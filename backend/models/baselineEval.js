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
// 兼容方案字段：answerDuration / answer_duration 视为 costTime，attemptIndex 透传
function loadFromDb() {
  const db = require('../database/memory-db');
  return db.find('student_answer').map((item) => ({
    userId: item.userId,
    kpCode: item.kpCode,
    questionId: item.questionId,
    isCorrect: !!item.isCorrect,
    costTime: Number(item.costTime ?? item.answerDuration ?? item.answer_duration ?? 0),
    attemptIndex: item.attemptIndex ?? null,
    createdAt: item.createdAt
  }));
}

// CSV：userId,kpCode,questionId,isCorrect,costTime,createdAt
// 兼容列名：answerDuration / answer_duration 等价 costTime；attemptIndex 可选
function loadFromCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = (...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const durationCell = idx('costTime', 'answerDuration', 'answer_duration');
    const attemptCell = idx('attemptIndex', 'attempt_index');
    return {
      userId: cells[idx('userId')].trim(),
      kpCode: cells[idx('kpCode')].trim(),
      questionId: cells[idx('questionId')].trim(),
      isCorrect: cells[idx('isCorrect')].trim() === '1' || cells[idx('isCorrect')].trim().toLowerCase() === 'true',
      costTime: Number(durationCell >= 0 ? cells[durationCell] : 0),
      attemptIndex: attemptCell >= 0 ? Number(cells[attemptCell]) : null,
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

// ---------- 统计严谨性：学生级 bootstrap 置信区间 + 配对显著性检验 ----------
// 依据《知识追踪项目推荐实验方案》：同一学生的答题记录彼此相关，
// 以「学生」为单位有放回重采样，保留其全部记录，重复约 1000 次，取 2.5%/97.5% 分位数。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

// 按学生分组（学生级重采样单位）
function groupRowsByStudent(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.userId)) groups.set(row.userId, []);
    groups.get(row.userId).push(row);
  }
  return [...groups.values()];
}

// rows 来自 walkForward 输出；学生级 bootstrap，返回各指标 95% 置信区间
function bootstrapCIs(rows, { reps = 1000, seed = 42 } = {}) {
  const groups = groupRowsByStudent(rows);
  const rand = mulberry32(seed);
  const samples = { AUC: [], LogLoss: [], Accuracy: [], Brier: [] };
  for (let r = 0; r < reps; r++) {
    const picked = [];
    for (let g = 0; g < groups.length; g++) {
      const student = groups[Math.floor(rand() * groups.length)];
      picked.push(...student);
    }
    const m = evaluateMetrics(picked);
    if (m.AUC !== null) samples.AUC.push(m.AUC);
    samples.LogLoss.push(m.LogLoss);
    samples.Accuracy.push(m.Accuracy);
    samples.Brier.push(m.Brier);
  }
  const ci = {};
  for (const [name, arr] of Object.entries(samples)) {
    arr.sort((a, b) => a - b);
    ci[name] = [Number(percentile(arr, 0.025).toFixed(4)), Number(percentile(arr, 0.975).toFixed(4))];
  }
  return ci;
}

// 配对比较：两模型 walk-forward 输出按 (userId,kpCode,createdAt) 对齐（target 相同）
// 统计方法：学生级聚类 bootstrap 下计算「池化」指标差（相同学生、相同测试样本的配对比较）。
// 注意：不能用学生内逐行 AUC 的均值——短序列上增长窗口预测器存在机械性负偏差
// （pred(t) 的历史窗口包含 target(t-1)，会制造虚假反相关），池化 AUC 才是 KT 标准指标。
function pairedComparison(rowsA, rowsB, { reps = 1000, seed = 42 } = {}) {
  const keyOf = (row) => `${row.userId}|${row.kpCode}|${row.createdAt}`;
  const mapB = new Map(rowsB.map((row) => [keyOf(row), row]));
  const paired = [];
  for (const a of rowsA) {
    const b = mapB.get(keyOf(a));
    if (b && b.target === a.target) paired.push({ key: keyOf(a), a, b });
  }

  // 学生级聚类
  const groups = new Map();
  for (const item of paired) {
    const gk = item.key.split('|')[0];
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(item);
  }
  const groupList = [...groups.values()];

  function pooledMetrics(items) {
    const auc = rocAUC(items.map((x) => ({ pred: x.a.pred, target: x.a.target })));
    const eps = params.logLossEps;
    let llA = 0, llB = 0;
    for (const x of items) {
      const pa = Math.min(1 - eps, Math.max(eps, x.a.pred));
      const pb = Math.min(1 - eps, Math.max(eps, x.b.pred));
      llA += -(x.a.target * Math.log(pa) + (1 - x.a.target) * Math.log(1 - pa));
      llB += -(x.b.target * Math.log(pb) + (1 - x.b.target) * Math.log(1 - pb));
    }
    return {
      dAUC: auc === null ? null : auc - rocAUC(items.map((x) => ({ pred: x.b.pred, target: x.b.target }))),
      dLogLoss: (llA - llB) / items.length
    };
  }

  const observed = pooledMetrics(paired);
  const rand = mulberry32(seed);
  const n = groupList.length;

  function bootStats(observedDiff, pickDiff) {
    const diffs = [];
    for (let r = 0; r < reps; r++) {
      const picked = [];
      for (let g = 0; g < n; g++) picked.push(...groupList[Math.floor(rand() * n)]);
      const m = pickDiff(picked);
      if (m !== null) diffs.push(m);
    }
    diffs.sort((a, b) => a - b);
    const pAbove = diffs.filter((d) => d <= 0).length / diffs.length;
    return {
      meanDiff: Number(observedDiff.toFixed(4)),
      ci: [Number(percentile(diffs, 0.025).toFixed(4)), Number(percentile(diffs, 0.975).toFixed(4))],
      // bootstrap 双侧 p 值：分布越过 0 的比例的两倍（加一平滑避免 0/1）
      p: Number(Math.min(1, 2 * Math.min((pAbove * diffs.length + 1) / (diffs.length + 1),
        ((1 - pAbove) * diffs.length + 1) / (diffs.length + 1))).toFixed(4)),
      units: n
    };
  }

  return {
    pairedRows: paired.length,
    dAUC: observed.dAUC === null
      ? { meanDiff: null, ci: [null, null], p: null, units: n }
      : bootStats(observed.dAUC, (items) => pooledMetrics(items).dAUC),
    dLogLoss: bootStats(observed.dLogLoss, (items) => pooledMetrics(items).dLogLoss)
  };
}

function formatComparisonTable(comparisons) {
  const header = ['对比 (A vs B)', 'ΔAUC均值', 'ΔAUC 95%CI', 'p(AUC)', 'ΔLogLoss均值', 'ΔLogLoss 95%CI', 'p(LogLoss)'];
  const rows = comparisons.map((c) => [
    `${c.a} - ${c.b}`,
    c.res.dAUC.meanDiff,
    `[${c.res.dAUC.ci[0]}, ${c.res.dAUC.ci[1]}]`,
    c.res.dAUC.p,
    c.res.dLogLoss.meanDiff,
    `[${c.res.dLogLoss.ci[0]}, ${c.res.dLogLoss.ci[1]}]`,
    c.res.dLogLoss.p
  ]);
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// 数据集元信息（方案要求随结果一并报告）
function datasetStats(records) {
  const times = records.map((r) => new Date(r.createdAt).getTime()).filter(Number.isFinite);
  return {
    recordCount: records.length,
    studentCount: new Set(records.map((r) => r.userId)).size,
    questionCount: new Set(records.map((r) => r.questionId)).size,
    knowledgePointCount: new Set(records.map((r) => r.kpCode)).size,
    timeRange: times.length
      ? [new Date(Math.min(...times)).toISOString(), new Date(Math.max(...times)).toISOString()]
      : []
  };
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
  const stats = datasetStats(records);
  console.log(`数据概况: 学生 ${stats.studentCount}，题目 ${stats.questionCount}，知识点 ${stats.knowledgePointCount}，时间范围 ${stats.timeRange.join(' ~ ') || '无'}`);
  const results = runEvaluation(records);
  const table = formatTable(results);
  console.log('\n== 时间顺序评估结果（预测第 t 次只用前 t-1 次记录）==');
  console.log(table);

  // bootstrap 置信区间 + 配对显著性检验
  const bootIdx = args.indexOf('--bootstrap');
  const reps = bootIdx >= 0 ? Number(args[bootIdx + 1] || 1000) : 1000;
  const models = Object.keys(results);
  const walkRows = {};
  for (const model of models) walkRows[model] = walkForward(records, model);

  console.log(`\n== 95% 置信区间（学生级 bootstrap × ${reps}）==`);
  const ciTable = models.map((model) => {
    const ci = bootstrapCIs(walkRows[model], { reps });
    const m = results[model];
    return [model,
      `${m.AUC === null ? '-' : m.AUC} [${ci.AUC[0]}, ${ci.AUC[1]}]`,
      `${m.LogLoss} [${ci.LogLoss[0]}, ${ci.LogLoss[1]}]`];
  });
  console.log(['模型', 'AUC [CI]', 'LogLoss [CI]'].map((h, i) => String(h).padEnd(Math.max(h.length, ...ciTable.map((r) => r[i].length)))).join(' | '));
  ciTable.forEach((r) => console.log(r.join(' | ')));

  console.log(`\n== 配对显著性检验（学生级聚类 bootstrap，池化指标差, Δ = 行A - 行B）==`);
  const pairs = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      pairs.push({ a: models[i], b: models[j], res: pairedComparison(walkRows[models[i]], walkRows[models[j]], { reps }) });
    }
  }
  console.log(formatComparisonTable(pairs));
  console.log('\n判读：ΔAUC 的 CI 不含 0 且 p < 0.05 → 差异显著；AUC 越大越好，LogLoss 越小越好。');

  const outDir = path.join(__dirname, '..', '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `baseline-results-${source}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    source,
    dataset: stats,
    evalProtocol: {
      task: '预测学生下一次答题结果（时间顺序 walk-forward，无未来信息泄漏）',
      bootstrap: '学生级聚类 bootstrap，重采样单位为学生，保留其全部记录',
      pairedComparison: '相同学生、相同测试样本的配对比较，池化指标差 + 学生级 bootstrap 置信区间与双侧 p 值',
      bootstrapReps: reps,
      seed: 42
    },
    params,
    results
  }, null, 2));
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
  bootstrapCIs,
  pairedComparison,
  formatComparisonTable,
  datasetStats,
  generateSyntheticRecords,
  loadFromDb,
  loadFromCsv
};
