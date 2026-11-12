/**
 * Stage 0 四臂 pilot（dev 集）——测噪声底 σ，为阈值推导提供唯一合法来源。
 *
 * 流程：
 *   1. 加载语料 → 分块(300/40) → BM25 索引 → doc 簇（一次构建，全 query 复用）
 *   2. 每条 query 构造 N/X/R/O 四臂上下文（contexts.jsonl 落盘，可复算）
 *   3. 每臂 × samplesPerQuery 次生成（temperature 按冻结配置）
 *   4. 逐条评分 token-F1 / EM，写 responses.jsonl（含 usage、延迟、错误）
 *   5. 汇总：各臂均值 + 配对 Δ + 95% CI + 噪声底 σ + 检索指标 + KC 分层
 *
 * 用法：
 *   set DASHSCOPE_API_KEY=...            （Windows bash: export DASHSCOPE_API_KEY=...）
 *   node src/stage0/runStage0.js --config configs/rag-eval-config.json --limit 5   # 冒烟
 *   node src/stage0/runStage0.js --config configs/rag-eval-config.json             # 全量 dev
 *
 * 断点续跑：默认读取已有 responses.jsonl，跳过已完成的 (queryId, arm, sampleIdx)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadXes3g5mCorpus } = require('../corpus/xes3g5m');
const { buildArtifacts, buildArmContexts, buildPrompt, PROMPT_TEMPLATE_SHA256 } = require('./contexts');
const { createLlmClient } = require('../llm/llmClient');
const { scoreRecord } = require('../metrics/answerScore');
const { bootstrapArms } = require('../stats/bootstrap');
const { sha256OfText } = require('../util/hash');

function argGet(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function pool(tasks, concurrency, onProgress) {
  let idx = 0;
  let done = 0;
  const results = [];
  async function worker() {
    while (idx < tasks.length) {
      const my = idx++;
      results[my] = await tasks[my]();
      done += 1;
      if (onProgress && (done % 20 === 0 || done === tasks.length)) onProgress(done, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

async function run() {
  const configPath = argGet('config', 'configs/rag-eval-config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const devPath = argGet('dev', cfg.devSet?.file);
  const outDir = argGet('out', 'data/stage0/dev-pilot');
  const limit = Number(argGet('limit', '0'));
  const samples = Number(argGet('samples', cfg.generator?.samplesPerQuery || 3));
  const concurrency = Number(argGet('concurrency', '5'));
  const topK = Number(argGet('topk', cfg.retriever?.topK || 5));
  const dryRun = hasFlag('dry-run');
  const excludeSelf = hasFlag('exclude-self');

  const queries = JSON.parse(fs.readFileSync(devPath, 'utf8')).slice(0, limit > 0 ? limit : undefined);
  console.log(`[S0] dev 集 ${queries.length} 条；samples=${samples} concurrency=${concurrency} topK=${topK}`);

  // ---- 语料与索引 ----
  const t0 = Date.now();
  const corpus = loadXes3g5mCorpus({ questionsPath: cfg.corpus.file });
  const art = buildArtifacts(corpus.docs, {
    chunkSize: cfg.corpus.chunkPolicy.size,
    chunkOverlap: cfg.corpus.chunkPolicy.overlap,
    jaccardThreshold: cfg.corpus.docCluster.jaccardThreshold,
  });
  console.log(`[S0] 索引就绪：${corpus.docs.length} docs / ${art.chunks.length} chunks / ${art.clusters.length} 簇（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  fs.mkdirSync(outDir, { recursive: true });
  const ctxPath = path.join(outDir, 'contexts.jsonl');
  const respPath = path.join(outDir, 'responses.jsonl');

  // ---- 上下文 ----
  const ctxByKey = new Map();
  for (const r of readJsonl(ctxPath)) ctxByKey.set(`${r.queryId}|${r.arm}`, r);
  const ctxTasks = [];
  for (const q of queries) {
    if (['N', 'X', 'R', 'O'].every((a) => ctxByKey.has(`${q.queryId}|${a}`))) continue;
    ctxTasks.push(() => {
      const arms = buildArmContexts(q, art, { topK, configSeed: `stage0:${cfg.evalSetBuild?.seed ?? 0}`, excludeSelfDoc: excludeSelf });
      return { queryId: q.queryId, kcId: q.kcId, goldAnswer: q.goldAnswer, arms, diag: arms.diag };
    });
  }
  if (ctxTasks.length) {
    const built = await pool(ctxTasks, 1);
    const fh = fs.openSync(ctxPath, 'a');
    for (const b of built) {
      for (const arm of ['N', 'X', 'R', 'O']) {
        const rec = { queryId: b.queryId, kcId: b.kcId, goldAnswer: b.goldAnswer, arm, ...b.arms[arm], diag: b.diag };
        fs.writeSync(fh, JSON.stringify(rec) + '\n');
        ctxByKey.set(`${b.queryId}|${arm}`, rec);
      }
    }
    fs.closeSync(fh);
  }
  console.log(`[S0] 上下文就绪 ${ctxByKey.size / 4} 条 query × 4 臂`);

  if (dryRun) {
    const sample = queries[0];
    const ctx = ctxByKey.get(`${sample.queryId}|R`);
    console.log(`[S0][dry-run] ${sample.queryId} R 臂 ${ctx.chars} 字符；prompt 前 200 字：\n${buildPrompt(ctx.text, sample.queryText).slice(0, 200)}`);
    return;
  }

  if (hasFlag('summarize-only')) {
    const cached = readJsonl(respPath).filter((r) => queries.some((q) => q.queryId === r.queryId));
    const summary = summarize({ all: cached, queries, samples, cfg, art, llm: { model: cfg.generator.model }, ctxByKey, topK, excludeSelf });
    const sumPath = path.join(outDir, 'stage0-summary.json');
    fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
    printSummary(summary, outDir, topK);
    return;
  }

  // ---- 生成 ----
  const llm = createLlmClient(cfg.generator);
  if (!llm.configured) throw new Error('LLM 未配置：请设置 DASHSCOPE_API_KEY 并在 config.generator.model 填模型名');

  const done = new Set(readJsonl(respPath).map((r) => `${r.queryId}|${r.arm}|${r.sampleIdx}`));
  const respFh = fs.openSync(respPath, 'a');
  const tasks = [];
  for (const q of queries) {
    for (const arm of ['N', 'X', 'R', 'O']) {
      for (let s = 0; s < samples; s++) {
        const key = `${q.queryId}|${arm}|${s}`;
        if (done.has(key)) continue;
        tasks.push(async () => {
          const ctx = ctxByKey.get(`${q.queryId}|${arm}`);
          const prompt = buildPrompt(ctx.text, q.queryText);
          const base = {
            queryId: q.queryId, kcId: q.kcId, arm, sampleIdx: s, goldAnswer: q.goldAnswer,
            contextChars: ctx.chars, promptSha256: sha256OfText(prompt), model: llm.model, at: new Date().toISOString(),
          };
          let rec;
          try {
            const res = await llm.complete(prompt);
            const sc = scoreRecord({ output: res.text, goldAnswer: q.goldAnswer });
            rec = { ...base, ...sc, output: res.text, finishReason: res.finishReason, usage: res.usage, latencyMs: res.latencyMs, attempts: res.attempts };
          } catch (e) {
            rec = { ...base, error: String(e.message || e), tokenF1: null, exactMatch: null, output: null };
          }
          fs.writeSync(respFh, JSON.stringify(rec) + '\n'); // 逐条落盘：中途中止也不丢已完成的样本
          return rec;
        });
      }
    }
  }
  console.log(`[S0] 待生成 ${tasks.length} 条（已完成 ${done.size}）`);
  const t1 = Date.now();
  const results = await pool(tasks, concurrency, (d, t) => {
    const el = (Date.now() - t1) / 1000;
    process.stdout.write(`\r[S0] ${d}/${t}  已用 ${el.toFixed(0)}s  ETA ${(el / d * (t - d)).toFixed(0)}s   `);
  });
  process.stdout.write('\n');
  fs.closeSync(respFh);
  void results;

  // ---- 汇总 ----
  const all = readJsonl(respPath).filter((r) => !limit || queries.some((q) => q.queryId === r.queryId));
  const summary = summarize({ all, queries, samples, cfg, art, llm, ctxByKey, topK, excludeSelf });
  const sumPath = path.join(outDir, 'stage0-summary.json');
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  printSummary(summary, outDir, topK);
  if (summary.errors.total > 0.05 * all.length) process.exitCode = 2;
}

function printSummary(summary, outDir, topK) {
  console.log(`[S0] 汇总 ${path.join(outDir, 'stage0-summary.json')}`);
  console.log(`[S0] 各臂 token-F1：` + ['N', 'X', 'R', 'O'].map((a) => `${a}=${summary.arms[a]?.meanF1?.toFixed(4) ?? 'NA'}`).join('  '));
  console.log(`[S0] ΔREL=R−X=${summary.delta.rel.point?.toFixed(4)} [${(summary.delta.rel.ci || []).map((v) => v.toFixed(4)).join(', ')}]  ΔRN=R−N=${summary.delta.rn.point?.toFixed(4)}`);
  console.log(`[S0] 检索 recall@${topK}=${summary.retrieval.recallAtK?.toFixed(3)} MRR=${summary.retrieval.mrr?.toFixed(3)}；X 臂长度最大偏差 ${(summary.retrieval.xLengthDeltaMax * 100)?.toFixed(2)}%`);
  console.log(`[S0] 噪声底 σ=${summary.noiseSigma.value?.toExponential(3)}（组内 SD ${summary.noiseSigma.sampleSd?.toExponential(3)} / √${summary.noiseSigma.nQueries}）→ 建议 strongDeltaRel=${summary.proposedThresholds.strongDeltaRel}`);
  if (summary.noiseSigma.value < 1e-3) {
    console.log('[S0][WARN] σ < 1e-3：生成近确定性，阈值不能只由 σ 推导，须并入 L3 judge 噪声（见 summary.notes）');
  }
}

function summarize({ all, queries, samples, cfg, art, llm, ctxByKey, topK, excludeSelf = false }) {
  const byArm = { N: [], X: [], R: [], O: [] };
  const errors = { total: 0, byArm: {} };
  const latencies = { N: [], X: [], R: [], O: [] };
  for (const r of all) {
    if (r.tokenF1 === null || r.tokenF1 === undefined) {
      errors.total += 1;
      errors.byArm[r.arm] = (errors.byArm[r.arm] || 0) + 1;
      continue;
    }
    byArm[r.arm].push(r);
    latencies[r.arm].push(r.latencyMs);
  }

  const armStats = {};
  for (const a of ['N', 'X', 'R', 'O']) {
    const rows = byArm[a];
    armStats[a] = {
      n: rows.length,
      meanF1: mean(rows.map((r) => r.tokenF1)),
      meanEM: mean(rows.map((r) => r.exactMatch)),
      sampleStdF1: std(rows.map((r) => r.tokenF1)),
      meanChars: mean(rows.map((r) => r.contextChars)),
      meanLatencyMs: mean(latencies[a]),
      errors: errors.byArm[a] || 0,
    };
  }

  // 配对：每 query 每 sample 的 Δ，用于噪声底
  const perQuery = new Map();
  for (const q of queries) perQuery.set(q.queryId, { queryId: q.queryId, kcId: q.kcId, scores: { N: [], X: [], R: [], O: [] } });
  for (const r of all) {
    if (r.tokenF1 === null || r.tokenF1 === undefined) continue;
    perQuery.get(r.queryId)?.scores[r.arm].push({ s: r.sampleIdx, f1: r.tokenF1 });
  }

  const deltaSamples = { rel: [], rn: [] };
  let withinSum = 0;
  let withinDf = 0;
  let nQForSigma = 0;
  for (const pq of perQuery.values()) {
    const map = (arr) => new Map(arr.map((x) => [x.s, x.f1]));
    const R = map(pq.scores.R); const X = map(pq.scores.X); const N = map(pq.scores.N);
    const ds = [];
    for (const [s, rv] of R) {
      if (X.has(s) && N.has(s)) { ds.push({ rel: rv - X.get(s), rn: rv - N.get(s) }); }
    }
    if (!ds.length) continue;
    deltaSamples.rel.push(...ds.map((d) => d.rel));
    deltaSamples.rn.push(...ds.map((d) => d.rn));
    const mRel = mean(ds.map((d) => d.rel));
    for (const d of ds) withinSum += (d.rel - mRel) ** 2;
    withinDf += ds.length - 1; // 每 query 组内自由度
    if (ds.length > 1) nQForSigma += 1;
  }
  // 逐 query 的采样 SD（同一 query 跨 sample 的 ΔREL 波动）
  const sigmaWithin = withinDf > 0 ? Math.sqrt(withinSum / withinDf) : 0;
  // Δ 点估计的种子噪声标准误：σ_within / √n（阈值比较的是「n 条 query 的均值」，
  // 与设计 §6.2「n=200 可检出 ~8.9pp」同一口径；逐 query 的抽样波动已由 bootstrap CI 覆盖）
  const nEff = nQForSigma > 0 ? nQForSigma : 1;
  const sigmaSe = sigmaWithin / Math.sqrt(nEff);

  // 点估计与 CI（query 级均值，配对 bootstrap）
  const rowsOf = (arm) => queries.map((q) => {
    const pq = perQuery.get(q.queryId);
    const f1s = pq ? pq.scores[arm].map((x) => x.f1) : [];
    return { queryId: q.queryId, score: f1s.length ? mean(f1s) : 0 };
  });
  const boot = bootstrapArms({ N: rowsOf('N'), X: rowsOf('X'), R: rowsOf('R'), O: rowsOf('O') }, { reps: 2000, seed: 42, groupKey: 'queryId' });
  // bootstrapArms 的 pair 顺序固定为臂名顺序（N,X,R,O），需按调用意图归一化符号
  const cmp = (a, b) => {
    const c = boot.comparisons.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!c) return {};
    const sign = c.a === a ? 1 : -1;
    return {
      ...c,
      pointDiff: c.pointDiff === null ? null : sign * c.pointDiff,
      deltaCI: sign === 1 ? c.deltaCI : [-c.deltaCI[1], -c.deltaCI[0]],
      supportFlag: sign === 1 ? c.supportFlag : c.negativeFlag,
      negativeFlag: sign === 1 ? c.negativeFlag : c.supportFlag,
    };
  };
  const rel = cmp('R', 'X');
  const rn = cmp('R', 'N');
  const ro = cmp('R', 'O');

  // 检索指标（L1，零噪声）：gold doc 是否进 R 臂 topK，及其名次
  const rq = queries.map((q) => ctxByKey.get(`${q.queryId}|R`)).filter(Boolean);
  const retrieval = {
    n: rq.length,
    recallAtK: rq.length ? rq.filter((c) => c.diag?.goldDocInR).length / rq.length : null,
    mrr: rq.length ? mean(rq.map((c) => (c.diag?.goldRankInR ? 1 / c.diag.goldRankInR : 0))) : null,
    topK,
    meanRChars: mean(rq.map((c) => c.chars)),
    xLengthDeltaMax: (() => {
      const ds = queries.map((q) => ctxByKey.get(`${q.queryId}|X`)?.diag?.xLengthDelta).filter((v) => typeof v === 'number');
      return ds.length ? Math.max(...ds.map(Math.abs)) : null;
    })(),
  };

  const kcTable = {};
  for (const pq of perQuery.values()) {
    const f1 = (arm) => mean(pq.scores[arm].map((x) => x.f1));
    const key = pq.kcId || '未知';
    kcTable[key] = kcTable[key] || { n: 0, N: [], X: [], R: [], O: [] };
    kcTable[key].n += 1;
    for (const a of ['N', 'X', 'R', 'O']) { const v = f1(a); if (v !== null) kcTable[key][a].push(v); }
  }
  for (const k of Object.keys(kcTable)) {
    for (const a of ['N', 'X', 'R', 'O']) kcTable[k][a] = mean(kcTable[k][a]);
  }

  const proposed = {
    noiseSigma: Number(sigmaSe.toPrecision(4)),
    strongDeltaRel: Number(Math.max(2 * sigmaSe, 1e-4).toPrecision(4)),
    _derivation: 'strongDeltaRel = 2 × noiseSigma；noiseSigma = σ_within / √n（σ_within 为同 query 跨 sample 的 ΔREL 组内标准差）',
  };

  return {
    stage: 'stage0-dev-pilot',
    generatedAt: new Date().toISOString(),
    model: llm.model,
    promptTemplateSha256: PROMPT_TEMPLATE_SHA256,
    config: { generator: cfg.generator, retriever: cfg.retriever, corpus: { docCount: cfg.corpus.docCount, chunkPolicy: cfg.corpus.chunkPolicy } },
    nQueries: queries.length,
    samplesPerQuery: samples,
    excludeSelfDoc: excludeSelf,
    chunkCount: art.chunks.length,
    arms: armStats,
    retrieval,
    delta: {
      rel: { point: rel.pointDiff ?? null, ci: rel.deltaCI ?? null, p: rel.p ?? null, support: rel.supportFlag ?? null },
      rn: { point: rn.pointDiff ?? null, ci: rn.deltaCI ?? null, p: rn.p ?? null, support: rn.supportFlag ?? null },
      ro: { point: ro.pointDiff ?? null, ci: ro.deltaCI ?? null, p: ro.p ?? null },
    },
    noiseSigma: {
      value: sigmaSe,
      sampleSd: sigmaWithin,
      nQueries: nEff,
      withinDf,
      source: 'generation：σ_within（同 query 跨 sample 的 ΔREL 组内 SD）除以 √n，即 Δ 点估计的种子噪声标准误',
    },
    proposedThresholds: proposed,
    kcBreakdown: kcTable,
    errors,
    notes: [
      'ΔREL 主效应 = R − X（等长随机上下文），不是 R − N：X 消掉了上下文长度与「有资料」暗示的混杂。',
      'noiseSigma = σ_within/√n，衡量「换一批生成种子时 Δ 点估计会漂多少」；逐 query 的抽样波动由 bootstrap CI 覆盖，两者不重复计数。',
      'σ_within 在 temperature=0 下仍非零（服务端非确定性），属实测值；若某模型完全确定，σ 会趋近 0，此时阈值须并入 judge 噪声并写 revision。',
      'O 臂 = gold 该题 doc（含解析），用作生成器上限诊断，不参与决策矩阵。',
    ],
  };
}

module.exports = { run, summarize };
if (require.main === module) run().catch((e) => { console.error('[S0][FAIL]', e); process.exitCode = 1; });
