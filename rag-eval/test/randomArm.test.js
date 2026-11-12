const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sampleRandomContext, fnv1a } = require('../src/arms/randomArm');
const { mulberry32 } = require('../src/stats/core');

function makePool(nClusters, charsPerChunk) {
  const clusters = [];
  const chunkTextById = new Map();
  for (let i = 0; i < nClusters; i++) {
    const cid = `XC${i}`;
    const chunkId = `xc-${i}`;
    clusters.push({ clusterId: cid, chunkIds: [chunkId] });
    chunkTextById.set(chunkId, (`随机块${i}：`).padEnd(charsPerChunk - 1, '内') + '。');
  }
  return { clusters, chunkTextById };
}

describe('fnv1a：确定性哈希种子', () => {
  it('不同 queryId 给出不同种子；同输入同输出', () => {
    assert.equal(fnv1a('seed:q1'), fnv1a('seed:q1'));
    assert.notEqual(fnv1a('seed:q1'), fnv1a('seed:q2'));
    assert.notEqual(fnv1a('seedA:q1'), fnv1a('seedB:q1'));
  });
});

describe('sampleRandomContext：等长随机臂（§2.2）', () => {
  const { clusters, chunkTextById } = makePool(12, 60);

  it('长度精确匹配（截断到 targetChars）', () => {
    const r = sampleRandomContext({
      queryId: 'q1', targetChars: 150, clusters, chunkTextById, configSeed: 's1'
    });
    assert.equal(r.chars, 150);
    assert.equal(r.texts.join('').length, 150);
  });

  it('确定性：同 query 同配置逐位一致；不同 queryId 用不同种子', () => {
    const args = { targetChars: 150, clusters, chunkTextById, configSeed: 's1' };
    const r1 = sampleRandomContext({ queryId: 'q1', ...args });
    const r2 = sampleRandomContext({ queryId: 'q1', ...args });
    assert.deepEqual(r1, r2);
    const r3 = sampleRandomContext({ queryId: 'q2', ...args });
    assert.ok(JSON.stringify(r1.texts) !== JSON.stringify(r3.texts) || r1.clusterIds[0] !== r3.clusterIds[0]);
  });

  it('簇间不重复（每簇最多一块）', () => {
    const r = sampleRandomContext({ queryId: 'q3', targetChars: 200, clusters, chunkTextById, configSeed: 's1' });
    assert.equal(new Set(r.clusterIds).size, r.clusterIds.length);
  });

  it('与 R 臂簇无交集（excludeClusterIds 生效）', () => {
    const r = sampleRandomContext({
      queryId: 'q4', targetChars: 100, clusters, chunkTextById, configSeed: 's1',
      excludeClusterIds: ['XC0', 'XC1', 'XC2']
    });
    assert.ok(r.clusterIds.every((c) => !['XC0', 'XC1', 'XC2'].includes(c)));
  });

  it('排除后池不足 → 显式报错（不是静默给短上下文）', () => {
    assert.throws(() => sampleRandomContext({
      queryId: 'q5', targetChars: 500, clusters, chunkTextById, configSeed: 's1',
      excludeClusterIds: clusters.map((c) => c.clusterId).slice(0, 11)
    }), /不足|为空/);
  });

  it('全排除 → 报错；targetChars 非法 → 报错', () => {
    assert.throws(() => sampleRandomContext({
      queryId: 'q6', targetChars: 100, clusters, chunkTextById, configSeed: 's1',
      excludeClusterIds: clusters.map((c) => c.clusterId)
    }), /为空/);
    assert.throws(() => sampleRandomContext({
      queryId: 'q7', targetChars: 0, clusters, chunkTextById, configSeed: 's1'
    }), /targetChars/);
  });

  it('lengthMatchTolerance：池总量不足且超过容差时报错', () => {
    const small = makePool(2, 60);
    assert.throws(() => sampleRandomContext({
      queryId: 'q8', targetChars: 500, clusters: small.clusters, chunkTextById: small.chunkTextById, configSeed: 's1', tolerance: 0.02
    }), /不足/);
  });

  it('与 mulberry32 配合的洗牌不越界（抽查多种子）', () => {
    for (let s = 0; s < 20; s++) {
      const r = sampleRandomContext({ queryId: `qs${s}`, targetChars: 180, clusters, chunkTextById, configSeed: `s${s}` });
      assert.equal(r.chars, 180);
    }
  });
});
