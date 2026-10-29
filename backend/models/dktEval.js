const fs = require('fs');
const path = require('path');
const {
  loadFromCsv,
  loadFromDb,
  generateSyntheticRecords,
  groupByStudentKp,
  evaluateMetrics,
  formatTable,
  formatComparisonTable,
  calibrationBins,
  datasetStats,
  bootstrapAllModels
} = require('./baselineEval');
const {
  fitBktByKp,
  predictNextCorrect: bktPredictNext,
  DEFAULT_PARAMS
} = require('./bkt');
const { predictNextCorrect: rulePredictNext } = require('./ruleMastery');
const { sortByTime } = require('./ruleMastery');
const {
  buildStudentSequences,
  buildVocab,
  splitStudents,
  GruDkt,
  DEFAULT_HYPERPARAMS
} = require('./dkt');

/**
 * GRU-DKT 对照实验（学生级 train/validation/test 协议）
 *
 * 与 BKT 的「前后半段」协议刻意不同，两种协议不混在一张表里：
 *   - 学生级划分：70% train / 15% validation / 15% test（按学生划分，固定种子）；
 *   - DKT 在 train 学生上训练、validation 学生上早停、test 学生上评估；
 *   - 对照模型与 DKT 在同一 test 学生目标集上逐条预测：
 *       BKT    参数只在 train 学生上拟合（EM，全序列）；
 *       Rule-0 无参数，逐条 walk-forward；
 *       Majority 全局时间前缀正例率；
 *   - 目标集规则与规则基线完全一致：同一 (学生,知识点) 组的首批次（无更早记录）
 *     整体跳过，之后每条记录都是预测目标；历史 = 严格早于目标时刻的同组记录。
 *
 * 用法：
 *   cd backend
 *   node models/dktEval.js --source csv \
 *     --file datasets/assist2009/interactions.csv \
 *     --bootstrap 2000 --label dkt-assist2009
 * 可选：--seed 42 --epochs 50 --patience 5 --hidden 64 --embed 32 --dropout 0.2
 *       --lr 1e-3 --batch 64 --train-fraction 0.7 --val-fraction 0.15 --out
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
    seed: Number(get('seed', DEFAULT_HYPERPARAMS.seed)),
    hyper: {
      embedDim: Number(get('embed', DEFAULT_HYPERPARAMS.embedDim)),
      hiddenSize: Number(get('hidden', DEFAULT_HYPERPARAMS.hiddenSize)),
      dropout: Number(get('dropout', DEFAULT_HYPERPARAMS.dropout)),
      learningRate: Number(get('lr', DEFAULT_HYPERPARAMS.learningRate)),
      batchSize: Number(get('batch', DEFAULT_HYPERPARAMS.batchSize)),
      maxEpochs: Number(get('epochs', DEFAULT_HYPERPARAMS.maxEpochs)),
      earlyStoppingPatience: Number(get('patience', DEFAULT_HYPERPARAMS.earlyStoppingPatience)),
      gradClipNorm: DEFAULT_HYPERPARAMS.gradClipNorm,
      bceEps: DEFAULT_HYPERPARAMS.bceEps,
      seed: Number(get('seed', DEFAULT_HYPERPARAMS.seed))
    },
    trainFraction: Number(get('train-fraction', 0.7)),
    valFraction: Number(get('val-fraction', 0.15))
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
    console.error('没有可用答题记录。');
    process.exit(1);
  }

  const stats = datasetStats(records);
  console.log(`数据源: ${args.source}，答题记录 ${records.length} 条，学生 ${stats.studentCount}`);

  // ---------- 学生级序列 + 词表 + 划分 ----------
  const sequences = buildStudentSequences(records, { minLen: 2 });
  const vocab = buildVocab(sequences);
  const split = splitStudents(sequences.map((s) => s.userId), {
    train: args.trainFraction,
    validation: args.valFraction,
    seed: args.seed
  });
  const byUser = new Map(sequences.map((s) => [s.userId, s]));
  const pick = (ids) => ids.map((id) => byUser.get(id));
  const trainSeqs = pick(split.train);
  const valSeqs = pick(split.validation);
  const testSeqs = pick(split.test);
  const testSet = new Set(split.test);
  console.log(`学生级划分（seed ${split.seed}）: train ${trainSeqs.length} / validation ${valSeqs.length} / test ${testSeqs.length}（70/15/15）`);
  console.log(`词表: 知识点 ${vocab.numSkills} 个，交互 id ${vocab.vocabSize} 个（id = 2×kpIndex + isCorrect）`);

  // ---------- BKT 对照参数：只在 train 学生上拟合（EM，全序列，无 test 信息） ----------
  const trainUsers = new Set(split.train);
  const trainRecords = records.filter((r) => trainUsers.has(r.userId));
  const trainGroups = groupByStudentKp(trainRecords);
  const sequencesByKp = new Map();
  for (const group of trainGroups) {
    if (!sequencesByKp.has(group[0].kpCode)) sequencesByKp.set(group[0].kpCode, []);
    sequencesByKp.get(group[0].kpCode).push(group.map((r) => (r.isCorrect ? 1 : 0)));
  }
  const t0Bkt = Date.now();
  const { paramsByKp, fitInfo, defaultParamsUsed } = fitBktByKp(sequencesByKp);
  const bktSeconds = ((Date.now() - t0Bkt) / 1000).toFixed(1);
  const bktConverged = Object.values(fitInfo).filter((f) => f.converged).length;
  console.log(`\n== BKT 对照参数（仅 train 学生，EM）==`);
  console.log(`知识点 ${Object.keys(fitInfo).length} 个：容差收敛 ${bktConverged}，数据不足回退默认 ${defaultParamsUsed} 个，耗时 ${bktSeconds}s`);

  // ---------- DKT 训练 ----------
  console.log(`\n== GRU-DKT 训练（embed ${args.hyper.embedDim} / hidden ${args.hyper.hiddenSize} / dropout ${args.hyper.dropout} / lr ${args.hyper.learningRate} / batch ${args.hyper.batchSize}）==`);
  const model = new GruDkt(vocab, args.hyper);
  console.log(`参数量 ${model.paramCount()}；早停: 验证 LogLoss 连续 ${args.hyper.earlyStoppingPatience} 轮不下降`);
  const t0 = Date.now();
  const fit = model.fit(trainSeqs, valSeqs, {
    onEpoch: (c) => {
      process.stdout.write(`  epoch ${c.epoch}: train ${c.trainLogLoss} / val ${c.valLogLoss}${c.stoppedEarly ? '（早停）' : ''}\n`);
    }
  });
  const fitSeconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`训练完成: ${fit.epochsRun} 轮，最优 epoch ${fit.bestEpoch}（val LogLoss ${fit.bestValLogLoss}），耗时 ${fitSeconds}s${fit.stoppedEarly ? '（早停触发）' : ''}`);

  // ---------- 同一 test 目标集上的对照预测 ----------
  // 目标集规则与 walkForward 一致：(学生,知识点) 组首个时间戳之前无记录的批次跳过；
  // 由于 assist2009 学生内时间戳严格递增（相对时间轴 60s 步长），
  // 目标条件即 ts > 该组首个 ts。所有模型在同一批目标上逐条输出，行完全对齐。
  const globalSorted = sortByTime(records);
  const globalTimes = globalSorted.map((item) => new Date(item.createdAt).getTime());
  const prefixCount = [0];
  const prefixCorrect = [0];
  for (let i = 0; i < globalSorted.length; i++) {
    prefixCount.push(prefixCount[i] + 1);
    prefixCorrect.push(prefixCorrect[i] + (globalSorted[i].isCorrect ? 1 : 0));
  }
  const countBefore = (timeMs) => {
    let lo = 0, hi = globalTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (globalTimes[mid] < timeMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const rowsByModel = { DKT: [], BKT: [], 'Rule-0': [], Majority: [] };
  let skippedFirstBatch = 0;

  for (const seq of testSeqs) {
    const items = seq.items;
    // DKT 一次前向得到全部 t ≥ 1 的预测
    const dktPreds = model.predictSequence(items);
    const dktByT = new Map(dktPreds.map((o) => [o.t, o.pred]));

    // 同组首个时间戳（首批次跳过规则）
    const firstTsByKp = new Map();
    for (const it of items) {
      if (!firstTsByKp.has(it.kpCode) || it.ts < firstTsByKp.get(it.kpCode)) {
        firstTsByKp.set(it.kpCode, it.ts);
      }
    }
    // 滚动维护同组历史（严格早于目标时刻）
    const kpHistory = new Map(); // kpCode → [{ts, correct, record}]
    const pushHistory = (it) => {
      if (!kpHistory.has(it.kpCode)) kpHistory.set(it.kpCode, []);
      kpHistory.get(it.kpCode).push({ ts: it.ts, correct: it.correct, record: it.record });
    };

    for (let t = 0; t < items.length; t++) {
      const it = items[t];
      if (it.ts <= firstTsByKp.get(it.kpCode)) {
        skippedFirstBatch++;
      } else {
        const history = kpHistory.get(it.kpCode) || [];
        const historyBinary = history.map((h) => h.correct);
        const historyRecords = history.map((h) => h.record);
        const target = it.correct;
        const base = { userId: seq.userId, kpCode: it.kpCode, createdAt: it.record.createdAt, target };
        rowsByModel.DKT.push({ ...base, pred: Number(dktByT.get(t).toFixed(6)) });
        rowsByModel.BKT.push({
          ...base,
          pred: Number(bktPredictNext(paramsByKp[it.kpCode] || DEFAULT_PARAMS, historyBinary).toFixed(6))
        });
        rowsByModel['Rule-0'].push({
          ...base,
          pred: Number(rulePredictNext('Rule-0', historyRecords, { now: it.ts }).toFixed(6))
        });
        const cnt = countBefore(it.ts);
        rowsByModel.Majority.push({
          ...base,
          pred: Number(((prefixCorrect[cnt] + 1) / (prefixCount[cnt] + 2)).toFixed(6))
        });
      }
      pushHistory(it);
    }
  }

  const n = rowsByModel.DKT.length;
  console.log(`\n== test 学生目标集 ==`);
  console.log(`目标 ${n} 条（${testSeqs.length} 名 test 学生）；首批次跳过 ${skippedFirstBatch} 条（与规则基线同一规则）`);
  const models = Object.keys(rowsByModel);
  for (const m of models) {
    if (rowsByModel[m].length !== n) throw new Error(`行数不一致: ${m} ${rowsByModel[m].length} vs ${n}`);
  }

  const results = {};
  for (const m of models) results[m] = evaluateMetrics(rowsByModel[m]);
  console.log(formatTable(results));

  // ---------- 学生级 bootstrap（同一批权重用于所有模型） ----------
  const boot = bootstrapAllModels(rowsByModel, { reps: args.bootstrap, seed: args.seed });
  console.log(`\n== 95% 置信区间（学生级 bootstrap × ${boot.reps}，${boot.students} 名 test 学生）==`);
  for (const m of models) {
    const ci = boot.ciByModel[m];
    const r = results[m];
    console.log(`${m}: AUC ${r.AUC === null ? '-' : r.AUC} [${ci.AUC[0]}, ${ci.AUC[1]}]，LogLoss ${r.LogLoss} [${ci.LogLoss[0]}, ${ci.LogLoss[1]}]`);
  }
  console.log('\n== 配对比较（同一目标集，Δ = 行A − 行B）==');
  const pairs = boot.comparisons.map((c) => ({ a: c.a, b: c.b, res: { dAUC: c.dAUC, dLogLoss: c.dLogLoss } }));
  console.log(formatComparisonTable(pairs));

  console.log('\n== 分箱校准（10 箱）==');
  for (const m of models) {
    const bins = calibrationBins(rowsByModel[m]).filter((b) => b.n > 0);
    console.log(`${m}:`);
    for (const b of bins) console.log(`  ${b.range}  n=${b.n}  预测 ${b.meanPredicted}  实际 ${b.observedRate}`);
  }

  // ---------- 结果 JSON ----------
  const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, '..', '实验结果文件');
  fs.mkdirSync(outDir, { recursive: true });
  const label = args.label ? String(args.label).replace(/[^\w.-]/g, '') : `dkt-${args.source}`;
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
    // 顶层便捷元数据（审计用；详细值见 dkt.splitCounts / dkt.training）
    seed: split.seed,
    trainStudents: trainSeqs.length,
    validationStudents: valSeqs.length,
    testStudents: testSeqs.length,
    epochsRun: fit.epochsRun,
    bestEpoch: fit.bestEpoch,
    dataset: stats,
    evalProtocol: {
      model: 'GRU-DKT（最小实现：Embedding → GRU(1 层) → Linear → Sigmoid，经典 DKT 输入 id = 2×kpIndex + isCorrect）',
      positioning: '深度知识追踪对照实验：检验基础深度模型在与规则基线/BKT 相同的数据管线上能否带来增益；不是复杂知识图谱模型',
      split: `学生级 train/validation/test = ${args.trainFraction}/${args.valFraction}/${(1 - args.trainFraction - args.valFraction).toFixed(2)}（按学生划分，固定种子 ${split.seed}，同一学生不出现在多个集合）`,
      protocolDifference: '与 BKT 的「前 50% 估计段 / 后 50% 评估段」协议刻意不同（DKT 需要独立验证集做早停），两种协议的结果不混在一张表、不直接互比',
      targetRule: '目标 = test 学生中 (学生,知识点) 组非首批次的记录（与规则基线同一规则：同组首条记录之前无更早记录则跳过）；历史 = 严格早于目标时刻的同组记录',
      fairness: 'DKT / BKT / Rule-0 / Majority 在同一 test 学生目标集上逐条预测，行完全对齐；BKT 参数只用 train 学生拟合',
      bootstrap: '学生级聚类 bootstrap，重采样单位为 test 学生，保留其全部记录',
      bootstrapReps: boot.reps,
      bootstrapUnits: `${boot.students} 名 test 学生`,
      pValueInterpretation: '探索性指标；主要结论应基于 Δ 及其 95% CI'
    },
    dkt: {
      hyperParams: args.hyper,
      paramCount: model.paramCount(),
      vocabSize: vocab.vocabSize,
      numSkills: vocab.numSkills,
      inputEncoding: 'interaction_id = 2 × kp_index + isCorrect（经典 DKT 输入方式）',
      training: {
        optimizer: 'Adam（梯度全局范数裁剪 5.0）',
        loss: 'BCE，仅在有效目标位（t ≥ 1）计算；padding 不参与损失',
        dropoutTarget: 'embedding 输出（inverted dropout，仅训练时）',
        earlyStopping: `验证集 LogLoss 连续 ${args.hyper.earlyStoppingPatience} 轮不下降即停止，回滚到验证集最优参数`,
        epochsRun: fit.epochsRun,
        bestEpoch: fit.bestEpoch,
        bestValLogLoss: fit.bestValLogLoss,
        stoppedEarly: fit.stoppedEarly,
        fitSeconds: Number(fitSeconds),
        curve: fit.curve
      },
      splitCounts: {
        train: trainSeqs.length,
        validation: valSeqs.length,
        test: testSeqs.length,
        seed: split.seed,
        fractions: split.fractions
      }
    },
    bkt: {
      fitScope: '仅 train 学生（全序列 EM；与 BKT 论文的估计段协议不同，此处按学生划分无泄漏）',
      knowledgePoints: Object.keys(fitInfo).length,
      emConverged: bktConverged,
      fallbackToDefault: defaultParamsUsed,
      fitSeconds: Number(bktSeconds),
      paramsByKp,
      fitInfo
    },
    targetCount: n,
    results,
    bootstrap: {
      method: '学生级聚类 bootstrap（test 学生为重采样单位），同一批重采样权重用于所有模型（paired bootstrap）',
      reps: boot.reps,
      units: boot.students,
      ci: boot.ciByModel,
      comparisons: boot.comparisons.map((c) => ({ a: c.a, b: c.b, dAUC: c.dAUC, dLogLoss: c.dLogLoss }))
    },
    calibration: Object.fromEntries(models.map((m) => [m, calibrationBins(rowsByModel[m])]))
  }, null, 2));
  console.log(`\n结果已写入 ${outFile}`);
  console.log('注意：synthetic 源仅用于验证评估管道，结果不可作为真实学习效果。');
}

if (require.main === module) main();

module.exports = { parseArgs };
