/**
 * graphDkt.test.js —— 图增强 DKT 五组模型与梯度测试（方案 §11.2 M01–M14）
 *
 * 全部使用小维度模型与合成 fixture，保证快速且确定性；
 * 有限差分按方案建议：Float64、中心差分、避开 ReLU 零点，
 * 绝对误差 < 1e-6 或稳定分母下相对误差 < 1e-3。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function resolveModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('找不到模块，尝试过：' + candidates.join(' ; '));
}

const dkt = resolveModule([
  path.join(__dirname, '..', 'models', 'dkt.js'),
  path.join(__dirname, '..', 'model', 'dkt.js')
]);
const graphDkt = resolveModule([
  path.join(__dirname, '..', 'models', 'graphDkt.js'),
  path.join(__dirname, '..', 'model', 'graphDkt.js')
]);
const graphScript = resolveModule([
  path.join(__dirname, '..', 'scripts', 'buildAssist2009SkillGraph.js'),
  path.join(__dirname, '..', '..', 'scripts', 'buildAssist2009SkillGraph.js')
]);
const { GruDkt, sigmoid } = dkt;
const { GraphDkt, GRAPH_MODES, MODEL_KEYS, rawAdjacencyFromEdges } = graphDkt;
const { adjacencyFromEdges, symmetricNormalize } = graphScript;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- 公共 fixture ----------

const KP_LIST = ['k1', 'k2', 'k3', 'k4'];
const VOCAB = {
  kpList: KP_LIST,
  kpIndex: new Map(KP_LIST.map((k, i) => [k, i])),
  vocabSize: 8,
  numSkills: 4
};

// 小图：k1-k2(权2)、k2-k3(权1)、k3-k4(权1)；k4 不作输入，仅作为 k3 的图邻居参与梯度。
// 注意：构造器接收「原始」邻接（无自环、未归一化），自环与归一化由模型内部统一完成。
const EDGES = [
  { i: 0, j: 1, w: 2 },
  { i: 1, j: 2, w: 1 },
  { i: 2, j: 3, w: 1 }
];
const ADJ = rawAdjacencyFromEdges(EDGES, 4);

const SEQ_A = {
  userId: 'uA',
  items: [
    { kpCode: 'k1', correct: 1 },
    { kpCode: 'k2', correct: 0 },
    { kpCode: 'k3', correct: 1 },
    { kpCode: 'k1', correct: 0 },
    { kpCode: 'k2', correct: 1 },
    { kpCode: 'k3', correct: 0 }
  ]
};
const SEQ_B = {
  userId: 'uB',
  items: [
    { kpCode: 'k3', correct: 0 },
    { kpCode: 'k1', correct: 1 },
    { kpCode: 'k2', correct: 1 },
    { kpCode: 'k3', correct: 1 }
  ]
};

const SMALL_HP = { embedDim: 4, hiddenSize: 6, dropout: 0.2, seed: 11 };

// 有学习信号的合成序列（正确率随练习上升）
function makeSeq(seed, len, userId) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const items = [];
  let m = 0.3;
  for (let t = 0; t < len; t++) {
    items.push({ kpCode: KP_LIST[t % 4], correct: rnd() < m ? 1 : 0 });
    m = Math.min(0.95, m + 0.03);
  }
  return { userId, items };
}

function finiteDiffCheck(model, keys, idxSelector, h = 1e-5) {
  model.training = true;
  model.zeroGrad();
  const items = SEQ_A.items;
  const loss0 = model._forwardTrain(items).logLoss;
  const ana = {};
  for (const key of keys) ana[key] = Float64Array.from(model.grads[key]);
  const lossOf = () => {
    model.zeroGrad();
    return model._forwardTrain(items).logLoss;
  };
  const report = [];
  for (const key of keys) {
    const p = model.params[key];
    for (const i of idxSelector(p)) {
      const orig = p[i];
      p[i] = orig + h;
      model.invalidateGraphCache();
      const l1 = lossOf();
      p[i] = orig - h;
      model.invalidateGraphCache();
      const l2 = lossOf();
      p[i] = orig;
      model.invalidateGraphCache();
      const num = (l1 - l2) / (2 * h);
      const absErr = Math.abs(num - ana[key][i]);
      const rel = absErr / Math.max(1e-5, Math.abs(num) + Math.abs(ana[key][i]));
      report.push({ key, i, num, ana: ana[key][i], absErr, rel });
      if (!(absErr < 1e-6 || rel < 1e-3)) {
        throw new Error(
          `有限差分失败 ${key}[${i}]：解析=${ana[key][i]}，数值=${num}，absErr=${absErr}，rel=${rel}`
        );
      }
    }
  }
  return { loss0, report };
}

// ---------- 配置与模式校验 ----------

describe('模式与配置校验', () => {
  test('五种模式与结果键映射齐全', () => {
    expect(GRAPH_MODES).toEqual(['full', 'gcn', 'random-graph', 'larger', 'selfloop']);
    expect(MODEL_KEYS.full).toBe('Full-DKT');
    expect(MODEL_KEYS.gcn).toBe('GCN-DKT');
    expect(MODEL_KEYS['random-graph']).toBe('RandomGraph-DKT');
    expect(MODEL_KEYS.larger).toBe('Larger-DKT');
    expect(MODEL_KEYS.selfloop).toBe('SelfLoop-DKT');
  });

  test('未知模式报错；gcn/random 缺邻接报错；full 传邻接报错', () => {
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'nope' })).toThrow(/未知模型模式/);
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn' })).toThrow(/adjacency/);
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'random-graph' })).toThrow(/adjacency/);
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'full', adjacency: ADJ })).toThrow(/不允许传入 adjacency/);
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'larger', adjacency: ADJ })).toThrow(/不允许传入 adjacency/);
  });

  test('非 full 输入编码被拒绝（五组对照只允许 full 编码）', () => {
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ, inputMode: 'same-kp' }))
      .toThrow(/full 输入编码/);
  });

  test('词表 inputMode 非 full 被拒绝（防止 no-response 词表绕过历史 response）', () => {
    const badVocab = { ...VOCAB, inputMode: 'no-response' };
    for (const mode of GRAPH_MODES) {
      expect(() => new GraphDkt(badVocab, { ...SMALL_HP, modelMode: mode, adjacency: ADJ }))
        .toThrow(/词表 inputMode/);
    }
  });

  test('vocabSize ≠ 2 × numSkills 被拒绝（防止节点特征越界产生非有限值）', () => {
    const badVocab = { ...VOCAB, vocabSize: 4 }; // K=4 的 no-response 词表
    for (const mode of GRAPH_MODES) {
      expect(() => new GraphDkt(badVocab, { ...SMALL_HP, modelMode: mode, adjacency: ADJ }))
        .toThrow(/词表大小不一致/);
    }
    // 合法语表下节点特征全部有限
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    const { X, Z } = m.graphForward();
    for (const v of [...X, ...Z]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('原始邻接校验与归一化（P1 整改）', () => {
  test('两节点、边权 3：归一化后对角 0.25、非对角 0.75（先加自环再对称归一化，仅一次）', () => {
    const raw = rawAdjacencyFromEdges([{ i: 0, j: 1, w: 3 }], 2);
    const m = new GraphDkt(
      { kpList: ['a', 'b'], kpIndex: new Map([['a', 0], ['b', 1]]), vocabSize: 4, numSkills: 2 },
      { embedDim: 4, hiddenSize: 6, seed: 42, modelMode: 'gcn', adjacency: raw }
    );
    expect(m.A[0]).toBeCloseTo(0.25, 15); // Atilde[0][0]=1, D=4 → 1/4
    expect(m.A[3]).toBeCloseTo(0.25, 15);
    expect(m.A[1]).toBeCloseTo(0.75, 15); // 3/4
    expect(m.A[2]).toBeCloseTo(0.75, 15);
  });

  test('拒绝已加自环/已归一化矩阵、非对称、负值、非有限、错误长度（构造器与 replaceAdjacency）', () => {
    const K = 4;
    const mk = (fn) => {
      const a = new Float64Array(K * K);
      fn(a);
      return a;
    };
    const selfLooped = mk((a) => { a[0 * K + 0] = 1; a[0 * K + 1] = 1; a[1 * K + 0] = 1; }); // 已加环
    const asymmetric = mk((a) => { a[0 * K + 1] = 1; }); // 非对称
    const negative = mk((a) => { a[0 * K + 1] = -1; a[1 * K + 0] = -1; });
    const nonFinite = mk((a) => { a[2 * K + 3] = NaN; a[3 * K + 2] = NaN; });
    const cases = [
      [selfLooped, /对角必须为 0/],
      [asymmetric, /必须对称/],
      [negative, /不允许负值/],
      [nonFinite, /非有限/],
      [new Float64Array(3), /长度应为/]
    ];
    for (const [bad, pattern] of cases) {
      expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: bad })).toThrow(pattern);
      const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
      expect(() => m.replaceAdjacency(bad)).toThrow(pattern);
    }
    // 合法原始矩阵可通过
    expect(() => new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ })).not.toThrow();
  });
});

describe('缺省种子与显式默认种子等价（P2 整改）', () => {
  test('省略 seed 与显式 seed:42 的全部参数（含图层 W1/W2/b1/b2）逐位一致', () => {
    const implicit = new GraphDkt(VOCAB, { embedDim: 4, hiddenSize: 6, dropout: 0.2, modelMode: 'gcn', adjacency: ADJ });
    const explicit = new GraphDkt(VOCAB, { embedDim: 4, hiddenSize: 6, dropout: 0.2, seed: 42, modelMode: 'gcn', adjacency: ADJ });
    expect(implicit.hp.seed).toBe(42);
    expect(explicit.hp.seed).toBe(42);
    for (const key of Object.keys(implicit.params)) {
      expect([...implicit.params[key]]).toEqual([...explicit.params[key]]);
    }
  });
});

describe('阶段 A 真实图接入（边表 → 模型内部邻接 → manifest 哈希一致）', () => {
  // 双布局解析：仓库 backend/实验结果文件；材料包顶层 实验结果文件
  const dir = ['../实验结果文件', '../../实验结果文件']
    .map((p) => path.join(__dirname, p, 'gcn-dkt-v1', 'seed-42'))
    .find((p) => fs.existsSync(p));
  if (!dir) throw new Error('找不到阶段 A 产物目录（gcn-dkt-v1/seed-42）');

  function parseEdgeCsv(csvPath) {
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('sourceIndex,targetIndex,sourceKp,targetKp,support');
    return lines.slice(1).map((line) => {
      const [i, j, sourceKp, targetKp, w] = line.split(',');
      return { i: Number(i), j: Number(j), sourceKp, targetKp, w: Number(w) };
    });
  }

  function checkAgainstManifest(kind) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, `graph-${kind}-manifest.json`), 'utf8'));
    const csvPath = path.join(dir, `graph-${kind}-edges.csv`);
    // 边 CSV 本体哈希与 manifest 记录一致（确认读取的就是阶段 A 产物）
    expect('sha256:' + sha256Hex(fs.readFileSync(csvPath))).toBe(manifest.graphEdgesSha256);
    const edges = parseEdgeCsv(csvPath);
    expect(edges.length).toBe(manifest.undirectedEdgeCount);
    // 原始边表 → 模型内部邻接 → 与 manifest 的 adjacencySha256 一致
    const vocab = JSON.parse(fs.readFileSync(path.join(dir, 'vocabulary.json'), 'utf8'));
    const modelVocab = {
      kpList: vocab.kpList,
      kpIndex: new Map(vocab.kpList.map((k, i) => [k, i])),
      vocabSize: vocab.kpList.length * 2,
      numSkills: vocab.kpList.length
    };
    const raw = rawAdjacencyFromEdges(edges, modelVocab.numSkills);
    const m = new GraphDkt(modelVocab, { embedDim: 32, hiddenSize: 64, seed: manifest.splitSeed, modelMode: 'gcn', adjacency: raw });
    expect('sha256:' + sha256Hex(Buffer.from(m.A.buffer))).toBe(manifest.adjacencySha256);
    // 与构图模块的对称归一化逐元素一致
    const expectAnorm = symmetricNormalize(adjacencyFromEdges(edges, modelVocab.numSkills), modelVocab.numSkills).Anorm;
    expect([...m.A]).toEqual([...expectAnorm]);
    return manifest;
  }

  test('真实图（seed-42）：边 CSV 哈希 + 模型邻接哈希与 manifest 一致', () => {
    const manifest = checkAgainstManifest('real');
    expect(manifest.graphType).toBe('real-train-attempt-multiskill-coannotation');
    expect(manifest.nodeCount).toBe(100);
    expect(manifest.usesResponseValues).toBe(false);
  });

  test('随机图（seed-42）：同构校验同样通过', () => {
    const manifest = checkAgainstManifest('random');
    expect(manifest.graphType).toContain('random');
  });
});

// ---------- M01 / M02 ----------

describe('M01 Full 逐位兼容', () => {
  test('GraphDkt(full) 与 GruDkt 参数、前向逐位一致', () => {
    const base = new GruDkt(VOCAB, SMALL_HP);
    const gfull = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'full' });
    expect(gfull.paramCount()).toBe(base.paramCount());
    for (const key of Object.keys(base.params)) {
      expect([...gfull.params[key]]).toEqual([...base.params[key]]);
    }
    expect(gfull.predictSequence(SEQ_A.items)).toEqual(base.predictSequence(SEQ_A.items));
    expect(gfull.predictSequence(SEQ_B.items)).toEqual(base.predictSequence(SEQ_B.items));
  });

  test('GraphDkt(full) 训练曲线与最终参数与 GruDkt 一致', () => {
    const train = Array.from({ length: 12 }, (_, i) => makeSeq(i + 1, 10, `tr${i}`));
    const val = Array.from({ length: 4 }, (_, i) => makeSeq(500 + i, 10, `va${i}`));
    const base = new GruDkt(VOCAB, SMALL_HP);
    const gfull = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'full' });
    const r1 = base.fit(train, val);
    const r2 = gfull.fit(train, val);
    expect(r2.curve).toEqual(r1.curve);
    expect(r2.epochsRun).toBe(r1.epochsRun);
    expect(r2.bestEpoch).toBe(r1.bestEpoch);
    expect(r2.bestValLogLoss).toBe(r1.bestValLogLoss);
    expect(r2.stoppedEarly).toBe(r1.stoppedEarly);
    for (const key of Object.keys(base.params)) {
      expect([...gfull.params[key]]).toEqual([...base.params[key]]);
    }
  });
});

describe('M02 零图残差一致性', () => {
  test('同种子基础参数逐位相同；图参数清零后前向与 Full 逐项一致', () => {
    const base = new GruDkt(VOCAB, SMALL_HP);
    const gcn = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    // 基础参数（E/GRU/输出头）与 Full 同种子逐位一致（图层未消耗基础随机流）
    for (const key of Object.keys(base.params)) {
      expect([...gcn.params[key]]).toEqual([...base.params[key]]);
    }
    // 图层参数确实非零（否则本测试无意义）
    expect([...gcn.params.W1].some((v) => v !== 0)).toBe(true);
    // 清零图参数 → Z ≡ 0 → 输入与 Full 完全相同
    gcn.params.W1.fill(0);
    gcn.params.W2.fill(0);
    gcn.params.b1.fill(0);
    gcn.params.b2.fill(0);
    gcn.invalidateGraphCache();
    expect(gcn.predictSequence(SEQ_A.items)).toEqual(base.predictSequence(SEQ_A.items));
    expect(gcn.predictSequence(SEQ_B.items)).toEqual(base.predictSequence(SEQ_B.items));
    // dropout=0 的训练前向 logLoss 也逐位一致
    base.training = true;
    gcn.training = true;
    expect(gcn._forwardTrain(SEQ_A.items).logLoss).toBe(base._forwardTrain(SEQ_A.items).logLoss);
  });
});

// ---------- M03 / M04 / M05 ----------

describe('M03 SelfLoop 定义（Anorm=I 等价逐节点两层编码器）', () => {
  test('A 为单位阵；Z[k] = ReLU(X[k]·W1+b1)·W2+b2 逐节点吻合', () => {
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'selfloop' });
    const K = 4, D = 4;
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) {
        expect(m.A[i * K + j]).toBe(i === j ? 1 : 0);
      }
    }
    const { X, Z } = m.graphForward();
    const { E, W1, W2, b1, b2 } = m.params;
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        expect(X[k * D + d]).toBeCloseTo((E[(2 * k) * D + d] + E[(2 * k + 1) * D + d]) / 2, 15);
      }
      const u = new Float64Array(D);
      for (let e = 0; e < D; e++) {
        let acc = b1[e];
        for (let d = 0; d < D; d++) acc += X[k * D + d] * W1[d * D + e];
        u[e] = acc;
      }
      for (let e = 0; e < D; e++) {
        let acc = b2[e];
        for (let d = 0; d < D; d++) acc += (u[d] > 0 ? u[d] : 0) * W2[d * D + e];
        expect(Z[k * D + e]).toBe(acc); // 逐位一致（相同求和顺序）
      }
    }
  });
});

describe('M04 三图模型容量一致', () => {
  test('GCN/RandomGraph/SelfLoop 参数键、形状与数量完全相同', () => {
    const hyper = { ...SMALL_HP };
    const gcn = new GraphDkt(VOCAB, { ...hyper, modelMode: 'gcn', adjacency: ADJ });
    const rand = new GraphDkt(VOCAB, { ...hyper, modelMode: 'random-graph', adjacency: ADJ });
    const self = new GraphDkt(VOCAB, { ...hyper, modelMode: 'selfloop' });
    const keys = Object.keys(gcn.params).sort();
    expect(Object.keys(rand.params).sort()).toEqual(keys);
    expect(Object.keys(self.params).sort()).toEqual(keys);
    for (const key of keys) {
      expect(rand.params[key].length).toBe(gcn.params[key].length);
      expect(self.params[key].length).toBe(gcn.params[key].length);
    }
    expect(rand.paramCount()).toBe(gcn.paramCount());
    expect(self.paramCount()).toBe(gcn.paramCount());
    // 同种子下图层初始化完全一致（独立流，与邻接无关）
    expect([...rand.params.W1]).toEqual([...gcn.params.W1]);
    expect([...self.params.W2]).toEqual([...gcn.params.W2]);
  });
});

describe('M05 参数量断言（K=100, D=32）', () => {
  const K100 = {
    kpList: Array.from({ length: 100 }, (_, i) => `kp${i}`),
    kpIndex: new Map(Array.from({ length: 100 }, (_, i) => [`kp${i}`, i])),
    vocabSize: 200,
    numSkills: 100
  };
  test('Full 31,524；图模型 33,636；Larger 33,904（差 268 < 1%）', () => {
    const full = new GraphDkt(K100, { embedDim: 32, hiddenSize: 64, seed: 42, modelMode: 'full' });
    const adj100 = new Float64Array(100 * 100);
    adj100[0 * 100 + 1] = 1; adj100[1 * 100 + 0] = 1;
    const gcn = new GraphDkt(K100, { embedDim: 32, hiddenSize: 64, seed: 42, modelMode: 'gcn', adjacency: adj100 });
    const larger = new GraphDkt(K100, { embedDim: 32, seed: 42, modelMode: 'larger' }); // 默认 hidden=68
    expect(full.paramCount()).toBe(31524);
    expect(gcn.paramCount()).toBe(33636);
    expect(larger.paramCount()).toBe(33904);
    const diff = larger.paramCount() - gcn.paramCount();
    expect(diff).toBe(268);
    expect(diff / gcn.paramCount()).toBeLessThan(0.01);
  });
});

// ---------- M06 / M07 ----------

describe('M06 当前标签不泄漏', () => {
  test('改 t 的 response 不改变 t 的预测，但改变后续预测（图模式）', () => {
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    const items = SEQ_A.items.map((it) => ({ ...it }));
    const p1 = m.predictSequence(items);
    const mutated = items.map((it, i) => (i === 2 ? { ...it, correct: it.correct ? 0 : 1 } : it));
    const p2 = m.predictSequence(mutated);
    expect(p2[1].pred).toBe(p1[1].pred); // t=2 的预测只依赖 h_2（x_0..x_1）
    expect(p2[2].pred).not.toBe(p1[2].pred); // t=3 起历史输入变化
  });
});

describe('M07 目标端口使用原始目标 KP', () => {
  test('Wout 清零、各 KP 偏置不同，预测 = 原始目标 KP 的偏置', () => {
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    m.params.Wout.fill(0);
    m.params.bout.forEach((_, k) => { m.params.bout[k] = 0.13 * (k + 1); });
    m.invalidateGraphCache();
    for (const p of m.predictSequence(SEQ_A.items)) {
      const k = m.kpIndex.get(SEQ_A.items[p.t].kpCode);
      expect(p.kpCode).toBe(SEQ_A.items[p.t].kpCode);
      expect(p.pred).toBe(sigmoid(m.params.bout[k]));
    }
  });
});

// ---------- M08 / M09 ----------

describe('M08 图层与共享 E 的有限差分梯度校验', () => {
  test('W1/W2/b1/b2 与 E（含仅图路径行）中心差分通过（dropout=0）', () => {
    const m = new GraphDkt(VOCAB, { embedDim: 4, hiddenSize: 6, dropout: 0, seed: 23, modelMode: 'gcn', adjacency: ADJ });
    const { loss0, report } = finiteDiffCheck(
      m,
      ['W1', 'W2', 'b1', 'b2', 'E'],
      (p) => [0, Math.floor(p.length / 2), p.length - 1]
    );
    expect(Number.isFinite(loss0)).toBe(true);
    expect(report.length).toBe(15);
    // E 抽查应覆盖图路径唯一贡献的行（KP4 的两行，位于 E 末尾）
    expect(report.some((r) => r.key === 'E' && r.i >= 6)).toBe(true);
  });
});

describe('M09 双路径 E 梯度', () => {
  test('直达路径与图路径梯度同时存在；图路径对正确/错误两行各分配 1/2', () => {
    const m = new GraphDkt(VOCAB, { embedDim: 4, hiddenSize: 6, dropout: 0, seed: 23, modelMode: 'gcn', adjacency: ADJ });
    m.training = true;
    m.zeroGrad();
    m._forwardTrain(SEQ_A.items);
    const gE = m.grads.E;
    const D = 4;
    // 直达路径：k1 wrong 行（id=0）被用作输入，必有直达梯度
    expect(gE[0]).not.toBe(0);
    // 图路径：k4（idx=3）从未作输入，但与 k3 相邻 → dZ(k3) 经图传播到 dX(k4)，
    // 以 1/2 分别写入 k4 两行（id=6/7 → 线性下标 6D/7D），两行逐位相等且非零
    expect(gE[6 * D]).not.toBe(0);
    expect(gE[6 * D]).toBe(gE[7 * D]);
    // 用 graphBackward 复算 0.5·dX(k4) 验证分配比例：直接路径不污染这两行
    m.zeroGrad();
    const dZprobe = new Float64Array(4 * 4);
    // 手工构造 dZ：只在 k3（idx=2）位置注入单位向量，走图分支反向
    dZprobe[2 * 4 + 0] = 1;
    m._dzAcc = dZprobe;
    m._graphBackward();
    m._dzAcc = null;
    const gE2 = m.grads.E;
    expect(gE2[6 * D]).not.toBe(0);
    expect(gE2[6 * D]).toBe(gE2[7 * D]); // 1/2 + 1/2 分配 → 两行相等
  });
});

// ---------- M10 / M11 / M12 ----------

describe('M10 图层参数实际更新', () => {
  test('小样本训练后 W1/W2/b1/b2 相对初始化发生变化', () => {
    const train = Array.from({ length: 10 }, (_, i) => makeSeq(i + 1, 10, `tr${i}`));
    const val = Array.from({ length: 3 }, (_, i) => makeSeq(900 + i, 10, `va${i}`));
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    const before = {
      W1: Float64Array.from(m.params.W1),
      W2: Float64Array.from(m.params.W2),
      b1: Float64Array.from(m.params.b1),
      b2: Float64Array.from(m.params.b2)
    };
    m.fit(train, val, { });
    for (const key of ['W1', 'W2', 'b1', 'b2']) {
      expect([...m.params[key]]).not.toEqual([...before[key]]);
    }
  });
});

describe('M11 图缓存失效', () => {
  test('adamUpdate 后缓存失效，预测与 freshly 复制参数的参考模型一致', () => {
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    const p0 = m.predictSequence(SEQ_A.items);
    expect(m._graphCache).not.toBeNull();
    const v0 = m._paramVersion;
    m.zeroGrad();
    for (const key of Object.keys(m.grads)) m.grads[key][0] = 0.01;
    m.adamUpdate();
    expect(m._paramVersion).toBe(v0 + 1);
    expect(m._graphCache).toBeNull();
    const p1 = m.predictSequence(SEQ_A.items);
    const ref = m.copy(); // 全新缓存，从当前参数重算
    expect(m.predictSequence(SEQ_A.items)).toEqual(ref.predictSequence(SEQ_A.items));
    expect(p1.some((p, i) => p.pred !== p0[i].pred)).toBe(true);
  });

  test('fit 最优参数回滚后缓存刷新：预测与参数快照参考一致；回滚钩子被调用', () => {
    const train = Array.from({ length: 8 }, (_, i) => makeSeq(i + 1, 8, `tr${i}`));
    const val = Array.from({ length: 3 }, (_, i) => makeSeq(700 + i, 8, `va${i}`));
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    let hookCalls = 0;
    const orig = m._afterParamsMutated.bind(m);
    m._afterParamsMutated = () => { hookCalls++; orig(); };
    m.fit(train, val);
    expect(hookCalls).toBeGreaterThan(0);
    const ref = m.copy();
    expect(m.predictSequence(SEQ_A.items)).toEqual(ref.predictSequence(SEQ_A.items));
  });

  test('手工回滚参数（+失效钩子）后预测恢复，缺失失效则不会恢复', () => {
    const m = new GraphDkt(VOCAB, { embedDim: 4, hiddenSize: 6, dropout: 0, seed: 31, modelMode: 'gcn', adjacency: ADJ });
    const snapshot = {};
    for (const key of Object.keys(m.params)) snapshot[key] = Float64Array.from(m.params[key]);
    const p0 = m.predictSequence(SEQ_A.items);
    // 一次参数更新
    m.zeroGrad();
    for (const key of Object.keys(m.grads)) m.grads[key][0] = 0.05;
    m.adamUpdate();
    const p1 = m.predictSequence(SEQ_A.items);
    expect(p1.some((p, i) => p.pred !== p0[i].pred)).toBe(true);
    // 回滚 + 失效
    for (const key of Object.keys(m.params)) m.params[key].set(snapshot[key]);
    m._afterParamsMutated();
    const ref = m.copy();
    expect(m.predictSequence(SEQ_A.items)).toEqual(ref.predictSequence(SEQ_A.items));
  });
});

describe('M12 全参数裁剪（含图层）', () => {
  test('合并梯度范数被裁到上限内，且所有参数（含图层）按同一比例缩放', () => {
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    for (const key of Object.keys(m.grads)) {
      const g = m.grads[key];
      for (let i = 0; i < g.length; i++) g[i] = ((i % 7) - 3) * 0.5 + 0.1;
    }
    const normOf = () => {
      let sq = 0;
      for (const g of Object.values(m.grads)) for (let i = 0; i < g.length; i++) sq += g[i] * g[i];
      return Math.sqrt(sq);
    };
    expect(normOf()).toBeGreaterThan(5);
    const before = {};
    for (const key of Object.keys(m.grads)) before[key] = Float64Array.from(m.grads[key]);
    m.clipGrad(5);
    expect(normOf()).toBeLessThanOrEqual(5 + 1e-9);
    // 同一比例缩放：取每个参数组首元素比值应一致
    const ratios = Object.keys(m.grads).map((key) => m.grads[key][0] / before[key][0]);
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0], 12);
    expect(ratios[0]).toBeLessThan(1);
  });
});

// ---------- M13 / M14 ----------

describe('M13 学生状态隔离', () => {
  test('不同学生 h 从零开始；图参数共享但个人状态不串流', () => {
    const m = new GraphDkt(VOCAB, { ...SMALL_HP, modelMode: 'gcn', adjacency: ADJ });
    const bAlone = m.predictSequence(SEQ_B.items);
    m.predictSequence(SEQ_A.items); // 先跑学生 A
    const bAfter = m.predictSequence(SEQ_B.items);
    expect(bAfter).toEqual(bAlone);
  });
});

describe('M14 结构生效（模型确实读取图）', () => {
  test('更换邻接改变表示与预测；且与同邻接参考模型一致（缓存已失效）', () => {
    const hyper = { embedDim: 4, hiddenSize: 6, dropout: 0, seed: 37 };
    const m = new GraphDkt(VOCAB, { ...hyper, modelMode: 'gcn', adjacency: ADJ });
    const p1 = m.predictSequence(SEQ_A.items);
    // 换一张不同的图：仅 k1-k4 一条边
    const ADJ2 = rawAdjacencyFromEdges([{ i: 0, j: 3, w: 1 }], 4);
    m.replaceAdjacency(ADJ2);
    const p2 = m.predictSequence(SEQ_A.items);
    expect(p2.some((p, i) => p.pred !== p1[i].pred)).toBe(true);
    // 与「同参数 + 新邻接」的全新参考模型逐位一致（证明 replaceAdjacency 正确失效缓存）
    const ref = new GraphDkt(VOCAB, { ...hyper, modelMode: 'gcn', adjacency: ADJ2 });
    for (const key of Object.keys(ref.params)) ref.params[key].set(m.params[key]);
    ref.invalidateGraphCache();
    expect(m.predictSequence(SEQ_A.items)).toEqual(ref.predictSequence(SEQ_A.items));
    // SelfLoop（Anorm=I）与带边图在同一参数下预测也不同
    const self = new GraphDkt(VOCAB, { ...hyper, modelMode: 'selfloop' });
    for (const key of Object.keys(self.params)) self.params[key].set(m.params[key]);
    self.invalidateGraphCache();
    const pSelf = self.predictSequence(SEQ_A.items);
    expect(pSelf.some((p, i) => Math.abs(p.pred - p2[i].pred) > 1e-12)).toBe(true);
  });
});
