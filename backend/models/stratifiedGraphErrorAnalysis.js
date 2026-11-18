#!/usr/bin/env node
/**
 * stratifiedGraphErrorAnalysis.js —— 图增强 DKT 分层误差分析（探索性，不重训）
 *
 * 定位：阶段 E 之后的**事后探索性分析**。不加载模型、不重训，只从已落盘的
 * 25 次拟合预测（seed-{42..46}/predictions.jsonl）按三个分层维度重算
 * GCN−Full ΔAUC，检验「图增益是否出现在某个子群」：
 *   ① 目标知识点图度数：isolated（度 0）/ low（1–2）/ hub（≥3），
 *      度数取**本种子** graph-real-edges.csv（图随种子 train 集不同而不同）；
 *   ② 历史长度 h：目标记录在学生全序列中的前一交互数（sequenceIndex−1），
 *      分桶 h0-5 / h6-15 / h16plus（全数据序列中位数 6）；
 *   ③ 学生活跃度：学生总交互数，act1-10 / act11-30 / act31plus。
 * 比较对象：GCN−Full（主）与 GCN−RandomGraph（结构 vs 容量，仅点估计）。
 *
 * 统计口径（诚实披露）：
 *   - 每个种子内部：同一批目标上配对计算两模型 AUC / LogLoss 与差值；
 *   - 跨种子：mean ± 总体标准差（÷n）与正向种子数；**不做跨种子显著性检验**；
 *   - 不做子群内 bootstrap CI（多次比较 + 事后选桶会放大假阳性）；
 *   - 全部结论须标注「探索性、事后、多重比较」——不构成冻结协议下的判定，
 *     不能因为某个子群出现正差值就回头宣布图有效。
 *
 * 用法：
 *   cd backend
 *   node models/stratifiedGraphErrorAnalysis.js \
 *     --input-dir 实验结果文件/gcn-dkt-v1 \
 *     --interactions datasets/assist2009/interactions.csv \
 *     --seeds 42,43,44,45,46 [--out 实验结果文件/gcn-dkt-v1/stratified-error-analysis.json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 纯函数（导出供测试） ----------

/** 从图边 CSV 行（sourceIndex,targetIndex,sourceKp,targetKp,support）算度数表 */
function degreeMapFromEdges(lines) {
  const deg = new Map();
  const weighted = new Map();
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('sourceIndex')) continue;
    const cols = t.split(',');
    const a = cols[2];
    const b = cols[3];
    const support = Number(cols[4]);
    if (!Number.isFinite(support) || !a || !b) {
      throw new Error(`图边行格式异常: ${t}`);
    }
    deg.set(a, (deg.get(a) || 0) + 1);
    deg.set(b, (deg.get(b) || 0) + 1);
    weighted.set(a, (weighted.get(a) || 0) + support);
    weighted.set(b, (weighted.get(b) || 0) + support);
  }
  return { deg, weighted };
}

function bucketOfDegree(deg) {
  if (!Number.isInteger(deg) || deg < 0) throw new Error(`非法度数: ${deg}`);
  if (deg === 0) return 'isolated';
  if (deg <= 2) return 'low(1-2)';
  return 'hub(3+)';
}

function bucketOfHistory(h) {
  if (!Number.isInteger(h) || h < 0) throw new Error(`非法历史长度: ${h}`);
  if (h <= 5) return 'h0-5';
  if (h <= 15) return 'h6-15';
  return 'h16plus';
}

function bucketOfActivity(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`非法活跃度: ${n}`);
  if (n <= 10) return 'act1-10';
  if (n <= 30) return 'act11-30';
  return 'act31plus';
}

/** AUC：单类返回 null（不可定义即拒绝给出数值）；平均秩法（含并列秩） */
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
    const avgRank = (i + j + 1) / 2; // 1-based 平均秩：秩 i+1..j
    for (let k = i; k < j; k += 1) {
      if (all[k].y === 1) rankSumPos += avgRank;
    }
    i = j;
  }
  const u = rankSumPos - (n1 * (n1 + 1)) / 2;
  return u / (n1 * n0);
}

/** LogLoss；p 截断 [eps,1-eps] 与主实验 bceEps=1e-7 一致 */
function logLossOf(pairs, eps = 1e-7) {
  let s = 0;
  for (const { p, y } of pairs) {
    const q = Math.min(1 - eps, Math.max(eps, p));
    s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  }
  return s / pairs.length;
}

function meanOf(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function populationStdOf(xs) {
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/** 对一组记录按维度分桶并计算指标（records: {predFull,predGcn,predRandom,target}） */
function metricsForPairs(recs, keyA, keyB) {
  const pairs = recs.map((r) => ({ p: r[keyA], y: r.target }));
  const pairsB = recs.map((r) => ({ p: r[keyB], y: r.target }));
  const aucA = aucOf(pairs);
  const aucB = aucOf(pairsB);
  return {
    n: recs.length,
    positiveRate: meanOf(recs.map((r) => r.target)),
    aucA,
    aucB,
    dAuc: aucA !== null && aucB !== null ? aucB - aucA : null,
    logLossA: logLossOf(pairs),
    logLossB: logLossOf(pairsB),
    dLogLoss: logLossOf(pairsB) - logLossOf(pairs),
  };
}

/** 主分层：给定带元数据的记录列表，返回三个维度 × 桶的指标 */
function stratify(records) {
  const dims = {
    degree: bucketOfDegree,
    history: bucketOfHistory,
    activity: bucketOfActivity,
  };
  const out = {};
  for (const [dim, fn] of Object.entries(dims)) {
    const groups = new Map();
    for (const r of records) {
      const b = fn(r[dim]);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(r);
    }
    out[dim] = {};
    for (const [b, recs] of groups) {
      const mFullGcn = metricsForPairs(recs, 'predFull', 'predGcn');
      const mGcnRandom = metricsForPairs(recs, 'predGcn', 'predRandom');
      out[dim][b] = {
        n: mFullGcn.n,
        positiveRate: mFullGcn.positiveRate,
        aucFull: mFullGcn.aucA,
        aucGcn: mFullGcn.aucB,
        dAucGcnMinusFull: mFullGcn.dAuc,
        logLossFull: mFullGcn.logLossA,
        logLossGcn: mFullGcn.logLossB,
        dLogLossGcnMinusFull: mFullGcn.dLogLoss,
        aucRandom: mGcnRandom.aucB,
        dAucGcnMinusRandom: mGcnRandom.dAuc,
      };
    }
  }
  return out;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || !k.startsWith('--')) throw new Error(`参数异常: ${k}`);
    args[k.slice(2)] = v;
  }
  if (!args['input-dir']) throw new Error('用法: --input-dir <gcn-dkt-v1 目录> --interactions <interactions.csv> --seeds 42,43,44,45,46 [--out <json>]');
  if (!args.interactions) throw new Error('缺少 --interactions');
  if (!args.seeds) throw new Error('缺少 --seeds');
  return args;
}

/** 读 interactions.csv：返回 (userId|createdAt -> sequenceIndex) 与用户总交互数 */
function loadInteractionMeta(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = raw[0].split(',');
  const iu = header.indexOf('userId');
  const ic = header.indexOf('createdAt');
  const is = header.indexOf('sequenceIndex');
  if (iu < 0 || ic < 0 || is < 0) throw new Error('interactions.csv 缺少 userId/createdAt/sequenceIndex 列');
  const seqByKey = new Map();
  const activity = new Map();
  let duplicateKeys = 0;
  for (let i = 1; i < raw.length; i += 1) {
    const cols = raw[i].split(',');
    const u = cols[iu];
    const c = cols[ic];
    const s = Number(cols[is]);
    const key = `${u}|${c}`;
    if (seqByKey.has(key)) duplicateKeys += 1;
    seqByKey.set(key, s); // 同键重复取最大 sequenceIndex（后写覆盖）
    activity.set(u, Math.max(activity.get(u) || 0, s));
  }
  return { seqByKey, activity, duplicateKeys, rows: raw.length - 1 };
}

function main() {
  const args = parseArgs(process.argv);
  const seeds = args.seeds.split(',').map((s) => Number(s.trim()));
  const inputDir = args['input-dir'];

  const meta = loadInteractionMeta(args.interactions);
  console.log(`interactions.csv: ${meta.rows} 行，重复 (userId|createdAt) 键 ${meta.duplicateKeys} 个`);

  const perSeed = {};
  const bucketKeys = { degree: [], history: [], activity: [] };

  for (const seed of seeds) {
    const dir = path.join(inputDir, `seed-${seed}`);
    const targets = JSON.parse(fs.readFileSync(path.join(dir, 'targets.json'), 'utf8'));
    const predLines = fs.readFileSync(path.join(dir, 'predictions.jsonl'), 'utf8').trim().split(/\r?\n/);
    if (predLines.length !== targets.targetCount) {
      throw new Error(`seed ${seed} predictions 行数 ${predLines.length} != targetCount ${targets.targetCount}`);
    }
    const edgeLines = fs.readFileSync(path.join(dir, 'graph-real-edges.csv'), 'utf8').trim().split(/\r?\n/);
    const { deg } = degreeMapFromEdges(edgeLines);

    const records = new Array(predLines.length);
    let missing = 0;
    for (let i = 0; i < predLines.length; i += 1) {
      const p = JSON.parse(predLines[i]);
      const seq = meta.seqByKey.get(`${p.userId}|${p.createdAt}`);
      if (seq === undefined) {
        missing += 1;
        continue;
      }
      records[i] = {
        target: p.target,
        predFull: p.preds['Full-DKT'],
        predGcn: p.preds['GCN-DKT'],
        predRandom: p.preds['RandomGraph-DKT'],
        degree: deg.get(p.kpCode) || 0,
        history: seq - 1,
        activity: meta.activity.get(p.userId),
      };
    }
    if (missing > 0) throw new Error(`seed ${seed} 有 ${missing} 条目标无法对齐 interactions.csv，拒绝输出`);

    const result = stratify(records);
    perSeed[seed] = result;
    for (const dim of Object.keys(bucketKeys)) {
      for (const b of Object.keys(result[dim])) {
        if (!bucketKeys[dim].includes(b)) bucketKeys[dim].push(b);
      }
    }
    console.log(`seed ${seed}: 分层完成（度数/历史/活跃度 三维度）`);
  }

  // 跨种子聚合
  const aggregate = {};
  for (const dim of Object.keys(bucketKeys)) {
    aggregate[dim] = {};
    for (const b of bucketKeys[dim]) {
      const dAuc = seeds.map((s) => perSeed[s][dim][b].dAucGcnMinusFull).filter((x) => x !== null);
      const dAucRandom = seeds.map((s) => perSeed[s][dim][b].dAucGcnMinusRandom).filter((x) => x !== null);
      aggregate[dim][b] = {
        aucAvailableSeeds: dAuc.length,
        totalSeeds: seeds.length,
        nPerSeed: seeds.map((s) => perSeed[s][dim][b].n),
        positiveRateMean: meanOf(seeds.map((s) => perSeed[s][dim][b].positiveRate)),
        dAucGcnMinusFull: dAuc.length === seeds.length
          ? { perSeed: dAuc, mean: meanOf(dAuc), populationStd: populationStdOf(dAuc), positiveSeeds: dAuc.filter((x) => x > 0).length }
          : null,
        dAucGcnMinusRandom: dAucRandom.length === seeds.length
          ? { perSeed: dAucRandom, mean: meanOf(dAucRandom), populationStd: populationStdOf(dAucRandom), positiveSeeds: dAucRandom.filter((x) => x > 0).length }
          : null,
      };
    }
  }

  const output = {
    stage: 'stratified-error-analysis',
    exploratory: true,
    disclaimer: '事后探索性分层分析：不重训、不引入新协议；分桶在见到逐种子结果前以数据常识固定（度数 0/1-2/3+，历史 0-5/6-15/16+，活跃度 1-10/11-30/31+）；不做子群内 bootstrap CI，跨种子仅 mean±总体std 与正向种子数；任何子群结论都受多重比较影响，不能作为图结构有效性的正式判定。',
    generatedAt: new Date().toISOString(),
    inputDir,
    seeds,
    bucketDefinitions: {
      degree: '本种子 graph-real-edges.csv 无权度：isolated=0, low=1-2, hub>=3',
      history: '目标记录 sequenceIndex-1（前一交互数）：h0-5 / h6-15 / h16plus',
      activity: '学生总交互数：act1-10 / act11-30 / act31plus',
    },
    interactionsMeta: { rows: meta.rows, duplicateKeys: meta.duplicateKeys },
    perSeed,
    aggregate,
  };

  const outPath = args.out || path.join(inputDir, 'stratified-error-analysis.json');
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`已写出: ${outPath}`);

  // 摘要打印
  for (const dim of Object.keys(aggregate)) {
    console.log(`\n== ${dim} ==`);
    for (const [b, v] of Object.entries(aggregate[dim])) {
      const d = v.dAucGcnMinusFull;
      const dr = v.dAucGcnMinusRandom;
      console.log(
        `  ${b.padEnd(10)} n~${Math.round(meanOf(v.nPerSeed))} posRate=${v.positiveRateMean.toFixed(3)} `
        + `ΔAUC(GCN−Full)=${(d.mean * 1000).toFixed(3)}e-3 ±${(d.populationStd * 1000).toFixed(3)}e-3 正${d.positiveSeeds}/${v.totalSeeds} `
        + `| GCN−Random ${(dr.mean * 1000).toFixed(3)}e-3 正${dr.positiveSeeds}/${v.totalSeeds}`,
      );
    }
  }
}

if (require.main === module) main();

module.exports = {
  degreeMapFromEdges,
  bucketOfDegree,
  bucketOfHistory,
  bucketOfActivity,
  aucOf,
  logLossOf,
  stratify,
  metricsForPairs,
  loadInteractionMeta,
};
