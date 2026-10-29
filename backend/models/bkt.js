/**
 * BKT（Bayesian Knowledge Tracing）基线
 *
 * 模型（Corbett & Anderson 1995，标准四参数，无遗忘）：
 *   P(L0)：初始掌握概率；P(T)：学习转移概率；
 *   P(G)：未掌握时猜对概率；P(S)：已掌握时失误概率。
 * 隐状态 L ∈ {未掌握, 已掌握}，答题结果 o ∈ {0, 1}：
 *   P(o=1 | L=1) = 1 - P(S)，P(o=1 | L=0) = P(G)
 * 转移：L=0 → L=1 概率 P(T)，L=1 → L=1 概率 1（BKT 假设掌握后不遗忘）。
 *
 * 无泄漏协议（与《规则基线完成后的下一阶段路线》的时间顺序原则一致）：
 *   参数不能用未来数据拟合。因此每个 (学生, 知识点) 序列按时间切成
 *   「估计段 = 前 estFraction 比例」与「评估段 = 其余」，EM 只用估计段拟合
 *   各知识点的参数，评估段内逐条 walk-forward 预测。评估目标的作答结果
 *   从不出现在拟合数据里；同序列评估段中早于目标的作答（已是过去）允许进入历史。
 *
 * 稳定性处理（标准做法，Ritter et al. 2016 等推荐）：
 *   P(G)、P(S) 夹紧在 [0.05, 0.4]，防止 EM 收敛到「猜对=1/失误=0」的退化解；
 *   P(L0)、P(T) 夹紧在 [0.01, 0.99]。
 */

const PARAM_CLAMP = {
  L0: [0.01, 0.99],
  T: [0.01, 0.99],
  G: [0.05, 0.4],
  S: [0.05, 0.4]
};

const DEFAULT_PARAMS = { L0: 0.4, T: 0.15, G: 0.2, S: 0.15 };

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// ---------- 发射概率 ----------
// b(l, o) = P(o | L=l)
function emission(l, o, p) {
  if (l === 1) return o === 1 ? 1 - p.S : p.S;
  return o === 1 ? p.G : 1 - p.G;
}

// ---------- 单序列前向-后向（E 步，Rabiner 缩放版防下溢） ----------
// 返回 gamma[t][l] = P(L_t=l | o_1..o_m)（t 为 0 起下标），以及 xiSum = Σ_t P(L_t=0, L_{t+1}=1 | O)
// 缩放：α̂_t 每步除以 c_t（观测似然），β̂_t 递推中除以 c_{t+1}；
// 该缩放下 γ_t(l) = α̂_t(l)·β̂_t(l) / Σ_l'（每步和为 1），logLik = Σ_t log c_t
function forwardBackward(obs, p) {
  const m = obs.length;
  const alphaHat = Array.from({ length: m }, () => [0, 0]);
  const c = new Array(m);

  // 前向（缩放）：α̂_1(l) = P(L_1=l)·P(o_1|l) / c_1
  let a1 = p.L0 * emission(1, obs[0], p);
  let a0 = (1 - p.L0) * emission(0, obs[0], p);
  let cs = a0 + a1;
  if (!(cs > 0)) return null;
  c[0] = cs;
  alphaHat[0][1] = a1 / cs;
  alphaHat[0][0] = a0 / cs;
  for (let t = 1; t < m; t++) {
    // 转移：L=0→0 概率 1-P(T)，0→1 概率 P(T)，1→1 概率 1
    const o = obs[t];
    a1 = (alphaHat[t - 1][0] * p.T + alphaHat[t - 1][1]) * emission(1, o, p);
    a0 = alphaHat[t - 1][0] * (1 - p.T) * emission(0, o, p);
    cs = a0 + a1;
    if (!(cs > 0)) return null;
    c[t] = cs;
    alphaHat[t][1] = a1 / cs;
    alphaHat[t][0] = a0 / cs;
  }

  // 后向（缩放）：β̂_m(l) = 1；β̂_t(l) = (Σ_{l'} P(l→l')·P(o_{t+1}|l')·β̂_{t+1}(l')) / c_{t+1}
  const betaHat = Array.from({ length: m }, () => [0, 0]);
  betaHat[m - 1][0] = 1;
  betaHat[m - 1][1] = 1;
  for (let t = m - 2; t >= 0; t--) {
    const o = obs[t + 1];
    const e1 = emission(1, o, p);
    const e0 = emission(0, o, p);
    betaHat[t][1] = e1 * betaHat[t + 1][1] / c[t + 1];
    betaHat[t][0] = ((1 - p.T) * e0 * betaHat[t + 1][0] + p.T * e1 * betaHat[t + 1][1]) / c[t + 1];
  }

  const gamma = Array.from({ length: m }, () => [0, 0]);
  for (let t = 0; t < m; t++) {
    const g0 = alphaHat[t][0] * betaHat[t][0];
    const g1 = alphaHat[t][1] * betaHat[t][1];
    const s = g0 + g1;
    if (!(s > 0)) return null;
    gamma[t][0] = g0 / s;
    gamma[t][1] = g1 / s;
  }

  // ξ 求和：Σ_t P(L_t=0, L_{t+1}=1 | O)（M 步用于更新 P(T)）
  // ξ_t(0,1) = α̂_t(0)·P(T)·P(o_{t+1}|L=1)·β̂_{t+1}(1) / c_{t+1}（缩放下分母即 c_{t+1}）
  let xiSum = 0;
  for (let t = 0; t < m - 1; t++) {
    const o = obs[t + 1];
    xiSum += alphaHat[t][0] * p.T * emission(1, o, p) * betaHat[t + 1][1] / c[t + 1];
  }

  let logLik = 0;
  for (let t = 0; t < m; t++) logLik += Math.log(c[t]);

  return { gamma, xiSum, logLik };
}

// ---------- M 步：一批序列上更新参数 ----------
function mStep(sequences, prev) {
  let l1AtStart = 0; // Σ γ_1(L=1)
  let nSeq = 0;
  let sum00 = 0; // Σ_t γ_t(L=0)，t = 1..m-1（转移分母）
  let xi01 = 0; // Σ ξ(0→1)
  let gNum = 0, gDen = 0; // P(G)：Σ γ(L=0)·1[o=1] / Σ γ(L=0)
  let sNum = 0, sDen = 0; // P(S)：Σ γ(L=1)·1[o=0] / Σ γ(L=1)

  for (const obs of sequences) {
    const fb = forwardBackward(obs, prev);
    if (!fb) continue;
    nSeq++;
    l1AtStart += fb.gamma[0][1];
    for (let t = 0; t < obs.length; t++) {
      const g0 = fb.gamma[t][0];
      const g1 = fb.gamma[t][1];
      if (obs[t] === 1) gNum += g0; else sNum += g1;
      gDen += g0;
      sDen += g1;
      if (t < obs.length - 1) sum00 += g0;
    }
    xi01 += fb.xiSum;
  }

  if (!nSeq) return null;
  return {
    L0: clamp(nSeq ? l1AtStart / nSeq : prev.L0, PARAM_CLAMP.L0),
    T: clamp(sum00 > 0 ? xi01 / sum00 : prev.T, PARAM_CLAMP.T),
    G: clamp(gDen > 0 ? gNum / gDen : prev.G, PARAM_CLAMP.G),
    S: clamp(sDen > 0 ? sNum / sDen : prev.S, PARAM_CLAMP.S)
  };
}

// ---------- EM 拟合：一组二值序列 → 一组 BKT 参数 ----------
// sequences: 二值作答数组（1=对，0=错）的数组；init/收敛/迭代上限可控
function fitBkt(sequences, { init = DEFAULT_PARAMS, maxIter = 100, tol = 1e-6 } = {}) {
  const valid = sequences.filter((s) => s.length >= 1);
  if (!valid.length) return { params: { ...DEFAULT_PARAMS }, logLik: null, iterations: 0, converged: false };
  let params = {
    L0: clamp(init.L0, PARAM_CLAMP.L0),
    T: clamp(init.T, PARAM_CLAMP.T),
    G: clamp(init.G, PARAM_CLAMP.G),
    S: clamp(init.S, PARAM_CLAMP.S)
  };
  let prevLL = -Infinity;
  let iter = 0;
  let converged = false;
  for (iter = 1; iter <= maxIter; iter++) {
    let logLik = 0;
    for (const obs of valid) {
      const fb = forwardBackward(obs, params);
      if (fb) logLik += fb.logLik;
    }
    const next = mStep(valid, params);
    if (!next) break;
    const delta = Math.abs(logLik - prevLL);
    params = next;
    prevLL = logLik;
    if (iter > 1 && delta < tol) { converged = true; break; }
  }
  return { params, logLik: prevLL, iterations: Math.min(iter, maxIter), converged };
}

// ---------- 按知识点拟合 ----------
// sequencesByKp: Map<kpCode, 二值序列[]>
// 数据不足（总观测 < minObservations）的知识点返回数据集级默认参数并标记 fallback
function fitBktByKp(sequencesByKp, { minObservations = 30, ...fitOpts } = {}) {
  const paramsByKp = {};
  const fitInfo = {};
  let allObs = [];
  for (const [kp, seqs] of sequencesByKp) {
    for (const s of seqs) allObs = allObs.concat(s);
  }
  for (const [kp, seqs] of sequencesByKp) {
    const nObs = seqs.reduce((a, s) => a + s.length, 0);
    if (nObs < minObservations) {
      paramsByKp[kp] = { ...DEFAULT_PARAMS };
      fitInfo[kp] = { observations: nObs, sequences: seqs.length, fallback: true };
      continue;
    }
    const fit = fitBkt(seqs, fitOpts);
    paramsByKp[kp] = fit.params;
    fitInfo[kp] = {
      observations: nObs,
      sequences: seqs.length,
      logLik: fit.logLik === null ? null : Number(fit.logLik.toFixed(2)),
      iterations: fit.iterations,
      converged: fit.converged,
      fallback: false
    };
  }
  const fallbackCount = Object.values(fitInfo).filter((f) => f.fallback).length;
  return { paramsByKp, fitInfo, defaultParamsUsed: fallbackCount, totalObservations: allObs.length };
}

// ---------- 预测 ----------
// 给定参数与历史作答（1=对，0=错的数组），返回下一次答对概率。
// 递归：先验 P(L1)=P(L0) → 观测 o → 学习转移 → 预测。
// P(L|o) = P(L,o)/P(o)；P(next) = P(L)·(1-P(S)) + (1-P(L))·P(G)
function predictNextCorrect(params, history) {
  let p = clamp(params.L0, PARAM_CLAMP.L0);
  for (const o of history) {
    // 贝叶斯更新
    p = o === 1
      ? p * (1 - params.S) / (p * (1 - params.S) + (1 - p) * params.G)
      : p * params.S / (p * params.S + (1 - p) * (1 - params.G));
    p = clamp(p, [0, 1]);
    // 学习转移
    p = p + (1 - p) * params.T;
  }
  return p * (1 - params.S) + (1 - p) * params.G;
}

// ---------- 序列切分：估计段 / 评估段 ----------
// 每条序列前 estFraction 比例（向下取整，且至少保留 1 条给评估段）进估计段；
// 长度 1 的序列整体进估计段（无法做预测目标）。估计段下标从 0 起。
function splitSequence(items, estFraction = 0.5) {
  if (items.length <= 1) return { est: items, eval: [] };
  const h = Math.max(1, Math.min(items.length - 1, Math.floor(items.length * estFraction)));
  return { est: items.slice(0, h), eval: items.slice(h) };
}

// 序列 → 二值作答数组（须已按时间升序）
function toBinary(items) {
  return items.map((r) => (r.isCorrect ? 1 : 0));
}

// ---------- 便捷：从分组数据构建 EM 输入 ----------
// groups: [[{kpCode, isCorrect, ...}, ...], ...]（每组同一 (学生,知识点)，时间升序）
// 返回 { sequencesByKp, splitOf } ；splitOf 记录每组切分点以便评估阶段复用
function buildEstimationData(groups, estFraction = 0.5) {
  const sequencesByKp = new Map();
  const splitOf = [];
  for (const group of groups) {
    const { est, eval: ev } = splitSequence(group, estFraction);
    splitOf.push({ estLen: est.length, evalLen: ev.length });
    if (!est.length) continue;
    const kp = group[0].kpCode;
    if (!sequencesByKp.has(kp)) sequencesByKp.set(kp, []);
    sequencesByKp.get(kp).push(toBinary(est));
  }
  return { sequencesByKp, splitOf };
}

// ---------- 结果文件元信息 ----------
function describeProtocol(estFraction) {
  return {
    model: 'BKT（Corbett & Anderson 1995 标准四参数，无遗忘）',
    parameters: '每个知识点独立估计 P(L0)/P(T)/P(G)/P(S)，EM（Baum-Welch）拟合',
    parameterClamp: PARAM_CLAMP,
    noLeakage: `每个 (学生,知识点) 序列按时间切分：前 ${Math.round(estFraction * 100)}% 为估计段，仅估计段用于 EM 拟合；评估目标全部位于评估段，其作答结果从不出现在拟合数据中`,
    evaluation: '评估段内 walk-forward：预测第 t 次只用同序列前 t-1 次；与规则基线同一分组、同一批次规则（首批次整体跳过）',
    fairness: 'Majority / Rule-0 在与 BKT 完全相同的目标集上重新计算，保证逐对可比',
    coldStart: '评估段内每条目标至少有 1 条历史（估计段非空）'
  };
}

module.exports = {
  PARAM_CLAMP,
  DEFAULT_PARAMS,
  fitBkt,
  fitBktByKp,
  predictNextCorrect,
  splitSequence,
  toBinary,
  buildEstimationData,
  describeProtocol,
  _internal: { forwardBackward, mStep, emission }
};
