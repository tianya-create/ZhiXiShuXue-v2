'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildQuerySet, querySetManifest, allocateQuotas, kc2IdOf, eligibilityOf, QUERY_TEMPLATES } = require('../src/evalset/buildQuerySet');
const { sha256OfJson } = require('../src/util/hash');

/** 合成 XES3G5M 元数据：n 组 KC，每组 size 道填空题 */
function synthQuestions({ groups, letterQuestions = 2, symbolQuestions = 2 }) {
  const out = {};
  let id = 0;
  for (const [kc2, size] of groups) {
    for (let i = 0; i < size; i++) {
      const qid = String(id++);
      out[qid] = {
        content: `第${qid}题：计算 ${qid} + 3 等于多少？`,
        kc_routes: [`${kc2.replace('>', '----')}`],
        type: '填空',
        options: {},
        answer: [`$$${qid}${i}$$`],
        analysis: `由题意 ${qid}+3=${qid}${i}。`,
      };
    }
  }
  for (let i = 0; i < letterQuestions; i++) {
    out[`L${i}`] = { content: '选择正确的一项', kc_routes: ['拓展思维----计数模块'], type: '单选', options: { A: '1' }, answer: ['A'], analysis: '选 A。' };
  }
  for (let i = 0; i < symbolQuestions; i++) {
    out[`S${i}`] = { content: '比较大小', kc_routes: ['拓展思维----计算模块'], type: '填空', options: {}, answer: ['$$<$$'], analysis: '小于。' };
  }
  return out;
}

test('buildQuerySet: 同 seed 完全可复现', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 60], ['拓展思维>几何模块', 40], ['知识点>应用题模块', 80]] });
  const a = buildQuerySet({ questions: q, devSize: 20, evalSize: 40, seed: 42 });
  const b = buildQuerySet({ questions: q, devSize: 20, evalSize: 40, seed: 42 });
  assert.deepStrictEqual(a.dev, b.dev);
  assert.deepStrictEqual(a.eval, b.eval);
  assert.deepStrictEqual(a.dropped, b.dropped);
});

test('buildQuerySet: dev/eval query 簇与 queryId 双双不相交', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 50], ['知识点>数论模块', 50], ['课内题型>综合与实践', 50], ['拓展思维>几何模块', 50]] });
  const r = buildQuerySet({ questions: q, devSize: 30, evalSize: 60, seed: 7 });
  const devIds = new Set(r.dev.map((x) => x.queryId));
  const devClusters = new Set(r.dev.map((x) => x.queryClusterId));
  for (const e of r.eval) {
    assert.ok(!devIds.has(e.queryId));
    assert.ok(!devClusters.has(e.queryClusterId));
  }
  assert.ok(r.stats.clusterDisjoint);
});

test('buildQuerySet: 集合规模精确命中', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 100], ['拓展思维>几何模块', 100], ['知识点>应用题模块', 100], ['课内知识点>数与运算', 100]] });
  const r = buildQuerySet({ questions: q, devSize: 30, evalSize: 80, seed: 1 });
  assert.strictEqual(r.dev.length, 30);
  assert.strictEqual(r.eval.length, 80);
});

test('buildQuerySet: 不合格题目被剔除且原因计数', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 30]], letterQuestions: 3, symbolQuestions: 2 });
  const r = buildQuerySet({ questions: q, devSize: 10, evalSize: 10, seed: 3 });
  assert.strictEqual(r.stats.eligibleTotal, 30);
  const reasons = r.dropped.reduce((m, d) => { m[d.reason] = (m[d.reason] || 0) + 1; return m; }, {});
  assert.strictEqual(reasons['type=单选（非填空，探针无区分度）'], 3);
  assert.strictEqual(reasons['纯符号答案'], 2);
});

test('buildQuerySet: KC 分层——两集合都覆盖各组（大体按比例）', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 80], ['拓展思维>几何模块', 20], ['知识点>应用题模块', 40]] });
  const r = buildQuerySet({ questions: q, devSize: 28, evalSize: 56, seed: 9 });
  const kcOf = (arr) => arr.reduce((m, x) => { m[x.kcId] = (m[x.kcId] || 0) + 1; return m; }, {});
  const devKc = kcOf(r.dev);
  const evalKc = kcOf(r.eval);
  // 每组都应在两个集合中出现（组容量 >= 比例名额）
  assert.ok(devKc['拓展思维>计算模块'] >= 10 && devKc['拓展思维>计算模块'] <= 16);
  assert.ok(evalKc['拓展思维>几何模块'] >= 6);
  assert.ok(devKc['知识点>应用题模块'] >= 4);
});

test('buildQuerySet: 记录字段完整、queryText 由模板包裹题面', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 30]] });
  const r = buildQuerySet({ questions: q, devSize: 5, evalSize: 5, seed: 11 });
  for (const x of [...r.dev, ...r.eval]) {
    assert.match(x.queryId, /^q-xes-\d+$/);
    assert.match(x.queryClusterId, /^qc-xes-\d+$/);
    assert.strictEqual(x.oracleDocId, `xes-q${x.qid}`);
    assert.ok(x.goldAnswer && x.goldAnswer.length >= 1);
    assert.ok(!/^\$\$/.test(x.goldAnswer), 'gold 不应残留 LaTeX 定界符');
    assert.ok(x.queryText.includes(questions_content(q, x.qid)));
    assert.ok(x.templateIndex >= 0 && x.templateIndex < QUERY_TEMPLATES.length);
    assert.strictEqual(x.queryText, QUERY_TEMPLATES[x.templateIndex](questions_content(q, x.qid)));
  }
});

function questions_content(q, qid) { return String(q[qid].content).trim(); }

test('buildQuerySet: 模板覆盖多个 index（确定性伪随机不至于只用一个）', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 200]] });
  const r = buildQuerySet({ questions: q, devSize: 50, evalSize: 100, seed: 5 });
  const used = new Set([...r.dev, ...r.eval].map((x) => x.templateIndex));
  assert.ok(used.size >= 2);
});

test('buildQuerySet: seed 缺失显式报错', () => {
  assert.throws(() => buildQuerySet({ questions: synthQuestions({ groups: [['a>b', 5]] }) }), /seed/);
});

test('allocateQuotas: 精确分配且最大余数法补齐', () => {
  assert.deepStrictEqual(allocateQuotas([10, 10, 10], 3), [1, 1, 1]);
  assert.deepStrictEqual(allocateQuotas([1, 1, 1], 1), [1, 0, 0]);
  assert.deepStrictEqual(allocateQuotas([7, 3], 10), [7, 3]);
  const q = allocateQuotas([3, 7], 5);
  assert.strictEqual(q[0] + q[1], 5);
  assert.ok(q[1] > q[0]);
});

test('allocateQuotas: 组容量不足时不超额', () => {
  const q = allocateQuotas([2, 2, 96], 6); // 前两组容量只有 2
  assert.ok(q[0] <= 2 && q[1] <= 2);
  assert.strictEqual(q[0] + q[1] + q[2], 6);
});

test('querySetManifest: sha256 稳定且随内容变化', () => {
  const q = synthQuestions({ groups: [['拓展思维>计算模块', 40], ['知识点>数论模块', 40]] });
  const a = buildQuerySet({ questions: q, devSize: 10, evalSize: 20, seed: 77 });
  const b = buildQuerySet({ questions: q, devSize: 10, evalSize: 20, seed: 78 });
  const ma = querySetManifest(a);
  const mb = querySetManifest(b);
  assert.strictEqual(ma.dev.recordsSha256, querySetManifest(buildQuerySet({ questions: q, devSize: 10, evalSize: 20, seed: 77 })).dev.recordsSha256);
  assert.notStrictEqual(ma.eval.recordsSha256, mb.eval.recordsSha256);
  assert.strictEqual(ma.clusterDisjointAssertion, true);
  assert.ok(ma.dev.queryIdsSha256.startsWith('sha256:'));
});

test('eligibilityOf: 真实数据边界形态', () => {
  assert.strictEqual(eligibilityOf({ type: '填空', answer: ['$$25$$'] }), '25');
  assert.strictEqual(eligibilityOf({ type: '填空', answer: ['$$<$$'] }), null);
  assert.strictEqual(eligibilityOf({ type: '填空', answer: ['$$A$$'] }), null);
  assert.strictEqual(eligibilityOf({ type: '填空', answer: ['$$3$$'] }), '3'); // 单个数字保留
  assert.strictEqual(eligibilityOf({ type: '单选', answer: ['A'] }), null);
  assert.strictEqual(eligibilityOf({ type: '填空', answer: [] }), null);
});

test('kc2IdOf: 真实格式（---- 分隔）', () => {
  assert.strictEqual(kc2IdOf({ kc_routes: ['拓展思维----应用题模块----行程问题'] }), '拓展思维>应用题模块');
  assert.strictEqual(kc2IdOf({ kc_routes: ['知识点----计算模块'] }), '知识点>计算模块');
  assert.strictEqual(kc2IdOf({ kc_routes: ['只有一级'] }), '');
});
