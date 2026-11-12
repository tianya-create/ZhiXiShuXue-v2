const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { chunkText, chunkCorpus } = require('../src/chunking/chunk');

describe('chunkText：recursive-character 切分', () => {
  const longText = Array.from({ length: 20 }, (_, i) => `这是第${i}段的测试内容，包含若干句子。用于验证切分逻辑。`).join('\n\n');

  it('所有块不超过 size', () => {
    const chunks = chunkText(longText, { size: 60, overlap: 10 });
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.charCount <= 60, `块 ${c.index} 长度 ${c.charCount} 超限`);
  });

  it('相邻块带 overlap（下一块以前一块结尾开头）', () => {
    const chunks = chunkText(longText, { size: 60, overlap: 10 });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].text;
      const cur = chunks[i].text;
      const tail = prev.slice(-10);
      assert.ok(cur.startsWith(tail) || cur.length <= 60, `块 ${i} 未携带 overlap 前缀`);
    }
  });

  it('确定性：同输入同输出', () => {
    assert.deepEqual(chunkText(longText, { size: 50, overlap: 8 }), chunkText(longText, { size: 50, overlap: 8 }));
  });

  it('空文本与纯空白 → 空数组', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('  \n\n  '), []);
  });

  it('单块文本不产生 overlap 空块', () => {
    const chunks = chunkText('短文本', { size: 100, overlap: 10 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, '短文本');
  });

  it('size 非法输入报错', () => {
    assert.throws(() => chunkText('abc', { size: 0 }), /size 必须/);
  });
});

describe('chunkCorpus：语料级分块', () => {
  it('chunkId 携带 docId，且 docId 归属正确', () => {
    const docs = [
      { docId: 'd0', text: '第一篇文档的内容。'.repeat(5) },
      { docId: 'd1', text: '第二篇文档的内容。'.repeat(5) }
    ];
    const chunks = chunkCorpus(docs, { size: 40, overlap: 5 });
    assert.ok(chunks.every((c) => /^c-d[01]-\d+$/.test(c.chunkId)));
    assert.ok(chunks.some((c) => c.docId === 'd0') && chunks.some((c) => c.docId === 'd1'));
  });
});
