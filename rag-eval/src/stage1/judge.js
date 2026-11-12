/**
 * L3 judge：用 LLM 按冻结 rubric 给答案打 0/1/2，作为 token-F1 之外的语义层评分。
 *
 * 纪律（设计 §11）：
 *  - rubric 逐字冻结（sha256 入 manifest），换 rubric = 换尺子，须写 revision 并全量重算；
 *  - **盲评**：judge 输入只有「题目 / 参考答案 / 待评答案」，不含臂名、不含上下文，
 *    避免 judge 知道「这是检索臂」而偏袒；
 *  - 空答案直接判 0，不烧调用，但同样落盘（可审计）；
 *  - 10% 样本二次重判，报一致率；低于 minRejudgeAgreement 则 L3 不可用于判定；
 *  - 人工校准表另出（CSV），由人填 humanScore 后再算 κ；κ < 0.6 时 L3 仅作参考。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sha256OfText } = require('../util/hash');
const { createLlmClient } = require('../llm/llmClient');
const { mulberry32 } = require('../stats/core');

const RUBRIC_TEXT = `2 = 完全正确：数值/表达式与参考答案等价（单位可省略，等价形式如 0.5 与 1/2 视为相同）
1 = 部分正确：思路或部分要素正确，但最终答案错误、不完整或含多余错误结论
0 = 错误：答案与参考答案不符、答非所问、拒答或为空`;

const JUDGE_PROMPT_TEMPLATE = `你是严格但公正的数学阅卷员。判断「待评答案」与「参考答案」是否等价。

题目：
{question}

参考答案：
{gold}

待评答案：
{pred}

评分标准：
${RUBRIC_TEXT}

只输出一行 JSON，不要解释：{"score": 0|1|2, "reason": "不超过30字"}`;

const RUBRIC_SHA256 = sha256OfText(RUBRIC_TEXT);
const JUDGE_PROMPT_SHA256 = sha256OfText(JUDGE_PROMPT_TEMPLATE);

function buildJudgePrompt({ question, goldAnswer, pred }) {
  return JUDGE_PROMPT_TEMPLATE
    .replace('{question}', question)
    .replace('{gold}', goldAnswer)
    .replace('{pred}', pred && pred.trim() ? pred.trim() : '（空）');
}

/** 稳健解析：优先取 JSON，退化到 "score": n / 数字 */
function parseJudgeOutput(text) {
  const s = String(text || '');
  const jsonMatch = s.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const j = JSON.parse(jsonMatch[0]);
      const sc = Number(j.score);
      if (sc === 0 || sc === 1 || sc === 2) return { score: sc, reason: String(j.reason || '').slice(0, 120), parsed: 'json' };
    } catch { /* 落到正则 */ }
  }
  const m = s.match(/"?score"?\s*[:：]\s*([012])/i) || s.match(/\b([012])\b/);
  if (m) return { score: Number(m[1]), reason: '', parsed: 'regex' };
  return { score: null, reason: '解析失败', parsed: 'failed' };
}

/**
 * 选择评分样本：每条 query × 臂取一个 sample（默认 sampleIdx=0），保证配对。
 * @returns {Array<{queryId, arm, sampleIdx, question, goldAnswer, pred, tokenF1}>}
 */
function selectJudgeItems({ responses, queries, sampleIdx = 0 }) {
  const qById = new Map(queries.map((q) => [q.queryId, q]));
  const items = [];
  for (const r of responses) {
    if (r.sampleIdx !== sampleIdx) continue;
    if (r.tokenF1 === null || r.tokenF1 === undefined) continue;
    const q = qById.get(r.queryId);
    if (!q) continue;
    items.push({ queryId: r.queryId, arm: r.arm, sampleIdx: r.sampleIdx, question: q.queryText, goldAnswer: q.goldAnswer, pred: r.pred ?? '', tokenF1: r.tokenF1 });
  }
  return items;
}

/** 二次重判抽样：按 (queryId,arm) 顺序的确定性抽样 */
function pickRejudge(items, rate, seed) {
  const rand = mulberry32(seed >>> 0);
  const out = [];
  for (const it of items) {
    if (rand() < rate) out.push(it);
  }
  return out;
}

function summarizeJudge(rows) {
  const byArm = {};
  for (const r of rows) {
    byArm[r.arm] = byArm[r.arm] || { n: 0, sum: 0, dist: { 0: 0, 1: 0, 2: 0 }, f1: [] };
    if (r.score === null) continue;
    byArm[r.arm].n += 1;
    byArm[r.arm].sum += r.score;
    byArm[r.arm].dist[r.score] += 1;
    byArm[r.arm].f1.push(r.tokenF1);
  }
  for (const a of Object.keys(byArm)) {
    const v = byArm[a];
    byArm[a].meanScore = v.n ? v.sum / v.n : null; // 0..2
    byArm[a].meanScoreNorm = v.n ? v.sum / (2 * v.n) : null; // 0..1
    byArm[a].meanF1 = v.f1.length ? v.f1.reduce((x, y) => x + y, 0) / v.f1.length : null;
    delete byArm[a].sum;
    delete byArm[a].f1;
  }
  return byArm;
}

function argGet(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function run() {
  const configPath = argGet('config', 'configs/rag-eval-config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const evalDir = argGet('eval-dir', 'data/stage1/eval');
  const outDir = argGet('out', path.join(evalDir, 'judge'));
  const sampleIdx = Number(argGet('sample-idx', '0'));
  const concurrency = Number(argGet('concurrency', '6'));
  const rejudgeRate = Number(argGet('rejudge-rate', String(cfg.judge.sampleRateForHumanCalibration || 0.1)));
  const limit = Number(argGet('limit', '0'));

  const responses = fs.readFileSync(path.join(evalDir, 'responses.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const queries = JSON.parse(fs.readFileSync(cfg.evalSet.file, 'utf8'));
  let items = selectJudgeItems({ responses, queries, sampleIdx });
  if (limit > 0) items = items.slice(0, limit);
  console.log(`[L3] 待评 ${items.length} 条（sampleIdx=${sampleIdx}）`);

  fs.mkdirSync(outDir, { recursive: true });
  const judgePath = path.join(outDir, 'judge.jsonl');
  const done = new Set(fs.existsSync(judgePath)
    ? fs.readFileSync(judgePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => `${r.queryId}|${r.arm}|${r.pass}`)
    : []);

  const llm = createLlmClient({ ...cfg.judge, ...cfg.generator, model: cfg.judge.model || cfg.generator.model });
  if (!llm.configured) throw new Error('judge 未配置：需要 cfg.judge.model 与 DASHSCOPE_API_KEY');

  const fh = fs.openSync(judgePath, 'a');
  const pending = [];
  for (const it of items) {
    for (const pass of [1, 2]) {
      if (pass === 2 && !pickRejudge([it], rejudgeRate, hashSeed(it.queryId + it.arm)).length) continue;
      const key = `${it.queryId}|${it.arm}|${pass}`;
      if (done.has(key)) continue;
      pending.push({ ...it, pass, key });
    }
  }
  console.log(`[L3] 待调用 ${pending.length}（含 ${rejudgeRate * 100}% 二次重判）`);

  let idx = 0;
  let finished = 0;
  async function worker() {
    while (idx < pending.length) {
      const it = pending[idx++];
      let rec;
      if (!String(it.pred || '').trim()) {
        rec = { ...it, score: 0, reason: '空答案（程序判定，不调用模型）', parsed: 'empty', latencyMs: 0 };
      } else {
        try {
          const res = await llm.complete(buildJudgePrompt(it));
          const p = parseJudgeOutput(res.text);
          rec = { ...it, score: p.score, reason: p.reason, parsed: p.parsed, raw: res.text.slice(0, 200), latencyMs: res.latencyMs };
        } catch (e) {
          rec = { ...it, score: null, reason: String(e.message || e), parsed: 'error', latencyMs: null };
        }
      }
      delete rec.key;
      fs.writeSync(fh, JSON.stringify(rec) + '\n');
      finished += 1;
      if (finished % 25 === 0 || finished === pending.length) process.stdout.write(`\r[L3] ${finished}/${pending.length}   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, worker));
  process.stdout.write('\n');
  fs.closeSync(fh);

  const all = fs.readFileSync(judgePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const firstPass = all.filter((r) => r.pass === 1);
  const second = all.filter((r) => r.pass === 2);
  const byArm = summarizeJudge(firstPass);
  const agree = second.map((r) => {
    const f = all.find((x) => x.pass === 1 && x.queryId === r.queryId && x.arm === r.arm);
    return f && f.score !== null && r.score !== null ? Math.abs(f.score - r.score) : null;
  }).filter((v) => v !== null);
  const agreement = {
    n: agree.length,
    exactAgreement: agree.length ? agree.filter((d) => d === 0).length / agree.length : null,
    within1Agreement: agree.length ? agree.filter((d) => d <= 1).length / agree.length : null,
    meanAbsDiff: agree.length ? agree.reduce((a, b) => a + b, 0) / agree.length : null,
  };

  const summary = {
    stage: 'stage1-eval-judge',
    generatedAt: new Date().toISOString(),
    judgeModel: cfg.judge.model || cfg.generator.model,
    rubricSha256: RUBRIC_SHA256,
    judgePromptSha256: JUDGE_PROMPT_SHA256,
    sampleIdx,
    nItems: firstPass.length,
    arms: byArm,
    rejudgeAgreement: agreement,
    minRejudgeAgreement: cfg.judge.minRejudgeAgreement,
    l3Usable: agreement.exactAgreement === null ? false : agreement.exactAgreement >= (cfg.judge.minRejudgeAgreement ?? 0.9),
    notes: [
      'judge 盲评：输入不含臂名与上下文。',
      '空答案由程序判 0，未调用模型。',
      'judge 与生成器同模型，存在自评偏好；须靠人工校准（κ）兜底，不能只报重判一致率。',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'judge-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[L3] 各臂 judge 均分(0-2)：` + Object.entries(byArm).map(([a, v]) => `${a}=${v.meanScore?.toFixed(3)}`).join('  '));
  console.log(`[L3] 重判一致率 ${agreement.exactAgreement?.toFixed(3)}（n=${agreement.n}，阈值 ${cfg.judge.minRejudgeAgreement}）`);

  // 人工校准表：盲评版（无臂名、无机器分）+ 密钥文件；κ 的算法与闸门见 src/stage1/calibration.js
  writeCalibrationSheet({ all: firstPass, queries, outDir, rate: cfg.judge.sampleRateForHumanCalibration ?? 0.25 });
}

function writeCalibrationSheet({ all, queries, outDir, rate }) {
  const { writeCalibration } = require('./calibration');
  const { blindPath, keyPath, stats } = writeCalibration({
    judgeRows: all, queries, outDir, rate, enrichPerClass: 0, seed: 20261112,
  });
  console.log(`[L3] 人工校准盲评表 ${stats.selected} 条 → ${blindPath}（密钥 ${keyPath}）`);
  console.log('[L3] 表中不含臂名与机器分；填完后用 `node src/stage1/calibration.js --score` 算 κ');
}

function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

module.exports = { RUBRIC_TEXT, RUBRIC_SHA256, JUDGE_PROMPT_TEMPLATE, JUDGE_PROMPT_SHA256, buildJudgePrompt, parseJudgeOutput, selectJudgeItems, pickRejudge, summarizeJudge, run };
if (require.main === module) run().catch((e) => { console.error('[L3][FAIL]', e); process.exitCode = 1; });
