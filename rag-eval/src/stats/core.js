/**
 * 统计工具核心：四个纯函数逐字复制自
 *   zhiXiShuXue/backend/models/bootstrapStats.js
 *   sha256 = dfcc9caa6f81e3b754c172769491c022d5a0634bf0a6256b5957dc1984e75dc4
 * 这四个函数与 KT 语义无关（PRNG / 百分位 / 未舍入 CI / 双侧 bootstrap p 值），
 * 属于可跨项目复用的统计纪律。若 KT 侧更新，须 sha256 比对后同步。
 *
 * 纪律说明（为什么必须保留 ciPreciseOf）：
 *   4 位舍入会把 [0.00004, …] 变成 [0, …]，把「方向稳定为正」错判成「跨零」，
 *   也会让 CI 与支持标志自相矛盾。方向判定必须基于未舍入百分位。
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/** 舍入到 4 位的展示用 CI */
function ciOf(sortedValues) {
  if (!sortedValues.length) return [null, null];
  return [
    Number(percentile(sortedValues, 0.025).toFixed(4)),
    Number(percentile(sortedValues, 0.975).toFixed(4))
  ];
}

/** 未舍入 CI（原始百分位 2.5/97.5）——方向判定唯一依据 */
function ciPreciseOf(sortedValues) {
  if (!sortedValues.length) return [null, null];
  return [percentile(sortedValues, 0.025), percentile(sortedValues, 0.975)];
}

/**
 * 双侧 bootstrap p 值：2 × min(P(Δ≤0), P(Δ≥0))，两端各加 1 平滑。
 * 全零差 → p=1；全部同号 → p = 2/(B+1)，不会出现 0。
 */
function pValueOf(diffs) {
  if (!diffs.length) return null;
  let below = 0;
  let above = 0;
  for (const d of diffs) {
    if (d <= 0) below++;
    if (d >= 0) above++;
  }
  const pLow = (below + 1) / (diffs.length + 1);
  const pHigh = (above + 1) / (diffs.length + 1);
  return Number(Math.min(1, 2 * Math.min(pLow, pHigh)).toFixed(4));
}

function round4(x) {
  return x === null ? null : Number(x.toFixed(4));
}

module.exports = { mulberry32, percentile, ciOf, ciPreciseOf, pValueOf, round4 };
