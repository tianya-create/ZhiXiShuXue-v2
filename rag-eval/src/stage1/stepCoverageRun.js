/**
 * 替代 L1 运行器：读已落盘的 contexts.jsonl（四臂上下文）+ gold 解析 → 步骤覆盖率。
 *
 * 零 LLM 调用：全部输入都是确定性文本（context 落盘 + 题库解析），因此这个指标
 * 可以随时重算、可逐位复现——这正好补上 L1 在 LOO 口径下「无法度量」的空缺。
 *
 * 两个阶段必须分开（防「挑一个让 R 好看的 τ」）：
 *   --select-tau   只在 dev 上扫网格，按预注册规则选 τ 并落盘 step-coverage-tau.json
 *   --apply        只读已冻结的 τ 文件；文件不存在或非 dev 选出则拒绝运行
 *
 * 用法：
 *   node src/stage1/stepCoverageRun.js --config configs/rag-eval-config.json \
 *     --split dev --contexts data/stage0/dev-pilot-loo --select-tau
 *   node src/stage1/stepCoverageRun.js --config configs/rag-eval-config.json \
 *     --split eval --contexts data/stage1/eval --apply
 */

const fs = require('fs');
const path = require('path');
const { loadXes3g5mCorpus, loadRawQuestions } = require('../corpus/xes3g5m');
const { chunkCorpus } = require('../chunking/chunk');
const { sha256OfText } = require('../util/hash');
const { bootstrapArms } = require('../stats/bootstrap');
const {
  queryStepCoverage,
  coverageAtTau,
  expressionCoverage,
  selectTau,
  splitSteps,
  SHINGLE_K,
  STEM_RESIDUAL_MIN_SHARE,
  isUnusableAnalysis,
  extractExpressions,
} = require('../metrics/stepCoverage');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function mean(arr) {
  const v = arr.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function main() {
  const configPath = argOf('config', 'configs/rag-eval-config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const split = argOf('split', 'dev');
  const contextsDir = argOf('contexts', split === 'dev' ? 'data/stage0/dev-pilot-loo' : 'data/stage1/eval');
  const queriesPath = argOf('queries', `data/evalset/${split}-queries.json`);
  const outDir = argOf('out', path.join('data/stage1/steps'));
  const tauFile = path.join(outDir, 'step-coverage-tau.json');

  const queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
  const { map: raw } = loadRawQuestions({ questionsPath: cfg.corpus.file });

  // 用与 Stage 0 完全相同的分块参数重建 chunkId → text（contexts.jsonl 只存了拼接文本）
  const chunkSize = cfg.corpus?.chunking?.size ?? 300;
  const chunkOverlap = cfg.corpus?.chunking?.overlap ?? 40;
  const corpus = loadXes3g5mCorpus({ questionsPath: cfg.corpus.file });
  const chunks = chunkCorpus(corpus.docs, { size: chunkSize, overlap: chunkOverlap, idPrefix: 'xes' });
  const chunkText = new Map(chunks.map((c) => [c.chunkId, c.text]));

  const ctxRows = readJsonl(path.join(contextsDir, 'contexts.jsonl'));
  const ctxByKey = new Map(ctxRows.map((r) => [`${r.queryId}|${r.arm}`, r]));

  // τ 决定：两阶段强制分离
  let tau;
  let tauMeta;
  if (hasFlag('select-tau')) {
    if (split !== 'dev') throw new Error('--select-tau 只允许在 dev 上执行（eval 上选 τ = 用 eval 调参，失效）');
    tau = null; // 先用 detail 扫，稍后填
  } else if (hasFlag('apply')) {
    if (!fs.existsSync(tauFile)) throw new Error(`τ 未冻结：${tauFile} 不存在，先跑 --select-tau`);
    tauMeta = JSON.parse(fs.readFileSync(tauFile, 'utf8'));
    if (tauMeta.basedOn !== 'dev' || !tauMeta.frozenBeforeEval) {
      throw new Error('τ 文件不是「eval 之前、基于 dev」冻结的，拒绝应用');
    }
    tau = tauMeta.tau;
  } else {
    throw new Error('必须显式指定 --select-tau（dev）或 --apply（eval）');
  }

  const shingleCache = new Map();
  function chunkSetOf(chunkId) {
    let s = shingleCache.get(chunkId);
    if (s) return s;
    const text = chunkText.get(chunkId);
    if (text === undefined) throw new Error(`chunkId 无法在语料中还原：${chunkId}（分块参数是否与 Stage 0 不一致？）`);
    // 复用模块内部逻辑：直接调 queryStepCoverage 会重复算，故此处缓存「单块」结果
    const { shinglesOf } = require('../metrics/stepCoverage');
    s = { chunkId, docId: chunkId.replace(/^xes-(.+?)-\d+$/, '$1'), text, literal: shinglesOf(text, { skeleton: false }), skeleton: shinglesOf(text, { skeleton: true }) };
    shingleCache.set(chunkId, s);
    return s;
  }

  const perQuery = [];
  const violations = { nArmNonZero: [], looViolation: [], missingCtx: [], noSteps: [], unusableAnalysis: [], unresolvableChunk: [] };

  for (const q of queries) {
    const rec = raw.get(String(q.qid));
    if (!rec) throw new Error(`题库中找不到 qid=${q.qid}（query ${q.queryId}）`);
    const steps = splitSteps(rec.analysis);
    if (steps.length === 0) {
      // 零步骤只有在「解析本身不可用」时才可接受；否则视为切分失败
      if (isUnusableAnalysis(rec.analysis)) violations.unusableAnalysis.push(q.queryId);
      else violations.noSteps.push(q.queryId);
    }

    for (const arm of ['N', 'X', 'R', 'O']) {
      const ctx = ctxByKey.get(`${q.queryId}|${arm}`);
      if (!ctx) { violations.missingCtx.push(`${q.queryId}|${arm}`); continue; }
      if (arm === 'R' && Array.isArray(ctx.docIds) && ctx.docIds.includes(q.oracleDocId)) {
        violations.looViolation.push(q.queryId);
      }
      let armChunks = [];
      try {
        armChunks = (ctx.chunkIds || []).map((id) => chunkSetOf(id));
      } catch (e) {
        violations.unresolvableChunk.push(`${q.queryId}|${arm}:${e.message}`);
        armChunks = [];
      }
      const cov = queryStepCoverage({
        analysis: rec.analysis,
        questionContent: rec.content,
        chunks: armChunks.map((c) => ({ chunkId: c.chunkId, docId: c.docId, text: c.text })),
        tau: tau ?? 0.5,
      });
      const ex = expressionCoverage({
        analysis: rec.analysis,
        chunks: armChunks.map((c) => ({ chunkId: c.chunkId, docId: c.docId, text: c.text })),
      });
      if (arm === 'N' && cov.coverageSkeleton !== 0 && cov.coverageSkeleton !== null) violations.nArmNonZero.push(q.queryId);
      perQuery.push({
        queryId: q.queryId, qid: q.qid, kcId: q.kcId, arm,
        nSteps: cov.nSteps, nStemEcho: cov.nStemEcho, nNumeric: cov.nNumeric,
        coverageLiteral: cov.coverageLiteral,
        coverageSkeleton: cov.coverageSkeleton,
        coverageLiteralNoEcho: cov.coverageLiteralNoEcho,
        coverageSkeletonNoEcho: cov.coverageSkeletonNoEcho,
        coverageSkeletonNumericNoEcho: cov.coverageSkeletonNumericNoEcho,
        coverageSkeletonProseNoEcho: cov.coverageSkeletonProseNoEcho,
        meanContainmentSkeleton: cov.meanContainmentSkeleton,
        meanContainmentSkeletonResidual: cov.meanContainmentSkeletonResidual,
        nExpr: ex.nExpr,
        nExprCompound: ex.nCompound,
        exprCoverageAny: ex.coverageAny,
        exprCoverageCompound: ex.coverageCompound,
        exprCoverageLiteral: ex.coverageLiteral,
        docIds: ctx.docIds || [],
        _detail: cov.detail,
        _expr: ex.detail,
      });
    }
  }

  // ---- τ 选择（dev） ----
  let sweep = null;
  if (hasFlag('select-tau')) {
    const sel = selectTau(perQuery);
    sweep = sel;
    if (sel.tau === null) {
      throw new Error(`τ 网格内无候选满足 X ≤ ${sel.chanceCeiling}：${sel.fallback}`);
    }
    tau = sel.tau;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(tauFile, JSON.stringify({
      tau,
      rule: sel.rule,
      variant: 'skeletonResidual（判别口径：骨架 + 残差）',
      shingleK: SHINGLE_K,
      stemResidualMinShare: STEM_RESIDUAL_MIN_SHARE,
      metricImplSha256: sha256OfText(fs.readFileSync(path.join(__dirname, '..', 'metrics', 'stepCoverage.js'), 'utf8')),
      _pin_note: '指标实现与超参一并钉死：换实现/换 k/换残差阈值 = 换尺子，必须写 revision 并重算',
      chanceCeiling: sel.chanceCeiling,
      grid: sel.grid,
      sweep: sel.sweep,
      basedOn: 'dev',
      basedOnQueries: queriesPath,
      frozenBeforeEval: true,
      selectedAt: new Date().toISOString(),
      note: '该 τ 在跑 eval 之前确定；eval 上的 τ 敏感性仅作稳健性展示，不用于重选',
    }, null, 2));
    console.log(`[L1'] τ=${tau}（${sel.rule}）；已冻结 ${tauFile}`);
  }

  // ---- 用最终 τ 重算（detail 与 τ 无关，故直接阈值化，结果与单点计算一致） ----
  for (const r of perQuery) {
    const d = r._detail;
    r.coverageLiteral = coverageAtTau(d, tau, { variant: 'literal', noEchoOnly: false });
    r.coverageSkeleton = coverageAtTau(d, tau, { variant: 'skeleton', noEchoOnly: false });
    r.coverageLiteralNoEcho = coverageAtTau(d, tau, { variant: 'literalResidual', noEchoOnly: true });
    r.coverageSkeletonNoEcho = coverageAtTau(d, tau, { variant: 'skeletonResidual', noEchoOnly: true });
    r.coverageSkeletonNumericNoEcho = coverageAtTau(d, tau, { variant: 'skeletonResidual', noEchoOnly: true, stepClass: 'numeric' });
    r.coverageSkeletonProseNoEcho = coverageAtTau(d, tau, { variant: 'skeletonResidual', noEchoOnly: true, stepClass: 'prose' });
    r.tau = tau;
  }

  // ---- 汇总 ----
  const ARMS = ['N', 'X', 'R', 'O'];
  const armStats = {};
  for (const arm of ARMS) {
    const rows = perQuery.filter((r) => r.arm === arm);
    const pick = (f) => mean(rows.map((r) => r[f]));
    armStats[arm] = {
      n: rows.length,
      coverageLiteral: pick('coverageLiteral'),
      coverageSkeleton: pick('coverageSkeleton'),
      coverageLiteralNoEcho: pick('coverageLiteralNoEcho'),
      coverageSkeletonNoEcho: pick('coverageSkeletonNoEcho'),
      coverageSkeletonNumericNoEcho: pick('coverageSkeletonNumericNoEcho'),
      coverageSkeletonProseNoEcho: pick('coverageSkeletonProseNoEcho'),
      meanContainmentSkeleton: pick('meanContainmentSkeleton'),
      meanContainmentSkeletonResidual: pick('meanContainmentSkeletonResidual'),
      exprCoverageAny: pick('exprCoverageAny'),
      exprCoverageCompound: pick('exprCoverageCompound'),
      exprCoverageLiteral: pick('exprCoverageLiteral'),
      meanExprPerQuery: pick('nExpr'),
    };
  }

  // 配对 bootstrap：只对四臂都有 finite 覆盖率的 query 配对
  const validQ = new Set(
    [...new Set(perQuery.map((r) => r.queryId))].filter((qid) => ARMS.every((arm) => {
      const r = perQuery.find((x) => x.queryId === qid && x.arm === arm);
      return r && Number.isFinite(r.coverageSkeletonNoEcho);
    }))
  );
  const rowsByArm = {};
  for (const arm of ARMS) {
    rowsByArm[arm] = perQuery
      .filter((r) => r.arm === arm && validQ.has(r.queryId))
      .sort((a, b) => (a.queryId < b.queryId ? -1 : 1))
      .map((r) => ({ queryId: r.queryId, score: r.coverageSkeletonNoEcho }));
  }
  const boot = bootstrapArms(rowsByArm, { reps: 2000, seed: 42, groupKey: 'queryId' });
  const rowsByArmExpr = {};
  const validQExpr = new Set(
    [...new Set(perQuery.map((r) => r.queryId))].filter((qid) => ARMS.every((arm) => {
      const r = perQuery.find((x) => x.queryId === qid && x.arm === arm);
      return r && Number.isFinite(r.exprCoverageCompound);
    }))
  );
  for (const arm of ARMS) {
    rowsByArmExpr[arm] = perQuery
      .filter((r) => r.arm === arm && validQExpr.has(r.queryId))
      .sort((a, b) => (a.queryId < b.queryId ? -1 : 1))
      .map((r) => ({ queryId: r.queryId, score: r.exprCoverageCompound }));
  }
  const bootExpr = validQExpr.size ? bootstrapArms(rowsByArmExpr, { reps: 2000, seed: 42, groupKey: 'queryId' }) : null;

  const deltaOf = (a, b, bootRes = boot) => {
    const c = (bootRes.comparisons || []).find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a)) || {};
    const sign = c.a === a ? 1 : -1;
    return {
      comparison: `${a} − ${b}`,
      point: c.pointDiff === null ? null : sign * c.pointDiff,
      ci: c.deltaCI ? (sign === 1 ? c.deltaCI : [-c.deltaCI[1], -c.deltaCI[0]]) : null,
      p: c.p === null || c.p === undefined ? null : (sign === 1 ? c.p : c.p),
      support: sign === 1 ? c.supportFlag : c.negativeFlag,
      negative: sign === 1 ? c.negativeFlag : c.supportFlag,
    };
  };

  const kcAgg = {};
  for (const r of perQuery) {
    if (!kcAgg[r.kcId]) kcAgg[r.kcId] = { n: 0, byArm: {} };
    kcAgg[r.kcId].byArm[r.arm] = kcAgg[r.kcId].byArm[r.arm] || [];
    kcAgg[r.kcId].byArm[r.arm].push(r.coverageSkeletonNoEcho);
  }
  const byKc = {};
  for (const [kc, v] of Object.entries(kcAgg)) {
    byKc[kc] = { n: Math.max(...ARMS.map((a) => (v.byArm[a] || []).length)) };
    for (const a of ARMS) byKc[kc][a] = mean(v.byArm[a] || []);
    byKc[kc].deltaRX = byKc[kc].R !== null && byKc[kc].X !== null ? byKc[kc].R - byKc[kc].X : null;
  }

  const dupStratification = (() => {
    const rRows = perQuery.filter((r) => r.arm === 'R' && r.exprCoverageLiteral !== null);
    const dup = rRows.filter((r) => r.exprCoverageLiteral > 0);
    const fresh = rRows.filter((r) => r.exprCoverageLiteral === 0);
    const xAll = perQuery.filter((r) => r.arm === 'X');
    const meanArm = (rows, f) => mean(rows.map((r) => r[f]));
    return {
      note: '按 R 臂是否命中「同数值算式」（= 检索到近似重复题）分层；X 臂无分层意义（其字面命中恒为 0）',
      dupRetrieved: {
        n: dup.length,
        shareOfQueries: rRows.length ? dup.length / rRows.length : null,
        R_coverageSkeletonNoEcho: meanArm(dup, 'coverageSkeletonNoEcho'),
        R_exprCompound: meanArm(dup, 'exprCoverageCompound'),
      },
      noDup: {
        n: fresh.length,
        R_coverageSkeletonNoEcho: meanArm(fresh, 'coverageSkeletonNoEcho'),
        R_exprCompound: meanArm(fresh, 'exprCoverageCompound'),
      },
      X_all: {
        n: xAll.length,
        X_coverageSkeletonNoEcho: meanArm(xAll, 'coverageSkeletonNoEcho'),
        X_exprCompound: meanArm(xAll, 'exprCoverageCompound'),
      },
      // 纯迁移口径：只在「没检索到重复题」的子集上比较 R 与 X（同子集配对）
      transferOnly: (() => {
        const ids = new Set(fresh.map((r) => r.queryId));
        const xSub = xAll.filter((r) => ids.has(r.queryId));
        const d = meanArm(fresh, 'coverageSkeletonNoEcho');
        const xm = meanArm(xSub, 'coverageSkeletonNoEcho');
        return {
          n: ids.size,
          R: d,
          X: xm,
          delta: d !== null && xm !== null ? d - xm : null,
        };
      })(),
    };
  })();

  const stepStats = {
    perQueryMedianSteps: (() => {
      const n = [...new Set(perQuery.map((r) => r.queryId))]
        .map((qid) => perQuery.find((r) => r.queryId === qid && r.arm === 'N').nSteps)
        .sort((a, b) => a - b);
      return n.length ? n[n.length >> 1] : 0;
    })(),
    totalStepInstances: perQuery.filter((r) => r.arm === 'N').reduce((s, r) => s + r.nSteps, 0),
    stemEchoRate: (() => {
      const rows = perQuery.filter((r) => r.arm === 'N');
      const tot = rows.reduce((s, r) => s + r.nSteps, 0);
      const echo = rows.reduce((s, r) => s + r.nStemEcho, 0);
      return tot ? echo / tot : null;
    })(),
    zeroStepQueries: violations.noSteps.length,
    exprMedianPerQuery: (() => {
      const n = perQuery.filter((r) => r.arm === 'N').map((r) => r.nExpr).sort((a, b) => a - b);
      return n.length ? n[n.length >> 1] : 0;
    })(),
    totalExprInstances: perQuery.filter((r) => r.arm === 'N').reduce((s2, r) => s2 + r.nExpr, 0),
    queriesWithoutExpr: perQuery.filter((r) => r.arm === 'N' && r.nExpr === 0).length,
  };

  const assertions = [
    { id: 'A1', claim: 'N 臂（空上下文）覆盖率为 0', pass: violations.nArmNonZero.length === 0, detail: `${violations.nArmNonZero.length} 例违例` },
    { id: 'A2', claim: 'R 臂不含本 query 的 gold doc（LOO 协议完好）', pass: violations.looViolation.length === 0, detail: `${violations.looViolation.length} 例违例` },
    { id: 'A3', claim: '非零步骤者皆切出 ≥1 步；零步骤仅限「解析不可用」（纯图片/纯答案）并已从聚合剔除', pass: violations.noSteps.length === 0, detail: `${violations.unusableAnalysis.length} 例解析不可用（已剔除）、${violations.noSteps.length} 例切分失败` },
    { id: 'A4', claim: 'O 臂（gold 解析自身）覆盖率 > X 臂（上界健全性）', pass: (armStats.O.coverageSkeletonNoEcho ?? 0) > (armStats.X.coverageSkeletonNoEcho ?? 0), detail: `O=${armStats.O.coverageSkeletonNoEcho?.toFixed(4)} vs X=${armStats.X.coverageSkeletonNoEcho?.toFixed(4)}` },
    { id: 'A5', claim: '每个 chunkId 都能用配置的分块参数从语料还原', pass: violations.unresolvableChunk.length === 0, detail: `${violations.unresolvableChunk.length} 例失败` },
  ];

  const result = {
    metric: 'step-coverage (替代 L1)',
    split,
    contextsDir,
    queriesPath,
    configPath,
    configSha256: sha256OfText(fs.readFileSync(configPath, 'utf8')),
    chunking: { size: chunkSize, overlap: chunkOverlap },
    tau,
    tauSource: hasFlag('select-tau') ? 'dev（本次选出并冻结）' : `dev（冻结文件 ${tauFile}）`,
    nQueries: new Set(perQuery.map((r) => r.queryId)).size,
    pairedQueries: validQ.size,
    stepStats,
    assertions,
    arms: armStats,
    dupStratification,
    delta: {
      relSkeleton: deltaOf('R', 'X'),
      relLiteral: (() => {
        // literal 口径只给点估计（跨题数值不同，literal 命中必然稀少，不作方向判定）
        const rv = armStats.R.coverageLiteralNoEcho;
        const xv = armStats.X.coverageLiteralNoEcho;
        return {
          point: rv !== null && xv !== null ? rv - xv : null,
          note: 'literal 口径只给点估计，仅作严格性参照',
        };
      })(),
      roCaption: deltaOf('R', 'O'),
      orDelta: deltaOf('O', 'X'),
      exprRel: validQExpr.size ? { ...deltaOf('R', 'X', bootExpr), paired: validQExpr.size, field: 'exprCoverageCompound（复合算式骨架出现率，算子≥2）' } : null,
    },
    byKc,
    tauSweep: sweep ? sweep.sweep : null,
    violations,
    perQuery: perQuery.map(({ _detail, _expr, ...rest }) => rest),
    perStep: perQuery.map((r) => ({ queryId: r.queryId, arm: r.arm, steps: r._detail })),
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `step-coverage-${split}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 1));

  const p = (x) => (x === null || x === undefined ? 'NA' : x.toFixed(4));
  console.log(`[L1'] ${split} n=${result.nQueries}（配对 ${validQ.size}）τ=${tau}`);
  console.log(`[L1'] 步骤：中位 ${stepStats.perQueryMedianSteps}/题，题面回声占比 ${p(stepStats.stemEchoRate)}`);
  console.log(`[L1'] 判别口径覆盖（skeleton, no-echo）：` + ARMS.map((a) => `${a}=${p(armStats[a].coverageSkeletonNoEcho)}`).join('  '));
  console.log(`[L1'] ΔStepCov=R−X=${p(result.delta.relSkeleton.point)} [${(result.delta.relSkeleton.ci || []).map(p).join(', ')}] support=${result.delta.relSkeleton.support}`);
  console.log(`[L1'] 算式级覆盖（骨架出现率）：` + ARMS.map((a) => `${a}=${p(armStats[a].exprCoverageAny)}`).join('  ')
    + `  | 算式字面（同数值复用）R=${p(armStats.R.exprCoverageLiteral)} X=${p(armStats.X.exprCoverageLiteral)}`);
  if (result.delta.exprRel) {
    console.log(`[L1'] ΔExpr=R−X=${p(result.delta.exprRel.point)} [${(result.delta.exprRel.ci || []).map(p).join(', ')}] support=${result.delta.exprRel.support}（配对 ${result.delta.exprRel.paired}）`);
  } else {
    console.log('[L1\'] 算式级：无足够配对 query，跳过 ΔExpr');
  }
  const ds = result.dupStratification;
  console.log(`[L1'] 重复题分层：R 命中同数值算式 ${ds.dupRetrieved.n}/${ds.dupRetrieved.n + ds.noDup.n} 条`
    + `（${p(ds.dupRetrieved.shareOfQueries)}）→ 其中 R 覆盖 ${p(ds.dupRetrieved.R_coverageSkeletonNoEcho)}`
    + ` / 未命中 ${ds.noDup.n} 条 R 覆盖 ${p(ds.noDup.R_coverageSkeletonNoEcho)}（X 同子集 ${p(ds.transferOnly.X)}，纯迁移 Δ=${p(ds.transferOnly.delta)}）`);
  console.log(`[L1'] 断言：${assertions.map((a) => `${a.id}${a.pass ? '✓' : '✗'}`).join(' ')}`);
  console.log(`[L1'] 落盘 ${outPath}`);
  if (assertions.some((a) => !a.pass)) process.exitCode = 3;
}

if (require.main === module) main();
