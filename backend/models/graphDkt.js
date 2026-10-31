/**
 * GraphDKT：图增强 DKT 五组对照实验统一模型（方案 §5、§7）
 *
 * 五组（结果键见 MODEL_KEYS），同一套 GRU 代码，唯一结构变量是输入路径与邻接矩阵：
 *   Full-DKT        原始交互 embedding，无图分支，hidden=64（与已验收 Full 逐位兼容）
 *   GCN-DKT         交互 embedding + 真实图两层残差图分支，hidden=64
 *   RandomGraph-DKT 同 GCN 分支，邻接换为同边数同边权多重集随机图
 *   Larger-DKT      无图分支，GRU hidden=68（参数量近似对照）
 *   SelfLoop-DKT    同 GCN 分支，Anorm = I（隔离逐节点两层编码器的影响）
 *
 * 图分支（残差式，方案 §5.1）：
 *   X[k] = (E[2k] + E[2k+1]) / 2          节点初始特征来自可学习 E，无任何 response/标签信息
 *   U    = Anorm X W1 + b1                首层 ReLU
 *   V    = ReLU(U)
 *   Z    = Anorm V W2 + b2                第二层线性
 *   x_t  = E[2*k_t + r_t] + Z[k_t]        残差系数固定 1，无可学习门控
 *   输入 dropout 0.2 统一施加在最终 x_t 上（mask 同时作用于直达路径与图分支路径）。
 *
 * 反向传播与缓存（方案 §7.4）：
 *   - Z 依赖当前 E，每次参数更新（Adam step / 最优参数回滚）后缓存失效并重算；
 *     一个 batch 内参数不变，图前向每序列组只算一次（按 _paramVersion 缓存）。
 *   - 图分支梯度传到 X 后，以 1/2 分别加到对应 KP 的正确/错误两行 E；
 *     同时保留交互输入直达 E 的梯度。
 *   - 梯度裁剪合并全部可训练参数（含 W1/W2/b1/b2），复用父类 clipGrad。
 *
 * 初始化与随机流（方案 §7.3）：
 *   - 基础参数（E/GRU/输出头）由父类构造用 mulberry32(seed) 初始化，Full 逐位一致；
 *   - 图层 W1/W2/b1/b2 用独立随机流 mulberry32(seed ^ GRAPH_INIT_SALT) 初始化，
 *     不消耗基础参数或 dropout 随机流；三组图模型（GCN/Random/SelfLoop）在同种子下
 *     图层初始化完全一致；
 *   - b1/b2 零初始化；W1/W2 为 ±sqrt(2/(D+D)) 均匀分布，与父类权重初始化规则同族。
 *
 * 直接改参数（测试/有限差分）必须调用 invalidateGraphCache()，否则图缓存不刷新。
 * 正规参数变更路径（adamUpdate / fit 回滚）自动失效缓存。
 */

const path = require('path');
const fs = require('fs');
const { GruDkt } = require('./dkt');
const { mulberry32 } = require('./bootstrapStats');

// 构图模块（adjacencyFromEdges / symmetricNormalize）双布局解析：
//   仓库：backend/models → backend/scripts
//   材料包：model/ → scripts/（或 backend/models → backend/scripts）
function resolveModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('找不到模块，尝试过：' + candidates.join(' ; '));
}

const graphScript = resolveModule([
  path.join(__dirname, '..', 'scripts', 'buildAssist2009SkillGraph.js'),
  path.join(__dirname, '..', '..', 'scripts', 'buildAssist2009SkillGraph.js')
]);

const GRAPH_MODES = ['full', 'gcn', 'random-graph', 'larger', 'selfloop'];
const MODEL_KEYS = {
  full: 'Full-DKT',
  gcn: 'GCN-DKT',
  'random-graph': 'RandomGraph-DKT',
  larger: 'Larger-DKT',
  selfloop: 'SelfLoop-DKT'
};
const LARGER_HIDDEN_SIZE = 68;
// 图层独立初始化随机流的固定盐值（与 dropout 流 0x9e3779b9、构图 graphSeed 均不同源）
const GRAPH_INIT_SALT = 0x5f356495;

function isGraphMode(mode) {
  return mode === 'gcn' || mode === 'random-graph' || mode === 'selfloop';
}

/** 由无向边表（{i,j,w}，无自环）构造「原始」对称邻接（无自环、未归一化；模型内部再统一加环归一化） */
function rawAdjacencyFromEdges(edgeList, K) {
  return graphScript.adjacencyFromEdges(edgeList, K);
}

/** 原始邻接校验：K×K、有限、非负、对称、对角为零（拒绝已加自环矩阵） */
function validateRawAdjacency(raw, K) {
  if (raw.length !== K * K) {
    throw new Error(`adjacency 长度应为 K×K=${K * K}，收到 ${raw.length}`);
  }
  for (let i = 0; i < K; i++) {
    if (raw[i * K + i] !== 0) {
      throw new Error(`adjacency 对角必须为 0（不要传已加自环/已归一化的矩阵）：A[${i},${i}]=${raw[i * K + i]}`);
    }
    for (let j = i + 1; j < K; j++) {
      const a = raw[i * K + j], b = raw[j * K + i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`adjacency 存在非有限值：A[${i},${j}]=${a}, A[${j},${i}]=${b}`);
      }
      if (a < 0 || b < 0) {
        throw new Error(`adjacency 不允许负值：A[${i},${j}]=${a}, A[${j},${i}]=${b}`);
      }
      if (a !== b) {
        throw new Error(`adjacency 必须对称：A[${i},${j}]=${a} ≠ A[${j},${i}]=${b}`);
      }
    }
  }
}

class GraphDkt extends GruDkt {
/**
 * @param vocab {kpList, kpIndex, vocabSize, numSkills}
 * @param hyper 父类超参 + { modelMode, adjacency }
 *   modelMode  五组之一（默认 'full'）
 *   adjacency  gcn / random-graph 模式必填：K×K 行主序「原始」对称邻接
 *              （无自环、无单位环；非对称/负值/非有限/对角非零一律拒绝），
 *              模型内部统一加单位自环并做对称归一化；selfloop 模式忽略并使用 Anorm=I；
 *              full / larger 模式传入 adjacency 视为配置错误。
 *   词表校验：inputMode（若提供）必须为 'full'，且 vocabSize === 2 × numSkills，
 *   防止以 no-response 词表（vocabSize=K）绕过检查导致节点特征越界产生非有限值。
 */
  constructor(vocab, hyper = {}) {
    const modelMode = hyper.modelMode || 'full';
    if (!GRAPH_MODES.includes(modelMode)) {
      throw new Error(`未知模型模式: ${modelMode}（可选：${GRAPH_MODES.join(', ')}）`);
    }
    if (hyper.inputMode && hyper.inputMode !== 'full') {
      throw new Error(`图增强五组对照只允许 full 输入编码，收到: ${hyper.inputMode}`);
    }
    if (vocab.inputMode !== undefined && vocab.inputMode !== 'full') {
      throw new Error(`词表 inputMode 必须为 'full'，收到: ${vocab.inputMode}（no-response 等编码会绕过历史 response）`);
    }
    if (vocab.vocabSize !== 2 * vocab.numSkills) {
      throw new Error(`词表大小不一致：vocabSize=${vocab.vocabSize} 应为 2 × numSkills=${2 * vocab.numSkills}（经典 DKT 编码 2k+r）`);
    }
    if (!isGraphMode(modelMode) && hyper.adjacency) {
      throw new Error(`${MODEL_KEYS[modelMode]} 无图分支，不允许传入 adjacency`);
    }
    if (isGraphMode(modelMode) && modelMode !== 'selfloop' && !hyper.adjacency) {
      throw new Error(`${MODEL_KEYS[modelMode]} 必须在构造时提供 K×K 原始对称邻接 adjacency`);
    }

    const hp = { ...hyper };
    if (modelMode === 'larger' && hp.hiddenSize === undefined) {
      hp.hiddenSize = LARGER_HIDDEN_SIZE;
    }
    delete hp.modelMode;
    delete hp.adjacency;
    super(vocab, hp);
    this.modelMode = modelMode;
    this._paramVersion = 0;
    this._graphCache = null;
    this._dzAcc = null; // 当前序列的图分支输出梯度累计（_forwardTrain 期间有效）
    this._rawAdjacency = null;

    if (isGraphMode(modelMode)) {
      const K = this.K, D = this.D;
      if (modelMode === 'selfloop') {
        this.A = graphScript.selfloopAdjacency(K); // Anorm = I（方案 §5.2）
      } else {
        this._rawAdjacency = Float64Array.from(hyper.adjacency);
        validateRawAdjacency(this._rawAdjacency, K);
        this.A = graphScript.symmetricNormalize(this._rawAdjacency, K).Anorm;
      }
      // 图层参数：独立随机流，不消耗基础参数/ dropout 流；三图组同种子完全一致。
      // 种子取合并默认值后的 this.hp.seed（缺省 seed 与显式 seed:42 严格等价）
      const rand = mulberry32((this.hp.seed ^ GRAPH_INIT_SALT) >>> 0);
      const scale = Math.sqrt(2 / (D + D));
      const uni = (n) => {
        const a = new Float64Array(n);
        for (let i = 0; i < n; i++) a[i] = (rand() * 2 - 1) * scale;
        return a;
      };
      this.params.W1 = uni(D * D);
      this.params.W2 = uni(D * D);
      this.params.b1 = new Float64Array(D);
      this.params.b2 = new Float64Array(D);
      this.grads.W1 = new Float64Array(D * D);
      this.grads.W2 = new Float64Array(D * D);
      this.grads.b1 = new Float64Array(D);
      this.grads.b2 = new Float64Array(D);
      this.m.W1 = new Float64Array(D * D);
      this.m.W2 = new Float64Array(D * D);
      this.m.b1 = new Float64Array(D);
      this.m.b2 = new Float64Array(D);
      this.v.W1 = new Float64Array(D * D);
      this.v.W2 = new Float64Array(D * D);
      this.v.b1 = new Float64Array(D);
      this.v.b2 = new Float64Array(D);
    }
  }

  isGraphMode() {
    return isGraphMode(this.modelMode);
  }

  /** 参数被修改（Adam step / fit 回滚）后失效图缓存；直接改参数请用 invalidateGraphCache */
  _afterParamsMutated() {
    this._paramVersion++;
    this._graphCache = null;
  }

  /** 直接修改参数后必须调用，强制下次使用重算图分支 */
  invalidateGraphCache() {
    this._graphCache = null;
  }

  /** 更换邻接（仅 gcn / random-graph）：接收「原始」邻接，校验后重新归一化并失效图缓存（M14 结构生效用） */
  replaceAdjacency(rawAdjacency) {
    if (!isGraphMode(this.modelMode) || this.modelMode === 'selfloop') {
      throw new Error(`${MODEL_KEYS[this.modelMode]} 不允许更换邻接`);
    }
    const K = this.K;
    const raw = Float64Array.from(rawAdjacency);
    validateRawAdjacency(raw, K);
    this._rawAdjacency = raw;
    this.A = graphScript.symmetricNormalize(raw, K).Anorm;
    this._graphCache = null;
  }

  /** 图分支前向（始终基于当前参数新算，不走缓存）；返回 {X, AX, U, V, AV, Z}（K×D 行主序） */
  graphForward() {
    const { E, W1, W2, b1, b2 } = this.params;
    const K = this.K, D = this.D, A = this.A;

    const X = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        X[k * D + d] = (E[(2 * k) * D + d] + E[(2 * k + 1) * D + d]) / 2;
      }
    }
    // AX = A·X
    const AX = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let m = 0; m < K; m++) {
        const a = A[k * K + m];
        if (a === 0) continue;
        for (let d = 0; d < D; d++) AX[k * D + d] += a * X[m * D + d];
      }
    }
    // U = AX·W1 + b1；V = ReLU(U)
    const U = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let e = 0; e < D; e++) {
        let acc = b1[e];
        for (let d = 0; d < D; d++) acc += AX[k * D + d] * W1[d * D + e];
        U[k * D + e] = acc;
      }
    }
    const V = new Float64Array(K * D);
    for (let i = 0; i < V.length; i++) V[i] = U[i] > 0 ? U[i] : 0;
    // AV = A·V；Z = AV·W2 + b2
    const AV = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let m = 0; m < K; m++) {
        const a = A[k * K + m];
        if (a === 0) continue;
        for (let d = 0; d < D; d++) AV[k * D + d] += a * V[m * D + d];
      }
    }
    const Z = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let e = 0; e < D; e++) {
        let acc = b2[e];
        for (let d = 0; d < D; d++) acc += AV[k * D + d] * W2[d * D + e];
        Z[k * D + e] = acc;
      }
    }
    return { X, AX, U, V, AV, Z };
  }

  _ensureGraphCache() {
    if (!this._graphCache || this._graphCache.version !== this._paramVersion) {
      this._graphCache = { version: this._paramVersion, ...this.graphForward() };
    }
    return this._graphCache;
  }

  // ---------- 输入路径钩子覆盖（图模式） ----------

  _trainInput(id, E, masks) {
    if (!this.isGraphMode()) return super._trainInput(id, E, masks);
    const D = this.D;
    const gc = this._ensureGraphCache();
    const row = id * D;
    const zRow = (id >> 1) * D; // 输入编码为 2*k+r，图残差取同一输入 KP 的节点向量
    if (this.training) {
      const keep = 1 - this.hp.dropout;
      const mask = new Float64Array(D);
      for (let d = 0; d < D; d++) mask[d] = this.trainRng() < keep ? 1 / keep : 0;
      const xd = new Float64Array(D);
      for (let d = 0; d < D; d++) xd[d] = (E[row + d] + gc.Z[zRow + d]) * mask[d];
      masks.push(mask);
      return xd;
    }
    masks.push(null);
    const xd = new Float64Array(D);
    for (let d = 0; d < D; d++) xd[d] = E[row + d] + gc.Z[zRow + d];
    return xd;
  }

  _evalInput(id, E) {
    if (!this.isGraphMode()) return super._evalInput(id, E);
    const D = this.D;
    const gc = this._ensureGraphCache();
    const row = id * D;
    const zRow = (id >> 1) * D;
    const xd = new Float64Array(D);
    for (let d = 0; d < D; d++) xd[d] = E[row + d] + gc.Z[zRow + d];
    return xd;
  }

  _routeInputGrad(id, dxd, mask) {
    if (!this.isGraphMode()) return super._routeInputGrad(id, dxd, mask);
    const gE = this.grads.E;
    const D = this.D;
    const row = id * D;
    const zRow = (id >> 1) * D;
    const dZ = this._dzAcc;
    if (mask) {
      // dropout mask 同时作用于直达路径与图分支路径（方案 §7.4）
      for (let d = 0; d < D; d++) {
        const g = dxd[d] * mask[d];
        gE[row + d] += g;
        dZ[zRow + d] += g;
      }
    } else {
      for (let d = 0; d < D; d++) {
        gE[row + d] += dxd[d];
        dZ[zRow + d] += dxd[d];
      }
    }
  }

  // ---------- 训练前向：父类 BPTT + 图分支反向 ----------

  _forwardTrain(items) {
    if (!this.isGraphMode()) return super._forwardTrain(items);
    this._dzAcc = new Float64Array(this.K * this.D);
    try {
      const out = super._forwardTrain(items);
      this._graphBackward();
      return out;
    } finally {
      this._dzAcc = null;
    }
  }

  /** 图分支反向：dZ → W2/b2 → V → U → W1/b1 → X → E（各 1/2） */
  _graphBackward() {
    const dZ = this._dzAcc;
    if (!dZ) throw new Error('_graphBackward 只能在 _forwardTrain 内部调用');
    const gc = this._ensureGraphCache();
    const { X, AX, U, AV } = gc;
    const { W1, W2 } = this.params;
    const g = this.grads;
    const K = this.K, D = this.D, A = this.A;

    // gW2[d][e] += Σ_k AV[k][d]·dZ[k][e]；gb2[e] += Σ_k dZ[k][e]
    const gW2 = g.W2, gb2 = g.b2;
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        const av = AV[k * D + d];
        if (av === 0) continue;
        for (let e = 0; e < D; e++) gW2[d * D + e] += av * dZ[k * D + e];
      }
    }
    for (let k = 0; k < K; k++) {
      for (let e = 0; e < D; e++) gb2[e] += dZ[k * D + e];
    }
    // dAV[k][d] = Σ_e W2[d][e]·dZ[k][e]
    const dAV = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        let acc = 0;
        for (let e = 0; e < D; e++) acc += W2[d * D + e] * dZ[k * D + e];
        dAV[k * D + d] = acc;
      }
    }
    // dV = Aᵀ·dAV
    const dV = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      const dk = dAV.subarray(k * D, k * D + D);
      for (let m = 0; m < K; m++) {
        const a = A[k * K + m];
        if (a === 0) continue;
        for (let d = 0; d < D; d++) dV[m * D + d] += a * dk[d];
      }
    }
    // dU = dV ∘ 1[U > 0]；gW1[d][e] += Σ_k AX[k][d]·dU[k][e]；gb1[e] += Σ_k dU[k][e]
    const dU = new Float64Array(K * D);
    const gW1 = g.W1, gb1 = g.b1;
    for (let k = 0; k < K; k++) {
      for (let e = 0; e < D; e++) {
        if (U[k * D + e] > 0) dU[k * D + e] = dV[k * D + e];
      }
    }
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        const ax = AX[k * D + d];
        if (ax === 0) continue;
        for (let e = 0; e < D; e++) gW1[d * D + e] += ax * dU[k * D + e];
      }
    }
    for (let k = 0; k < K; k++) {
      for (let e = 0; e < D; e++) gb1[e] += dU[k * D + e];
    }
    // dAX[k][d] = Σ_e W1[d][e]·dU[k][e]；dX = Aᵀ·dAX
    const dAX = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        let acc = 0;
        for (let e = 0; e < D; e++) acc += W1[d * D + e] * dU[k * D + e];
        dAX[k * D + d] = acc;
      }
    }
    const dX = new Float64Array(K * D);
    for (let k = 0; k < K; k++) {
      for (let m = 0; m < K; m++) {
        const a = A[k * K + m];
        if (a === 0) continue;
        for (let d = 0; d < D; d++) dX[m * D + d] += a * dAX[k * D + d];
      }
    }
    // dX 以 1/2 加到对应 KP 的正确/错误两行 E
    const gE = g.E;
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < D; d++) {
        const g = dX[k * D + d] / 2;
        if (g === 0) continue;
        gE[(2 * k) * D + d] += g;
        gE[(2 * k + 1) * D + d] += g;
      }
    }
    void X; // X 不直接参与本层梯度（经 AX 间接），保留在缓存中供审计
  }

  copy() {
    const clone = new GraphDkt(
      { kpList: this.kpList, kpIndex: this.kpIndex, vocabSize: this.vocabSize, numSkills: this.numSkills },
      { ...this.hp, modelMode: this.modelMode, adjacency: this._rawAdjacency }
    );
    for (const key of Object.keys(this.params)) clone.params[key].set(this.params[key]);
    return clone;
  }
}

module.exports = {
  GRAPH_MODES,
  MODEL_KEYS,
  LARGER_HIDDEN_SIZE,
  GRAPH_INIT_SALT,
  isGraphMode,
  rawAdjacencyFromEdges,
  validateRawAdjacency,
  GraphDkt
};
