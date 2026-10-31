/**
 * graphDktExperiment.test.js —— 冒烟入口测试（方案 §11.3 E 系列的阶段 C 子集）
 *
 * 覆盖：
 *   - 配置校验：未知字段 / 缺必填 / 协议版本 / seeds[0]≠42 / 冻结标记 / 实现约束，全部拒绝
 *   - 合成小数据端到端：构图 CLI 生成 prepared 产物 → runSmoke 全五组（epochs=1）
 *     断言 Full 与原 GruDkt 同入口逐位一致、五组有限性、早停回滚一致、
 *     模型内部 Anorm 与 manifest 哈希一致、test 学生隔离、结果落盘并标记 smoke
 *
 * 合成输出仅用于测试，不代表正式实验数据。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function resolveModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('找不到模块，尝试过：' + candidates.join(' ; '));
}

const exp = resolveModule([
  path.join(__dirname, '..', 'models', 'graphDktExperiment.js'),
  path.join(__dirname, '..', 'graphDktExperiment.js')
]);
const dkt = resolveModule([
  path.join(__dirname, '..', 'models', 'dkt.js'),
  path.join(__dirname, '..', 'model', 'dkt.js')
]);

const sha = (p) => 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------- 与 graphData.test.js 同款 fixture（独立标识 KP） ----------
const KP1 = 'a09-s21', KP2 = 'a09-s22', KP3 = 'a09-s23', KP4 = 'a09-s24';
const USERS = Array.from({ length: 10 }, (_, i) => `a09-u${400 + i}`);
const split = dkt.splitStudents(USERS, { train: 0.7, validation: 0.15, seed: 42 });

function buildFixture(dir) {
  fs.mkdirSync(path.join(dir, 'assist2009'), { recursive: true });
  const t = (n) => `2000-01-01T00:${String(n).padStart(2, '0')}:00.000Z`;
  const rows = ['userId,questionId,kpCode,isCorrect,costTime,createdAt,sequenceIndex'];
  const nonTrain = new Set([...split.validation, ...split.test]);
  for (const u of USERS) {
    let si = 0;
    rows.push(`${u},a09-p1,${KP1},1,5,${t(1)},${si++}`);
    rows.push(`${u},a09-p2,${KP2},0,5,${t(2)},${si++}`);
    if (nonTrain.has(u)) rows.push(`${u},a09-p3,${KP3},1,5,${t(3)},${si++}`);
  }
  const interactionsPath = path.join(dir, 'assist2009', 'interactions.csv');
  fs.writeFileSync(interactionsPath, rows.join('\n') + '\n');

  const rawRows = ['order_id,user_id,problem_id,skill_id,correct,ms_first_response'];
  const line = (o, u, p, s, c, ms) => rawRows.push(`${o},${u.replace('a09-u', '')},${p.replace('a09-p', '')},${s.replace('a09-s', '')},${c},${ms}`);
  const tr = split.train;
  line(1, tr[0], 'a09-p1', KP1, 1, 12000); line(1, tr[0], 'a09-p1', KP2, 0, 45000);
  for (let k = 0; k < 10; k++) { line(10 + k, tr[1], 'a09-p1', KP1, 1, 9000); line(10 + k, tr[1], 'a09-p1', KP2, 1, 8000); }
  line(30, tr[2], 'a09-p2', KP2, 1, 7000);
  line(40, split.validation[0], 'a09-p1', KP1, 1, 11000); line(40, split.validation[0], 'a09-p1', KP3, 0, 22000);
  line(50, split.test[0], 'a09-p1', KP2, 1, 13000); line(50, split.test[0], 'a09-p1', KP3, 0, 14000);
  line(60, split.test[0], 'a09-p1', KP4, 1, 15000);
  const rawPath = path.join(dir, 'raw.csv');
  fs.writeFileSync(rawPath, rawRows.join('\n') + '\n');

  const targets = [
    { targetKey: 't1', kpCode: KP1 }, { targetKey: 't2', kpCode: KP1 },
    { targetKey: 't3', kpCode: KP2 },
    { targetKey: 't4', kpCode: KP3 }, { targetKey: 't5', kpCode: KP3 },
    { targetKey: 't6', kpCode: KP4 }
  ];
  const targetsPath = path.join(dir, 'targets.json');
  fs.writeFileSync(targetsPath, JSON.stringify({
    protocolVersion: 'fixture', seed: 42, targetCount: targets.length,
    targetManifestHash: 'sha256:fixture-target-manifest', targets
  }));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ source: { rawSha256: sha(rawPath) }, output: { sha256: sha(interactionsPath) } }));
  return { rawPath, interactionsPath, manifestPath, targetsPath };
}

function buildGraphScript() {
  const candidates = [
    path.join(__dirname, '..', 'scripts', 'buildAssist2009SkillGraph.js'),
    path.join(__dirname, '..', '..', 'scripts', 'buildAssist2009SkillGraph.js')
  ];
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) throw new Error('找不到构图脚本');
  return p;
}

const GRAPH_SCRIPT = buildGraphScript();

/** 冒烟用小配置（与冻结配置同字段结构，维度缩小） */
function buildConfig(fx, preparedDir) {
  const real = JSON.parse(fs.readFileSync(path.join(preparedDir, 'graph-real-manifest.json'), 'utf8'));
  return {
    protocolVersion: 'assist2009-gcn-dkt-v1',
    schemaVersion: 1,
    seeds: [42, 43, 44, 45, 46],
    models: ['Full-DKT', 'GCN-DKT', 'RandomGraph-DKT', 'Larger-DKT', 'SelfLoop-DKT'],
    graph: {
      source: 'train-attempt-multiskill-coannotation',
      weight: 'distinct-problem-support',
      minSupport: 1,
      normalization: 'symmetric-with-unit-self-loop',
      selfLoopWeight: 1,
      randomization: 'same-edge-count-and-weight-multiset',
      randomRetryLimit: 100
    },
    model: {
      embedDim: 4, hiddenSize: 6, largerHiddenSize: 8, graphLayers: 2,
      graphHiddenDim: 4, graphResidualScale: 1, graphBranchDropout: 0,
      dropout: 0.2, residualFormula: 'x_t = E[2k+r] + Z[k]'
    },
    training: {
      learningRate: 0.01, adamBetas: [0.9, 0.999], adamEpsilon: 1e-8,
      weightDecay: 0, batchSize: 4, maxEpochs: 50, patience: 5,
      minImprovement: 0.00001, gradClipNorm: 5, bceEps: 1e-7,
      gradientReduction: 'legacy-summed-target-gradients（锁定当前 dkt.js 实际梯度累计行为）'
    },
    evaluation: {
      bootstrapReps: 100, confidenceLevel: 0.95, predictionDecimals: 6,
      primaryMetric: 'AUC',
      comparisons: ['GCN-DKT − Full-DKT', 'GCN-DKT − RandomGraph-DKT', 'GCN-DKT − SelfLoop-DKT', 'GCN-DKT − Larger-DKT'],
      minimumMeanAucGainVsFull: 0.002, maximumMeanLogLossIncreaseVsFull: 0.001,
      selectionRule: 'fixture'
    },
    data: {
      rawFile: fx.rawPath, rawSha256: sha(fx.rawPath),
      taskFile: fx.interactionsPath, taskSha256: sha(fx.interactionsPath),
      records: 36, students: USERS.length, knowledgePoints: 3,
      vocabRule: 'fixture 完整任务固定词表', split: 'fixture 70/15/15',
      targetRule: 'fixture'
    },
    frozenBeforeTestRun: true,
    frozenAt: '2026-10-31',
    notes: ['synthetic 冒烟 fixture，非正式数据']
  };
}

describe('配置校验：未知字段 / 缺必填 / 冻结与实现约束全部拒绝', () => {
  const base = {
    protocolVersion: 'assist2009-gcn-dkt-v1', schemaVersion: 1,
    seeds: [42, 43, 44, 45, 46],
    models: ['Full-DKT', 'GCN-DKT', 'RandomGraph-DKT', 'Larger-DKT', 'SelfLoop-DKT'],
    graph: { source: 'x', weight: 'w', minSupport: 1, normalization: 'n', selfLoopWeight: 1, randomization: 'r', randomRetryLimit: 100 },
    model: { embedDim: 32, hiddenSize: 64, largerHiddenSize: 68, graphLayers: 2, graphHiddenDim: 32, graphResidualScale: 1, graphBranchDropout: 0, dropout: 0.2, residualFormula: 'f' },
    training: { learningRate: 0.001, adamBetas: [0.9, 0.999], adamEpsilon: 1e-8, weightDecay: 0, batchSize: 64, maxEpochs: 50, patience: 5, minImprovement: 0.00001, gradClipNorm: 5, bceEps: 1e-7, gradientReduction: 'legacy-summed-target-gradients' },
    evaluation: { bootstrapReps: 2000, confidenceLevel: 0.95, predictionDecimals: 6, primaryMetric: 'AUC', comparisons: [], minimumMeanAucGainVsFull: 0.002, maximumMeanLogLossIncreaseVsFull: 0.001, selectionRule: 's' },
    data: { rawFile: 'r', rawSha256: 'sha256:' + 'a'.repeat(64), taskFile: 't', taskSha256: 'sha256:' + 'b'.repeat(64), records: 1, students: 1, knowledgePoints: 100, vocabRule: 'v', split: 's', targetRule: 't' },
    frozenBeforeTestRun: true, frozenAt: '2026-10-31', notes: []
  };

  test('合法配置通过', () => {
    expect(() => exp.validateConfig(JSON.parse(JSON.stringify(base)))).not.toThrow();
  });
  test('未知顶层字段拒绝', () => {
    const c = { ...base, extra: 1 };
    expect(() => exp.validateConfig(c)).toThrow(/未知顶层字段: extra/);
  });
  test('缺必填字段拒绝', () => {
    const c = JSON.parse(JSON.stringify(base));
    delete c.training;
    expect(() => exp.validateConfig(c)).toThrow(/缺少必填字段: training/);
  });
  test('sections 内未知字段拒绝', () => {
    const c = JSON.parse(JSON.stringify(base));
    c.model.novelBranch = true;
    expect(() => exp.validateConfig(c)).toThrow(/model 中存在未知字段: novelBranch/);
  });
  test('protocolVersion 不符拒绝', () => {
    const c = { ...base, protocolVersion: 'other-v9' };
    expect(() => exp.validateConfig(c)).toThrow(/protocolVersion/);
  });
  test('seeds[0]≠42 拒绝（阶段 C 只放行 seed 42）', () => {
    const c = { ...base, seeds: [43, 44] };
    expect(() => exp.validateConfig(c)).toThrow(/seeds\[0\] === 42/);
  });
  test('未冻结配置拒绝', () => {
    const c = { ...base, frozenBeforeTestRun: false };
    expect(() => exp.validateConfig(c)).toThrow(/冻结/);
  });
  test('实现约束不符拒绝（graphLayers / graphHiddenDim / graphResidualScale / graphBranchDropout / minImprovement）', () => {
    for (const [ mutate, pattern ] of [
      [(c) => { c.model.graphLayers = 3; }, /graphLayers/],
      [(c) => { c.model.graphHiddenDim = 16; }, /graphHiddenDim/],
      [(c) => { c.model.graphResidualScale = 0.5; }, /graphResidualScale/],
      [(c) => { c.model.graphBranchDropout = 0.1; }, /graphBranchDropout/],
      [(c) => { c.training.minImprovement = 1e-4; }, /1e-5/]
    ]) {
      const c = JSON.parse(JSON.stringify(base));
      mutate(c);
      expect(() => exp.validateConfig(c)).toThrow(pattern);
    }
  });
  test('类型与范围校验拒绝（无效/未实现的设置不得静默通过）', () => {
    for (const [ mutate, pattern ] of [
      [(c) => { c.seeds = 42; }, /seeds 必须为数组/],
      [(c) => { c.models = 'all'; }, /models 必须为数组/],
      [(c) => { c.schemaVersion = 999; }, /schemaVersion 应为 1/],
      [(c) => { c.model.dropout = 1.5; }, /dropout 必须为 \[0,1\) 的数值/],
      [(c) => { c.graph.selfLoopWeight = 9; }, /selfLoopWeight 固定为 1/],
      [(c) => { c.training.adamEpsilon = 1e-7; }, /adamEpsilon 应为 1e-8/],
      [(c) => { c.training.bceEps = 1e-6; }, /bceEps 应为 1e-7/],
      [(c) => { c.data.rawSha256 = 'deadbeef'; }, /rawSha256/],
      [(c) => { c.evaluation.confidenceLevel = 1.5; }, /confidenceLevel/],
      [(c) => { c.training.batchSize = 0; }, /batchSize/]
    ]) {
      const c = JSON.parse(JSON.stringify(base));
      mutate(c);
      expect(() => exp.validateConfig(c)).toThrow(pattern);
    }
  });
});

describe('aggregateFiniteness：注入异常必须漏报失败为零（纯函数）', () => {
  const okModel = () => ({
    paramsFinite: true,
    paramsFiniteFailure: null,
    valPredictions: { count: 10, allFinite: true },
    rollbackConsistent: true,
    numericalChecks: { epochCurveChecks: 3, gradientBatchesChecked: 12, gradientFinite: true, paramUpdatesChecked: 12, paramsFiniteAfterUpdate: true },
    training: { curve: [{ epoch: 1, trainLogLoss: 0.6, valLogLoss: 0.6 }, { epoch: 2, trainLogLoss: 0.5, valLogLoss: 0.55 }] },
    memory: { memorySamples: 12, rssPeakSampledBytes: 1000, heapPeakSampledBytes: 500 }
  });

  test('全正常 → passed=true', () => {
    expect(exp.aggregateFiniteness({ A: okModel(), B: okModel() }).passed).toBe(true);
  });
  test('注入 trainLogLoss=NaN → passed=false（不得漏报成功）', () => {
    const m = okModel();
    m.training.curve[1].trainLogLoss = NaN;
    const r = exp.aggregateFiniteness({ A: m });
    expect(r.passed).toBe(false);
    expect(r.failures.join('\n')).toMatch(/曲线 epoch 2 loss 非有限/);
  });
  test('注入 valLogLoss=NaN → passed=false', () => {
    const m = okModel();
    m.training.curve[0].valLogLoss = NaN;
    const r = exp.aggregateFiniteness({ A: m });
    expect(r.passed).toBe(false);
  });
  test('监控未生效（梯度检查计数为 0）→ passed=false', () => {
    const m = okModel();
    m.numericalChecks.gradientBatchesChecked = 0;
    const r = exp.aggregateFiniteness({ A: m });
    expect(r.passed).toBe(false);
    expect(r.failures.join('\n')).toMatch(/梯度有限性检查计数为 0/);
  });
  test('梯度非有限 / 更新后参数非有限 / 预测非有限 / 回滚不一致 → 全部失败', () => {
    for (const mutate of [
      (m) => { m.numericalChecks.gradientFinite = false; },
      (m) => { m.numericalChecks.paramsFiniteAfterUpdate = false; },
      (m) => { m.valPredictions.allFinite = false; },
      (m) => { m.rollbackConsistent = false; },
      (m) => { m.paramsFinite = false; },
      (m) => { m.memory.memorySamples = 0; }
    ]) {
      const m = okModel();
      mutate(m);
      expect(exp.aggregateFiniteness({ A: m }).passed).toBe(false);
    }
  });
});

describe('MonitoredGraphDkt 监控行为：1e200 / Infinity / NaN 梯度不得被范数溢出掩盖', () => {
  const KP = ['k1', 'k2', 'k3'];
  const VOCAB = {
    kpList: KP,
    kpIndex: new Map(KP.map((k, i) => [k, i])),
    vocabSize: 6,
    numSkills: 3,
    inputMode: 'full'
  };
  const make = () => new exp.MonitoredGraphDkt(VOCAB, { embedDim: 4, hiddenSize: 6, seed: 42, modelMode: 'full' });
  const zeroGrads = (m) => { for (const g of Object.values(m.grads)) g.fill(0); };

  test('对照：正常有限大范数梯度被裁剪到 maxNorm，计数 +1，监控不误报', () => {
    const m = make();
    zeroGrads(m);
    m.grads.E[0] = 10; // 唯一非零梯度 → 范数 10 > maxNorm 5
    const norm = m.clipGrad(5);
    expect(norm).toBeCloseTo(10, 10);
    expect(m.grads.E[0]).toBeCloseTo(5, 10); // scale = 5/10
    expect(m._monitor.gradientBatchesChecked).toBe(1);
    expect(m._monitor.gradientFinite).toBe(true);
    expect(m._monitor.failure).toBe(null);
  });

  test('1e200：逐元素有限但平方求和溢出 → 范数检查拦截，不得静默缩放为 0 漏报', () => {
    const m = make();
    zeroGrads(m);
    m.grads.E[0] = 1e200; // 有限值；norm = sqrt((1e200)^2) = Infinity
    expect(() => m.clipGrad(5)).toThrow(/梯度范数非有限（Infinity）/);
    expect(m._monitor.gradientFinite).toBe(false);
    expect(m._monitor.failure).toMatch(/平方求和溢出/);
    // 行为断言：失败批次不得计入"通过检查"计数（不能只改汇总布尔字段）
    expect(m._monitor.gradientBatchesChecked).toBe(0);
  });

  test('Infinity 梯度：裁剪前逐元素检查拦截并中止', () => {
    const m = make();
    zeroGrads(m);
    m.grads.Wz[3] = Infinity;
    expect(() => m.clipGrad(5)).toThrow(/裁剪前梯度非有限（Wz\[3\]）/);
    expect(m._monitor.gradientFinite).toBe(false);
    expect(m._monitor.gradientBatchesChecked).toBe(0);
  });

  test('NaN 梯度：裁剪前逐元素检查拦截并中止', () => {
    const m = make();
    zeroGrads(m);
    m.grads.Wh[7] = NaN;
    expect(() => m.clipGrad(5)).toThrow(/裁剪前梯度非有限（Wh\[7\]）/);
    expect(m._monitor.gradientFinite).toBe(false);
    expect(m._monitor.gradientBatchesChecked).toBe(0);
  });

  test('裁剪后分支（独立触发）：_checkGradsFinite("裁剪后") 对非有限梯度拦截', () => {
    // 正常路径下裁剪后必有限（预检全有限 + norm 有限 → scale∈(0,1] 保值有限），
    // 因此裁剪后检查是防御性不变量；直接触发该分支验证其独立可用。
    const m = make();
    zeroGrads(m);
    m.grads.Wout[0] = NaN;
    expect(() => m._checkGradsFinite('裁剪后')).toThrow(/裁剪后梯度非有限（Wout\[0\]）/);
    expect(m._monitor.gradientFinite).toBe(false);
  });

  test('连续 batch：正常通过后再次注入坏梯度被裁剪前检查拦截，计数不增长', () => {
    const m = make();
    zeroGrads(m);
    m.grads.Wout[0] = 3; // 范数 3 ≤ 5，正常通过
    m.clipGrad(5);
    expect(m._monitor.gradientBatchesChecked).toBe(1);
    // 下一 batch 注入非有限值（模拟前向/反向产生坏梯度）
    zeroGrads(m);
    m.grads.Wout[0] = NaN;
    expect(() => m.clipGrad(5)).toThrow(/裁剪前梯度非有限（Wout\[0\]）/);
    expect(m._monitor.gradientBatchesChecked).toBe(1); // 不增加
  });
});

describe('端到端冒烟（synthetic 小数据，epochs=1，全五组）', () => {
  let fx;
  let preparedDir;
  let config;
  let records;
  let outDir;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-'));
    fx = buildFixture(dir);
    outDir = path.join(dir, 'out');
    execFileSync('node', [GRAPH_SCRIPT, '--raw', fx.rawPath, '--interactions', fx.interactionsPath,
      '--manifest', fx.manifestPath, '--targets', fx.targetsPath, '--seed', '42', '--out', outDir], { stdio: 'pipe' });
    preparedDir = path.join(outDir, 'seed-42');
    config = buildConfig(fx, preparedDir);
    records = exp.loadInteractions(fx.interactionsPath);
  });

  let results;

  test('runSmoke 全五组完成且全部硬校验通过', () => {
    results = exp.runSmoke({ config, records, prepared: exp.loadPrepared(preparedDir), outDir, epochs: 1 });
    const keys = Object.keys(results.models);
    expect(keys.sort()).toEqual(['Full-DKT', 'GCN-DKT', 'Larger-DKT', 'RandomGraph-DKT', 'SelfLoop-DKT']);
    expect(results.allFiniteChecksPassed).toBe(true);
    expect(results.seed).toBe(42);
  });

  test('Full 与原 GruDkt 同入口逐位一致', () => {
    const r = results.fullReferenceConsistency;
    expect(r.curveIdentical).toBe(true);
    expect(r.paramsIdentical).toBe(true);
    expect(r.valLogLossEqual).toBe(true);
    expect(r.gruValLogLoss).toBe(results.models['Full-DKT'].training.bestValLogLoss);
  });

  test('结果标记 smoke 并落盘到独立目录', () => {
    const file = exp.writeSmokeResults(results, outDir);
    expect(file).toContain(path.join('smoke-seed-42', 'smoke-results.json'));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.smoke).toBe(true);
    expect(saved.purpose).toContain('非正式结果');
    expect(saved.stage).toBe('C-smoke');
    expect(saved.dataIsolation.architectureSelection).toContain('不读取正式 test 指标');
  });

  test('test 学生隔离：train/validation 序列不含 test 学生', () => {
    expect(results.dataIsolation.testStudents).toBe(split.test.length);
    expect(results.sequenceCounts.validation).toBe(split.validation.length);
  });

  test('逐 batch 数值监控生效：梯度/参数检查计数 > 0，曲线逐轮检查 = epochs，内存采样次数 > 0', () => {
    for (const [key, r] of Object.entries(results.models)) {
      const nc = r.numericalChecks;
      expect(nc.gradientBatchesChecked).toBeGreaterThan(0);
      expect(nc.paramUpdatesChecked).toBeGreaterThan(0);
      expect(nc.gradientFinite).toBe(true);
      expect(nc.paramsFiniteAfterUpdate).toBe(true);
      expect(nc.epochCurveChecks).toBe(r.training.epochsRun);
      expect(r.memory.memorySamples).toBeGreaterThan(0);
      expect(r.memory.rssPeakSampledBytes).toBeGreaterThan(0);
      expect(r.memory.sampledAt).toContain('batch 边界');
    }
  });

  test('早停披露：本轮未触发早停时必须如实声明', () => {
    const anyStop = Object.values(results.models).some((r) => r.training.stoppedEarly);
    if (!anyStop) {
      expect(results.earlyStopDisclosure).toContain('未实际触发早停');
      expect(results.earlyStopDisclosure).toContain('不构成真实数据早停验证');
    } else {
      expect(results.earlyStopDisclosure).toContain('实际触发早停');
    }
  });

  test('实现元数据落盘：implementationHash / 逐源码哈希 / configSha256 与实际文件一致', () => {
    const meta = results.implementationMetadata;
    const dir = path.join(__dirname, '..', 'models');
    const altDir = path.join(__dirname, '..', '..', 'model');
    const readOpt = (f) => {
      const p1 = path.join(dir, f);
      const p2 = path.join(altDir, f);
      return fs.existsSync(p1) ? p1 : p2;
    };
    const recompute = Object.entries(meta.sourceHashes).map(([f, h]) => {
      expect(h).toBe('sha256:' + crypto.createHash('sha256').update(fs.readFileSync(readOpt(f))).digest('hex'));
      return h;
    }).join('');
    expect(Object.keys(meta.sourceHashes).sort()).toEqual(['dkt.js', 'graphDkt.js', 'graphDktExperiment.js']);
    expect(meta.implementationHash).toBe('sha256:' + crypto.createHash('sha256').update(Buffer.from(recompute)).digest('hex'));
    expect(meta.configSha256).toBe('sha256:' + crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'));
  });

  test('图组模型内部 Anorm 与 manifest 哈希一致（runSmoke 内部已断言）且三图组参数摘要互不相同', () => {
    const digests = [
      results.models['GCN-DKT'].paramDigest,
      results.models['RandomGraph-DKT'].paramDigest,
      results.models['SelfLoop-DKT'].paramDigest
    ];
    expect(new Set(digests).size).toBe(3);
  });

  test('数据哈希链完整记录', () => {
    const h = results.dataHashes;
    expect(h.realEdgesSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h.realAdjacencySha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h.randomAdjacencySha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h.selfloopAdjacencySha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('哈希被篡改的 prepared 产物被拒绝', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-bad-'));
    try {
      const fx2 = buildFixture(dir2);
      const out2 = path.join(dir2, 'out');
      execFileSync('node', [GRAPH_SCRIPT, '--raw', fx2.rawPath, '--interactions', fx2.interactionsPath,
        '--manifest', fx2.manifestPath, '--targets', fx2.targetsPath, '--seed', '42', '--out', out2], { stdio: 'pipe' });
      // 篡改真实边 CSV（修改首条数据行的 support）
      const edgeFile = path.join(out2, 'seed-42', 'graph-real-edges.csv');
      const lines = fs.readFileSync(edgeFile, 'utf8').trim().split('\n');
      lines[1] = lines[1].replace(/,(\d+)$/, ',9');
      fs.writeFileSync(edgeFile, lines.join('\n') + '\n');
      expect(() => exp.loadPrepared(path.join(out2, 'seed-42'))).toThrow(/graph-real-edges/);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(path.dirname(fx.rawPath) === fx.rawPath ? fx.rawPath : path.dirname(fx.rawPath), { recursive: true, force: true });
  });
});
