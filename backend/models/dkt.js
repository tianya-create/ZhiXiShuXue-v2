/**
 * GRU-DKT：深度知识追踪对照实验（最小实现）
 *
 * 定位：不是复杂知识图谱模型，而是「深度知识追踪对照实验」——
 * 在与规则基线 / BKT 同一条数据管线上，检验基础深度模型能否带来增益。
 * 核心目标（对照基线为 assist2009 学生级协议下的数字）：
 *   - AUC 是否超过 Rule-0；
 *   - LogLoss 是否超过 BKT；
 *   - 是否利用了跨知识点、题目序列信息；
 *   - 是否在短序列数据上真正有效，而不是过拟合。
 *
 * 模型（经典 DKT 输入方式，Piech et al. 2015）：
 *   输入  interaction_id = 2 × kp_index + isCorrect
 *         （skill_1_correct = 2×0+1 / skill_1_wrong = 2×0+0 / skill_2_correct = 2×1+1 / ...）
 *   结构  Embedding → GRU(1 层) → Linear → Sigmoid
 *   输出  对「下一次作答的知识点 k」输出 P(答对) = σ(Wout[k]·h + bout[k])，
 *         等价于取经典 DKT 全知识点输出向量的第 k 维；损失只在有效目标位（t ≥ 1）
 *         计算，padding 不参与、也不会被当成错误答案。
 *
 * 评估协议（与 BKT 的前后半段协议刻意不同，两种协议不混在一张表里）：
 *   学生级 train/validation/test = 70%/15%/15%（固定种子按学生划分，同一学生
 *   不会同时出现在训练与测试）；对照模型（BKT/Rule-0/Majority）与 DKT 在
 *   同一 test 学生目标集上逐条预测。
 *
 * 纯 JS 实现（无 Python/torch 依赖，与项目 Node 栈一致）：
 *   GRU 前向 + 完整 BPTT + Adam + 全局范数梯度裁剪 + dropout（仅训练时，
 *   作用于 embedding 输出，inverted dropout）。全部 Float64Array，固定种子可复现。
 */

const { mulberry32 } = require('./bootstrapStats');

// ---------- 默认超参（第一版防过拟合配置，短序列数据不用大模型） ----------
const DEFAULT_HYPERPARAMS = {
  embedDim: 32,             // Embedding 维度
  hiddenSize: 64,           // GRU hidden size
  dropout: 0.2,             // embedding 输出 dropout（训练时）
  learningRate: 1e-3,
  batchSize: 64,            // 每批序列数（批内梯度平均后一步 Adam）
  maxEpochs: 50,
  earlyStoppingPatience: 5, // 验证集 LogLoss 连续 5 轮不下降即停止
  gradClipNorm: 5.0,
  bceEps: 1e-7,
  seed: 42
};

function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// ---------- 学生级序列构建 ----------

// 按学生分组、时间升序（与规则基线同一稳定排序：createdAt → attemptIndex → 原始行序）。
// 返回 [{userId, items:[{kpCode, correct, ts, record}]}]，交互数 ≥ minLen 的学生保留。
function buildStudentSequences(records, { minLen = 2 } = {}) {
  const { sortByTime } = require('./ruleMastery');
  const byUser = new Map();
  for (const item of sortByTime(records)) {
    if (!byUser.has(item.userId)) byUser.set(item.userId, []);
    byUser.get(item.userId).push({
      kpCode: item.kpCode,
      correct: item.isCorrect ? 1 : 0,
      ts: new Date(item.createdAt).getTime(),
      record: item
    });
  }
  const sequences = [];
  for (const [userId, items] of byUser) {
    if (items.length >= minLen) sequences.push({ userId, items });
  }
  sequences.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return sequences;
}

// 知识点词表：kpCode 升序 → 下标；交互 id = 2 × kpIndex + isCorrect
function buildVocab(sequences) {
  const kps = new Set();
  for (const seq of sequences) for (const it of seq.items) kps.add(it.kpCode);
  const kpList = [...kps].sort();
  const kpIndex = new Map(kpList.map((k, i) => [k, i]));
  return { kpList, kpIndex, vocabSize: kpList.length * 2, numSkills: kpList.length };
}

function encodeInteractionId(kpIndex, kpCode, correct) {
  const idx = kpIndex.get(kpCode);
  if (idx === undefined) throw new Error(`未知知识点: ${kpCode}`);
  return idx * 2 + (correct ? 1 : 0);
}

// ---------- 学生级 train/val/test 划分（固定种子，可复现） ----------
function splitStudents(userIds, { train = 0.7, validation = 0.15, seed = 42 } = {}) {
  const ids = [...userIds].sort();
  const rand = mulberry32(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const nTrain = Math.round(ids.length * train);
  const nVal = Math.round(ids.length * validation);
  return {
    train: ids.slice(0, nTrain),
    validation: ids.slice(nTrain, nTrain + nVal),
    test: ids.slice(nTrain + nVal),
    seed,
    fractions: { train, validation, test: Number((1 - train - validation).toFixed(4)) }
  };
}

// ---------- 模型 ----------
class GruDkt {
  /**
   * @param vocab {kpList, kpIndex, vocabSize, numSkills}
   * @param hyper 部分超参覆盖
   */
  constructor(vocab, hyper = {}) {
    const hp = { ...DEFAULT_HYPERPARAMS, ...hyper };
    this.hp = hp;
    this.kpList = vocab.kpList;
    this.kpIndex = vocab.kpIndex;
    this.vocabSize = vocab.vocabSize;
    this.numSkills = vocab.numSkills;
    const D = hp.embedDim, H = hp.hiddenSize, K = vocab.numSkills, V = vocab.vocabSize;
    this.D = D; this.H = H; this.K = K; this.V = V;

    const rand = mulberry32(hp.seed);
    const uniform = (n, scale) => {
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = (rand() * 2 - 1) * scale;
      return a;
    };
    const sIn = Math.sqrt(2 / (D + H));
    const sH = Math.sqrt(2 / (2 * H));
    const sOut = Math.sqrt(2 / (H + K));
    const sEmb = Math.sqrt(2 / D);

    this.params = {
      E: uniform(V * D, sEmb),
      Wz: uniform(D * H, sIn), Wr: uniform(D * H, sIn), Wh: uniform(D * H, sIn),
      Uz: uniform(H * H, sH), Ur: uniform(H * H, sH), Uh: uniform(H * H, sH),
      bz: new Float64Array(H), br: new Float64Array(H), bh: new Float64Array(H),
      Wout: uniform(K * H, sOut), // 每个知识点一行：Wout[k*H + j]
      bout: new Float64Array(K)
    };
    this.grads = {}; this.m = {}; this.v = {};
    for (const key of Object.keys(this.params)) {
      this.grads[key] = new Float64Array(this.params[key].length);
      this.m[key] = new Float64Array(this.params[key].length);
      this.v[key] = new Float64Array(this.params[key].length);
    }
    this.adamT = 0;
    this.trainRng = mulberry32(hp.seed ^ 0x9e3779b9); // dropout 与洗牌随机流（独立于初始化）
    this.training = false;
  }

  zeroGrad() {
    for (const key of Object.keys(this.grads)) this.grads[key].fill(0);
  }

  clipGrad(maxNorm) {
    let sq = 0;
    for (const g of Object.values(this.grads)) {
      for (let i = 0; i < g.length; i++) sq += g[i] * g[i];
    }
    const norm = Math.sqrt(sq);
    if (norm > maxNorm && norm > 0) {
      const scale = maxNorm / norm;
      for (const g of Object.values(this.grads)) {
        for (let i = 0; i < g.length; i++) g[i] *= scale;
      }
    }
    return norm;
  }

  adamUpdate(lr = this.hp.learningRate) {
    this.adamT++;
    const b1 = 0.9, b2 = 0.999, epsA = 1e-8;
    const c1 = 1 - Math.pow(b1, this.adamT);
    const c2 = 1 - Math.pow(b2, this.adamT);
    for (const key of Object.keys(this.params)) {
      const p = this.params[key], g = this.grads[key], m = this.m[key], v = this.v[key];
      for (let i = 0; i < p.length; i++) {
        m[i] = b1 * m[i] + (1 - b1) * g[i];
        v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
        p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + epsA);
      }
    }
  }

  copy() {
    const clone = new GruDkt(
      { kpList: this.kpList, kpIndex: this.kpIndex, vocabSize: this.vocabSize, numSkills: this.numSkills },
      this.hp
    );
    for (const key of Object.keys(this.params)) clone.params[key].set(this.params[key]);
    return clone;
  }

  paramCount() {
    return Object.values(this.params).reduce((a, p) => a + p.length, 0);
  }

  // ---------- 单步 GRU 前向：h' = GRU(x, h) ----------
  // 输出写入 hNew（调用方提供缓冲），并可选写入缓存数组（BPTT 用）
  _step(xd, hPrev, hNew, cache) {
    const { Wz, Wr, Wh, Uz, Ur, Uh, bz, br, bh } = this.params;
    const D = this.D, H = this.H;
    const z = cache ? cache.z : new Float64Array(H);
    const r = cache ? cache.r : new Float64Array(H);
    const hh = cache ? cache.hh : new Float64Array(H);
    const rh = cache ? cache.rh : new Float64Array(H);

    for (let j = 0; j < H; j++) {
      let zacc = bz[j], racc = br[j], hacc = bh[j];
      for (let d = 0; d < D; d++) {
        const xv = xd[d];
        zacc += Wz[d * H + j] * xv;
        racc += Wr[d * H + j] * xv;
        hacc += Wh[d * H + j] * xv;
      }
      // 隐状态侧：z/r 门与 hh 都依赖 hPrev
      for (let k = 0; k < H; k++) {
        const hv = hPrev[k];
        zacc += Uz[k * H + j] * hv;
        racc += Ur[k * H + j] * hv;
      }
      z[j] = sigmoid(zacc);
      r[j] = sigmoid(racc);
      rh[j] = r[j] * hPrev[j];
      hh[j] = hacc; // 暂存输入侧累计，下面补 Uh 项
    }
    for (let j = 0; j < H; j++) {
      let hacc = hh[j];
      for (let k = 0; k < H; k++) hacc += Uh[k * H + j] * rh[k];
      hh[j] = Math.tanh(hacc);
    }
    for (let j = 0; j < H; j++) hNew[j] = (1 - z[j]) * hPrev[j] + z[j] * hh[j];
  }

  // ---------- 训练前向：单序列前向 + BPTT，梯度累计进 this.grads ----------
  // 返回 { logLoss, targets }（目标位 t = 1..T-1）
  _forwardTrain(items) {
    const { E, Wz, Wr, Wh, Uz, Ur, Uh, Wout, bout } = this.params;
    const g = this.grads;
    const D = this.D, H = this.H;
    const eps = this.hp.bceEps;
    const keep = 1 - this.hp.dropout;
    const T = items.length;

    const ids = new Int32Array(T);
    for (let t = 0; t < T; t++) {
      ids[t] = this.kpIndex.get(items[t].kpCode) * 2 + items[t].correct;
    }

    // 前向缓存
    const xs = [];      // dropout 后输入
    const masks = [];   // dropout mask（null = 评估）
    const caches = [];  // {z, r, hh, rh, hPrev}
    const hSteps = [new Float64Array(H)]; // h_0 = 0
    const dhAcc = Array.from({ length: T + 1 }, () => null); // dhAcc[t] = 输出对 h_t 的梯度

    const hNew = new Float64Array(H);
    let logLoss = 0;
    let targets = 0;

    for (let t = 0; t < T; t++) {
      const hPrev = hSteps[t];
      // ---- 目标 t：用 h_t（x_0..x_{t-1} 的摘要）预测 items[t].correct ----
      if (t > 0) {
        const k = this.kpIndex.get(items[t].kpCode);
        const y = items[t].correct;
        let a = bout[k];
        const wRow = k * H;
        for (let j = 0; j < H; j++) a += Wout[wRow + j] * hPrev[j];
        const p = sigmoid(a);
        const pc = Math.min(1 - eps, Math.max(eps, p));
        logLoss += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
        targets++;
        const dA = p - y;
        const gW = g.Wout;
        const dh = new Float64Array(H);
        for (let j = 0; j < H; j++) {
          gW[wRow + j] += dA * hPrev[j];
          dh[j] = dA * Wout[wRow + j];
        }
        g.bout[k] += dA;
        dhAcc[t] = dh;
      }

      // ---- 输入 x_t → h_{t+1} ----
      const eRow = ids[t] * D;
      let xd;
      if (this.training) {
        const mask = new Float64Array(D);
        for (let d = 0; d < D; d++) mask[d] = this.trainRng() < keep ? 1 / keep : 0;
        xd = new Float64Array(D);
        for (let d = 0; d < D; d++) xd[d] = E[eRow + d] * mask[d];
        masks.push(mask);
      } else {
        masks.push(null);
        xd = new Float64Array(D);
        for (let d = 0; d < D; d++) xd[d] = E[eRow + d];
      }
      xs.push(xd);
      const cache = {
        z: new Float64Array(H), r: new Float64Array(H),
        hh: new Float64Array(H), rh: new Float64Array(H),
        hPrev
      };
      caches.push(cache);
      this._step(xd, hPrev, hNew, cache);
      hSteps.push(Float64Array.from(hNew));
    }

    // ---- BPTT：从最后一步往回传 ----
    const dhTotal = new Float64Array(H);
    const dhPrev = new Float64Array(H);
    const dxd = new Float64Array(D);
    const dzPre = new Float64Array(H);
    const drPre = new Float64Array(H);
    const dhhPre = new Float64Array(H);
    const drh = new Float64Array(H);
    const gE = g.E, gWz = g.Wz, gWr = g.Wr, gWh = g.Wh;
    const gUz = g.Uz, gUr = g.Ur, gUh = g.Uh;
    const gBz = g.bz, gBr = g.br, gBh = g.bh;

    for (let s = T - 1; s >= 0; s--) {
      // dhTotal = carry（来自 s+1 步的递归）+ dhAcc[s+1]（s+1 时刻的输出梯度）
      let nonzero = false;
      const outG = dhAcc[s + 1];
      for (let j = 0; j < H; j++) {
        dhTotal[j] = dhPrev[j] + (outG ? outG[j] : 0);
        if (dhTotal[j] !== 0) nonzero = true;
      }
      if (!nonzero) {
        dhPrev.fill(0);
        continue;
      }
      const cache = caches[s];
      const { z, r, hh, rh, hPrev } = cache;
      const xd = xs[s];
      dxd.fill(0);
      dhPrev.fill(0);

      for (let j = 0; j < H; j++) {
        // h' = (1-z)·h + z·hh
        const dhh = dhTotal[j] * z[j];
        dhPrev[j] += dhTotal[j] * (1 - z[j]);
        const dz = dhTotal[j] * (hh[j] - hPrev[j]);
        dzPre[j] = dz * z[j] * (1 - z[j]);
        dhhPre[j] = dhh * (1 - hh[j] * hh[j]);
        gBh[j] += dhhPre[j];
      }
      // Wh / Uh（hh_pre = Whᵀx + Uhᵀ(r∘h) + bh）
      for (let j = 0; j < H; j++) {
        const ghh = dhhPre[j];
        for (let d = 0; d < D; d++) {
          gWh[d * H + j] += ghh * xd[d];
          dxd[d] += Wh[d * H + j] * ghh;
        }
        for (let k = 0; k < H; k++) gUh[k * H + j] += ghh * rh[k];
      }
      // Uh 的反向对 rh 的梯度
      drh.fill(0);
      for (let j = 0; j < H; j++) {
        const ghh = dhhPre[j];
        for (let k = 0; k < H; k++) drh[k] += Uh[k * H + j] * ghh;
      }
      // r∘h 反向拆开：dr = drh∘h，dh += drh∘r
      for (let k = 0; k < H; k++) {
        const dr = drh[k] * hPrev[k];
        dhPrev[k] += drh[k] * r[k];
        drPre[k] = dr * r[k] * (1 - r[k]);
        gBr[k] += drPre[k];
        const dp = drPre[k];
        for (let d = 0; d < D; d++) {
          gWr[d * H + k] += dp * xd[d];
          dxd[d] += Wr[d * H + k] * dp;
        }
        for (let j = 0; j < H; j++) {
          gUr[j * H + k] += dp * hPrev[j];
          dhPrev[j] += Ur[j * H + k] * dp;
        }
      }
      // z 门
      for (let j = 0; j < H; j++) {
        const dp = dzPre[j];
        gBz[j] += dp;
        for (let d = 0; d < D; d++) {
          gWz[d * H + j] += dp * xd[d];
          dxd[d] += Wz[d * H + j] * dp;
        }
        for (let k = 0; k < H; k++) {
          gUz[k * H + j] += dp * hPrev[k];
          dhPrev[k] += Uz[k * H + j] * dp;
        }
      }
      // dropout + embedding
      const mask = masks[s];
      const idRow = ids[s] * D;
      if (mask) {
        for (let d = 0; d < D; d++) gE[idRow + d] += dxd[d] * mask[d];
      } else {
        for (let d = 0; d < D; d++) gE[idRow + d] += dxd[d];
      }
    }

    return { logLoss, targets };
  }

  // ---------- 评估前向：一次前向，逐步输出 P(x_t.correct | 前缀) ----------
  // 返回 [{t, kpCode, pred}]（t ≥ 1）
  predictSequence(items) {
    const { Wout, bout } = this.params;
    const H = this.H;
    const h = new Float64Array(this.H);
    const hNew = new Float64Array(this.H);
    const out = [];
    for (let t = 0; t < items.length; t++) {
      if (t > 0) {
        const k = this.kpIndex.get(items[t].kpCode);
        let a = bout[k];
        const wRow = k * H;
        for (let j = 0; j < H; j++) a += Wout[wRow + j] * h[j];
        out.push({ t, kpCode: items[t].kpCode, pred: sigmoid(a) });
      }
      const id = this.kpIndex.get(items[t].kpCode) * 2 + items[t].correct;
      const xd = new Float64Array(this.D);
      for (let d = 0; d < this.D; d++) xd[d] = this.params.E[id * this.D + d];
      this._step(xd, h, hNew, null);
      h.set(hNew);
    }
    return out;
  }

  // 数据集平均 LogLoss（验证/训练监控用）
  meanLogLoss(seqs) {
    const wasTraining = this.training;
    this.training = false;
    let ll = 0, n = 0;
    const eps = this.hp.bceEps;
    for (const seq of seqs) {
      for (const o of this.predictSequence(seq.items)) {
        const y = seq.items[o.t].correct;
        const p = Math.min(1 - eps, Math.max(eps, o.pred));
        ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
        n++;
      }
    }
    this.training = wasTraining;
    return { logLoss: n ? ll / n : null, targets: n };
  }

  // ---------- 训练主循环 ----------
  // trainSeqs/valSeqs: [{userId, items}]；返回训练曲线与最优轮次
  fit(trainSeqs, valSeqs, { onEpoch = null } = {}) {
    const hp = this.hp;
    const curve = [];
    let bestVal = Infinity;
    let bestEpoch = 0;
    let bestParams = null;
    let epochsWaited = 0;
    let stoppedEarly = false;
    const order = trainSeqs.map((_, i) => i);

    for (let epoch = 1; epoch <= hp.maxEpochs; epoch++) {
      // 洗牌（独立随机流，固定种子可复现）
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.trainRng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      this.training = true;
      let trainLL = 0, trainN = 0;
      for (let start = 0; start < order.length; start += hp.batchSize) {
        this.zeroGrad();
        const batchEnd = Math.min(start + hp.batchSize, order.length);
        for (let b = start; b < batchEnd; b++) {
          const r = this._forwardTrain(trainSeqs[order[b]].items);
          trainLL += r.logLoss;
          trainN += r.targets;
        }
        this.clipGrad(hp.gradClipNorm);
        this.adamUpdate();
      }
      this.training = false;

      const val = this.meanLogLoss(valSeqs);
      curve.push({
        epoch,
        trainLogLoss: Number((trainLL / trainN).toFixed(6)),
        valLogLoss: Number(val.logLoss.toFixed(6))
      });
      if (val.logLoss < bestVal - 1e-5) {
        bestVal = val.logLoss;
        bestEpoch = epoch;
        bestParams = this.copy();
        epochsWaited = 0;
      } else {
        epochsWaited++;
        if (epochsWaited >= hp.earlyStoppingPatience) {
          stoppedEarly = true;
          break;
        }
      }
      if (onEpoch) onEpoch(curve[curve.length - 1], stoppedEarly);
    }

    // 回滚到验证集最优参数
    if (bestParams) {
      for (const key of Object.keys(this.params)) this.params[key].set(bestParams.params[key]);
    }
    return {
      epochsRun: curve.length,
      bestEpoch,
      bestValLogLoss: Number(bestVal.toFixed(6)),
      stoppedEarly,
      curve
    };
  }
}

module.exports = {
  DEFAULT_HYPERPARAMS,
  buildStudentSequences,
  buildVocab,
  encodeInteractionId,
  splitStudents,
  sigmoid,
  GruDkt
};
