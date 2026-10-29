const fs = require('fs');
const path = require('path');
const params = require('./baselineParams.json');
const { sortByTime, predictNextCorrect } = require('./ruleMastery');

/**
 * 规则基线时间顺序评估（walk-forward，无数据泄漏）
 *
 * 对每个 (学生, 知识点) 组合，按时间升序遍历答题记录：
 *   预测第 t 次时，只允许使用第 1 ~ t-1 次记录。
 * 对比模型：Majority / Rule-0 / Rule-1 / Rule-2
 * 指标：AUC、LogLoss、Brier、Accuracy、F1
 */

// ---------- 指标（零依赖实现） ----------

function rocAUC(pairs) {
  const pos = pairs.filter((x) => x.target === 1).length;
  const neg = pairs.length - pos;
  if (!pos || !neg) return null; // 样本只有一类时 AUC 无定义
  const sorted = [...pairs].sort((a, b) => a.pred - b.pred);
  let rankSumPos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].pred === sorted[i].pred) j++;
    const avgRank = (i + 1 + j) / 2; // 并列取平均秩（1-based）
    for (let k = i; k < j; k++) if (sorted[k].target === 1) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - pos * (pos + 1) / 2) / (pos * neg);
}

function evaluateMetrics(rows) {
  const eps = params.logLossEps;
  const n = rows.length;
  if (!n) return { n: 0 };

  let logLoss = 0;
  let brier = 0;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of rows) {
    const p = Math.min(1 - eps, Math.max(eps, row.pred));
    logLoss += -(row.target * Math.log(p) + (1 - row.target) * Math.log(1 - p));
    brier += (row.pred - row.target) ** 2;
    const hit = row.pred >= params.decisionThreshold;
    if (row.target === 1) hit ? tp++ : fn++;
    else hit ? fp++ : tn++;
  }

  const auc = rocAUC(rows.map(({ pred, target }) => ({ pred, target })));
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    n,
    AUC: auc === null ? null : Number(auc.toFixed(4)),
    LogLoss: Number((logLoss / n).toFixed(4)),
    Brier: Number((brier / n).toFixed(4)),
    Accuracy: Number(((tp + tn) / n).toFixed(4)),
    F1: precision + recall ? Number((2 * precision * recall / (precision + recall)).toFixed(4)) : 0,
    positiveRate: Number((rows.filter((r) => r.target === 1).length / n).toFixed(4))
  };
}

// ---------- 数据准备 ----------

// 按时间全局排序后按 (userId, kpCode) 分组，组内升序
function groupByStudentKp(records) {
  const groups = new Map();
  for (const item of sortByTime(records)) {
    const key = `${item.userId}|${item.kpCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

// walk-forward 生成预测样本；majority 使用「全局时间前缀」的正例占比（避免泄漏）
function walkForward(records, model, options = {}) {
  const groups = groupByStudentKp(records);
  const rows = [];
  // 全局时间线：用于 Majority 基线的累积正例率
  const globalSorted = sortByTime(records);
  let seen = 0;
  let seenCorrect = 0;

  const globalIndex = new Map();
  globalSorted.forEach((item, idx) => globalIndex.set(item, idx));

  for (const group of groups) {
    for (let t = 1; t < group.length; t++) {
      const history = group.slice(0, t);
      const target = group[t].isCorrect ? 1 : 0;
      const currentTime = new Date(group[t].createdAt).getTime();
      // 推进全局时间线到目标时刻之前
      while (seen < globalSorted.length &&
             new Date(globalSorted[seen].createdAt).getTime() < currentTime) {
        if (globalIndex.get(group[t]) !== seen) {
          seenCorrect += globalSorted[seen].isCorrect ? 1 : 0;
          seen++;
        } else break;
      }
      let pred;
      if (model === 'Majority') {
        // 拉普拉斯平滑的全局累积正例率，避免早期 0/1 极端概率；无历史时为 0.5
        pred = (seenCorrect + 1) / (seen + 2);
      } else {
        // 预测时刻 = 目标答题时刻：时间衰减按「距上次练习的真实间隔」计算，
        // 而不是按今天的系统时间（否则历史数据衰减全部失真）
        pred = predictNextCorrect(model, history, { ...options, now: currentTime });
      }
      rows.push({
        userId: group[t].userId,
        kpCode: group[t].kpCode,
        createdAt: group[t].createdAt,
        pred: Number(pred.toFixed(6)),
        target
      });
    }
  }
  return rows;
}

// ---------- 数据源 ----------

// 合成数据：验证评估管道用，严禁当作真实学习效果写进报告
function generateSyntheticRecords({ students = 40, kps = 6, avgPerPair = 12 } = {}) {
  const records = [];
  let day = 0;
  for (let s = 0; s < students; s++) {
    const ability = 0.25 + Math.random() * 0.5; // 学生基础能力
    for (let k = 0; k < kps; k++) {
      const kpCode = `KP${String(k + 1).padStart(2, '0')}`;
      const kpDifficulty = Math.random() * 0.4 - 0.2;
      let mastery = ability - kpDifficulty; // 模拟「越练越会」
      const count = Math.max(4, Math.round(avgPerPair * (0.6 + Math.random() * 0.8)));
      let t = Math.random() * 5;
      for (let i = 0; i < count; i++) {
        t += Math.random() * 6; // 间隔 0~6 天
        const isCorrect = Math.random() < mastery;
        records.push({
          userId: `stu-${String(s + 1).padStart(3, '0')}`,
          kpCode,
          questionId: `q-${s}-${k}-${i}`,
          isCorrect,
          costTime: Math.round(30 + Math.random() * 120),
          createdAt: new Date(Date.UTC(2026, 0, 1) + t * 24 * 3600 * 1000).toISOString()
        });
        mastery = Math.min(0.95, mastery + (isCorrect ? 0.02 : -0.01) + Math.random() * 0.01);
      }
    }
  }
  return records;
}

// 从内存数据库读取（需先 seedDemoData 或有真实运行数据）
function loadFromDb() {
  const db = require('../database/memory-db');
  return db.find('student_answer').map((item) => ({
    userId: item.userId,
    kpCode: item.kpCode,
    questionId: item.questionId,
    isCorrect: !!item.isCorrect,
    costTime: Number(item.costTime || 0),
    createdAt: item.createdAt
  }));
}

// CSV：userId,kpCode,questionId,isCorrect,costTime,createdAt
function loadFromCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = (name) => header.indexOf(name);
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return {
      userId: cells[idx('userId')].trim(),
      kpCode: cells[idx('kpCode')].trim(),
      questionId: cells[idx('questionId')].trim(),
      isCorrect: cells[idx('isCorrect')].trim() === '1' || cells[idx('isCorrect')].trim().toLowerCase() === 'true',
      costTime: Number(cells[idx('costTime')] || 0),
      createdAt: cells[idx('createdAt')].trim()
    };
  });
}

// ---------- 主流程 ----------

function runEvaluation(records, { models = ['Majority', 'Rule-0', 'Rule-1', 'Rule-2'], options = {} } = {}) {
  const results = {};
  for (const model of models) {
    const rows = walkForward(records, model, options);
    results[model] = evaluateMetrics(rows);
  }
  return results;
}

function formatTable(results) {
  const header = ['模型', '样本数', 'AUC', 'LogLoss', 'Brier', 'Accuracy', 'F1'];
  const rows = Object.entries(results).map(([name, m]) => [
    name, m.n, m.AUC === null ? '-' : m.AUC, m.LogLoss, m.Brier, m.Accuracy, m.F1
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  const source = sourceIdx >= 0 ? args[sourceIdx + 1] : 'synthetic';

  let records;
  if (source === 'db') {
    records = loadFromDb();
  } else if (source === 'csv') {
    const fileIdx = args.indexOf('--file');
    records = loadFromCsv(args[fileIdx + 1]);
  } else {
    records = generateSyntheticRecords();
  }

  if (!records.length) {
    console.error('没有可用答题记录。db 源为空时可先运行 seed 或改用 --source synthetic / --source csv --file <路径>');
    process.exit(1);
  }

  console.log(`数据源: ${source}，答题记录 ${records.length} 条，(学生,知识点) 组合 ${groupByStudentKp(records).length} 组`);
  const results = runEvaluation(records);
  const table = formatTable(results);
  console.log('\n== 时间顺序评估结果（预测第 t 次只用前 t-1 次记录）==');
  console.log(table);

  const outDir = path.join(__dirname, '..', '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `baseline-results-${source}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ source, recordCount: records.length, params, results }, null, 2));
  console.log(`\n结果已写入 ${outFile}`);
  console.log('注意：synthetic 源仅用于验证评估管道，结果不可作为真实学习效果。');
}

if (require.main === module) main();

module.exports = {
  evaluateMetrics,
  rocAUC,
  groupByStudentKp,
  walkForward,
  runEvaluation,
  formatTable,
  generateSyntheticRecords,
  loadFromDb,
  loadFromCsv
};
