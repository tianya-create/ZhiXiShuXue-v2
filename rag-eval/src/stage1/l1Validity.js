/**
 * 替代 L1 的效度检验：步骤覆盖率能不能预测「真的答对」。
 *
 * 一个检索侧的代理指标（proxy）只有在与下游正确率相关时才配叫 L1。否则它只是
 * 「上下文和解析长得像」的相似度，不能用来支持 ret-strong。
 *
 * 三个检验（都只用 eval 的落盘结果，零新调用）：
 *   V1 同臂相关：R 臂覆盖率 vs R 臂 token-F1（逐 query Pearson / Spearman）
 *   V2 配对增益：覆盖率增量 (R−X) vs F1 增量 (R−X)——控制题目难度后仍应正相关
 *   V3 分档单调：按覆盖率分档看 F1 是否单调升
 *
 * 用法：node src/stage1/l1Validity.js --eval-dir data/stage1/eval --steps data/stage1/steps/step-coverage-eval.json
 */

const fs = require('fs');
const path = require('path');

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function mean(a) {
  const v = a.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) return { r: null, n };
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let num = 0; let dx = 0; let dy = 0;
  for (const [x, y] of pairs) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
  return { r: dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null, n };
}

function rankOf(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(arr.length);
  for (let i = 0; i < idx.length; i++) ranks[idx[i][1]] = i + 1;
  return ranks;
}

function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return { rho: null, n: pairs.length };
  return { rho: pearson(rankOf(pairs.map((p) => p[0])), rankOf(pairs.map((p) => p[1]))).r, n: pairs.length };
}

function main() {
  const evalDir = argOf('eval-dir', 'data/stage1/eval');
  const stepsPath = argOf('steps', 'data/stage1/steps/step-coverage-eval.json');
  const outPath = argOf('out', 'data/stage1/steps/l1-validity.json');

  const steps = JSON.parse(fs.readFileSync(stepsPath, 'utf8'));
  const rows = readJsonl(path.join(evalDir, 'responses.jsonl'));

  // 逐 query 聚合 F1（同一 query 的多次采样取均值）
  const f1 = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.tokenF1)) continue;
    const k = `${r.queryId}|${r.arm}`;
    if (!f1.has(k)) f1.set(k, []);
    f1.get(k).push(r.tokenF1);
  }
  const f1Of = (qid, arm) => {
    const v = f1.get(`${qid}|${arm}`);
    return v && v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  const idx = new Map();
  for (const r of steps.perQuery) idx.set(`${r.queryId}|${r.arm}`, r);
  const queryIds = [...new Set(steps.perQuery.map((r) => r.queryId))];

  const cov = (qid, arm, field) => {
    const r = idx.get(`${qid}|${arm}`);
    return r ? r[field] : null;
  };

  // V1：同臂相关
  const v1 = {};
  for (const arm of ['R', 'X', 'O']) {
    const xs = queryIds.map((q) => cov(q, arm, 'coverageSkeletonNoEcho'));
    const ys = queryIds.map((q) => f1Of(q, arm));
    const p = pearson(xs, ys);
    const s = spearman(xs, ys);
    v1[arm] = { field: 'coverageSkeletonNoEcho', pearson: p.r, pearsonN: p.n, spearman: s.rho };
  }

  // V2：配对增益相关（控制题目难度）
  const dx = []; const dy = [];
  for (const q of queryIds) {
    const cr = cov(q, 'R', 'coverageSkeletonNoEcho');
    const cx = cov(q, 'X', 'coverageSkeletonNoEcho');
    const fr = f1Of(q, 'R');
    const fx = f1Of(q, 'X');
    if ([cr, cx, fr, fx].every(Number.isFinite)) { dx.push(cr - cx); dy.push(fr - fx); }
  }
  const v2 = { pearson: pearson(dx, dy).r, n: dx.length, meanDeltaCov: mean(dx), meanDeltaF1: mean(dy) };

  // V3：分档单调
  const buckets = [
    { label: '0（完全没覆盖）', test: (v) => v === 0 },
    { label: '(0, 0.5)', test: (v) => v > 0 && v < 0.5 },
    { label: '[0.5, 1)', test: (v) => v >= 0.5 && v < 1 },
    { label: '1（全步覆盖）', test: (v) => v === 1 },
  ];
  const v3 = buckets.map((b) => {
    const qs = queryIds.filter((q) => b.test(cov(q, 'R', 'coverageSkeletonNoEcho')));
    return { bucket: b.label, n: qs.length, meanF1_R: mean(qs.map((q) => f1Of(q, 'R'))), meanF1_X: mean(qs.map((q) => f1Of(q, 'X'))) };
  }).filter((b) => b.n > 0);

  // V4：算式级同臂相关（辅助）
  const xs4 = queryIds.map((q) => cov(q, 'R', 'exprCoverageCompound'));
  const ys4 = queryIds.map((q) => f1Of(q, 'R'));
  const v4 = { field: 'exprCoverageCompound', pearson: pearson(xs4, ys4).r, n: pearson(xs4, ys4).n };

  const result = {
    generatedAt: new Date().toISOString(),
    evalDir, stepsPath,
    nQueries: queryIds.length,
    v1_sameArm: v1,
    v2_pairedGain: v2,
    v3_buckets: v3,
    v4_exprSameArm: v4,
    verdict: (() => {
      const okV1 = Number.isFinite(v1.R.pearson) && v1.R.pearson > 0.2;
      const okV2 = Number.isFinite(v2.pearson) && v2.pearson > 0.2;
      if (okV1 && okV2) return '指标可用：覆盖率与正确率同向，且能预测检索带来的增益';
      if (okV1 || okV2) return '指标部分可用：仅其中一个检验为正向，结论须标注';
      return '指标不可用：覆盖率与正确率无正相关，不能作为 ret-strong 的证据';
    })(),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  const p = (x) => (x === null || x === undefined ? 'NA' : x.toFixed(3));
  console.log('[效度] V1 同臂相关（覆盖率 vs F1）：' + ['R', 'X', 'O'].map((a) => `${a}: r=${p(v1[a].pearson)} ρ=${p(v1[a].spearman)}`).join('  '));
  console.log(`[效度] V2 配对增益：r=${p(v2.pearson)}（n=${v2.n}）；平均 Δcov=${p(v2.meanDeltaCov)} ΔF1=${p(v2.meanDeltaF1)}`);
  console.log('[效度] V3 分档：' + v3.map((b) => `${b.bucket} n=${b.n} F1_R=${p(b.meanF1_R)}`).join(' | '));
  console.log(`[效度] V4 算式级：r=${p(v4.pearson)}（n=${v4.n}）`);
  console.log(`[效度] 结论：${result.verdict}`);
  console.log(`[效度] 落盘 ${outPath}`);
}

if (require.main === module) main();
