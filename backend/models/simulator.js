const fs = require('fs');
const path = require('path');
const knowledgeTree = require('../../shared/knowledge-tree.json');

/**
 * 模拟用户生成器（虚拟学生答题行为仿真）
 *
 * 用途与边界：
 *   ✅ 填充网站演示数据、验证推荐/学情闭环、压力测试评估管道
 *   ❌ 严禁把模拟数据的评估结果当作真实学习效果写进报告或论文
 *
 * 行为模型（贴近教育测量常识）：
 *   - 学生总体能力 θ ~ N(0.55, 0.15)，截断到 [0.15, 0.95]
 *   - 每个知识点有个人偏好偏移（±0.12）
 *   - 练习效应：答对后掌握度上升（学习增益随能力递减），答错小幅下降
 *   - 遗忘效应：两次作答间隔 d 天，掌握度乘 exp(-0.02d)
 *   - 猜测：不会时仍有 guessRate 概率蒙对；失误：会做时 slipRate 概率粗心错
 *   - 用时：与正确性和能力相关（对题更快），对数正态扰动
 */

function flattenKpCodes() {
  const codes = [];
  for (const cat of knowledgeTree.categories || []) {
    for (const node of cat.nodes || []) codes.push(node.id);
  }
  return codes;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  // Box-Muller
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function generateSimulatedRecords({
  students = 30,
  kpCodes = null,
  kpCount = 8,
  seed = 42,
  startDate = '2026-08-01',
  days = 80,
  sessionsPerPair = [3, 8],      // 每个(学生,知识点)的练习场次范围
  questionsPerSession = [1, 3],  // 每场次题数
  guessRate = 0.15,
  slipRate = 0.08,
  learnGain = 0.045,
  forgetRate = 0.02
} = {}) {
  const rand = mulberry32(seed);
  const codes = kpCodes && kpCodes.length ? kpCodes : flattenKpCodes().slice(0, kpCount);
  if (!codes.length) throw new Error('knowledge-tree.json 中没有可用知识点');
  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const records = [];

  for (let s = 0; s < students; s++) {
    const userId = `stu-sim-${String(s + 1).padStart(3, '0')}`;
    const ability = clamp(0.55 + gaussian(rand) * 0.15, 0.15, 0.95);
    const diligence = rand(); // 影响练习场次多少

    for (const kpCode of codes) {
      if (rand() > 0.35 + diligence * 0.6) continue; // 不是每个学生都练所有知识点
      const affinity = gaussian(rand) * 0.12;
      let mastery = clamp(ability + affinity - 0.15, 0.08, 0.9); // 初学时低于能力
      const sessions = Math.round(sessionsPerPair[0] + rand() * (sessionsPerPair[1] - sessionsPerPair[0]));
      let t = rand() * 14; // 首次练习在窗口前两周内

      for (let session = 0; session < sessions; session++) {
        const gap = 1 + rand() * 9; // 场次间隔 1~10 天
        t += gap;
        if (t > days) break;
        // 遗忘：掌握度随间隔衰减，下限 0.1
        mastery = Math.max(0.1, mastery * Math.exp(-forgetRate * gap));

        const qCount = Math.round(questionsPerSession[0] + rand() * (questionsPerSession[1] - questionsPerSession[0]));
        for (let q = 0; q < qCount; q++) {
          const knows = rand() < mastery;
          const isCorrect = knows ? rand() >= slipRate : rand() < guessRate;
          const baseTime = knows ? 45 : 95;
          const costTime = Math.round(
            clamp(baseTime * (1.4 - ability * 0.6) * Math.exp(gaussian(rand) * 0.3), 15, 400)
          );
          records.push({
            userId,
            kpCode,
            questionId: `${kpCode}-sim-${session}-${q}`,
            isCorrect,
            costTime,
            createdAt: new Date(startMs + t * 24 * 3600 * 1000 + q * 5 * 60 * 1000).toISOString()
          });
          // 学习效应：答对增益随掌握度接近 1 而递减，答错小幅回退
          mastery = clamp(
            mastery + (isCorrect ? learnGain * (1 - mastery) : -0.015),
            0.1, 0.95
          );
        }
      }
    }
  }
  return records;
}

function recordsToCsv(records) {
  const header = 'userId,kpCode,questionId,isCorrect,costTime,createdAt';
  const lines = records.map((r) =>
    [r.userId, r.kpCode, r.questionId, r.isCorrect ? '1' : '0', r.costTime, r.createdAt].join(',')
  );
  return [header, ...lines].join('\n');
}

/**
 * 注入内存数据库（SQLite 落盘，服务重启不丢）。
 * 同时创建 users/students 档案，教师端可见。
 * 注意：必须在服务进程或共享同一 questions.sqlite 的进程中调用。
 */
function injectSimulatedRecords(records, { usernamePrefix = 'sim' } = {}) {
  const db = require('../database/memory-db');
  const userIds = [...new Set(records.map((r) => r.userId))];
  for (const userId of userIds) {
    if (!db.findById('users', userId)) {
      db.data.users.push({
        id: userId,
        username: `${usernamePrefix}-${userId}`,
        password: '$2a$10$VhK8fA7R1QmV6b5lS3nHxuWgOvk6QH6Z8m0lZ0lJ2lNQk0K4x3y4m',
        role: 'student',
        name: `模拟学生 ${userId.slice(-3)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      db.data.students.push({
        id: userId,
        userId,
        name: `模拟学生 ${userId.slice(-3)}`,
        studentNo: userId,
        classId: db.data.classes[0] ? db.data.classes[0].id : null,
        createdAt: new Date().toISOString()
      });
    }
  }
  let count = 0;
  for (const record of records) {
    db.create('student_answer', {
      userId: record.userId,
      kpCode: record.kpCode,
      questionId: record.questionId,
      isCorrect: record.isCorrect,
      costTime: record.costTime,
      createdAt: record.createdAt,
      source: 'simulated'
    });
    count++;
  }
  return { users: userIds.length, records: count };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : fallback;
  };

  const records = generateSimulatedRecords({
    students: Number(opt('students', 30)),
    kpCount: Number(opt('kp', 8)),
    seed: Number(opt('seed', 42))
  });

  console.log(`生成模拟答题记录 ${records.length} 条（${new Set(records.map(r => r.userId)).size} 名虚拟学生）`);

  const outDir = path.join(__dirname, '..', '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const csvFile = path.join(outDir, 'simulated-records.csv');
  fs.writeFileSync(csvFile, recordsToCsv(records));
  console.log(`CSV 已写入 ${csvFile}`);

  if (args.includes('--inject')) {
    console.warn('⚠️ 正在向数据库注入模拟数据（source=simulated 标记，可识别、可清理）');
    const result = injectSimulatedRecords(records);
    console.log(`已注入：${result.users} 名虚拟学生，${result.records} 条答题记录`);
  } else {
    console.log('提示：加 --inject 可将数据写入网站数据库（教师端可见，source=simulated）');
  }

  console.log('再次提醒：模拟数据仅用于演示与管道验证，评估结果不可作为真实学习效果。');
}

if (require.main === module) main();

module.exports = {
  generateSimulatedRecords,
  recordsToCsv,
  injectSimulatedRecords,
  flattenKpCodes
};
