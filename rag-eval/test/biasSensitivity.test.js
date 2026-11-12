'use strict';
/**
 * 人类分敏感性重算测试。
 * 重点钉四件事：① 归一化口径（0/1/2 → 0–1）与主流程一致；② ΔREL 方向正确；
 * ③ 富集样本必须排除（否则中间档重复计入）；④ 符号翻转能被识别。
 */
const test = require('node:test');
const assert = require('node:assert');
const { analyze, collectPairs, armMeans, deltaRel } = require('../src/stage1/biasSensitivity');

const key = (itemId, queryId, arm, judgeScore, enriched = false) => ({
  itemId, queryId, arm, judgeScore, enriched
});

function sheet(rows) {
  const head = 'itemId,question,goldAnswer,pred,humanScore,note';
  return [head].concat(rows.map((r) => `${r.id},q,g,p,${r.h},`)).join('\n');
}

test('collectPairs：缺填/非法/富集/未知 id 分别计数，且不混入主样本', () => {
  const keyRows = [
    key('a', 'q1', 'R', 2),
    key('b', 'q2', 'X', 0),
    key('c', 'q3', 'R', 1, true), // 富集
    key('d', 'q4', 'X', 2)
  ];
  const csv = sheet([
    { id: 'a', h: 2 },
    { id: 'b', h: '' },      // 缺填
    { id: 'c', h: 1 },       // 富集，应排除
    { id: 'zzz', h: 1 },     // 未知 id
    { id: 'd', h: 5 }        // 非法
  ]);
  const r = collectPairs(csv, keyRows);
  assert.strictEqual(r.recs.length, 1);
  assert.strictEqual(r.missing, 1);
  assert.strictEqual(r.invalid, 1);
  assert.strictEqual(r.enriched, 1);
  assert.strictEqual(r.unknown, 1);
  assert.deepStrictEqual(r.recs[0], { queryId: 'q1', arm: 'R', human: 2, judge: 2 });
});

test('armMeans：0/1/2 除以 2 归一到 0–1', () => {
  const recs = [
    { queryId: 'q1', arm: 'R', human: 2, judge: 1 },
    { queryId: 'q2', arm: 'R', human: 0, judge: 0 },
    { queryId: 'q3', arm: 'X', human: 1, judge: 1 }
  ];
  const m = armMeans(recs, 'human');
  assert.strictEqual(m.R.mean, 0.5);   // (2+0)/2 条 /2 归一共 0.5
  assert.strictEqual(m.X.mean, 0.5);   // 单条 1 分 → 0.5
  assert.strictEqual(m.N.n, 0);
  assert.strictEqual(m.N.mean, null);
});

test('deltaRel：R−X，缺臂返回 null', () => {
  const recs = [
    { queryId: 'q1', arm: 'R', human: 2, judge: 2 },
    { queryId: 'q2', arm: 'X', human: 0, judge: 0 }
  ];
  assert.strictEqual(deltaRel(armMeans(recs, 'human')), 1); // R=1.0, X=0
  assert.strictEqual(deltaRel(armMeans(recs.slice(0, 1), 'human')), null);
});

test('analyze：人类分与 judge 同号时 signConsistent=true，反向时 false', () => {
  const keyRows = [
    key('a', 'q1', 'R', 0), key('b', 'q2', 'R', 0),
    key('c', 'q3', 'X', 2), key('d', 'q4', 'X', 2)
  ];
  // 人类分：R 对、X 错 → 与 judge 反向
  const flipped = analyze({
    sheetCsv: sheet([{ id: 'a', h: 2 }, { id: 'b', h: 2 }, { id: 'c', h: 0 }, { id: 'd', h: 0 }]),
    keyRows, reps: 200, seed: 1
  });
  assert.strictEqual(flipped.deltaRel.human, 1);
  assert.strictEqual(flipped.deltaRel.judge, -1);
  assert.strictEqual(flipped.deltaRel.signConsistent, false);
  assert.strictEqual(flipped.deltaRel.nClusters, 4);

  // 人类分与 judge 一致 → 同号
  const same = analyze({
    sheetCsv: sheet([{ id: 'a', h: 0 }, { id: 'b', h: 0 }, { id: 'c', h: 2 }, { id: 'd', h: 2 }]),
    keyRows, reps: 200, seed: 1
  });
  assert.strictEqual(same.deltaRel.signConsistent, true);
});

test('analyze：bootstrap 以 queryId 为簇，簇数正确', () => {
  const keyRows = [key('a', 'q1', 'R', 2), key('b', 'q1', 'X', 0)];
  const rep = analyze({
    sheetCsv: sheet([{ id: 'a', h: 2 }, { id: 'b', h: 0 }]),
    keyRows, reps: 100, seed: 7
  });
  assert.strictEqual(rep.deltaRel.nClusters, 1);
  assert.deepStrictEqual(rep.deltaRel.humanCI95, [null, null]); // 单簇无法自助
  assert.strictEqual(rep.deltaRel.human, 1);
});
