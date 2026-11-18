#!/usr/bin/env node
/**
 * priorProbeSubgroup.js —— 闸门实验的事后子群复核（post-hoc，只读追加）
 *
 * 为什么需要它：
 *   探针的主端点 ΔA 是**全部目标**上的 OOF LogLoss 平均，但只有 17.9% 的目标满足
 *   「学生已练过至少一个先修知识点」（nb_missing = 0）。其余 82% 的目标上先修特征
 *   全为缺失，这些行的 Δ 被结构性压到接近 0，于是整体 ΔA 被稀释约 1/0.179 ≈ 5.6 倍。
 *   本脚本只在「有已练先修邻居」的子群上重算 ΔA，检验 stop 判定是否因稀释而失真。
 *
 * 定位声明（必读）：
 *   - 事后探索（post-hoc），发生在冻结判定之后；不改变任何阈值、不改冻结管线；
 *   - 不重训新模型、不换超参，完全复用 priorSignalProbe.js 的纯函数与同一折划分；
 *   - 结果只能用于检验「整体结论是否被稀释」，**不能**用来翻案宣布图有效。
 *   - 内置复现校验：整体 ΔA 必须与 probe.json 的 perSeed 值逐位一致，否则报错退出。
 *
 * 用法：
 *   cd backend
 *   node models/priorProbeSubgroup.js \
 *     --input-dir 实验结果文件/gcn-dkt-v1 \
 *     --interactions datasets/assist2009/interactions.csv \
 *     --prior-edges datasets/assist2009/prior-edges.csv \
 *     --config 实验结果文件/prior-probe-v1/probe-config.json \
 *     --probe 实验结果文件/prior-probe-v1/probe.json \
 *     --out 实验结果文件/prior-probe-v1/subgroup-posthoc.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const probe = require('./priorSignalProbe');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) args[argv[i].slice(2)] = argv[i + 1];
  for (const k of ['input-dir', 'interactions', 'prior-edges', 'config', 'probe', 'out']) {
    if (!args[k]) throw new Error(`缺少 --${k}`);
  }
  return args;
}

function sha256File(p) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
}

function meanOf(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function popStdOf(xs) {
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/** 与上游完全一致：选择块 → 行拼接 + 缺失指示列位置（块内 [missing,cov,recent_acc,last_correct,gap,recent20]） */
function makeBuilder(parts) {
  const missIdx = [];
  let offset = 10;
  for (const g of ['A', 'B', 'C']) {
    if (parts.includes(g)) missIdx.push(offset + 2, offset + 3, offset + 4);
    offset += 6;
  }
  return (rows) => ({ rows: rows.map((r) => parts.flatMap((p) => r[p])), missIdx });
}

function main() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const probeJson = JSON.parse(fs.readFileSync(args.probe, 'utf8'));

  const priorSha = sha256File(args['prior-edges']);
  if (priorSha !== config.groups.A.sha256) {
    throw new Error(`prior-edges sha256 与冻结配置不一致：${priorSha}`);
  }

  const byUser = probe.loadInteractions(args.interactions);
  const priorRows = probe.parseEdgeCsv(fs.readFileSync(args['prior-edges'], 'utf8'), 'confidence');
  const adjA = probe.neighborSetsFromEdges(priorRows, { directed: true });

  const folds = config.folds;
  const C = config.lrC;
  const featureSets = { S: ['S'], SA: ['S', 'A'], SB: ['S', 'B'], SC: ['S', 'C'], SAB: ['S', 'A', 'B'] };
  const expectedOverall = new Map(probeJson.perSeed.map((s) => [s.seed, s.delta]));

  const perSeed = [];
  for (const seed of config.seeds) {
    const dir = path.join(args['input-dir'], `seed-${seed}`);
    const split = JSON.parse(fs.readFileSync(path.join(dir, 'split.json'), 'utf8'));
    const trainStudents = new Set(split.train);
    const nodesDoc = JSON.parse(fs.readFileSync(path.join(dir, 'graph-nodes.json'), 'utf8'));
    const nodeArr = Array.isArray(nodesDoc) ? nodesDoc : nodesDoc.nodes;
    void nodeArr;

    const bRows = probe.parseEdgeCsv(fs.readFileSync(path.join(dir, 'graph-real-edges.csv'), 'utf8'), 'support');
    const adjB = probe.neighborSetsFromEdges(bRows, { directed: false });
    const cRows = probe.parseEdgeCsv(fs.readFileSync(path.join(dir, 'graph-random-edges.csv'), 'utf8'), 'one');
    const adjC = probe.neighborSetsFromEdges(cRows, { directed: false });

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

    const rawLines = fs.readFileSync(path.join(dir, 'predictions.jsonl'), 'utf8').trim().split(/\r?\n/);
    const targets = rawLines.map((l) => JSON.parse(l));
    const byTargetUser = new Map();
    for (const t of targets) {
      if (!byTargetUser.has(t.userId)) byTargetUser.set(t.userId, []);
      byTargetUser.get(t.userId).push(t);
    }

    const foldAssign = probe.groupKFold(byTargetUser.keys(), folds, config.foldSeed);
    const foldRows = Array.from({ length: folds }, () => []);

    for (const [u, list] of byTargetUser) {
      const state = probe.emptyStudentState();
      const recs = byUser.get(u) || [];
      const byTs = new Map(list.map((t) => [t.createdAt, t]));
      for (const r of recs) {
        const tgt = byTs.get(new Date(r.ts).toISOString());
        if (tgt) {
          const fA = probe.computeTargetFeatures({ predFull: tgt.preds['Full-DKT'], kcCode: tgt.kpCode, seqIndex: r.seqIndex, ts: r.ts, state, neighbors: adjA.get(tgt.kpCode) || null, kcTrainAcc });
          const fB = probe.computeTargetFeatures({ predFull: tgt.preds['Full-DKT'], kcCode: tgt.kpCode, seqIndex: r.seqIndex, ts: r.ts, state, neighbors: adjB.get(tgt.kpCode) || null, kcTrainAcc });
          const fC = probe.computeTargetFeatures({ predFull: tgt.preds['Full-DKT'], kcCode: tgt.kpCode, seqIndex: r.seqIndex, ts: r.ts, state, neighbors: adjC.get(tgt.kpCode) || null, kcTrainAcc });
          foldRows[foldAssign.get(u)].push({
            targetKey: tgt.targetKey,
            y: tgt.target,
            S: [...Object.values(fA.base)],
            A: [...Object.values(fA.nb)],
            B: [...Object.values(fB.nb)],
            C: [...Object.values(fC.nb)],
          });
        }
        probe.updateStudentState(state, r);
      }
    }

    const targetCount = targets.length;
    const ordered = foldRows.flat();
    if (ordered.length !== targetCount) throw new Error(`seed ${seed} 行数不匹配: ${ordered.length} != ${targetCount}`);

    const oof = {};
    for (const name of Object.keys(featureSets)) {
      const build = makeBuilder(featureSets[name]);
      const preds = new Float64Array(targetCount);
      let idx = 0;
      for (let f = 0; f < folds; f += 1) {
        const testRows = foldRows[f];
        const trainRows = [];
        for (let g = 0; g < folds; g += 1) if (g !== f) trainRows.push(...foldRows[g]);
        const { rows: trainFeat, missIdx } = build(trainRows);
        const testFeat = build(testRows).rows;
        const scaler = probe.fitScaler(trainFeat, config.baseFeatures.concat(config.neighborFeatures));
        const Xtr = probe.transformRows(trainFeat, scaler, missIdx);
        const Xte = probe.transformRows(testFeat, scaler, missIdx);
        const ytr = trainRows.map((r) => r.y);
        const w = probe.trainLR(Xtr, ytr, C);
        const p = probe.predictLR(w, Xte);
        for (let i = 0; i < testRows.length; i += 1) { preds[idx] = p[i]; idx += 1; }
      }
      oof[name] = preds;
    }

    // ---- 复现校验：整体 Δ 必须与 probe.json 逐位一致 ----
    const pairsAll = (name) => Array.from({ length: targetCount }, (_, i) => ({ p: oof[name][i], y: ordered[i].y }));
    const llAll = { S: probe.logLossOf(pairsAll('S')), SA: probe.logLossOf(pairsAll('SA')), SB: probe.logLossOf(pairsAll('SB')), SAB: probe.logLossOf(pairsAll('SAB')) };
    const dAoverall = llAll.S - llAll.SA;
    const dABoverall = llAll.SB - llAll.SAB;
    const exp = expectedOverall.get(seed);
    const tol = 1e-9;
    if (!exp || Math.abs(dAoverall - exp.A) > tol || Math.abs(dABoverall - exp.AB) > tol) {
      throw new Error(`seed ${seed} 复现校验失败: ΔA=${dAoverall} 期望=${exp && exp.A}; ΔA|B=${dABoverall} 期望=${exp && exp.AB}`);
    }

    // ---- 子群掩码 ----
    // nb_missing 是邻居块首列：0 = 学生已练过 ≥1 个先修邻居
    const maskA = ordered.map((r) => r.A[0] === 0);
    const maskB = ordered.map((r) => r.B[0] === 0);
    const maskC = ordered.map((r) => r.C[0] === 0);
    const sub = (mask, name) => {
      const pairs = [];
      for (let i = 0; i < targetCount; i += 1) if (mask[i]) pairs.push({ p: oof[name][i], y: ordered[i].y });
      return { n: pairs.length, ll: pairs.length ? probe.logLossOf(pairs) : null, auc: probe.aucOf(pairs) };
    };

    const nA = maskA.filter(Boolean).length;
    const nB = maskB.filter(Boolean).length;
    const nC = maskC.filter(Boolean).length;
    const covA = {
      S: sub(maskA, 'S'), SA: sub(maskA, 'SA'),
    };
    const covB = {
      SB: sub(maskB, 'SB'), SAB: sub(maskB, 'SAB'),
    };
    const covC = {
      S: sub(maskC, 'S'), SC: sub(maskC, 'SC'),
    };
    const dAcov = covA.S.ll - covA.SA.ll;
    const dABcov = covB.SB.ll - covB.SAB.ll;
    const dCcov = covC.S.ll - covC.SC.ll;

    perSeed.push({
      seed,
      targetCount,
      nCovA: nA,
      covAShare: nA / targetCount,
      nCovB: nB,
      covBShare: nB / targetCount,
      overall: {
        logLoss: llAll,
        deltaA: dAoverall,
        deltaAB: dABoverall,
      },
      subgroupA: {
        logLoss: { S: covA.S.ll, SA: covA.SA.ll },
        auc: { S: covA.S.auc, SA: covA.SA.auc },
        deltaA: dAcov,
      },
      subgroupB: {
        logLoss: { SB: covB.SB.ll, SAB: covB.SAB.ll },
        deltaAB: dABcov,
      },
      subgroupC: {
        nCovered: nC,
        covCShare: nC / targetCount,
        logLoss: { S: covC.S.ll, SC: covC.SC.ll },
        deltaC: dCcov,
      },
      dilutionFactor: (nA / targetCount) || null,
    });
    console.log(`seed ${seed}: covA=${nA}/${targetCount} (${(nA / targetCount).toFixed(3)}) ΔA_overall=${dAoverall.toExponential(3)} ΔA_cov=${dAcov.toExponential(3)} ΔC_cov=${dCcov.toExponential(3)}`);
  }

  const agg = (key) => {
    const xs = perSeed.map((s) => s[key]);
    return { mean: meanOf(xs), std: popStdOf(xs), positiveCount: xs.filter((x) => x > 0).length, perSeed: xs };
  };

  const out = {
    protocolVersion: 'assist2009-prior-probe-subgroup-posthoc-v1',
    postHoc: true,
    generatedAt: new Date().toISOString(),
    note: '事后子群复核：只检验整体 ΔA 是否被「82% 目标无已练先修邻居」稀释，不构成对冻结判定的翻案依据。',
    priorEdgesSha256: priorSha,
    perSeed,
    aggregate: {
      deltaA_overall: (() => { const xs = perSeed.map((s) => s.overall.deltaA); return { mean: meanOf(xs), std: popStdOf(xs), positiveCount: xs.filter((x) => x > 0).length, perSeed: xs }; })(),
      deltaA_subgroup: (() => { const xs = perSeed.map((s) => s.subgroupA.deltaA); return { mean: meanOf(xs), std: popStdOf(xs), positiveCount: xs.filter((x) => x > 0).length, perSeed: xs }; })(),
      deltaAB_subgroup: (() => { const xs = perSeed.map((s) => s.subgroupB.deltaAB); return { mean: meanOf(xs), std: popStdOf(xs), positiveCount: xs.filter((x) => x > 0).length, perSeed: xs }; })(),
      deltaC_subgroup: (() => { const xs = perSeed.map((s) => s.subgroupC.deltaC); return { mean: meanOf(xs), std: popStdOf(xs), positiveCount: xs.filter((x) => x > 0).length, perSeed: xs }; })(),
      covAShareMean: meanOf(perSeed.map((s) => s.covAShare)),
      impliedDilution: 1 / meanOf(perSeed.map((s) => s.covAShare)),
    },
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`);

  const a = out.aggregate.deltaA_subgroup;
  const o = out.aggregate.deltaA_overall;
  const c = out.aggregate.deltaC_subgroup;
  console.log(`\n整体 ΔA: mean=${o.mean.toExponential(3)} (${o.positiveCount}/5 正)`);
  console.log(`子群 ΔA: mean=${a.mean.toExponential(3)} (${a.positiveCount}/5 正)  覆盖率=${out.aggregate.covAShareMean.toFixed(3)}  稀释倍数=${out.aggregate.impliedDilution.toFixed(2)}`);
  console.log(`子群 ΔC（随机对照）: mean=${c.mean.toExponential(3)} (${c.positiveCount}/5 正)`);
  console.log(`已写出: ${args.out}`);
}

if (require.main === module) main();

module.exports = { popStdOf, meanOf };
