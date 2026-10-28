const db = require('../database/memory-db');

function runDailySnapshot() {
  const now = new Date().toISOString();
  const records = db.find('student_knowledge_mastery');
  records.forEach((item) => {
    db.create('mastery_snapshot', {
      userId: item.userId,
      kpCode: item.kpCode,
      mastery: item.mastery,
      status: item.status,
      snapshotAt: now
    });
  });
}

function startDailySnapshotJob() {
  const interval = 24 * 60 * 60 * 1000;
  setInterval(runDailySnapshot, interval);
}

module.exports = {
  runDailySnapshot,
  startDailySnapshotJob
};
