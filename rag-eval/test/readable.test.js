'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toReadable, toReadableInline, extractImageRefs, needsImage } = require('../src/util/readable');

test('toReadable：去 $$ 定界符', () => {
  assert.strictEqual(toReadable('$$63$$只猫咪'), '63只猫咪');
  assert.strictEqual(toReadable('有$$15$$只'), '有15只');
});

test('toReadable：\\times \\div \\cdot 转 unicode', () => {
  assert.strictEqual(toReadable('计算：$$46\\times 99$$'), '计算：46×99');
  assert.strictEqual(toReadable('$$100\\div 50=2$$'), '100÷50=2');
  assert.strictEqual(toReadable('$$3\\cdot 4$$'), '3·4');
});

test('toReadable：分式与根号', () => {
  assert.strictEqual(toReadable('$$\\dfrac{1}{2}$$'), '1/2');
  assert.strictEqual(toReadable('$$\\frac{3}{4}$$'), '3/4');
  assert.strictEqual(toReadable('$$\\sqrt{9}$$'), '√(9)');
});

test('toReadable：上标与度数', () => {
  assert.strictEqual(toReadable('$$x^2$$'), 'x²');
  assert.strictEqual(toReadable('$$3^{2}$$'), '3²');
  assert.ok(toReadable('$$90^{\\circ}$$').includes('°'));
});

test('toReadable：\\text{} 与 \\left( \\right)', () => {
  assert.strictEqual(toReadable('$$\\left(100-8\\right)\\times 25$$'), '(100-8)×25');
  assert.strictEqual(toReadable('$$5\\text{厘米}$$'), '5厘米');
});

test('toReadable：图片占位符按出现顺序编号，且不残留内部文件名', () => {
  const t = toReadable('如图所示，图中数字表示面积． question_3124-image_0 问号处是？');
  assert.ok(t.includes('【图1】'));
  assert.ok(!t.includes('question_3124-image_0'), '内部文件名不应残留');
  assert.ok(!t.includes('$$'));
});

test('toReadable：多个图片按顺序编号', () => {
  const t = toReadable('前 question_1-image_0 中 analysis_2-image_1 后');
  assert.ok(t.includes('【图1】'));
  assert.ok(t.includes('【图2】'));
});

test('extractImageRefs：去重保序并给出真实文件名', () => {
  const refs = extractImageRefs('a question_3124-image_0 b question_3124-image_0 c analysis_9-image_2');
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0].file, 'question_3124-image_0.png');
  assert.strictEqual(refs[1].origin, 'analysis');
});

test('needsImage：引用图片或含图提示词都算', () => {
  assert.strictEqual(needsImage('question_3124-image_0'), true);
  assert.strictEqual(needsImage('如下图所示，求阴影面积'), true);
  assert.strictEqual(needsImage('计算 46×99'), false);
});

test('toReadableInline：换行折叠为空格（CSV 单元格安全）', () => {
  const t = toReadableInline('第一行\n第二行');
  assert.strictEqual(t, '第一行 第二行');
});

test('toReadable 不破坏普通数字与中文', () => {
  assert.strictEqual(toReadable('小明的身高是 1.5 米，体重 40 千克。'), '小明的身高是 1.5 米，体重 40 千克。');
});

test('toReadable：未知命令不残留反斜杠', () => {
  const t = toReadable('$$\\unknowncmd 5$$');
  assert.ok(!t.includes('\\'), `不应残留反斜杠：${t}`);
  assert.ok(t.includes('5'));
});

test('toReadable：题面中的「如图」但无文件引用 → 保留原句可读', () => {
  const t = toReadable('下图的九个方格中已填入四个数');
  assert.strictEqual(t, '下图的九个方格中已填入四个数');
});
