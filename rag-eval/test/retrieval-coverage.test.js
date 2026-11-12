const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, buildBm25Index } = require('../src/retrieval/bm25');
const { answerInCorpusRate, oracleRecallAtK, generatorCeiling, normalizeAnswer } = require('../src/coverage/coverageAudit');

describe('bm25：骨架内置检索器', () => {
  const docs = [
    { id: 'c-a0', text: '勾股定理：直角三角形两直角边的平方和等于斜边的平方。' },
    { id: 'c-a1', text: '概率初步：随机事件发生的可能性大小用概率表示。' },
    { id: 'c-a2', text: '勾股定理的应用：已知直角三角形两边求第三边，先判断直角位置。' }
  ];
  const index = buildBm25Index(docs);

  it('含查询词的文档排在前面', () => {
    const hits = index.search('勾股定理 直角三角形', 3);
    assert.equal(hits[0].docId, 'c-a0');
    assert.equal(hits[1].docId, 'c-a2');
    assert.equal(hits[2].docId, 'c-a1');
  });

  it('topK 生效；并列分数按 docId 升序（确定性）', () => {
    assert.equal(index.search('勾股定理', 1).length, 1);
    const t1 = index.search('勾股定理', 2);
    const t2 = index.search('勾股定理', 2);
    assert.deepEqual(t1, t2);
    for (let i = 1; i < t1.length; i++) {
      assert.ok(t1[i - 1].score > t1[i].score || t1[i - 1].docId < t1[i].docId);
    }
  });

  it('CJK 2-gram 分词：单字查询也能命中', () => {
    const toks = tokenize('勾股定理abc');
    assert.ok(toks.includes('勾股') && toks.includes('定理'));
    assert.ok(toks.includes('abc'));
    const hits = index.search('概率', 3);
    assert.equal(hits[0].docId, 'c-a1');
  });
});

describe('coverage：语料覆盖率预检（§5.2 闸门）', () => {
  const chunks = [
    { chunkId: 'x0', docId: 'd0', text: '本节结论：结论3号——运用勾股定理解题时先识别题型。' },
    { chunkId: 'x1', docId: 'd1', text: '概率初步研究随机事件。' }
  ];

  it('答案在语料中 → rate 反映命中', () => {
    const r = answerInCorpusRate({
      items: [{ queryId: 'q0', answer: '结论3号' }, { queryId: 'q1', answer: '结论9号' }],
      chunks
    });
    assert.equal(r.total, 2);
    assert.equal(r.found, 1);
    assert.equal(r.rate, 0.5);
  });

  it('归一化忽略空白与标点后仍能命中', () => {
    const r = answerInCorpusRate({ items: [{ queryId: 'q0', answer: '结论 3 号！' }], chunks });
    assert.equal(r.found, 1);
    assert.equal(normalizeAnswer('结论 3 号！'), '结论3号');
  });

  it('probeK 截断：取答案前缀作为探针', () => {
    const r = answerInCorpusRate({
      items: [{ queryId: 'q0', answer: '结论3号——运用勾股定理解题时先识别题型再选择方法最后检验结果' }],
      chunks
    });
    assert.equal(r.found, 1);
  });

  it('空答案显式报错', () => {
    assert.throws(() => answerInCorpusRate({ items: [{ queryId: 'q0', answer: '！！！' }], chunks }), /为空/);
  });

  it('oracleRecallAtK 手算一致', () => {
    const r = oracleRecallAtK({
      ranked: [{ queryId: 'q0', docIds: ['d0', 'd1', 'd2'] }],
      golds: [{ queryId: 'q0', docIds: ['d0', 'd2'] }],
      k: 2
    });
    assert.equal(r.recallAtK, 0.5); // top2 = [d0,d1]，命中 d0 → 1/2
  });

  it('缺 gold 标注报错', () => {
    assert.throws(() => oracleRecallAtK({ ranked: [{ queryId: 'qX', docIds: [] }], golds: [], k: 3 }), /gold/);
  });

  it('generatorCeiling 显式拒绝返回估计值', () => {
    assert.throws(() => generatorCeiling(), /LLM/);
  });
});
