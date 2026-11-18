#!/usr/bin/env node
/** 一次性脚本：生成先修边人工核验工作表（方案 §2.4） */
'use strict';
const fs = require('fs');
const path = require('path');
const { buildNameMap, parseEdgeLine } = require('./buildPriorEdges.js');

const backend = process.cwd();
if (!backend.endsWith('backend')) process.chdir(path.join(__dirname, '..'));

const skillNames = JSON.parse(fs.readFileSync('datasets/assist2009/skill-names.json', 'utf8'));
const kpList = JSON.parse(fs.readFileSync('实验结果文件/gcn-dkt-v1/seed-42/vocabulary.json', 'utf8')).kpList;
const { usableNames } = buildNameMap(skillNames, kpList);
const runFiles = ['run1.csv', 'run2.csv', 'run3.csv'];
const runEdges = runFiles.map((f) => fs.readFileSync(path.join('datasets/assist2009/prior-extraction', f), 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean).map((l) => parseEdgeLine(l, usableNames)));
const tally = new Map();
runEdges.forEach((run, ri) => {
  const seen = new Set();
  for (const e of run) {
    const k = `${e.sourceName}\u0000${e.targetName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!tally.has(k)) tally.set(k, []);
    tally.get(k).push({ ...e, run: ri + 1 });
  }
});
const kept = [];
const once = [];
for (const [k, occ] of tally) {
  const [s, t] = k.split('\u0000');
  if (occ.length >= 2) kept.push({ s, t, conf: occ.map((o) => o.confidence), votes: occ.length, reason: occ[0].reason });
  else once.push({ s, t, runs: occ.map((o) => o.run), reason: occ[0].reason });
}
kept.sort((a, b) => a.s.localeCompare(b.s) || a.t.localeCompare(b.t));
const cand = kept.filter((_, i) => i % 2 === 0).slice(0, 40);
once.sort((a, b) => a.s.localeCompare(b.s) || a.t.localeCompare(b.t));
const rej = once.filter((_, i) => i % 2 === 0).slice(0, 40);
const clean = (r) => r.replace(/\|/g, '/');
let md = '# 先修边人工核验工作表（方案 §2.4）\n\n';
md += '核验日期：____ ｜ 核验人：____（按教材目录/课标独立判对错，勿参照 reason 列）\n\n';
md += '判定标准：source → target 语义为「掌握 target 之前应先掌握 source」。对 = 该教学顺序成立；错 = 不成立/反向/无关系。\n\n';
md += '## A. 候选边（入选 prior-edges.csv）40 条 —— 报 precision\n\n';
md += '| # | source | target | conf | votes | 对/错 |\n|---|---|---|---|---|---|\n';
cand.forEach((e, i) => { md += `| ${i + 1} | ${clean(e.s)} | ${clean(e.t)} | ${e.conf} | ${e.votes} | |\n`; });
md += '\n## B. 被投票规则否决的边（仅 1/3 次出现）40 条 —— 检验规则是否误杀\n\n';
md += '| # | source | target | 出现轮次 | 对/错 |\n|---|---|---|---|---|\n';
rej.forEach((e, i) => { md += `| ${i + 1} | ${clean(e.s)} | ${clean(e.t)} | ${e.runs.join('/')} | |\n`; });
md += '\n> 通过线：A 组 precision ≥ 0.75，且第二核验人（同学/数学老师，标其中 50 条）κ ≥ 0.60。\n';
md += '> 不达标 → 改一次 prompt 重跑三次抽取；仍不达标 → 判定「先修关系不适合 LLM 抽取」，直接进终止分支。\n';
fs.writeFileSync('实验结果文件/prior-probe-v1/human-verification-sheet.md', md);
console.log(`sheet written: A=${cand.length} B=${rej.length} (kept=${kept.length}, once=${once.length})`);
