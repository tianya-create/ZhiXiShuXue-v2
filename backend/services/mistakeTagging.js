const { getQuestionBase } = require('./question-cache');

const ERROR_TYPES = ['计算', '概念', '审题', '其他'];

function normalizeErrorType(value, question, userAnswer) {
  const text = String(value || '').trim();
  if (ERROR_TYPES.includes(text)) return text;

  const content = String((question && question.content) || '').toLowerCase();
  const answer = String(userAnswer || '').trim();

  if (!answer) return '审题';
  if (/定义|概念|性质|说明|简述|为什么/.test(content)) return '概念';
  if (/计算|求值|解方程|化简|求解/.test(content)) return '计算';
  return '其他';
}

function buildMistakeTags(question, errorType) {
  const base = getQuestionBase(question.id) || {};
  return {
    kpCode: base.kpCode || question.kpCode || question.knowledgePointId || '',
    difficulty: base.difficulty || 3,
    errorType: normalizeErrorType(errorType, question)
  };
}

module.exports = {
  ERROR_TYPES,
  normalizeErrorType,
  buildMistakeTags
};
