'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReviewSheet } = require('../src/stage1/buildReviewSheet');
const { parseCsv, toCsv, evaluateCalibration } = require('../src/stage1/calibration');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'revsheet-'));
}

/** 造一个最小可用的盲表 + 密钥（含一条依赖图片的样本） */
function fixture(dir) {
  const sheet = [
    { itemId: 'c-001', question: '如图所示，问号处面积是． question_9-image_0', goldAnswer: '18', pred: '15', humanScore: '', note: '' },
    { itemId: 'c-002', question: '计算：$$46\\times 99$$=．', goldAnswer: '4554', pred: '4554', humanScore: '', note: '' },
    { itemId: 'c-003', question: '有$$9$$人．', goldAnswer: '105', pred: '105', humanScore: '', note: '' },
  ];
  fs.writeFileSync(
    path.join(dir, 'human-calibration-blind.v1-raw.csv'),
    '\ufeff' + toCsv(['itemId', 'question', 'goldAnswer', 'pred', 'humanScore', 'note'], sheet),
    'utf8'
  );
  const keys = [
    { itemId: 'c-001', queryId: 'q1', arm: 'R', judgeScore: 0, enriched: false },
    { itemId: 'c-002', queryId: 'q2', arm: 'X', judgeScore: 2, enriched: false },
    { itemId: 'c-003', queryId: 'q3', arm: 'N', judgeScore: 2, enriched: false },
  ];
  fs.writeFileSync(path.join(dir, 'human-calibration-key.jsonl'), keys.map((k) => JSON.stringify(k)).join('\n') + '\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  // 1x1 透明 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(path.join(dir, 'images', 'question_9-image_0.png'), png);
}

test('buildReviewSheet：LaTeX 转可读、图片内嵌、needsImage 标出', () => {
  const dir = tmpDir();
  fixture(dir);
  const r = buildReviewSheet({ dir, outPrefix: 't' });

  assert.strictEqual(r.stat.n, 3);
  assert.strictEqual(r.stat.needsImage, 1);
  assert.strictEqual(r.stat.missingImages, 0);

  const html = fs.readFileSync(r.stat.htmlPath, 'utf8');
  assert.ok(html.includes('data:image/png;base64,'), '图片应内嵌为 data URI');
  assert.ok(!html.includes('$$'), 'LaTeX 定界符不应残留');
  assert.ok(!/"judgeScore"/.test(html), 'HTML 不得含机器分字段名');
  assert.ok(html.includes('【图1】'), '题面应把内部文件名换成【图N】');
});

test('buildReviewSheet：CSV 含 needsImage/images 列且无 $$', () => {
  const dir = tmpDir();
  fixture(dir);
  const r = buildReviewSheet({ dir, outPrefix: 't', inlineImages: false });
  const csv = fs.readFileSync(r.stat.csvPath, 'utf8');
  const rows = parseCsv(csv);
  assert.deepStrictEqual(Object.keys(rows[0]), [
    'itemId', 'needsImage', 'images', 'question', 'goldAnswer', 'pred', 'humanScore', 'note',
  ]);
  assert.strictEqual(rows[0].needsImage, '1');
  assert.strictEqual(rows[0].images, 'question_9-image_0.png');
  assert.ok(!csv.includes('$$'));
  assert.ok(rows[1].question.includes('46×99'));
});

test('buildReviewSheet：缺图片文件时如实记录，不静默跳过', () => {
  const dir = tmpDir();
  fixture(dir);
  fs.unlinkSync(path.join(dir, 'images', 'question_9-image_0.png'));
  const r = buildReviewSheet({ dir, outPrefix: 't' });
  assert.strictEqual(r.stat.missingImages, 1);
  assert.strictEqual(r.missingImages[0].itemId, 'c-001');
  const html = fs.readFileSync(r.stat.htmlPath, 'utf8');
  assert.ok(html.includes('图片缺失'), 'HTML 应显式提示缺图');
});

test('itemId 与密钥不同源时直接报错（防止错配）', () => {
  const dir = tmpDir();
  fixture(dir);
  const sheet = parseCsv(fs.readFileSync(path.join(dir, 'human-calibration-blind.v1-raw.csv'), 'utf8'));
  fs.writeFileSync(
    path.join(dir, 'human-calibration-blind.v1-raw.csv'),
    '\ufeff' + toCsv(['itemId', 'question', 'goldAnswer', 'pred', 'humanScore', 'note'], [...sheet, { itemId: 'c-999', question: 'x', goldAnswer: '1', pred: '1', humanScore: '', note: '' }]),
    'utf8'
  );
  assert.throws(() => buildReviewSheet({ dir, outPrefix: 't' }), /c-999/);
});

test('导出的 CSV（itemId,humanScore,note）能直接被 evaluateCalibration 消费', () => {
  const dir = tmpDir();
  fixture(dir);
  buildReviewSheet({ dir, outPrefix: 't' });
  // 模拟审阅器导出的三列 CSV
  const filled = 'itemId,humanScore,note\nc-001,0,"第二空错"\nc-002,2,\nc-003,2,\n';
  const keyRows = fs
    .readFileSync(path.join(dir, 'human-calibration-key.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const rep = evaluateCalibration({ sheetCsv: filled, keyRows, cfg: { minHumanKappa: 0.6 }, reps: 200 });
  assert.strictEqual(rep.n.rated, 3);
  assert.strictEqual(rep.n.missing, 0);
  assert.strictEqual(rep.n.invalid, 0);
  assert.ok(Number.isFinite(rep.agreement.cohenKappa));
});
