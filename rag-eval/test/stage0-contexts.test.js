'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildArtifacts, buildArmContexts, buildPrompt, PROMPT_TEMPLATE, PROMPT_TEMPLATE_SHA256 } = require('../src/stage0/contexts');

/** 构造 30 道互不相似的合成题（避免 doc 簇把候选池吞掉） */
function synthDocs(n = 30) {
  const topics = ['行程', '工程', '浓度', '几何', '数论', '计数', '概率', '方程'];
  const docs = [];
  for (let i = 0; i < n; i++) {
    const t = topics[i % topics.length];
    docs.push({
      docId: `xes-q${i}`,
      kcId: `拓展思维>${t}模块`,
      text: `${t}第${i}题：某个量是${i * 7 + 3}，另一个量比它多${i + 1}，求两量之和（题号${i}，关键词${t}${i}）。\n解析：结果为${i * 8 + 4}（题号${i}）。`,
    });
  }
  return docs;
}

test('buildArmContexts: N 空、R 非空、O 含 gold 解析、X 等长且簇不相交', () => {
  const docs = synthDocs();
  const art = buildArtifacts(docs, { chunkSize: 300, chunkOverlap: 40 });
  const gold = docs.find((d) => d.docId === 'xes-q4');
  const q = { queryId: 'q-xes-4', queryText: '第四个几何题的答案是多少？关键词几何4', oracleDocId: 'xes-q4', goldAnswer: '36' };
  const arms = buildArmContexts(q, art, { topK: 5, configSeed: 'test' });

  assert.strictEqual(arms.N.text, '');
  assert.strictEqual(arms.N.chars, 0);
  assert.ok(arms.R.chars > 0);
  assert.ok(arms.O.text.includes('解析'));
  assert.ok(arms.O.docIds.includes(gold.docId));
  assert.strictEqual(arms.O.text, gold.text); // 单块 doc：O = 该 doc 全文

  const rClusters = new Set(arms.R.clusterIds);
  assert.ok(arms.X.clusterIds.every((c) => !rClusters.has(c)), 'X 簇与 R 簇必须无交集');
  const ratio = Math.abs(arms.X.chars - arms.R.chars) / arms.R.chars;
  assert.ok(ratio <= 0.02 + 1e-9, `X 与 R 长度差 ${(ratio * 100).toFixed(2)}% 超过 2%`);
});

test('buildArmContexts: 确定性（同 seed 逐字符一致）', () => {
  const art = buildArtifacts(synthDocs());
  const q = { queryId: 'q-xes-7', queryText: '第七题求两量之和', oracleDocId: 'xes-q7', goldAnswer: '60' };
  const a = buildArmContexts(q, art, { configSeed: 'seed-A' });
  const b = buildArmContexts(q, art, { configSeed: 'seed-A' });
  assert.strictEqual(a.X.text, b.X.text);
  assert.deepStrictEqual(a.R.chunkIds, b.R.chunkIds);
});

test('buildArmContexts: 检索全零分时显式报错（不静默给空上下文）', () => {
  const art = buildArtifacts(synthDocs());
  const q = { queryId: 'q-xes-1', queryText: 'zzzz-qqqq-xxxx', oracleDocId: 'xes-q1', goldAnswer: '1' };
  assert.throws(() => buildArmContexts(q, art, {}), /检索无命中/);
});

test('buildArmContexts: oracle doc 不存在时报错', () => {
  const art = buildArtifacts(synthDocs());
  const q = { queryId: 'q-xes-1', queryText: '第一题', oracleDocId: 'xes-q999', goldAnswer: '1' };
  assert.throws(() => buildArmContexts(q, art, {}), /oracle doc/);
});

test('buildPrompt: 四臂只有 context 槽位不同，模板 sha 稳定', () => {
  const q = '题目文本';
  assert.ok(buildPrompt('', q).includes('参考资料：\n\n'));
  assert.ok(buildPrompt('上下文A', q).includes('上下文A'));
  assert.strictEqual(PROMPT_TEMPLATE.split('{context}').length, 2, '模板应只有一个 context 槽位');
  assert.match(PROMPT_TEMPLATE_SHA256, /^sha256:[0-9a-f]{64}$/);
});

test('buildArmContexts: excludeSelfDoc 时 R 不含 gold doc（leave-one-out）', () => {
  const docs = synthDocs();
  const art = buildArtifacts(docs);
  const q = { queryId: 'q-xes-4', queryText: '几何第4题 关键词几何4', oracleDocId: 'xes-q4', goldAnswer: '36' };
  const normal = buildArmContexts(q, art, {});
  assert.strictEqual(normal.diag.goldDocInR, true);
  const loo = buildArmContexts(q, art, { excludeSelfDoc: true });
  assert.strictEqual(loo.diag.goldDocInR, false);
  assert.ok(!loo.R.docIds.includes('xes-q4'));
  assert.strictEqual(loo.diag.excludeSelfDoc, true);
  assert.ok(loo.R.chars > 0);
  // X 仍需与 R 簇无交集且长度匹配
  const rc = new Set(loo.R.clusterIds);
  assert.ok(loo.X.clusterIds.every((c) => !rc.has(c)));
});
