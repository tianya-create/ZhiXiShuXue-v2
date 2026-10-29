/**
 * 多种子重复实验汇总：读取 GRU-DKT 学生级协议在不同 --seed 下的结果 JSON，
 * 输出每个模型 AUC/LogLoss 的 mean±std（种子间波动）、逐种子配对差方向统计，
 * 写入 baseline-results-dkt-assist2009-multiseed.json。
 *
 * 用法：node models/aggregateDktSeeds.js --seeds 42,43,44,45,46
 *
 * 注意：各种子使用不同的学生级 70/15/15 划分（目标集不同），
 * 因此各种子之间的指标**不能配对比较**，只能做「逐种子内部配对结论 + 跨种子方向统计」。
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    seeds: get('seeds', '42,43,44,45,46').split(',').map(Number),
    out: get('out', path.join(__dirname, '..', '实验结果文件', 'baseline-results-dkt-assist2009-multiseed.json'))
  };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// 注意：这里是总体标准差（除以 n）。种子只有 5 个且是我们主动选取的
// 重复实验条件（不是从种子总体随机抽样），用总体口径描述「这 5 次运行的
// 实际波动」比样本口径更贴切；如需样本标准差请改用 n−1。
const std = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = [];
  for (const seed of args.seeds) {
    const suffix = seed === 42 ? '' : `-s${seed}`;
    const file = path.join(__dirname, '..', '实验结果文件', `baseline-results-dkt-assist2009${suffix}.json`);
    if (!fs.existsSync(file)) {
      console.error(`缺少结果文件: ${file}`);
      process.exit(1);
    }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    runs.push({ seed, file: path.basename(file), json: j });
  }

  const models = ['DKT', 'BKT', 'Rule-0', 'Majority'];
  const perModel = {};
  for (const m of models) {
    const aucs = runs.map((r) => r.json.results[m].AUC);
    const lls = runs.map((r) => r.json.results[m].LogLoss);
    perModel[m] = {
      auc: { perSeed: aucs.map((v) => Number(v.toFixed(4))), mean: Number(mean(aucs).toFixed(4)), std: Number(std(aucs).toFixed(4)) },
      logLoss: { perSeed: lls.map((v) => Number(v.toFixed(4))), mean: Number(mean(lls).toFixed(4)), std: Number(std(lls).toFixed(4)) }
    };
  }

  // 逐种子配对结论（种子内部同目标集，可配对；跨种子只统计方向）
  const pairs = [['DKT', 'BKT'], ['DKT', 'Rule-0'], ['DKT', 'Majority'], ['BKT', 'Rule-0']];
  // sign 统一为 a − b 方向后，区间端点需重排；CI 不含 0 ⇔ 两端同号（lo*hi > 0）
  const flipCi = (ci, sign) => (sign > 0 ? ci : [-ci[1], -ci[0]]);
  const excludesZero = (ci, sign) => {
    const [lo, hi] = flipCi(ci, sign);
    return lo * hi > 0;
  };
  const pairStats = pairs.map(([a, b]) => {
    const perSeed = runs.map((r) => {
      const c = r.json.bootstrap.comparisons.find((x) => x.a === a && x.b === b)
        || r.json.bootstrap.comparisons.find((x) => x.a === b && x.b === a);
      const sign = c ? (c.a === a ? 1 : -1) : 0; // 统一为 a − b 方向
      const [aucLo, aucHi] = flipCi(c.dAUC.ci, sign);
      const [llLo, llHi] = flipCi(c.dLogLoss.ci, sign);
      return {
        seed: r.seed,
        dAUC: Number((sign * c.dAUC.meanDiff).toFixed(4)),
        dAucCi: [Number(aucLo.toFixed(4)), Number(aucHi.toFixed(4))],
        dLogLoss: Number((sign * c.dLogLoss.meanDiff).toFixed(4)),
        dLogLossCi: [Number(llLo.toFixed(4)), Number(llHi.toFixed(4))],
        aucCiExcludesZero: excludesZero(c.dAUC.ci, sign),
        llCiExcludesZero: excludesZero(c.dLogLoss.ci, sign)
      };
    });
    return {
      pair: `${a} − ${b}`,
      perSeed,
      aucPositiveSeeds: perSeed.filter((p) => p.dAUC > 0).length,
      aucCiExcludesZeroSeeds: perSeed.filter((p) => p.aucCiExcludesZero).length,
      llNegativeSeeds: perSeed.filter((p) => p.dLogLoss < 0).length,
      llCiExcludesZeroSeeds: perSeed.filter((p) => p.llCiExcludesZero).length
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    experimentType: '5 个随机种子重复实验：改变学生划分、参数初始化和训练随机过程；共享同一数据集与同一组超参，不是统计意义上的完全独立实验',
    aggregation: '对各种子指标取 mean ± std（std 为种子间总体标准差，除以 n；不是跨种子置信区间）',
    caveatMergedTestSet: '各种子 test 学生集合不同，禁止把 5 份 test 目标合并成一个「合并测试集」重算总指标或做配对检验',
    perSeedCiMeaning: '每个种子内部的配对 bootstrap CI 只说明该划分内模型差异稳定，不是对 5 种子均值进行的跨种子显著性检验',
    protocol: '学生级 70/15/15（按学生划分，每个种子独立划分并独立训练）；各种子目标集不同，跨种子数字不可配对比较，仅统计方向一致性',
    seeds: runs.map((r) => ({ seed: r.seed, file: r.file, testTargets: r.json.targetCount, epochsRun: r.json.dkt.training.epochsRun, bestEpoch: r.json.dkt.training.bestEpoch })),
    perModel,
    pairedDirection: pairStats,
    conclusionTemplate: '在 {nSeeds} 个随机种子（改变学生划分、初始化与训练随机过程）的重复实验中，DKT − Rule-0 的 ΔAUC 在 {aucPos}/{nSeeds} 个种子为正、{aucCi}/{nSeeds} 个种子 CI 不含 0；DKT − BKT 的 ΔLogLoss 在 {llPos}/{nSeeds} 个种子为负、{llCi}/{nSeeds} 个种子 CI 不含 0。'
  };

  fs.writeFileSync(args.out, JSON.stringify(summary, null, 2) + '\n');
  console.log('写入', args.out);
  for (const m of models) {
    const p = perModel[m];
    console.log(m.padEnd(9), 'AUC', p.auc.mean, '±', p.auc.std, '| LL', p.logLoss.mean, '±', p.logLoss.std);
  }
  for (const p of pairStats) {
    console.log(p.pair.padEnd(16), 'ΔAUC>0:', `${p.aucPositiveSeeds}/${p.perSeed.length}`, 'CI>0:', `${p.aucCiExcludesZeroSeeds}/${p.perSeed.length}`, '| ΔLL<0:', `${p.llNegativeSeeds}/${p.perSeed.length}`, 'CI<0:', `${p.llCiExcludesZeroSeeds}/${p.perSeed.length}`);
  }
}

main();
