const NodeCache = require('node-cache');
const db = require('../database/memory-db');

const recommendationCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });
const REVIEW_INTERVALS = [1, 2, 4, 7, 15];

function getCacheKey(userId, limit) {
  return `smart-recommendations:${userId}:${limit}`;
}

function jaccard(aSet, bSet) {
  const a = new Set(aSet.filter(Boolean));
  const b = new Set(bSet.filter(Boolean));
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let intersect = 0;
  union.forEach((item) => {
    if (a.has(item) && b.has(item)) intersect += 1;
  });
  return intersect / union.size;
}

function getRecentCorrectRate(userId, kpCode) {
  const attempts = db.find('student_answer')
    .filter((item) => item.userId === userId && item.kpCode === kpCode)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);

  if (!attempts.length) return 0.1;
  return attempts.filter((item) => item.isCorrect).length / attempts.length;
}

function getForgettingUrgency(userId, question) {
  const attempts = db.find('student_answer')
    .filter((item) => item.userId === userId && item.questionId === question.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (!attempts.length) return 0.8;
  const last = attempts[0];
  const days = Math.max(0, Math.round((Date.now() - new Date(last.createdAt).getTime()) / (24 * 60 * 60 * 1000)));
  const nearest = REVIEW_INTERVALS.reduce((best, current) => {
    return Math.abs(current - days) < Math.abs(best - days) ? current : best;
  }, REVIEW_INTERVALS[0]);
  return 1 / (Math.abs(nearest - days) + 0.5);
}

function excludeRecentCorrect(userId, questionId) {
  const recent = db.find('student_answer')
    .filter((item) => item.userId === userId && item.questionId === questionId && item.isCorrect)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (!recent) return false;
  return Date.now() - new Date(recent.createdAt).getTime() <= 3 * 24 * 60 * 60 * 1000;
}

function buildReason(question, weakKpName) {
  if (weakKpName) {
    return `因你常错${weakKpName}，推荐相似题继续巩固`;
  }
  return `因你在${question.kpCode || '该知识点'}上仍需巩固，推荐本题`;
}

function getSmartRecommendations(userId, limit = 10, refresh = false) {
  const cacheKey = getCacheKey(userId, limit);
  if (refresh) recommendationCache.del(cacheKey);
  const cached = recommendationCache.get(cacheKey);
  if (cached) return cached;

  const mistakes = db.getAllMistakesForStudent(userId).filter((item) => !item.isResolved);
  const questions = db.find('questions');
  const scored = [];

  questions.forEach((question) => {
    if (excludeRecentCorrect(userId, question.id)) return;

    const tags = [question.kpCode || question.knowledgePointId || '', question.errorType || ''];
    let bestSimilarity = 0;
    let bestMistake = null;

    mistakes.forEach((mistake) => {
      const similarity = jaccard(tags, [mistake.kpCode, mistake.errorType]);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMistake = mistake;
      }
    });

    const kpCode = question.kpCode || question.knowledgePointId || (Array.isArray(question.knowledgePoints) ? question.knowledgePoints[0] : '');
    const correctRate = getRecentCorrectRate(userId, kpCode);
    const kpWeight = 1 - Math.min(0.9, correctRate);
    const urgency = getForgettingUrgency(userId, question);
    const finalScore = bestSimilarity * 0.4 + kpWeight * 0.3 + urgency * 0.3;

    scored.push({
      ...question,
      kpCode,
      score: Number(finalScore.toFixed(4)),
      recommendationReason: buildReason(question, bestMistake && (bestMistake.kpName || bestMistake.kpCode)),
      scoreBreakdown: {
        similarity: Number(bestSimilarity.toFixed(4)),
        kpWeight: Number(kpWeight.toFixed(4)),
        urgency: Number(urgency.toFixed(4))
      }
    });
  });

  const deduped = [];
  const seen = new Set();
  scored
    .sort((a, b) => b.score - a.score)
    .forEach((item) => {
      const key = item.id;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(item);
      }
    });

  const result = deduped.slice(0, limit);
  recommendationCache.set(cacheKey, result);
  return result;
}

module.exports = {
  getSmartRecommendations,
  recommendationCache,
  jaccard,
  getForgettingUrgency
};
