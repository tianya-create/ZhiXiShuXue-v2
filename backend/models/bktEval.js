const fs = require('fs');
const path = require('path');
const {
  loadFromCsv,
  loadFromDb,
  generateSyntheticRecords,
  groupByStudentKp,
  walkForward,
  evaluateMetrics,
  formatTable,
  formatComparisonTable,
  calibrationBins,
  datasetStats,
  bootstrapAllModels
} = require('./baselineEval');
const {
  fitBktByKp,
  predictNextCorrect,
  buildEstimationData,
  splitSequence,
  DEFAULT_PARAMS,
  describeProtocol
} = require('./bkt');

/**
 * BKT 基线评估（与规则基线同一分组/批次/统计协议，但目标集为「评估段」）
 *
 * 无泄漏协议：每个 (学生, 知识点) 序列前 estFraction（默认 50%）为估计段，
 * EM 只用估计段拟合各知识点参数；评估段内逐条 walk-forward 预测。
 * Majority / Rule-0 用 --models 全集时会在完全相同的目标集上重新计算，
 * 保证「BKT vs 规则」的逐对比较公平（样本量与目标一致）。
 *
 * 用法（与 baselineEval.js 参数一致）：
 *   cd backend
 *   node models/bktEval.js --source csv \
 *     --file datasets/assist2009/interactions.csv \
 *     --bootstrap 2000 --label bkt-assist2009
 * 可选：--est-fraction 0.5（估计段比例）、--out、--models "BKT,Rule-0,Majority"
 */

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    source: get('source', 'synthetic'),
    file: get('file', null),
    bootstrap: Number(get('bootstrap', 2000)),
    label: get('label', null),
    out: get('out', null),
    estFraction: Math.min(0.9, Math.max(0.1, Number(get('est-fraction', 0.5)))),
    models: String(get('models', 'BKT,Rule-0,Majority')).split(',').map((s) => s.trim()).filter(Boolean)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let records;
  let csvFile = null;
  if (args.source === 'db') {
    records = loadFromDb();
  } else if (args.source === 'csv') {
    if (!args.file) { console.error('--source csv 需要 --file <路径>'); process.exit(1); }
    csvFile = args.file;
    records = loadFromCsv(csvFile);
  } else {
    records = generateSyntheticRecords();
  }
  if (!records.length) {
    console.error('没有可用答题记录。db 源为空时可先运行 seed 或改用 --source synthetic / csv');
    process.exit(1);
  }

  const groups = groupByStudentKp(records);
  const stats = datasetStats(records);
  console.log(`数据源: ${args.source}，答题记录 ${records.length} 条，(学生,知识点) 组合 ${groups.length} 组`);
  console.log(`数据概况: 学生 ${stats.studentCount}，题目 ${stats.questionCount}，知识点 ${stats.knowledgePointCount}`);

  // ---------- 估计段/评估段切分 + EM 拟合 ----------
  const { sequencesByKp, splitOf } = buildEstimationData(groups, args.estFraction);
  const t0 = Date.now();
  const { paramsByKp, fitInfo, defaultParamsUsed, totalObservations } = fitBktByKp(sequencesByKp);
  const fitSeconds = ((Date.now() - t0) / 1000).toFixed(1);

  const estTotal = splitOf.reduce((a, s) => a + s.estLen, 0);
  const evalTotal = splitOf.reduce((a, s) => a + s.evalLen, 0);
  const convergedCount = Object.values(fitInfo).filter((f) => f.converged).length;
  console.log(`\n== BKT 参数估计（EM，估计段 ${estTotal} 条 / 评估段 ${evalTotal} 条）==`);
  console.log(`知识点 ${Object.keys(fitInfo).length} 个：EM 收敛 ${convergedCount}，数据不足回退默认参数 ${defaultParamsUsed} 个，拟合耗时 ${fitSeconds}s`);
  console.log(`夹紧范围: P(G)/P(S) ∈ [0.05, 0.4]（防退化），P(L0)/P(T) ∈ [0.01, 0.99]`);
  // 打印几个样本知识点参数
  const sampleKps = [...Object.entries(fitInfo)].slice(0, 3);
  for (const [kp, info] of sampleKps) {
    console.log(`  ${kp}: P(L0)=${paramsByKp[kp].L0.toFixed(3)} P(T)=${paramsByKp[kp].T.toFixed(3)} P(G)=${paramsByKp[kp].G.toFixed(3)} P(S)=${paramsByKp[kp].S.toFixed(3)}（${info.observations} 条估计观测，${info.converged ? '已收敛' : '未收敛/回退'}）`);
  }

  // ---------- 同一目标集上的 walk-forward ----------
  // 目标 = 每组评估段的非首批次记录；estLen 由 buildEstimationData 记录，与 groups 一一对应
  const targetFilter = (groupIndex, t) => t >= splitOf[groupIndex].estLen;
  const bktPredict = (kpCode, historyBinary) =>
    predictNextCorrect(paramsByKp[kpCode] || DEFAULT_PARAMS, historyBinary);

  const models = args.models;
  const results = {};
  const walkRows = {};
  for (const model of models) {
    const options = model === 'BKT' ? { targetFilter, bktPredict } : { targetFilter };
    const rows = walkForward(records, model, options);
    walkRows[model] = rows;
    results[model] = evaluateMetrics(rows);
  }

  console.log(`\n== 评估段 walk-forward 结果（目标 ${walkRows[models[0]].length} 条，估计段不参与评估）==`);
  console.log(formatTable(results));

  // ---------- bootstrap（学生级聚类，同一批权重用于所有模型） ----------
  const boot = bootstrapAllModels(walkRows, { reps: args.bootstrap });
  console.log(`\n== 95% 置信区间（学生级 bootstrap × ${boot.reps}）==`);
  for (const model of models) {
    const ci = boot.ciByModel[model];
    const m = results[model];
    console.log(`${model}: AUC ${m.AUC === null ? '-' : m.AUC} [${ci.AUC[0]}, ${ci.AUC[1]}]，LogLoss ${m.LogLoss} [${ci.LogLoss[0]}, ${ci.LogLoss[1]}]`);
  }

  console.log('\n== 配对显著性检验（同一目标集，Δ = 行A - 行B）==');
  const pairs = boot.comparisons.map((c) => ({ a: c.a, b: c.b, res: { dAUC: c.dAUC, dLogLoss: c.dLogLoss } }));
  console.log(formatComparisonTable(pairs));
  console.log('判读：主要依据 Δ 及其 95% CI（CI 不含 0 → 方向稳定）；p 值为探索性指标。');

  console.log('\n== 分箱校准（10 箱，重点看低分区是否仍低估）==');
  for (const model of models) {
    const bins = calibrationBins(walkRows[model]).filter((b) => b.n > 0);
    console.log(`${model}:`);
    for (const b of bins) console.log(`  ${b.range}  n=${b.n}  预测 ${b.meanPredicted}  实际 ${b.observedRate}`);
  }

  // ---------- 结果 JSON（与 baselineEval 同构） ----------
  const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, '..', '实验结果文件');
  fs.mkdirSync(outDir, { recursive: true });
  const label = args.label ? String(args.label).replace(/[^\w.-]/g, '') : `bkt-${args.source}`;
  const outFile = path.join(outDir, `baseline-results-${label}.json`);

  let gitCommit = null;
  try {
    gitCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..', '..') }).toString().trim();
  } catch (e) { /* 非 git 环境忽略 */ }
  let inputHash = null;
  if (csvFile) {
    const crypto = require('crypto');
    inputHash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.resolve(csvFile))).digest('hex').slice(0, 16);
  }

  fs.writeFileSync(outFile, JSON.stringify({
    source: args.source,
    label,
    inputFile: csvFile ? path.resolve(csvFile) : null,
    inputHash,
    gitCommit,
    generatedAt: new Date().toISOString(),
    dataset: stats,
    evalProtocol: {
      ...describeProtocol(args.estFraction),
      sameTimestampRule: '同一时间戳视为同一答题批次，批次内记录互不为历史信息；排序以 createdAt、attemptIndex、原始行序为稳定次序（与规则基线完全一致）',
      bootstrap: '学生级聚类 bootstrap，重采样单位为学生，保留其全部记录',
      pValueInterpretation: '探索性指标：bootstrap 次数有限时分辨率低，不作为模型优越性的充分依据；主要结论应基于 Δ 及其 95% CI',
      bootstrapReps: boot.reps,
      bootstrapUnits: `${boot.students} 名学生（学生级聚类重采样）`,
      seed: 42
    },
    bkt: {
      estFraction: args.estFraction,
      targetCount: walkRows[models[0]].length,
      estimationObservations: estTotal,
      evaluationObservations: evalTotal,
      knowledgePoints: Object.keys(fitInfo).length,
      emConverged: convergedCount,
      fallbackToDefault: defaultParamsUsed,
      totalEstimationObservations: totalObservations,
      fitSeconds: Number(fitSeconds),
      paramsByKp,
      fitInfo
    },
    params: { bktDefault: DEFAULT_PARAMS },
    results,
    bootstrap: {
      method: '学生级聚类 bootstrap：以学生为重采样单位，保留其全部记录；同一批重采样权重同时用于所有模型（paired bootstrap）',
      reps: boot.reps,
      units: boot.students,
      ci: boot.ciByModel,
      comparisons: boot.comparisons.map((c) => ({ a: c.a, b: c.b, dAUC: c.dAUC, dLogLoss: c.dLogLoss }))
    },
    calibration: Object.fromEntries(models.map((m) => [m, calibrationBins(walkRows[m])]))
  }, null, 2));
  console.log(`\n结果已写入 ${outFile}`);
  console.log('注意：synthetic 源仅用于验证评估管道，结果不可作为真实学习效果。');
}

if (require.main === module) main();

module.exports = { parseArgs };
