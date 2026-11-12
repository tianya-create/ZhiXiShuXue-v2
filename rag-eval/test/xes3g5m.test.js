'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { detectMode, docTextOf, kcIdOf, answerProbeOf, loadXes3g5mCorpus } = require('../src/corpus/xes3g5m');

test('detectMode：官方 questions.json（analysis 字段）→ full', () => {
  assert.equal(detectMode({ '0': { content: 'x', analysis: 'y', type: '填空' } }), 'full');
  assert.equal(detectMode({ '0': { content: 'x', kc: '计数', difficulty: 'easy' } }), 'subset');
  assert.throws(() => detectMode({ '0': { content: 'x' } }), /无法识别/);
});

test('docTextOf full：options 为 dict、解析拼接、图片占位符改写', () => {
  const q = {
    content: '看图答题 question_2210-image_0',
    options: { A: '$$25$$', B: '$$24$$' },
    analysis: '由图 analysis_2210-image_0 可知',
  };
  const text = docTextOf(q, 'full');
  assert.ok(text.includes('选项：A. $$25$$ B. $$24$$'));
  assert.ok(text.includes('解析：'));
  assert.ok(text.includes('[图:question-2210-0]'));
  assert.ok(!text.includes('question_2210-image_0'));
});

test('docTextOf full：填空题 options 为空 dict 时不输出选项段', () => {
  const text = docTextOf({ content: '求周长', options: {}, analysis: 'C=2πr' }, 'full');
  assert.ok(!text.includes('选项'));
  assert.ok(text.startsWith('求周长'));
});

test('docTextOf full：不含答案字段（答案属于评测侧）', () => {
  const text = docTextOf({ content: 'x', answer: ['$$24$$'], analysis: 'y', options: {} }, 'full');
  assert.ok(!text.includes('24')); // 答案绝不进语料
});

test('kcIdOf：官方 kc_routes 为 "A----B----C" 字符串列表，取顶层模块', () => {
  assert.equal(kcIdOf({ kc_routes: ['拓展思维----计数模块----加乘原理'] }, 'full'), '拓展思维');
  assert.equal(kcIdOf({ kc_routes: ['几何模块----直线型----三角形'] }, 'full'), '几何模块');
  assert.equal(kcIdOf({ kc: '一笔画判断' }, 'subset'), '一笔画判断');
  assert.equal(kcIdOf({ kc_routes: [] }, 'full'), '');
});

test('answerProbeOf：list 拼接并剥 $$ 定界', () => {
  assert.equal(answerProbeOf({ answer: ['$$24$$'] }), '24');
  assert.equal(answerProbeOf({ answer: ['$$<$$', '$$=$$'] }), '< =');
  assert.equal(answerProbeOf({ answer: [] }), '');
});

test('loadXes3g5mCorpus：短 content / 空 kc 剔除且计入 dropped，不静默', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(os.tmpdir(), `xes3g5m-test-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    '1': { content: '学校有四种兴趣班，一共有几种报名方法', kc_routes: ['拓展思维----计数模块'], analysis: '4×3×2', type: '填空', options: {}, answer: ['$$24$$'] },
    '2': { content: '太短', kc_routes: ['拓展思维----计数模块'], analysis: 'x', type: '填空', options: {}, answer: ['$$1$$'] },
    '3': { content: '没有知识点路由的一题', kc_routes: [], analysis: 'x', type: '填空', options: {}, answer: ['$$2$$'] },
  }));
  try {
    const corpus = loadXes3g5mCorpus({ questionsPath: tmp });
    assert.equal(corpus.mode, 'full');
    assert.equal(corpus.docs.length, 1);
    assert.equal(corpus.dropped.length, 2);
    assert.deepEqual(corpus.dropped.map((d) => d.qid).sort(), ['2', '3']);
    assert.equal(corpus.docs[0].docId, 'xes-q1');
    assert.ok(corpus.docs[0].text.includes('解析：4×3×2'));
  } finally {
    fs.unlinkSync(tmp);
  }
});
