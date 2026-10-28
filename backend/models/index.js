const db = require('../database/memory-db');

function initializeSmartLearningModels() {
  const questions = db.find('questions');
  questions.forEach((question) => {
    const kpCode = question.kpCode || question.knowledgePointId || (Array.isArray(question.knowledgePoints) ? question.knowledgePoints[0] : '');
    if (!kpCode) return;
    db.updateById('questions', question.id, {
      kpCode,
      answer_text: question.answer_text || question.answerText || (question.type === 'shortAnswer' ? String(question.answer || '') : ''),
      explanation: question.explanation || question.analysis || '',
      type: question.type === 'shortAnswer' ? 'subjective' : (question.type || 'objective')
    });
  });
}

module.exports = {
  initializeSmartLearningModels
};
