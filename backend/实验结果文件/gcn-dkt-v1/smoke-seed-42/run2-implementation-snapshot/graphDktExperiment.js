/**
 * graphDktExperiment.js —— 图增强 DKT 五组对照实验入口（分阶段）
 *
 * 当前仅实现阶段 C 冒烟（--stage smoke）：
 *   - 限定 seed 42、仅 train/validation；不读取 test 指标、不用于架构选择；
 *   - 复用阶段 A 冻结产物（split / vocabulary / 真实图 / 随机图 / SelfLoop manifest），
 *     并对全部哈希（raw、task、split、vocabulary、边表、邻接）逐项校验；
 *   - 先在同一入口、同一数据上核对 GraphDkt(full) 与原 GruDkt 的训练/验证行为逐位一致；
 *   - 再跑五组模型，检查 loss / 参数 / 验证预测有限性，记录耗时、内存峰值与早停回滚；
 *   - 冒烟结果写入 smoke-seed-42/ 单独目录并标记 smoke=true，注明非正式结果。
 *
 * 正式阶段（prepare/train/evaluate、五种子 25 次拟合）尚未实现，也未获放行。
 *
 * 用法：
 *   node models/graphDktExperiment.js --stage smoke \
 *     --config 实验结果文件/gcn-dkt-v1/experiment-config.json \
 *     --prepared-dir 实验结果文件/gcn-dkt-v1/seed-42 \
 *     --interactions backend/datasets/assist2009/interactions.csv \
 *     --raw backend/datasets/raw/skill_builder_data.csv \
 *     --out 实验结果文件/gcn-dkt-v1 \
 *     [--epochs 3] [--models full,gcn,random-graph,larger,selfloop] [--skip-full-reference]
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
function loadPrepared(preparedDir) {
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
  if (split.splitSeed !== SMOKE_SEED) throw new Error(`冻结划分种子应为 ${SMOKE_SEED}，收到 ${split.splitSeed}`);

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

  clipGrad(maxNorm) {
    const norm = super.clipGrad(maxNorm);
    for (const key of Object.keys(this.grads)) {
      const g = this.grads[key];
      for (let i = 0; i < g.length; i++) {
        if (!Number.isFinite(g[i])) {
          this._monitor.gradientFinite = false;
          this._monitor.failure = `裁剪后梯度非有限（${key}[${i}]）`;
          throw new Error(`数值监控：${this._monitor.failure}，停止冒烟`);
        }
      }
    }
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
    emit(`  → val LogLoss ${r.training.bestValLogLoss}（epoch ${r.training.bestEpoch}/${r.training.epochsRun}，耗时 ${r.fitSeconds}s，RSS 峰值 ${(r.memory.rssPeakBytes / 1048576).toFixed(0)}MB）`);
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
    : `本轮冒烟 epochs≤${epochs}，五组均未实际触发早停（stoppedEarly=false）；不构成真实数据早停验证，回滚路径由 M12 单元测试保证。`;

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
    epochs: get('epochs') ? Number(get('epochs')) : 3,
    models: get('models') ? String(get('models')).split(',').map((s) => s.trim()).filter(Boolean) : null,
    skipFullReference: argv.includes('--skip-full-reference'),
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.stage !== 'smoke') {
    console.error(`未知阶段: ${args.stage}。当前仅实现 --stage smoke（正式 prepare/train/evaluate 尚未实现、未放行）。`);
    process.exit(1);
  }
  if (args.seed !== SMOKE_SEED) {
    console.error(`阶段 C 冒烟限定 seed ${SMOKE_SEED}，收到 --seed ${args.seed}。`);
    process.exit(1);
  }
  for (const [k, v] of [['--config', args.config], ['--prepared-dir', args.preparedDir], ['--interactions', args.interactions], ['--out', args.out]]) {
    if (!v) { console.error(`缺少必填参数 ${k}`); process.exit(1); }
  }

  const config = validateConfig(JSON.parse(fs.readFileSync(path.resolve(args.config), 'utf8')));
  // 数据版本校验（G01 口径）
  const actualRaw = sha256File(args.raw);
  const actualTask = sha256File(args.interactions);
  if ('sha256:' + actualRaw !== config.data.rawSha256) throw new Error('raw 文件哈希与冻结配置不一致');
  if ('sha256:' + actualTask !== config.data.taskSha256) throw new Error('interactions 文件哈希与冻结配置不一致');
  log(`数据哈希校验通过：raw ${actualRaw.slice(0, 16)}… task ${actualTask.slice(0, 16)}…`);

  const prepared = loadPrepared(args.preparedDir);
  log(`阶段 A 冻结产物校验通过：${prepared.realManifest.nodeCount} 节点，真实边 ${prepared.realEdges.length}，随机边 ${prepared.randomEdges.length}`);

  const records = loadInteractions(args.interactions);
  log(`interactions 记录 ${records.length} 条`);

  const results = runSmoke({
    config,
    records,
    prepared,
    outDir: args.out,
    epochs: args.epochs,
    models: args.models,
    fullReference: !args.skipFullReference
  });

  const file = writeSmokeResults(results, args.out);
  log(`\n实现源码组合哈希（已写入结果文件 implementationMetadata）: ${results.implementationMetadata.implementationHash.slice(0, 23)}…`);
  log(`配置文件内容哈希（configSha256）: ${results.implementationMetadata.configSha256.slice(0, 23)}…`);
  log(`早停披露: ${results.earlyStopDisclosure}`);
  log(`冒烟结果已写入 ${file}`);
  log('冒烟完成：非正式结果，不得用于架构选择或正式报告。');
}

if (require.main === module) main();

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
  paramsFinite
};
