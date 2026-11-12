'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeAnswer, tokenize, f1Of, exactMatch, extractFinalAnswer, scoreRecord } = require('../src/metrics/answerScore');

test('normalizeAnswer: 剥 LaTeX 定界符、空白与标点', () => {
  assert.strictEqual(normalizeAnswer('$$25$$'), '25');
  assert.strictEqual(normalizeAnswer(' 3.5 米 '), '3.5米');
  assert.strictEqual(normalizeAnswer('\\frac{1}{2}'), 'frac12');
  assert.strictEqual(normalizeAnswer('答案：９９。'), '答案99');
});

test('tokenize: CJK 逐字、数字整体、小数不拆', () => {
  assert.deepStrictEqual(tokenize('小明有3.5个'), ['小', '明', '有', '3.5', '个']);
  assert.deepStrictEqual(tokenize('abc123'), ['abc', '123']);
});

test('f1Of: 完全相同为 1，部分重叠介于 0-1，全错为 0', () => {
  assert.strictEqual(f1Of('99', '99'), 1);
  assert.strictEqual(f1Of('$$99$$', '99'), 1);
  assert.strictEqual(f1Of('100', '99'), 0);
  const partial = f1Of('99米', '99');
  assert.ok(partial > 0 && partial < 1);
});

test('f1Of: 双方为空视为 1，单方为空为 0', () => {
  assert.strictEqual(f1Of('', ''), 1);
  assert.strictEqual(f1Of('', '5'), 0);
  assert.strictEqual(f1Of('5', ''), 0);
});

test('exactMatch: 归一化后相等', () => {
  assert.strictEqual(exactMatch('$$25$$', '25'), 1);
  assert.strictEqual(exactMatch('25。', '25'), 1);
  assert.strictEqual(exactMatch('26', '25'), 0);
});

test('extractFinalAnswer: 取最后一行、剥离「答案：」前缀', () => {
  assert.strictEqual(extractFinalAnswer('先算减法\n答案是 91'), '91');
  assert.strictEqual(extractFinalAnswer('最终答案：12。'), '12');
  assert.strictEqual(extractFinalAnswer('  \n\n'), '');
});

test('scoreRecord: 多行输出只评最后一行', () => {
  const r = scoreRecord({ output: '因为 3580-1600=1980\n1980÷20=99\n99', goldAnswer: '99' });
  assert.strictEqual(r.pred, '99');
  assert.strictEqual(r.tokenF1, 1);
  assert.strictEqual(r.exactMatch, 1);
});

test('scoreRecord: thinking 内容混入正文时不误判（取末行答数）', () => {
  const r = scoreRecord({ output: '思考：20分钟……\n最终答案：99', goldAnswer: '99' });
  assert.strictEqual(r.tokenF1, 1);
});
