const db = require('../database/memory-db');

function getStatus(mastery) {
  if (mastery >= 80) return '已掌握';
  if (mastery >= 60) return '学习中';
  return '待强化';
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function getKnowledgeAttempts(userId, kpCode) {
  return db.find('student_answer')
    .filter((item) => item.userId === userId && item.kpCode === kpCode)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function updateMastery(userId, kpCode) {
  const attempts = getKnowledgeAttempts(userId, kpCode);
  const latest10 = attempts.slice(-10);
  const correctRate = latest10.length
    ? latest10.filter((item) => item.isCorrect).length / latest10.length
    : 0;
  let mastery = Math.round(correctRate * 100);

  const last3 = attempts.slice(-3);
  const last2 = attempts.slice(-2);
  const historicalTime = average(attempts.slice(0, -3).map((item) => Number(item.costTime || 0)).filter(Boolean));
  const last3Time = average(last3.map((item) => Number(item.costTime || 0)).filter(Boolean));

  if (last3.length === 3 && last3.every((item) => item.isCorrect) && (!historicalTime || last3Time <= historicalTime * 1.2)) {
    mastery = Math.min(100, mastery + 10);
  }

  if (last2.length === 2 && last2.every((item) => !item.isCorrect)) {
    mastery = Math.max(0, mastery - 10);
  }

  const existing = db.findOne('student_knowledge_mastery', { userId, kpCode });
  const payload = {
    userId,
    kpCode,
    mastery,
    status: getStatus(mastery),
    correctRate: Number(correctRate.toFixed(2)),
    attemptCount: attempts.length,
    updatedAt: new Date().toISOString()
  };

  if (existing) {
    return db.updateById('student_knowledge_mastery', existing.id, payload);
  }

  return db.create('student_knowledge_mastery', payload);
}

function getTrend(userId, kpCode, days) {
  const since = Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000;
  return db.find('mastery_snapshot')
    .filter((item) => item.userId === userId && item.kpCode === kpCode && new Date(item.snapshotAt).getTime() >= since)
    .sort((a, b) => new Date(a.snapshotAt) - new Date(b.snapshotAt));
}

module.exports = {
  getStatus,
  updateMastery,
  getTrend
};
