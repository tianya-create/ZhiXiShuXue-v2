/**
 * 端到端骨架演示：合成教材/题库语料 → 分块 → doc 簇 → BM25 检索 → 三臂+O →
 * 合成判分（无 LLM，明确标注）→ 配对 bootstrap → 独立审计。
 * 目的：证明骨架管道可跑通、审计 22 项全绿；合成分数仅验证管道，不代表真实效果。
 *
 * 运行：node src/demo.js
 */

const { chunkCorpus } = require('./chunking/chunk');
const { docClusters } = require('./clustering/cluster');
const { buildBm25Index } = require('./retrieval/bm25');
const { sampleRandomContext, fnv1a } = require('./arms/randomArm');
const { bootstrapArms } = require('./stats/bootstrap');
const { mulberry32 } = require('./stats/core');
const { auditRun } = require('./audit/auditor');
const { normalizeAnswer } = require('./coverage/coverageAudit');
const { sha256OfJson, sha256OfText } = require('./util/hash');

const CONFIG_SEED = 'rag-eval-demo-20261112';

// ---------- 1. 合成语料（36 篇「教材节」，含 3 对近重复文档） ----------
const TOPICS = [
  '一元二次方程', '二次函数图像', '勾股定理', '全等三角形', '相似三角形', '一次函数',
  '反比例函数', '圆的切线', '弧长与扇形面积', '概率初步', '平均数与中位数', '因式分解',
  '分式化简', '二次根式', '一元一次不等式', '二元一次方程组', '平行四边形性质', '三角形中位线',
  '锐角三角函数', '抛物线平移', '韦达定理', '配方法', '十字相乘法', '科学记数法',
  '数轴与绝对值', '有理数运算', '整式乘法', '幂的运算法则', '平方差公式', '完全平方公式'
];
// dev 专用主题（与 eval 的 gold doc 簇天然不相交）
const DEV_TOPICS = ['圆周角定理', '垂径定理', '正多边形与圆', '旋转的性质', '轴对称与中心对称', '视图与投影'];

function docText(topic, i) {
  // 固定长度（180 字符、单行）：保证每篇恰好一个 chunk，R/X 臂的块数与长度天然可对齐
  let t = `【${topic}】本节定义：${topic}是初中数学的核心内容之一，要求掌握基本概念与运算方法。`
    + `本节结论：结论${i}号——运用${topic}解题时，先识别题型，再选择方法，最后检验结果。`
    + `典型例题：给出与${topic}有关的条件，要求逐步写出推导过程并得出答案。`
    + `易错点：注意运算顺序、符号变化与单位换算。`;
  if (t.length > 180) t = t.slice(0, 180);
  while (t.length < 180) t += '（本节练习与答案见配套题库）';
  return t.slice(0, 180);
}

const docs = TOPICS.map((t, i) => ({ docId: `d${String(i).padStart(2, '0')}`, text: docText(t, i) }));
// 近重复对（教材里的「拓展阅读」排版副本）：验证 doc 簇能抓到。
// 注意同样要截回 180 字符——否则会破坏「每篇恰好一个 chunk」的定长约定。
for (const i of [3, 10, 20]) {
  const src = docs[i];
  const copy = (src.text.replace('本节定义', '本讲定义')
    + '\n拓展阅读：本页与正文内容高度相似，供教师排版参考。').slice(0, 180);
  docs.push({ docId: `d${String(docs.length).padStart(2, '0')}`, text: copy });
}
for (const t of DEV_TOPICS) {
  docs.push({ docId: `d${String(docs.length).padStart(2, '0')}`, text: docText(t, docs.length) });
}

// ---------- 2. 分块 + doc 簇 ----------
const chunkPolicy = { size: 220, overlap: 30 };
const chunks = chunkCorpus(docs, { ...chunkPolicy });
const clusterResult = docClusters(docs, { threshold: 0.8, shingleK: 5 });
const docClusterOf = clusterResult.assignments; // docId → clusterId
// 每簇一个代表 chunk（簇内不重复给信息）
const clustersForRandom = clusterResult.clusters.map((c) => ({
  clusterId: c.clusterId,
  chunkIds: chunks.filter((ch) => c.memberIds.includes(ch.docId)).map((ch) => ch.chunkId).slice(0, 1)
})).filter((c) => c.chunkIds.length > 0);
const chunkTextById = new Map(chunks.map((c) => [c.chunkId, c.text]));

// ---------- 3. eval / dev 查询集（真值 query 簇：生成时已知同义改写对） ----------
const evalQueries = [];
for (let i = 0; i < 40; i++) {
  const topicIdx = i % 30;
  const q = i < 30
    ? `${TOPICS[topicIdx]}的核心公式是什么？`
    : `请告诉我${TOPICS[topicIdx]}的核心结论。`;
  evalQueries.push({ queryId: `q${String(i).padStart(2, '0')}`, text: q, topicIdx, queryClusterId: `qg-t${topicIdx}` });
}
const devQueries = DEV_TOPICS.map((t, i) => ({
  queryId: `dev${String(i).padStart(2, '0')}`,
  text: `${t}的判定方法有哪些？`,
  topicIdx: 30 + i,
  queryClusterId: `qg-dev${i}`
}));

// ---------- 4. 三臂 + O ----------
const index = buildBm25Index(chunks.map((c) => ({ id: c.chunkId, text: c.text })));
const allTopicNames = TOPICS.concat(DEV_TOPICS);
const goldDocIdOf = (topicIdx) => docs.find((d) => d.text.startsWith(`【${allTopicNames[topicIdx]}】`)).docId;

function synthScore({ arm, hasAnswer, queryId, sampleIdx }) {
  // ⚠️ 合成分数，仅验证管道；真实运行时这里是「LLM 生成 + 判分」
  let base;
  if (arm === 'O') base = 0.95;
  else if (arm === 'N') base = 0.35;
  else base = hasAnswer ? 0.88 : 0.42;
  const rnd = mulberry32(fnv1a(`${CONFIG_SEED}:score:${queryId}:${arm}:${sampleIdx}`));
  return Math.min(1, Math.max(0, base + (rnd() - 0.5) * 0.04));
}

const SAMPLES = 3;
const perQuery = {};
for (const q of evalQueries) {
  const goldDoc = goldDocIdOf(q.topicIdx);
  const probe = normalizeAnswer(`结论${q.topicIdx}号`).slice(0, 10);

  const hits = index.search(q.text, 5);
  const rChunks = hits.map((h) => chunks.find((c) => c.chunkId === h.docId));
  const rText = rChunks.map((c) => c.text).join('\n');
  // 预算口径：块字符数之和（分隔符在块数相等时两边一致，不计入）
  const rChars = rChunks.reduce((s, c) => s + c.charCount, 0);
  const rClusterIds = [...new Set(rChunks.map((c) => docClusterOf.get(c.docId)))];

  const x = sampleRandomContext({
    queryId: q.queryId,
    targetChars: rChars,
    clusters: clustersForRandom,
    chunkTextById,
    configSeed: CONFIG_SEED,
    excludeClusterIds: rClusterIds
  });
  const xText = x.texts.join('\n');

  const goldChunk = chunks.find((c) => c.docId === goldDoc);
  const oText = goldChunk.text;

  const has = (t) => normalizeAnswer(t).includes(probe);
  perQuery[q.queryId] = {
    N: { scores: Array.from({ length: SAMPLES }, (_, s) => synthScore({ arm: 'N', hasAnswer: false, queryId: q.queryId, sampleIdx: s })) },
    R: {
      chars: rChars, chunkCount: rChunks.length, docClusterIds: rClusterIds,
      scores: Array.from({ length: SAMPLES }, (_, s) => synthScore({ arm: 'R', hasAnswer: has(rText), queryId: q.queryId, sampleIdx: s }))
    },
    X: {
      chars: x.chars, chunkCount: x.texts.length, docClusterIds: x.clusterIds,
      scores: Array.from({ length: SAMPLES }, (_, s) => synthScore({ arm: 'X', hasAnswer: has(xText), queryId: q.queryId, sampleIdx: s }))
    },
    O: {
      chars: oText.length,
      scores: Array.from({ length: SAMPLES }, (_, s) => synthScore({ arm: 'O', hasAnswer: has(oText), queryId: q.queryId, sampleIdx: s }))
    }
  };
}

// ---------- 5. 配对 bootstrap + summary ----------
const rowsByArm = {};
for (const arm of ['N', 'R', 'X', 'O']) {
  rowsByArm[arm] = evalQueries.map((q) => {
    const scores = perQuery[q.queryId][arm].scores;
    return { userId: q.queryId, score: scores.reduce((s, x) => s + x, 0) / scores.length };
  });
}
const boot = bootstrapArms(rowsByArm, { reps: 400, seed: 20261112 });

const armMeans = {};
for (const [arm, ci] of Object.entries(boot.ciByArm)) armMeans[arm] = ci.meanExact;
const summary = {
  armMeans,
  comparisons: boot.comparisons
    .filter((c) => ['R − X', 'N − R', 'R − O'].includes(c.comparison))
    .map((c) => ({
      a: c.a, b: c.b,
      deltaMeanExact: c.pointDiff,
      deltaCI: c.deltaCI, deltaCI4: c.deltaCI4,
      supportFlag: c.supportFlag, p: c.p
    }))
};

// ---------- 6. 审计 ----------
const config = {
  protocolVersion: 'rag-controlled-eval-demo-v1',
  frozenBeforeRun: true,
  frozenAt: '2026-11-12',
  corpus: { chunkPolicy, docCluster: { method: 'jaccard-shingle', threshold: 0.8, shingleK: 5 } },
  retriever: { type: 'bm25-local', topK: 5 },
  generator: { temperature: 0, samplesPerQuery: SAMPLES, aggregation: 'mean' },
  judge: { minRejudgeAgreement: 0.9, minHumanKappa: 0.6 },
  metrics: { primary: 'token-f1' },
  bootstrap: { reps: 400, seed: 20261112 }
};

const evalSetSha = sha256OfJson(evalQueries);
const report = auditRun({
  config,
  hashes: {
    configSha256: sha256OfJson(config),
    evalSetSha256: evalSetSha,
    corpusSha256: sha256OfText(docs.map((d) => d.text).join('\n')),
    chunkManifestSha256: sha256OfJson(chunks.map((c) => c.chunkId)),
    judgeRubricSha256: sha256OfText('rubric-demo-v1')
  },
  freezeManifest: { configSha256: sha256OfJson(config), evalSetSha256: evalSetSha },
  queries: evalQueries.map((q) => ({
    queryId: q.queryId,
    queryClusterId: q.queryClusterId,
    goldDocClusterIds: [docClusterOf.get(goldDocIdOf(q.topicIdx))]
  })),
  perQuery,
  devQueryClusterIds: devQueries.map((q) => q.queryClusterId),
  devDocClusterIds: DEV_TOPICS.map((_, i) => docClusterOf.get(goldDocIdOf(30 + i))),
  fewShotQueryIds: devQueries.slice(0, 4).map((q) => q.queryId),
  fewShotQueryClusterIds: devQueries.slice(0, 4).map((q) => q.queryClusterId),
  indexQueryIds: [],
  judge: {
    minRejudgeAgreement: 0.9,
    minHumanKappa: 0.6,
    rejudge: Array.from({ length: 10 }, (_, i) => ({ original: i % 3, rejudged: i % 3 })),
    humanCalibration: Array.from({ length: 12 }, (_, i) => ({ judge: i % 3, human: i % 3 }))
  },
  summary,
  bootstrap: { reps: 400, seed: 20261112 },
  lengthTolerance: 0.02,
  ksThreshold: 0.2,
  requiredArms: ['N', 'R', 'X'],
  samplesPerQuery: SAMPLES
});

// ---------- 7. 输出 ----------
console.log('=== RAG 受控评测骨架 demo（合成分数，仅验证管道） ===\n');
console.log('语料:', docs.length, '篇 →', chunks.length, 'chunks；doc 簇:', clusterResult.clusters.length,
  '（近重复对已合并:', clusterResult.clusters.filter((c) => c.memberIds.length > 1).length, '个多成员簇）');
console.log('eval queries:', evalQueries.length, ' dev queries:', devQueries.length, '\n');
console.log('臂均值（合成分数）:');
for (const [arm, v] of Object.entries(boot.ciByArm)) {
  console.log(`  ${arm}: ${v.meanExact.toFixed(4)}  CI4 [${v.ci4[0]}, ${v.ci4[1]}]`);
}
console.log('\n比较:');
for (const c of summary.comparisons) {
  console.log(`  ${c.a} − ${c.b}: Δ = ${c.deltaMeanExact.toFixed(4)}  CI [${c.deltaCI[0].toFixed(4)}, ${c.deltaCI[1].toFixed(4)}]  p=${c.p}  支持=${c.supportFlag}`);
}
console.log('\n功效提示: n=40 时可检出最小效应约', (2.8 * Math.sqrt(0.2 / 40) * 100).toFixed(1), 'pp（p_disc=0.2）');
console.log('\n审计:', report.passed, '/', report.checks.length, '项通过');
for (const c of report.checks.filter((x) => !x.passed)) console.log('  ✗', c.id, c.name, '—', c.detail);
console.log('总体:', report.allPassed ? '✅ 全部通过' : '❌ 存在失败项');
process.exitCode = report.allPassed ? 0 : 1;
