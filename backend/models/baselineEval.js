const fs = require('fs');
const path = require('path');
const params = require('./baselineParams.json');
const { sortByTime, predictNextCorrect } = require('./ruleMastery');

/**
 * 规则基线时间顺序评估（walk-forward，无数据泄漏）
 *
 * 对每个 (学生, 知识点) 组合，按时间升序遍历答题记录：
 *   预测第 t 次时，只允许使用第 1 ~ t-1 次记录。
 * 对比模型：Majority / Online-Rule（线上公式复现）/ Rule-0 / Rule-1 / Rule-2
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

// ---------- 分箱校准表（可靠性表）----------
// 按预测概率分 10 桶，比较桶内平均预测概率与实际正确率；
// 校准好的模型两者接近。用于解释「AUC 高但 LogLoss 差」的概率质量短板。
function calibrationBins(rows, binCount = 10) {
  const bins = Array.from({ length: binCount }, () => ({ n: 0, predSum: 0, correct: 0 }));
  for (const row of rows) {
    const b = Math.min(binCount - 1, Math.max(0, Math.floor(row.pred * binCount)));
    bins[b].n++;
    bins[b].predSum += row.pred;
    bins[b].correct += row.target;
  }
  return bins.map((bin, i) => ({
    range: `[${(i / binCount).toFixed(1)}, ${((i + 1) / binCount).toFixed(1)})`,
    n: bin.n,
    meanPredicted: bin.n ? Number((bin.predSum / bin.n).toFixed(4)) : null,
    observedRate: bin.n ? Number((bin.correct / bin.n).toFixed(4)) : null
  }));
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

// walk-forward 生成预测样本。
// Majority 使用「全局时间前缀」正例率：预先计算全局时间排序的前缀和，
// 预测时刻 T 用二分查找取 createdAt < T 的记录数与正确数。
// 这样与组处理顺序完全无关，避免单调指针在交错时间数据上的未来信息泄漏。
function walkForward(records, model, options = {}) {
  const groups = groupByStudentKp(records);
  const rows = [];

  // Majority 用的全局前缀和：prefixCount[i] = 前 i 条记录数，prefixCorrect[i] = 前 i 条正确数
  const globalSorted = sortByTime(records);
  const globalTimes = globalSorted.map((item) => new Date(item.createdAt).getTime());
  const prefixCount = [0];
  const prefixCorrect = [0];
  for (let i = 0; i < globalSorted.length; i++) {
    prefixCount.push(prefixCount[i] + 1);
    prefixCorrect.push(prefixCorrect[i] + (globalSorted[i].isCorrect ? 1 : 0));
  }
  // 第一个时间 >= T 的记录下标（即 createdAt < T 的记录条数）
  function countBefore(timeMs) {
    let lo = 0, hi = globalTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (globalTimes[mid] < timeMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  for (const group of groups) {
    // 同一时间戳视为同一答题批次：批次内记录互不为历史信息，历史只包含
    // 严格早于目标时刻的记录（与 Majority 的全局前缀规则一致）。
    // 首批次（无任何更早记录）整体跳过；之后每个记录都是预测目标——
    // 目标选取与批次内行顺序无关，输入行序变化不改变结果。
    const minTs = new Date(group[0].createdAt).getTime();
    let cutoff = 0;
    for (let t = 0; t < group.length; t++) {
      const currentTime = new Date(group[t].createdAt).getTime();
      if (currentTime === minTs) continue; // 首批次无历史
      while (cutoff < group.length &&
             new Date(group[cutoff].createdAt).getTime() < currentTime) cutoff++;
      const history = group.slice(0, cutoff);
      const target = group[t].isCorrect ? 1 : 0;
      let pred;
      if (model === 'Majority') {
        // 拉普拉斯平滑的全局累积正例率（严格早于目标时刻），无历史时为 0.5
        const cnt = countBefore(currentTime);
        pred = (prefixCorrect[cnt] + 1) / (prefixCount[cnt] + 2);
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
// 最小 CSV 行解析：支持双引号包裹与 "" 转义（不支持跨行字段）
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function loadFromCsv(filePath) {
  // 说明：引号内的换行不支持（公开数据集清洗产物不会出现），如需支持请改用流式解析
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map((s) => s.trim());
  const idx = (...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
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

function runEvaluation(records, { models = ['Majority', 'Online-Rule', 'Rule-0', 'Rule-1', 'Rule-2'], options = {} } = {}) {
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
// 大样本（十万条以上）下若每次重采样都重新排序算 AUC，2000 次 bootstrap 要一小时以上。
// 因此实现移到 bootstrapStats.js：预排序 + 预计算损失 + 权重前缀和，指标与 evaluateMetrics 等价。
const {
  bootstrapAllModels,
  bootstrapCIs,
  pairedComparison
} = require('./bootstrapStats');

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
  // 注意：不能用 Math.min(...times)，几十万条记录会触发参数个数上限（RangeError）
  let minT = Infinity;
  let maxT = -Infinity;
  const users = new Set();
  const questions = new Set();
  const kps = new Set();
  for (const r of records) {
    const t = new Date(r.createdAt).getTime();
    if (Number.isFinite(t)) {
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    users.add(r.userId);
    questions.add(r.questionId);
    kps.add(r.kpCode);
  }
  return {
    recordCount: records.length,
    studentCount: users.size,
    questionCount: questions.size,
    knowledgePointCount: kps.size,
    timeRange: minT === Infinity ? [] : [new Date(minT).toISOString(), new Date(maxT).toISOString()]
  };
}

function main() {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  const source = sourceIdx >= 0 ? args[sourceIdx + 1] : 'synthetic';

  let records;
  let csvFile = null;
  if (source === 'db') {
    records = loadFromDb();
  } else if (source === 'csv') {
    const fileIdx = args.indexOf('--file');
    csvFile = args[fileIdx + 1];
    records = loadFromCsv(csvFile);
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

  // bootstrap 置信区间 + 配对显著性检验（正式结果建议 ≥2000 次）
  const bootIdx = args.indexOf('--bootstrap');
  const reps = bootIdx >= 0 ? Number(args[bootIdx + 1] || 2000) : 2000;
  const models = Object.keys(results);
  const walkRows = {};
  for (const model of models) walkRows[model] = walkForward(records, model);

  // 同一批重采样权重同时用于所有模型：置信区间与两两配对检验天然配对，且只遍历一次数据
  const boot = bootstrapAllModels(walkRows, { reps });
  console.log(`\n== 95% 置信区间（学生级 bootstrap × ${reps}）==`);
  const ciTable = models.map((model) => {
    const ci = boot.ciByModel[model];
    const m = results[model];
    return [model,
      `${m.AUC === null ? '-' : m.AUC} [${ci.AUC[0]}, ${ci.AUC[1]}]`,
      `${m.LogLoss} [${ci.LogLoss[0]}, ${ci.LogLoss[1]}]`];
  });
  console.log(['模型', 'AUC [CI]', 'LogLoss [CI]'].map((h, i) => String(h).padEnd(Math.max(h.length, ...ciTable.map((r) => r[i].length)))).join(' | '));
  ciTable.forEach((r) => console.log(r.join(' | ')));

  console.log(`\n== 配对显著性检验（学生级聚类 bootstrap，池化指标差, Δ = 行A - 行B）==`);
  const pairs = boot.comparisons.map((c) => ({ a: c.a, b: c.b, res: { dAUC: c.dAUC, dLogLoss: c.dLogLoss } }));
  console.log(formatComparisonTable(pairs));
  console.log('\n判读：主要依据 Δ 及其 95% CI（CI 不含 0 → 方向稳定）；AUC 越大越好，LogLoss/Brier 越小越好。');
  console.log('注意：p 值为探索性指标（受 bootstrap 次数影响分辨率有限），不作为模型优越性的充分依据；');
  console.log('      Accuracy/F1 为固定阈值 0.5 下的分类表现，Majority 正例率 < 0.5 时 F1=0 属预期，解释力有限。');

  // P2-5：分箱校准表（可靠性表）——衡量概率预测质量（与排序能力 AUC 互补）
  console.log('\n== 分箱校准表（10 箱：桶内平均预测概率 vs 实际正确率）==');
  for (const model of models) {
    const bins = calibrationBins(walkRows[model]);
    console.log(`\n${model}:`);
    console.log(bins);
  }

  // P1-4：输出目录可配置（--out），默认脚本所在项目内的 实验结果文件/（不存在自动创建），
  // 不依赖任何外部或原作者本地路径
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(__dirname, '..', '实验结果文件');
  fs.mkdirSync(outDir, { recursive: true });
  // --label 用于区分不同数据集的结果文件（例如 assist2009），默认用数据源名
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 ? String(args[labelIdx + 1]).replace(/[^\w.-]/g, '') : source;
  const outFile = path.join(outDir, `baseline-results-${label}.json`);

  // 可复现性元信息：代码版本 + 输入文件指纹 + 运行时间
  let gitCommit = null;
  try {
    gitCommit = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..', '..') })
      .toString().trim();
  } catch (e) { /* 非 git 环境忽略 */ }
  let inputHash = null;
  if (source === 'csv' && csvFile) {
    const crypto = require('crypto');
    inputHash = 'sha256:' + crypto.createHash('sha256')
      .update(fs.readFileSync(path.resolve(csvFile))).digest('hex').slice(0, 16);
  }

  const calibration = {};
  for (const model of models) calibration[model] = calibrationBins(walkRows[model]);

  fs.writeFileSync(outFile, JSON.stringify({
    source,
    label,
    inputFile: source === 'csv' ? path.resolve(csvFile || '') : null,
    inputHash,
    gitCommit,
    generatedAt: new Date().toISOString(),
    dataset: stats,
    evalProtocol: {
      task: '预测学生下一次答题结果（时间顺序 walk-forward，无未来信息泄漏）',
      majority: '全局时间前缀正例率（前缀和+二分查找，严格早于预测时刻，与组处理顺序无关）',
      sameTimestampRule: '同一时间戳视为同一答题批次，批次内记录互不为历史信息；排序以 createdAt、attemptIndex、原始行序为稳定次序',
      bootstrap: '学生级聚类 bootstrap，重采样单位为学生，保留其全部记录',
      pairedComparison: '相同学生、相同测试样本的配对比较，池化指标差 + 学生级 bootstrap 置信区间与双侧 p 值',
      pValueInterpretation: '探索性指标：bootstrap 次数有限时分辨率低，不作为模型优越性的充分依据；主要结论应基于 Δ 及其 95% CI',
      metricInterpretation: 'AUC=排序能力；LogLoss=概率预测质量；Brier=概率校准与误差；Accuracy/F1=固定阈值0.5下的分类表现（Majority 正例率<0.5 时 F1=0 属预期）',
      bootstrapReps: boot.reps,
      bootstrapUnits: `${boot.students} 名学生（学生级聚类重采样）`,
      seed: 42
    },
    params,
    results,
    // 统计不确定性与模型间配对比较必须随结果文件一起保存，不能只打印在终端
    bootstrap: {
      method: '学生级聚类 bootstrap：以学生为重采样单位，保留其全部记录；同一批重采样权重同时用于所有模型（paired bootstrap）',
      reps: boot.reps,
      units: boot.students,
      ci: boot.ciByModel,
      comparisons: boot.comparisons.map((c) => ({
        a: c.a,
        b: c.b,
        dAUC: c.dAUC,
        dLogLoss: c.dLogLoss
      }))
    },
    calibration
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
  bootstrapAllModels,
  formatComparisonTable,
  calibrationBins,
  datasetStats,
  generateSyntheticRecords,
  loadFromDb,
  loadFromCsv,
  parseCsvLine
};
