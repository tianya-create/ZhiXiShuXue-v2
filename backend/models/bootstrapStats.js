/**
 * 大样本下的学生级 bootstrap 引擎（与 evaluateMetrics 数值等价，但不需要每次重采样都排序）
 *
 * 背景：评估集到 20 万条量级后，直接「重采样→排序→算 AUC」的写法每次要 ~2 秒，
 * 2000 次 bootstrap 要一小时以上。这里改写成：
 *   1. 按预测概率预排序，记录并列组（AUC 的秩结构只依赖预测值顺序）；
 *   2. 预计算每条的 logloss 正/负项、Brier 项、阈值命中；
 *   3. 每次重采样只生成「每条记录被抽中的次数」权重，指标用加权前缀和 O(n) 算出。
 * 结果与 evaluateMetrics 在权重全 1 时完全一致（有单测对照）。
 */

const params = require('./baselineParams.json');

function buildEvaluator(rows) {
  const n = rows.length;
  const eps = params.logLossEps;
  const pred = new Float64Array(n);
  const target = new Uint8Array(n);
  const llPos = new Float64Array(n);
  const llNeg = new Float64Array(n);
  const brier = new Float64Array(n);
  const hit = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - eps, Math.max(eps, rows[i].pred));
    const y = rows[i].target === 1 ? 1 : 0;
    pred[i] = rows[i].pred;
    target[i] = y;
    llPos[i] = -Math.log(p);
    llNeg[i] = -Math.log(1 - p);
    brier[i] = (rows[i].pred - y) ** 2;
    hit[i] = rows[i].pred >= params.decisionThreshold ? 1 : 0;
  }

  // 按预测值升序排序，并把并列值合并成组（AUC 并列按平均秩处理，等价于 0.5 权重）
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const sortedArray = Array.from(order).sort((a, b) => pred[a] - pred[b]);
  order.set(sortedArray);

  const groupStart = [];
  const groupEnd = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && pred[order[j]] === pred[order[i]]) j++;
    groupStart.push(i);
    groupEnd.push(j);
    i = j;
  }

  function evaluate(weights, { auc = true } = {}) {
    let logLoss = 0;
    let brierSum = 0;
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    let totalW = 0;
    for (let i = 0; i < n; i++) {
      const w = weights[i];
      if (w === 0) continue;
      totalW += w;
      if (target[i]) {
        logLoss += w * llPos[i];
        if (hit[i]) tp += w; else fn += w;
      } else {
        logLoss += w * llNeg[i];
        if (hit[i]) fp += w; else tn += w;
      }
      brierSum += w * brier[i];
    }
    if (!totalW) return null;

    let aucValue = null;
    if (auc) {
      let posW = 0;
      let negW = 0;
      for (let i = 0; i < n; i++) {
        const w = weights[i];
        if (w === 0) continue;
        if (target[i]) posW += w; else negW += w;
      }
      if (posW > 0 && negW > 0) {
        let negBefore = 0;
        let accum = 0;
        for (let g = 0; g < groupStart.length; g++) {
          let gPos = 0;
          let gNeg = 0;
          for (let k = groupStart[g]; k < groupEnd[g]; k++) {
            const idx = order[k];
            const w = weights[idx];
            if (w === 0) continue;
            if (target[idx]) gPos += w; else gNeg += w;
          }
          if (gPos || gNeg) {
            accum += gPos * (negBefore + 0.5 * gNeg);
            negBefore += gNeg;
          }
        }
        aucValue = accum / (posW * negW);
      }
    }

    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return {
      n: totalW,
      AUC: aucValue,
      LogLoss: logLoss / totalW,
      Brier: brierSum / totalW,
      Accuracy: (tp + tn) / totalW,
      F1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0
    };
  }

  return { evaluate };
}

/** 学生级重采样器：每次返回「每条记录被抽中次数」的权重数组（复用缓冲区） */
function buildStudentSampler(rows) {
  const studentRows = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = rows[i].userId;
    if (!studentRows.has(key)) studentRows.set(key, []);
    studentRows.get(key).push(i);
  }
  const groups = [...studentRows.values()];
  const weights = new Float64Array(rows.length);

  function sampleWeights(rand) {
    weights.fill(0);
    for (let g = 0; g < groups.length; g++) {
      const picked = groups[Math.floor(rand() * groups.length)];
      for (let k = 0; k < picked.length; k++) weights[picked[k]] += 1;
    }
    return weights;
  }

  return { sampleWeights, studentCount: groups.length, weights };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function ciOf(sortedValues) {
  if (!sortedValues.length) return [null, null];
  return [
    Number(percentile(sortedValues, 0.025).toFixed(4)),
    Number(percentile(sortedValues, 0.975).toFixed(4))
  ];
}

/**
 * 双侧 bootstrap p 值：2 × min(P(Δ≤0), P(Δ≥0))，两端各加 1 平滑。
 * 这样处理两个边界情形才不会出错：
 *   - 所有 Δ 恰好为 0（例如两个模型预测完全相同）→ 两个尾部概率都是 1 → p = 1；
 *   - 所有 Δ 同号 → p 降到分辨率下限 2/(B+1)，而不是 0。
 */
function pValueOf(diffs) {
  if (!diffs.length) return null;
  let below = 0;
  let above = 0;
  for (const d of diffs) {
    if (d <= 0) below++;
    if (d >= 0) above++;
  }
  const pLow = (below + 1) / (diffs.length + 1);
  const pHigh = (above + 1) / (diffs.length + 1);
  return Number(Math.min(1, 2 * Math.min(pLow, pHigh)).toFixed(4));
}

/**
 * 多模型一次性 bootstrap：同一批重采样权重同时用于所有模型，
 * 因此置信区间与两两配对检验天然配对（paired bootstrap），也只需遍历一次数据。
 *
 * @param {Object<string, Array>} rowsByModel 模型名 → walkForward 输出行（顺序需一致）
 */
function bootstrapAllModels(rowsByModel, { reps = 2000, seed = 42 } = {}) {
  const models = Object.keys(rowsByModel);
  if (!models.length) return { ciByModel: {}, comparisons: [], reps: 0, students: 0 };
  const base = rowsByModel[models[0]];
  const evaluators = {};
  for (const model of models) {
    if (rowsByModel[model].length !== base.length) {
      throw new Error(`bootstrapAllModels 要求各模型预测样本数一致：${model} ${rowsByModel[model].length} vs ${base.length}`);
    }
    evaluators[model] = buildEvaluator(rowsByModel[model]);
  }
  const sampler = buildStudentSampler(base);
  const rand = mulberry32(seed);

  const aucSamples = {};
  const llSamples = {};
  const brierSamples = {};
  const accSamples = {};
  for (const model of models) {
    aucSamples[model] = [];
    llSamples[model] = [];
    brierSamples[model] = [];
    accSamples[model] = [];
  }

  const pairs = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      pairs.push({ a: models[i], b: models[j], dAUC: [], dLL: [] });
    }
  }

  for (let r = 0; r < reps; r++) {
    const weights = sampler.sampleWeights(rand);
    const metrics = {};
    for (const model of models) {
      const m = evaluators[model].evaluate(weights);
      metrics[model] = m;
      if (!m) continue;
      if (m.AUC !== null) aucSamples[model].push(m.AUC);
      llSamples[model].push(m.LogLoss);
      brierSamples[model].push(m.Brier);
      accSamples[model].push(m.Accuracy);
    }
    for (const pair of pairs) {
      const ma = metrics[pair.a];
      const mb = metrics[pair.b];
      if (!ma || !mb) continue;
      if (ma.AUC !== null && mb.AUC !== null) pair.dAUC.push(ma.AUC - mb.AUC);
      pair.dLL.push(ma.LogLoss - mb.LogLoss);
    }
  }

  const ciByModel = {};
  for (const model of models) {
    ciByModel[model] = {
      AUC: ciOf([...aucSamples[model]].sort((x, y) => x - y)),
      LogLoss: ciOf([...llSamples[model]].sort((x, y) => x - y)),
      Brier: ciOf([...brierSamples[model]].sort((x, y) => x - y)),
      Accuracy: ciOf([...accSamples[model]].sort((x, y) => x - y)),
      draws: llSamples[model].length
    };
  }

  const comparisons = pairs.map((pair) => {
    const dAucSorted = [...pair.dAUC].sort((x, y) => x - y);
    const dLlSorted = [...pair.dLL].sort((x, y) => x - y);
    const meanAuc = dAucSorted.length ? dAucSorted.reduce((s, x) => s + x, 0) / dAucSorted.length : null;
    const meanLl = dLlSorted.length ? dLlSorted.reduce((s, x) => s + x, 0) / dLlSorted.length : null;
    return {
      a: pair.a,
      b: pair.b,
      dAUC: {
        meanDiff: meanAuc === null ? null : Number(meanAuc.toFixed(4)),
        ci: ciOf(dAucSorted),
        p: pValueOf(dAucSorted)
      },
      dLogLoss: {
        meanDiff: meanLl === null ? null : Number(meanLl.toFixed(4)),
        ci: ciOf(dLlSorted),
        p: pValueOf(dLlSorted)
      }
    };
  });

  return { ciByModel, comparisons, reps, students: sampler.studentCount };
}

/** 单模型置信区间（保持原有 API） */
function bootstrapCIs(rows, { reps = 2000, seed = 42 } = {}) {
  const { ciByModel } = bootstrapAllModels({ Model: rows }, { reps, seed });
  const ci = ciByModel.Model;
  return { AUC: ci.AUC, LogLoss: ci.LogLoss, Accuracy: ci.Accuracy, Brier: ci.Brier };
}

/** 两模型配对检验（保持原有 API，内部走同一套加权引擎） */
function pairedComparison(rowsA, rowsB, { reps = 2000, seed = 42 } = {}) {
  const keyOf = (row) => `${row.userId}|${row.kpCode}|${row.createdAt}`;
  const mapB = new Map(rowsB.map((row) => [keyOf(row), row]));
  const idxA = [];
  const idxB = [];
  for (let i = 0; i < rowsA.length; i++) {
    const b = mapB.get(keyOf(rowsA[i]));
    if (b && b.target === rowsA[i].target) {
      idxA.push(rowsA[i]);
      idxB.push(b);
    }
  }
  if (!idxA.length) {
    const empty = { meanDiff: null, ci: [null, null], p: null };
    return { pairedRows: 0, dAUC: { ...empty, units: 0 }, dLogLoss: { ...empty, units: 0 } };
  }
  const { comparisons, students } = bootstrapAllModels({ A: idxA, B: idxB }, { reps, seed });
  const res = comparisons[0];
  return {
    pairedRows: idxA.length,
    dAUC: { ...res.dAUC, units: students },
    dLogLoss: { ...res.dLogLoss, units: students }
  };
}

module.exports = {
  buildEvaluator,
  buildStudentSampler,
  mulberry32,
  percentile,
  bootstrapAllModels,
  bootstrapCIs,
  pairedComparison
};
