const memoryCache = require('memory-cache');
const db = require('../database/memory-db');

function normalizeDifficulty(value) {
  if (typeof value === 'number') {
    return Math.max(1, Math.min(5, value));
  }

  const text = String(value || '').toLowerCase();
  if (text === 'easy') return 2;
  if (text === 'medium') return 3;
  if (text === 'hard') return 4;
  const parsed = parseInt(text, 10);
  return Number.isNaN(parsed) ? 3 : Math.max(1, Math.min(5, parsed));
}

function getQuestionBase(questionId) {
  const key = 'question-base:' + questionId;
  const cached = memoryCache.get(key);
  if (cached) return cached;

  const question = db.findById('questions', questionId);
  if (!question) return null;

  const payload = {
    id: question.id,
    kpCode: question.kpCode || question.knowledgePointId || (Array.isArray(question.knowledgePoints) ? question.knowledgePoints[0] : ''),
    difficulty: normalizeDifficulty(question.difficulty),
    type: question.type === 'subjective' || question.type === 'shortAnswer' ? '主观题' : '客观题',
    answer: question.answer || '',
    answer_text: question.answer_text || question.answerText || '',
    explanation: question.explanation || question.analysis || ''
  };

  memoryCache.put(key, payload, 60 * 60 * 1000);
  return payload;
}

module.exports = {
  normalizeDifficulty,
  getQuestionBase
};
