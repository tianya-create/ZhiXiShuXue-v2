#!/usr/bin/env node
/**
 * buildPriorEdges.js —— 先修边合并、投票与规则校验（闸门实验 §2）
 *
 * 输入：prior-extraction/run{1,2,3}.csv（sourceName,targetName,confidence,reason，名称逐字）
 * 输出：datasets/assist2009/prior-edges.csv（sourceKp,targetKp,confidence,votes,reason）
 *       实验结果文件/prior-probe-v1/prior-edges-validation.json（校验记录 + 被规则否决的边，供人工核验 §2.4）
 *
 * 流程（全部自动，全部通过才允许进入探针）：
 *   1. 名称→kpCode 白名单映射（逐字匹配 skill-names；重名 KC 全部排除并在报告中记录）；
 *   2. 投票：≥2/3 次出现的边入选；confidence 取出现轮次的中位数（向上取整），votes 记录次数；
 *   3. 去重：同一 (source,target) 只保留一条；互逆对 (a,b)/(b,a) 同时出现时保留 (confidence,votes)
 *      更高的一条，另一条计入否决清单；
 *   4. DAG：拓扑排序检测，若有环按 (confidence,votes) 从低到高删边直到无环，被删边入否决清单；
 *   5. 度数上限：出度 ≤3、入度 ≤2，超限按 (confidence,votes) 从低到高裁剪，被裁边入否决清单；
 *   6. 边数区间 40–120：越界直接失败退出（不自动增删）；
 *   7. 覆盖率统计：有出边或入边的 KC 数、仍孤立 KC 数；
 *   8. 落盘 + sha256（final 的 sha256 由本脚本输出，供 probe-config.json 冻结）。
 *
 * 用法：
 *   cd backend
 *   node scripts/buildPriorEdges.js \
 *     --runs datasets/assist2009/prior-extraction \
 *     --skills datasets/assist2009/skill-names.json \
 *     --vocabulary 实验结果文件/gcn-dkt-v1/seed-42/vocabulary.json \
 *     --out datasets/assist2009/prior-edges.csv \
 *     --report 实验结果文件/prior-probe-v1/prior-edges-validation.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AMBIGUOUS_NAMES_EXCLUDED = ['Absolute Value']; // 重名 KC（s85/s163），协议 §2.1 修订：整对排除

// ---------- 纯函数（导出供测试） ----------

/** 解析一行 "source,target,confidence,reason"：source/target 可能含逗号，须由已知名称集切分 */
function parseEdgeLine(line, knownNames) {
  const m = line.match(/^(.+),(\d+),(.+)$/);
  if (!m) return null;
  const rest = m[1];
  const confidence = Number(m[2]);
  const reason = m[3].trim();
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  for (const src of sorted) {
    if (!rest.startsWith(src + ',')) continue;
    const target = rest.slice(src.length + 1);
    if (knownNames.has(target)) return { sourceName: src, targetName: target, confidence, reason };
  }
  return null;
}

/** 名称→kpCode 映射；重名直接排除 */
function buildNameMap(skillNames, kpList) {
  const kpByNumber = new Map(); // "N" -> kpCode（仅 kpList 内的）
  for (const kp of kpList) kpByNumber.set(kp.replace(/^a09-s/, ''), kp);
  const nameToKp = new Map();
  const ambiguous = new Set();
  const counts = new Map();
  for (const [num, name] of Object.entries(skillNames)) {
    if (!kpByNumber.has(num)) continue; // 清洗后无交互的 11 条
    if (AMBIGUOUS_NAMES_EXCLUDED.includes(name)) { ambiguous.add(name); continue; }
    counts.set(name, (counts.get(name) || 0) + 1);
    if (counts.get(name) > 1) { ambiguous.add(name); nameToKp.delete(name); continue; }
    nameToKp.set(name, kpByNumber.get(num));
  }
  return { nameToKp, ambiguous, usableNames: new Set(nameToKp.keys()) };
}

/** 投票合并：≥minVotes 的边入选 */
function voteEdges(runEdges, minVotes) {
  const tally = new Map();
  for (const run of runEdges) {
    const seen = new Set();
    for (const e of run) {
      const key = `${e.sourceName}\u0000${e.targetName}`;
      if (seen.has(key)) continue; // 同轮去重
      seen.add(key);
      if (!tally.has(key)) tally.set(key, []);
      tally.get(key).push(e);
    }
  }
  const kept = [];
  for (const [key, occurrences] of tally) {
    if (occurrences.length < minVotes) continue;
    const confs = occurrences.map((o) => o.confidence).sort((a, b) => a - b);
    const median = confs.length % 2 === 1
      ? confs[(confs.length - 1) / 2]
      : Math.ceil((confs[confs.length / 2 - 1] + confs[confs.length / 2]) / 2);
    const [sourceName, targetName] = key.split('\u0000');
    kept.push({
      sourceName,
      targetName,
      confidence: median,
      votes: occurrences.length,
      reason: occurrences[0].reason,
    });
  }
  return kept;
}

/** 拓扑排序；有环返回参与环的边集合（全部边中位于环上的） */
function findCycleEdges(edges) {
  const nodes = new Set();
  for (const e of edges) { nodes.add(e.sourceKp); nodes.add(e.targetKp); }
  const adj = new Map();
  const indeg = new Map();
  for (const n of nodes) { adj.set(n, []); indeg.set(n, 0); }
  for (const e of edges) { adj.get(e.sourceKp).push(e.targetKp); indeg.set(e.targetKp, indeg.get(e.targetKp) + 1); }
  const q = [...nodes].filter((n) => indeg.get(n) === 0).sort();
  const seen = new Set();
  while (q.length) {
    const n = q.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) q.push(m);
    }
  }
  const onCycle = new Set([...nodes].filter((n) => !seen.has(n)));
  return edges.filter((e) => onCycle.has(e.sourceKp) && onCycle.has(e.targetKp));
}

const rankOf = (e) => [e.confidence, e.votes];

function compareRank(a, b) {
  const ra = rankOf(a);
  const rb = rankOf(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || a.sourceKp.localeCompare(b.sourceKp) || a.targetKp.localeCompare(b.targetKp);
}

/** 规则校验主流程：互逆去重 → 破环 → 度数裁剪；返回 {kept, rejected, ok, edgeCount, coverage} */
function validateEdges(kpEdges) {
  const rejected = [];
  // 1) 互逆对去重
  const byPair = new Map();
  for (const e of kpEdges) byPair.set(`${e.sourceKp}\u0000${e.targetKp}`, e);
  const mutualDropped = new Set();
  for (const e of kpEdges) {
    const revKey = `${e.targetKp}\u0000${e.sourceKp}`;
    const fwdKey = `${e.sourceKp}\u0000${e.targetKp}`;
    if (!byPair.has(revKey) || mutualDropped.has(fwdKey)) continue;
    const rev = byPair.get(revKey);
    if (compareRank(e, rev) > 0) { mutualDropped.add(revKey); rejected.push({ ...rev, rejectedBy: 'mutual-pair' }); }
    else { mutualDropped.add(fwdKey); rejected.push({ ...e, rejectedBy: 'mutual-pair' }); }
  }
  let kept = kpEdges.filter((e) => !mutualDropped.has(`${e.sourceKp}\u0000${e.targetKp}`));

  // 2) 破环
  for (let guard = 0; guard < 200; guard += 1) {
    const cyc = findCycleEdges(kept);
    if (cyc.length === 0) break;
    const sorted = [...cyc].sort(compareRank);
    const drop = sorted[0];
    kept = kept.filter((e) => !(e.sourceKp === drop.sourceKp && e.targetKp === drop.targetKp));
    rejected.push({ ...drop, rejectedBy: 'cycle' });
  }

  // 3) 度数上限（out≤3, in≤2），每轮裁剪一条最低秩边直到全部合规
  for (let guard = 0; guard < 500; guard += 1) {
    const outDeg = new Map();
    const inDeg = new Map();
    for (const e of kept) {
      outDeg.set(e.sourceKp, (outDeg.get(e.sourceKp) || 0) + 1);
      inDeg.set(e.targetKp, (inDeg.get(e.targetKp) || 0) + 1);
    }
    let worst = null;
    for (const e of kept) {
      const over = (outDeg.get(e.sourceKp) > 3) || (inDeg.get(e.targetKp) > 2);
      if (!over) continue;
      if (!worst || compareRank(e, worst) < 0) worst = e;
    }
    if (!worst) break;
    kept = kept.filter((e) => !(e.sourceKp === worst.sourceKp && e.targetKp === worst.targetKp));
    rejected.push({ ...worst, rejectedBy: 'degree-cap' });
  }

  const nodesTouched = new Set();
  for (const e of kept) { nodesTouched.add(e.sourceKp); nodesTouched.add(e.targetKp); }
  return {
    kept,
    rejected,
    edgeCount: kept.length,
    kcsWithEdges: nodesTouched.size,
    isolatedKcs: 100 - nodesTouched.size,
  };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) args[argv[i].slice(2)] = argv[i + 1];
  for (const k of ['runs', 'skills', 'vocabulary', 'out', 'report']) {
    if (!args[k]) throw new Error(`缺少 --${k}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const skillNames = JSON.parse(fs.readFileSync(args.skills, 'utf8'));
  const vocab = JSON.parse(fs.readFileSync(args.vocabulary, 'utf8'));
  const kpList = vocab.kpList;
  const { nameToKp, ambiguous, usableNames } = buildNameMap(skillNames, kpList);

  const runFiles = fs.readdirSync(args.runs).filter((f) => /^run\d+\.csv$/.test(f)).sort();
  const runEdges = runFiles.map((f) => {
    const lines = fs.readFileSync(path.join(args.runs, f), 'utf8').trim().split(/\r?\n/).slice(1);
    const edges = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      const e = parseEdgeLine(l, usableNames);
      if (!e) throw new Error(`${f} 存在无法白名单映射的行: ${l}`);
      edges.push(e);
    }
    return edges;
  });
  console.log(`runs: ${runFiles.join(', ')}，各 ${runEdges.map((r) => r.length).join(' / ')} 条`);

  const voted = voteEdges(runEdges, 2);
  const kpEdges = voted.map((e) => ({
    sourceKp: nameToKp.get(e.sourceName),
    targetKp: nameToKp.get(e.targetName),
    sourceName: e.sourceName,
    targetName: e.targetName,
    confidence: e.confidence,
    votes: e.votes,
    reason: e.reason,
  }));
  console.log(`投票后候选边: ${kpEdges.length}`);

  const result = validateEdges(kpEdges);
  const edgeCount = result.edgeCount;
  if (edgeCount < 40 || edgeCount > 120) {
    throw new Error(`边数 ${edgeCount} 不在 40–120 区间，按协议终止（不自动增删）`);
  }

  const outLines = ['sourceKp,targetKp,confidence,votes,reason'];
  const final = [...result.kept].sort((a, b) => a.sourceKp.localeCompare(b.sourceKp) || a.targetKp.localeCompare(b.targetKp));
  for (const e of final) outLines.push(`${e.sourceKp},${e.targetKp},${e.confidence},${e.votes},"${e.reason}"`);
  fs.writeFileSync(args.out, `${outLines.join('\n')}\n`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(args.out)).digest('hex');

  const report = {
    protocolVersion: 'assist2009-prior-edges-v1',
    generatedAt: new Date().toISOString(),
    runs: runFiles,
    votesRule: '>=2/3',
    ambiguousNamesExcluded: [...ambiguous],
    usableNameCount: usableNames.size,
    votedCandidates: kpEdges.length,
    edgeCount,
    kcsWithEdges: result.kcsWithEdges,
    isolatedKcs: result.isolatedKcs,
    rejectedByRules: result.rejected,
    finalFile: args.out,
    sha256: `sha256:${sha256}`,
    note: 'final 定稿后必须先 git commit 再跑探针；本报告与 sha256 是防"看到结果再改图"的留痕。',
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`final: ${edgeCount} 边 → ${args.out}`);
  console.log(`sha256: ${sha256}`);
  console.log(`覆盖: ${result.kcsWithEdges}/100 KC 有边（孤立 ${result.isolatedKcs}）；规则否决 ${result.rejected.length} 条`);
}

if (require.main === module) main();

module.exports = { parseEdgeLine, buildNameMap, voteEdges, validateEdges, findCycleEdges, compareRank, AMBIGUOUS_NAMES_EXCLUDED };
