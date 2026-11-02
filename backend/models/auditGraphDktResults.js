/**
 * auditGraphDktResults.js —— 图增强 DKT 结果独立审计（阶段 E 口径的单种子部分）
 *
 * 不加载训练 checkpoint 与任何模型：仅读取落盘的 targets.json / predictions.jsonl，
 * 重算全部指标、校准、学生级配对 bootstrap 与未舍入 CI，核对：
 *   1) 文件哈希（targets / predictions / results / training-curves）与 results.json 引用；
 *   2) 逐目标身份、标签、五组预测合法性；
 *   3) 指标、校准分箱、逐模型 CI、四项比较的点差与未舍入 CI；
 *   4) 方向/显著性标志：既比对记录值，也用「记录中的原始 CI」重新判定 → 抓自相矛盾标志；
 *   5) 有效抽样数：bootstrap reps / units（学生数）/ 逐模型 draws / 逐比较 validDraws；
 *   6) 源码来源：当前源码 implementationHash vs 记录的统计实现哈希；
 *      统计修订（statisticsRevision）时必须证明「训练哈希保留、预测未变、未重训」；
 *   7) 图 manifest 邻接哈希：从原始边 CSV 独立重建 Anorm。
 * 任何不一致都使审计失败（exit 1），并在 audit-report.json 记录 results.json 的哈希，
 * 供聚合器拒绝「审计后被修改」的结果文件。
 *
 * 用法：
 *   node models/auditGraphDktResults.js --config <experiment-config.json> \
 *     --input-dir <gcn-dkt-v1> --seed 42 [--recompute-bootstrap]
 *   （--recompute-bootstrap 为兼容旧调用保留；bootstrap 现在总是重算。）
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
const baselineEval = resolveModule([
  path.join(__dirname, 'baselineEval.js'),
  path.join(repoRoot, 'model', 'baselineEval.js')
]);
const bootstrapStats = resolveModule([
  path.join(__dirname, 'bootstrapStats.js'),
  path.join(repoRoot, 'model', 'bootstrapStats.js')
]);
const graphScript = resolveModule([
  path.join(__dirname, '..', 'scripts', 'buildAssist2009SkillGraph.js'),
  path.join(repoRoot, 'scripts', 'buildAssist2009SkillGraph.js')
]);
const exp = resolveModule([
  path.join(__dirname, 'graphDktExperiment.js'),
  path.join(repoRoot, 'model', 'graphDktExperiment.js')
]);
const { evaluateMetrics, calibrationBins, bootstrapAllModels } = baselineEval;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256Hex(fs.readFileSync(p));
const log = (s) => process.stdout.write(s + '\n');

const get = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
};

/** 未舍入 CI 足够接近（bootstrap 确定性，同一实现应逐位相同；留 1e-12 容差） */
const ciEqual = (a, b, tol = 1e-12) => Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 &&
  a.every((v, i) => (v === null && b[i] === null) || (Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v - b[i]) <= tol));

/** 审计侧独立实现的标志判定（与 graphDktExperiment.comparisonFlags 交叉核对） */
function localFlags(dAUC, dAUCCI, dLogLoss, dLogLossCI) {
  const ok = (ci) => Array.isArray(ci) && ci.length === 2 && ci.every((v) => Number.isFinite(v));
  const ciAvailable = ok(dAUCCI) && ok(dLogLossCI);
  return {
    ciAvailable,
    aucExcludesZero: ciAvailable ? dAUCCI[0] * dAUCCI[1] > 0 : null,
    aucCISupportsGCN: ciAvailable ? dAUCCI[0] > 0 : null,
    logLossExcludesZero: ciAvailable ? dLogLossCI[0] * dLogLossCI[1] > 0 : null,
    logLossCISupportsGCN: ciAvailable ? dLogLossCI[1] < 0 : null
  };
}

function main() {
  const configFile = get('config');
  const inputDir = get('input-dir');
  const seed = Number(get('seed'));
  const recomputeBootstrapFlag = process.argv.includes('--recompute-bootstrap');
  if (!configFile || !inputDir || !Number.isInteger(seed)) {
    console.error('用法: node models/auditGraphDktResults.js --config <config> --input-dir <dir> --seed <n> [--recompute-bootstrap]');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'));
  exp.validateConfig(config);
  if (!config.seeds.includes(seed)) {
    console.error(`--seed ${seed} 不在配置 seeds 中`);
    process.exit(1);
  }

  const seedDir = path.join(path.resolve(inputDir), `seed-${seed}`);
  const failures = [];
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    if (!ok) failures.push(`${name}: ${detail === undefined ? '未通过' : detail}`);
  };

  // ---- 读取落盘文件（绝不加载模型/缓存）----
  const targetsFile = path.join(seedDir, 'targets.json');
  const predsFile = path.join(seedDir, 'predictions.jsonl');
  const resultsFile = path.join(seedDir, 'results.json');
  const curvesFile = path.join(seedDir, 'training-curves.json');
  for (const f of [targetsFile, predsFile]) {
    if (!fs.existsSync(f)) {
      console.error(`缺少 ${f}——审计只针对已落盘预测，缺失即失败（补训须显式运行 train 阶段）。`);
      process.exit(1);
    }
  }
  const targetsDoc = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
  const lines = fs.readFileSync(predsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const keys = Object.keys(exp.MODE_KEYS);
  const targetsSha = 'sha256:' + sha256File(targetsFile);
  const predsSha = 'sha256:' + sha256File(predsFile);

  // ---- 1. 文件哈希与 results.json 引用核对 ----
  let resultsDoc = null;
  let resultsSha = null;
  const emptyResults = fs.existsSync(resultsFile) ? fs.statSync(resultsFile).size === 0 : true;
  if (!emptyResults) {
    resultsSha = 'sha256:' + sha256File(resultsFile);
    resultsDoc = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    check('results.predictionsSha256 与实际文件一致',
      resultsDoc.files && resultsDoc.files.predictionsSha256 === predsSha,
      `记录 ${resultsDoc.files && resultsDoc.files.predictionsSha256}`);
    check('results.targetsSha256 与实际文件一致',
      resultsDoc.files && resultsDoc.files.targetsSha256 === targetsSha,
      `记录 ${resultsDoc.files && resultsDoc.files.targetsSha256}`);
    check('training-curves.json 存在且非空', fs.existsSync(curvesFile) && fs.statSync(curvesFile).size > 2);
    check('results.seed 与审计种子一致', resultsDoc.seed === seed, String(resultsDoc.seed));
    check('results.protocolVersion 一致', resultsDoc.protocolVersion === config.protocolVersion, resultsDoc.protocolVersion);
    check('results.configSha256 与冻结配置一致',
      resultsDoc.configSha256 === 'sha256:' + sha256Hex(Buffer.from(JSON.stringify(config))),
      resultsDoc.configSha256);
  } else {
    failures.push('results.json 不存在或为空——审计要求结果文件与预测同时落盘');
  }

  // ---- 2. 目标清单与预测逐行核对 ----
  check('目标身份唯一', new Set(targetsDoc.targets.map((t) => t.targetKey)).size === targetsDoc.targets.length);
  check('predictions 行数 == 目标数', lines.length === targetsDoc.targets.length,
    `${lines.length} vs ${targetsDoc.targets.length}`);
  const rowsByModel = {};
  for (const k of keys) rowsByModel[k] = [];
  let rowErrors = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = targetsDoc.targets[i];
    const l = lines[i];
    if (l.targetKey !== t.targetKey || l.userId !== t.userId || l.kpCode !== t.kpCode ||
        l.createdAt !== t.createdAt || l.target !== t.target) { rowErrors++; continue; }
    for (const k of keys) {
      const p = l.preds && l.preds[k];
      if (!Number.isFinite(p) || p < 0 || p > 1) { rowErrors++; break; }
      rowsByModel[k].push({ targetKey: t.targetKey, userId: t.userId, kpCode: t.kpCode, createdAt: t.createdAt, target: t.target, pred: p });
    }
  }
  check('逐行身份/标签一致且五组预测合法', rowErrors === 0, `${rowErrors} 行异常`);
  const uniqueStudents = new Set(targetsDoc.targets.map((t) => t.userId)).size;

  // ---- 3. 独立重算：指标 / 校准 / bootstrap（含未舍入 CI）----
  const recomputed = {};
  const recomputedCalibration = {};
  for (const k of keys) {
    recomputed[k] = evaluateMetrics(rowsByModel[k]);
    recomputedCalibration[k] = calibrationBins(rowsByModel[k]);
  }
  const boot = bootstrapAllModels(rowsByModel, { reps: config.evaluation.bootstrapReps, seed });
  // 审计侧独立重建四项比较（不调用 comparisonRows，保证实现独立；再与导出纯函数交叉核对）
  const recomputedComparisons = ['Full-DKT', 'RandomGraph-DKT', 'SelfLoop-DKT', 'Larger-DKT'].map((other) => {
    const c = boot.comparisons.find((x) => (x.a === 'GCN-DKT' && x.b === other) || (x.a === other && x.b === 'GCN-DKT'));
    if (!c) throw new Error(`bootstrap 未生成 GCN-DKT vs ${other}`);
    const sign = c.a === 'GCN-DKT' ? 1 : -1;
    const flip = (ci) => (sign > 0 ? ci.slice() : [-ci[1], -ci[0]]);
    const dAUC = sign * c.dAUC.pointDiff;
    const dLogLoss = sign * c.dLogLoss.pointDiff;
    const aucCi = flip(c.dAUC.ciPrecise || c.dAUC.ci);
    const llCi = flip(c.dLogLoss.ciPrecise || c.dLogLoss.ci);
    const flags = localFlags(dAUC, aucCi, dLogLoss, llCi);
    return {
      comparison: `GCN-DKT − ${other}`,
      dAUC, dAUCCI: flags.ciAvailable ? aucCi : null,
      dLogLoss, dLogLossCI: flags.ciAvailable ? llCi : null,
      ...flags,
      dAUCValidDraws: c.dAUC.validDraws,
      dLogLossValidDraws: c.dLogLoss.validDraws,
      units: boot.students
    };
  });

  // ---- 4. 与 results.json 逐项比对 ----
  if (resultsDoc) {
    for (const k of keys) {
      for (const m of ['AUC', 'LogLoss', 'Brier', 'Accuracy']) {
        const a = recomputed[k][m], b = resultsDoc.results && resultsDoc.results[k] && resultsDoc.results[k][m];
        check(`results.results.${k}.${m} 与重算一致`, a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9, `重算 ${a} vs 记录 ${b}`);
      }
      check(`results.results.${k}.n == 目标数`,
        resultsDoc.results && resultsDoc.results[k] && resultsDoc.results[k].n === targetsDoc.targets.length,
        String(resultsDoc.results && resultsDoc.results[k] && resultsDoc.results[k].n));

      // 校准分箱
      const recBins = resultsDoc.calibration && resultsDoc.calibration[k];
      const reBins = recomputedCalibration[k];
      let binsOk = Array.isArray(recBins) && recBins.length === reBins.length;
      const binDiffs = [];
      if (binsOk) {
        for (let i = 0; i < reBins.length; i++) {
          const a = reBins[i], b = recBins[i];
          if (a.n !== b.n) { binDiffs.push(`bin${i}.n ${a.n} vs ${b.n}`); binsOk = false; }
          for (const f of ['meanPredicted', 'observedRate']) {
            if (a[f] === null && b[f] === null) continue;
            if (a[f] === null || b[f] === null || Math.abs(a[f] - b[f]) > 1e-9) {
              binDiffs.push(`bin${i}.${f} ${a[f]} vs ${b[f]}`); binsOk = false;
            }
          }
          if (a.range !== b.range) { binDiffs.push(`bin${i}.range`); binsOk = false; }
        }
      }
      check(`results.calibration.${k} 与重算一致`, binsOk, binDiffs.slice(0, 3).join('; ') || '分箱逐项一致');
    }

    // bootstrap 有效抽样数与逐模型 CI
    const rb = resultsDoc.bootstrap;
    check('results.bootstrap.reps == 冻结配置', rb && rb.reps === config.evaluation.bootstrapReps, `记录 ${rb && rb.reps}`);
    check('results.bootstrap.units == test 学生数', rb && rb.units === uniqueStudents, `记录 ${rb && rb.units} vs ${uniqueStudents}`);
    for (const k of keys) {
      const rec = rb && rb.ci && rb.ci[k];
      check(`results.bootstrap.ci.${k} 存在`, !!rec);
      if (!rec) continue;
      check(`results.bootstrap.ci.${k}.draws == reps`, rec.draws === config.evaluation.bootstrapReps, `记录 ${rec.draws}`);
      const recPrecise = rec.precise || null;
      for (const m of ['AUC', 'LogLoss', 'Brier', 'Accuracy']) {
        const reCi = boot.ciByModel[k].precise[m];
        if (recPrecise) {
          check(`results.bootstrap.ci.${k}.${m}（未舍入）与重算一致`, ciEqual(recPrecise[m], reCi),
            `重算 [${reCi.join(', ')}] vs 记录 [${(recPrecise[m] || []).join(', ')}]`);
        } else {
          check(`results.bootstrap.ci.${k}.${m}（4 位）与重算一致`,
            ciEqual(rec[m], boot.ciByModel[k][m], 1e-9), `记录 [${(rec[m] || []).join(', ')}]（缺少未舍入 CI）`);
        }
      }
    }

    // 四项比较：点差 / 未舍入 CI / 4 位 CI / 标志 / 有效抽样数
    const recComps = (rb && Array.isArray(rb.comparisons)) ? rb.comparisons : [];
    for (const rc of recomputedComparisons) {
      const rec = recComps.find((c) => c.comparison === rc.comparison);
      check(`results.bootstrap.${rc.comparison} 存在`, !!rec);
      if (!rec) continue;
      check(`results.bootstrap.${rc.comparison}.dAUC 与重算一致`, Math.abs(rec.dAUC - rc.dAUC) <= 1e-12,
        `重算 ${rc.dAUC} vs 记录 ${rec.dAUC}`);
      check(`results.bootstrap.${rc.comparison}.dLogLoss 与重算一致`, Math.abs(rec.dLogLoss - rc.dLogLoss) <= 1e-12,
        `重算 ${rc.dLogLoss} vs 记录 ${rec.dLogLoss}`);
      check(`results.bootstrap.${rc.comparison}.ciAvailable 与重算一致`, rec.ciAvailable === rc.ciAvailable,
        `记录 ${rec.ciAvailable}`);
      if (rc.ciAvailable) {
        check(`results.bootstrap.${rc.comparison}.dAUCCI（未舍入）与重算一致`, ciEqual(rec.dAUCCI, rc.dAUCCI),
          `重算 [${rc.dAUCCI.join(', ')}] vs 记录 [${(rec.dAUCCI || []).join(', ')}]`);
        check(`results.bootstrap.${rc.comparison}.dLogLossCI（未舍入）与重算一致`, ciEqual(rec.dLogLossCI, rc.dLogLossCI),
          `重算 [${rc.dLogLossCI.join(', ')}] vs 记录 [${(rec.dLogLossCI || []).join(', ')}]`);
      } else {
        check(`results.bootstrap.${rc.comparison}.CI 不可用时应为 null`,
          rec.dAUCCI === null && rec.dLogLossCI === null,
          `记录 ${JSON.stringify(rec.dAUCCI)} / ${JSON.stringify(rec.dLogLossCI)}`);
      }
      // 4 位展示 CI 必须等于未舍入值舍入结果（防止展示值与原始值脱节）
      if (rc.ciAvailable && Array.isArray(rec.dAUCCI4)) {
        const expectAuc4 = rc.dAUCCI.map((v) => Number(v.toFixed(4)));
        const expectLl4 = rc.dLogLossCI.map((v) => Number(v.toFixed(4)));
        check(`results.bootstrap.${rc.comparison}.dAUCCI4 == round4(未舍入 CI)`, ciEqual(rec.dAUCCI4, expectAuc4, 1e-12),
          `记录 [${rec.dAUCCI4.join(', ')}] vs 期望 [${expectAuc4.join(', ')}]`);
        check(`results.bootstrap.${rc.comparison}.dLogLossCI4 == round4(未舍入 CI)`,
          ciEqual(rec.dLogLossCI4, expectLl4, 1e-12),
          `记录 [${(rec.dLogLossCI4 || []).join(', ')}] vs 期望 [${expectLl4.join(', ')}]`);
      }
      // 标志：与重算一致，且与「记录自身的原始 CI」自洽（抓矛盾标志）
      const recFlagsFromRecorded = localFlags(rec.dAUC, rec.dAUCCI, rec.dLogLoss, rec.dLogLossCI);
      for (const f of ['aucExcludesZero', 'aucCISupportsGCN', 'logLossExcludesZero', 'logLossCISupportsGCN']) {
        check(`results.bootstrap.${rc.comparison}.${f} 与记录 CI 自洽`, rec[f] === recFlagsFromRecorded[f],
          `记录 ${rec[f]} vs 由记录 CI 判定 ${recFlagsFromRecorded[f]}`);
        check(`results.bootstrap.${rc.comparison}.${f} 与重算一致`, rec[f] === rc[f],
          `记录 ${rec[f]} vs 重算 ${rc[f]}`);
      }
      // 交叉核对：审计独立标志实现 == 主实现导出的纯函数
      const shared = exp.comparisonFlags({ dAUC: rc.dAUC, dAUCCI: rc.dAUCCI, dLogLoss: rc.dLogLoss, dLogLossCI: rc.dLogLossCI });
      check(`results.bootstrap.${rc.comparison}.标志实现交叉一致（审计 vs 主实现）`,
        ['ciAvailable', 'aucExcludesZero', 'aucCISupportsGCN', 'logLossExcludesZero', 'logLossCISupportsGCN']
          .every((f) => shared[f] === localFlags(rc.dAUC, rc.dAUCCI, rc.dLogLoss, rc.dLogLossCI)[f]),
        '两套独立实现的标志判定不一致');
      // 有效抽样数
      check(`results.bootstrap.${rc.comparison}.dAUCValidDraws 与重算一致`, rec.dAUCValidDraws === rc.dAUCValidDraws,
        `记录 ${rec.dAUCValidDraws} vs 重算 ${rc.dAUCValidDraws}`);
      check(`results.bootstrap.${rc.comparison}.dLogLossValidDraws 与重算一致`, rec.dLogLossValidDraws === rc.dLogLossValidDraws,
        `记录 ${rec.dLogLossValidDraws} vs 重算 ${rc.dLogLossValidDraws}`);
      check(`results.bootstrap.${rc.comparison}.units 与重算一致`, rec.units === rc.units, `记录 ${rec.units} vs ${rc.units}`);
    }

    // ---- 5. 源码来源核验（统计实现哈希 vs 训练实现哈希）----
    const { sourceHashes: currentSourceHashes, implementationHash: currentImplementationHash } = exp.implementationHashOf
      ? exp.implementationHashOf(['dkt.js', 'graphDkt.js', 'graphDktExperiment.js', 'baselineEval.js', 'bootstrapStats.js'])
      : (() => { throw new Error('graphDktExperiment 未导出 implementationHashOf，无法核验源码来源'); })();
    const revision = resultsDoc.statisticsRevision || null;
    const trainingImpl = resultsDoc.implementationMetadata && resultsDoc.implementationMetadata.implementationHash;
    const recordedStatsImpl = revision ? revision.statisticsImplementationHash : trainingImpl;
    check('记录的统计实现哈希 == 当前源码 implementationHash', recordedStatsImpl === currentImplementationHash,
      `记录 ${recordedStatsImpl} vs 当前 ${currentImplementationHash}`);
    check('implementationMetadata.sourceHashes 含五个源文件',
      resultsDoc.implementationMetadata && resultsDoc.implementationMetadata.sourceHashes &&
      ['dkt.js', 'graphDkt.js', 'graphDktExperiment.js', 'baselineEval.js', 'bootstrapStats.js']
        .every((f) => typeof resultsDoc.implementationMetadata.sourceHashes[f] === 'string'));
    if (revision) {
      check('修订记录：确实未重训（noRetraining）', revision.noRetraining === true, String(revision.noRetraining));
      check('修订记录：预测未变（predictionsUnchanged）', revision.predictionsUnchanged === true, String(revision.predictionsUnchanged));
      check('修订记录：predictionsSha256 == 实际文件', revision.predictionsSha256 === predsSha, String(revision.predictionsSha256));
      check('修订记录：训练实现哈希被原样保留', revision.trainingImplementationHash === trainingImpl,
        `修订记录 ${revision.trainingImplementationHash} vs implementationMetadata ${trainingImpl}`);
      check('修订记录：previousStatisticsSha256 非空', typeof revision.previousStatisticsSha256 === 'string' && revision.previousStatisticsSha256.startsWith('sha256:'));
      check('修订记录：statisticsImplementationHash == 当前源码', revision.statisticsImplementationHash === currentImplementationHash);
    } else {
      check('无修订时训练实现哈希 == 当前源码', trainingImpl === currentImplementationHash,
        `记录 ${trainingImpl} vs 当前 ${currentImplementationHash}`);
    }

    check('bootstrap CI 规则标注为未舍入', !resultsDoc.bootstrap || !resultsDoc.bootstrap.ciRule || /未舍入/.test(resultsDoc.bootstrap.ciRule),
      resultsDoc.bootstrap && resultsDoc.bootstrap.ciRule);
  }

  // ---- 6. 图 manifest 邻接哈希独立重算（原始边 CSV → Anorm）----
  for (const [type, edgesFile, manifestFile] of [
    ['real', 'graph-real-edges.csv', 'graph-real-manifest.json'],
    ['random', 'graph-random-edges.csv', 'graph-random-manifest.json']
  ]) {
    const eFile = path.join(seedDir, edgesFile);
    const mFile = path.join(seedDir, manifestFile);
    if (!fs.existsSync(eFile) || !fs.existsSync(mFile)) {
      failures.push(`缺少图文件 ${edgesFile} / ${manifestFile}`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(mFile, 'utf8'));
    if ('sha256:' + sha256File(eFile) !== manifest.graphEdgesSha256) {
      failures.push(`${edgesFile} 哈希与 manifest 不一致`);
      continue;
    }
    // 从边 CSV 独立重建 Anorm（构图脚本同一实现），核验 adjacencySha256
    const csv = fs.readFileSync(eFile, 'utf8').trim().split('\n').slice(1);
    const nodesDoc = JSON.parse(fs.readFileSync(path.join(seedDir, 'graph-nodes.json'), 'utf8'));
    const nodeList = nodesDoc.nodes || [];
    const K = nodeList.length;
    const kpIndex = new Map(nodeList.map((n) => [n.kpCode, n.index]));
    const edges = csv.map((l) => {
      const [si, ti, sk, tk, sup] = l.split(',');
      const i = kpIndex.get(sk), j = kpIndex.get(tk);
      if (i === undefined || j === undefined) throw new Error(`${edgesFile}: 边端点不在节点表: ${sk}/${tk}`);
      return { i, j, w: Number(sup) };
    });
    const A = graphScript.symmetricNormalize(graphScript.adjacencyFromEdges(edges, K), K).Anorm;
    const actual = 'sha256:' + sha256Hex(Buffer.from(A.buffer));
    check(`${type} 图 Anorm 独立重建哈希 == manifest`, actual === manifest.adjacencySha256,
      `${actual.slice(0, 23)} vs ${manifest.adjacencySha256.slice(0, 23)}`);
    if (resultsDoc && resultsDoc.dataHashes) {
      const recorded = type === 'real' ? resultsDoc.dataHashes.realAdjacencySha256 : resultsDoc.dataHashes.randomAdjacencySha256;
      check(`results.dataHashes.${type}AdjacencySha256 一致`, recorded === manifest.adjacencySha256);
    }
  }

  const passed = failures.length === 0;
  const auditorSources = {};
  for (const [name, file] of [
    ['auditGraphDktResults.js', __filename],
    ['graphDktExperiment.js', path.join(__dirname, 'graphDktExperiment.js')],
    ['baselineEval.js', path.join(__dirname, 'baselineEval.js')],
    ['bootstrapStats.js', path.join(__dirname, 'bootstrapStats.js')]
  ]) {
    if (fs.existsSync(file)) auditorSources[name] = 'sha256:' + sha256File(file);
  }
  const report = {
    stage: 'E-audit',
    protocolVersion: config.protocolVersion,
    seed,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    auditorSha256: 'sha256:' + sha256Hex(fs.readFileSync(__filename)),
    auditorSources,
    inputs: {
      targetsSha256: targetsSha,
      predictionsSha256: predsSha,
      resultsSha256: resultsSha,
      trainingCurvesSha256: fs.existsSync(curvesFile) ? 'sha256:' + sha256File(curvesFile) : null,
      targetsCount: targetsDoc.targets.length,
      targetManifestHash: targetsDoc.targetManifestHash,
      uniqueStudents,
      resultsPresent: !!resultsDoc
    },
    bootstrapRecomputed: true,
    recomputeBootstrapFlag,
    checksTotal: checks.length,
    checksPassed: checks.filter((c) => c.ok).length,
    checks,
    failures,
    recomputedMetrics: recomputed,
    recomputedCalibration,
    recomputedComparisons,
    implementation: {
      currentImplementationHash: null, // 下方填充
      statisticsImplementationHash: null,
      trainingImplementationHash: resultsDoc && resultsDoc.implementationMetadata ? resultsDoc.implementationMetadata.implementationHash : null,
      revisionPresent: !!(resultsDoc && resultsDoc.statisticsRevision)
    },
    passed,
    note: '审计不加载训练 checkpoint 与任何模型；指标/校准/CI/标志/有效抽样数全部从落盘 predictions.jsonl 与 targets.json 独立重算，并绑定 results.json 哈希供聚合器校验。'
  };
  // 填充 implementation 细节（放在 try 中，避免隐藏异常）
  try {
    const { implementationHash } = exp.implementationHashOf(['dkt.js', 'graphDkt.js', 'graphDktExperiment.js', 'baselineEval.js', 'bootstrapStats.js']);
    report.implementation.currentImplementationHash = implementationHash;
    report.implementation.statisticsImplementationHash = resultsDoc
      ? (resultsDoc.statisticsRevision ? resultsDoc.statisticsRevision.statisticsImplementationHash : (resultsDoc.implementationMetadata || {}).implementationHash)
      : null;
  } catch (e) {
    report.implementation.error = e.message;
  }
  const reportFile = path.join(seedDir, 'audit-report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  log(`审计完成（seed ${seed}）：checks ${report.checksPassed}/${report.checksTotal}，passed=${passed}`);
  log(`审计报告已写入 ${reportFile}`);
  if (!passed) {
    log('失败项：\n  - ' + failures.slice(0, 40).join('\n  - '));
    if (failures.length > 40) log(`  … 其余 ${failures.length - 40} 项略`);
    process.exit(1);
  }
}

main();
