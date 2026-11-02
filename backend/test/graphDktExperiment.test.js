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
const evalMod = resolveModule([
  path.join(__dirname, '..', 'models', 'baselineEval.js'),
  path.join(__dirname, '..', 'model', 'baselineEval.js')
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
    if (nonTrain.has(u)) {
      rows.push(`${u},a09-p3,${KP3},1,5,${t(3)},${si++}`);
      // 重复 KP 作答：保证 (学生,知识点) 组存在非首条记录 → test 目标集非空（阶段 D 需要）
      rows.push(`${u},a09-p4,${KP1},0,5,${t(4)},${si++}`);
      rows.push(`${u},a09-p5,${KP2},1,5,${t(5)},${si++}`);
    }
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

// ========== 阶段 D：正式训练 / 评估（synthetic 小数据验收） ==========
describe('阶段 D runTrainSeed / runEvaluate（synthetic 小数据验收）', () => {
  let fx;
  let preparedDir;
  let config;
  let records;
  let outDir;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-d-'));
    fx = buildFixture(dir);
    outDir = path.join(dir, 'out');
    execFileSync('node', [GRAPH_SCRIPT, '--raw', fx.rawPath, '--interactions', fx.interactionsPath,
      '--manifest', fx.manifestPath, '--targets', fx.targetsPath, '--seed', '42', '--out', outDir], { stdio: 'pipe' });
    preparedDir = path.join(outDir, 'seed-42');
    config = buildConfig(fx, preparedDir);
    records = exp.loadInteractions(fx.interactionsPath);
  });

  afterAll(() => {
    fs.rmSync(outDir ? path.dirname(fx.rawPath) : '', { recursive: true, force: true });
  });

  const trainOpts = (overrides) => ({
    config, records, prepared: exp.loadPrepared(preparedDir), seed: 42, outDir,
    allowHyperOverrides: true, hyperOverrides: { maxEpochs: 2 }, log: () => {},
    ...overrides
  });

  test('正式训练全五组：落盘 targets/predictions/curves/results，逐目标预测与目标清单逐行一致', () => {
    const out = exp.runTrainSeed(trainOpts());
    expect(out.complete).toBe(true);
    const seedDir = path.join(outDir, 'seed-42');
    for (const f of ['targets.json', 'predictions.jsonl', 'training-curves.json', 'results.json']) {
      expect(fs.existsSync(path.join(seedDir, f))).toBe(true);
    }
    const targetsDoc = JSON.parse(fs.readFileSync(path.join(seedDir, 'targets.json'), 'utf8'));
    const lines = fs.readFileSync(path.join(seedDir, 'predictions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBe(targetsDoc.targetCount);
    const keys = Object.keys(exp.MODE_KEYS);
    for (let i = 0; i < lines.length; i++) {
      const t = targetsDoc.targets[i];
      expect(lines[i].targetKey).toBe(t.targetKey);
      expect(lines[i].userId).toBe(t.userId);
      expect(lines[i].kpCode).toBe(t.kpCode);
      expect(lines[i].createdAt).toBe(t.createdAt);
      expect(lines[i].target).toBe(t.target);
      for (const k of keys) {
        expect(Number.isFinite(lines[i].preds[k])).toBe(true);
        expect(lines[i].preds[k]).toBeGreaterThanOrEqual(0);
        expect(lines[i].preds[k]).toBeLessThanOrEqual(1);
      }
    }
    const saved = JSON.parse(fs.readFileSync(path.join(seedDir, 'results.json'), 'utf8'));
    expect(saved.smoke).toBe(false);
    expect(saved.stage).toBe('D-train');
    expect(Object.keys(saved.models).sort()).toEqual(keys.slice().sort());
    expect(saved.bootstrap.comparisons.map((c) => c.comparison).sort()).toEqual([
      'GCN-DKT − Full-DKT', 'GCN-DKT − Larger-DKT', 'GCN-DKT − RandomGraph-DKT', 'GCN-DKT − SelfLoop-DKT'
    ].sort());
  });

  test('统计落盘：学生级配对 CI 与方向标志均从数值重算', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'seed-42', 'results.json'), 'utf8'));
    for (const c of saved.bootstrap.comparisons) {
      expect(Number.isFinite(c.dAUC)).toBe(true);
      expect(Number.isFinite(c.dLogLoss)).toBe(true);
      expect(typeof c.ciAvailable).toBe('boolean');
      if (c.ciAvailable) {
        expect(c.dAUCCI.length).toBe(2);
        expect(c.dAUCCI[0] <= c.dAUCCI[1]).toBe(true);
        expect(c.aucExcludesZero).toBe(c.dAUCCI[0] * c.dAUCCI[1] > 0);
        expect(c.aucCISupportsGCN).toBe(c.dAUCCI[0] > 0);
        expect(c.logLossCISupportsGCN).toBe(c.dLogLossCI[1] < 0);
      } else {
        // 极小 fixture：CI 退化必须如实标记，不得伪装成有效区间
        expect(c.dAUCCI).toBe(null);
        expect(c.dLogLossCI).toBe(null);
        expect(c.ciNote).toContain('CI 不可用');
      }
    }
  });

  test('缓存恢复：相同指纹重跑不重训，预测文件逐字节一致', () => {
    const predsBefore = fs.readFileSync(path.join(outDir, 'seed-42', 'predictions.jsonl'), 'utf8');
    const out = exp.runTrainSeed(trainOpts());
    expect(out.complete).toBe(true);
    expect(out.trained).toEqual([]);
    expect(out.reused.sort()).toEqual(Object.keys(exp.MODE_KEYS).sort());
    const predsAfter = fs.readFileSync(path.join(outDir, 'seed-42', 'predictions.jsonl'), 'utf8');
    expect(predsAfter).toBe(predsBefore);
  });

  test('分批续训：--models 子集点名时，未点名但缓存有效的模型必须纳入并可凑齐五组', () => {
    const subOut = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-subset-'));
    const fullOut = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-fullbase-'));
    try {
      // 第一批：只点 Full
      const first = exp.runTrainSeed(trainOpts({ outDir: subOut, models: ['Full-DKT'] }));
      expect(first.complete).toBe(false);
      expect(first.trained).toEqual(['Full-DKT']);
      expect(first.missing.sort()).toEqual(['GCN-DKT', 'Larger-DKT', 'RandomGraph-DKT', 'SelfLoop-DKT'].sort());

      // 第二批：点其余四组 → Full 从缓存纳入，五组凑齐并落盘
      const second = exp.runTrainSeed(trainOpts({
        outDir: subOut, models: ['GCN-DKT', 'RandomGraph-DKT', 'SelfLoop-DKT', 'Larger-DKT']
      }));
      expect(second.complete).toBe(true);
      expect(second.missing).toEqual([]);
      expect(second.reused).toContain('Full-DKT');
      const seedDir = path.join(subOut, 'seed-42');
      const saved = JSON.parse(fs.readFileSync(path.join(seedDir, 'results.json'), 'utf8'));
      expect(Object.keys(saved.models).sort()).toEqual(Object.keys(exp.MODE_KEYS).sort());
      expect(saved.models['Full-DKT'].reusedFrom).toBe('cache');

      // 与一次性五组训练的预测逐字节一致（缓存复用不得改变数值路径）
      exp.runTrainSeed(trainOpts({ outDir: fullOut }));
      const a = fs.readFileSync(path.join(seedDir, 'predictions.jsonl'), 'utf8');
      const b = fs.readFileSync(path.join(fullOut, 'seed-42', 'predictions.jsonl'), 'utf8');
      expect(a).toBe(b);
    } finally {
      fs.rmSync(subOut, { recursive: true, force: true });
      fs.rmSync(fullOut, { recursive: true, force: true });
    }
  });

  test('缓存拒绝（E08）：训练超参变化 → 指纹不匹配 → 拒绝旧缓存并重训', () => {
    const out = exp.runTrainSeed(trainOpts({ hyperOverrides: { maxEpochs: 1 } }));
    expect(out.complete).toBe(true);
    expect(out.trained.sort()).toEqual(Object.keys(exp.MODE_KEYS).sort());
    expect(out.reused).toEqual([]);
  });

  test('seed 不在冻结配置 → 拒绝训练', () => {
    expect(() => exp.runTrainSeed(trainOpts({ seed: 99 }))).toThrow(/不在冻结配置/);
  });

  test('可控触发的早停与回滚：早停触发时回滚后 val LogLoss == bestValLogLoss', () => {
    // 小数据 + lr 0.01：50 epoch 内收敛进入平台 → patience=1 触发早停（可控触发）
    const out = exp.runTrainSeed(trainOpts({ hyperOverrides: { maxEpochs: 50, earlyStoppingPatience: 1 } }));
    expect(out.complete).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'seed-42', 'results.json'), 'utf8'));
    const stopped = Object.values(saved.models).filter((m) => m.training.stoppedEarly);
    expect(stopped.length).toBeGreaterThan(0); // 可控触发成功
    for (const m of Object.values(saved.models)) {
      expect(m.rollbackConsistent).toBe(true);
      expect(m.valLogLossAfterRollback).toBeCloseTo(m.training.bestValLogLoss, 6);
    }
    expect(saved.earlyStopDisclosure).toContain('实际触发早停');
  });

  test('Full 基线复现核对：与参考逐目标预测逐条比对（一致 / 不一致两路）', () => {
    // 先用默认超参建立缓存与落盘（前一测试用了不同超参，预测文件属于那次运行）
    exp.runTrainSeed(trainOpts());
    const lines = fs.readFileSync(path.join(outDir, 'seed-42', 'predictions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const refRows = lines.map((l) => ({ userId: l.userId, kpCode: l.kpCode, createdAt: l.createdAt, target: l.target, pred: l.preds['Full-DKT'] }));
    const refFile = path.join(path.dirname(fx.rawPath), 'full-ref.json');
    fs.writeFileSync(refFile, JSON.stringify({ rowsByModel: { 'Full-DKT': refRows } }));

    const ok = exp.runTrainSeed(trainOpts({ fullReferenceFile: refFile }));
    expect(ok.baselineReproduction.allMatchedAndIdentical).toBe(true);

    refRows[0].pred = refRows[0].pred > 0.5 ? refRows[0].pred - 0.1 : refRows[0].pred + 0.1;
    fs.writeFileSync(refFile, JSON.stringify({ rowsByModel: { 'Full-DKT': refRows } }));
    const bad = exp.runTrainSeed(trainOpts({ fullReferenceFile: refFile }));
    expect(bad.baselineReproduction.allMatchedAndIdentical).toBe(false);
    expect(bad.baselineReproduction.identicalPredictions).toBeLessThan(bad.baselineReproduction.matchedTargets);
  });

  test('evaluate：只读落盘预测重算（不加载模型），指标与 results.json 一致；缺预测时拒绝并提示补训须显式运行', () => {
    const evalOut = exp.runEvaluate({ config, inputDir: outDir, seed: 42, log: () => {} });
    expect(evalOut.stage).toBe('D-evaluate');
    const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'seed-42', 'results.json'), 'utf8'));
    expect(evalOut.resultsJsonConsistency.metricsMatch).toBe(true);
    for (const k of Object.keys(exp.MODE_KEYS)) {
      expect(evalOut.results[k].AUC).toBeCloseTo(saved.results[k].AUC, 9);
      expect(evalOut.results[k].LogLoss).toBeCloseTo(saved.results[k].LogLoss, 9);
    }
    // 缺预测 → 报错且不补训
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-ev-'));
    try {
      expect(() => exp.runEvaluate({ config, inputDir: emptyDir, seed: 42, log: () => {} }))
        .toThrow(/不触发补训/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('双入口：新阶段 API 在 backend/models 与顶层 model/ 两处布局均可解析（材料包布局存在时）', () => {
    const readOpt = (f) => {
      const p1 = path.join(__dirname, '..', 'models', f);
      const p2 = path.join(__dirname, '..', '..', 'model', f);
      if (fs.existsSync(p1)) return require(p1);
      if (fs.existsSync(p2)) return require(p2);
      return null;
    };
    const mod = readOpt('graphDktExperiment.js');
    expect(mod).not.toBeNull();
    expect(typeof mod.runTrainSeed).toBe('function');
    expect(typeof mod.runEvaluate).toBe('function');
    expect(typeof mod.buildTargetManifest).toBe('function');
    expect(typeof mod.trainFingerprint).toBe('function');
  });
});

describe('阶段 D/E 审计与聚合 CLI（synthetic 双种子端到端）', () => {
  jest.setTimeout(120000);
  let fx;
  let outDir;
  let config;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-audit-'));
    fx = buildFixture(dir);
    outDir = path.join(dir, 'out');
    const records = exp.loadInteractions(fx.interactionsPath);
    for (const seed of [42, 43]) {
      execFileSync('node', [GRAPH_SCRIPT, '--raw', fx.rawPath, '--interactions', fx.interactionsPath,
        '--manifest', fx.manifestPath, '--targets', fx.targetsPath, '--seed', String(seed), '--out', outDir], { stdio: 'pipe' });
    }
    config = buildConfig(fx, path.join(outDir, 'seed-42'));
    void records;
  });

  afterAll(() => {
    fs.rmSync(fx.rawPath ? path.dirname(fx.rawPath) : '', { recursive: true, force: true });
  });

  const entry = () => {
    const p1 = path.join(__dirname, '..', 'models');
    const p2 = path.join(__dirname, '..', '..', 'model');
    return (f) => path.join(fs.existsSync(path.join(p1, f)) ? p1 : p2, f);
  };

  test('CLI train seed 42/43 五组训练 → audit 42/43 → aggregate 双种子', () => {
    const E = entry();
    const common = ['--config', JSON.parse(JSON.stringify(fx.manifestPath)) && writeConfigFile(fx, config)];
    // 两个种子训练（正式 CLI 路径；小数据 50 epoch 内会触发早停）
    for (const seed of [42, 43]) {
      execFileSync('node', [E('graphDktExperiment.js'), '--stage', 'train', '--seed', String(seed),
        '--config', common[1], '--prepared-dir', path.join(outDir, `seed-${seed}`),
        '--interactions', fx.interactionsPath, '--raw', fx.rawPath, '--out', outDir], { stdio: 'pipe' });
    }
    // 独立审计两个种子
    for (const seed of [42, 43]) {
      execFileSync('node', [E('auditGraphDktResults.js'), '--config', common[1],
        '--input-dir', outDir, '--seed', String(seed), '--recompute-bootstrap'], { stdio: 'pipe' });
      const audit = JSON.parse(fs.readFileSync(path.join(outDir, `seed-${seed}`, 'audit-report.json'), 'utf8'));
      expect(audit.passed).toBe(true);
    }
    // 聚合（双种子；seedsComplete=false）
    execFileSync('node', [E('aggregateGraphDktSeeds.js'), '--config', common[1],
      '--input-dir', outDir, '--seeds', '42,43'], { stdio: 'pipe' });
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'multiseed-summary.json'), 'utf8'));
    expect(summary.seeds).toEqual([42, 43]);
    expect(summary.seedsComplete).toBe(false);
    expect(Object.keys(summary.perModelStats).sort()).toEqual(Object.keys(exp.MODE_KEYS).sort());
    expect(Object.keys(summary.comparisons).sort()).toEqual([
      'GCN-DKT − Full-DKT', 'GCN-DKT − Larger-DKT', 'GCN-DKT − RandomGraph-DKT', 'GCN-DKT − SelfLoop-DKT'
    ].sort());
    for (const c of Object.values(summary.comparisons)) {
      expect(Number.isFinite(c.dAUCMean)).toBe(true);
      expect(c.dAUCPositiveCount).toBeLessThanOrEqual(2);
    }
  });
});

describe('审计加固：未舍入 CI 判向 / 异常注入 / 审计后篡改 / 统计修订留痕', () => {
  jest.setTimeout(240000);
  let fx;
  let outDir;
  let config;
  let configFile;
  const entry = () => {
    const p1 = path.join(__dirname, '..', 'models');
    const p2 = path.join(__dirname, '..', '..', 'model');
    return (f) => path.join(fs.existsSync(path.join(p1, f)) ? p1 : p2, f);
  };
  const E = () => entry();
  const seedDir = () => path.join(outDir, 'seed-42');
  const resultsPath = () => path.join(seedDir(), 'results.json');
  const auditPath = () => path.join(seedDir(), 'audit-report.json');
  const predsPath = () => path.join(seedDir(), 'predictions.jsonl');
  const sha = (f) => 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const runCli = (args) => execFileSync('node', args, { stdio: 'pipe', encoding: 'utf8' });
  const expectCliFail = (args, re) => {
    let err = null;
    try { execFileSync('node', args, { stdio: 'pipe', encoding: 'utf8' }); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    if (re) expect(out).toMatch(re);
    return out;
  };
  const auditCli = () => [E()('auditGraphDktResults.js'), '--config', configFile, '--input-dir', outDir, '--seed', '42'];
  const aggCli = (seeds = '42') => [E()('aggregateGraphDktSeeds.js'), '--config', configFile, '--input-dir', outDir, '--seeds', seeds];

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexp-auditplus-'));
    fx = buildFixture(dir);
    outDir = path.join(dir, 'out');
    execFileSync('node', [GRAPH_SCRIPT, '--raw', fx.rawPath, '--interactions', fx.interactionsPath,
      '--manifest', fx.manifestPath, '--targets', fx.targetsPath, '--seed', '42', '--out', outDir], { stdio: 'pipe' });
    config = buildConfig(fx, path.join(outDir, 'seed-42'));
    configFile = writeConfigFile(fx, config);
    runCli([E()('graphDktExperiment.js'), '--stage', 'train', '--seed', '42',
      '--config', configFile, '--prepared-dir', path.join(outDir, 'seed-42'),
      '--interactions', fx.interactionsPath, '--raw', fx.rawPath, '--out', outDir]);
    runCli(auditCli());
  });

  afterAll(() => {
    fs.rmSync(fx.rawPath ? path.dirname(fx.rawPath) : '', { recursive: true, force: true });
  });

  test('未舍入 CI 判向（舍入边界）：0.00004 不得被判成跨零', () => {
    const f = exp.comparisonFlags;
    const plus = f({ dAUC: 0.001, dAUCCI: [0.00004, 0.002], dLogLoss: -0.001, dLogLossCI: [-0.002, -0.00004] });
    expect(plus.ciAvailable).toBe(true);
    expect(plus.aucExcludesZero).toBe(true);        // 原始下界 > 0
    expect(plus.aucCISupportsGCN).toBe(true);
    expect(plus.logLossExcludesZero).toBe(true);
    expect(plus.logLossCISupportsGCN).toBe(true);
    // 若先用 4 位舍入再判，下界 0.00004 → 0，会被错判为跨零（这正是本次修复的缺陷）
    const rounded = [0.00004, 0.002].map((v) => Number(v.toFixed(4)));
    expect(rounded[0] * rounded[1] > 0).toBe(false);
    // 对称的负向边界：跨零判定为真，但方向不支持 GCN
    const minus = f({ dAUC: -0.001, dAUCCI: [-0.002, -0.00004], dLogLoss: 0.001, dLogLossCI: [0.00004, 0.002] });
    expect(minus.aucExcludesZero).toBe(true);
    expect(minus.aucCISupportsGCN).toBe(false);
    expect(minus.logLossCISupportsGCN).toBe(false);
    // CI 真跨零 / 不可用
    expect(f({ dAUC: 0, dAUCCI: [-0.001, 0.001], dLogLoss: 0, dLogLossCI: [-0.001, 0.001] }).aucExcludesZero).toBe(false);
    const na = f({ dAUC: 0.1, dAUCCI: null, dLogLoss: -0.1, dLogLossCI: null });
    expect(na.ciAvailable).toBe(false);
    expect(na.aucExcludesZero).toBe(null);
    expect(na.aucCISupportsGCN).toBe(null);
  });

  test('审计报告绑定 results.json 哈希，且补齐 CI/标志/校准/有效抽样数/源码核验', () => {
    const audit = JSON.parse(fs.readFileSync(auditPath(), 'utf8'));
    expect(audit.passed).toBe(true);
    expect(audit.inputs.resultsSha256).toBe(sha(resultsPath()));
    expect(audit.recomputedComparisons.length).toBe(4);
    const names = audit.checks.map((c) => c.name).join('\n');
    expect(names).toMatch(/dAUCCI（未舍入）与重算一致/);
    expect(names).toMatch(/calibration\.Full-DKT 与重算一致/);
    expect(names).toMatch(/bootstrap\.units == test 学生数/);
    expect(names).toMatch(/记录的统计实现哈希 == 当前源码 implementationHash/);
    expect(names).toMatch(/aucCISupportsGCN 与记录 CI 自洽/);
    expect(audit.auditorSources['bootstrapStats.js']).toBe(sha(path.join(__dirname, '..', 'models', 'bootstrapStats.js')));
  });

  test('异常注入：篡改未舍入 CI（+1e-6）→ 审计必须失败', () => {
    const original = fs.readFileSync(resultsPath(), 'utf8');
    try {
      const doc = JSON.parse(original);
      doc.bootstrap.comparisons[0].dAUCCI[0] += 1e-6;
      fs.writeFileSync(resultsPath(), JSON.stringify(doc, null, 2));
      expectCliFail(auditCli(), /dAUCCI（未舍入）与重算一致/);
    } finally {
      fs.writeFileSync(resultsPath(), original);
      runCli(auditCli());
    }
  });

  test('异常注入：篡改校准分箱 → 审计必须失败', () => {
    const original = fs.readFileSync(resultsPath(), 'utf8');
    try {
      const doc = JSON.parse(original);
      doc.calibration['GCN-DKT'][0].n += 1;
      fs.writeFileSync(resultsPath(), JSON.stringify(doc, null, 2));
      expectCliFail(auditCli(), /calibration\.GCN-DKT 与重算一致/);
    } finally {
      fs.writeFileSync(resultsPath(), original);
      runCli(auditCli());
    }
  });

  test('异常注入：只翻转支持标志（CI 不动）→ 审计失败，聚合器也拒绝', () => {
    const original = fs.readFileSync(resultsPath(), 'utf8');
    try {
      const doc = JSON.parse(original);
      const c = doc.bootstrap.comparisons[0];
      c.aucCISupportsGCN = !c.aucCISupportsGCN;
      fs.writeFileSync(resultsPath(), JSON.stringify(doc, null, 2));
      expectCliFail(auditCli(), /aucCISupportsGCN 与记录 CI 自洽/);
      expectCliFail(aggCli(), /审计未通过|不符|矛盾|拒绝/);
    } finally {
      fs.writeFileSync(resultsPath(), original);
      runCli(auditCli());
    }
  });

  test('审计后篡改成绩（不改预测）→ 聚合器因 results.json 哈希不匹配拒绝', () => {
    const original = fs.readFileSync(resultsPath(), 'utf8');
    try {
      const doc = JSON.parse(original);
      doc.results['GCN-DKT'].AUC += 0.0001;
      fs.writeFileSync(resultsPath(), JSON.stringify(doc, null, 2));
      expectCliFail(aggCli(), /审计后被修改/);
    } finally {
      fs.writeFileSync(resultsPath(), original);
    }
  });

  test('统计修订（restat）：不重训、预测不变、训练哈希保留、缓存指纹不动', () => {
    const predsBefore = sha(predsPath());
    const docBefore = JSON.parse(fs.readFileSync(resultsPath(), 'utf8'));
    const cacheFile = path.join(outDir, 'cache', 'gcn-dkt-train-seed-42.json');
    const cacheBefore = sha(cacheFile);

    const out = runCli([E()('graphDktExperiment.js'), '--stage', 'restat', '--seed', '42',
      '--config', configFile, '--input-dir', outDir]);
    expect(out).toMatch(/统计修订完成/);

    expect(sha(predsPath())).toBe(predsBefore);                        // 预测未变
    expect(sha(cacheFile)).toBe(cacheBefore);                          // 缓存指纹未动
    const docAfter = JSON.parse(fs.readFileSync(resultsPath(), 'utf8'));
    expect(docAfter.statisticsRevision.noRetraining).toBe(true);
    expect(docAfter.statisticsRevision.predictionsUnchanged).toBe(true);
    expect(docAfter.statisticsRevision.predictionsSha256).toBe(predsBefore);
    expect(docAfter.statisticsRevision.trainingImplementationHash)
      .toBe(docBefore.implementationMetadata.implementationHash);      // 历史训练哈希保留
    expect(docAfter.implementationMetadata.implementationHash)
      .toBe(docBefore.implementationMetadata.implementationHash);      // 训练元数据整体未被改写
    expect(docAfter.models).toEqual(docBefore.models);                 // 训练统计/指纹不动
    expect(docAfter.baselineReproduction).toEqual(docBefore.baselineReproduction);
    expect(docAfter.bootstrap.ciRule).toMatch(/未舍入/);
    // 修订后重新审计必须通过（审计识别 statisticsRevision 并核验训练哈希保留）
    runCli(auditCli());
    const audit = JSON.parse(fs.readFileSync(auditPath(), 'utf8'));
    expect(audit.passed).toBe(true);
    expect(audit.implementation.revisionPresent).toBe(true);
    // 单种子聚合（seedsComplete=false）也应通过
    runCli(aggCli('42'));
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'multiseed-summary.json'), 'utf8'));
    expect(summary.seedsComplete).toBe(false);
    expect(summary.statisticsImplementationHash).toBe(docAfter.statisticsRevision.statisticsImplementationHash);
  });

  test('restat 拒绝：预测文件与 results 记录不一致时必须显式重训', () => {
    const original = fs.readFileSync(predsPath(), 'utf8');
    try {
      const lines = original.trim().split('\n');
      const first = JSON.parse(lines[0]);
      first.preds['GCN-DKT'] = Number((first.preds['GCN-DKT'] * 0.9).toFixed(6));
      lines[0] = JSON.stringify(first);
      fs.writeFileSync(predsPath(), lines.join('\n') + '\n');
      expectCliFail([E()('graphDktExperiment.js'), '--stage', 'restat', '--seed', '42',
        '--config', configFile, '--input-dir', outDir], /统计修订|重训/);
    } finally {
      fs.writeFileSync(predsPath(), original);
      runCli(auditCli());
    }
  });

  test('evaluateMetricsPrecise：未舍入指标 vs evaluateMetrics 的 4 位展示值（舍入边界回归）', () => {
    const rows = [{ pred: 0.311, target: 1 }, { pred: 0.3, target: 0 }];
    const precise = evalMod.evaluateMetricsPrecise(rows);
    const shown = evalMod.evaluateMetrics(rows);
    // Brier 精确值 = ((1-0.311)^2 + 0.3^2)/2 = 0.2823605，4 位舍入后 0.2824
    expect(precise.Brier).toBeCloseTo(0.2823605, 12);
    expect(shown.Brier).toBe(0.2824);
    expect(precise.Brier).not.toBe(shown.Brier);
    // LogLoss 精确值有更低有效位，4 位舍入会丢掉
    expect(precise.LogLoss).toBeGreaterThan(0);
    expect(shown.LogLoss).toBe(Number(precise.LogLoss.toFixed(4)));
    expect(precise.LogLoss).not.toBe(shown.LogLoss);
    // AUC / 口径一致性：evaluateMetrics 必须恒等于 precise 的 4 位舍入（单一实现）
    expect(shown.AUC).toBe(1);
    expect(precise.AUC).toBe(1);
    // 单类样本：AUC 无定义 → 两者一致返回 null
    const single = evalMod.evaluateMetricsPrecise([{ pred: 0.4, target: 1 }, { pred: 0.6, target: 1 }]);
    expect(single.AUC).toBeNull();
    expect(evalMod.evaluateMetrics([{ pred: 0.4, target: 1 }, { pred: 0.6, target: 1 }]).AUC).toBeNull();
  });

  test('聚合主表精度（P2 回归）：meanExact 必须来自预测重算的未舍入指标', () => {
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'multiseed-summary.json'), 'utf8'));
    // 测试内独立重算 seed 42 GCN 的未舍入 LogLoss，与聚合器 meanExact 对账（1e-12）
    const targetsDoc = JSON.parse(fs.readFileSync(path.join(seedDir(), 'targets.json'), 'utf8'));
    const lines = fs.readFileSync(predsPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rows = lines.map((l, i) => ({ ...targetsDoc.targets[i], pred: l.preds['GCN-DKT'] }));
    const raw = evalMod.evaluateMetricsPrecise(rows);
    const rec = summary.perModelStats['GCN-DKT'].LogLoss;
    expect(rec.meanExact).toBeCloseTo(raw.LogLoss, 12);
    expect(rec.inputRule).toMatch(/未舍入/);
    expect(summary.mainTableInputRule).toMatch(/未舍入/);
    // 未舍入明细必须真的带更低有效位（否则说明聚合器退回了 4 位舍入输入）
    const ll = summary.perSeedExact['GCN-DKT'][0].LogLoss;
    expect(ll).not.toBe(Number(ll.toFixed(4)));
    expect(summary.perSeedExact['GCN-DKT'][0].seed).toBe(42);
    // 旧口径（舍入记录求均值）留痕，便于审计对照第 4 位小数差异
    expect(typeof rec.meanFromStoredRounded).toBe('number');
    expect(rec.mean).toBe(Number(rec.meanExact.toFixed(6)));
    expect(rec.populationStd).toBe(Number(rec.populationStdExact.toFixed(6)));
  });
});

// 供 CLI 测试使用的配置文件写入（配置对象来自内存 buildConfig）
function writeConfigFile(fx, config) {
  const file = path.join(path.dirname(fx.rawPath), 'exp-config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
