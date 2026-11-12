/**
 * 多臂一次性配对 bootstrap——KT bootstrapAllModels 的泛化版。
 *
 * 与 KT 版的差异（设计 §9）：KT 版内部写死 buildEvaluator（AUC/LogLoss 口径），
 * 本版把评估器抽为 meanScoreOf（加权均值），并新增「行对齐校验」：
 * 各臂 rows 必须按同一 query 顺序排列（配对的前提），错位会静默破坏配对，
 * 所以在入口直接拒绝。
 *
 * 纪律继承：
 *   - 同一批重采样权重同时用于所有臂 → CI 与两两配对天然配对；
 *   - 方向判定只用未舍入 ciPrecise，舍入值仅展示；
 *   - 点估计差（报告用 Δ）与 bootstrap 均值分开报告。
 */

const { mulberry32, ciOf, ciPreciseOf, pValueOf, round4 } = require('./core');
const { buildGroupSampler } = require('./sampler');
const { meanScoreOf } = require('./evaluator');

function bootstrapArms(rowsByArm, { reps = 2000, seed = 42, groupKey = 'userId' } = {}) {
  const arms = Object.keys(rowsByArm);
  if (!arms.length) return { ciByArm: {}, comparisons: [], reps: 0, groupCount: 0 };
  if (reps < 1) throw new Error('bootstrapArms: reps 必须 ≥ 1');

  const base = rowsByArm[arms[0]];
  for (const arm of arms) {
    const rows = rowsByArm[arm];
    if (rows.length !== base.length) {
      throw new Error(`bootstrapArms 要求各臂行数一致：${arm} ${rows.length} vs ${base.length}`);
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][groupKey] !== base[i][groupKey]) {
        throw new Error(
          `bootstrapArms 各臂行未按 ${groupKey} 对齐（第 ${i} 行：${arm}=${rows[i][groupKey]} vs ${arms[0]}=${base[i][groupKey]}）。` +
          '配对 bootstrap 的前提是同 query 对齐，错位必须显式报错而不是静默配错。'
        );
      }
    }
  }

  const sampler = buildGroupSampler(base, { groupKey });
  const rand = mulberry32(seed);

  // 点估计（未舍入）：全 1 权重
  const allOne = new Float64Array(base.length).fill(1);
  const pointMeans = {};
  for (const arm of arms) pointMeans[arm] = meanScoreOf(rowsByArm[arm], allOne);

  const samples = {};
  for (const arm of arms) samples[arm] = [];
  const pairs = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) pairs.push({ a: arms[i], b: arms[j], diffs: [] });
  }

  for (let r = 0; r < reps; r++) {
    const w = sampler.sampleWeights(rand);
    const means = {};
    for (const arm of arms) {
      means[arm] = meanScoreOf(rowsByArm[arm], w);
      if (means[arm] !== null) samples[arm].push(means[arm]);
    }
    for (const pair of pairs) {
      const ma = means[pair.a];
      const mb = means[pair.b];
      if (ma !== null && mb !== null) pair.diffs.push(ma - mb);
    }
  }

  const ciByArm = {};
  for (const arm of arms) {
    const sorted = [...samples[arm]].sort((x, y) => x - y);
    const precise = ciPreciseOf(sorted);
    ciByArm[arm] = {
      meanExact: pointMeans[arm],
      mean4: round4(pointMeans[arm]),
      ciPrecise: precise,
      ci4: [round4(precise[0]), round4(precise[1])],
      validDraws: sorted.length
    };
  }

  const comparisons = pairs.map((pair) => {
    const sorted = [...pair.diffs].sort((x, y) => x - y);
    const bootMean = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : null;
    const precise = ciPreciseOf(sorted);
    return {
      a: pair.a,
      b: pair.b,
      comparison: `${pair.a} − ${pair.b}`,
      pointDiff: pointMeans[pair.a] !== null && pointMeans[pair.b] !== null
        ? pointMeans[pair.a] - pointMeans[pair.b]
        : null,
      bootstrapMeanDiff: bootMean,
      deltaCI: precise, // 未舍入，方向判定唯一依据
      deltaCI4: [round4(precise[0]), round4(precise[1])],
      p: pValueOf(sorted),
      supportFlag: precise[0] !== null && precise[0] > 0,
      negativeFlag: precise[1] !== null && precise[1] < 0,
      validDraws: sorted.length
    };
  });

  return { ciByArm, comparisons, reps, groupCount: sampler.groupCount };
}

module.exports = { bootstrapArms };
