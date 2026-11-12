/**
 * RAG 口径的评估器：重采样权重下的加权均值。
 *
 * 为什么不能复用 KT 的 buildEvaluator（设计 §9）：它输出 AUC/LogLoss/Brier，
 * 是二分类概率口径（需要每行的连续 pred 与 0/1 target）。RAG 的逐条分数
 * （EM / token-F1 / judge 分归一化到 [0,1]）只需要均值，不需要排序一致性。
 */

/** 加权均值；weights 缺省视为全 1。无有效权重时返回 null（不可定义即拒绝给数） */
function meanScoreOf(rows, weights) {
  let sum = 0;
  let totalW = 0;
  for (let i = 0; i < rows.length; i++) {
    const w = weights ? weights[i] : 1;
    if (w === 0) continue;
    sum += w * rows[i].score;
    totalW += w;
  }
  return totalW > 0 ? sum / totalW : null;
}

/** 校验逐条分数合法（有限且在 [0,1] 内）；返回违规行下标列表 */
function scoreViolations(rows) {
  const bad = [];
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i].score;
    if (!Number.isFinite(s) || s < 0 || s > 1) bad.push(i);
  }
  return bad;
}

module.exports = { meanScoreOf, scoreViolations };
