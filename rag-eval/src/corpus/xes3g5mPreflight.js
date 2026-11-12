/**
 * XES3G5M 语料 P0 预检（设计文档 §3 Stage 0 的语料侧部分）。
 *
 * 输入：XES3G5M 元数据 JSON（full 或 subset 模式，自动识别）
 * 输出：P0 报告 JSON——分块统计、doc 簇、BM25 自检索@1/@10 冒烟、语料 manifest。
 *
 * 自检索冒烟：以每题题面（截断 80 字符）为 query，gold = 该题自身任一块，
 * 报 recall@1/@10。这是检索器"下界体检"：连题目原文都检不回，说明分块/分词有问题。
 * subset 模式无答案，coverage 三口径无法计算正式值（degraded 标注）。
 *
 * 用法：
 *   node src/corpus/xes3g5mPreflight.js --questions <questions.json> --out <report.json>
 *       [--max-queries 500] [--chunk-size 300] [--chunk-overlap 40]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadXes3g5mCorpus, corpusManifest, answerProbeOf, LICENSE_NOTE } = require('./xes3g5m');
const { chunkCorpus } = require('../chunking/chunk');
const { docClusters } = require('../clustering/cluster');
const { buildBm25Index } = require('../retrieval/bm25');
const { answerInCorpusRate, oracleRecallAtK } = require('../coverage/coverageAudit');
const { sha256OfText } = require('../util/hash');

function argGet(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function run() {
  const questionsPath = argGet('questions');
  if (!questionsPath) throw new Error('--questions 必填');
  const outPath = argGet('out', 'data/xes3g5m/preflight-report.json');
  const maxQueries = Number(argGet('max-queries', '500'));
  const chunkSize = Number(argGet('chunk-size', '300'));
  const chunkOverlap = Number(argGet('chunk-overlap', '40'));

  console.log(`[P0] 加载语料：${questionsPath}`);
  const corpus = loadXes3g5mCorpus({ questionsPath });
  console.log(`[P0] mode=${corpus.mode} docs=${corpus.stats.docsKept}/${corpus.stats.questionsTotal} dropped=${corpus.stats.dropped}`);
  console.log(`[P0] 字符 min=${corpus.stats.charMin} median=${corpus.stats.charMedian} max=${corpus.stats.charMax}`);

  // ---- 分块 ----
  const chunks = chunkCorpus(corpus.docs, { size: chunkSize, overlap: chunkOverlap, idPrefix: 'xes' });
  const chunkLens = chunks.map((c) => c.charCount);
  const chunkStats = {
    chunkCount: chunks.length,
    perDocMean: (chunks.length / corpus.docs.length).toFixed(2),
    charMin: Math.min(...chunkLens),
    charMedian: chunkLens.sort((a, b) => a - b)[chunkLens.length >> 1],
    charMax: Math.max(...chunkLens),
    size: chunkSize,
    overlap: chunkOverlap,
  };
  console.log(`[P0] 分块 ${chunkStats.chunkCount} 块（每 doc 均 ${chunkStats.perDocMean} 块）`);

  // ---- doc 簇（近重复检测）----
  const clusters = docClusters(corpus.docs, { threshold: 0.8 });
  const multi = clusters.clusters.filter((c) => c.memberIds.length > 1);
  console.log(`[P0] doc 簇：${clusters.clusters.length} 个，多成员簇 ${multi.length} 个（覆盖 ${multi.reduce((s, c) => s + c.memberIds.length, 0)} docs）`);

  // ---- BM25 自检索冒烟 ----
  const docById = new Map(corpus.docs.map((d) => [d.docId, d]));
  const chunkDocOf = new Map(chunks.map((c) => [c.chunkId, c.docId]));
  const index = buildBm25Index(chunks.map((c) => ({ id: c.chunkId, text: c.text })));
  const sample = corpus.docs.slice(0, maxQueries);
  let r1 = 0;
  let r10 = 0;
  for (const d of sample) {
    const query = d.text.slice(0, 80);
    const hits = index.search(query, 10);
    const topDoc = hits.map((h) => chunkDocOf.get(h.docId));
    if (topDoc[0] === d.docId) r1 += 1;
    if (topDoc.includes(d.docId)) r10 += 1;
  }
  const selfRetrieval = { n: sample.length, recallAt1: (r1 / sample.length).toFixed(4), recallAt10: (r10 / sample.length).toFixed(4) };
  console.log(`[P0] BM25 自检索 @1=${selfRetrieval.recallAt1} @10=${selfRetrieval.recallAt10}（n=${selfRetrieval.n}）`);

  // ---- 覆盖率三口径 ----
  let coverage;
  if (corpus.mode === 'full') {
    const raw = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
    // answerInCorpusRate：只用填空题（单选答案为选项字母，探针无区分度），剥 $$..$$ LaTeX
    const blankItems = [];
    let skippedChoice = 0;
    let skippedSymbolAnswer = 0;
    for (const [qid, q] of Object.entries(raw)) {
      const type = String(q.type || '');
      if (!type.includes('填空')) { skippedChoice += 1; continue; }
      const probe = answerProbeOf(q);
      // 与 coverageAudit.normalizeAnswer 同口径判空：纯符号答案（"<"、">"、"=" 等）无探针意义
      const normalized = probe.replace(/[^\p{L}\p{N}]+/gu, '');
      if (!normalized) { skippedSymbolAnswer += 1; continue; }
      blankItems.push({ queryId: `xes-q${qid}`, answer: probe });
    }
    const aic = answerInCorpusRate({ items: blankItems, chunks });
    // oracle recall@5/@10：query = 题面前 80 字符，gold = 该题自身 doc（chunk 级聚合到 doc 级）
    const chunkDocOf2 = new Map(chunks.map((c) => [c.chunkId, c.docId]));
    const sampleDocs = corpus.docs.slice(0, maxQueries);
    const golds = sampleDocs.map((d) => ({ queryId: d.docId, docIds: [d.docId] }));
    const ranked = sampleDocs.map((d) => ({
      queryId: d.docId,
      docIds: [...new Set(index.search(d.text.slice(0, 80), 10).map((h) => chunkDocOf2.get(h.docId)))],
    }));
    const or5 = oracleRecallAtK({ ranked, golds, k: 5 });
    const or10 = oracleRecallAtK({ ranked, golds, k: 10 });
    coverage = {
      answerInCorpusRate: aic.rate,
      answerInCorpusFound: aic.found,
      answerInCorpusTotal: aic.total,
      skippedChoiceQuestions: skippedChoice,
      skippedSymbolAnswerQuestions: skippedSymbolAnswer,
      note: 'answerInCorpusRate 仅对填空题计算（单选答案为字母无探针区分度；纯符号答案 <、>、= 共 13 题亦剔除）；oracle recall 的 query 为题面原文前 80 字符，gold 为该题解析所在 doc',
      oracleRecallAt5: or5.recallAtK,
      oracleRecallAt10: or10.recallAtK,
      generatorCeiling: '需 LLM 在 O 臂（gold 上下文）下实测，骨架显式拒绝估计值',
    };
    console.log(`[P0] answerInCorpusRate=${coverage.answerInCorpusRate.toFixed(4)}（填空 ${aic.total} 题，跳过单选/空探针 ${skippedChoice}）`);
    console.log(`[P0] oracle recall @5=${coverage.oracleRecallAt5.toFixed(4)} @10=${coverage.oracleRecallAt10.toFixed(4)}`);
  } else {
    coverage = { answerInCorpusRate: null, degraded: true, note: 'subset 无 answer/analysis，无法计算覆盖率三口径；仅作管道验证，不得用于正式评测' };
  }

  // ---- manifest + 报告 ----
  const report = {
    generatedAt: new Date().toISOString(),
    input: { questionsPath: path.resolve(questionsPath), questionsJsonSha256: sha256OfText(fs.readFileSync(questionsPath, 'utf8')) },
    source: { ...LICENSE_NOTE, subsetCaveat: corpus.mode === 'subset' ? '来自 HF Gyikoo/KT4EQG-data（无解析/答案，content 多为英译），仅管道验证用' : undefined },
    mode: corpus.mode,
    corpusStats: corpus.stats,
    chunkStats,
    docClusters: { count: clusters.clusters.length, multiMember: multi.length, multiMemberCoverage: multi.reduce((s, c) => s + c.memberIds.length, 0) },
    selfRetrieval,
    coverage,
    dropped: corpus.dropped.slice(0, 50),
    droppedTotal: corpus.stats.dropped,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const manifestPath = outPath.replace(/\.json$/, '') + '-corpus-manifest.json';
  fs.writeFileSync(manifestPath, JSON.stringify(corpusManifest(corpus), null, 2), 'utf8');
  console.log(`[P0] 报告 ${outPath}；manifest ${manifestPath}`);

  // ---- 硬校验：自检索不达标的语料不得进入 Stage 1 ----
  if (Number(selfRetrieval.recallAt10) < 0.95) {
    console.error(`[P0][FAIL] 自检索 @10=${selfRetrieval.recallAt10} < 0.95：分块/分词存在结构性问题，先修分块参数再谈评测`);
    process.exitCode = 2;
  } else {
    console.log('[P0][PASS] 自检索达标');
  }
}

module.exports = { run };
if (require.main === module) run();
