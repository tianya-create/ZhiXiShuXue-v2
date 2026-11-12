'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseJudgeOutput, buildJudgePrompt, selectJudgeItems, pickRejudge, summarizeJudge, RUBRIC_SHA256, JUDGE_PROMPT_SHA256 } = require('../src/stage1/judge');

test('parseJudgeOutput: 标准 JSON', () => {
  assert.deepStrictEqual(parseJudgeOutput('{"score": 2, "reason": "等价"}'), { score: 2, reason: '等价', parsed: 'json' });
});

test('parseJudgeOutput: 带解释文字包裹的 JSON', () => {
  const r = parseJudgeOutput('评分结果如下：\n{"score":1,"reason":"部分正确"}\n完毕');
  assert.strictEqual(r.score, 1);
});

test('parseJudgeOutput: 非法 JSON 退化为正则', () => {
  assert.strictEqual(parseJudgeOutput('score: 0').score, 0);
  assert.strictEqual(parseJudgeOutput('我给 2 分').score, 2);
});

test('parseJudgeOutput: 完全无法解析时 score=null（不冒充 0 分）', () => {
  const r = parseJudgeOutput('答案正确');
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.parsed, 'failed');
});

test('parseJudgeOutput: 越界分数不采信', () => {
  assert.strictEqual(parseJudgeOutput('{"score": 3}').score, null);
});

test('buildJudgePrompt: 包含题目/参考答案/待评答案，空答案显式标注', () => {
  const p = buildJudgePrompt({ question: '1+1=?', goldAnswer: '2', pred: '' });
  assert.ok(p.includes('1+1=?'));
  assert.ok(p.includes('（空）'));
  assert.ok(!p.includes('R 臂'), 'judge prompt 不得泄露臂名');
});

test('rubric 与 prompt 的 sha 稳定', () => {
  assert.match(RUBRIC_SHA256, /^sha256:[0-9a-f]{64}$/);
  assert.match(JUDGE_PROMPT_SHA256, /^sha256:[0-9a-f]{64}$/);
});

test('selectJudgeItems: 只取指定 sampleIdx，且跳过失败记录', () => {
  const queries = [{ queryId: 'q1', queryText: 'Q1', goldAnswer: '1' }, { queryId: 'q2', queryText: 'Q2', goldAnswer: '2' }];
  const responses = [
    { queryId: 'q1', arm: 'R', sampleIdx: 0, tokenF1: 1, pred: '1' },
    { queryId: 'q1', arm: 'R', sampleIdx: 1, tokenF1: 1, pred: '1' },
    { queryId: 'q2', arm: 'R', sampleIdx: 0, tokenF1: null, pred: null },
    { queryId: 'q1', arm: 'X', sampleIdx: 0, tokenF1: 0, pred: '9' },
  ];
  const items = selectJudgeItems({ responses, queries, sampleIdx: 0 });
  assert.deepStrictEqual(items.map((x) => `${x.queryId}|${x.arm}`), ['q1|R', 'q1|X']);
});

test('pickRejudge: 抽样比例近似、且确定性', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ queryId: `q${i}`, arm: 'R' }));
  const a = pickRejudge(items, 0.1, 42);
  const b = pickRejudge(items, 0.1, 42);
  assert.deepStrictEqual(a.map((x) => x.queryId), b.map((x) => x.queryId));
  assert.ok(a.length > 25 && a.length < 75, `抽样数 ${a.length} 不在合理区间`);
});

test('summarizeJudge: 均分与归一化、跳过 null 分', () => {
  const rows = [
    { arm: 'R', score: 2, tokenF1: 1 }, { arm: 'R', score: 1, tokenF1: 0.5 }, { arm: 'R', score: null, tokenF1: 0 },
    { arm: 'X', score: 0, tokenF1: 0 }, { arm: 'X', score: 0, tokenF1: 0 },
  ];
  const s = summarizeJudge(rows);
  assert.strictEqual(s.R.n, 2);
  assert.strictEqual(s.R.meanScore, 1.5);
  assert.strictEqual(s.R.meanScoreNorm, 0.75);
  assert.strictEqual(s.X.meanScore, 0);
});
