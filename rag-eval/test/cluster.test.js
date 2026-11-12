const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { shingleSet, jaccardOf, clusterBySimilarity, docClusters, queryClusters } = require('../src/clustering/cluster');

describe('shingle 与 Jaccard', () => {
  it('归一化忽略大小写与空白', () => {
    const a = shingleSet('Hello World 测试', 3);
    const b = shingleSet('hello  world 测试', 3);
    assert.equal(jaccardOf(a, b), 1);
  });

  it('相同文本 Jaccard=1，无交集=0', () => {
    const a = shingleSet('勾股定理的内容', 3);
    assert.equal(jaccardOf(a, a), 1);
    const c = shingleSet('概率统计初步', 3);
    assert.equal(jaccardOf(a, c), 0);
  });
});

describe('clusterBySimilarity：doc 簇（防近重复泄漏的底座）', () => {
  const mk = (id, text) => ({ docId: id, text });

  it('完全相同文本归同簇', () => {
    const r = clusterBySimilarity([mk('a', '完全一样的教材段落内容'), mk('b', '完全一样的教材段落内容')], { threshold: 0.8, idKey: 'docId' });
    assert.equal(r.assignments.get('a'), r.assignments.get('b'));
  });

  it('无关文本不归簇', () => {
    const r = clusterBySimilarity(
      [mk('a', '勾股定理描述直角三角形三边关系'), mk('b', '概率初步研究随机事件发生的可能性')],
      { threshold: 0.8, idKey: 'docId' }
    );
    assert.notEqual(r.assignments.get('a'), r.assignments.get('b'));
  });

  it('近重复（教材拓展阅读排版副本）在 0.8 阈值下归簇', () => {
    const base = '【全等三角形】本节定义：全等三角形是初中数学的核心内容之一。本节结论：三边对应相等的两个三角形全等。典型例题：已知两边一角判断三角形全等。易错点：注意对应关系。';
    const copy = base.replace('本节定义', '本讲定义') + '拓展。'; // Jaccard ≈ 0.84，仍 ≥ 0.8
    const other = '【概率初步】本节定义：概率初步研究随机事件。本节结论：抛掷均匀硬币正面朝上概率为二分之一。典型例题：计算简单事件的概率。易错点：注意等可能性。';
    const r = clusterBySimilarity([mk('base', base), mk('copy', copy), mk('other', other)], { threshold: 0.8, idKey: 'docId' });
    assert.equal(r.assignments.get('base'), r.assignments.get('copy'));
    assert.notEqual(r.assignments.get('base'), r.assignments.get('other'));
    const big = r.clusters.find((c) => c.memberIds.length === 2);
    assert.ok(big, '存在一个两成员簇');
  });

  it('传递闭包：A~B、B~C → 三者同簇（union-find）', () => {
    const t = '这是一段用于传递闭包测试的教材文本内容，重复若干关键词以保证相似度足够高。'.repeat(2);
    const items = [
      mk('a', t),
      mk('b', t + '补充一句。'),
      mk('c', t + '补充一句。再补充一句。')
    ];
    // a~b 高相似，b~c 高相似，a~c 稍低但经 b 传递应同簇
    const r = clusterBySimilarity(items, { threshold: 0.85, idKey: 'docId' });
    assert.equal(r.assignments.get('a'), r.assignments.get('b'));
    assert.equal(r.assignments.get('b'), r.assignments.get('c'));
  });

  it('threshold 越小越易合并；非法 threshold 报错', () => {
    const items = [mk('a', '内容甲'.repeat(20)), mk('b', '内容乙'.repeat(20))];
    const strict = clusterBySimilarity(items, { threshold: 0.99, idKey: 'docId' });
    assert.notEqual(strict.assignments.get('a'), strict.assignments.get('b'));
    // 完全不重叠的文本 Jaccard=0，任何正阈值都不会合并 → 用相同文本验证低阈值合并
    const same = [mk('a', '内容甲'.repeat(20)), mk('b', '内容甲'.repeat(20))];
    const loose = clusterBySimilarity(same, { threshold: 0.01, idKey: 'docId' });
    assert.equal(loose.assignments.get('a'), loose.assignments.get('b'));
    assert.throws(() => clusterBySimilarity(items, { threshold: 0, idKey: 'docId' }), /threshold/);
    assert.throws(() => clusterBySimilarity(items, { threshold: 1.5, idKey: 'docId' }), /threshold/);
  });

  it('assignments 覆盖全部条目，簇编号确定', () => {
    const items = [mk('x', '文本一'), mk('y', '文本二'), mk('z', '文本一')];
    const r1 = clusterBySimilarity(items, { threshold: 0.8, idKey: 'docId' });
    const r2 = clusterBySimilarity(items, { threshold: 0.8, idKey: 'docId' });
    assert.equal(r1.assignments.size, 3);
    assert.deepEqual([...r1.assignments.entries()], [...r2.assignments.entries()]);
  });
});

describe('便捷封装', () => {
  it('docClusters 用 docId/textKey；queryClusters 用 queryId/char-3gram', () => {
    const d = docClusters([{ docId: 'd1', text: '教材段落' }], { threshold: 0.8 });
    assert.equal(d.assignments.get('d1'), 'C0');
    const q = queryClusters([{ queryId: 'q1', text: '勾股定理是什么' }], { threshold: 0.6 });
    assert.equal(q.assignments.get('q1'), 'C0');
  });
});

describe('倒排模式与精确模式等价（n>1500 路径）', () => {
  it('200 篇语料（含植入近重复对）与暴力 O(n²) 结果一致', () => {
    const { clusterBySimilarity, shingleSet, jaccardOf } = require('../src/clustering/cluster');
    // 造 200 篇：每篇 12 个随机短语；每 20 篇植入一个近重复副本（替换 2 字）
    const PH = ['题面给出已知条件与图形', '求线段长度与角度大小', '下列选项正确的是哪一项', '根据定义判断三角形形状', '计算抛物线的顶点坐标', '阅读材料后回答问题', '判断命题是否成立', '用两种方法求阴影面积', '已知函数求最值', '化简分式并求值', '如图所示的正方形网格', '完成下列填空'];
    const items = [];
    for (let i = 0; i < 200; i++) {
      const base = PH.map((p, j) => `${p}${(i * 7 + j * 13) % 10}`).join('。');
      items.push({ id: `d${i}`, text: i % 20 === 19 ? base.replace(/题面给出/, '题面列示') : base });
    }
    const t = 0.8;
    const fast = clusterBySimilarity(items, { threshold: t, idKey: 'id' });
    // 暴力精确
    const sets = items.map((x) => shingleSet(x.text, 5));
    const parent = items.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) x = parent[x]; return x; };
    for (let i = 0; i < 200; i++) for (let j = i + 1; j < 200; j++) {
      if (jaccardOf(sets[i], sets[j]) >= t) {
        const ra = find(i), rb = find(j);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
    // 以「组员集合签名」比较，簇标签本身可以不同
    const sigOf = (membersById) => {
      const groups = new Map();
      for (const x of items) {
        const g = membersById(x.id);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(x.id);
      }
      return new Set([...groups.values()].map((m) => m.sort().join('|')));
    };
    const fastGroups = new Map();
    for (const c of fast.clusters) for (const id of c.memberIds) fastGroups.set(id, c.clusterId);
    assert.deepEqual(sigOf((id) => fastGroups.get(id)), sigOf((id) => find(items.findIndex((x) => x.id === id))), '倒排模式分组结果应与暴力精确完全一致');
    assert.ok(fast.clusters.filter((c) => c.memberIds.length > 1).length >= 9, '植入的近重复对应成多成员簇');
  });
});
