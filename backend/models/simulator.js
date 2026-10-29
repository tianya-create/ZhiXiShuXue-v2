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

// 四类学生原型（方案 §模拟用户数据）：高水平 / 普通 / 薄弱 / 突击型
// 突击型：起点低、短间隔高强度集中练、提升快但遗忘也快（考前突击画像）
const ARCHETYPES = {
  high: {
    label: '高水平', weight: 0.2,
    ability: [0.8, 0.06], learnGain: 0.04, forgetRate: 0.015,
    guessRate: 0.08, slipRate: 0.05,
    sessionsPerPair: [3, 7], questionsPerSession: [1, 3], gapDays: [1, 8]
  },
  average: {
    label: '普通', weight: 0.4,
    ability: [0.55, 0.08], learnGain: 0.045, forgetRate: 0.02,
    guessRate: 0.15, slipRate: 0.08,
    sessionsPerPair: [3, 8], questionsPerSession: [1, 3], gapDays: [1, 10]
  },
  weak: {
    label: '薄弱', weight: 0.25,
    ability: [0.3, 0.07], learnGain: 0.05, forgetRate: 0.025,
    guessRate: 0.2, slipRate: 0.1,
    sessionsPerPair: [5, 10], questionsPerSession: [2, 4], gapDays: [1, 6]
  },
  crammer: {
    label: '突击型', weight: 0.15,
    ability: [0.35, 0.08], learnGain: 0.09, forgetRate: 0.06,
    guessRate: 0.18, slipRate: 0.1,
    sessionsPerPair: [6, 12], questionsPerSession: [2, 5], gapDays: [0.2, 2]
  }
};

function pickArchetype(rand) {
  const roll = rand();
  let acc = 0;
  for (const cfg of Object.values(ARCHETYPES)) {
    acc += cfg.weight;
    if (roll < acc) return cfg;
  }
  return ARCHETYPES.average;
}

function generateSimulatedRecords({
  students = 30,
  kpCodes = null,
  kpCount = 8,
  seed = 42,
  startDate = '2026-08-01',
  days = 80
} = {}) {
  const rand = mulberry32(seed);
  const codes = kpCodes && kpCodes.length ? kpCodes : flattenKpCodes().slice(0, kpCount);
  if (!codes.length) throw new Error('knowledge-tree.json 中没有可用知识点');
  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const records = [];
  const archetypes = {};

  for (let s = 0; s < students; s++) {
    const userId = `stu-sim-${String(s + 1).padStart(3, '0')}`;
    const type = pickArchetype(rand);
    archetypes[userId] = type.label;
    const ability = clamp(type.ability[0] + gaussian(rand) * type.ability[1], 0.1, 0.95);
    const diligence = rand(); // 影响练习场次多少

    for (const kpCode of codes) {
      if (rand() > 0.35 + diligence * 0.6) continue; // 不是每个学生都练所有知识点
      const affinity = gaussian(rand) * 0.12;
      let mastery = clamp(ability + affinity - 0.15, 0.08, 0.9); // 初学时低于能力
      const sessions = Math.round(type.sessionsPerPair[0] + rand() * (type.sessionsPerPair[1] - type.sessionsPerPair[0]));
      let t = type.gapDays[0] < 1 ? rand() * 5 : rand() * 14; // 突击型开局更集中

      for (let session = 0; session < sessions; session++) {
        const gap = type.gapDays[0] + rand() * (type.gapDays[1] - type.gapDays[0]);
        t += gap;
        if (t > days) break;
        // 遗忘：掌握度随间隔衰减，下限 0.1
        mastery = Math.max(0.1, mastery * Math.exp(-type.forgetRate * gap));

        const qCount = Math.round(type.questionsPerSession[0] + rand() * (type.questionsPerSession[1] - type.questionsPerSession[0]));
        for (let q = 0; q < qCount; q++) {
          const knows = rand() < mastery;
          const isCorrect = knows ? rand() >= type.slipRate : rand() < type.guessRate;
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
            mastery + (isCorrect ? type.learnGain * (1 - mastery) : -0.015),
            0.1, 0.95
          );
        }
      }
    }
  }
  records.archetypes = archetypes;
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
 * 同时创建 users/students 档案（含四类原型标签），教师端可见。
 * 注意：必须在服务进程或共享同一 questions.sqlite 的进程中调用。
 */
function injectSimulatedRecords(records, { usernamePrefix = 'sim' } = {}) {
  const db = require('../database/memory-db');
  const archetypes = records.archetypes || {};
  const userIds = [...new Set(records.map((r) => r.userId))];
  for (const userId of userIds) {
    if (!db.findById('users', userId)) {
      const typeLabel = archetypes[userId] ? `${archetypes[userId]}` : '模拟';
      db.data.users.push({
        id: userId,
        username: `${usernamePrefix}-${userId}`,
        password: '$2a$10$VhK8fA7R1QmV6b5lS3nHxuWgOvk6QH6Z8m0lZ0lJ2lNQk0K4x3y4m',
        role: 'student',
        name: `模拟-${typeLabel}-${userId.slice(-3)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      db.data.students.push({
        id: userId,
        userId,
        name: `模拟-${typeLabel}-${userId.slice(-3)}`,
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
  const typeCount = {};
  for (const label of Object.values(records.archetypes || {})) {
    typeCount[label] = (typeCount[label] || 0) + 1;
  }
  console.log('学生原型分布:', JSON.stringify(typeCount));

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
  ARCHETYPES,
  generateSimulatedRecords,
  recordsToCsv,
  injectSimulatedRecords,
  flattenKpCodes
};
