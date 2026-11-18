#!/usr/bin/env node
/**
 * priorSignalProbe.js —— 图增益闸门实验：先修信息探针（Prior-Signal Probe，方案 §3/§6）
 *
 * 问题：Full-DKT 已吸收作答序列后，先修关系是否仍对目标正确率有增量预测力？
 * 方法：以 preds["Full-DKT"] 的 logit 为基底特征之一，训练 L2 逻辑回归残差探针，
 *       比较 S / S+A / S+B / S+C / S+A+B 五个特征集的 OOF LogLoss（按 userId GroupKFold）。
 * 判定：预注册阈值见 probe-config.json（strong/gray/none → build/switch-dataset/stop）。
 *
 * 口径（防作弊，§8）：
 *   - 全部特征只用 createdAt < t 的交互；
 *   - LR 只在 4 折 fit、第 5 折 predict（OOF 汇总）；
 *   - A/B/C 同一次运行、同一折划分、同一随机种子；
 *   - 先修边 sha256 冻结于 probe-config.json，先于任何结果。
 *
 * 复核模型：环境无 Python/sklearn，HistGradientBoosting 以「16 分位箱直方图深度1桩提升」
 * 等价替代（100 轮、步长 0.5），仅在 seed 42 的 S 与 S+A 上复核 Δ 符号一致性，不作主判定。
 *
 * 用法：
 *   cd backend
 *   node models/priorSignalProbe.js \
 *     --input-dir 实验结果文件/gcn-dkt-v1 \
 *     --interactions datasets/assist2009/interactions.csv \
 *     --prior-edges datasets/assist2009/prior-edges.csv \
 *     --config 实验结果文件/prior-probe-v1/probe-config.json \
 *     --out 实验结果文件/prior-probe-v1/probe.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EPS = 1e-6;

// ---------- 数值工具（纯函数） ----------

function logitClip(p, eps = EPS) {
  const q = Math.min(1 - eps, Math.max(eps, p));
  return Math.log(q / (1 - q));
}

function log1pSafe(x) {
  return Math.log(1 + Math.max(0, x));
}

/** AUC（平均秩，含并列）；单类返回 null */
function aucOf(pairs) {
  const pos = [];
  const neg = [];
  for (const { p, y } of pairs) (y === 1 ? pos : neg).push(p);
  const n1 = pos.length;
  const n0 = neg.length;
  if (n1 === 0 || n0 === 0) return null;
  const all = pos.map((p) => ({ p, y: 1 })).concat(neg.map((p) => ({ p, y: 0 })));
  all.sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].p === all[i].p) j += 1;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k += 1) if (all[k].y === 1) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

function logLossOf(pairs, eps = 1e-7) {
  let s = 0;
  for (const { p, y } of pairs) {
    const q = Math.min(1 - eps, Math.max(eps, p));
    s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  }
  return s / pairs.length;
}

function meanOf(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function popStdOf(xs) { const m = meanOf(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length); }

// ---------- 图与邻居（纯函数） ----------

/** 邻居表：directed → N(k)={a:(a,k)∈E}；undirected → (a,k) 与 (k,a) 都进 N(k)；同邻居重复边取最大权重 */
function neighborSetsFromEdges(edgeRows, { directed }) {
  const adj = new Map();
  const add = (k, a, w) => {
    if (!adj.has(k)) adj.set(k, new Map());
    const cur = adj.get(k);
    cur.set(a, Math.max(cur.get(a) || 0, w));
  };
  for (const [a, b, w] of edgeRows) {
    if (directed) add(b, a, w);
    else { add(b, a, w); add(a, b, w); }
  }
  return adj;
}

function parseEdgeCsv(text, weightMode) {
  const lines = text.trim().split(/\r?\n/).slice(1);
  const rows = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    if (weightMode === 'confidence') {
      // prior-edges.csv: sourceKp,targetKp,confidence,votes,"reason"
      const m = l.match(/^([^,]+),([^,]+),(\d+),\d+,(.*)$/);
      if (!m) throw new Error(`prior-edges 行解析失败: ${l}`);
      rows.push([m[1], m[2], Number(m[3])]);
    } else {
      // graph-*-edges.csv: sourceIndex,targetIndex,sourceKp,targetKp,support
      const cols = l.split(',');
      rows.push([cols[2], cols[3], weightMode === 'support' ? Number(cols[4]) : 1]);
    }
  }
  return rows;
}

// ---------- 学生前缀状态（纯函数） ----------

/** 空的学生前缀状态 */
function emptyStudentState() {
  return { kc: new Map(), stu: { n: 0, c: 0, last5: [] }, recent20: [] };
}

/** 把一条交互并入状态（不产生任何输出） */
function updateStudentState(state, { kpCode, isCorrect, ts }) {
  let kc = state.kc.get(kpCode);
  if (!kc) { kc = { n: 0, c: 0, lastTs: 0, last5: [] }; state.kc.set(kpCode, kc); }
  kc.n += 1;
  kc.c += isCorrect;
  kc.lastTs = ts;
  kc.last5.push(isCorrect);
  if (kc.last5.length > 5) kc.last5.shift();
  state.stu.n += 1;
  state.stu.c += isCorrect;
  state.stu.last5.push(isCorrect);
  if (state.stu.last5.length > 5) state.stu.last5.shift();
  state.recent20.push(kpCode);
  if (state.recent20.length > 20) state.recent20.shift();
}

function last5Acc(arr) { return arr.length ? meanOf(arr) : null; }

/**
 * 目标特征（纯）：state 必须恰好只含 createdAt < t 的交互
 * neighbors: Map kp -> Map(neighbor -> weight)（目标 KC 的邻居集）；kcTrainAcc: 全局统计
 */
function computeTargetFeatures({ predFull, kcCode, seqIndex, ts, state, neighbors, kcTrainAcc }) {
  const kc = state.kc.get(kcCode);
  const stu = state.stu;
  const base = {
    dkt_logit: logitClip(predFull),
    kc_attempts_log: kc ? log1pSafe(kc.n) : null,
    kc_last5_acc: kc ? last5Acc(kc.last5) : null,
    kc_last_correct: kc && kc.last5.length ? kc.last5[kc.last5.length - 1] : null,
    kc_gap_log: kc && kc.lastTs ? log1pSafe((ts - kc.lastTs) / 60000) : null,
    kc_train_acc: Object.prototype.hasOwnProperty.call(kcTrainAcc, kcCode) ? kcTrainAcc[kcCode] : null,
    stu_attempts_log: log1pSafe(stu.n),
    stu_acc: stu.n ? stu.c / stu.n : null,
    stu_last5_acc: last5Acc(stu.last5),
    hist_len_log: log1pSafe(seqIndex - 1),
  };
  const nb = { nb_missing: 1, nb_cov: 0, nb_recent_acc: null, nb_last_correct: null, nb_gap_log: null, nb_recent20: 0 };
  if (neighbors && neighbors.size) {
    const practiced = [];
    for (const [a, w] of neighbors) {
      const s2 = state.kc.get(a);
      if (s2 && s2.n >= 1) practiced.push({ a, w, st: s2 });
    }
    if (practiced.length) {
      nb.nb_missing = 0;
      nb.nb_cov = practiced.length / neighbors.size;
      const wSum = practiced.reduce((s, x) => s + x.w, 0);
      nb.nb_recent_acc = wSum > 0 ? practiced.reduce((s, x) => s + x.w * last5Acc(x.st.last5), 0) / wSum : 0;
      let latest = practiced[0];
      for (const x of practiced) if (x.st.lastTs > latest.st.lastTs) latest = x;
      nb.nb_last_correct = latest.st.last5[latest.st.last5.length - 1];
      nb.nb_gap_log = log1pSafe((ts - latest.st.lastTs) / 60000);
      const nset = new Set(neighbors.keys());
      nb.nb_recent20 = state.recent20.filter((k) => nset.has(k)).length;
    }
  }
  return { base, nb };
}

// ---------- 分折（纯函数） ----------

/** GroupKFold：学生级 5 折，mulberry32 Fisher-Yates 洗牌后轮流分配 */
function groupKFold(userIds, folds, seed) {
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...userIds].sort();
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const assignment = new Map();
  arr.forEach((u, i) => assignment.set(u, i % folds));
  return assignment;
}

// ---------- 模型（纯函数） ----------

/** L2 逻辑回归（IRLS/Newton，截距不正则）；X 为 n×(d+1)（末列恒 1） */
function trainLR(X, y, C = 1.0, iters = 8) {
  const n = X.length;
  const d = X[0].length;
  const w = new Float64Array(d);
  const ridge = new Float64Array(d);
  for (let j = 0; j < d - 1; j += 1) ridge[j] = 1 / C; // 截距不正则
  for (let it = 0; it < iters; it += 1) {
    const g = new Float64Array(d);
    const H = Array.from({ length: d }, () => new Float64Array(d));
    for (let i = 0; i < n; i += 1) {
      const xi = X[i];
      let f = 0;
      for (let j = 0; j < d; j += 1) f += w[j] * xi[j];
      const p = 1 / (1 + Math.exp(-f));
      const wi = p * (1 - p) + 1e-9;
      const r = p - y[i];
      for (let j = 0; j < d; j += 1) {
        g[j] += r * xi[j];
        const xj = xi[j];
        for (let k2 = j; k2 < d; k2 += 1) H[j][k2] += wi * xj * xi[k2];
      }
    }
    for (let j = 0; j < d; j += 1) {
      g[j] += ridge[j] * w[j];
      H[j][j] += ridge[j];
      for (let k2 = 0; k2 < j; k2 += 1) H[j][k2] = H[k2][j];
    }
    // 解 H Δ = g（高斯消元）
    const A = H.map((row, j) => [...row, g[j]]);
    for (let col = 0; col < d; col += 1) {
      let piv = col;
      for (let r2 = col + 1; r2 < d; r2 += 1) if (Math.abs(A[r2][col]) > Math.abs(A[piv][col])) piv = r2;
      if (Math.abs(A[piv][col]) < 1e-12) continue;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r2 = col + 1; r2 < d; r2 += 1) {
        const f2 = A[r2][col] / A[col][col];
        if (f2 === 0) continue;
        for (let c2 = col; c2 <= d; c2 += 1) A[r2][c2] -= f2 * A[col][c2];
      }
    }
    const delta = new Float64Array(d);
    for (let r2 = d - 1; r2 >= 0; r2 -= 1) {
      if (Math.abs(A[r2][r2]) < 1e-12) continue;
      let s = A[r2][d];
      for (let c2 = r2 + 1; c2 < d; c2 += 1) s -= A[r2][c2] * delta[c2];
      delta[r2] = s / A[r2][r2];
    }
    for (let j = 0; j < d; j += 1) w[j] -= delta[j];
  }
  return w;
}

function predictLR(w, X) {
  const out = new Float64Array(X.length);
  for (let i = 0; i < X.length; i += 1) {
    let f = 0;
    for (let j = 0; j < w.length; j += 1) f += w[j] * X[i][j];
    out[i] = 1 / (1 + Math.exp(-f));
  }
  return out;
}

/** StandardScaler（fit 于训练折） */
function fitScaler(rows, featureNames) {
  const d = featureNames.length;
  const mean = new Float64Array(d);
  const std = new Float64Array(d);
  for (let j = 0; j < d; j += 1) {
    let s = 0;
    let c = 0;
    for (const r of rows) { const v = r[j]; if (Number.isFinite(v)) { s += v; c += 1; } }
    mean[j] = c ? s / c : 0;
    let v2 = 0;
    for (const r of rows) { const v = r[j]; if (Number.isFinite(v)) v2 += (v - mean[j]) * (v - mean[j]); }
    std[j] = c > 1 && v2 / (c - 1) > 1e-12 ? Math.sqrt(v2 / (c - 1)) : 1;
  }
  return { mean, std, featureNames };
}

/** StandardScaler（fit 于训练折）；缺失 NaN → 标准化后补 0，并在 missIdx 指定位置生成缺失指示列 */
function transformRows(rows, scaler, missIdx = []) {
  const d = scaler.featureNames.length;
  const nMissing = missIdx.length;
  const out = [];
  for (const r of rows) {
    const x = new Float64Array(d + nMissing + 1);
    for (let j = 0; j < d; j += 1) {
      const v = r[j];
      x[j] = Number.isFinite(v) ? (v - scaler.mean[j]) / scaler.std[j] : 0;
    }
    for (let m2 = 0; m2 < nMissing; m2 += 1) x[d + m2] = Number.isFinite(r[missIdx[m2]]) ? 0 : 1;
    x[d + nMissing] = 1; // 截距
    out.push(x);
  }
  return out;
}

/** 直方图深度1桩提升（复核模型）：16 分位箱，100 轮，步长 0.5 */
function stumpBoostTrain(rows, y, { bins = 16, rounds = 100, lr = 0.5 } = {}) {
  const d = rows[0].length;
  // 分位箱边界（每列）
  const binEdges = [];
  for (let j = 0; j < d - 1; j += 1) { // 末列是截距，跳过
    const vals = rows.map((r) => r[j]).filter(Number.isFinite).sort((a, b) => a - b);
    const edges = [];
    for (let b = 1; b < bins; b += 1) {
      const idx = Math.floor((vals.length - 1) * b / bins);
      edges.push(vals[idx]);
    }
    binEdges.push(edges);
  }
  const binned = rows.map((r) => {
    const bi = new Uint8Array(d - 1);
    for (let j = 0; j < d - 1; j += 1) {
      const v = Number.isFinite(r[j]) ? r[j] : 0;
      let b = 0;
      const e = binEdges[j];
      while (b < e.length && v > e[b]) b += 1;
      bi[j] = b;
    }
    return bi;
  });
  const F = new Float64Array(y.length);
  const trees = [];
  for (let t = 0; t < rounds; t += 1) {
    const grad = new Float64Array(y.length);
    for (let i = 0; i < y.length; i += 1) grad[i] = y[i] - 1 / (1 + Math.exp(-F[i]));
    let best = null;
    for (let j = 0; j < d - 1; j += 1) {
      const sum = new Float64Array(bins);
      const cnt = new Uint32Array(bins);
      for (let i = 0; i < y.length; i += 1) { sum[ binned[i][j]] += grad[i]; cnt[binned[i][j]] += 1; }
      const totalSum = sum.reduce((a, b) => a + b, 0);
      const totalCnt = y.length;
      for (let cut = 0; cut < bins - 1; cut += 1) {
        let ls = 0;
        let lc = 0;
        for (let b = 0; b <= cut; b += 1) { ls += sum[b]; lc += cnt[b]; }
        if (lc === 0 || totalCnt - lc === 0) continue;
        const leftMean = ls / lc;
        const rightMean = (totalSum - ls) / (totalCnt - lc);
        // 平方误差缩减 = 分组均值差的加权平方
        const gain = lc * (totalCnt - lc) * leftMean * rightMean * -1; // 等价于 -lc*rc*(mL-mR)^2 常数倍方向
        const diff = Math.abs(leftMean - rightMean);
        const score = diff * Math.sqrt(lc * (totalCnt - lc));
        if (!best || score > best.score) best = { j, cut, leftMean, rightMean, score, gain };
      }
    }
    if (!best) break;
    trees.push(best);
    for (let i = 0; i < y.length; i += 1) F[i] += lr * (binned[i][best.j] <= best.cut ? best.leftMean : best.rightMean);
  }
  return { binEdges, trees, lr, bins };
}

function stumpBoostPredict(model, rows) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    let f = 0;
    for (const t of model.trees) {
      const v = Number.isFinite(rows[i][t.j]) ? rows[i][t.j] : 0;
      let b = 0;
      const e = model.binEdges[t.j];
      while (b < e.length && v > e[b]) b += 1;
      f += model.lr * (b <= t.cut ? t.leftMean : t.rightMean);
    }
    out[i] = 1 / (1 + Math.exp(-f));
  }
  return out;
}

// ---------- CLI 主流程 ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) args[argv[i].slice(2)] = argv[i + 1];
  for (const k of ['input-dir', 'interactions', 'prior-edges', 'config', 'out']) {
    if (!args[k]) throw new Error(`缺少 --${k}`);
  }
  return args;
}

function loadInteractions(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = raw[0].split(',');
  const iu = header.indexOf('userId');
  const ik = header.indexOf('kpCode');
  const ic = header.indexOf('isCorrect');
  const it = header.indexOf('createdAt');
  const is = header.indexOf('sequenceIndex');
  const byUser = new Map();
  for (let i = 1; i < raw.length; i += 1) {
    const c = raw[i].split(',');
    const u = c[iu];
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push({
      kpCode: c[ik],
      isCorrect: Number(c[ic]),
      ts: Date.parse(c[it]),
      seqIndex: Number(c[is]),
    });
  }
  for (const arr of byUser.values()) arr.sort((a, b) => a.seqIndex - b.seqIndex);
  return byUser;
}

function sha256File(p) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
}

function main() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const seeds = config.seeds;
  const folds = config.folds;
  const C = config.lrC;

  // 校验边文件 sha256 与冻结配置一致
  const priorSha = sha256File(args['prior-edges']);
  if (priorSha !== config.groups.A.sha256) {
    throw new Error(`prior-edges sha256 与冻结配置不一致：${priorSha} != ${config.groups.A.sha256}`);
  }

  const byUser = loadInteractions(args.interactions);

  // A 组邻居（有向，权重 confidence）——只建一份
  const priorRows = parseEdgeCsv(fs.readFileSync(args['prior-edges'], 'utf8'), 'confidence');
  const adjA = neighborSetsFromEdges(priorRows, { directed: true });
  const kcsWithPrior = new Set(priorRows.flatMap(([a, b]) => [a, b]));

  const perSeed = [];
  for (const seed of seeds) {
    const dir = path.join(args['input-dir'], `seed-${seed}`);
    const split = JSON.parse(fs.readFileSync(path.join(dir, 'split.json'), 'utf8'));
    const trainStudents = new Set(split.train);
    const nodesDoc = JSON.parse(fs.readFileSync(path.join(dir, 'graph-nodes.json'), 'utf8'));
    const nodeArr = Array.isArray(nodesDoc) ? nodesDoc : nodesDoc.nodes;
    const kpIndex = new Map(nodeArr.map((n) => [n.kpCode, n.index]));

    // B / C 组邻居（每种子）
    const bRows = parseEdgeCsv(fs.readFileSync(path.join(dir, 'graph-real-edges.csv'), 'utf8'), 'support');
    const cRows = parseEdgeCsv(fs.readFileSync(path.join(dir, 'graph-random-edges.csv'), 'utf8'), 'one');
    const adjB = neighborSetsFromEdges(bRows, { directed: false });
    const adjC = neighborSetsFromEdges(cRows, { directed: false });

    // kc_train_acc：训练学生全体交互
    const kcAgg = new Map();
    for (const u of trainStudents) {
      for (const r of byUser.get(u) || []) {
        if (!kcAgg.has(r.kpCode)) kcAgg.set(r.kpCode, { c: 0, n: 0 });
        const a = kcAgg.get(r.kpCode);
        a.c += r.isCorrect;
        a.n += 1;
      }
    }
    const kcTrainAcc = {};
    for (const [k, v] of kcAgg) kcTrainAcc[k] = v.c / v.n;

    // 目标流：predictions.jsonl 顺序 = 学生时间序？不一定——按学生分组处理
    const predLines = fs.readFileSync(path.join(dir, 'predictions.jsonl'), 'utf8').trim().split(/\r?\n/);
    const targets = predLines.map((l) => JSON.parse(l));
    const byTargetUser = new Map();
    for (const t of targets) {
      if (!byTargetUser.has(t.userId)) byTargetUser.set(t.userId, []);
      byTargetUser.get(t.userId).push(t);
    }

    const foldAssign = groupKFold(byTargetUser.keys(), folds, config.foldSeed);
    const foldRows = Array.from({ length: folds }, () => []);
    let coverageHits = 0;

    for (const [u, list] of byTargetUser) {
      const state = emptyStudentState();
      const recs = byUser.get(u) || [];
      const byTs = new Map(list.map((t) => [t.createdAt, t]));
      for (const r of recs) {
        const tgt = byTs.get(new Date(r.ts).toISOString());
        if (tgt) {
          const h = r.seqIndex - 1;
          const fA = computeTargetFeatures({ predFull: tgt.preds['Full-DKT'], kcCode: tgt.kpCode, seqIndex: r.seqIndex, ts: r.ts, state, neighbors: adjA.get(tgt.kpCode) || null, kcTrainAcc });
          const fB = computeTargetFeatures({ predFull: tgt.preds['Full-DKT'], kcCode: tgt.kpCode, seqIndex: r.seqIndex, ts: r.ts, state, neighbors: adjB.get(tgt.kpCode) || null, kcTrainAcc });
          const fC = computeTargetFeatures({ predFull: tgt.preds['Full-DKT'], kcCode: tgt.kpCode, seqIndex: r.seqIndex, ts: r.ts, state, neighbors: adjC.get(tgt.kpCode) || null, kcTrainAcc });
          if (fA.nb.nb_missing === 0) coverageHits += 1;
          foldRows[foldAssign.get(u)].push({
            targetKey: tgt.targetKey,
            y: tgt.target,
            S: [...Object.values(fA.base)],
            A: [...Object.values(fA.nb)],
            B: [...Object.values(fB.nb)],
            C: [...Object.values(fC.nb)],
          });
        }
        updateStudentState(state, r);
      }
    }
    const targetCount = targets.length;
    let totalRows = 0;
    const keySet = new Set();
    for (const fr of foldRows) { totalRows += fr.length; for (const r of fr) keySet.add(r.targetKey); }
    if (totalRows !== targetCount || keySet.size !== targetCount) {
      throw new Error(`seed ${seed} OOF 覆盖不全: rows=${totalRows} targets=${targetCount} uniqueKeys=${keySet.size}`);
    }

    // OOF 训练/预测（同一折划分跑五个特征集）
    const featureSets = {
      S: ['S'],
      SA: ['S', 'A'],
      SB: ['S', 'B'],
      SC: ['S', 'C'],
      SAB: ['S', 'A', 'B'],
    };
    const oofPred = {};
    for (const name of Object.keys(featureSets)) {
      const parts = featureSets[name];
      const preds = new Float64Array(targetCount);
      const yArr = new Float64Array(targetCount);
      let idx = 0;
      for (let f = 0; f < folds; f += 1) {
        const testRows = foldRows[f];
        const trainRows = [];
        for (let g = 0; g < folds; g += 1) if (g !== f) trainRows.push(...foldRows[g]);
        const build = (rows) => {
          // 每个邻居块各 6 特征；块内 [missing, cov, recent_acc, last_correct, gap, recent20]
          // 缺失指示列 = 各已选块的 recent_acc/last_correct/gap 三列位置
          const missIdx = [];
          let offset = 10;
          for (const g of ['A', 'B', 'C']) {
            if (parts.includes(g)) missIdx.push(offset + 2, offset + 3, offset + 4);
            offset += 6;
          }
          return { rows: rows.map((r) => parts.flatMap((p) => r[p])), missIdx };
        };
        const { rows: trainFeat, missIdx } = build(trainRows);
        const testFeat = build(testRows).rows;
        const scaler = fitScaler(trainFeat, config.baseFeatures.concat(config.neighborFeatures));
        const Xtr = transformRows(trainFeat, scaler, missIdx);
        const Xte = transformRows(testFeat, scaler, missIdx);
        const ytr = trainRows.map((r) => r.y);
        const w = trainLR(Xtr, ytr, C);
        const p = predictLR(w, Xte);
        for (let i = 0; i < testRows.length; i += 1) {
          preds[idx] = p[i];
          yArr[idx] = testRows[i].y;
          idx += 1;
        }
      }
      const pairs = Array.from({ length: targetCount }, (_, i) => ({ p: preds[i], y: yArr[i] }));
      oofPred[name] = { logLoss: logLossOf(pairs), auc: aucOf(pairs) };
    }

    const dA = oofPred.S.logLoss - oofPred.SA.logLoss;
    const dB = oofPred.S.logLoss - oofPred.SB.logLoss;
    const dC = oofPred.S.logLoss - oofPred.SC.logLoss;
    const dAB = oofPred.SB.logLoss - oofPred.SAB.logLoss;

    // 复核模型：直方图桩提升（仅配置指定的种子与特征集，验证 Δ 符号一致性）
    let review = null;
    if (config.reviewModel && config.reviewModel.seeds.includes(seed)) {
      review = {};
      for (const name of config.reviewModel.appliedTo) {
        const parts = featureSets[name];
        const build = (rows) => {
          const missIdx = [];
          let offset = 10;
          for (const g of ['A', 'B', 'C']) {
            if (parts.includes(g)) missIdx.push(offset + 2, offset + 3, offset + 4);
            offset += 6;
          }
          return { rows: rows.map((r) => parts.flatMap((p) => r[p])), missIdx };
        };
        const preds = new Float64Array(targetCount);
        const yArr = new Float64Array(targetCount);
        let idx = 0;
        for (let f = 0; f < folds; f += 1) {
          const testRows = foldRows[f];
          const trainRows = [];
          for (let g = 0; g < folds; g += 1) if (g !== f) trainRows.push(...foldRows[g]);
          const { rows: trainFeat, missIdx } = build(trainRows);
          const testFeat = build(testRows).rows;
          const scaler = fitScaler(trainFeat, config.baseFeatures.concat(config.neighborFeatures));
          const Xtr = transformRows(trainFeat, scaler, missIdx);
          const Xte = transformRows(testFeat, scaler, missIdx);
          const ytr = trainRows.map((r) => r.y);
          const model = stumpBoostTrain(Xtr, ytr, { bins: 16, rounds: 100, lr: 0.5 });
          const p = stumpBoostPredict(model, Xte);
          for (let i = 0; i < testRows.length; i += 1) {
            preds[idx] = p[i];
            yArr[idx] = testRows[i].y;
            idx += 1;
          }
        }
        const pairs = Array.from({ length: targetCount }, (_, i) => ({ p: preds[i], y: yArr[i] }));
        review[name] = { logLoss: logLossOf(pairs), auc: aucOf(pairs) };
      }
      review.deltaA_boost = review.S.logLoss - review.SA.logLoss;
    }

    perSeed.push({
      seed,
      targetCount,
      coverage: coverageHits / targetCount,
      coverageKcPrior: kcsWithPrior.size / 100,
      logLoss: { S: oofPred.S.logLoss, SA: oofPred.SA.logLoss, SB: oofPred.SB.logLoss, SC: oofPred.SC.logLoss, SAB: oofPred.SAB.logLoss },
      auc: { S: oofPred.S.auc, SA: oofPred.SA.auc, SB: oofPred.SB.auc, SC: oofPred.SC.auc, SAB: oofPred.SAB.auc },
      delta: { A: dA, B: dB, C: dC, AB: dAB },
      review,
    });
    console.log(`seed ${seed}: coverage=${(coverageHits / targetCount).toFixed(3)} ΔA=${dA.toExponential(2)} ΔB=${dB.toExponential(2)} ΔC=${dC.toExponential(2)} ΔA|B=${dAB.toExponential(2)}`);
  }

  // 聚合 + 判定
  const agg = (key) => {
    const xs = perSeed.map((s) => s.delta[key]);
    return { mean: meanOf(xs), std: popStdOf(xs), positiveCount: xs.filter((x) => x > 0).length, perSeed: xs };
  };
  const aggregate = {
    deltaA: agg('A'),
    deltaB: agg('B'),
    deltaC: agg('C'),
    deltaAB: agg('AB'),
    coverageMean: meanOf(perSeed.map((s) => s.coverage)),
  };

  const th = config.thresholds;
  let signal;
  if (aggregate.deltaA.mean >= th.strongDeltaA
      && aggregate.deltaA.positiveCount >= th.strongMinPositiveSeeds
      && aggregate.deltaAB.mean >= th.strongDeltaAB
      && aggregate.deltaC.mean <= th.strongMaxDeltaC) signal = 'strong';
  else if (aggregate.deltaA.mean >= th.grayDeltaA || aggregate.deltaA.positiveCount >= th.grayPositiveSeeds) signal = 'gray';
  else signal = 'none';
  if (aggregate.deltaC.mean >= th.randomGuardInvalid) signal = 'INVALID(leak-suspect)';

  let verdict;
  if (signal === 'strong') verdict = aggregate.coverageMean >= 0.4 ? 'build' : 'switch-dataset';
  else if (signal === 'gray') verdict = 'switch-dataset-review';
  else if (signal === 'none') verdict = 'stop';
  else verdict = 'invalid-review-leak';

  const output = {
    protocolVersion: 'assist2009-prior-probe-v1',
    exploratoryDecisionExperiment: true,
    generatedAt: new Date().toISOString(),
    config: args.config,
    priorEdges: { file: args['prior-edges'], sha256: priorSha, edgeCount: priorRows.length, kcsWithPrior: kcsWithPrior.size, isolatedKcs: 100 - kcsWithPrior.size },
    perSeed,
    aggregate,
    decision: { signal, coverage: aggregate.coverageMean, verdict },
    reviewModelNote: config.reviewModel,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`\n判定: signal=${signal} coverage=${aggregate.coverageMean.toFixed(3)} verdict=${verdict}`);
  console.log(`已写出: ${args.out}`);
}

if (require.main === module) main();

module.exports = {
  logitClip,
  log1pSafe,
  aucOf,
  logLossOf,
  neighborSetsFromEdges,
  parseEdgeCsv,
  emptyStudentState,
  updateStudentState,
  computeTargetFeatures,
  groupKFold,
  trainLR,
  predictLR,
  fitScaler,
  transformRows,
  stumpBoostTrain,
  stumpBoostPredict,
  loadInteractions,
};
