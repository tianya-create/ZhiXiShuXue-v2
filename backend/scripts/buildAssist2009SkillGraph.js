#!/usr/bin/env node
/**
 * buildAssist2009SkillGraph.js —— ASSISTments 2009 知识点共现图构建（阶段 A）
 *
 * 协议：assist2009-gcn-dkt-v1（图数据构建部分）
 * 方案：《ASSISTments2009_图增强DKT五组对照实验方案.md》§3/§4/§9
 *
 * 核心规则（冻结，不得按结果调整）：
 *   - 先划分，再构图：只用本种子 train 学生原始行（graphStudentsOutsideTrain 必须 = 0）
 *   - 题目范围：仅保留出现在预测任务 train 学生 questionId 集合中的 problem_id
 *   - 分组键 (user_id, order_id, problem_id)，组内不同 KP 两两成无序候选边，
 *     同组同 KP 只保留一次；不过滤 correct/用时（usesResponseValues=false）
 *   - 边权 w(i,j) = 支持该边的不同 problem_id 数（同题重复作答不重复加权）；
 *     minSupport = 1；不加 top-K、不做阈值搜索
 *   - A 对角为 0、无自环；送入 GCN 时才加一次单位自环并做对称归一化
 *   - RandomGraph：同节点、同边数、同边权多重集，节点对均匀无放回抽取；
 *     graphSeed 由固定哈希派生，与训练随机流独立；至多 100 次重试避开与真实图同拓扑
 *
 * 输出（--out 目录下 seed-<N>/）：split.json、vocabulary.json、graph-nodes.json、
 * graph-real-edges.csv、graph-edge-evidence.jsonl、graph-random-edges.csv、
 * graph-real-manifest.json、graph-random-manifest.json、graph-selfloop-manifest.json
 *
 * 纯函数（buildEdgeTable / adjacencyFromEdges / symmetricNormalize / randomizeEdges /
 * connectedComponents / graphSummary）导出供测试使用；CLI 负责哈希校验与落盘。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ---------- 冻结常量（与 datasets/assist2009/manifest.json 一致；启动时还会校验） ----------
const GRAPH_PROTOCOL_VERSION = 'assist2009-gcn-dkt-v1';
const RAW_COLUMNS_NEEDED = ['order_id', 'user_id', 'problem_id', 'skill_id'];

// ---------- 通用工具 ----------
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function sha256File(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}
function canonicalHashOfIds(sortedIds) {
  // 学生集合规范哈希：JSON.stringify(有序数组)
  return 'sha256:' + sha256Hex(Buffer.from(JSON.stringify(sortedIds)));
}
// 独立随机流（与训练随机流无关）：fnv1a 派生 32 位种子 + mulberry32
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function deriveGraphSeed(splitSeed, purpose) {
  // 派生规则：fnv1a("<protocol>|<purpose>|<splitSeed>") → 32 位无符号整数
  const rule = 'fnv1a("<graphProtocolVersion>|<purpose>|<splitSeed>") as uint32, PRNG=mulberry32';
  const seed = fnv1a(`${GRAPH_PROTOCOL_VERSION}|${purpose}|${splitSeed}`);
  return { seed, rule, prng: 'mulberry32' };
}

/** 最小 CSV 行解析：支持双引号包裹与 "" 转义（不含跨行字段） */
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur); cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// ---------- 纯函数：构图核心 ----------

/**
 * 从「一次作答组」构造无向边表。
 * @param attemptGroups [{problemId, skillIds:[kpCode,...]}]（同组同 KP 已去重由本函数兜底）
 * @param kpIndex Map<kpCode, index>（冻结词表；不在词表的 KP 由调用方先过滤）
 * @returns {edges:Map<"i|j",{i,j,support,problemIds:Set}>, stats:{...}}
 */
function buildEdgeTable(attemptGroups, kpIndex) {
  const edges = new Map(); // key "minI|maxI"（kpIndex 下标）
  const stats = {
    attemptGroups: attemptGroups.length,
    singleSkillGroups: 0,
    multiSkillGroups: 0,
    distinctKpPairs: 0,
    groupsWithUnknownKp: 0,
    duplicateKpInGroup: 0
  };
  for (const g of attemptGroups) {
    const unknown = g.skillIds.filter((k) => !kpIndex.has(k)).length;
    stats.groupsWithUnknownKp += unknown;
    const idxs = [...new Set(g.skillIds.map((k) => kpIndex.get(k)).filter((v) => v !== undefined))];
    stats.duplicateKpInGroup += g.skillIds.length - new Set(g.skillIds).size;
    if (idxs.length < 2) { stats.singleSkillGroups++; continue; }
    stats.multiSkillGroups++;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = Math.min(idxs[a], idxs[b]);
        const j = Math.max(idxs[a], idxs[b]);
        const key = `${i}|${j}`;
        if (!edges.has(key)) edges.set(key, { i, j, support: 0, problemIds: new Set() });
        const e = edges.get(key);
        e.problemIds.add(g.problemId);
      }
    }
  }
  for (const e of edges.values()) e.support = e.problemIds.size;
  stats.distinctKpPairs = edges.size;
  return { edges, stats };
}

/** 无自环对称邻接矩阵（行主序 Float64Array，对角 = 0） */
function adjacencyFromEdges(edgeList, K) {
  const A = new Float64Array(K * K);
  for (const e of edgeList) {
    if (e.i === e.j) throw new Error(`邻接矩阵不允许自环：${e.i}`);
    if (e.i < 0 || e.j < 0 || e.i >= K || e.j >= K) throw new Error(`边越界：${e.i},${e.j}`);
    A[e.i * K + e.j] = e.w;
    A[e.j * K + e.i] = e.w;
  }
  return A;
}

/** 对称归一化：Atilde = A + I；Anorm = D^(-1/2) Atilde D^(-1/2)（行和不必为 1） */
function symmetricNormalize(A, K) {
  const Atilde = new Float64Array(K * K);
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) Atilde[i * K + j] = A[i * K + j];
    Atilde[i * K + i] += 1;
  }
  const D = new Float64Array(K);
  for (let i = 0; i < K; i++) {
    let s = 0;
    for (let j = 0; j < K; j++) s += Atilde[i * K + j];
    D[i] = s;
    if (!(s > 0) || !Number.isFinite(s)) throw new Error(`节点 ${i} 归一化度非正/非有限：${s}`);
  }
  const Anorm = new Float64Array(K * K);
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      Anorm[i * K + j] = Atilde[i * K + j] / Math.sqrt(D[i] * D[j]);
      if (!Number.isFinite(Anorm[i * K + j])) throw new Error(`Anorm[${i},${j}] 非有限`);
    }
  }
  return { Atilde, Anorm, degree: D };
}

/** 无向边数组的随机化：同节点数、同边数、同边权多重集；均匀无放回抽节点对 */
function randomizeEdges(realEdgeList, K, rng) {
  const M = realEdgeList.length;
  const totalPairs = (K * (K - 1)) / 2;
  if (M > totalPairs) throw new Error(`边数 ${M} 超过无向对总数 ${totalPairs}（完全图）`);
  // 部分 Fisher–Yates：从全部无序对中无放回抽 M 个
  const pairIndex = new Int32Array(totalPairs);
  let p = 0;
  for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) pairIndex[p++] = i * K + j;
  const picked = [];
  for (let m = 0; m < M; m++) {
    const t = m + Math.floor(rng() * (totalPairs - m));
    const tmp = pairIndex[m]; pairIndex[m] = pairIndex[t]; pairIndex[t] = tmp;
    const code = pairIndex[m];
    picked.push({ i: Math.floor(code / K), j: code % K });
  }
  // 权多重集置换
  const weights = realEdgeList.map((e) => e.w);
  for (let m = weights.length - 1; m > 0; m--) {
    const t = Math.floor(rng() * (m + 1));
    [weights[m], weights[t]] = [weights[t], weights[m]];
  }
  const out = picked
    .map((pr, idx) => ({ i: Math.min(pr.i, pr.j), j: Math.max(pr.i, pr.j), w: weights[idx] }))
    .sort((a, b) => (a.i - b.i) || (a.j - b.j));
  return out;
}

/** 边集合是否相同（同拓扑判定：无向边集合一致，不管权） */
function sameTopology(listA, listB) {
  if (listA.length !== listB.length) return false;
  const keyOf = (e) => `${e.i}|${e.j}`;
  const setB = new Set(listB.map(keyOf));
  return listA.every((e) => setB.has(keyOf(e)));
}

/** 连通分量（忽略权，忽略自环；孤立节点自成单分量） */
function connectedComponents(A, K) {
  const parent = new Int32Array(K);
  for (let i = 0; i < K; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      if (A[i * K + j] > 0) {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const sizes = new Map();
  for (let i = 0; i < K; i++) {
    const r = find(i);
    sizes.set(r, (sizes.get(r) || 0) + 1);
  }
  return [...sizes.values()].sort((a, b) => b - a);
}

/** 图摘要：密度、孤立节点、度统计 */
function graphSummary(edgeList, K) {
  const deg = new Int32Array(K);
  let weightSum = 0;
  for (const e of edgeList) { deg[e.i]++; deg[e.j]++; weightSum += e.w; }
  const degs = [...deg].sort((a, b) => a - b);
  const isolated = degs.filter((d) => d === 0).length;
  const wDeg = new Float64Array(K);
  for (const e of edgeList) { wDeg[e.i] += e.w; wDeg[e.j] += e.w; }
  const sortedWDeg = [...wDeg].sort((a, b) => a - b);
  const median = (arr) => arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
  return {
    undirectedEdgeCount: edgeList.length,
    weightSum,
    density: edgeList.length / ((K * (K - 1)) / 2),
    isolatedNodeCount: isolated,
    degreeSummary: {
      min: degs[0], median: median(degs), max: degs[degs.length - 1],
      mean: Number((degs.reduce((s, d) => s + d, 0) / K).toFixed(4)),
      weightedMin: sortedWDeg[0], weightedMedian: median(sortedWDeg), weightedMax: sortedWDeg[sortedWDeg.length - 1]
    }
  };
}

/** SelfLoop 图：无真实边，Anorm = I */
function selfloopAdjacency(K) {
  const I = new Float64Array(K * K);
  for (let i = 0; i < K; i++) I[i * K + i] = 1;
  return I;
}

/**
 * 非孤立节点目标覆盖率（事后描述统计，方案 §9.2 允许）。
 * 非孤立节点 = 无自环邻接矩阵 A 中度 > 0 的节点（有非自环邻接边）；
 * 目标 = 五组对照目标清单（与 Full-DKT / 消融同一目标规则与目标集）。
 * 注意：孤立节点仍有逐节点编码器（自环 + 逐节点参数），不能断言其预测不受图分支影响。
 */
function nonIsolatedTargetCoverage(edgeList, kpIndex, targets, targetManifestHash, targetsFileSha256) {
  const K = kpIndex.size;
  const deg = new Int32Array(K);
  for (const e of edgeList) { deg[e.i]++; deg[e.j]++; }
  const nonIsolated = new Set();
  for (let i = 0; i < K; i++) if (deg[i] > 0) nonIsolated.add(i);
  let numerator = 0;
  let kpNotInVocab = 0;
  for (const t of targets) {
    const idx = kpIndex.get(t.kpCode);
    if (idx === undefined) { kpNotInVocab++; continue; }
    if (nonIsolated.has(idx)) numerator++;
  }
  return {
    rule: '非孤立节点 = 无自环邻接矩阵 A 中度>0（有非自环邻接边）的节点；目标 = 五组对照目标清单（与 Full-DKT/消融同一目标规则）；分子 = kpCode 位于非孤立节点的目标数',
    isolatedNodeNote: '孤立节点仍有逐节点编码器（自环+逐节点参数），覆盖率低不等于这些目标的预测与图分支无关',
    targetCount: targets.length,
    numerator,
    denominator: targets.length,
    ratio: Number((numerator / targets.length).toFixed(6)),
    nonIsolatedNodeCount: nonIsolated.size,
    nodeCount: K,
    targetKpNotInVocab: kpNotInVocab,
    targetManifestHash: targetManifestHash || null,
    targetsFileSha256
  };
}

// ---------- 边 CSV / 证据 JSONL 序列化 ----------

function edgesToCsv(edgeList, kpList) {
  const lines = ['sourceIndex,targetIndex,sourceKp,targetKp,support'];
  for (const e of edgeList) {
    lines.push(`${e.i},${e.j},${kpList[e.i]},${kpList[e.j]},${e.w}`);
  }
  return lines.join('\n') + '\n';
}
function evidenceToJsonl(edgeList) {
  // 每条无向边一条：支持题目 ID 排序去重，可从证据重建边权
  const sorted = [...edgeList].sort((a, b) => (a.i - b.i) || (a.j - b.j));
  return sorted.map((e) => JSON.stringify({
    sourceKp: e.sourceKp, targetKp: e.targetKp,
    problemIds: [...e.problemIds].sort(),
    support: e.support
  })).join('\n') + '\n';
}

/** 加载 dkt.js：兼容仓库 backend/scripts（../models）与材料包 scripts/（../model）两种布局 */
function loadDkt() {
  const candidates = [
    path.join(__dirname, '..', 'models', 'dkt.js'),
    path.join(__dirname, '..', 'model', 'dkt.js')
  ];
  for (const p of candidates) {
    try { return require(p); } catch (e) { /* 尝试下一个 */ }
  }
  throw new Error('找不到 dkt.js（尝试过：' + candidates.join(' ; ') + '）');
}

// ---------- CLI 主流程 ----------

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const required = ['raw', 'interactions', 'manifest', 'seed', 'out', 'targets'];
  const args = {};
  for (const k of required) args[k] = get(k, null);
  for (const k of required) {
    if (args[k] === null) throw new Error(`缺少必填参数 --${k}`);
  }
  args.seed = Number(args.seed);
  if (!Number.isInteger(args.seed)) throw new Error(`--seed 必须是整数：${args.seed}`);
  return args;
}

async function readRawAttempts(rawPath, manifest, kpIndex, trainStudentSet, trainQuestionSet) {
  // 读取原始行并按 §4.1 过滤/分组；返回 { attempts, diagnostics }
  const diag = {
    rawRows: 0, headerRows: 0, missingIdRows: 0,
    userMapFailRows: 0, userOutsideTrainRows: 0,
    problemOutsideTrainTaskRows: 0,
    skillMapFailRows: 0, skillNotInVocabRows: 0,
    emptyOrderIdRows: 0,
    duplicateRowsCollapsed: 0,
    multiProblemPerUserOrder: 0
  };
  const groupKey = new Map(); // "user|order|problem" → { problemId, skillIds:[] , skillSet:Set }
  const userOrderProblems = new Map(); // "user|order" → Set(problemId)
  const graphUsers = new Set(); // 实际纳入构图的学生（原始行通过全部过滤并进入作答分组）

  const stream = fs.createReadStream(rawPath, { encoding: 'latin1' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let col = null;
  const seenRawKeys = new Set(); // (user, order, skill) 检测重复写入行

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    diag.rawRows++;
    if (!header) {
      header = parseCsvLine(line).map((s) => s.trim());
      col = {};
      for (const c of RAW_COLUMNS_NEEDED) {
        const idx = header.indexOf(c);
        if (idx < 0) throw new Error(`原始文件缺少必需列：${c}`);
        col[c] = idx;
      }
      continue;
    }
    const cells = parseCsvLine(line);
    const orderId = cells[col.order_id].trim();
    const userId = cells[col.user_id].trim();
    const problemId = cells[col.problem_id].trim();
    const skillId = cells[col.skill_id].trim();
    if (!orderId || !userId || !problemId || !skillId) { diag.missingIdRows++; continue; }
    if (!orderId || orderId === '') { diag.emptyOrderIdRows++; continue; }

    const mappedUser = `a09-u${userId}`;
    const mappedProblem = `a09-p${problemId}`;
    const mappedSkill = `a09-s${skillId}`;
    if (!/^a09-u/.test(mappedUser)) { diag.userMapFailRows++; continue; }
    if (!trainStudentSet.has(mappedUser)) { diag.userOutsideTrainRows++; continue; }
    if (!trainQuestionSet.has(mappedProblem)) { diag.problemOutsideTrainTaskRows++; continue; }
    if (!kpIndex.has(mappedSkill)) { diag.skillNotInVocabRows++; continue; }

    // 重复写入检测：(user, order, skill) 重复行在分组去重时自然折叠
    const rawKey = `${mappedUser}|${orderId}|${mappedSkill}`;
    if (seenRawKeys.has(rawKey)) diag.duplicateRowsCollapsed++;
    else seenRawKeys.add(rawKey);

    const uoKey = `${mappedUser}|${orderId}`;
    if (!userOrderProblems.has(uoKey)) userOrderProblems.set(uoKey, new Set());
    const probs = userOrderProblems.get(uoKey);
    probs.add(mappedProblem);
    if (probs.size > 1) diag.multiProblemPerUserOrder = [...userOrderProblems.values()].filter((s) => s.size > 1).length;

    const gKey = `${mappedUser}|${orderId}|${mappedProblem}`;
    if (!groupKey.has(gKey)) groupKey.set(gKey, { problemId: mappedProblem, skillIds: [] });
    groupKey.get(gKey).skillIds.push(mappedSkill);
    graphUsers.add(mappedUser);
  }
  const attempts = [...groupKey.values()];
  return { attempts, diag, graphStudentIds: [...graphUsers].sort() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outRoot = path.resolve(args.out);
  const seedDir = path.join(outRoot, `seed-${args.seed}`);
  fs.mkdirSync(seedDir, { recursive: true });

  // ---------- 1. 数据版本校验（G01） ----------
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8'));
  const expectRaw = manifest.source.rawSha256.replace(/^sha256:/, '');
  const expectTask = manifest.output.sha256.replace(/^sha256:/, '');
  const rawPath = path.resolve(args.raw);
  const taskPath = path.resolve(args.interactions);
  const actualRaw = sha256File(rawPath);
  const actualTask = sha256File(taskPath);
  if (actualRaw !== expectRaw) throw new Error(`原始文件哈希不一致：actual=${actualRaw} expect=${expectRaw}。停止，不自动换版本。`);
  if (actualTask !== expectTask) throw new Error(`预测文件哈希不一致：actual=${actualTask} expect=${expectTask}。停止。`);
  console.log(`数据哈希校验通过：raw ${actualRaw.slice(0, 16)}… task ${actualTask.slice(0, 16)}…`);

  // ---------- 2. 预测任务 → 学生划分 / 词表 / train 题目集合（与 Full-DKT 完全一致） ----------
  const dkt = loadDkt();
  const interactionsCsv = fs.readFileSync(taskPath, 'utf8').trim().split('\n');
  const taskHeader = interactionsCsv[0].split(',');
  const ti = Object.fromEntries(taskHeader.map((h, i) => [h, i]));
  const records = [];
  for (let r = 1; r < interactionsCsv.length; r++) {
    const c = interactionsCsv[r].split(',');
    records.push({
      userId: c[ti.userId], questionId: c[ti.questionId], kpCode: c[ti.kpCode],
      isCorrect: Number(c[ti.isCorrect]), createdAt: c[ti.createdAt]
    });
  }
  const sequences = dkt.buildStudentSequences(records);
  const userIds = sequences.map((s) => s.userId);
  const split = dkt.splitStudents(userIds, { train: 0.7, validation: 0.15, seed: args.seed });
  const trainSet = new Set(split.train);
  // 词表 = 完整任务固定词表（与 dktEval 的 buildVocab(sequences) 完全一致，K 固定），
  // 不是 buildVocab(trainSeqs)。词表固定 ≠ 用测试数据构边：边仍只来自 train 学生原始行；
  // 训练中未出现的 KP 保留为孤立节点、不删除。
  const vocab = dkt.buildVocab(sequences, { inputMode: 'full' });
  const { kpList, kpIndex } = vocab;
  const K = kpList.length;
  // train 学生实际出现的题目集合（§3.2）
  const trainQuestionSet = new Set();
  for (const rec of records) if (trainSet.has(rec.userId)) trainQuestionSet.add(rec.questionId);
  console.log(`seed=${args.seed}：学生 ${userIds.length}（train ${split.train.length}），节点 K=${K}，train 题目 ${trainQuestionSet.size}`);

  // ---------- 3. 目标清单（覆盖率计算口径） ----------
  const targetsPath = path.resolve(args.targets);
  const targetsJson = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
  if (!Array.isArray(targetsJson.targets) || targetsJson.targets.length !== targetsJson.targetCount) {
    throw new Error(`目标清单不合法：targets.length=${Array.isArray(targetsJson.targets) ? targetsJson.targets.length : 'n/a'}，targetCount=${targetsJson.targetCount}`);
  }
  for (const t of targetsJson.targets) {
    if (!t.kpCode) throw new Error('目标清单存在缺少 kpCode 的条目');
  }
  const targetsFileSha = 'sha256:' + sha256File(targetsPath);

  // ---------- 4. 原始行 → 作答组 ----------
  const { attempts, diag, graphStudentIds } = await readRawAttempts(rawPath, manifest, kpIndex, trainSet, trainQuestionSet);
  // 实际纳入构图的学生集合：必须 ⊆ train（不依赖过滤逻辑正确性的硬断言）
  const outsideStudents = graphStudentIds.filter((id) => !trainSet.has(id));
  if (outsideStudents.length > 0) {
    throw new Error(`纳入构图的学生越出 train 集合（${outsideStudents.length} 个）：${outsideStudents.slice(0, 5).join(', ')}…。停止。`);
  }
  const graphStudentsHash = canonicalHashOfIds(graphStudentIds);
  console.log(`作答组：${attempts.length}；诊断：` +
    `缺ID ${diag.missingIdRows}，非train ${diag.userOutsideTrainRows}，题目越界 ${diag.problemOutsideTrainTaskRows}，` +
    `KP不在词表 ${diag.skillNotInVocabRows}，重复写入折叠 ${diag.duplicateRowsCollapsed}`);

  // ---------- 5. 真实图 ----------
  const { edges: edgeMap, stats } = buildEdgeTable(attempts, kpIndex);
  const realEdgeList = [...edgeMap.values()]
    .map((e) => ({ i: e.i, j: e.j, w: e.support, sourceKp: kpList[e.i], targetKp: kpList[e.j], problemIds: e.problemIds, support: e.support }))
    .sort((a, b) => (a.i - b.i) || (a.j - b.j));
  if (realEdgeList.length === 0) throw new Error('真实图为空图：无任何共现边。停止（§4.5 门槛）。');
  if (realEdgeList.length >= (K * (K - 1)) / 2) throw new Error('真实图是完全图：关系对照无法区分。停止（§4.5 门槛）。');
  const A = adjacencyFromEdges(realEdgeList, K);
  const { Anorm } = symmetricNormalize(A, K);

  // ---------- 6. RandomGraph（独立 graphSeed；至多 100 次重试避开同拓扑） ----------
  const derived = deriveGraphSeed(args.seed, 'random-graph');
  let graphSeed = derived.seed;
  let randomEdgeList = null;
  for (let attemptNo = 0; attemptNo < 100; attemptNo++) {
    const rng = mulberry32((graphSeed + attemptNo) >>> 0);
    const candidate = randomizeEdges(realEdgeList, K, rng);
    if (!sameTopology(candidate, realEdgeList)) {
      randomEdgeList = candidate;
      graphSeed = (graphSeed + attemptNo) >>> 0;
      break;
    }
    if (attemptNo === 99) throw new Error('随机图 100 次重试均与真实图同拓扑。停止随机图对照。');
  }
  const Ar = adjacencyFromEdges(randomEdgeList, K);
  const { Anorm: AnormR } = symmetricNormalize(Ar, K);

  // SelfLoop：Anorm = I
  const AnormS = selfloopAdjacency(K);

  // ---------- 7. 落盘 ----------
  const write = (name, content) => fs.writeFileSync(path.join(seedDir, name), content);

  const splitOut = {
    protocolVersion: GRAPH_PROTOCOL_VERSION,
    splitSeed: args.seed,
    fractions: split.fractions,
    train: split.train, validation: split.validation, test: split.test,
    counts: { train: split.train.length, validation: split.validation.length, test: split.test.length },
    trainStudentsHash: canonicalHashOfIds(split.train),
    validationStudentsHash: canonicalHashOfIds(split.validation),
    testStudentsHash: canonicalHashOfIds(split.test),
    algorithm: 'dkt.js splitStudents (mulberry32 Fisher-Yates on sorted ids)'
  };
  write('split.json', JSON.stringify(splitOut, null, 2));

  const vocabOut = {
    protocolVersion: GRAPH_PROTOCOL_VERSION,
    splitSeed: args.seed,
    nodeCount: K,
    kpList,
    vocabRule: '完整任务固定词表：dkt.buildVocab(全任务学生序列)（与 dktEval 逐位一致，kpCode 升序）；不随种子/划分变化',
    note: '词表固定 ≠ 用测试数据构边：边仅来自 train 学生原始行；train 中未出现的 KP 保留为孤立节点，不删除；不声称对未见知识点的归纳泛化',
    filteredSkillNote: `原始数据中不在词表内的技能行被过滤（计数见 graph-real-manifest.diagnostics.skillNotInVocabRows），不扩展输出头`
  };
  write('vocabulary.json', JSON.stringify(vocabOut, null, 2));
  write('graph-nodes.json', JSON.stringify({
    protocolVersion: GRAPH_PROTOCOL_VERSION, splitSeed: args.seed,
    nodes: kpList.map((kp, index) => ({ index, kpCode: kp }))
  }, null, 2));

  const realCsv = edgesToCsv(realEdgeList, kpList);
  const randCsv = edgesToCsv(randomEdgeList, kpList);
  const evidence = evidenceToJsonl(realEdgeList);
  write('graph-real-edges.csv', realCsv);
  write('graph-random-edges.csv', randCsv);
  write('graph-edge-evidence.jsonl', evidence);

  const vocabSha = 'sha256:' + sha256Hex(Buffer.from(JSON.stringify(vocabOut)));
  const splitSha = 'sha256:' + sha256Hex(Buffer.from(JSON.stringify(splitOut)));
  const builderSha = 'sha256:' + sha256Hex(fs.readFileSync(__filename));
  const realCoverage = nonIsolatedTargetCoverage(realEdgeList, kpIndex, targetsJson.targets, targetsJson.targetManifestHash, targetsFileSha);
  const randCoverage = nonIsolatedTargetCoverage(randomEdgeList, kpIndex, targetsJson.targets, targetsJson.targetManifestHash, targetsFileSha);
  const selfCoverage = nonIsolatedTargetCoverage([], kpIndex, targetsJson.targets, targetsJson.targetManifestHash, targetsFileSha);

  const commonManifest = {
    graphProtocolVersion: GRAPH_PROTOCOL_VERSION,
    splitSeed: args.seed,
    rawSha256: 'sha256:' + actualRaw,
    taskDataSha256: 'sha256:' + actualTask,
    vocabularySha256: vocabSha,
    splitSha256: splitSha,
    trainStudentsHash: splitOut.trainStudentsHash,
    graphStudentIdsHash: graphStudentsHash, // 实际纳入构图的学生集合（⊆ train，main 中已硬断言）
    graphStudentCount: graphStudentIds.length,
    graphStudentRule: '实际纳入构图的学生 = 原始行通过全部过滤并进入 (user,order,problem) 作答分组的学生；main 中断言其 ⊆ train，否则报错停止',
    graphStudentsOutsideTrain: outsideStudents.length,
    nodeCount: K,
    supportRule: 'distinct-problem-support（在至少一个训练作答组中同时标注的 different problem 数）',
    minSupport: 1,
    usesResponseValues: false,
    diagonalPolicy: 'A 对角为 0 无自环；仅在 GCN 输入时加一次单位自环（selfLoopWeight=1）',
    normalization: 'symmetric-with-unit-self-loop: Anorm = D^(-1/2)(A+I)D^(-1/2)',
    builderImplementationSha256: builderSha,
    generatedAt: new Date().toISOString()
  };

  const realSummary = graphSummary(realEdgeList, K);
  const realComponents = connectedComponents(A, K);
  write('graph-real-manifest.json', JSON.stringify({
    ...commonManifest,
    graphType: 'real-train-attempt-multiskill-coannotation',
    graphSeed: null,
    ...realSummary,
    componentSizes: realComponents,
    graphEdgesSha256: 'sha256:' + sha256Hex(Buffer.from(realCsv)),
    evidenceSha256: 'sha256:' + sha256Hex(Buffer.from(evidence)),
    adjacencySha256: 'sha256:' + sha256Hex(Buffer.from(Anorm.buffer)),
    nonIsolatedTargetCoverage: realCoverage,
    diagnostics: {
      rawRows: diag.rawRows, missingIdRows: diag.missingIdRows,
      userOutsideTrainRows: diag.userOutsideTrainRows,
      problemOutsideTrainTaskRows: diag.problemOutsideTrainTaskRows,
      skillNotInVocabRows: diag.skillNotInVocabRows,
      duplicateRowsCollapsed: diag.duplicateRowsCollapsed,
      multiProblemPerUserOrder: diag.multiProblemPerUserOrder,
      attemptGroups: stats.attemptGroups,
      singleSkillGroups: stats.singleSkillGroups,
      multiSkillGroups: stats.multiSkillGroups,
      distinctKpPairs: stats.distinctKpPairs,
      duplicateKpInGroup: stats.duplicateKpInGroup
    }
  }, null, 2));

  const randSummary = graphSummary(randomEdgeList, K);
  write('graph-random-manifest.json', JSON.stringify({
    ...commonManifest,
    graphType: 'random-same-edge-count-and-weight-multiset',
    graphSeed,
    graphSeedDerivation: derived.rule,
    graphSeedPrng: derived.prng,
    ...randSummary,
    componentSizes: connectedComponents(Ar, K),
    graphEdgesSha256: 'sha256:' + sha256Hex(Buffer.from(randCsv)),
    evidenceSha256: null,
    adjacencySha256: 'sha256:' + sha256Hex(Buffer.from(AnormR.buffer)),
    nonIsolatedTargetCoverage: randCoverage,
    randomizationNote: '随机化不保持度分布/连通性/加权度；主实验每种子一张随机图，不分离随机图实例方差'
  }, null, 2));

  write('graph-selfloop-manifest.json', JSON.stringify({
    ...commonManifest,
    graphType: 'selfloop-only',
    graphSeed: null,
    undirectedEdgeCount: 0,
    weightSum: 0,
    density: 0,
    isolatedNodeCount: K,
    componentSizes: Array(K).fill(1),
    degreeSummary: { min: 0, median: 0, max: 0, mean: 0, weightedMin: 0, weightedMedian: 0, weightedMax: 0 },
    graphEdgesSha256: 'sha256:' + sha256Hex(Buffer.from('sourceIndex,targetIndex,sourceKp,targetKp,support\n')),
    evidenceSha256: null,
    adjacencySha256: 'sha256:' + sha256Hex(Buffer.from(AnormS.buffer)),
    nonIsolatedTargetCoverage: selfCoverage,
    note: 'SelfLoop 对照：Anorm = I，仍计算逐节点两层非线性编码器；与 GCN 唯一差异是邻接矩阵'
  }, null, 2));

  console.log(`真实图：${realEdgeList.length} 条边（权重和 ${realSummary.weightSum}，密度 ${realSummary.density.toFixed(4)}，孤立 ${realSummary.isolatedNodeCount}/${K}，最大连通分量 ${realComponents[0]}）`);
  console.log(`随机图：graphSeed=${graphSeed}，${randomEdgeList.length} 条边`);
  console.log(`产出目录：${seedDir}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[buildAssist2009SkillGraph] ' + e.message); process.exit(1); });
}

module.exports = {
  GRAPH_PROTOCOL_VERSION,
  buildEdgeTable, adjacencyFromEdges, symmetricNormalize, randomizeEdges,
  sameTopology, connectedComponents, graphSummary, selfloopAdjacency,
  nonIsolatedTargetCoverage,
  edgesToCsv, evidenceToJsonl, parseCsvLine, mulberry32, fnv1a, deriveGraphSeed, canonicalHashOfIds
};
