/**
 * Stage 1 冻结：把「配置 + 数据集 + prompt + 检索器」四把尺子钉死，并实测四项泄漏断言。
 *
 * 纪律：
 *  - 任一断言不为 true、或 stage0Preflight / thresholds 仍为 null → 拒绝冻结（exit 2），
 *    不写 frozenAt、不写 manifest；
 *  - 冻结后任何 config 改动都必须写 revision，旧 manifest 保留（用于事后核对跑的是哪版）。
 *
 * 四项断言的**可操作定义**（本框架采用）：
 *  1. queryClusterDisjoint   dev 与 eval 的 query 簇集合无交集（同事实不同问法不跨集）
 *  2. docClusterDisjoint     dev 与 eval 各自 oracle doc 所属 doc 簇无交集（近重复题不跨集）
 *  3. fewShotExcludedFromEval 本协议不使用 few-shot；若配置里出现示例，必须与 eval 簇无交集
 *  4. indexExcludesEvalQueries 检索侧对每条 eval query 排除其自身 doc（LOO），实测每条 R 上下文都不含 gold doc
 *
 * 用法：
 *   node src/stage1/freeze.js --config configs/rag-eval-config.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sha256OfText, sha256OfJson } = require('../util/hash');
const { loadXes3g5mCorpus } = require('../corpus/xes3g5m');
const { docClusters } = require('../clustering/cluster');
const { buildArtifacts, buildArmContexts, PROMPT_TEMPLATE_SHA256 } = require('../stage0/contexts');

function argGet(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

/** 断言 1：dev/eval query 簇无交集 */
function queryClusterDisjoint(dev, evalSet) {
  const d = new Set(dev.map((q) => q.queryClusterId));
  const leaked = evalSet.filter((q) => d.has(q.queryClusterId)).map((q) => q.queryId);
  return { pass: leaked.length === 0, leaked };
}

/** 断言 2：dev/eval oracle doc 所属簇无交集 */
function docClusterDisjoint(dev, evalSet, assignments) {
  const d = new Set(dev.map((q) => assignments.get(q.oracleDocId)));
  const leaked = evalSet.filter((q) => d.has(assignments.get(q.oracleDocId))).map((q) => q.queryId);
  return { pass: leaked.length === 0, leaked, devClusters: d.size };
}

/** 断言 3：few-shot 未进入 eval（无 few-shot 时为空集，恒真） */
function fewShotExcludedFromEval(fewShot, evalSet) {
  const examples = Array.isArray(fewShot) ? fewShot : [];
  const e = new Set(evalSet.map((q) => q.queryClusterId));
  const leaked = examples.filter((x) => e.has(x.queryClusterId)).map((x) => x.queryId || x.queryClusterId);
  return { pass: leaked.length === 0, leaked, exampleCount: examples.length };
}

/** 断言 4：LOO 检索下 R 上下文不含 gold doc（逐条实测，不是看配置开关） */
function indexExcludesEvalQueries(evalSet, art, { topK = 5 } = {}) {
  const violations = [];
  for (const q of evalSet) {
    const arms = buildArmContexts(q, art, { topK, excludeSelfDoc: true });
    if (arms.R.docIds.includes(q.oracleDocId)) violations.push(q.queryId);
  }
  return { pass: violations.length === 0, leaked: violations, checked: evalSet.length };
}

function run() {
  const configPath = argGet('config', 'configs/rag-eval-config.json');
  const outPath = argGet('out', 'data/stage1/freeze-manifest.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // ---- 前置：Stage 0 实测值必须齐 ----
  const missing = [];
  for (const k of ['answerInCorpusRate', 'oracleRecallAtK', 'generatorCeiling', 'noiseSigma']) {
    if (cfg.stage0Preflight?.[k] === null || cfg.stage0Preflight?.[k] === undefined) missing.push(`stage0Preflight.${k}`);
  }
  for (const k of ['strongDeltaRel', 'stopCooldown']) {
    if (k === 'stopCooldown') continue; // 允许为 null（表示不设冷却）
    if (cfg.thresholds?.[k] === null || cfg.thresholds?.[k] === undefined) missing.push(`thresholds.${k}`);
  }
  if (missing.length) {
    console.error(`[S1][REFUSE] 以下 Stage 0 实测值仍为空，不得冻结：${missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const dev = JSON.parse(fs.readFileSync(cfg.devSet.file, 'utf8'));
  const evalSet = JSON.parse(fs.readFileSync(cfg.evalSet.file, 'utf8'));
  console.log(`[S1] dev=${dev.length} eval=${evalSet.length}`);

  const corpus = loadXes3g5mCorpus({ questionsPath: cfg.corpus.file });
  const art = buildArtifacts(corpus.docs, {
    chunkSize: cfg.corpus.chunkPolicy.size,
    chunkOverlap: cfg.corpus.chunkPolicy.overlap,
    jaccardThreshold: cfg.corpus.docCluster.jaccardThreshold,
  });
  const { assignments } = docClusters(corpus.docs, { threshold: cfg.corpus.docCluster.jaccardThreshold });

  const a1 = queryClusterDisjoint(dev, evalSet);
  const a2 = docClusterDisjoint(dev, evalSet, assignments);
  const a3 = fewShotExcludedFromEval(cfg.fewShot, evalSet);
  const a4 = indexExcludesEvalQueries(evalSet, art, { topK: cfg.retriever.topK });
  const assertions = {
    queryClusterDisjoint: a1.pass,
    docClusterDisjoint: a2.pass,
    fewShotExcludedFromEval: a3.pass,
    indexExcludesEvalQueries: a4.pass,
  };
  console.log(`[S1] 断言：query 簇 ${a1.pass}｜doc 簇 ${a2.pass}（dev 簇 ${a2.devClusters}）｜few-shot ${a3.pass}（${a3.exampleCount} 例）｜LOO 索引 ${a4.pass}（查 ${a4.checked} 条）`);

  const failed = Object.entries(assertions).filter(([, v]) => !v);
  if (failed.length) {
    console.error(`[S1][REFUSE] 泄漏断言未通过：${failed.map(([k]) => k).join(', ')}；明细 ${JSON.stringify({ a1, a2, a3, a4 })}`);
    process.exitCode = 2;
    return;
  }

  // ---- 冻结：先落 frozenAt 与断言，再对「落盘后的配置」取哈希 ----
  const frozenAt = cfg.frozenAt || new Date().toISOString();
  const frozenCfg = {
    ...cfg,
    frozenAt,
    leakageAssertions: {
      ...cfg.leakageAssertions,
      queryClusterDisjoint: true,
      docClusterDisjoint: true,
      fewShotExcludedFromEval: true,
      indexExcludesEvalQueries: true,
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(frozenCfg, null, 2) + '\n', 'utf8');

  const configText = fs.readFileSync(configPath, 'utf8');
  const manifest = {
    protocolVersion: frozenCfg.protocolVersion,
    revision: frozenCfg.revision,
    frozenAt,
    frozenBy: 'src/stage1/freeze.js',
    hashes: {
      configFile: sha256OfText(configText),
      evalSetFile: sha256OfText(fs.readFileSync(frozenCfg.evalSet.file, 'utf8')),
      devSetFile: sha256OfText(fs.readFileSync(frozenCfg.devSet.file, 'utf8')),
      corpusManifestFile: sha256OfText(fs.readFileSync(frozenCfg.corpus.manifestFile, 'utf8')),
      promptTemplate: PROMPT_TEMPLATE_SHA256,
      retrieverModule: frozenCfg.retriever.modelVersionHash,
    },
    declaredHashes: {
      evalSet: frozenCfg.evalSet.sha256,
      devSet: frozenCfg.devSet.sha256,
      promptTemplate: frozenCfg.generator.promptTemplateSha256,
      corpusManifest: frozenCfg.corpus.manifestSha256,
    },
    assertions: {
      queryClusterDisjoint: { pass: a1.pass, leaked: a1.leaked },
      docClusterDisjoint: { pass: a2.pass, leaked: a2.leaked, devClusters: a2.devClusters },
      fewShotExcludedFromEval: { pass: a3.pass, leaked: a3.leaked, exampleCount: a3.exampleCount },
      indexExcludesEvalQueries: { pass: a4.pass, leaked: a4.leaked, checked: a4.checked },
    },
    frozenParameters: {
      stage0Preflight: frozenCfg.stage0Preflight,
      thresholds: frozenCfg.thresholds,
      retriever: frozenCfg.retriever,
      generator: frozenCfg.generator,
      chunkPolicy: frozenCfg.corpus.chunkPolicy,
      samplesPerQuery: frozenCfg.generator.samplesPerQuery,
      nEval: evalSet.length,
      nDev: dev.length,
    },
    evalSetDigest: {
      n: evalSet.length,
      recordsSha256: sha256OfJson(evalSet),
      queryClusterIdsSha256: sha256OfJson(evalSet.map((q) => q.queryClusterId).sort()),
    },
  };

  // 声明的哈希必须与实际文件一致（防止 manifest 里写一套、跑的是另一套）
  const mismatch = [];
  if (frozenCfg.evalSet.sha256 !== manifest.hashes.evalSetFile) {
    // evalSet.sha256 记录的是记录级 sha（querySetManifest），此处比较文件级，允许不同但必须显式记录
    manifest.evalSetHashNote = 'evalSet.sha256 为记录级 sha（buildQuerySet.querySetManifest），manifest.hashes.evalSetFile 为文件字节 sha，两者口径不同';
  }
  if (frozenCfg.generator.promptTemplateSha256 !== PROMPT_TEMPLATE_SHA256) mismatch.push('promptTemplateSha256');
  if (frozenCfg.corpus.manifestSha256 !== manifest.hashes.corpusManifestFile) mismatch.push('corpus.manifestSha256');
  if (mismatch.length) {
    console.error(`[S1][REFUSE] 配置声明的哈希与实物不一致：${mismatch.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[S1][FROZEN] ${outPath}`);
  console.log(`[S1] config sha=${manifest.hashes.configFile.slice(0, 23)}…  eval 集记录 sha=${manifest.evalSetDigest.recordsSha256.slice(0, 23)}…`);
  console.log(`[S1] 阈值：σ=${frozenCfg.stage0Preflight.noiseSigma} strongDeltaRel=${frozenCfg.thresholds.strongDeltaRel} 覆盖率=${frozenCfg.stage0Preflight.answerInCorpusRate}`);
}

module.exports = { queryClusterDisjoint, docClusterDisjoint, fewShotExcludedFromEval, indexExcludesEvalQueries, run };
if (require.main === module) run();
