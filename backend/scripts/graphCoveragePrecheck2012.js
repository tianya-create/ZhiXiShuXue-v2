#!/usr/bin/env node
/**
 * graphCoveragePrecheck2012.js —— 2012 图覆盖率预检（不看模型性能）
 *
 * 协议：assist2012-gcn-dkt-v1 §2.4
 *   - 对五个种子的 train 图分别报告：节点数、边数、孤立节点比例、
 *     train / validation 目标落在非孤立节点的比例、每题多 skill 比例
 *   - 可行性闸门：五种子 validation 目标覆盖率均值 < 40% → 停止正式训练，
 *     报告「同口径图仍过稀疏」，保留图统计；不得解释为再次证明无增益
 *   - 本脚本只读 interactions.csv 与已落盘的图产物，不加载模型、不生成预测、不读 test 标签
 *
 * 用法：
 *   node scripts/graphCoveragePrecheck2012.js \
 *     --interactions backend/datasets/assist2012/interactions.csv \
 *     --graphs-root  backend/实验结果文件/assist2012-gcn-dkt-v1 \
 *     --out          backend/实验结果文件/assist2012-gcn-dkt-v1/precheck-coverage.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const THRESHOLD = 0.40;

function loadDkt() {
  const candidates = [
    path.join(__dirname, '..', 'models', 'dkt.js'),
    path.join(__dirname, '..', 'model', 'dkt.js')
  ];
  for (const p of candidates) {
    try { return require(p); } catch (e) { /* 下一个 */ }
  }
  throw new Error('找不到 dkt.js');
}

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    interactions: get('interactions', path.join('backend', 'datasets', 'assist2012', 'interactions.csv')),
    graphsRoot: get('graphs-root', path.join('backend', '实验结果文件', 'assist2012-gcn-dkt-v1')),
    out: get('out', null),
    seeds: get('seeds', '42,43,44,45,46').split(',').map(Number)
  };
}

const sha256File = (p) => 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 与 graphDktExperiment.buildTargetManifest 同一规则：某组学生的 (学生,知识点) 非首条记录 */
function buildTargets(sequences, studentSet) {
  const targets = [];
  for (const seq of sequences) {
    if (!studentSet.has(seq.userId)) continue;
    const firstTs = new Map();
    for (const it of seq.items) {
      if (!firstTs.has(it.kpCode) || it.ts < firstTs.get(it.kpCode)) firstTs.set(it.kpCode, it.ts);
    }
    for (const it of seq.items) {
      if (it.ts <= firstTs.get(it.kpCode)) continue;
      targets.push({ targetKey: `${seq.userId}|${it.ts}`, kpCode: it.kpCode });
    }
  }
  return targets;
}

function coverage(edges, targets) {
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.s, (deg.get(e.s) || 0) + 1);
    deg.set(e.t, (deg.get(e.t) || 0) + 1);
  }
  let hit = 0;
  for (const t of targets) if ((deg.get(t.kpCode) || 0) > 0) hit++;
  return {
    targetCount: targets.length,
    nonIsolatedTargetCount: hit,
    coverage: targets.length ? Number((hit / targets.length).toFixed(6)) : null
  };
}

function readEdges(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  return lines.slice(1).filter(Boolean).map((line) => {
    const [, , sk, tk, sup] = line.split(',');
    return { s: sk, t: tk, w: Number(sup) };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dkt = loadDkt();
  const interPath = path.resolve(args.interactions);
  const lines = fs.readFileSync(interPath, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  const records = [];
  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(',');
    records.push({
      userId: c[ix.userId], questionId: c[ix.questionId], kpCode: c[ix.kpCode],
      isCorrect: Number(c[ix.isCorrect]), createdAt: c[ix.createdAt]
    });
  }
  const sequences = dkt.buildStudentSequences(records);
  console.log(`交互 ${records.length} 条，学生 ${sequences.length} 名，序列口径已按 dkt.buildStudentSequences 归一`);

  const seedReports = [];
  for (const seed of args.seeds) {
    const dir = path.join(path.resolve(args.graphsRoot), `seed-${seed}`);
    const split = JSON.parse(fs.readFileSync(path.join(dir, 'split.json'), 'utf8'));
    const vocab = JSON.parse(fs.readFileSync(path.join(dir, 'vocabulary.json'), 'utf8'));
    const realManifest = JSON.parse(fs.readFileSync(path.join(dir, 'graph-real-manifest.json'), 'utf8'));
    const edges = readEdges(path.join(dir, 'graph-real-edges.csv'));

    const trainSet = new Set(split.train);
    const valSet = new Set(split.validation);
    const trainTargets = buildTargets(sequences, trainSet);
    const valTargets = buildTargets(sequences, valSet);
    const covTrain = coverage(edges, trainTargets);
    const covVal = coverage(edges, valTargets);

    const K = vocab.nodeCount;
    const isolated = realManifest.isolatedNodeCount;
    const multi = realManifest.diagnostics ? realManifest.diagnostics.multiSkillGroups : null;
    const single = realManifest.diagnostics ? realManifest.diagnostics.singleSkillGroups : null;

    seedReports.push({
      seed,
      nodeCount: K,
      undirectedEdgeCount: realManifest.undirectedEdgeCount,
      edgeCountFromCsv: edges.length,
      density: realManifest.density,
      weightSum: realManifest.weightSum,
      isolatedNodeCount: isolated,
      isolatedNodeRatio: Number((isolated / K).toFixed(6)),
      componentSizesTop3: (realManifest.componentSizes || []).slice(0, 3),
      attemptGroups: realManifest.diagnostics ? realManifest.diagnostics.attemptGroups : null,
      multiSkillAttemptGroups: multi,
      multiSkillGroupRatio: multi !== null && single !== null
        ? Number((multi / (multi + single)).toFixed(6)) : null,
      trainTargetCoverage: covTrain,
      validationTargetCoverage: covVal,
      splitCounts: split.counts,
      hashes: {
        splitSha256: realManifest.splitSha256,
        graphEdgesSha256: realManifest.graphEdgesSha256,
        vocabularySha256: realManifest.vocabularySha256
      }
    });
  }

  const vals = seedReports.map((r) => r.validationTargetCoverage.coverage).filter((v) => v !== null);
  const meanVal = vals.reduce((a, b) => a + b, 0) / vals.length;
  const meanTrain = seedReports.reduce((a, r) => a + r.trainTargetCoverage.coverage, 0) / seedReports.length;
  const gate = {
    rule: `五种子 validation 目标落在非孤立节点的覆盖率均值 < ${THRESHOLD} 时停止正式 GCN 训练`,
    threshold: THRESHOLD,
    meanValidationCoverage: Number(meanVal.toFixed(6)),
    meanTrainCoverage: Number(meanTrain.toFixed(6)),
    perSeedValidationCoverage: vals.map((v) => Number(v.toFixed(6))),
    passes: meanVal >= THRESHOLD,
    verdict: meanVal >= THRESHOLD
      ? '通过可行性闸门：可进入五种子正式对照'
      : '未通过：2012 同口径图仍过稀疏，不能用本次实验检验模型增益（保留图统计，不得解释为再次证明无增益）'
  };

  const report = {
    protocolVersion: 'assist2012-gcn-dkt-v1',
    generatedAt: new Date().toISOString(),
    inputs: {
      interactions: path.relative(path.join(__dirname, '..'), interPath).split(path.sep).join('/'),
      interactionsSha256: sha256File(interPath),
      graphsRoot: args.graphsRoot,
      seeds: args.seeds
    },
    targetRule: '目标 = 指定学生集合中 (学生,知识点) 组非首条记录（与 graphDktExperiment.buildTargetManifest 同一规则）',
    coverageRule: '非孤立节点 = 真实图（无自环）中度 > 0 的节点；覆盖率 = 目标 kpCode 落在非孤立节点的比例',
    testLabelsUsed: false,
    seedReports,
    gate
  };

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(path.resolve(args.graphsRoot), 'precheck-coverage.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nseed  节点  边    孤立%   trainCov  valCov  多skill组%');
  for (const r of seedReports) {
    console.log([
      String(r.seed).padEnd(4),
      String(r.nodeCount).padEnd(5),
      String(r.undirectedEdgeCount).padEnd(5),
      (r.isolatedNodeRatio * 100).toFixed(1).padStart(6),
      (r.trainTargetCoverage.coverage * 100).toFixed(2).padStart(8),
      (r.validationTargetCoverage.coverage * 100).toFixed(2).padStart(7),
      r.multiSkillGroupRatio === null ? 'n/a' : (r.multiSkillGroupRatio * 100).toFixed(1).padStart(9)
    ].join(' '));
  }
  console.log(`\n五种子 validation 覆盖率均值 = ${(meanVal * 100).toFixed(2)}%（闸门 ${THRESHOLD * 100}%）`);
  console.log(`判定：${gate.verdict}`);
  console.log(`报告：${outPath}`);
  if (!gate.passes) process.exitCode = 3;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[precheck] ' + e.message); process.exit(1); }
}

module.exports = { buildTargets, coverage, THRESHOLD };
