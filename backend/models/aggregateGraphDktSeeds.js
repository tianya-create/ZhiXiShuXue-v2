/**
 * aggregateGraphDktSeeds.js —— 图增强 DKT 五种子聚合
 *
 * 严格校验：每个种子目录必须有 results.json / targets.json / predictions.jsonl /
 * audit-report.json（非空且 passed=true、引用哈希与当前文件一致）；种子不重复、
 * 协议/构图规则/超参跨种子一致（允许 splitSeed、图哈希与目标数随种子变化）。
 * 汇总：五种子明细 → 每模型 mean ± 总体标准差（÷n）。**主表输入不是 results.json 里的
 * 4 位舍入值**：从落盘 predictions.jsonl/targets.json 用 evaluateMetricsPrecise 重算
 * 每种子未舍入指标（并核对 round4(重算) == results.json 记录，不一致即拒绝），
 * 再以全精度计算 meanExact/populationStdExact；四项重点比较用同种子
 * 未舍入点差的均值（不用已舍入均值相减），并汇总方向与 CI 支持计数。
 *
 * 用法：
 *   node models/aggregateGraphDktSeeds.js --config <config> \
 *     --input-dir <gcn-dkt-v1> --seeds 42,43,44,45,46 [--out <file>]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('找不到模块，尝试过：' + candidates.join(' ; '));
}
const repoRoot = path.join(__dirname, '..', '..');
const exp = resolveModule([
  path.join(__dirname, 'graphDktExperiment.js'),
  path.join(repoRoot, 'model', 'graphDktExperiment.js')
]);
const evalMod = resolveModule([
  path.join(__dirname, 'baselineEval.js'),
  path.join(repoRoot, 'model', 'baselineEval.js')
]);

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256Hex(fs.readFileSync(p));
const log = (s) => process.stdout.write(s + '\n');
const get = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
};

function main() {
  const configFile = get('config');
  const inputDir = get('input-dir');
  const seedsArg = get('seeds');
  const outArg = get('out');
  if (!configFile || !inputDir || !seedsArg) {
    console.error('用法: node models/aggregateGraphDktSeeds.js --config <config> --input-dir <dir> --seeds 42,43,44,45,46 [--out <file>]');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'));
  exp.validateConfig(config);
  const seeds = seedsArg.split(',').map((s) => Number(s.trim()));
  if (new Set(seeds).size !== seeds.length) { console.error('seeds 存在重复'); process.exit(1); }
  for (const s of seeds) {
    if (!config.seeds.includes(s)) { console.error(`seed ${s} 不在配置 seeds ${JSON.stringify(config.seeds)} 中（拒绝混协议聚合）`); process.exit(1); }
  }

  const keys = Object.keys(exp.MODE_KEYS);
  const seedDocs = [];
  for (const seed of seeds) {
    const seedDir = path.join(path.resolve(inputDir), `seed-${seed}`);
    const need = ['results.json', 'targets.json', 'predictions.jsonl', 'audit-report.json'];
    for (const f of need) {
      const p = path.join(seedDir, f);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
        console.error(`seed-${seed} 缺少 ${f} 或为空文件——空文件不能作为有效审计依据，聚合拒绝。`);
        process.exit(1);
      }
    }
    const results = JSON.parse(fs.readFileSync(path.join(seedDir, 'results.json'), 'utf8'));
    const audit = JSON.parse(fs.readFileSync(path.join(seedDir, 'audit-report.json'), 'utf8'));
    if (results.seed !== seed) { console.error(`seed-${seed} 目录内 results.seed=${results.seed}，不一致`); process.exit(1); }
    if (results.protocolVersion !== config.protocolVersion) { console.error(`seed-${seed} 协议不一致`); process.exit(1); }
    if (audit.passed !== true) { console.error(`seed-${seed} 审计未通过（passed=${audit.passed}）`); process.exit(1); }
    // 审计引用的文件哈希必须与当前文件一致（防止审计后文件被替换）
    const predsSha = 'sha256:' + sha256File(path.join(seedDir, 'predictions.jsonl'));
    const targetsSha = 'sha256:' + sha256File(path.join(seedDir, 'targets.json'));
    if (audit.inputs.predictionsSha256 !== predsSha || audit.inputs.targetsSha256 !== targetsSha) {
      console.error(`seed-${seed} 审计报告引用的文件哈希与当前文件不一致（预测/目标在审计后被替换）`);
      process.exit(1);
    }
    if (results.files.predictionsSha256 !== predsSha) { console.error(`seed-${seed} predictions 哈希与 results 引用不一致`); process.exit(1); }
    // 审计必须绑定 results.json 本身的哈希：审计后又被改过（哪怕只改成绩）即拒绝
    const resultsSha = 'sha256:' + sha256File(path.join(seedDir, 'results.json'));
    if (!audit.inputs || audit.inputs.resultsSha256 !== resultsSha) {
      console.error(`seed-${seed} results.json 在审计后被修改（审计记录 ${audit.inputs && audit.inputs.resultsSha256} vs 当前 ${resultsSha}）——拒绝聚合`);
      process.exit(1);
    }
    if (audit.checksPassed !== audit.checksTotal) {
      console.error(`seed-${seed} 审计报告自相矛盾（checksPassed ${audit.checksPassed} ≠ checksTotal ${audit.checksTotal}）`);
      process.exit(1);
    }
    // 审计必须真的重算过 bootstrap（否则 CI/标志无独立依据）
    if (!Array.isArray(audit.recomputedComparisons) || audit.recomputedComparisons.length === 0) {
      console.error(`seed-${seed} 审计报告缺少 recomputedComparisons（未重算 CI 的审计不能作为聚合依据）`);
      process.exit(1);
    }
    // 比较行：标志必须与「原始未舍入 CI」自洽，且与审计重算逐项一致
    if (!results.bootstrap || !Array.isArray(results.bootstrap.comparisons)) {
      console.error(`seed-${seed} results.bootstrap.comparisons 缺失`);
      process.exit(1);
    }
    for (const c of results.bootstrap.comparisons) {
      const flags = exp.comparisonFlags({ dAUC: c.dAUC, dAUCCI: c.dAUCCI, dLogLoss: c.dLogLoss, dLogLossCI: c.dLogLossCI });
      const bad = ['ciAvailable', 'aucExcludesZero', 'aucCISupportsGCN', 'logLossExcludesZero', 'logLossCISupportsGCN']
        .filter((f) => c[f] !== flags[f]);
      if (bad.length) {
        console.error(`seed-${seed} 比较「${c.comparison}」的 ${bad.join('/')} 与原始 CI 矛盾——拒绝聚合`);
        process.exit(1);
      }
      if (c.ciAvailable && (!Array.isArray(c.dAUCCI) || c.dAUCCI.length !== 2 || !Array.isArray(c.dLogLossCI) || c.dLogLossCI.length !== 2)) {
        console.error(`seed-${seed} 比较「${c.comparison}」标记 CI 可用但 CI 缺失/长度异常`);
        process.exit(1);
      }
      const audited = audit.recomputedComparisons.find((x) => x.comparison === c.comparison);
      if (!audited) { console.error(`seed-${seed} 审计重算缺少比较「${c.comparison}」`); process.exit(1); }
      const drift = ['dAUC', 'dLogLoss'].filter((f) => Math.abs(audited[f] - c[f]) > 1e-12);
      if (drift.length) {
        console.error(`seed-${seed} 比较「${c.comparison}」的 ${drift.join('/')} 与审计重算不一致——拒绝聚合`);
        process.exit(1);
      }
    }
    // 模型齐全、参数量一致
    for (const k of keys) {
      if (!results.models[k]) { console.error(`seed-${seed} 缺模型 ${k}`); process.exit(1); }
    }
    // 主表精度（2026-11-02 审计 P2）：从落盘预测重算「未舍入」单种子指标；
    // results.json 的 4 位记录仅作交叉核对（round4(重算) 必须等于记录，否则结果与预测不符）
    const targetsDoc = JSON.parse(fs.readFileSync(path.join(seedDir, 'targets.json'), 'utf8'));
    const predLines = fs.readFileSync(path.join(seedDir, 'predictions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (predLines.length !== targetsDoc.targets.length) {
      console.error(`seed-${seed} predictions 行数 ${predLines.length} ≠ 目标数 ${targetsDoc.targets.length}`);
      process.exit(1);
    }
    const rowsByModel = Object.fromEntries(keys.map((k) => [k, []]));
    for (let i = 0; i < predLines.length; i++) {
      const t = targetsDoc.targets[i];
      for (const k of keys) {
        const p = predLines[i].preds && predLines[i].preds[k];
        if (!Number.isFinite(p) || p < 0 || p > 1) {
          console.error(`seed-${seed} predictions 第 ${i} 行 ${k} 预测值不合法`); process.exit(1);
        }
        rowsByModel[k].push({ ...t, pred: p });
      }
    }
    const preciseMetrics = {};
    for (const k of keys) {
      const raw = evalMod.evaluateMetricsPrecise(rowsByModel[k]);
      for (const m of ['AUC', 'LogLoss', 'Brier', 'Accuracy']) {
        const stored = results.results[k][m];
        const rec = raw[m] === null || raw[m] === undefined ? null : Number(raw[m].toFixed(4));
        if (rec !== stored) {
          console.error(`seed-${seed} 模型 ${k} 的 ${m}：预测重算 round4=${rec} ≠ results.json 记录 ${stored}——结果与预测不符，拒绝聚合`);
          process.exit(1);
        }
      }
      preciseMetrics[k] = raw;
    }
    // 跨种子一致性：结构超参与构图规则一致（splitSeed/图哈希/目标数允许随种子变化）
    seedDocs.push({ seed, seedDir, results, audit, preciseMetrics });
  }
  const first = seedDocs[0].results;
  const statsHashOf = (results) => (results.statisticsRevision
    ? results.statisticsRevision.statisticsImplementationHash
    : (results.implementationMetadata && results.implementationMetadata.implementationHash) || null);
  const statsHashes = seedDocs.map(({ results }) => statsHashOf(results));
  if (new Set(statsHashes).size !== 1) {
    console.error(`各种子统计实现哈希不一致（${statsHashes.map((h) => String(h).slice(7, 15)).join(', ')}）——拒绝混用修订前后/不同统计实现的聚合`);
    process.exit(1);
  }
  for (const { seed, results } of seedDocs) {
    for (const k of keys) {
      if (results.models[k].paramCount !== first.models[k].paramCount) {
        console.error(`seed-${seed} 模型 ${k} 参数量与 seed-${seeds[0]} 不一致`); process.exit(1);
      }
      const hu = { ...results.models[k].hyperUsed, seed: null };
      const h0 = { ...first.models[k].hyperUsed, seed: null };
      if (JSON.stringify(hu) !== JSON.stringify(h0)) {
        console.error(`seed-${seed} 模型 ${k} 训练超参与 seed-${seeds[0]} 不一致（seed 本身允许不同）`); process.exit(1);
      }
    }
    if (JSON.stringify(results.configSha256) !== JSON.stringify(first.configSha256)) {
      console.error(`seed-${seed} configSha256 与 seed-${seeds[0]} 不一致（拒绝混协议/混超参聚合）`); process.exit(1);
    }
  }

  // ---- 汇总 ----
  const popStd = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length); // 总体标准差 ÷n
  };
  const perSeed = {};
  const perSeedExact = {};
  const perModelStats = {};
  for (const k of keys) {
    perSeed[k] = seedDocs.map(({ seed, results }) => ({
      seed,
      AUC: results.results[k].AUC,
      LogLoss: results.results[k].LogLoss,
      Brier: results.results[k].Brier,
      Accuracy: results.results[k].Accuracy,
      bestValLogLoss: results.models[k].training.bestValLogLoss,
      epochsRun: results.models[k].training.epochsRun,
      fitSeconds: results.models[k].training.fitSeconds,
      targetCount: results.targetCount
    }));
    // 未舍入明细：来自 evaluateMetricsPrecise（对落盘预测重算），不是 results.json 的 4 位记录
    perSeedExact[k] = seedDocs.map(({ seed, preciseMetrics }) => ({
      seed,
      AUC: preciseMetrics[k].AUC,
      LogLoss: preciseMetrics[k].LogLoss,
      Brier: preciseMetrics[k].Brier,
      Accuracy: preciseMetrics[k].Accuracy
    }));
    for (const m of ['AUC', 'LogLoss', 'Brier', 'Accuracy']) {
      const exactVals = perSeedExact[k].map((r) => r[m]);
      const storedVals = perSeed[k].map((r) => r[m]);
      if (exactVals.some((v) => v === null || v === undefined || !Number.isFinite(v))) {
        console.error(`模型 ${k} 的 ${m} 存在不可用值（单类 AUC 为 null 等），拒绝聚合主表`); process.exit(1);
      }
      const meanExact = exactVals.reduce((a, b) => a + b, 0) / exactVals.length;
      perModelStats[k] = perModelStats[k] || {};
      perModelStats[k][m] = {
        meanExact,                                   // 全精度均值（主表口径）
        populationStdExact: popStd(exactVals),       // 全精度总体标准差（÷n）
        mean: Number(meanExact.toFixed(6)),          // 展示值 = meanExact 的 6 位有效舍入
        populationStd: Number(popStd(exactVals).toFixed(6)),
        perSeedExact: exactVals,
        // 留痕：旧口径（直接平均 results.json 的 4 位舍入记录）——用于审计对照，
        // 两者在第 4 位小数可能不同（例：Full 平均 LogLoss 0.5384 vs 0.5385）
        meanFromStoredRounded: Number((storedVals.reduce((a, b) => a + b, 0) / storedVals.length).toFixed(6)),
        populationStdFromStoredRounded: Number(popStd(storedVals).toFixed(6)),
        inputRule: '各种子指标从 predictions.jsonl 以 evaluateMetricsPrecise 重算（未舍入），非 results.json 的 4 位展示值'
      };
    }
  }
  // 四项重点比较：同种子未舍入点差 → 跨种子均值/总体标准差/方向与 CI 支持计数
  const comparisons = {};
  for (const c of first.bootstrap.comparisons) {
    const name = c.comparison;
    const perSeedRows = seedDocs.map(({ seed, results }) => {
      const r = results.bootstrap.comparisons.find((x) => x.comparison === name);
      if (!r) throw new Error(`seed-${seed} 缺少比较 ${name}`);
      return {
        seed,
        dAUC: r.dAUC,               // 未舍入点估计差
        dLogLoss: r.dLogLoss,
        aucCISupportsGCN: r.aucCISupportsGCN,       // AUC：CI 下界 > 0
        logLossCISupportsGCN: r.logLossCISupportsGCN, // LogLoss：CI 上界 < 0
        ciAvailable: r.ciAvailable
      };
    });
    const dAUCs = perSeedRows.map((r) => r.dAUC);
    const dLLs = perSeedRows.map((r) => r.dLogLoss);
    comparisons[name] = {
      perSeed: perSeedRows,
      dAUCMean: dAUCs.reduce((a, b) => a + b, 0) / dAUCs.length,
      dAUCPopulationStd: popStd(dAUCs),
      dAUCPositiveCount: dAUCs.filter((v) => v > 0).length,
      aucCISupportCount: perSeedRows.filter((r) => r.aucCISupportsGCN === true).length,
      dLogLossMean: dLLs.reduce((a, b) => a + b, 0) / dLLs.length,
      dLogLossPopulationStd: popStd(dLLs),
      dLogLossNegativeCount: dLLs.filter((v) => v < 0).length,
      logLossCISupportCount: perSeedRows.filter((r) => r.logLossCISupportsGCN === true).length,
      ciDegenerateSeeds: perSeedRows.filter((r) => !r.ciAvailable).map((r) => r.seed)
    };
  }

  const seedsComplete = seeds.length === config.seeds.length;
  const summary = {
    stage: 'E-aggregate',
    protocolVersion: config.protocolVersion,
    configSha256: first.configSha256,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    seeds,
    seedsComplete,
    note: seedsComplete
      ? '五种子齐全。'
      : `仅聚合 ${seeds.length}/${config.seeds.length} 个种子（seedsComplete=false），不得作为最终五种子结论。`,
    perSeed,
    perSeedExact,
    mainTableInputRule: '主表 mean/populationStd 由各种子「未舍入指标」（从 predictions.jsonl 重算）聚合；perSeed 为 results.json 的 4 位记录，仅作对照',
    perModelStats,
    comparisons,
    frozenThresholds: {
      minimumMeanAucGainVsFull: config.evaluation.minimumMeanAucGainVsFull,
      maximumMeanLogLossIncreaseVsFull: config.evaluation.maximumMeanLogLossIncreaseVsFull,
      rule: config.evaluation.selectionRule
    },
    statisticsImplementationHash: statsHashes[0],
    comparisonCIRule: 'CI 为未舍入百分位；方向/显著性标志由原始值判定（*CI4 仅展示）',
    auditReferences: seedDocs.map(({ seed, results, audit }) => ({
      seed,
      auditFile: `seed-${seed}/audit-report.json`,
      auditSha256: 'sha256:' + sha256File(path.join(seedDocs.find((d) => d.seed === seed).seedDir, 'audit-report.json')),
      auditPassed: audit.passed,
      checksPassed: audit.checksPassed,
      checksTotal: audit.checksTotal,
      resultsSha256: audit.inputs.resultsSha256,
      predictionsSha256: audit.inputs.predictionsSha256,
      trainingImplementationHash: results.implementationMetadata ? results.implementationMetadata.implementationHash : null,
      statisticsImplementationHash: statsHashes.find((h, i) => seedDocs[i].seed === seed) || null,
      statisticsRevised: !!results.statisticsRevision,
      revisionNote: results.statisticsRevision ? results.statisticsRevision.reason : null
    }))
  };

  const outFile = outArg
    ? path.resolve(outArg)
    : path.join(path.resolve(inputDir), 'multiseed-summary.json');
  if (fs.existsSync(outFile)) {
    const prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (prev.protocolVersion !== config.protocolVersion) {
      console.error(`已存在 ${outFile} 属于不同协议版本 ${prev.protocolVersion}，拒绝覆盖`);
      process.exit(1);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  log(`聚合完成：seeds [${seeds.join(', ')}]，seedsComplete=${seedsComplete}`);
  log('== 主表（mean ± 总体标准差；输入=从预测重算的未舍入单种子指标）==');
  for (const k of keys) {
    const a = perModelStats[k].AUC;
    const l = perModelStats[k].LogLoss;
    const drift = ['AUC', 'LogLoss'].filter((m) => perModelStats[k][m].mean !== perModelStats[k][m].meanFromStoredRounded);
    const note = drift.length ? `（${drift.join('/')} 与旧「舍入记录求均值」口径不同：${drift.map((m) => perModelStats[k][m].meanFromStoredRounded.toFixed(4) + '→' + perModelStats[k][m].mean.toFixed(4)).join('、')}）` : '';
    log(`  ${k.padEnd(16)} AUC ${a.mean.toFixed(4)} ± ${a.populationStd.toFixed(4)}  LogLoss ${l.mean.toFixed(4)} ± ${l.populationStd.toFixed(4)}${note}`);
  }
  log('== 四项重点比较（GCN − X）==');
  for (const [name, c] of Object.entries(comparisons)) {
    log(`  ${name.padEnd(26)} ΔAUC ${c.dAUCMean.toFixed(6)} ± ${c.dAUCPopulationStd.toFixed(6)}（正 ${c.dAUCPositiveCount}/${seeds.length}，CI 支持 ${c.aucCISupportCount}/${seeds.length}）  ΔLogLoss ${c.dLogLossMean.toFixed(6)}（负 ${c.dLogLossNegativeCount}/${seeds.length}，CI 支持 ${c.logLossCISupportCount}/${seeds.length}）`);
  }
  log(`汇总已写入 ${outFile}`);
}

main();
