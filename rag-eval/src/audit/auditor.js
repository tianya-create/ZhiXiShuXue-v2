/**
 * 独立审计器——8 类检查（设计 §7），不重跑生成，只读落盘产物。
 * 定位与 KT auditGraphDktResults 一致：它是「检查者」不是「执行者」。
 *
 * 输入 schema 见 auditRun 的 JSDoc。骨架落地 22 项检查（后续按同一模式扩到 60+）。
 */

const { meanScoreOf } = require('../stats/evaluator');
const { bootstrapArms } = require('../stats/bootstrap');
const { round4 } = require('../stats/core');

/** 两样本 KS 统计量 D（长度分布真实性检查用） */
function ksStatistic(xs, ys) {
  const a = [...xs].sort((x, y) => x - y);
  const b = [...ys].sort((x, y) => x - y);
  const all = [...a, ...b].sort((x, y) => x - y);
  let i = 0;
  let j = 0;
  let d = 0;
  for (const v of all) {
    while (i < a.length && a[i] <= v) i++;
    while (j < b.length && b[j] <= v) j++;
    d = Math.max(d, Math.abs(i / a.length - j / b.length));
  }
  return d;
}

/** Cohen's κ（judge-人工一致性）；pairs: [{rater1, rater2}] */
function cohensKappa(pairs) {
  if (!pairs.length) return null;
  const cats = [...new Set(pairs.flatMap((p) => [p.rater1, p.rater2]))];
  const conf = new Map();
  for (const c1 of cats) for (const c2 of cats) conf.set(`${c1}|${c2}`, 0);
  for (const p of pairs) conf.set(`${p.rater1}|${p.rater2}`, conf.get(`${p.rater1}|${p.rater2}`) + 1);
  const n = pairs.length;
  const po = pairs.filter((p) => p.rater1 === p.rater2).length / n;
  const m1 = new Map();
  const m2 = new Map();
  for (const c of cats) {
    m1.set(c, pairs.filter((p) => p.rater1 === c).length / n);
    m2.set(c, pairs.filter((p) => p.rater2 === c).length / n);
  }
  const pe = cats.reduce((s, c) => s + m1.get(c) * m2.get(c), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function disjoint(a, b) {
  const sb = new Set(b);
  return [...new Set(a)].every((x) => !sb.has(x));
}

function intersection(a, b) {
  const sb = new Set(b);
  return [...new Set(a)].filter((x) => sb.has(x));
}

/**
 * @param {Object} input
 * @param {Object} input.config          冻结配置对象
 * @param {Object} input.hashes          {configSha256, evalSetSha256, corpusSha256, chunkManifestSha256, judgeRubricSha256}
 * @param {Object|null} input.freezeManifest  {configSha256, evalSetSha256}
 * @param {Array<{queryId, queryClusterId, goldDocClusterIds}>} input.queries  eval 集（含簇分配）
 * @param {Object} input.perQuery        queryId → { N:{scores}, R:{chars,chunkCount,docClusterIds,scores}, X:{...}, O?:{scores} }
 * @param {string[]} input.devQueryClusterIds
 * @param {string[]} input.devDocClusterIds
 * @param {string[]} input.fewShotQueryIds
 * @param {string[]} input.fewShotQueryClusterIds
 * @param {string[]} input.indexQueryIds
 * @param {Object} input.judge           {minRejudgeAgreement, minHumanKappa, rejudge:[{original,rejudged}], humanCalibration:[{judge,human}]}
 * @param {Object} input.summary         {armMeans:{...}, comparisons:[{a,b,deltaMeanExact,deltaCI,deltaCI4,supportFlag}]}
 * @param {Object} input.bootstrap       {reps, seed}
 * @param {number} [input.lengthTolerance]  默认 0.02
 * @param {number} [input.ksThreshold]      默认 0.2
 * @param {string[]} [input.requiredArms]   默认 ['N','R','X']
 * @param {number} [input.samplesPerQuery]  默认 1
 */
function auditRun(input) {
  const {
    config,
    hashes,
    freezeManifest,
    queries,
    perQuery,
    devQueryClusterIds = [],
    devDocClusterIds = [],
    fewShotQueryIds = [],
    fewShotQueryClusterIds = [],
    indexQueryIds = [],
    judge,
    summary,
    bootstrap,
    lengthTolerance = 0.02,
    ksThreshold = 0.2,
    requiredArms = ['N', 'R', 'X'],
    samplesPerQuery = 1
  } = input;

  if (!config || !hashes || !perQuery || !summary || !bootstrap) {
    throw new Error('auditRun: config/hashes/perQuery/summary/bootstrap 为必填');
  }
  const queryIds = queries.map((q) => q.queryId);
  const queryById = new Map(queries.map((q) => [q.queryId, q]));
  const checks = [];
  const add = (id, category, name, passed, detail) => checks.push({ id, category, name, passed: !!passed, detail });

  // ---------- C1 产物哈希 ----------
  const hashNames = ['configSha256', 'evalSetSha256', 'corpusSha256', 'chunkManifestSha256', 'judgeRubricSha256'];
  const missingHashes = hashNames.filter((k) => !hashes[k]);
  add('H1.1', 'C1-产物哈希', '五类产物哈希齐全', missingHashes.length === 0,
    missingHashes.length ? `缺失: ${missingHashes.join(',')}` : 'config/evalSet/corpus/chunkManifest/judgeRubric 均非空');

  const manifestOk = freezeManifest
    && freezeManifest.configSha256 === hashes.configSha256
    && freezeManifest.evalSetSha256 === hashes.evalSetSha256;
  add('H1.2', 'C1-产物哈希', 'freeze-manifest 与当前哈希一致', !!manifestOk,
    manifestOk ? 'config 与 evalSet 哈希均匹配' : 'freezeManifest 缺失或不匹配——配置可能在冻结后被改过');

  const frozenOk = config.frozenBeforeRun === true && !!config.frozenAt;
  add('H1.3', 'C1-产物哈希', '配置带冻结标记（frozenBeforeRun + frozenAt）', frozenOk,
    `frozenBeforeRun=${config.frozenBeforeRun}, frozenAt=${config.frozenAt}`);

  // ---------- C2 预算等长 ----------
  const lenViolations = [];
  let maxRelDiff = 0;
  for (const qid of queryIds) {
    const r = perQuery[qid] && perQuery[qid].R;
    const x = perQuery[qid] && perQuery[qid].X;
    if (!r || !x) continue;
    const rel = Math.abs(r.chars - x.chars) / r.chars;
    maxRelDiff = Math.max(maxRelDiff, rel);
    if (rel > lengthTolerance) lenViolations.push(`${qid}: R=${r.chars} X=${x.chars} rel=${rel.toFixed(4)}`);
  }
  add('H2.1', 'C2-预算等长', `R 与 X 逐 query 字符数差 ≤ ${lengthTolerance}`, lenViolations.length === 0,
    lenViolations.length ? `${lenViolations.length} 个超差: ${lenViolations.slice(0, 5).join('; ')}` : `最大相对差 ${maxRelDiff.toExponential(2)}`);

  const chunkCountViolations = queryIds
    .filter((qid) => perQuery[qid].R && perQuery[qid].X && perQuery[qid].R.chunkCount !== perQuery[qid].X.chunkCount)
    .map((qid) => `${qid}: R=${perQuery[qid].R.chunkCount} X=${perQuery[qid].X.chunkCount}`);
  add('H2.2', 'C2-预算等长', 'R 与 X 块数相等', chunkCountViolations.length === 0,
    chunkCountViolations.length ? chunkCountViolations.slice(0, 5).join('; ') : '全部相等');

  // ---------- C3 X 臂真实性 ----------
  const overlapViolations = [];
  for (const qid of queryIds) {
    const r = perQuery[qid].R;
    const x = perQuery[qid].X;
    if (!r || !x) continue;
    const inter = intersection(x.docClusterIds || [], r.docClusterIds || []);
    if (inter.length) overlapViolations.push(`${qid}: ${inter.slice(0, 3).join(',')}`);
  }
  add('H3.1', 'C3-X臂真实性', '每个 query 的 X 簇与 R 簇无交集', overlapViolations.length === 0,
    overlapViolations.length ? `${overlapViolations.length} 个相交: ${overlapViolations.slice(0, 5).join('; ')}` : '全部不相交');

  const rChars = queryIds.map((qid) => perQuery[qid].R && perQuery[qid].R.chars).filter((v) => Number.isFinite(v));
  const xChars = queryIds.map((qid) => perQuery[qid].X && perQuery[qid].X.chars).filter((v) => Number.isFinite(v));
  const ksD = rChars.length && xChars.length ? ksStatistic(rChars, xChars) : null;
  add('H3.2', 'C3-X臂真实性', `R/X 长度分布 KS D ≤ ${ksThreshold}`, ksD !== null && ksD <= ksThreshold,
    ksD === null ? '长度数据缺失' : `D = ${ksD.toFixed(4)}`);

  // ---------- C4 泄漏断言 ----------
  const evalQueryClusterIds = queries.map((q) => q.queryClusterId);
  const qClusterInter = intersection(evalQueryClusterIds, devQueryClusterIds);
  add('H4.1', 'C4-泄漏断言', 'eval 与 dev 的 query 簇无交集', qClusterInter.length === 0,
    qClusterInter.length ? `相交簇: ${qClusterInter.slice(0, 5).join(',')}` : '无交集');

  const evalDocClusterIds = [...new Set(queries.flatMap((q) => q.goldDocClusterIds || []))];
  const dClusterInter = intersection(evalDocClusterIds, devDocClusterIds);
  add('H4.2', 'C4-泄漏断言', 'eval gold doc 簇与 dev doc 簇无交集', dClusterInter.length === 0,
    dClusterInter.length ? `相交簇: ${dClusterInter.slice(0, 5).join(',')}` : '无交集');

  const fsQueryInter = intersection(fewShotQueryIds, queryIds);
  const fsClusterInter = intersection(fewShotQueryClusterIds, evalQueryClusterIds);
  add('H4.3', 'C4-泄漏断言', 'few-shot 示例不在 eval（query 级与簇级）',
    fsQueryInter.length === 0 && fsClusterInter.length === 0,
    `query 级相交 ${fsQueryInter.length} 个；簇级相交 ${fsClusterInter.length} 个`);

  const indexInter = intersection(indexQueryIds, queryIds);
  add('H4.4', 'C4-泄漏断言', '建索引用查询与 eval 查询无交集（防自检索）', indexInter.length === 0,
    indexInter.length ? `相交: ${indexInter.slice(0, 5).join(',')}` : '无交集');

  // ---------- C5 指标可复算 ----------
  const flatRowsByArm = {};
  for (const arm of new Set([...requiredArms, ...Object.keys(summary.armMeans)])) {
    flatRowsByArm[arm] = queryIds
      .map((qid) => ({ userId: qid, score: perQuery[qid] && perQuery[qid][arm] ? perQuery[qid][arm].scores : [] }))
      .filter((row) => row.score.length)
      .map((row) => ({ userId: row.userId, score: row.score.reduce((s, x) => s + x, 0) / row.score.length }));
  }
  const recomputeDiffs = [];
  for (const [arm, mean] of Object.entries(summary.armMeans)) {
    const recomputed = flatRowsByArm[arm] ? meanScoreOf(flatRowsByArm[arm]) : null;
    if (recomputed === null || Math.abs(recomputed - mean) > 1e-12) {
      recomputeDiffs.push(`${arm}: summary=${mean} 重算=${recomputed}`);
    }
  }
  add('H5.1', 'C5-指标可复算', 'summary 臂均值可从逐条分数重算（未舍入，≤1e-12）', recomputeDiffs.length === 0,
    recomputeDiffs.length ? recomputeDiffs.join('; ') : '全部臂均值逐位一致');

  const pointDiffs = [];
  for (const cmp of summary.comparisons) {
    const ma = summary.armMeans[cmp.a];
    const mb = summary.armMeans[cmp.b];
    if (ma === undefined || mb === undefined) { pointDiffs.push(`${cmp.a}−${cmp.b}: 臂均值缺失`); continue; }
    if (Math.abs(ma - mb - cmp.deltaMeanExact) > 1e-12) {
      pointDiffs.push(`${cmp.a}−${cmp.b}: 记录=${cmp.deltaMeanExact} 重算=${ma - mb}`);
    }
  }
  add('H5.2', 'C5-指标可复算', '比较的点估计差 = 臂均值差（≤1e-12）', pointDiffs.length === 0,
    pointDiffs.length ? pointDiffs.join('; ') : '全部一致');

  const boundViolations = [];
  for (const qid of queryIds) {
    for (const arm of requiredArms) {
      const entry = perQuery[qid] && perQuery[qid][arm];
      if (!entry) continue;
      entry.scores.forEach((s, i) => {
        if (!Number.isFinite(s) || s < 0 || s > 1) boundViolations.push(`${qid}/${arm}[${i}]=${s}`);
      });
    }
  }
  add('H5.3', 'C5-指标可复算', '全部分数有限且在 [0,1]', boundViolations.length === 0,
    boundViolations.length ? `${boundViolations.length} 个越界: ${boundViolations.slice(0, 5).join('; ')}` : '无越界');

  // ---------- C6 judge 一致性 ----------
  const minAgree = (judge && judge.minRejudgeAgreement) ?? 0.9;
  const rejudge = (judge && judge.rejudge) || [];
  if (rejudge.length) {
    const agree = rejudge.filter((p) => p.original === p.rejudged).length / rejudge.length;
    add('H6.1', 'C6-judge一致性', `复判一致率 ≥ ${minAgree}`, agree >= minAgree,
      `一致率 ${agree.toFixed(3)}（${rejudge.length} 条）`);
  } else {
    add('H6.1', 'C6-judge一致性', '复判记录非空', false, '缺少 10% 复判记录，L3 层不可用');
  }

  const minKappa = (judge && judge.minHumanKappa) ?? 0.6;
  const calibration = (judge && judge.humanCalibration) || [];
  if (calibration.length) {
    const kappa = cohensKappa(calibration);
    add('H6.2', 'C6-judge一致性', `judge-人工 κ ≥ ${minKappa}`, kappa !== null && kappa >= minKappa,
      `κ = ${kappa === null ? 'null' : kappa.toFixed(3)}（${calibration.length} 条双人标注）`);
  } else {
    add('H6.2', 'C6-judge一致性', '人工校准记录非空', false, '缺少双人标注校准，κ 不可计算');
  }

  // ---------- C7 三臂齐全 ----------
  const missingArms = [];
  for (const qid of queryIds) {
    for (const arm of requiredArms) {
      if (!perQuery[qid] || !perQuery[qid][arm]) missingArms.push(`${qid}/${arm}`);
    }
  }
  add('H7.1', 'C7-三臂齐全', `每个 query 都有 ${requiredArms.join('/')} 记录`, missingArms.length === 0,
    missingArms.length ? `缺失 ${missingArms.length} 项: ${missingArms.slice(0, 5).join('; ')}` : '无缺失');

  const countViolations = [];
  for (const qid of queryIds) {
    for (const arm of requiredArms) {
      const entry = perQuery[qid] && perQuery[qid][arm];
      if (entry && entry.scores.length !== samplesPerQuery) {
        countViolations.push(`${qid}/${arm}: ${entry.scores.length} != ${samplesPerQuery}`);
      }
    }
  }
  add('H7.2', 'C7-三臂齐全', `每臂恰好 ${samplesPerQuery} 个生成样本`, countViolations.length === 0,
    countViolations.length ? `${countViolations.length} 项数量不符: ${countViolations.slice(0, 5).join('; ')}` : '数量全部正确');

  const nullScores = [];
  for (const qid of queryIds) {
    for (const arm of requiredArms) {
      const entry = perQuery[qid] && perQuery[qid][arm];
      if (entry && entry.scores.some((s) => !Number.isFinite(s))) nullScores.push(`${qid}/${arm}`);
    }
  }
  add('H7.3', 'C7-三臂齐全', '无静默丢弃（无 null/NaN 分数）', nullScores.length === 0,
    nullScores.length ? `${nullScores.length} 项含非有限分数: ${nullScores.slice(0, 5).join('; ')}` : '全部有限');

  // ---------- C8 CI 与标志自洽 ----------
  const flagViolations = [];
  for (const cmp of summary.comparisons) {
    if (cmp.supportFlag !== (cmp.deltaCI[0] > 0)) {
      flagViolations.push(`${cmp.a}−${cmp.b}: supportFlag=${cmp.supportFlag} 但未舍入 CI 下界=${cmp.deltaCI[0]}`);
    }
  }
  add('H8.1', 'C8-CI与标志自洽', '支持标志由未舍入 CI 下界判定', flagViolations.length === 0,
    flagViolations.length ? flagViolations.join('; ') : '全部自洽');

  const roundViolations = [];
  for (const cmp of summary.comparisons) {
    const expect = [round4(cmp.deltaCI[0]), round4(cmp.deltaCI[1])];
    if (expect[0] !== cmp.deltaCI4[0] || expect[1] !== cmp.deltaCI4[1]) {
      roundViolations.push(`${cmp.a}−${cmp.b}: deltaCI4=${JSON.stringify(cmp.deltaCI4)} 应为 ${JSON.stringify(expect)}`);
    }
  }
  add('H8.2', 'C8-CI与标志自洽', 'deltaCI4 = round4(deltaCI)（展示值可溯源）', roundViolations.length === 0,
    roundViolations.length ? roundViolations.join('; ') : '舍入关系成立');

  const rowsByArm = {};
  for (const arm of Object.keys(flatRowsByArm)) rowsByArm[arm] = flatRowsByArm[arm];
  let rerun = null;
  const reproViolations = [];
  try {
    rerun = bootstrapArms(rowsByArm, { reps: bootstrap.reps, seed: bootstrap.seed });
  } catch (e) {
    reproViolations.push(`复跑失败（臂行数不一致或未对齐）: ${e.message}`);
  }
  if (rerun) {
    for (const cmp of summary.comparisons) {
      const rc = rerun.comparisons.find((c) => c.a === cmp.a && c.b === cmp.b);
      if (!rc) { reproViolations.push(`${cmp.a}−${cmp.b}: 复跑未产生该比较`); continue; }
      if (Math.abs(rc.deltaCI[0] - cmp.deltaCI[0]) > 1e-12 || Math.abs(rc.deltaCI[1] - cmp.deltaCI[1]) > 1e-12) {
        reproViolations.push(`${cmp.a}−${cmp.b}: CI 复跑不一致 ${JSON.stringify(rc.deltaCI)} vs ${JSON.stringify(cmp.deltaCI)}`);
      }
    }
  }
  add('H8.3', 'C8-CI与标志自洽', `同种子复跑 bootstrap CI 可复现（reps=${bootstrap.reps}, seed=${bootstrap.seed}）`,
    reproViolations.length === 0, reproViolations.length ? reproViolations.join('; ') : '逐位一致');

  const byCategory = {};
  for (const c of checks) {
    byCategory[c.category] = byCategory[c.category] || { passed: 0, failed: 0 };
    byCategory[c.category][c.passed ? 'passed' : 'failed']++;
  }
  const failed = checks.filter((c) => !c.passed).length;
  return { checks, passed: checks.length - failed, failed, allPassed: failed === 0, byCategory };
}

module.exports = { auditRun, ksStatistic, cohensKappa };
