/**
 * 人类分敏感性重算：把 R/X 两臂的分数换成人工分，重算 ΔREL，看符号是否翻转。
 *
 * 为什么单独一个脚本（而不是塞进 calibration.js）：
 *  - κ 回答「judge 与人对不对得上」，本脚本回答「对不上会不会改写结论」；两件事的
 *    输入都是盲表，但输出服务于不同闸门（前者定 L3 能不能用，后者定 ΔREL 要不要换尺子）。
 *  - 护栏触发条件写在 config（|bias(R)−bias(X)| ≥ 0.25）里；未触发时本脚本是**可选的
 *    稳健性展示**，触发时才是必跑的敏感性检验。无论哪种，数字都必须可复现，
 *    不能只留一句「手算过」。
 *
 * 纪律：
 *  1. 只在**主样本**（非富集）上重算——富集样本是按 judge 分抽的，混进来会重复计入
 *     中间档，把人类分的高估/低估放大成伪信号。
 *  2. ΔREL 用与主流程同一口径：先 /2 归一到 0–1，再取 R−X。
 *  3. CI 以 queryId 为簇自助——同一题的四臂响应不独立，按条重采会把 CI 压窄。
 *  4. 子样本只有 25% 抽样，CI 天然宽；本脚本的职责是「符号与量级是否对得上」，
 *     不是复现全量 11.9pp。结论里必须写明这一点，避免把宽 CI 误读成结论不稳。
 */
'use strict';

const fs = require('fs');
const { mulberry32, ciPreciseOf, round4 } = require('../stats/core');
const { parseCsv } = require('./calibration');

const ARMS = ['N', 'X', 'R', 'O'];

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 主样本记录：{queryId, arm, human, judge}，非法分与非主样本单独计数 */
function collectPairs(sheetCsv, keyRows) {
  const key = new Map();
  for (const k of keyRows) key.set(k.itemId, k);
  const rows = parseCsv(sheetCsv);
  const recs = [];
  let missing = 0;
  let invalid = 0;
  let enriched = 0;
  let unknown = 0;
  for (const r of rows) {
    const id = String(r.itemId || '').trim();
    if (!id) continue;
    const k = key.get(id);
    if (!k) { unknown++; continue; }
    const raw = String(r.humanScore === undefined ? '' : r.humanScore).trim();
    if (raw === '') { missing++; continue; }
    if (!/^[0-2]$/.test(raw)) { invalid++; continue; }
    if (k.enriched) { enriched++; continue; }
    recs.push({ queryId: k.queryId, arm: k.arm, human: Number(raw), judge: Number(k.judgeScore) });
  }
  return { recs, missing, invalid, enriched, unknown };
}

function armMeans(recs, field) {
  const acc = new Map();
  for (const r of recs) {
    if (!acc.has(r.arm)) acc.set(r.arm, { sum: 0, n: 0 });
    const a = acc.get(r.arm);
    a.sum += r[field];
    a.n += 1;
  }
  const out = {};
  for (const arm of ARMS) {
    const a = acc.get(arm);
    out[arm] = a && a.n ? { mean: a.sum / a.n / 2, n: a.n } : { mean: null, n: 0 };
  }
  return out;
}

function deltaRel(means) {
  if (!means.R || !means.X || means.R.mean === null || means.X.mean === null) return null;
  return means.R.mean - means.X.mean;
}

/** 以 queryId 为簇自助重采，返回 ΔREL 的未舍入 CI */
function bootstrapDelta(recs, field, { reps = 4000, seed = 20261112 } = {}) {
  const clusters = new Map();
  for (const r of recs) {
    if (!clusters.has(r.queryId)) clusters.set(r.queryId, []);
    clusters.get(r.queryId).push(r);
  }
  const keys = [...clusters.keys()];
  if (keys.length < 2) return { ci95: [null, null], reps, nClusters: keys.length };
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < reps; i++) {
    const sample = [];
    for (let j = 0; j < keys.length; j++) {
      const pick = keys[Math.floor(rand() * keys.length)];
      sample.push(...clusters.get(pick));
    }
    const d = deltaRel(armMeans(sample, field));
    if (d !== null) out.push(d);
  }
  out.sort((a, b) => a - b);
  return { ci95: ciPreciseOf(out), reps, nClusters: keys.length };
}

function analyze({ sheetCsv, keyRows, reps = 4000, seed = 20261112 }) {
  const { recs, missing, invalid, enriched, unknown } = collectPairs(sheetCsv, keyRows);
  const human = armMeans(recs, 'human');
  const judge = armMeans(recs, 'judge');
  const dHuman = deltaRel(human);
  const dJudge = deltaRel(judge);
  const bHuman = bootstrapDelta(recs, 'human', { reps, seed });
  const bJudge = bootstrapDelta(recs, 'judge', { reps, seed });
  const bias = {};
  for (const arm of ARMS) {
    bias[arm] = human[arm].mean === null || judge[arm].mean === null
      ? null
      : round4(judge[arm].mean - human[arm].mean);
  }
  const signFlip = dHuman === null || dJudge === null
    ? null
    : (dHuman > 0) !== (dJudge > 0);
  return {
    generatedAt: new Date().toISOString(),
    n: { rated: recs.length, missing, invalid, enriched, unknown },
    unit: '0-1（原始 0/1/2 除以 2）',
    means: { human, judge },
    deltaRel: {
      human: round4(dHuman),
      judge: round4(dJudge),
      diff: dHuman !== null && dJudge !== null ? round4(dHuman - dJudge) : null,
      humanCI95: bHuman.ci95.map(round4),
      judgeCI95: bJudge.ci95.map(round4),
      nClusters: bHuman.nClusters,
      reps,
      signConsistent: signFlip === null ? null : !signFlip,
      note: '子样本为 25% 随机抽样，CI 天然宽；本表只判「符号与量级是否对得上」，不复现全量估计'
    },
    perArmBias: bias,
    perArmBiasNote: 'judge − human，正数=judge 更宽松'
  };
}

function f(x) { return Number.isFinite(x) ? x.toFixed(4) : 'NA'; }

function argGet(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  const judgeDir = argGet('judge-dir', 'data/stage1/eval/judge');
  const sheet = argGet('sheet', `${judgeDir}/human-calibration-blind.v1-raw.csv`);
  const keyPath = argGet('key', `${judgeDir}/human-calibration-key.jsonl`);
  const rep = analyze({
    sheetCsv: fs.readFileSync(sheet, 'utf8'),
    keyRows: readJsonl(keyPath),
    reps: Number(argGet('reps', '4000')),
    seed: Number(argGet('seed', '20261112'))
  });
  const outPath = argGet('out', `${judgeDir}/bias-sensitivity.json`);
  fs.writeFileSync(outPath, JSON.stringify(rep, null, 2));

  console.log(`[敏感] 主样本 ${rep.n.rated} 条（缺填 ${rep.n.missing}，非法 ${rep.n.invalid}，富集另计 ${rep.n.enriched}）`);
  const line = (arm) => `  ${arm}: human=${f(rep.means.human[arm].mean)} judge=${f(rep.means.judge[arm].mean)} bias=${f(rep.perArmBias[arm])} (n=${rep.means.human[arm].n})`;
  ARMS.forEach((a) => console.log(line(a)));
  console.log(`[敏感] ΔREL 人类分=${f(rep.deltaRel.human)} [${rep.deltaRel.humanCI95.map(f).join(', ')}]`);
  console.log(`[敏感] ΔREL judge =${f(rep.deltaRel.judge)} [${rep.deltaRel.judgeCI95.map(f).join(', ')}]`);
  console.log(`[敏感] 符号一致：${rep.deltaRel.signConsistent}（差 ${f(rep.deltaRel.diff)}；簇 ${rep.deltaRel.nClusters}，B=${rep.deltaRel.reps}）`);
  console.log(`[敏感] 报告 ${outPath}`);
}

if (require.main === module) main();

module.exports = { analyze, collectPairs, armMeans, deltaRel, bootstrapDelta };
