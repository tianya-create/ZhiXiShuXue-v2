/**
 * L3 人工 κ 校准：盲评表生成 + 一致性计算 + 放行闸门。
 *
 * 为什么需要这一步（而非只跑 10% 重判）：
 *  - 重判一致率只证明 judge 确定性（同 prompt 同模型自洽），不证明判得对；
 *  - judge 与生成器同模型，存在自评偏好；且偏好可能是**按臂差异化**的，
 *    这才是直接威胁 ΔREL 结论的偏差（对检索臂一致宽松 = 凭空造效应）；
 *  - 因此人工校准要回答两件事：① judge 与人对得上吗（κ）；② 偏差是否按臂不同（Δbias）。
 *
 * 三条纪律：
 *  1. **盲**：盲评表不含臂名、不含 judgeScore，按随机顺序编号；臂与分数只存 key 文件，
 *     评分完成后再 join。否则锚定效应让 κ 无解释力。
 *  2. **不删档**：缺失/非法值一律列出，不静默丢弃，也不自动补 judge 分。
 *  3. **不回流**：κ 结果只用于「L3 能不能进判定」，不得据此改 rubric 或重挑样本，
 *     要改 = 换尺子 = 写 revision 并重判全量。
 *
 * 决策规则（预注册，写在 docs/Stage1-L3人工κ校准-操作指南.md）：
 *  - κ_w(quadratic) ≥ 0.60 且 95% CI 下界 ≥ 0.45 → L3 可作主证据之一；
 *  - 0.40 ≤ κ_w < 0.60 → L3 仅报方向，判定不得以其为唯一依据；
 *  - κ_w < 0.40 → L3 作废，结论回落到 L2 + 替代 L1；
 *  - 附加护栏：|bias(R) − bias(X)| ≥ 0.25 分 → ΔREL 必须做人类分敏感性重算。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sha256OfText } = require('../util/hash');
const { mulberry32 } = require('../stats/core');

const SCORE_DOMAIN = [0, 1, 2];

// ---------------------------------------------------------------- CSV

/** 稳健 CSV 解析：处理 BOM / CRLF / 引号内逗号与换行 / "" 转义 */
function parseCsv(text) {
  const s = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0].trim() === '') continue;
    const obj = {};
    header.forEach((h, j) => { obj[h] = r[j] === undefined ? '' : r[j]; });
    out.push(obj);
  }
  return out;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(header, rows) {
  return [header.join(',')]
    .concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(',')))
    .join('\n');
}

// ---------------------------------------------------------------- 抽样

/** 与输入顺序无关的确定性均匀数：同一 (seed,key) 永远同一 u */
function uniformFrom(seed, key) {
  const h = sha256OfText(`${seed}|${key}`);
  return parseInt(h.slice(7, 15), 16) / 0x100000000;
}

/**
 * 生成盲评表 + 密钥文件。
 *
 * @param {object[]} judgeRows first-pass judge 记录（{queryId, arm, score, pred, goldAnswer}）
 * @param {object[]} queries   eval 集（用于取题面）
 * @param {number}   rate      随机抽样比例（建议 0.25：n=200 时 κ 的 95%CI 半宽约 0.10）
 * @param {number}   enrichPerClass 每个稀缺类别额外补足条数（judge=1），**单独标记、不得并入主 κ**
 * @param {string}   seed      抽样种子
 */
function buildCalibration({ judgeRows, queries = [], rate = 0.25, enrichPerClass = 0, seed = 20261112 }) {
  const qById = new Map(queries.map((q) => [q.queryId, q]));
  const seen = new Set();
  const pool = [];
  for (const r of judgeRows) {
    if (!r || !r.queryId || !r.arm) continue;
    if (![0, 1, 2].includes(Number(r.score))) continue;
    const key = `${r.queryId}|${r.arm}`;
    if (seen.has(key)) continue; // 同 key 只取一条（first-pass）
    seen.add(key);
    pool.push({
      key,
      queryId: r.queryId,
      arm: r.arm,
      judgeScore: Number(r.score),
      pred: String(r.pred == null ? '' : r.pred),
      goldAnswer: String(r.goldAnswer == null ? '' : r.goldAnswer),
      u: uniformFrom(seed, key),
    });
  }

  const picked = pool.filter((p) => p.u < rate);
  const pickedKeys = new Set(picked.map((p) => p.key));

  // 稀缺类别补样（默认 judge=1）：单独标记 enriched=true，不计入主 κ
  const enriched = [];
  if (enrichPerClass > 0) {
    const rare = pool
      .filter((p) => p.judgeScore === 1 && !pickedKeys.has(p.key))
      .sort((a, b) => a.u - b.u)
      .slice(0, enrichPerClass);
    for (const r of rare) { r.enriched = true; enriched.push(r); pickedKeys.add(r.key); }
  }

  const all = picked.concat(enriched).sort((a, b) => a.u - b.u); // u 排序 = 与 key 无关的随机顺序

  const blindRows = [];
  const keyRows = [];
  all.forEach((p, i) => {
    const itemId = `c-${String(i + 1).padStart(3, '0')}`;
    const q = qById.get(p.queryId);
    blindRows.push({
      itemId,
      question: String((q && q.queryText) || '').replace(/\s+/g, ' ').trim(),
      goldAnswer: p.goldAnswer,
      pred: p.pred.replace(/\s+/g, ' ').trim(),
      humanScore: '',
      note: '',
    });
    keyRows.push({
      itemId,
      queryId: p.queryId,
      arm: p.arm,
      judgeScore: p.judgeScore,
      enriched: Boolean(p.enriched),
    });
  });

  const byArm = {};
  for (const k of keyRows) byArm[k.arm] = (byArm[k.arm] || 0) + 1;
  const dist = {};
  for (const k of keyRows) dist[k.judgeScore] = (dist[k.judgeScore] || 0) + 1;

  return {
    blindCsv: toCsv(['itemId', 'question', 'goldAnswer', 'pred', 'humanScore', 'note'], blindRows),
    keyRows,
    blindRows,
    stats: {
      poolSize: pool.length,
      selected: picked.length,
      enriched: enriched.length,
      rate,
      seed,
      byArm,
      judgeDist: dist,
      // 盲性自检：盲表列名不得含臂/分数字段
      blindColumns: ['itemId', 'question', 'goldAnswer', 'pred', 'humanScore', 'note'],
    },
  };
}

function writeCalibration({ judgeRows, queries, outDir, rate = 0.25, enrichPerClass = 0, seed = 20261112 }) {
  const built = buildCalibration({ judgeRows, queries, rate, enrichPerClass, seed });
  fs.mkdirSync(outDir, { recursive: true });
  const blindPath = path.join(outDir, 'human-calibration-blind.csv');
  const keyPath = path.join(outDir, 'human-calibration-key.jsonl');
  fs.writeFileSync(blindPath, '\ufeff' + built.blindCsv, 'utf8');
  fs.writeFileSync(keyPath, built.keyRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  if (rate === 1) {
    // 全量校准：额外落一份不含富集样本的纯净版（富集后不能算无偏 κ）
    const clean = buildCalibration({ judgeRows, queries, rate: 1, enrichPerClass: 0, seed });
    fs.writeFileSync(path.join(outDir, 'human-calibration-blind.full.csv'), '\ufeff' + clean.blindCsv, 'utf8');
    fs.writeFileSync(path.join(outDir, 'human-calibration-key.full.jsonl'), clean.keyRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return { blindPath, keyPath, stats: built.stats };
}

// ---------------------------------------------------------------- 一致性统计

function emptyTable() {
  return SCORE_DOMAIN.map(() => SCORE_DOMAIN.map(() => 0));
}

/** 3×3 混淆表：行 = 人，列 = judge */
function confusionOf(pairs) {
  const t = emptyTable();
  for (const p of pairs) t[p.human][p.judge] += 1;
  return t;
}

function poOf(pairs) {
  if (!pairs.length) return null;
  return pairs.filter((p) => p.human === p.judge).length / pairs.length;
}

/** 期望一致率：以两侧边际分布独立为基准 */
function peOf(pairs) {
  if (!pairs.length) return null;
  const n = pairs.length;
  const mh = [0, 0, 0];
  const mj = [0, 0, 0];
  for (const p of pairs) { mh[p.human] += 1; mj[p.judge] += 1; }
  let pe = 0;
  for (let k = 0; k < 3; k++) pe += (mh[k] / n) * (mj[k] / n);
  return pe;
}

function kappaFrom(po, pe) {
  if (po === null || pe === null) return null;
  if (pe >= 1 - 1e-12) return null; // 全同一类：κ 无定义
  return (po - pe) / (1 - pe);
}

function cohenKappa(pairs) {
  const po = poOf(pairs);
  const pe = peOf(pairs);
  return { n: pairs.length, po, pe, kappa: kappaFrom(po, pe) };
}

/** 加权 κ：quadratic 权重 (i-j)^2/(K-1)^2 —— 相邻分歧（0↔1）比跨档分歧（0↔2）罚得轻 */
function weightedKappa(pairs, { type = 'quadratic' } = {}) {
  if (!pairs.length) return { n: 0, kappa: null, po: null, pe: null, type };
  const K = 3;
  const t = emptyTable();
  const mh = [0, 0, 0];
  const mj = [0, 0, 0];
  for (const p of pairs) { t[p.human][p.judge] += 1; mh[p.human] += 1; mj[p.judge] += 1; }
  const n = pairs.length;
  const w = (i, j) => (type === 'linear' ? Math.abs(i - j) / (K - 1) : ((i - j) ** 2) / ((K - 1) ** 2));
  let num = 0;
  let den = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      num += w(i, j) * t[i][j];
      den += w(i, j) * ((mh[i] * mj[j]) / n);
    }
  }
  return { n, type, kappa: den > 1e-12 ? 1 - num / den : null, po: poOf(pairs), pe: peOf(pairs) };
}

/**
 * Gwet's AC1：专治「患病率悖论」——两方都强烈偏向某一类时 κ 会被压低到失真，
 * AC1 用 π_k(1-π_k) 作机会基准，对偏斜分布稳健。κ 低而 AC1 高 = 分布问题而非判读问题。
 */
function gwetAC1(pairs) {
  if (!pairs.length) return { n: 0, ac1: null };
  const n = pairs.length;
  const mh = [0, 0, 0];
  const mj = [0, 0, 0];
  for (const p of pairs) { mh[p.human] += 1; mj[p.judge] += 1; }
  let pe = 0;
  for (let k = 0; k < 3; k++) {
    const pi = (mh[k] + mj[k]) / (2 * n);
    pe += pi * (1 - pi);
  }
  pe /= 2; // K-1 = 2
  const po = poOf(pairs);
  return { n, po, pe, ac1: pe >= 1 - 1e-12 ? null : (po - pe) / (1 - pe) };
}

/** PABAK = 2·po − 1：完全不看机会一致，作为「κ 被患病率压低」的旁证 */
function pabak(pairs) {
  const po = poOf(pairs);
  return { n: pairs.length, po, pabak: po === null ? null : 2 * po - 1 };
}

/** 二元化诊断：{0} 视为「不对」、{1,2} 视为「对」——产品真正关心的切法 */
function binaryDiagnostics(pairs) {
  let bothRight = 0;
  let bothWrong = 0;
  let judgeOnlyRight = 0;
  let humanOnlyRight = 0;
  for (const p of pairs) {
    const h = p.human > 0;
    const j = p.judge > 0;
    if (h && j) bothRight++;
    else if (!h && !j) bothWrong++;
    else if (j) judgeOnlyRight++;
    else humanOnlyRight++;
  }
  const n = pairs.length || 1;
  return {
    bothRight, bothWrong, judgeOnlyRight, humanOnlyRight,
    prevalenceIndex: Math.abs((bothRight + bothWrong) - (judgeOnlyRight + humanOnlyRight)) / n,
    biasIndex: Math.abs(judgeOnlyRight - humanOnlyRight) / n,
    note: 'prevalenceIndex 大 = 分布偏斜会压低 κ；biasIndex 大 = 一方系统性更宽松',
  };
}

function meanOf(a) {
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

/** 按臂拆：一致性 + 有符号偏差（judge − human） */
function byArm(pairs) {
  const arms = [...new Set(pairs.map((p) => p.arm))].sort();
  const out = {};
  for (const arm of arms) {
    const sub = pairs.filter((p) => p.arm === arm);
    const k = cohenKappa(sub);
    out[arm] = {
      n: sub.length,
      po: k.po,
      kappa: sub.length >= 20 ? k.kappa : null, // n<20 的 κ 噪声过大，只报 po 与偏差
      kappaNote: sub.length >= 20 ? null : 'n<20，κ 不稳定，仅报一致率与偏差',
      meanJudge: meanOf(sub.map((p) => p.judge)),
      meanHuman: meanOf(sub.map((p) => p.human)),
      meanSignedBias: meanOf(sub.map((p) => p.judge - p.human)),
      dist: {
        human: [0, 1, 2].map((s) => sub.filter((p) => p.human === s).length),
        judge: [0, 1, 2].map((s) => sub.filter((p) => p.judge === s).length),
      },
    };
  }
  return out;
}

/** 簇自助：按 queryId 重采样（同一题的多条答案相关，不能按条独立重采） */
function clusterBootstrap(pairs, statFn, { reps = 2000, seed = 42 } = {}) {
  const byCluster = new Map();
  for (const p of pairs) {
    if (!byCluster.has(p.queryId)) byCluster.set(p.queryId, []);
    byCluster.get(p.queryId).push(p);
  }
  const clusters = [...byCluster.keys()];
  if (clusters.length < 2) return { point: statFn(pairs), ci95: null, reps: 0, nClusters: clusters.length };
  const rand = mulberry32(seed);
  const vals = [];
  for (let r = 0; r < reps; r++) {
    const sample = [];
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      sample.push(...byCluster.get(c));
    }
    const v = statFn(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.025)];
  const hi = vals[Math.floor(vals.length * 0.975) - 1] ?? vals[vals.length - 1];
  return { point: statFn(pairs), ci95: vals.length ? [lo, hi] : null, reps: vals.length, nClusters: clusters.length };
}

// ---------------------------------------------------------------- 评分与闸门

function normalizeScore(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return { ok: false, reason: 'missing' };
  if (!/^[0-2]$/.test(s)) return { ok: false, reason: 'invalid' };
  return { ok: true, value: Number(s) };
}

/**
 * 读已填好的盲评表 + key，算全部一致性统计与放行结论。
 * 不做任何静默修复：缺填/非法值逐条列出，并阻止出结论。
 */
function evaluateCalibration({ sheetCsv, keyRows, cfg = {}, reps = 2000, seed = 42, strata = null }) {
  const sheet = parseCsv(sheetCsv).filter((r) => String(r.itemId || '').trim() !== '');
  const keyById = new Map(keyRows.map((k) => [k.itemId, k]));

  // 「是否依赖图片」分层：优先读表内 needsImage 列（v2 表自带），
  // 否则用外部传入的 strata 映射（HTML 导出只有三列时靠 --strata 补）。
  // 依赖图的题模型看不到图、pred 系统性偏差，混进主 κ 会把「判不了」误报成「判不准」。
  const needsImageOf = (id, row) => {
    const cell = row && row.needsImage != null ? String(row.needsImage).trim() : '';
    if (cell !== '') return cell === '1';
    if (strata && strata.has(id)) return Boolean(strata.get(id));
    return null;
  };

  const missing = [];
  const invalid = [];
  const unknown = [];
  const allPairs = [];

  for (const r of sheet) {
    const id = String(r.itemId).trim();
    const k = keyById.get(id);
    if (!k) { unknown.push(id); continue; }
    const primary = normalizeScore(r.humanScore);
    if (!primary.ok) {
      (primary.reason === 'missing' ? missing : invalid).push(id);
      continue;
    }
    const second = normalizeScore(r.humanScore2);
    allPairs.push({
      itemId: id,
      queryId: k.queryId,
      arm: k.arm,
      judge: k.judgeScore,
      human: primary.value,
      human2: second.ok ? second.value : null,
      enriched: Boolean(k.enriched),
      needsImage: needsImageOf(id, r),
      note: String(r.note || ''),
    });
  }

  // 富集样本只为看清中间档分歧，混进来会让 κ 有偏 → 主统计一律只用随机样本
  const hasEnriched = allPairs.some((p) => p.enriched);
  const pairs = hasEnriched ? allPairs.filter((p) => !p.enriched) : allPairs;
  const enrichedPairs = hasEnriched ? allPairs.filter((p) => p.enriched) : [];

  const rated = allPairs.length;
  const mainRated = pairs.length;
  const expected = sheet.length;
  const mainExpected = sheet.filter((r) => !keyById.get(String(r.itemId).trim())?.enriched).length;
  const complete = missing.length === 0 && invalid.length === 0 && unknown.length === 0;

  const kappa = cohenKappa(pairs);
  const wKappa = weightedKappa(pairs, { type: 'quadratic' });
  const wKappaLin = weightedKappa(pairs, { type: 'linear' });
  const ac1 = gwetAC1(pairs);
  const pb = pabak(pairs);
  const bin = binaryDiagnostics(pairs);
  const arms = byArm(pairs);

  const bootW = clusterBootstrap(pairs, (ps) => weightedKappa(ps, { type: 'quadratic' }).kappa, { reps, seed });
  const bootK = clusterBootstrap(pairs, (ps) => cohenKappa(ps).kappa, { reps, seed });

  // 差异化偏差：R 与 X 的 judge−human 均值差（真正威胁 ΔREL 的量）
  const biasOf = (ps, arm) => {
    const sub = ps.filter((p) => p.arm === arm);
    return sub.length ? meanOf(sub.map((p) => p.judge - p.human)) : null;
  };
  const biasDiffPoint = (() => {
    const r = biasOf(pairs, 'R');
    const x = biasOf(pairs, 'X');
    return r === null || x === null ? null : r - x;
  })();
  const bootBiasDiff = (() => {
    if (biasDiffPoint === null) return { point: null, ci95: null };
    return clusterBootstrap(pairs, (ps) => {
      const r = biasOf(ps, 'R');
      const x = biasOf(ps, 'X');
      return r === null || x === null ? NaN : r - x;
    }, { reps, seed });
  })();

  // 双人一致性（若表里有 humanScore2）
  const dualPairs = pairs.filter((p) => Number.isFinite(p.human2));
  const interHuman = dualPairs.length
    ? {
      n: dualPairs.length,
      po: dualPairs.filter((p) => p.human === p.human2).length / dualPairs.length,
      kappa: kappaFrom(
        dualPairs.filter((p) => p.human === p.human2).length / dualPairs.length,
        peOf(dualPairs.map((p) => ({ human: p.human, judge: p.human2 })))
      ),
    }
    : null;

  // 依赖图片分层：题库里有 1/4 的题要图才能作答，而模型在四臂里都看不到图，
  // 这些题的 pred 会系统性偏低。混在一起算，会把「这几题本来判不了」
  // 伪装成「judge 判不准」。分开报，哪边掉一目了然。
  const subStats = (ps) => {
    if (!ps.length) return null;
    // 单条样本算不出 κ，但仍要如实报出「这组有几条」，否则会被误读成「这组不存在」
    if (ps.length < 2) {
      return { n: ps.length, po: null, weightedKappaQuadratic: null, ci95: null, ac1: null, insufficient: true };
    }
    const w = weightedKappa(ps, { type: 'quadratic' });
    const b = clusterBootstrap(ps, (ss) => weightedKappa(ss, { type: 'quadratic' }).kappa, {
      reps: Math.min(reps, 1000),
      seed,
    });
    return {
      n: ps.length,
      po: cohenKappa(ps).po,
      weightedKappaQuadratic: w.kappa,
      ci95: b.ci95,
      ac1: gwetAC1(ps).ac1,
      insufficient: false,
    };
  };
  const noImg = pairs.filter((p) => p.needsImage === false);
  const withImg = pairs.filter((p) => p.needsImage === true);
  const byNeedsImage = noImg.length + withImg.length > 0
    ? {
      note: '依赖图的题模型看不到图 → pred 系统性偏低；分开报以区分「判不了」与「judge 判不准」',
      unknown: pairs.filter((p) => p.needsImage === null).length,
      noImage: subStats(noImg),
      withImage: subStats(withImg),
    }
    : null;

  const gate = decideGate({
    weightedKappa: wKappa.kappa,
    ci: bootW.ci95,
    minKappa: cfg.minHumanKappa ?? 0.6,
    biasDiff: biasDiffPoint,
    biasDiffCI: bootBiasDiff.ci95,
    complete,
    n: mainRated,
    expected: mainExpected,
    missingCount: missing.length,
  });

  return {
    generatedAt: new Date().toISOString(),
    complete,
    n: {
      rated,
      expected,
      mainRated,
      mainExpected,
      enrichedRated: enrichedPairs.length,
      missing: missing.length,
      invalid: invalid.length,
      unknown: unknown.length,
    },
    missing, invalid, unknown,
    agreement: {
      po: kappa.po,
      pe: kappa.pe,
      cohenKappa: kappa.kappa,
      cohenKappaCI: bootK.ci95,
      weightedKappaQuadratic: wKappa.kappa,
      weightedKappaQuadraticCI: bootW.ci95,
      weightedKappaLinear: wKappaLin.kappa,
      gwetAC1: ac1.ac1,
      pabak: pb.pabak,
      bootstrap: { reps: bootW.reps, nClusters: bootW.nClusters, unit: 'queryId' },
    },
    binaryDiagnostics: bin,
    confusion: confusionOf(pairs),
    byArm: arms,
    differentialBias: {
      meanSignedBias: Object.fromEntries(Object.entries(arms).map(([a, v]) => [a, v.meanSignedBias])),
      RminusX: biasDiffPoint,
      RminusXCI: bootBiasDiff.ci95,
      note: 'judge − human 的有符号均值；R−X 若显著为正，说明 judge 对检索臂系统性宽松，ΔREL 需用人类分重算',
    },
    interHuman,
    byNeedsImage,
    enrichedOnly: enrichedPairs.length
      ? {
        n: enrichedPairs.length,
        po: poOf(enrichedPairs),
        dist: {
          human: [0, 1, 2].map((s) => enrichedPairs.filter((p) => p.human === s).length),
          judge: [0, 1, 2].map((s) => enrichedPairs.filter((p) => p.judge === s).length),
        },
        items: enrichedPairs.map((p) => ({ itemId: p.itemId, judge: p.judge, human: p.human, note: p.note })),
        note: '富集样本（judge 判中间档）单独看：判断人对「部分正确」这一档是否与 judge 同构；不并入主 κ',
      }
      : null,
    gate,
    protocol: {
      rubricSha256: cfg.rubricSha256 ?? null,
      judgeModel: cfg.judgeModel ?? null,
      seed, reps,
      enrichedExcludedFromMain: hasEnriched,
      note: 'κ 只在随机盲评样本上算；富集样本仅用于看中间档分歧，不进主 κ',
    },
  };
}

function decideGate({ weightedKappa, ci, minKappa, biasDiff, biasDiffCI, complete, n, expected, missingCount = null }) {
  const reasons = [];
  const gaps = missingCount === null ? Math.max(0, expected - n) : missingCount;
  if (!complete) reasons.push(`表未填完：缺填 ${gaps} 条/存在非法值，κ 不可用`);
  if (weightedKappa === null || weightedKappa === undefined) reasons.push('κ 无定义（样本全同类或 n 过小）');
  if (!ci) reasons.push('CI 无法估计（簇数过少）');

  let level = 'unusable';
  if (complete && Number.isFinite(weightedKappa)) {
    if (weightedKappa >= minKappa && ci && ci[0] >= minKappa - 0.15) level = 'primary';
    else if (weightedKappa >= 0.4) level = 'directional';
    else level = 'unusable';
  }
  if (complete && Number.isFinite(weightedKappa)) {
    reasons.push(`κ_w=${weightedKappa.toFixed(3)}${ci ? ` [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : ''}，门槛 ${minKappa}`);
    if (level === 'primary') reasons.push('κ 与下界均达标 → L3 可作主证据之一');
    if (level === 'directional') reasons.push('κ 落在 0.40–0.60 或下界偏低 → L3 仅报方向，不得作为判定唯一依据');
    if (level === 'unusable') reasons.push('κ < 0.40 → L3 作废，结论回落 L2 + 替代 L1');
  }

  const biasAlarm = Number.isFinite(biasDiff) && Math.abs(biasDiff) >= 0.25;
  if (biasAlarm) {
    reasons.push(`差异化偏差 |bias(R)−bias(X)|=${Math.abs(biasDiff).toFixed(3)} ≥ 0.25 → ΔREL 须用人类分做敏感性重算`);
  } else if (Number.isFinite(biasDiff)) {
    reasons.push(`差异化偏差 ${biasDiff.toFixed(3)}（< 0.25，未触发）`);
  }

  return {
    level,
    l3UsableForVerdict: level !== 'unusable',
    verdictMayRelyOnL3: level === 'primary',
    biasAlarm,
    biasDiffCI: biasDiffCI ?? null,
    reasons,
  };
}

/** 算「达到给定 CI 半宽所需条数」，用于回答「n 够不够」 */
function requiredN({ po = 0.85, pe = 0.5, halfWidth = 0.1, z = 1.96 } = {}) {
  const se = (halfWidth / z) * (1 - pe);
  if (se <= 0) return null;
  return Math.ceil((po * (1 - po)) / (se * se));
}

// ---------------------------------------------------------------- CLI

function argGet(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function main() {
  const evalDir = argGet('eval-dir', 'data/stage1/eval');
  const judgeDir = path.join(evalDir, 'judge');

  if (hasFlag('build')) {
    const judgeRows = readJsonl(path.join(judgeDir, 'judge.jsonl')).filter((r) => r.pass === 1);
    const evalSet = argGet('eval-set', 'data/evalset/eval-queries.json');
    const queries = JSON.parse(fs.readFileSync(evalSet, 'utf8'));
    const rate = Number(argGet('rate', '0.25'));
    const enrich = Number(argGet('enrich-ones', '0'));
    const { blindPath, keyPath, stats } = writeCalibration({
      judgeRows, queries, outDir: judgeDir, rate, enrichPerClass: enrich, seed: Number(argGet('seed', '20261112')),
    });
    console.log(`[κ] 盲评表 ${blindPath}（${stats.selected + stats.enriched} 条，rate=${rate}）`);
    console.log(`[κ] 密钥文件 ${keyPath}`);
    console.log(`[κ] 各臂条数 ${JSON.stringify(stats.byArm)}；judge 分布 ${JSON.stringify(stats.judgeDist)}`);
    if (stats.judgeDist['1'] === 0) {
      console.log('[κ][WARN] 样本中没有 judge=1 的条目：中间档无法估计，建议 --enrich-ones 10 单独补样（不并入主 κ）');
    }
    return;
  }

  if (hasFlag('score')) {
    const sheetPath = argGet('sheet', path.join(judgeDir, 'human-calibration-blind.csv'));
    const keyPath = argGet('key', path.join(judgeDir, 'human-calibration-key.jsonl'));
    const cfg = JSON.parse(fs.readFileSync(argGet('config', 'configs/rag-eval-config.json'), 'utf8'));

    // 分层信息（是否依赖图片）：审阅器导出的是三列 CSV，表里没有 needsImage，
    // 需用 --strata 指向 v2 表补齐；若直接在 v2 表里填分，则自动读取。
    const strataPath = argGet('strata', null);
    let strata = null;
    if (strataPath) {
      const sRows = parseCsv(fs.readFileSync(strataPath, 'utf8'));
      strata = new Map();
      for (const r of sRows) {
        const id = String(r.itemId || '').trim();
        if (!id) continue;
        strata.set(id, String(r.needsImage || '').trim() === '1');
      }
    }

    const rep = evaluateCalibration({
      sheetCsv: fs.readFileSync(sheetPath, 'utf8'),
      keyRows: readJsonl(keyPath),
      cfg: cfg.judge || {},
      reps: Number(argGet('reps', '2000')),
      strata,
    });
    const outPath = path.join(path.dirname(sheetPath), 'kappa-report.json');
    fs.writeFileSync(outPath, JSON.stringify(rep, null, 2));

    const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'NA');
    console.log(`[κ] 已评 ${rep.n.rated}/${rep.n.expected}（缺填 ${rep.missing.length}，非法 ${rep.invalid.length}，未知 id ${rep.unknown.length}）`
      + `；主 κ 用 ${rep.n.mainRated}/${rep.n.mainExpected}${rep.n.enrichedRated ? `，富集 ${rep.n.enrichedRated} 条单列` : ''}`);
    console.log(`[κ] po=${f(rep.agreement.po)}  Cohen κ=${f(rep.agreement.cohenKappa)} ${rep.agreement.cohenKappaCI ? `[${rep.agreement.cohenKappaCI.map(f).join(', ')}]` : ''}`);
    console.log(`[κ] 加权 κ(quad) = ${f(rep.agreement.weightedKappaQuadratic)} ${rep.agreement.weightedKappaQuadraticCI ? `[${rep.agreement.weightedKappaQuadraticCI.map(f).join(', ')}]` : ''}`);
    console.log(`[κ] AC1=${f(rep.agreement.gwetAC1)}  PABAK=${f(rep.agreement.pabak)}  biasIdx=${f(rep.binaryDiagnostics.biasIndex)}`);
    console.log('[κ] 各臂 judge−human 偏差：' + Object.entries(rep.differentialBias.meanSignedBias).map(([a, v]) => `${a}=${f(v)}`).join('  '));
    console.log(`[κ] 判定：${rep.gate.level}（L3 可用于判定：${rep.gate.l3UsableForVerdict}，可作为主证据：${rep.gate.verdictMayRelyOnL3}）`);
    for (const r of rep.gate.reasons) console.log(`      · ${r}`);
    if (rep.byNeedsImage) {
      const seg = (lab, s) => (s
        ? `${lab} n=${s.n} κ_w=${f(s.weightedKappaQuadratic)}${s.ci95 ? `[${s.ci95.map(f).join(', ')}]` : ''} po=${f(s.po)} AC1=${f(s.ac1)}`
        : `${lab} 样本不足`);
      console.log(`[κ] 分层（依赖图片）：`);
      console.log(`      ${seg('不含图', rep.byNeedsImage.noImage)}`);
      console.log(`      ${seg('含图  ', rep.byNeedsImage.withImage)}`);
      if (rep.byNeedsImage.unknown) console.log(`      分层未知 ${rep.byNeedsImage.unknown} 条（--strata 未提供或表无 needsImage 列）`);
    }
    console.log(`[κ] 报告 ${outPath}`);
    if (!rep.complete) process.exitCode = 2;
    return;
  }

  if (hasFlag('required-n')) {
    const n = requiredN({
      po: Number(argGet('po', '0.85')),
      pe: Number(argGet('pe', '0.5')),
      halfWidth: Number(argGet('half-width', '0.1')),
    });
    console.log(`[κ] 要达到 95%CI 半宽 ${argGet('half-width', '0.1')}，约需 ${n} 条（当前池 800 条 → rate≈${(n / 800).toFixed(3)}）`);
    return;
  }

  console.log('用法：');
  console.log('  node src/stage1/calibration.js --build [--rate 0.25] [--enrich-ones 10]');
  console.log('  node src/stage1/calibration.js --score [--sheet <filled.csv>] [--key <key.jsonl>]');
  console.log('  node src/stage1/calibration.js --required-n [--po .85 --pe .5 --half-width .1]');
}

if (require.main === module) main();

module.exports = {
  SCORE_DOMAIN,
  parseCsv,
  toCsv,
  uniformFrom,
  buildCalibration,
  writeCalibration,
  confusionOf,
  poOf,
  peOf,
  cohenKappa,
  weightedKappa,
  gwetAC1,
  pabak,
  binaryDiagnostics,
  byArm,
  clusterBootstrap,
  evaluateCalibration,
  decideGate,
  requiredN,
  readJsonl,
};
