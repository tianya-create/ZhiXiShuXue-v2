const params = require('./baselineParams.json');

/**
 * 规则掌握度基线（Rule-0 / Rule-1 / Rule-2）
 *
 * 任务定义：根据学生在时间 t 之前的答题记录，预测下一次遇到该知识点时是否答对。
 * 输出 mastery ∈ [0, 1]，作为下一题答对概率 p 使用。
 *
 * Rule-0：最近正确率（拉普拉斯平滑）
 * Rule-1：正确率 + 连续答题修正（提取自 backend/services/masteryEngine.js 的线上公式）
 * Rule-2：Rule-1 + 指数时间衰减 exp(-λd)
 *
 * 参数全部来自 baselineParams.json，固定不变，不按学生单独调整。
 */

// 记录按时间升序排序（isCorrect: boolean, costTime: number, createdAt: ISO 字符串）
function sortByTime(records) {
  return [...(records || [])].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
}

function daysBetween(laterMs, earlierMs) {
  return Math.max(0, (laterMs - earlierMs) / (1000 * 60 * 60 * 24));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

// 掌握度作为答对概率输出，裁剪到安全区间 [probFloor, probCeil]，
// 避免 0/1 极端值导致 LogLoss 爆炸
function clip01(value, cfg = params) {
  const floor = Number.isFinite(cfg.probFloor) ? cfg.probFloor : 0;
  const ceil = Number.isFinite(cfg.probCeil) ? cfg.probCeil : 1;
  return Math.max(floor, Math.min(ceil, value));
}

function distinctQuestions(records) {
  return new Set(records.map((item) => item.questionId)).size;
}

// 拉普拉斯平滑正确率：(correct + prior) / (n + 2 * prior)
function smoothAccuracy(correctCount, total, prior) {
  const p = Number.isFinite(prior) ? prior : params.laplacePrior;
  return (correctCount + p) / (total + 2 * p);
}

/**
 * Rule-0：最近 windowSize 次平滑正确率
 */
function rule0(records, options = {}) {
  const cfg = { ...params, ...options };
  const recent = sortByTime(records).slice(-cfg.windowSize);
  if (!recent.length) {
    return { mastery: cfg.coldStartMastery, accuracy: null, sampleCount: 0, confidence: 'none' };
  }
  const correctCount = recent.filter((item) => item.isCorrect).length;
  const mastery = clip01(smoothAccuracy(correctCount, recent.length, cfg.laplacePrior));
  return {
    mastery,
    accuracy: correctCount / recent.length,
    sampleCount: recent.length,
    confidence: recent.length >= cfg.minSamples ? 'sufficient' : 'limited'
  };
}

/**
 * Rule-1：Rule-0 + 连续答题修正，忠实提取自 masteryEngine.calculateMastery：
 *   - 最近 3 次全对且速度不慢于历史（last3Time <= historicalAvgTime * 1.2）→ +streakBoost
 *   - 最近 2 次全错 → -streakPenalty
 *   - 样本不足（次数 < minSamples 或去重题目 < minDistinctQuestions）→ mastery 封顶 insufficientCap
 * 结果裁剪到 [0, 1]。
 */
function rule1(records, options = {}) {
  const cfg = { ...params, ...options };
  const sorted = sortByTime(records);
  const recent = sorted.slice(-cfg.windowSize);
  if (!recent.length) {
    return { ...rule0(records, options), streakCorrect: 0, streakWrong: 0, sufficient: false };
  }

  const correctCount = recent.filter((item) => item.isCorrect).length;
  const accuracy = correctCount / recent.length;
  let mastery = smoothAccuracy(correctCount, recent.length, cfg.laplacePrior);

  // 连对 streakWindowCorrect 次 + 速度条件（历史时间 = 去掉最近 streakWindowCorrect 次后的均值）
  const lastC = sorted.slice(-cfg.streakWindowCorrect);
  const historicalTime = average(
    sorted.slice(0, -cfg.streakWindowCorrect)
      .map((item) => Number(item.costTime || 0))
      .filter(Boolean)
  );
  const lastCTime = average(lastC.map((item) => Number(item.costTime || 0)).filter(Boolean));
  const streakCorrect =
    lastC.length === cfg.streakWindowCorrect && lastC.every((item) => item.isCorrect) &&
    (!historicalTime || lastCTime <= historicalTime * cfg.speedTolerance);

  // 连错 streakWindowWrong 次
  const lastW = sorted.slice(-cfg.streakWindowWrong);
  const streakWrong = lastW.length === cfg.streakWindowWrong && lastW.every((item) => !item.isCorrect);

  if (streakCorrect) mastery += cfg.streakBoost;
  if (streakWrong) mastery -= cfg.streakPenalty;

  const sufficient =
    recent.length >= cfg.minSamples &&
    distinctQuestions(recent) >= cfg.minDistinctQuestions;
  if (!sufficient) mastery = Math.min(mastery, cfg.insufficientCap);

  return {
    mastery: clip01(mastery),
    accuracy,
    sampleCount: recent.length,
    confidence: sufficient ? 'sufficient' : 'limited',
    streakCorrect: streakCorrect ? 1 : 0,
    streakWrong: streakWrong ? 1 : 0,
    sufficient
  };
}

/**
 * Rule-2：Rule-1 结果乘以时间衰减 exp(-λd)，d 为距最近一次练习的天数
 */
function rule2(records, options = {}) {
  const cfg = { ...params, ...options };
  const base = rule1(records, options);
  const sorted = sortByTime(records);
  if (!sorted.length) return base;

  const lastTime = new Date(sorted[sorted.length - 1].createdAt).getTime();
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const days = daysBetween(now, lastTime);
  const decay = Math.exp(-cfg.decayRate * days);

  return {
    ...base,
    mastery: clip01(base.mastery * decay),
    daysSinceLastPractice: Number(days.toFixed(2)),
    decayFactor: Number(decay.toFixed(4))
  };
}

const MODELS = { 'Rule-0': rule0, 'Rule-1': rule1, 'Rule-2': rule2 };

// 统一入口：model = 'Rule-0' | 'Rule-1' | 'Rule-2'，返回下一题答对概率 p
function predictNextCorrect(model, records, options = {}) {
  const fn = MODELS[model];
  if (!fn) throw new Error(`未知基线模型: ${model}`);
  return fn(records, options).mastery;
}

module.exports = {
  params,
  sortByTime,
  rule0,
  rule1,
  rule2,
  predictNextCorrect
};
