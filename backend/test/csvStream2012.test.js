/**
 * csvStream2012.test.js —— 2012 流式 CSV 解析回归测试
 *
 * 背景：ASSISTments 2012 的 actions 列是引号包裹的多行文本，按行切分会把一条记录拆成多行。
 * 这个解析器是 2012 清洗与构图两条链路的共同底座，解析错了会整表错位且很难事后发现。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CsvStream, readHeader, parseTimeMs } = require('../scripts/lib/csvStream');

function writeTemp(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvstream-'));
  const file = path.join(dir, 't.csv');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

async function collect(file, wanted) {
  const out = [];
  for await (const rec of new CsvStream(file, new Set(wanted)).records()) out.push(rec);
  return out;
}

describe('2012 流式 CSV 解析（引号内换行是主要风险）', () => {
  test('引号内的换行不会被当成记录结束', async () => {
    const file = writeTemp([
      'a,b,c',
      '1,"line1',
      'line2",3',
      '4,5,6'
    ].join('\n') + '\n');
    const recs = await collect(file, [0, 1, 2]);
    expect(recs.length).toBe(3);
    expect(recs[0]).toEqual(['a', 'b', 'c']);
    expect(recs[1]).toEqual(['1', 'line1\nline2', '3']);
    expect(recs[2]).toEqual(['4', '5', '6']);
  });

  test('双引号转义 "" 还原为一个引号', async () => {
    const file = writeTemp('x,y\n1,"say ""hi"""\n');
    const recs = await collect(file, [0, 1]);
    expect(recs[1]).toEqual(['1', 'say "hi"']);
  });

  test('CRLF 行尾不污染字段', async () => {
    const file = writeTemp('a,b\r\n1,2\r\n');
    const recs = await collect(file, [0, 1]);
    expect(recs[1]).toEqual(['1', '2']);
  });

  test('只物化指定列，跳过未请求列', async () => {
    const file = writeTemp('a,b,c,d\n1,2,3,4\n5,6,7,8\n');
    const recs = await collect(file, [0, 2]);
    expect(recs.length).toBe(3);
    expect(recs[1]).toEqual(['1', '3']);
    expect(recs[2]).toEqual(['5', '7']);
  });

  test('未请求列里的引号与换行也要正确跳过', async () => {
    const file = writeTemp([
      'keep,big,tail',
      '1,"multi',
      'line, with comma",9',
      '2,"x",8'
    ].join('\n') + '\n');
    const recs = await collect(file, [0, 2]);
    expect(recs[1]).toEqual(['1', '9']);
    expect(recs[2]).toEqual(['2', '8']);
  });

  test('readHeader 处理 BOM', () => {
    const file = writeTemp('\uFEFFuser_id,skill_id\r\n1,2\r\n');
    expect(readHeader(file)).toEqual(['user_id', 'skill_id']);
  });

  test('parseTimeMs 支持 2012 格式与毫秒小数', () => {
    expect(parseTimeMs('2012-09-28 15:11:27')).toBe(Date.UTC(2012, 8, 28, 15, 11, 27));
    expect(parseTimeMs('2012-09-28 15:11:27.856')).toBe(Date.UTC(2012, 8, 28, 15, 11, 27, 856));
    expect(parseTimeMs('')).toBeNull();
    expect(parseTimeMs('not-a-time')).toBeNull();
  });
});
