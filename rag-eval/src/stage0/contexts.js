/**
 * Stage 0 四臂上下文构造（N / X / R / O）。
 *
 * 纪律：四臂共用同一 prompt 模板，只有 {context} 槽位内容不同；N 臂填空串而非删段。
 *
 *  - N：空串（测参数记忆下界）
 *  - X：与 R 等字符数、且 doc 簇与 R 无交集的随机块（测「上下文长度」这个混杂）
 *  - R：BM25 检索 topK（冻结 retriever）
 *  - O：gold 该题自身 doc 的全部块（测生成器上限，含解析里的答案）
 */
'use strict';

const { buildBm25Index } = require('../retrieval/bm25');
const { chunkCorpus } = require('../chunking/chunk');
const { docClusters } = require('../clustering/cluster');
const { sampleRandomContext } = require('../arms/randomArm');
const { sha256OfText } = require('../util/hash');

const PROMPT_TEMPLATE = `参考资料：
{context}

题目：
{question}

请只给出最终答案，不要写解题过程。`;

const PROMPT_TEMPLATE_SHA256 = sha256OfText(PROMPT_TEMPLATE);

function buildPrompt(context, question) {
  return PROMPT_TEMPLATE.replace('{context}', context).replace('{question}', question);
}

/**
 * 一次性构建检索/分块/簇索引（对同一语料可复用）。
 * @param {Array<{docId,text,kcId}>} docs
 */
function buildArtifacts(docs, { chunkSize = 300, chunkOverlap = 40, jaccardThreshold = 0.8 } = {}) {
  const chunks = chunkCorpus(docs, { size: chunkSize, overlap: chunkOverlap, idPrefix: 'xes' });
  const index = buildBm25Index(chunks.map((c) => ({ id: c.chunkId, text: c.text })));
  const { clusters, assignments } = docClusters(docs, { threshold: jaccardThreshold });
  const chunksByDoc = new Map();
  for (const c of chunks) {
    if (!chunksByDoc.has(c.docId)) chunksByDoc.set(c.docId, []);
    chunksByDoc.get(c.docId).push(c);
  }
  const clusterOfDoc = assignments; // Map docId → clusterId
  const clusterPool = clusters.map((cl) => {
    const chunkIds = [];
    for (const docId of cl.memberIds) for (const c of chunksByDoc.get(docId) || []) chunkIds.push(c.chunkId);
    return { clusterId: cl.clusterId, chunkIds };
  });
  const chunkTextById = new Map(chunks.map((c) => [c.chunkId, c.text]));
  const chunkDocById = new Map(chunks.map((c) => [c.chunkId, c.docId]));
  return { chunks, index, clusters, clusterPool, chunksByDoc, clusterOfDoc, chunkTextById, chunkDocById };
}

/**
 * 构造单条 query 的四臂上下文。
 * @param {{queryId, queryText, oracleDocId, goldAnswer}} query
 * @param {object} art buildArtifacts 的返回
 * @param {{topK?:number, configSeed?:string, tolerance?:number}} opts
 */
function buildArmContexts(query, art, { topK = 5, configSeed = 'stage0', tolerance = 0.02, excludeSelfDoc = false } = {}) {
  const goldChunks = art.chunksByDoc.get(query.oracleDocId) || [];
  if (goldChunks.length === 0) throw new Error(`oracle doc 不存在或未分块：${query.oracleDocId}`);

  // excludeSelfDoc：leave-one-out 检索（排除题目自身 doc），测「靠同类题/知识点」而非「抄本题解析」
  const rawHits = art.index.search(query.queryText, excludeSelfDoc ? topK + 10 : topK);
  const hits = rawHits
    .filter((h) => h.score > 0)
    .filter((h) => !excludeSelfDoc || art.chunkDocById.get(h.docId) !== query.oracleDocId)
    .slice(0, topK);
  if (hits.length === 0) throw new Error(`检索无命中（query ${query.queryId}）：BM25 全零分，检查分词`);
  const rChunks = hits.map((h) => {
    const chunkId = h.docId;
    const docId = art.chunkDocById.get(chunkId);
    return { chunkId, docId, clusterId: art.clusterOfDoc.get(docId), text: art.chunkTextById.get(chunkId), score: h.score };
  });
  const rText = rChunks.map((c) => c.text).join('\n\n');

  const oText = goldChunks.map((c) => c.text).join('\n\n');

  const x = sampleRandomContext({
    queryId: query.queryId,
    targetChars: rText.length,
    clusters: art.clusterPool,
    chunkTextById: art.chunkTextById,
    configSeed,
    excludeClusterIds: [...new Set(rChunks.map((c) => c.clusterId))],
    tolerance,
  });

  return {
    N: { text: '', chars: 0, chunkIds: [], docIds: [], clusterIds: [] },
    X: { text: x.texts.join('\n\n'), chars: x.chars, chunkIds: x.chunkIds, docIds: x.chunkIds.map((id) => art.chunkDocById.get(id)), clusterIds: x.clusterIds },
    R: { text: rText, chars: rText.length, chunkIds: rChunks.map((c) => c.chunkId), docIds: rChunks.map((c) => c.docId), clusterIds: rChunks.map((c) => c.clusterId) },
    O: { text: oText, chars: oText.length, chunkIds: goldChunks.map((c) => c.chunkId), docIds: [query.oracleDocId], clusterIds: [art.clusterOfDoc.get(query.oracleDocId)] },
    diag: {
      topK,
      excludeSelfDoc,
      goldDocInR: rChunks.some((c) => c.docId === query.oracleDocId),
      goldRankInR: (() => { const i = rChunks.findIndex((c) => c.docId === query.oracleDocId); return i < 0 ? null : i + 1; })(),
      xOverlapWithR: x.clusterIds.filter((c) => rChunks.some((r) => r.clusterId === c)).length,
      xLengthDelta: rText.length === 0 ? 0 : (x.chars - rText.length) / rText.length,
    },
  };
}

module.exports = { buildArtifacts, buildArmContexts, buildPrompt, PROMPT_TEMPLATE, PROMPT_TEMPLATE_SHA256 };
