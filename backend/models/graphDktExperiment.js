/**
 * graphDktExperiment.js —— 图增强 DKT 五组对照实验入口（分阶段）
 *
 * 当前实现：
 *   - --stage smoke：阶段 C 冒烟（限定 seed 42、仅 train/validation，非正式）；
 *   - --stage train：阶段 D 正式训练（逐种子五组，逐目标预测落盘 + 缓存指纹 +
 *     Full 基线复现核对 + results.json 统计与配对 CI）；
 *   - --stage evaluate：只读 predictions.jsonl / targets.json 重算指标与 CI（不补训）。
 *
 * 独立审计见 auditGraphDktResults.js，五种子聚合见 aggregateGraphDktSeeds.js。
 *
 * 用法：
 *   node models/graphDktExperiment.js --stage smoke \
 *     --config 实验结果文件/gcn-dkt-v1/experiment-config.json \
 *     --prepared-dir 实验结果文件/gcn-dkt-v1/seed-42 \
 *     --interactions backend/datasets/assist2009/interactions.csv \
 *     --raw backend/datasets/raw/skill_builder_data.csv \
 *     --out 实验结果文件/gcn-dkt-v1 \
 *     [--epochs 3] [--models full,gcn,random-graph,larger,selfloop] [--skip-full-reference]
 *
 *   node models/graphDktExperiment.js --stage train --seed 42 \
 *     --config 实验结果文件/gcn-dkt-v1/experiment-config.json \
 *     --prepared-dir 实验结果文件/gcn-dkt-v1/seed-42 \
 *     --interactions datasets/assist2009/interactions.csv \
 *     --raw datasets/raw/skill_builder_data.csv \
 *     --out 实验结果文件/gcn-dkt-v1 \
 *     [--models Full-DKT] [--full-reference 实验结果文件/ablation-checkpoint-dkt-ablation-s42.json]
 *
 *   node models/graphDktExperiment.js --stage evaluate --seed 42 \
 *     --config 实验结果文件/gcn-dkt-v1/experiment-config.json \
 *     --input-dir 实验结果文件/gcn-dkt-v1
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
const dkt = resolveModule([
  path.join(__dirname, 'dkt.js'),
  path.join(repoRoot, 'model', 'dkt.js')
]);
const graphDkt = resolveModule([
  path.join(__dirname, 'graphDkt.js'),
  path.join(repoRoot, 'model', 'graphDkt.js')
]);
const { GruDkt, buildStudentSequences, buildVocab, collectPredictions } = dkt;
const { GraphDkt, GRAPH_MODES } = graphDkt;
const baselineEval = resolveModule([
  path.join(__dirname, 'baselineEval.js'),
  path.join(repoRoot, 'model', 'baselineEval.js')
]);
const { evaluateMetrics, calibrationBins, bootstrapAllModels } = baselineEval;

const PROTOCOL_VERSION = 'assist2009-gcn-dkt-v1';
const SMOKE_SEED = 42; // 阶段 C 只放行 seed 42
const MODE_KEYS = {
  'Full-DKT': 'full',
  'GCN-DKT': 'gcn',
  'RandomGraph-DKT': 'random-graph',
  'Larger-DKT': 'larger',
  'SelfLoop-DKT': 'selfloop'
};

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256Hex(fs.readFileSync(p));
const canonicalJson = (o) => JSON.stringify(o);

const log = (s) => process.stdout.write(s + '\n');

// ---------- 配置校验：拒绝未知字段与缺失必填项 ----------
const CONFIG_WHITELIST = {
  protocolVersion: 'string',
  schemaVersion: 'number',
  seeds: 'array',
  models: 'array',
  graph: ['source', 'weight', 'minSupport', 'normalization', 'selfLoopWeight', 'randomization', 'randomRetryLimit'],
  model: ['embedDim', 'hiddenSize', 'largerHiddenSize', 'graphLayers', 'graphHiddenDim', 'graphResidualScale', 'graphBranchDropout', 'dropout', 'residualFormula'],
  training: ['learningRate', 'adamBetas', 'adamEpsilon', 'weightDecay', 'batchSize', 'maxEpochs', 'patience', 'minImprovement', 'gradClipNorm', 'bceEps', 'gradientReduction'],
  evaluation: ['bootstrapReps', 'confidenceLevel', 'predictionDecimals', 'primaryMetric', 'comparisons', 'minimumMeanAucGainVsFull', 'maximumMeanLogLossIncreaseVsFull', 'selectionRule'],
  data: ['rawFile', 'rawSha256', 'taskFile', 'taskSha256', 'records', 'students', 'knowledgePoints', 'vocabRule', 'split', 'targetRule'],
  frozenBeforeTestRun: 'boolean',
  frozenAt: 'string',
  notes: 'array'
};

function validateConfig(raw) {
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!CONFIG_WHITELIST[key]) errors.push(`未知顶层字段: ${key}`);
  }
  for (const key of ['protocolVersion', 'schemaVersion', 'seeds', 'models', 'graph', 'model', 'training', 'evaluation', 'data']) {
    if (!(key in raw)) errors.push(`缺少必填字段: ${key}`);
  }
  if (raw.protocolVersion !== PROTOCOL_VERSION) {
    errors.push(`protocolVersion 应为 ${PROTOCOL_VERSION}，收到 ${raw.protocolVersion}`);
  }
  if (raw.schemaVersion !== 1) {
    errors.push(`schemaVersion 应为 1，收到 ${raw.schemaVersion}`);
  }
  if (raw.frozenBeforeTestRun !== true) {
    errors.push(`配置必须冻结于正式 test 运行前（frozenBeforeTestRun 应为 true），收到 ${raw.frozenBeforeTestRun}`);
  }
  if (typeof raw.frozenAt !== 'string' || !raw.frozenAt.trim()) {
    errors.push(`frozenAt 必须为非空字符串，收到 ${JSON.stringify(raw.frozenAt)}`);
  }
  if (!Array.isArray(raw.notes) || raw.notes.some((n) => typeof n !== 'string')) {
    errors.push('notes 必须为字符串数组');
  }
  // 类型校验：数组、数值类型与范围——无效或未实现的设置必须拒绝，不得静默忽略
  if (!Array.isArray(raw.seeds)) {
    errors.push(`seeds 必须为数组，收到 ${typeof raw.seeds}`);
  } else {
    if (raw.seeds.some((s) => typeof s !== 'number' || !Number.isInteger(s))) {
      errors.push('seeds 必须为整数数组');
    }
    if (JSON.stringify(raw.seeds) !== JSON.stringify([42, 43, 44, 45, 46])) {
      errors.push(`seeds 应为 [42, 43, 44, 45, 46]（阶段 C 冒烟要求 seeds[0] === ${SMOKE_SEED}），收到 ${JSON.stringify(raw.seeds)}`);
    }
  }
  if (!Array.isArray(raw.models)) {
    errors.push(`models 必须为数组，收到 ${typeof raw.models}`);
  } else if (JSON.stringify(raw.models) !== JSON.stringify(Object.keys(MODE_KEYS))) {
    errors.push(`models 应为五组 ${Object.keys(MODE_KEYS).join('/')}`);
  }
  const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  const isPosNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const g = raw.graph || {};
  if (g.selfLoopWeight !== 1) errors.push(`当前实现单位自环 selfLoopWeight 固定为 1，收到 ${g.selfLoopWeight}`);
  const mv = raw.model || {};
  for (const [k, v] of Object.entries(mv)) {
    if (['embedDim', 'hiddenSize', 'largerHiddenSize', 'graphHiddenDim'].includes(k) && !isPosInt(v)) {
      errors.push(`model.${k} 必须为正整数，收到 ${JSON.stringify(v)}`);
    }
  }
  if (typeof mv.dropout !== 'number' || !Number.isFinite(mv.dropout) || mv.dropout < 0 || mv.dropout >= 1) {
    errors.push(`model.dropout 必须为 [0,1) 的数值，收到 ${JSON.stringify(mv.dropout)}`);
  }
  const t = raw.training || {};
  if (!isPosNum(t.learningRate)) errors.push(`training.learningRate 必须为正数，收到 ${JSON.stringify(t.learningRate)}`);
  if (!isPosInt(t.batchSize)) errors.push(`training.batchSize 必须为正整数，收到 ${JSON.stringify(t.batchSize)}`);
  if (!isPosInt(t.maxEpochs)) errors.push(`training.maxEpochs 必须为正整数，收到 ${JSON.stringify(t.maxEpochs)}`);
  if (!isPosInt(t.patience)) errors.push(`training.patience 必须为正整数，收到 ${JSON.stringify(t.patience)}`);
  if (!isPosNum(t.gradClipNorm)) errors.push(`training.gradClipNorm 必须为正数，收到 ${JSON.stringify(t.gradClipNorm)}`);
  const ev = raw.evaluation || {};
  if (!isPosInt(ev.bootstrapReps)) errors.push(`evaluation.bootstrapReps 必须为正整数，收到 ${JSON.stringify(ev.bootstrapReps)}`);
  if (typeof ev.confidenceLevel !== 'number' || !Number.isFinite(ev.confidenceLevel) || ev.confidenceLevel <= 0 || ev.confidenceLevel >= 1) {
    errors.push(`evaluation.confidenceLevel 必须为 (0,1) 的数值，收到 ${JSON.stringify(ev.confidenceLevel)}`);
  }
  if (!isPosInt(ev.predictionDecimals)) errors.push(`evaluation.predictionDecimals 必须为正整数，收到 ${JSON.stringify(ev.predictionDecimals)}`);
  if (ev.primaryMetric !== 'AUC') errors.push(`evaluation.primaryMetric 应为 AUC，收到 ${ev.primaryMetric}`);
  if (!isPosNum(ev.minimumMeanAucGainVsFull)) errors.push(`evaluation.minimumMeanAucGainVsFull 必须为正数，收到 ${JSON.stringify(ev.minimumMeanAucGainVsFull)}`);
  if (!isPosNum(ev.maximumMeanLogLossIncreaseVsFull)) errors.push(`evaluation.maximumMeanLogLossIncreaseVsFull 必须为正数，收到 ${JSON.stringify(ev.maximumMeanLogLossIncreaseVsFull)}`);
  const dv = raw.data || {};
  for (const k of ['rawSha256', 'taskSha256']) {
    if (typeof dv[k] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(dv[k])) {
      errors.push(`data.${k} 必须为 sha256:<64位十六进制>，收到 ${JSON.stringify(dv[k])}`);
    }
  }
  for (const k of ['records', 'students', 'knowledgePoints']) {
    if (!isPosInt(dv[k])) errors.push(`data.${k} 必须为正整数，收到 ${JSON.stringify(dv[k])}`);
  }
  for (const section of ['graph', 'model', 'training', 'evaluation', 'data']) {
    const allowed = CONFIG_WHITELIST[section];
    if (!Array.isArray(allowed)) continue;
    for (const key of Object.keys(raw[section] || {})) {
      if (!allowed.includes(key)) errors.push(`${section} 中存在未知字段: ${key}`);
    }
    for (const key of allowed) {
      if (!(key in (raw[section] || {}))) errors.push(`${section} 缺少必填字段: ${key}`);
    }
  }
  // 实现约束（与 dkt.js / graphDkt.js 当前实现一致；如实现升级须同步更新此处与测试）
  if (mv.graphLayers !== 2) errors.push(`当前实现 graphLayers 固定为 2，收到 ${mv.graphLayers}`);
  if (mv.graphHiddenDim !== mv.embedDim) errors.push(`当前实现 graphHiddenDim 必须等于 embedDim（${mv.graphHiddenDim} vs ${mv.embedDim}）`);
  if (mv.graphResidualScale !== 1) errors.push(`当前实现 graphResidualScale 固定为 1，收到 ${mv.graphResidualScale}`);
  if (mv.graphBranchDropout !== 0) errors.push(`当前实现无独立图分支 dropout（graphBranchDropout 应为 0），收到 ${mv.graphBranchDropout}`);
  if (t.minImprovement !== 0.00001) errors.push(`当前实现早停改进阈值固定为 1e-5，收到 ${t.minImprovement}`);
  if (!String(t.gradientReduction).startsWith('legacy-summed-target-gradients')) errors.push(`gradientReduction 应为 legacy-summed-target-gradients，收到 ${t.gradientReduction}`);
  if (!Array.isArray(t.adamBetas) || t.adamBetas[0] !== 0.9 || t.adamBetas[1] !== 0.999) errors.push(`adamBetas 应为 [0.9, 0.999]（dkt.js adamUpdate 硬编码），收到 ${JSON.stringify(t.adamBetas)}`);
  if (t.adamEpsilon !== 1e-8) errors.push(`adamEpsilon 应为 1e-8（dkt.js adamUpdate 硬编码，当前实现不接受该配置），收到 ${JSON.stringify(t.adamEpsilon)}`);
  if (t.bceEps !== 1e-7) errors.push(`bceEps 应为 1e-7（dkt.js 默认值，冒烟入口不透传该配置），收到 ${JSON.stringify(t.bceEps)}`);
  if (t.weightDecay !== 0) errors.push(`当前实现无 weight decay（weightDecay 应为 0），收到 ${JSON.stringify(t.weightDecay)}`);
  if (errors.length) throw new Error('配置校验失败：\n  - ' + errors.join('\n  - '));
  return raw;
}

// ---------- 阶段 A 冻结产物加载与哈希校验 ----------
function loadPrepared(preparedDir, { expectedSeed = SMOKE_SEED } = {}) {
  const dir = path.resolve(preparedDir);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const realManifest = read('graph-real-manifest.json');
  const randomManifest = read('graph-random-manifest.json');
  const selfManifest = read('graph-selfloop-manifest.json');
  const split = read('split.json');
  const vocabOut = read('vocabulary.json');

  // split / vocabulary：与构图脚本相同的紧凑序列化哈希
  const splitSha = 'sha256:' + sha256Hex(Buffer.from(canonicalJson(split)));
  if (splitSha !== realManifest.splitSha256) {
    throw new Error(`split.json 哈希不一致: ${splitSha} vs manifest ${realManifest.splitSha256}`);
  }
  const vocabSha = 'sha256:' + sha256Hex(Buffer.from(canonicalJson(vocabOut)));
  if (vocabSha !== realManifest.vocabularySha256) {
    throw new Error(`vocabulary.json 哈希不一致: ${vocabSha} vs manifest ${realManifest.vocabularySha256}`);
  }
  if (split.splitSeed !== expectedSeed) throw new Error(`冻结划分种子应为 ${expectedSeed}，收到 ${split.splitSeed}`);

  const readText = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  const realCsv = readText('graph-real-edges.csv');
  const randomCsv = readText('graph-random-edges.csv');
  if ('sha256:' + sha256Hex(Buffer.from(realCsv)) !== realManifest.graphEdgesSha256) {
    throw new Error('graph-real-edges.csv 哈希与 manifest 不一致');
  }
  if ('sha256:' + sha256Hex(Buffer.from(randomCsv)) !== randomManifest.graphEdgesSha256) {
    throw new Error('graph-random-edges.csv 哈希与 manifest 不一致');
  }
  const parseEdges = (csv) => csv.trim().split('\n').slice(1).map((line) => {
    // 列结构：sourceIndex,targetIndex,sourceKp,targetKp,support
    const [, , sk, tk, sup] = line.split(',');
    return { s: sk, t: tk, w: Number(sup) };
  });

  return {
    dir,
    split,
    vocabOut,
    realManifest,
    randomManifest,
    selfManifest,
    realEdges: parseEdges(realCsv),
    randomEdges: parseEdges(randomCsv),
    realCsv,
    randomCsv
  };
}

function edgesToIndices(edgeList, kpIndex) {
  return edgeList.map((e) => {
    const i = kpIndex.get(e.s);
    const j = kpIndex.get(e.t);
    if (i === undefined || j === undefined) throw new Error(`边端点不在词表: ${e.s} / ${e.t}`);
    return { i, j, w: e.w };
  });
}

// ---------- 参数摘要 / 有限性 / 内存采样 ----------
function paramDigest(model) {
  const h = crypto.createHash('sha256');
  for (const key of Object.keys(model.params).sort()) {
    h.update(Buffer.from(model.params[key].buffer));
  }
  return h.digest('hex');
}

function paramsFinite(model) {
  for (const key of Object.keys(model.params)) {
    for (const v of model.params[key]) {
      if (!Number.isFinite(v)) return { ok: false, param: key };
    }
  }
  return { ok: true };
}

// ---------- 数值监控模型：逐 batch 梯度/参数有限性 + batch 边界内存采样 ----------
// fit() 为同步计算，setInterval 定时回调在训练期间不会执行（采样次数为 0），
// 因此内存改为在 adamUpdate（每 batch 一次）边界主动采样，记录为「采样峰值」。
class MonitoredGraphDkt extends GraphDkt {
  constructor(vocab, hyper) {
    super(vocab, hyper);
    this._monitor = {
      gradientBatchesChecked: 0,
      gradientFinite: true,
      paramUpdatesChecked: 0,
      paramsFiniteAfterUpdate: true,
      memorySamples: 0,
      rssPeakSampledBytes: 0,
      heapPeakSampledBytes: 0,
      failure: null
    };
  }

  /** 逐元素检查全部梯度张量有限性；stageLabel 用于区分裁剪前/裁剪后（测试可独立触发裁剪后分支） */
  _checkGradsFinite(stageLabel) {
    for (const key of Object.keys(this.grads)) {
      const g = this.grads[key];
      for (let i = 0; i < g.length; i++) {
        if (!Number.isFinite(g[i])) {
          this._monitor.gradientFinite = false;
          this._monitor.failure = `${stageLabel}梯度非有限（${key}[${i}]）`;
          throw new Error(`数值监控：${this._monitor.failure}，停止冒烟`);
        }
      }
    }
  }

  clipGrad(maxNorm) {
    // ① 裁剪前逐元素检查：Infinity/NaN 在此拦截。
    //    （仅靠裁剪后检查不够：见 ② 的范数溢出路径。）
    this._checkGradsFinite('裁剪前');
    const norm = super.clipGrad(maxNorm);
    // ② 原始范数检查：逐元素有限（如 1e200）时平方求和仍可溢出为 Infinity，
    //    父类会用 scale = maxNorm/Infinity = 0 把梯度静默清零——裁剪后全 0 有限，
    //    若不在此拦截即构成漏报。父类返回裁剪前范数，恰好可查。
    if (!Number.isFinite(norm)) {
      this._monitor.gradientFinite = false;
      this._monitor.failure = `梯度范数非有限（${norm}）：逐元素有限但平方求和溢出，裁剪已将梯度整体缩放为 0`;
      throw new Error(`数值监控：${this._monitor.failure}，停止冒烟`);
    }
    // ③ 裁剪后逐元素检查（防御性不变量；正常路径下不可达，见测试）
    this._checkGradsFinite('裁剪后');
    this._monitor.gradientBatchesChecked++;
    return norm;
  }

  adamUpdate(lr) {
    const mem = process.memoryUsage();
    if (mem.rss > this._monitor.rssPeakSampledBytes) this._monitor.rssPeakSampledBytes = mem.rss;
    if (mem.heapUsed > this._monitor.heapPeakSampledBytes) this._monitor.heapPeakSampledBytes = mem.heapUsed;
    this._monitor.memorySamples++;
    super.adamUpdate(lr);
    for (const key of Object.keys(this.params)) {
      const p = this.params[key];
      for (let i = 0; i < p.length; i++) {
        if (!Number.isFinite(p[i])) {
          this._monitor.paramsFiniteAfterUpdate = false;
          this._monitor.failure = `Adam 更新后参数非有限（${key}[${i}]）`;
          throw new Error(`数值监控：${this._monitor.failure}，停止冒烟`);
        }
      }
    }
    this._monitor.paramUpdatesChecked++;
  }
}

// ---------- 冒烟主流程 ----------
/**
 * @param opts { config, records, prepared, outDir, epochs, models, fullReference, log }
 *   records: interactions 任务文件的记录（与构图脚本同解析），[{userId, questionId, kpCode, isCorrect, createdAt}]
 *   prepared: loadPrepared() 的返回
 */
function runSmoke(opts) {
  const {
    config, records, prepared, outDir,
    epochs = 3,
    models: requestedModels,
    fullReference = true,
    log: emit = log
  } = opts;
  const models = requestedModels || Object.keys(MODE_KEYS);
  if (Math.floor(epochs) !== epochs || epochs < 1) throw new Error(`epochs 必须为正整数，收到 ${epochs}`);
  for (const key of models) {
    if (!MODE_KEYS[key]) throw new Error(`未知模型名: ${key}（可选：${Object.keys(MODE_KEYS).join(', ')}）`);
  }

  // ---- 数据链路复现（与构图脚本完全一致）----
  const sequences = buildStudentSequences(records);
  const byUser = new Map();
  for (const s of sequences) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }
  const vocab = buildVocab(sequences, { inputMode: 'full' });
  if (JSON.stringify(vocab.kpList) !== JSON.stringify(prepared.vocabOut.kpList)) {
    throw new Error('重建词表与阶段 A 冻结词表不一致');
  }
  if (vocab.kpList.length !== vocab.numSkills || vocab.vocabSize !== 2 * vocab.numSkills) {
    throw new Error('词表结构不合法（vocabSize 应为 2×numSkills）');
  }

  const split = prepared.split;
  const pick = (ids) => {
    const out = [];
    for (const id of ids) {
      const list = byUser.get(id);
      if (!list) throw new Error(`划分中的学生不在重建序列中: ${id}`);
      out.push(...list);
    }
    return out;
  };
  const trainSeqs = pick(split.train);
  const valSeqs = pick(split.validation);
  const testUserSet = new Set(split.test);
  // 冒烟隔离断言：train/validation 序列绝不包含 test 学生
  for (const s of [...trainSeqs, ...valSeqs]) {
    if (testUserSet.has(s.userId)) throw new Error(`test 学生 ${s.userId} 出现在 train/validation 序列中`);
  }
  emit(`序列: train ${trainSeqs.length} / validation ${valSeqs.length}（test ${split.test.length} 名学生全程未使用）`);
  emit(`词表: K=${vocab.numSkills}，vocabSize=${vocab.vocabSize}（与阶段 A 冻结词表一致）`);

  // ---- 超参（冻结配置 + 冒烟 epoch 上限）----
  const baseHyper = {
    embedDim: config.model.embedDim,
    hiddenSize: config.model.hiddenSize,
    dropout: config.model.dropout,
    learningRate: config.training.learningRate,
    batchSize: config.training.batchSize,
    maxEpochs: epochs,
    earlyStoppingPatience: config.training.patience,
    gradClipNorm: config.training.gradClipNorm,
    seed: SMOKE_SEED
  };

  const hyperFor = (mode) => {
    const hp = { ...baseHyper };
    if (mode === 'larger') hp.hiddenSize = config.model.largerHiddenSize;
    return hp;
  };

  const makeModel = (mode) => {
    const hp = hyperFor(mode);
    if (mode === 'full' || mode === 'larger' || mode === 'selfloop') {
      return new MonitoredGraphDkt(vocab, { ...hp, modelMode: mode });
    }
    const edgeList = mode === 'gcn'
      ? edgesToIndices(prepared.realEdges, vocab.kpIndex)
      : edgesToIndices(prepared.randomEdges, vocab.kpIndex);
    const rawAdj = graphDkt.rawAdjacencyFromEdges(edgeList, vocab.numSkills);
    return new MonitoredGraphDkt(vocab, { ...hp, modelMode: mode, adjacency: rawAdj });
  };
  const hpEmbed = () => config.model.embedDim;
  const hpHidden = (mode) => (mode === 'larger' ? config.model.largerHiddenSize : config.model.hiddenSize);

  // 模型内部邻接与阶段 A manifest 哈希一致（图组必查）
  function verifyAdjacency(model, mode) {
    if (mode !== 'gcn' && mode !== 'random-graph' && mode !== 'selfloop') return null;
    const manifest = mode === 'gcn' ? prepared.realManifest
      : mode === 'random-graph' ? prepared.randomManifest
        : prepared.selfManifest;
    const actual = 'sha256:' + sha256Hex(Buffer.from(model.A.buffer));
    if (actual !== manifest.adjacencySha256) {
      throw new Error(`${mode}: 模型内部 Anorm 哈希与 manifest 不一致: ${actual} vs ${manifest.adjacencySha256}`);
    }
    return actual;
  }

  // ---- 第 2 步：Full 与原 GruDkt 同入口行为一致性 ----
  let fullReferenceResult = null;
  const trainedCache = new Map(); // Full 一致性核对的结果直接复用进五组结果
  if (fullReference && models.includes('Full-DKT')) {
    emit('\n===== Full 一致性核对：GraphDkt(full) vs 原 GruDkt（同入口/同数据/同种子） =====');
    const refModel = new GruDkt(vocab, hyperFor('full'));
    const t0 = Date.now();
    const refFit = refModel.fit(trainSeqs, valSeqs, {
      onEpoch: (c) => emit(`  [GruDkt 基准] epoch ${c.epoch}: train ${c.trainLogLoss} / val ${c.valLogLoss}`)
    });
    const refSeconds = (Date.now() - t0) / 1000;
    const refVal = refModel.meanLogLoss(valSeqs).logLoss;

    const t1 = Date.now();
    const entryFit = smokeTrain('Full-DKT', { emit });
    const entrySeconds = entryFit.fitSeconds;
    const entryVal = entryFit.valLogLossAfterRollback;

    const curveIdentical = canonicalJson(refFit.curve) === canonicalJson(entryFit.fit.curve);
    const paramsIdentical = paramDigest(refModel) === entryFit.paramDigest;
    const valLogLossEqual = refVal.toFixed(6) === entryVal.toFixed(6);
    fullReferenceResult = {
      gruFitSeconds: Number(refSeconds.toFixed(1)),
      entryFitSeconds: Number(entrySeconds.toFixed(1)),
      curveIdentical,
      paramsIdentical,
      gruValLogLoss: Number(refVal.toFixed(6)),
      graphDktValLogLoss: Number(entryVal.toFixed(6)),
      valLogLossEqual
    };
    emit(`  曲线逐位一致: ${curveIdentical}；最终参数摘要一致: ${paramsIdentical}；回滚后 val LogLoss 一致: ${valLogLossEqual}`);
    if (!curveIdentical || !paramsIdentical || !valLogLossEqual) {
      throw new Error('GraphDkt(full) 与原 GruDkt 行为不一致，停止冒烟。');
    }
    trainedCache.set('Full-DKT', entryFit);
  }

  // ---- 单模型冒烟训练 + 有限性/内存/早停记录 ----
  function smokeTrain(modelKey, { emit: emit2 }) {
    const mode = MODE_KEYS[modelKey];
    emit2(`\n===== ${modelKey}（modelMode=${mode}，epochs≤${epochs}） =====`);
    const model = makeModel(mode);
    emit2(`  参数量 ${model.paramCount()}（embed ${hpEmbed()} / hidden ${hpHidden(mode)}）`);
    const adjSha = verifyAdjacency(model, mode);
    if (adjSha) emit2(`  模型内部 Anorm 哈希 = manifest ✓ (${adjSha.slice(7, 23)}…)`);

    let epochCurveChecks = 0;
    const t0 = Date.now();
    const fit = model.fit(trainSeqs, valSeqs, {
      onEpoch: (c) => {
        // 每轮训练/验证 loss 有限性断言（防止非有限值静默进入曲线与早停逻辑）
        if (!Number.isFinite(c.trainLogLoss) || !Number.isFinite(c.valLogLoss)) {
          throw new Error(`数值监控：epoch ${c.epoch} 曲线 loss 非有限（train ${c.trainLogLoss} / val ${c.valLogLoss}），停止冒烟`);
        }
        epochCurveChecks++;
        emit2(`  epoch ${c.epoch}: train ${c.trainLogLoss} / val ${c.valLogLoss}${c.stoppedEarly ? '（早停）' : ''}`);
      }
    });
    const fitSeconds = (Date.now() - t0) / 1000;

    // 回滚校验：fit 后参数应为验证集最优 → val LogLoss 应等于 bestValLogLoss
    const valAfter = model.meanLogLoss(valSeqs).logLoss;
    const rollbackConsistent = valAfter.toFixed(6) === fit.bestValLogLoss.toFixed(6);

    const fin = paramsFinite(model);
    const valPreds = collectPredictions(model, valSeqs, { targetIds: null });
    let predsFinite = true;
    for (const p of valPreds.values()) {
      if (!Number.isFinite(p) || p < 0 || p > 1) { predsFinite = false; break; }
    }
    const mon = model._monitor;
    const numericalChecks = {
      epochCurveChecks,
      gradientBatchesChecked: mon.gradientBatchesChecked,
      gradientFinite: mon.gradientFinite,
      paramUpdatesChecked: mon.paramUpdatesChecked,
      paramsFiniteAfterUpdate: mon.paramsFiniteAfterUpdate
    };

    const supervision = (seqs) => seqs.reduce((s, q) => s + Math.max(0, q.items.length - 1), 0);
    return {
      mode,
      description: MODEL_DESCRIPTIONS[mode],
      paramCount: model.paramCount(),
      sequenceCounts: { train: trainSeqs.length, validation: valSeqs.length },
      supervisionCounts: { train: supervision(trainSeqs), validation: supervision(valSeqs) },
      training: {
        maxEpochsSmoke: epochs,
        epochsRun: fit.epochsRun,
        bestEpoch: fit.bestEpoch,
        bestValLogLoss: fit.bestValLogLoss,
        stoppedEarly: fit.stoppedEarly,
        curve: fit.curve
      },
      fitSeconds: Number(fitSeconds.toFixed(1)),
      memory: {
        sampledAt: 'adamUpdate batch 边界主动采样（fit 为同步计算，定时器回调训练期间不可执行；此为采样峰值，非进程级连续监测峰值）',
        memorySamples: mon.memorySamples,
        rssPeakSampledBytes: mon.rssPeakSampledBytes,
        heapPeakSampledBytes: mon.heapPeakSampledBytes
      },
      numericalChecks,
      valLogLossAfterRollback: Number(valAfter.toFixed(6)),
      rollbackConsistent,
      paramsFinite: fin.ok,
      paramsFiniteFailure: fin.ok ? null : fin.param,
      valPredictions: { count: valPreds.size, allFinite: predsFinite },
      paramDigest: paramDigest(model),
      fit
    };
  }

  // ---- 第 3 步：五组（或指定子集）冒烟 ----
  const modelResults = {};
  for (const key of models) {
    const r = trainedCache.get(key) || smokeTrain(key, { emit });
    if (!r.paramsFinite) throw new Error(`${key}: 参数存在非有限值（${r.paramsFiniteFailure}），停止冒烟。`);
    if (!r.valPredictions.allFinite) throw new Error(`${key}: 验证预测存在非有限值，停止冒烟。`);
    if (!r.rollbackConsistent) throw new Error(`${key}: 早停回滚后 val LogLoss 与 bestValLogLoss 不一致，停止冒烟。`);
    emit(`  → val LogLoss ${r.training.bestValLogLoss}（epoch ${r.training.bestEpoch}/${r.training.epochsRun}，耗时 ${r.fitSeconds}s，batch 边界采样 RSS 峰值 ${(r.memory.rssPeakSampledBytes / 1048576).toFixed(0)}MB）`);
    modelResults[key] = r;
  }

  // ---- 汇总 ----
  const finiteness = aggregateFiniteness(modelResults);
  if (!finiteness.passed) {
    throw new Error('冒烟数值汇总检查未通过：\n  - ' + finiteness.failures.join('\n  - '));
  }
  // 源码组合哈希与逐源码哈希：写入结果对象（落盘前），把结果绑定到实际运行版本
  const sourceFiles = ['dkt.js', 'graphDkt.js', 'graphDktExperiment.js'];
  const sourceHashes = Object.fromEntries(sourceFiles.map((f) => [f, 'sha256:' + sha256Hex(fs.readFileSync(path.join(__dirname, f)))]));
  const implementationHash = 'sha256:' + sha256Hex(Buffer.from(sourceFiles.map((f) => sourceHashes[f]).join('')));
  const configSha256 = 'sha256:' + sha256Hex(Buffer.from(canonicalJson(config)));

  // 早停披露：仅当实际触发了早停才可声称「早停已验证」
  const anyEarlyStop = Object.values(modelResults).some((r) => r.training.stoppedEarly);
  const earlyStopDisclosure = anyEarlyStop
    ? '本轮冒烟至少一组实际触发早停（见各模型 training.stoppedEarly / bestEpoch）。'
    : `本轮冒烟 epochs≤${epochs}，五组均未实际触发早停（stoppedEarly=false）；不构成真实数据早停验证，回滚路径由 M11（图缓存失效/最优参数回滚）单元测试保证。`;

  const results = {
    smoke: true,
    purpose: '阶段 C 冒烟：数值/内存/耗时/早停检查——非正式结果，不得用于论文数字、test 指标或架构选择',
    protocolVersion: PROTOCOL_VERSION,
    stage: 'C-smoke',
    seed: SMOKE_SEED,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    dataIsolation: {
      testStudents: split.test.length,
      testUsage: '未读取：test 学生序列未参与训练、验证、早停与任何评估（冒烟仅 train/validation）',
      architectureSelection: '禁止：本轮不读取正式 test 指标，不据冒烟结果选择架构'
    },
    earlyStopDisclosure,
    dataHashes: {
      rawSha256: config.data.rawSha256,
      taskSha256: config.data.taskSha256,
      splitSha256: prepared.realManifest.splitSha256,
      vocabularySha256: prepared.realManifest.vocabularySha256,
      realEdgesSha256: prepared.realManifest.graphEdgesSha256,
      realAdjacencySha256: prepared.realManifest.adjacencySha256,
      randomEdgesSha256: prepared.randomManifest.graphEdgesSha256,
      randomAdjacencySha256: prepared.randomManifest.adjacencySha256,
      selfloopAdjacencySha256: prepared.selfManifest.adjacencySha256
    },
    implementationMetadata: {
      implementationHash,
      sourceHashes,
      configSha256,
      note: 'implementationHash = 三个源文件 sha256 串接后再哈希；configSha256 = 冻结配置紧凑序列化哈希。结果绑定到实际运行版本。'
    },
    config,
    hyperUsed: { ...baseHyper, smokeEpochCap: epochs, largerHiddenSize: config.model.largerHiddenSize },
    vocabulary: { nodeCount: vocab.numSkills, vocabSize: vocab.vocabSize, rule: prepared.vocabOut.vocabRule },
    sequenceCounts: { train: trainSeqs.length, validation: valSeqs.length },
    fullReferenceConsistency: fullReferenceResult,
    models: modelResults,
    finitenessSummary: finiteness,
    allFiniteChecksPassed: finiteness.passed
  };
  return results;
}

/**
 * 汇总有限性检查（纯函数，供测试直接注入异常用例）：
 * 覆盖最终参数、验证预测、回滚一致性、每轮曲线 loss、梯度与更新后参数检查计数。
 * 注入 trainLogLoss=NaN 之类异常必须使 passed=false（不得漏报成功）。
 */
function aggregateFiniteness(modelResults) {
  const failures = [];
  for (const [key, r] of Object.entries(modelResults)) {
    if (!r.paramsFinite) failures.push(`${key}: 最终参数存在非有限值（${r.paramsFiniteFailure}）`);
    if (!r.valPredictions || !r.valPredictions.allFinite) failures.push(`${key}: 验证预测存在非有限值`);
    if (!r.rollbackConsistent) failures.push(`${key}: 回滚后 val LogLoss 与 bestValLogLoss 不一致`);
    const nc = r.numericalChecks || {};
    if (!nc.gradientFinite) failures.push(`${key}: 梯度检查失败（${(r.monitor && r.monitor.failure) || '非有限梯度'}）`);
    if (!nc.paramsFiniteAfterUpdate) failures.push(`${key}: Adam 更新后参数存在非有限值`);
    if (!(nc.gradientBatchesChecked > 0)) failures.push(`${key}: 梯度有限性检查计数为 0（监控未生效）`);
    if (!(nc.paramUpdatesChecked > 0)) failures.push(`${key}: 参数更新后检查计数为 0（监控未生效）`);
    if (!(nc.epochCurveChecks > 0)) failures.push(`${key}: 训练曲线逐轮检查计数为 0`);
    if (Array.isArray(r.training && r.training.curve)) {
      for (const c of r.training.curve) {
        if (!Number.isFinite(c.trainLogLoss) || !Number.isFinite(c.valLogLoss)) {
          failures.push(`${key}: 训练曲线 epoch ${c.epoch} loss 非有限（train ${c.trainLogLoss} / val ${c.valLogLoss}）`);
        }
      }
    }
    if (r.memory && !(r.memory.memorySamples > 0)) failures.push(`${key}: 内存采样次数为 0（采样未生效）`);
  }
  return { passed: failures.length === 0, failures };
}

// ---------- 阶段 D：正式训练 / 评估 ----------
// 目标清单：与 dktEval / 消融 v2 同一规则——test 学生中 (学生,知识点) 组非首条记录；
// 目标身份 = userId|ts（相对时间轴），目标 KP = 原始 kpCode（只决定输出端口与目标身份）。
function buildTargetManifest(sequences, split) {
  const testSet = new Set(split.test);
  const targets = [];
  for (const seq of sequences) {
    if (!testSet.has(seq.userId)) continue;
    const firstTs = new Map();
    for (const it of seq.items) {
      if (!firstTs.has(it.kpCode) || it.ts < firstTs.get(it.kpCode)) firstTs.set(it.kpCode, it.ts);
    }
    for (const it of seq.items) {
      if (it.ts <= firstTs.get(it.kpCode)) continue;
      targets.push({ targetKey: `${seq.userId}|${it.ts}`, userId: seq.userId, kpCode: it.kpCode, createdAt: it.record.createdAt, target: it.correct });
    }
  }
  const ids = new Set(targets.map((t) => t.targetKey));
  if (ids.size !== targets.length) throw new Error('目标身份存在重复（userId|ts 不唯一），拒绝生成目标清单');
  const targetManifestHash = 'sha256:' + sha256Hex(Buffer.from(JSON.stringify(
    targets.map((t) => [t.targetKey, t.userId, t.kpCode, t.createdAt, t.target])
  )));
  return { targets, targetManifestHash };
}

// 目标逐行核对：身份（targetKey/userId/kpCode/createdAt）、标签、预测合法性
function assertRowsMatchTargets(rows, targets, modelKey) {
  if (!Array.isArray(rows) || rows.length !== targets.length) {
    throw new Error(`${modelKey}: 目标数量不匹配（${Array.isArray(rows) ? rows.length : '非数组'} vs ${targets.length}）`);
  }
  for (let i = 0; i < targets.length; i++) {
    const r = rows[i], t = targets[i];
    if (!r || r.targetKey !== t.targetKey || r.userId !== t.userId || r.kpCode !== t.kpCode ||
        r.createdAt !== t.createdAt || r.target !== t.target ||
        !Number.isFinite(r.pred) || r.pred < 0 || r.pred > 1) {
      throw new Error(`${modelKey}: 第 ${i} 行目标身份、标签或预测不合法`);
    }
  }
}

// 训练缓存指纹（E08）：协议 + 模型键/结构 + 全部训练超参 + 数据/词表/划分/目标哈希 +
// 实际使用图的邻接哈希 + 构图规则 + 种子 + 数值约定 + 实现组合哈希。
// 统计配置（bootstrap 次数等）不进训练指纹——逐目标预测通过校验后可单独重算统计。
function trainFingerprint({ modelKey, mode, config, hyper, dataHashes, adjacencySha256, implementationHash, seed }) {
  return 'sha256:' + sha256Hex(Buffer.from(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    stage: 'D-train',
    modelKey,
    mode,
    seed,
    structure: {
      embedDim: config.model.embedDim,
      hiddenSize: mode === 'larger' ? config.model.largerHiddenSize : config.model.hiddenSize,
      graphLayers: config.model.graphLayers,
      graphHiddenDim: config.model.graphHiddenDim,
      graphResidualScale: config.model.graphResidualScale,
      graphBranchDropout: config.model.graphBranchDropout,
      dropout: config.model.dropout
    },
    hyper,
    dataHashes,
    adjacencySha256: adjacencySha256 || null,
    graph: {
      minSupport: config.graph.minSupport,
      normalization: config.graph.normalization,
      selfLoopWeight: config.graph.selfLoopWeight,
      randomization: config.graph.randomization
    },
    numeric: {
      gradientReduction: config.training.gradientReduction,
      bceEps: config.training.bceEps,
      adamBetas: config.training.adamBetas,
      adamEpsilon: config.training.adamEpsilon,
      weightDecay: config.training.weightDecay,
      predictionDecimals: config.evaluation.predictionDecimals
    },
    implementationHash
  })));
}

function formalHyperFor(config, seed, overrides = {}) {
  return {
    embedDim: config.model.embedDim,
    hiddenSize: config.model.hiddenSize,
    dropout: config.model.dropout,
    learningRate: config.training.learningRate,
    batchSize: config.training.batchSize,
    maxEpochs: config.training.maxEpochs,
    earlyStoppingPatience: config.training.patience,
    gradClipNorm: config.training.gradClipNorm,
    seed,
    ...overrides // 仅测试/验收用（可控触发早停）；正式流程必须传空，指纹随实际值变化
  };
}

function implementationHashOf(fileNames) {
  const sourceHashes = Object.fromEntries(fileNames.map((f) => [f, 'sha256:' + sha256Hex(fs.readFileSync(path.join(__dirname, f)))]));
  const implementationHash = 'sha256:' + sha256Hex(Buffer.from(fileNames.map((f) => sourceHashes[f]).join('')));
  return { sourceHashes, implementationHash };
}

function envMetadata() {
  let gitCommit = null;
  try {
    gitCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..', '..') }).toString().trim();
  } catch (e) { /* 非 git 环境忽略 */ }
  return { nodeVersion: process.version, platform: `${process.platform} ${process.arch}`, gitCommit };
}

function readCache(cacheFile) {
  try {
    const cp = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cp.protocolVersion !== PROTOCOL_VERSION || cp.stage !== 'D-train') return {};
    return cp.entries || {};
  } catch (e) {
    return {};
  }
}

function writeCache(cacheFile, seed, entries) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = cacheFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    stage: 'D-train',
    seed,
    savedAt: new Date().toISOString(),
    entries
  }, null, 2));
  fs.renameSync(tmp, cacheFile);
}

/**
 * 阶段 D 单种子正式训练。
 * @param opts { config, records, prepared, seed, outDir, models, fullReferenceFile, hyperOverrides, log }
 * 返回 { complete, trained, reused, missing, baselineReproduction }
 */
function runTrainSeed(opts) {
  const {
    config, records, prepared, seed, outDir,
    models: requestedModels,
    fullReferenceFile = null,
    hyperOverrides = {},
    log: emit = log
  } = opts;
  const models = requestedModels && requestedModels.length ? requestedModels : Object.keys(MODE_KEYS);
  for (const key of models) {
    if (!MODE_KEYS[key]) throw new Error(`未知模型名: ${key}（可选：${Object.keys(MODE_KEYS).join(', ')}）`);
  }
  if (!config.seeds.includes(seed)) {
    throw new Error(`--seed ${seed} 不在冻结配置 seeds ${JSON.stringify(config.seeds)} 中，拒绝训练`);
  }
  if (Object.keys(hyperOverrides).length && !opts.allowHyperOverrides) {
    throw new Error('hyperOverrides 仅限测试/小数据验收使用（须同时传 allowHyperOverrides: true）');
  }

  // ---- 数据链路复现（与构图脚本/冒烟完全一致）----
  const sequences = buildStudentSequences(records);
  const byUser = new Map();
  for (const s of sequences) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }
  const vocab = buildVocab(sequences, { inputMode: 'full' });
  if (JSON.stringify(vocab.kpList) !== JSON.stringify(prepared.vocabOut.kpList)) {
    throw new Error('重建词表与阶段 A 冻结词表不一致');
  }
  // 划分同源性：splitStudents 重算必须与冻结 split 逐位一致
  const recomputedSplit = dkt.splitStudents(sequences.map((s) => s.userId), {
    train: 0.7, validation: 0.15, seed
  });
  if (canonicalJson(recomputedSplit.train) !== canonicalJson(prepared.split.train) ||
      canonicalJson(recomputedSplit.validation) !== canonicalJson(prepared.split.validation) ||
      canonicalJson(recomputedSplit.test) !== canonicalJson(prepared.split.test)) {
    throw new Error(`splitStudents 重算与冻结 split 不一致（seed ${seed}）`);
  }

  const split = prepared.split;
  const pick = (ids) => {
    const out = [];
    for (const id of ids) {
      const list = byUser.get(id);
      if (!list) throw new Error(`划分中的学生不在重建序列中: ${id}`);
      out.push(...list);
    }
    return out;
  };
  const trainSeqs = pick(split.train);
  const valSeqs = pick(split.validation);
  const testSeqs = pick(split.test);
  const testUserSet = new Set(split.test);
  for (const s of [...trainSeqs, ...valSeqs]) {
    if (testUserSet.has(s.userId)) throw new Error(`test 学生 ${s.userId} 出现在 train/validation 序列中`);
  }

  const { targets, targetManifestHash } = buildTargetManifest(sequences, split);
  const targetIds = new Set(targets.map((t) => t.targetKey));

  const dataHashes = {
    rawSha256: config.data.rawSha256,
    taskSha256: config.data.taskSha256,
    vocabularySha256: prepared.realManifest.vocabularySha256,
    splitSha256: prepared.realManifest.splitSha256,
    targetManifestHash
  };
  const adjacencyShaOf = (mode) => mode === 'gcn' ? prepared.realManifest.adjacencySha256
    : mode === 'random-graph' ? prepared.randomManifest.adjacencySha256
      : mode === 'selfloop' ? prepared.selfManifest.adjacencySha256 : null;

  const { sourceHashes, implementationHash } = implementationHashOf([
    'dkt.js', 'graphDkt.js', 'graphDktExperiment.js', 'baselineEval.js', 'bootstrapStats.js'
  ]);
  const configSha256 = 'sha256:' + sha256Hex(Buffer.from(canonicalJson(config)));

  const cacheFile = path.join(path.resolve(outDir), 'cache', `gcn-dkt-train-seed-${seed}.json`);
  const cacheEntries = readCache(cacheFile);
  const supervision = (seqs) => seqs.reduce((s, q) => s + Math.max(0, q.items.length - 1), 0);

  const trained = [];
  const reused = [];
  const rowsByModel = {};

  // 单模型训练指纹（点名训练与未点名缓存复用共用同一算法，避免两处漂移）
  const fingerprintFor = (modelKey) => {
    const mode = MODE_KEYS[modelKey];
    const hyper = formalHyperFor(config, seed, hyperOverrides);
    if (mode === 'larger') hyper.hiddenSize = config.model.largerHiddenSize;
    return trainFingerprint({
      modelKey, mode, config, hyper, dataHashes,
      adjacencySha256: adjacencyShaOf(mode),
      implementationHash, seed
    });
  };

  for (const modelKey of models) {
    const mode = MODE_KEYS[modelKey];
    const hyper = formalHyperFor(config, seed, hyperOverrides);
    if (mode === 'larger') hyper.hiddenSize = config.model.largerHiddenSize;
    const fingerprint = fingerprintFor(modelKey);

    const cached = cacheEntries[modelKey];
    if (cached && cached.fingerprint === fingerprint) {
      try {
        assertRowsMatchTargets(cached.rows, targets, modelKey);
        rowsByModel[modelKey] = cached.rows;
        cached.modelMeta.reusedFrom = 'cache';
        cached.modelMeta.fingerprint = fingerprint;
        reused.push(modelKey);
        emit(`\n===== ${modelKey}: 缓存指纹匹配，恢复已训练预测（${cached.rows.length} 条），跳过训练 =====`);
        continue;
      } catch (e) {
        emit(`\n===== ${modelKey}: 缓存行校验失败（${e.message}），重新训练 =====`);
      }
    } else if (cached) {
      emit(`\n===== ${modelKey}: 缓存指纹不匹配（协议/结构/超参/数据/图/实现已变化），拒绝旧缓存并重新训练 =====`);
    }

    emit(`\n===== ${modelKey}（modelMode=${mode}，maxEpochs=${hyper.maxEpochs}，patience=${hyper.earlyStoppingPatience}） =====`);
    const hp = { ...hyper };
    delete hp.earlyStoppingPatience;
    hp.earlyStoppingPatience = hyper.earlyStoppingPatience;
    let model;
    if (mode === 'full' || mode === 'larger' || mode === 'selfloop') {
      model = new MonitoredGraphDkt(vocab, { ...hp, modelMode: mode });
    } else {
      const edgeList = mode === 'gcn'
        ? edgesToIndices(prepared.realEdges, vocab.kpIndex)
        : edgesToIndices(prepared.randomEdges, vocab.kpIndex);
      const rawAdj = graphDkt.rawAdjacencyFromEdges(edgeList, vocab.numSkills);
      model = new MonitoredGraphDkt(vocab, { ...hp, modelMode: mode, adjacency: rawAdj });
    }
    emit(`  参数量 ${model.paramCount()}；test 学生 ${split.test.length} 名，目标 ${targets.length} 条（仅训练后用于逐目标预测）`);

    // 模型内部邻接与阶段 A manifest 哈希一致（图组必查）
    if (mode === 'gcn' || mode === 'random-graph' || mode === 'selfloop') {
      const actual = 'sha256:' + sha256Hex(Buffer.from(model.A.buffer));
      if (actual !== adjacencyShaOf(mode)) {
        throw new Error(`${modelKey}: 模型内部 Anorm 哈希与 manifest 不一致: ${actual}`);
      }
    }

    let epochCurveChecks = 0;
    const t0 = Date.now();
    const fit = model.fit(trainSeqs, valSeqs, {
      onEpoch: (c) => {
        if (!Number.isFinite(c.trainLogLoss) || !Number.isFinite(c.valLogLoss)) {
          throw new Error(`数值监控：epoch ${c.epoch} 曲线 loss 非有限（train ${c.trainLogLoss} / val ${c.valLogLoss}），停止训练`);
        }
        epochCurveChecks++;
        emit(`  epoch ${c.epoch}: train ${c.trainLogLoss} / val ${c.valLogLoss}${c.stoppedEarly ? '（早停）' : ''}`);
      }
    });
    const fitSeconds = (Date.now() - t0) / 1000;

    const valAfter = model.meanLogLoss(valSeqs).logLoss;
    const rollbackConsistent = valAfter.toFixed(6) === fit.bestValLogLoss.toFixed(6);

    const testPreds = collectPredictions(model, testSeqs, { targetIds });
    const missing = targets.filter((t) => !testPreds.has(t.targetKey));
    if (missing.length) {
      throw new Error(`${modelKey}: ${missing.length} 个目标没有预测（示例 ${missing[0].targetKey}），五组目标集必须一致，已中止。`);
    }
    const rows = targets.map((t) => ({
      targetKey: t.targetKey, userId: t.userId, kpCode: t.kpCode,
      createdAt: t.createdAt, target: t.target,
      pred: Number(testPreds.get(t.targetKey).toFixed(config.evaluation.predictionDecimals))
    }));
    assertRowsMatchTargets(rows, targets, modelKey);

    const fin = paramsFinite(model);
    if (!fin.ok) throw new Error(`${modelKey}: 最终参数存在非有限值（${fin.param}），停止训练`);
    const mon = model._monitor;
    if (!mon.gradientFinite) throw new Error(`${modelKey}: ${mon.failure || '梯度非有限'}`);
    if (!mon.paramsFiniteAfterUpdate) throw new Error(`${modelKey}: Adam 更新后参数非有限`);
    if (!(mon.gradientBatchesChecked > 0) || !(mon.paramUpdatesChecked > 0)) {
      throw new Error(`${modelKey}: 数值监控未生效（梯度/参数检查计数为 0）`);
    }

    rowsByModel[modelKey] = rows;
    cacheEntries[modelKey] = {
      fingerprint,
      trainedAt: new Date().toISOString(),
      rows,
      modelMeta: {
        modelKey,
        mode,
        description: MODEL_DESCRIPTIONS[mode],
        fingerprint,
        paramCount: model.paramCount(),
        sequenceCounts: { train: trainSeqs.length, validation: valSeqs.length, test: testSeqs.length },
        supervisionCounts: { train: supervision(trainSeqs), validation: supervision(valSeqs), test: targets.length },
        training: {
          epochsRun: fit.epochsRun,
          bestEpoch: fit.bestEpoch,
          bestValLogLoss: fit.bestValLogLoss,
          stoppedEarly: fit.stoppedEarly,
          fitSeconds: Number(fitSeconds.toFixed(1)),
          curve: fit.curve
        },
        valLogLossAfterRollback: Number(valAfter.toFixed(6)),
        rollbackConsistent,
        numericalChecks: {
          epochCurveChecks,
          gradientBatchesChecked: mon.gradientBatchesChecked,
          gradientFinite: mon.gradientFinite,
          paramUpdatesChecked: mon.paramUpdatesChecked,
          paramsFiniteAfterUpdate: mon.paramsFiniteAfterUpdate
        },
        memory: {
          sampledAt: 'adamUpdate batch 边界主动采样（此为采样峰值，非进程级连续监测峰值）',
          memorySamples: mon.memorySamples,
          rssPeakSampledBytes: mon.rssPeakSampledBytes,
          heapPeakSampledBytes: mon.heapPeakSampledBytes
        },
        paramDigest: paramDigest(model),
        adjacencySha256: adjacencyShaOf(mode),
        hyperUsed: { ...hyper }
      }
    };
    trained.push(modelKey);
    writeCache(cacheFile, seed, cacheEntries);
    emit(`  → val LogLoss ${fit.bestValLogLoss}（epoch ${fit.bestEpoch}/${fit.epochsRun}，耗时 ${fitSeconds.toFixed(1)}s）已写入缓存`);
  }

  // ---- 未点名但缓存有效的模型一并纳入 ----
  // 支持 `--models` 分批续训：点名批次若只看本批模型，五组永远凑不齐（完成判定恒 false）。
  // 未点名模型只有在指纹完全匹配、缓存行通过目标集校验时才纳入，否则保持缺失并如实提示。
  for (const modelKey of Object.keys(MODE_KEYS)) {
    if (rowsByModel[modelKey]) continue;
    const cached = cacheEntries[modelKey];
    if (!cached) continue;
    const fingerprint = fingerprintFor(modelKey);
    if (cached.fingerprint !== fingerprint) {
      emit(`\n===== ${modelKey}: 本批次未点名，缓存指纹不匹配（协议/结构/超参/数据/图/实现已变化），不纳入 =====`);
      continue;
    }
    try {
      assertRowsMatchTargets(cached.rows, targets, modelKey);
    } catch (e) {
      emit(`\n===== ${modelKey}: 本批次未点名，缓存行校验失败（${e.message}），不纳入 =====`);
      continue;
    }
    rowsByModel[modelKey] = cached.rows;
    cached.modelMeta.reusedFrom = 'cache';
    cached.modelMeta.fingerprint = fingerprint;
    reused.push(modelKey);
    emit(`\n===== ${modelKey}: 本批次未点名，缓存指纹匹配，直接复用（${cached.rows.length} 条） =====`);
  }

  // ---- Full 基线复现核对（可选）：与既有 Full 逐目标预测逐条比对 ----
  let baselineReproduction = null;
  if (fullReferenceFile && rowsByModel['Full-DKT']) {
    const ref = JSON.parse(fs.readFileSync(path.resolve(fullReferenceFile), 'utf8'));
    const refRows = (ref.rowsByModel && ref.rowsByModel['Full-DKT']) || null;
    if (!refRows) throw new Error('full-reference 文件中无 Full-DKT 逐目标预测');
    const refIndex = new Map(refRows.map((r) => [`${r.userId}|${r.createdAt}|${r.kpCode}|${r.target}`, r.pred]));
    let matched = 0, identical = 0;
    const mismatches = [];
    for (const r of rowsByModel['Full-DKT']) {
      const k = `${r.userId}|${r.createdAt}|${r.kpCode}|${r.target}`;
      if (!refIndex.has(k)) continue;
      matched++;
      if (refIndex.get(k) === r.pred) identical++;
      else if (mismatches.length < 5) mismatches.push({ targetKey: r.targetKey, ref: refIndex.get(k), got: r.pred });
    }
    baselineReproduction = {
      referenceFile: path.basename(fullReferenceFile),
      referenceRowCount: refRows.length,
      matchedTargets: matched,
      identicalPredictions: identical,
      allMatchedAndIdentical: matched === targets.length && identical === matched,
      sampleMismatches: mismatches,
      note: 'GraphDkt(full) 与原 GruDkt 同种子同数据逐位兼容（M02）；复现判定要求全部目标匹配且预测逐位一致。'
    };
    emit(`\nFull 基线复现：匹配 ${matched}/${targets.length}，逐位一致 ${identical}/${matched}`);
  }

  const missing = Object.keys(MODE_KEYS).filter((k) => !rowsByModel[k]);
  const complete = missing.length === 0;
  if (!complete) {
    emit(`\n尚缺模型：${missing.join(', ')}。缓存已保存，用相同命令重跑即可续训（或用 --models 只补缺失模型）。`);
    return { complete: false, trained, reused, missing, baselineReproduction, cacheFile };
  }

  // ---- 五组齐全：逐目标预测 / 目标清单 / 训练曲线 / results.json 落盘 ----
  const seedDir = path.join(path.resolve(outDir), `seed-${seed}`);
  fs.mkdirSync(seedDir, { recursive: true });
  const keys = Object.keys(MODE_KEYS);

  const targetsFile = path.join(seedDir, 'targets.json');
  fs.writeFileSync(targetsFile, JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    seed,
    targetRule: '目标 = test 学生中 (学生,知识点) 组非首条记录（与 dktEval / 消融 v2 同一规则）；目标身份 = userId|相对时间轴',
    targetCount: targets.length,
    targetManifestHash,
    targets
  }, null, 2));

  const predsFile = path.join(seedDir, 'predictions.jsonl');
  const predsLines = [];
  for (let i = 0; i < targets.length; i++) {
    const r0 = rowsByModel[keys[0]][i];
    predsLines.push(JSON.stringify({
      targetKey: r0.targetKey, userId: r0.userId, kpCode: r0.kpCode,
      createdAt: r0.createdAt, target: r0.target,
      preds: Object.fromEntries(keys.map((k) => [k, rowsByModel[k][i].pred]))
    }));
  }
  fs.writeFileSync(predsFile, predsLines.join('\n') + '\n');
  const predsSha256 = 'sha256:' + sha256File(predsFile);

  const curvesFile = path.join(seedDir, 'training-curves.json');
  fs.writeFileSync(curvesFile, JSON.stringify(Object.fromEntries(keys.map((k) => [k, cacheEntries[k].modelMeta.training.curve])), null, 2));

  // ---- 指标 + 学生级配对 bootstrap（重采样单位 = test 学生，同一批权重用于五组）----
  const results = {};
  const calibration = {};
  for (const k of keys) {
    results[k] = evaluateMetrics(rowsByModel[k]);
    calibration[k] = calibrationBins(rowsByModel[k]);
  }
  const boot = bootstrapAllModels(rowsByModel, {
    reps: config.evaluation.bootstrapReps, seed
  });
  // 四项重点比较：统一为 GCN − X 的点估计差（ΔAUC > 0 表示 GCN 更好；ΔLogLoss < 0 表示 GCN 更好）
  const comparisons = comparisonRows(boot);
  const modelMeta = Object.fromEntries(keys.map((k) => [k, cacheEntries[k].modelMeta]));
  const anyEarlyStop = keys.some((k) => modelMeta[k].training.stoppedEarly);
  const resultsOut = {
    smoke: false,
    stage: 'D-train',
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: 1,
    seed,
    generatedAt: new Date().toISOString(),
    ...envMetadata(),
    configSha256,
    dataHashes: {
      ...dataHashes,
      realEdgesSha256: prepared.realManifest.graphEdgesSha256,
      realAdjacencySha256: prepared.realManifest.adjacencySha256,
      randomEdgesSha256: prepared.randomManifest.graphEdgesSha256,
      randomAdjacencySha256: prepared.randomManifest.adjacencySha256,
      selfloopAdjacencySha256: prepared.selfManifest.adjacencySha256
    },
    sequenceCounts: { train: trainSeqs.length, validation: valSeqs.length, test: testSeqs.length },
    targetCount: targets.length,
    targetManifestHash,
    files: {
      targetsFile: 'targets.json',
      targetsSha256: 'sha256:' + sha256File(targetsFile),
      predictionsFile: 'predictions.jsonl',
      predictionsSha256: predsSha256,
      trainingCurvesFile: 'training-curves.json'
    },
    implementationMetadata: {
      implementationHash,
      sourceHashes,
      configSha256,
      note: 'implementationHash = 五个源文件 sha256 串接后再哈希；结果绑定到实际运行版本。'
    },
    hyperUsed: Object.fromEntries(keys.map((k) => [k, modelMeta[k].hyperUsed])),
    models: modelMeta,
    earlyStopDisclosure: anyEarlyStop
      ? '本轮至少一组实际触发早停（见各模型 training.stoppedEarly / bestEpoch）；回滚后 val LogLoss 已逐组核对。'
      : '本轮五组均未实际触发早停（stoppedEarly=false）；回滚路径由 M11 单元测试保证。',
    baselineReproduction,
    results,
    calibration,
    bootstrap: {
      reps: boot.reps,
      units: boot.students,
      unitRule: '学生级聚类 bootstrap（重采样单位 = test 学生），同一批权重用于五组 → 天然配对',
      ciRule: 'CI 存未舍入百分位（2.5/97.5）；方向/显著性标志由未舍入值判定（*CI4 仅作展示，不参与判定）',
      ci: boot.ciByModel,
      comparisons
    }
  };
  const resultsFile = path.join(seedDir, 'results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(resultsOut, null, 2));
  emit(`\n结果已写入 ${resultsFile}`);
  emit(`逐目标预测已写入 ${predsFile}（sha256 前 16 位 ${predsSha256.slice(7, 23)}）`);
  return { complete: true, trained, reused, missing: [], baselineReproduction, resultsFile, predsFile, predsSha256 };
}

/**
 * 阶段 D 评估：只读 predictions.jsonl / targets.json 重算指标与 CI，绝不触发训练。
 * 预测缺失时报错退出（补训须由用户显式运行 --stage train）。
 */
function runEvaluate(opts) {
  const { config, inputDir, seed, log: emit = log } = opts;
  const seedDir = path.join(path.resolve(inputDir), `seed-${seed}`);
  const targetsFile = path.join(seedDir, 'targets.json');
  const predsFile = path.join(seedDir, 'predictions.jsonl');
  if (!fs.existsSync(targetsFile) || !fs.existsSync(predsFile)) {
    throw new Error(`seed-${seed} 缺少 targets.json / predictions.jsonl——评估不触发补训，请先显式运行 --stage train`);
  }
  const targetsDoc = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
  const lines = fs.readFileSync(predsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const keys = Object.keys(MODE_KEYS);

  // 身份/标签逐行核对 + 五组预测齐全与合法性
  if (lines.length !== targetsDoc.targets.length) {
    throw new Error(`predictions 行数 ${lines.length} ≠ 目标数 ${targetsDoc.targets.length}`);
  }
  const rowsByModel = {};
  for (const k of keys) rowsByModel[k] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = targetsDoc.targets[i];
    if (line.targetKey !== t.targetKey || line.userId !== t.userId || line.kpCode !== t.kpCode ||
        line.createdAt !== t.createdAt || line.target !== t.target) {
      throw new Error(`第 ${i} 行目标身份/标签与 targets.json 不一致`);
    }
    for (const k of keys) {
      const p = line.preds && line.preds[k];
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(`第 ${i} 行 ${k} 预测不合法: ${JSON.stringify(p)}`);
      }
      rowsByModel[k].push({ ...t, pred: p });
    }
  }
  // 文件哈希与 results.json 引用核对（如存在）
  const resultsFile = path.join(seedDir, 'results.json');
  let resultsDoc = null;
  if (fs.existsSync(resultsFile)) {
    resultsDoc = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const actualPredsSha = 'sha256:' + sha256File(predsFile);
    if (resultsDoc.files && resultsDoc.files.predictionsSha256 !== actualPredsSha) {
      throw new Error(`predictions.jsonl 哈希与 results.json 引用不一致: ${actualPredsSha} vs ${resultsDoc.files.predictionsSha256}`);
    }
  }

  const results = {};
  const calibration = {};
  for (const k of keys) {
    results[k] = evaluateMetrics(rowsByModel[k]);
    calibration[k] = calibrationBins(rowsByModel[k]);
  }
  const boot = bootstrapAllModels(rowsByModel, { reps: config.evaluation.bootstrapReps, seed });
  const comparisons = comparisonRows(boot);
  // 与 results.json 记录比对（如存在）：指标必须一致（同数据同代码确定性重算）
  let consistency = null;
  if (resultsDoc) {
    const diffs = [];
    for (const k of keys) {
      for (const m of ['AUC', 'LogLoss', 'Brier']) {
        const a = results[k][m], b = resultsDoc.results[k][m];
        if (Math.abs(a - b) > 1e-9) diffs.push(`${k}.${m}: 重算 ${a} vs 记录 ${b}`);
      }
    }
    consistency = { metricsMatch: diffs.length === 0, diffs: diffs.slice(0, 10) };
  }
  const evalOut = {
    smoke: false,
    stage: 'D-evaluate',
    protocolVersion: PROTOCOL_VERSION,
    seed,
    generatedAt: new Date().toISOString(),
    ...envMetadata(),
    sourceFiles: {
      targetsSha256: 'sha256:' + sha256File(targetsFile),
      predictionsSha256: 'sha256:' + sha256File(predsFile)
    },
    targetCount: lines.length,
    results,
    calibration,
    bootstrap: { reps: boot.reps, units: boot.students, ci: boot.ciByModel, comparisons },
    resultsJsonConsistency: consistency,
    note: '仅从落盘 predictions.jsonl / targets.json 重算，未加载任何模型或训练 checkpoint。'
  };
  const evalFile = path.join(seedDir, 'eval.json');
  fs.writeFileSync(evalFile, JSON.stringify(evalOut, null, 2));
  emit(`评估完成（seed ${seed}，目标 ${lines.length} 条，未加载任何模型），写入 ${evalFile}`);
  for (const c of comparisons) {
    const ciText = c.ciAvailable ? `[${c.dAUCCI.map((v) => v.toFixed(6)).join(', ')}]` : '[CI 不可用]';
    emit(`  ${c.comparison.padEnd(26)} ΔAUC ${c.dAUC.toFixed(6)} ${ciText}  ΔLogLoss ${c.dLogLoss.toFixed(6)}`);
  }
  return evalOut;
}

// 四项重点比较行（runTrainSeed 与 runEvaluate 共用）：
// 点估计差不可用（AUC 单类或数据异常）→ 硬失败拒绝输出；
// bootstrap CI 非有限（极小样本重采样中出现单类样本）→ 如实标记 ciAvailable=false（正式数据不适用）。
/**
 * 由「未舍入 CI + 点估计差」判定方向/显著性标志（纯函数，审计与测试复用同一口径）。
 * 规则：ciAvailable 要求两侧四个端点全部有限；AUC 越大越好 → 下界 > 0 才算支持 GCN；
 * LogLoss 越小越好 → 上界 < 0 才算支持。必须以未舍入值判定：4 位舍入会把
 * 0.00004 变成 0，把「方向稳定为正」错判为「跨零」，并与 CI 自相矛盾。
 */
function comparisonFlags({ dAUC, dAUCCI, dLogLoss, dLogLossCI }) {
  const finitePair = (ci) => Array.isArray(ci) && ci.length === 2 &&
    ci[0] !== null && ci[1] !== null && Number.isFinite(ci[0]) && Number.isFinite(ci[1]);
  const ciAvailable = finitePair(dAUCCI) && finitePair(dLogLossCI);
  return {
    ciAvailable,
    aucExcludesZero: ciAvailable ? dAUCCI[0] * dAUCCI[1] > 0 : null,
    aucCISupportsGCN: ciAvailable ? dAUCCI[0] > 0 : null,
    logLossExcludesZero: ciAvailable ? dLogLossCI[0] * dLogLossCI[1] > 0 : null,
    logLossCISupportsGCN: ciAvailable ? dLogLossCI[1] < 0 : null,
    pointEstimateAvailable: Number.isFinite(dAUC) && Number.isFinite(dLogLoss)
  };
}

const round4 = (ci) => (Array.isArray(ci) && ci.every((v) => Number.isFinite(v))
  ? ci.map((v) => Number(v.toFixed(4)))
  : null);

function comparisonRows(boot) {
  const out = [];
  for (const other of ['Full-DKT', 'RandomGraph-DKT', 'SelfLoop-DKT', 'Larger-DKT']) {
    const c = boot.comparisons.find((x) => (x.a === 'GCN-DKT' && x.b === other) || (x.a === other && x.b === 'GCN-DKT'));
    if (!c) throw new Error(`bootstrap 未生成 GCN-DKT vs ${other} 比较`);
    const sign = c.a === 'GCN-DKT' ? 1 : -1;
    const flip = (ci) => (sign > 0 ? ci.slice() : [-ci[1], -ci[0]]);
    const dAUC = sign * c.dAUC.pointDiff;
    const dLogLoss = sign * c.dLogLoss.pointDiff;
    if (!Number.isFinite(dAUC) || !Number.isFinite(dLogLoss)) {
      throw new Error(`GCN-DKT vs ${other}: 点估计差不可用（AUC 单类不可定义或数据异常），拒绝输出`);
    }
    const aucCi = flip(c.dAUC.ciPrecise || c.dAUC.ci);
    const llCi = flip(c.dLogLoss.ciPrecise || c.dLogLoss.ci);
    const flags = comparisonFlags({ dAUC, dAUCCI: aucCi, dLogLoss, dLogLossCI: llCi });
    out.push({
      comparison: `GCN-DKT − ${other}`,
      dAUC,
      // 未舍入 CI（原始百分位）：方向标志由它判定；*CI4 仅供人读，不参与判定
      dAUCCI: flags.ciAvailable ? aucCi : null,
      dAUCCI4: flags.ciAvailable ? round4(aucCi) : null,
      dAUCBootstrapMean: sign * c.dAUC.bootstrapMeanDiff,
      dLogLoss,
      dLogLossCI: flags.ciAvailable ? llCi : null,
      dLogLossCI4: flags.ciAvailable ? round4(llCi) : null,
      dLogLossBootstrapMean: sign * c.dLogLoss.bootstrapMeanDiff,
      ...flags,
      dAUCValidDraws: c.dAUC.validDraws,
      dLogLossValidDraws: c.dLogLoss.validDraws,
      units: boot.students,
      ciRounding: 'raw（percentile 2.5/97.5，未舍入）',
      ciNote: flags.ciAvailable ? null : 'bootstrap 重采样中存在 AUC 不可定义（单类）样本，该小样本 CI 不可用；仅极小 fixture 会出现'
    });
  }
  return out;
}

const MODEL_DESCRIPTIONS = {
  full: 'Full-DKT：无图分支（残差分支参数清零）',
  gcn: 'GCN-DKT：train-only 真实共现图',
  'random-graph': 'RandomGraph-DKT：同边数同边权多重集随机图',
  larger: 'Larger-DKT：GRU hidden=68 容量对照',
  selfloop: 'SelfLoop-DKT：Anorm=I（仅逐节点编码器）'
};

// ---------- 结果落盘 ----------
function writeSmokeResults(results, outDir) {
  const dir = path.join(path.resolve(outDir), 'smoke-seed-42');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'smoke-results.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(results, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };
  return {
    stage: get('stage'),
    config: get('config'),
    preparedDir: get('prepared-dir'),
    interactions: get('interactions'),
    raw: get('raw'),
    out: get('out'),
    inputDir: get('input-dir'),
    epochs: get('epochs') ? Number(get('epochs')) : 3,
    models: get('models') ? String(get('models')).split(',').map((s) => s.trim()).filter(Boolean) : null,
    skipFullReference: argv.includes('--skip-full-reference'),
    fullReference: get('full-reference'),
    reason: get('reason'),
    seed: get('seed') ? Number(get('seed')) : SMOKE_SEED
  };
}

function loadInteractions(taskFile) {
  const csv = fs.readFileSync(path.resolve(taskFile), 'utf8').trim().split('\n');
  const ti = Object.fromEntries(csv[0].split(',').map((h, i) => [h, i]));
  const records = [];
  for (let r = 1; r < csv.length; r++) {
    const c = csv[r].split(',');
    records.push({
      userId: c[ti.userId], questionId: c[ti.questionId], kpCode: c[ti.kpCode],
      isCorrect: Number(c[ti.isCorrect]), createdAt: c[ti.createdAt]
    });
  }
  return records;
}

function verifyDataHashes(config, args) {
  const actualRaw = sha256File(args.raw);
  const actualTask = sha256File(args.interactions);
  if ('sha256:' + actualRaw !== config.data.rawSha256) throw new Error('raw 文件哈希与冻结配置不一致');
  if ('sha256:' + actualTask !== config.data.taskSha256) throw new Error('interactions 文件哈希与冻结配置不一致');
  log(`数据哈希校验通过：raw ${actualRaw.slice(0, 16)}… task ${actualTask.slice(0, 16)}…`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['smoke', 'train', 'evaluate', 'restat'].includes(args.stage)) {
    console.error(`未知阶段: ${args.stage}。可选 --stage smoke | train | evaluate | restat。`);
    process.exit(1);
  }
  for (const [k, v] of [['--config', args.config]]) {
    if (!v) { console.error(`缺少必填参数 ${k}`); process.exit(1); }
  }
  const config = validateConfig(JSON.parse(fs.readFileSync(path.resolve(args.config), 'utf8')));

  if (args.stage === 'smoke') {
    if (args.seed !== SMOKE_SEED) {
      console.error(`阶段 C 冒烟限定 seed ${SMOKE_SEED}，收到 --seed ${args.seed}。`);
      process.exit(1);
    }
    for (const [k, v] of [['--prepared-dir', args.preparedDir], ['--interactions', args.interactions], ['--raw', args.raw], ['--out', args.out]]) {
      if (!v) { console.error(`smoke 缺少必填参数 ${k}`); process.exit(1); }
    }
    verifyDataHashes(config, args);
    const prepared = loadPrepared(args.preparedDir);
    log(`阶段 A 冻结产物校验通过：${prepared.realManifest.nodeCount} 节点，真实边 ${prepared.realEdges.length}，随机边 ${prepared.randomEdges.length}`);
    const records = loadInteractions(args.interactions);
    log(`interactions 记录 ${records.length} 条`);
    const results = runSmoke({
      config, records, prepared, outDir: args.out, epochs: args.epochs,
      models: args.models, fullReference: !args.skipFullReference
    });
    const file = writeSmokeResults(results, args.out);
    log(`\n实现源码组合哈希（已写入结果文件 implementationMetadata）: ${results.implementationMetadata.implementationHash.slice(0, 23)}…`);
    log(`配置文件内容哈希（configSha256）: ${results.implementationMetadata.configSha256.slice(0, 23)}…`);
    log(`早停披露: ${results.earlyStopDisclosure}`);
    log(`冒烟结果已写入 ${file}`);
    log('冒烟完成：非正式结果，不得用于架构选择或正式报告。');
    return;
  }

  if (args.stage === 'train') {
    for (const [k, v] of [['--prepared-dir', args.preparedDir], ['--interactions', args.interactions], ['--raw', args.raw], ['--out', args.out]]) {
      if (!v) { console.error(`train 缺少必填参数 ${k}`); process.exit(1); }
    }
    verifyDataHashes(config, args);
    const prepared = loadPrepared(args.preparedDir, { expectedSeed: args.seed });
    log(`阶段 A 冻结产物校验通过（seed ${args.seed}）：${prepared.realManifest.nodeCount} 节点，真实边 ${prepared.realEdges.length}，随机边 ${prepared.randomEdges.length}`);
    const records = loadInteractions(args.interactions);
    log(`interactions 记录 ${records.length} 条`);
    const out = runTrainSeed({
      config, records, prepared, seed: args.seed, outDir: args.out,
      models: args.models, fullReferenceFile: args.fullReference
    });
    log(`\n训练阶段结束：新训练 ${out.trained.length ? out.trained.join(', ') : '无'}；缓存恢复 ${out.reused.length ? out.reused.join(', ') : '无'}`);
    if (out.complete) {
      log(`五组齐全，逐目标预测与结果已落盘（seed-${args.seed}）。`);
    } else {
      log(`尚缺模型：${out.missing.join(', ')}——重跑相同命令续训。`);
    }
    return;
  }

  if (args.stage === 'restat') {
    if (!args.inputDir) { console.error('restat 缺少必填参数 --input-dir'); process.exit(1); }
    if (!config.seeds.includes(args.seed)) { console.error(`--seed ${args.seed} 不在冻结配置中`); process.exit(1); }
    runRestat({ config, inputDir: args.inputDir, seed: args.seed, reason: args.reason || undefined });
    return;
  }

  // evaluate
  if (!args.inputDir) { console.error('evaluate 缺少必填参数 --input-dir'); process.exit(1); }
  runEvaluate({ config, inputDir: args.inputDir, seed: args.seed });
}

if (require.main === module) main();

/**
 * 阶段 D 统计修订（restat）：从既有 predictions.jsonl / targets.json 重算统计，
 * 只替换 results.json 的 statistics 分区（results / calibration / bootstrap），
 * 并写 statisticsRevision 留痕：
 *   - implementationMetadata（训练实现哈希 + 逐源哈希）原样保留为历史，绝不改写；
 *   - 统计实现哈希单独记录；
 *   - 缓存指纹、models 训练元数据、曲线、基线复现一律不动 → 不冒充新训练。
 * 预测哈希一旦与 results.json 记录不一致即拒绝（预测变了就该重训，不是统计修订）。
 */
function runRestat({ config, inputDir, seed, reason, log: emit = log }) {
  const seedDir = path.join(path.resolve(inputDir), `seed-${seed}`);
  const targetsFile = path.join(seedDir, 'targets.json');
  const predsFile = path.join(seedDir, 'predictions.jsonl');
  const resultsFile = path.join(seedDir, 'results.json');
  for (const [name, f] of [['targets.json', targetsFile], ['predictions.jsonl', predsFile], ['results.json', resultsFile]]) {
    if (!fs.existsSync(f)) throw new Error(`缺少 ${name}——统计修订要求训练已完整落盘（本阶段绝不训练）`);
  }
  const resultsDoc = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const targetsDoc = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
  const predsSha256 = 'sha256:' + sha256File(predsFile);
  if (resultsDoc.files && resultsDoc.files.predictionsSha256 && resultsDoc.files.predictionsSha256 !== predsSha256) {
    throw new Error(`predictions.jsonl 哈希（${predsSha256}）与 results.json 记录（${resultsDoc.files.predictionsSha256}）不一致——预测已变，须显式重训，禁止以统计修订掩盖`);
  }
  const keys = Object.keys(MODE_KEYS);
  const lines = fs.readFileSync(predsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (lines.length !== targetsDoc.targets.length) {
    throw new Error(`predictions 行数 ${lines.length} ≠ 目标数 ${targetsDoc.targets.length}`);
  }
  const rowsByModel = Object.fromEntries(keys.map((k) => [k, []]));
  for (let i = 0; i < lines.length; i++) {
    const t = targetsDoc.targets[i];
    for (const k of keys) {
      const p = lines[i].preds && lines[i].preds[k];
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`第 ${i} 行 ${k} 预测不合法`);
      rowsByModel[k].push({ ...t, pred: p });
    }
  }
  const results = {};
  const calibration = {};
  for (const k of keys) {
    results[k] = evaluateMetrics(rowsByModel[k]);
    calibration[k] = calibrationBins(rowsByModel[k]);
  }
  const boot = bootstrapAllModels(rowsByModel, { reps: config.evaluation.bootstrapReps, seed });
  const comparisons = comparisonRows(boot);
  const bootstrap = {
    reps: boot.reps,
    units: boot.students,
    unitRule: '学生级聚类 bootstrap（重采样单位 = test 学生），同一批权重用于五组 → 天然配对',
    ciRule: 'CI 存未舍入百分位（2.5/97.5）；方向/显著性标志由未舍入值判定（*CI4 仅作展示，不参与判定）',
    ci: boot.ciByModel,
    comparisons
  };
  const { sourceHashes, implementationHash } = implementationHashOf([
    'dkt.js', 'graphDkt.js', 'graphDktExperiment.js', 'baselineEval.js', 'bootstrapStats.js'
  ]);
  const prevRevision = resultsDoc.statisticsRevision || null;
  const previousStats = canonicalJson({ results: resultsDoc.results, calibration: resultsDoc.calibration, bootstrap: resultsDoc.bootstrap });
  const revision = {
    stage: 'D-restat',
    revisedAt: new Date().toISOString(),
    nodeVersion: process.version,
    reason: reason || '审计加固：CI 改存未舍入百分位、方向标志由原始值判定；审计补齐校准/CI/支持标志/有效抽样数/源码来源核验。仅重算统计，未重训。',
    previousStatisticsSha256: 'sha256:' + sha256Hex(Buffer.from(previousStats)),
    noRetraining: true,
    predictionsSha256: predsSha256,
    predictionsUnchanged: true,
    trainingImplementationHash: resultsDoc.implementationMetadata ? resultsDoc.implementationMetadata.implementationHash : null,
    trainingSourceHashes: resultsDoc.implementationMetadata ? resultsDoc.implementationMetadata.sourceHashes : null,
    statisticsImplementationHash: implementationHash,
    statisticsSourceHashes: sourceHashes,
    history: prevRevision
      ? [...(prevRevision.history || []), {
        revisedAt: prevRevision.revisedAt,
        previousStatisticsSha256: prevRevision.previousStatisticsSha256,
        statisticsImplementationHash: prevRevision.statisticsImplementationHash
      }]
      : []
  };
  const next = {
    ...resultsDoc,
    results,
    calibration,
    bootstrap,
    statisticsRevision: revision
  };
  // 显式重申：训练相关分区保持原值（防止上层展开时被覆盖）
  for (const f of ['models', 'hyperUsed', 'implementationMetadata', 'baselineReproduction', 'files', 'dataHashes', 'earlyStopDisclosure', 'sequenceCounts', 'targetCount', 'targetManifestHash']) {
    if (resultsDoc[f] !== undefined) next[f] = resultsDoc[f];
  }
  fs.writeFileSync(resultsFile, JSON.stringify(next, null, 2));
  emit(`统计修订完成（seed ${seed}）：predictions 未变 ${predsSha256.slice(7, 23)}…；训练实现哈希保留 ${revision.trainingImplementationHash ? revision.trainingImplementationHash.slice(7, 23) + '…' : 'n/a'}；统计实现哈希 ${implementationHash.slice(7, 23)}…`);
  emit(`已写回 ${resultsFile}（仅 statistics 分区 + statisticsRevision；缓存指纹/训练元数据未动）`);
  return { resultsFile, revision, predictionsSha256: predsSha256, comparisons };
}

module.exports = {
  PROTOCOL_VERSION,
  SMOKE_SEED,
  MODE_KEYS,
  MODEL_DESCRIPTIONS,
  validateConfig,
  loadPrepared,
  loadInteractions,
  runSmoke,
  writeSmokeResults,
  aggregateFiniteness,
  MonitoredGraphDkt,
  paramDigest,
  paramsFinite,
  buildTargetManifest,
  assertRowsMatchTargets,
  trainFingerprint,
  formalHyperFor,
  runTrainSeed,
  runEvaluate,
  runRestat,
  comparisonFlags,
  comparisonRows,
  implementationHashOf
};
