const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { mulberry32, percentile, ciOf, ciPreciseOf, pValueOf, round4 } = require('../src/stats/core');
const { buildGroupSampler } = require('../src/stats/sampler');
const { meanScoreOf, scoreViolations } = require('../src/stats/evaluator');
const { bootstrapArms } = require('../src/stats/bootstrap');

describe('core：PRNG 与百分位', () => {
  it('mulberry32 同种子序列完全一致，不同种子不同', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, [c(), c(), c()]);
  });

  it('percentile 线性插值与单点', () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([10], 0.25), 10);
    assert.equal(percentile([], 0.5), null);
  });

  it('ciPreciseOf 未舍入 vs ciOf 舍入：0.00004 边界必须区分', () => {
    // 40 个值：首两位 0 与 0.00004，2.5% 分位落在两者之间 → 舍入后变 0
    const vals = [0, 0.00004];
    for (let i = 0; i < 38; i++) vals.push(0.001 + i * 0.0001);
    const sorted = [...vals].sort((x, y) => x - y);
    const precise = ciPreciseOf(sorted);
    const rounded = ciOf(sorted);
    assert.ok(precise[0] > 0, '未舍入下界应为正');
    assert.equal(rounded[0], 0, '舍入下界退化为 0');
    assert.equal(round4(precise[0]), 0);
  });
});

describe('core：pValueOf 边界', () => {
  it('全零差 → p=1（不是 0 也不是 NaN）', () => {
    assert.equal(pValueOf([0, 0, 0, 0]), 1);
  });
  it('全部同号 → p = 2/(B+1)，不会出现 0', () => {
    assert.equal(pValueOf([1, 2, 3, 4, 5, 6, 7, 8, 9]), 2 / 10);
  });
  it('混合 → (0,1) 区间', () => {
    const p = pValueOf([-1, -1, 1, 1, 1, 1]);
    assert.ok(p > 0 && p < 1);
  });
  it('空数组 → null', () => {
    assert.equal(pValueOf([]), null);
  });
});

describe('sampler：组级重采样适配层', () => {
  const rows = [
    { userId: 'q1', score: 1 }, { userId: 'q1', score: 2 },
    { userId: 'q2', score: 3 }, { userId: 'q3', score: 4 }
  ];

  it('组级重采样：组内权重一致，平均总权重 = 行数（每行期望被抽 1 次）', () => {
    const { sampleWeights, groupCount } = buildGroupSampler(rows);
    const rand = mulberry32(1);
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const w = sampleWeights(rand);
      assert.equal(w[0], w[1], 'q1 组内两条记录必须同权（整组被抽）');
      sum += [...w].reduce((s, x) => s + x, 0);
    }
    const avg = sum / 2000;
    assert.ok(Math.abs(avg - rows.length) < 0.2, `平均总权重 ${avg.toFixed(3)} 应≈行数 ${rows.length}`);
    assert.equal(groupCount, 3);
  });

  it('复用同一缓冲区（返回同一 Float64Array）', () => {
    const { sampleWeights, weights } = buildGroupSampler(rows);
    const rand = mulberry32(2);
    assert.equal(sampleWeights(rand), weights);
    assert.equal(sampleWeights(rand), weights);
  });

  it('缺分组字段的行显式报错', () => {
    assert.throws(() => buildGroupSampler([{ score: 1 }]), /缺少分组字段/);
    assert.throws(() => buildGroupSampler([]), /为空/);
  });
});

describe('evaluator：meanScoreEvaluator', () => {
  it('加权均值手算一致', () => {
    const rows = [{ score: 0.8 }, { score: 0.4 }, { score: 0.6 }];
    const w = new Float64Array([2, 0, 1]);
    assert.ok(Math.abs(meanScoreOf(rows, w) - (0.8 * 2 + 0.6) / 3) < 1e-12);
  });

  it('缺省权重 = 全 1；全零权重 → null', () => {
    const rows = [{ score: 0.5 }, { score: 0.5 }];
    assert.equal(meanScoreOf(rows), 0.5);
    const zero = new Float64Array([0, 0]);
    assert.equal(meanScoreOf(rows, zero), null);
  });

  it('scoreViolations 抓越界与非有限值', () => {
    assert.deepEqual(scoreViolations([{ score: 0.5 }, { score: 1.2 }, { score: NaN }]), [1, 2]);
    assert.deepEqual(scoreViolations([{ score: 0 }, { score: 1 }]), []);
  });
});

describe('bootstrapArms：配对 bootstrap', () => {
  function makeRows(n, fA, fB) {
    const a = [];
    const b = [];
    for (let i = 0; i < n; i++) {
      const id = `q${i}`;
      a.push({ userId: id, score: fA(i) });
      b.push({ userId: id, score: fB(i) });
    }
    return { A: a, B: b };
  }

  it('同种子完全可复现', () => {
    const { A, B } = makeRows(30, (i) => (i % 3) / 3, (i) => ((i + 1) % 3) / 3);
    const r1 = bootstrapArms({ A, B }, { reps: 200, seed: 7 });
    const r2 = bootstrapArms({ A, B }, { reps: 200, seed: 7 });
    assert.deepEqual(r1.comparisons[0].deltaCI, r2.comparisons[0].deltaCI);
    assert.deepEqual(r1.ciByArm.A.ciPrecise, r2.ciByArm.A.ciPrecise);
  });

  it('行未按 query 对齐 → 显式报错（防静默配错）', () => {
    const { A } = makeRows(5, () => 0.5, () => 0.5);
    const Bmis = [{ userId: 'q0', score: 0.1 }, { userId: 'qX', score: 0.2 }, { userId: 'q2', score: 0.3 }, { userId: 'q3', score: 0.4 }, { userId: 'q4', score: 0.5 }];
    assert.throws(() => bootstrapArms({ A, B: Bmis }, { reps: 10 }), /对齐/);
  });

  it('行数不一致 → 报错', () => {
    const { A, B } = makeRows(4, () => 0.5, () => 0.5);
    assert.throws(() => bootstrapArms({ A, B: B.slice(0, 3) }, { reps: 10 }), /行数一致/);
  });

  it('舍入边界：A = B + 0.00004 → 未舍入 CI 为正（supportFlag=true），展示 CI 为 [0,0]', () => {
    const n = 40;
    const a = [];
    const b = [];
    for (let i = 0; i < n; i++) {
      a.push({ userId: `q${i}`, score: 0.5 + 0.00004 });
      b.push({ userId: `q${i}`, score: 0.5 });
    }
    const r = bootstrapArms({ A: a, B: b }, { reps: 300, seed: 11 });
    const cmp = r.comparisons[0];
    assert.ok(Math.abs(cmp.pointDiff - 0.00004) < 1e-15);
    assert.equal(cmp.supportFlag, true, '方向必须由未舍入 CI 判定');
    assert.deepEqual(cmp.deltaCI4, [0, 0], '展示值退化为 0，正说明为何不能用展示值判向');
  });

  it('A 显著大于 B → supportFlag；反之 negativeFlag', () => {
    const { A, B } = makeRows(30, () => 0.9, () => 0.4);
    const r = bootstrapArms({ A, B }, { reps: 300, seed: 3 });
    const cmp = r.comparisons[0];
    assert.equal(cmp.supportFlag, true);
    assert.equal(cmp.negativeFlag, false);
    const r2 = bootstrapArms({ A: B, B: A }, { reps: 300, seed: 3 });
    assert.equal(r2.comparisons[0].negativeFlag, true);
  });

  it('点估计差与臂均值差一致（报告 Δ 与 bootstrap 均值分开）', () => {
    const { A, B } = makeRows(20, (i) => 0.2 + (i % 5) * 0.1, () => 0.3);
    const r = bootstrapArms({ A, B }, { reps: 100, seed: 5 });
    const cmp = r.comparisons[0];
    assert.ok(Math.abs(cmp.pointDiff - (r.ciByArm.A.meanExact - r.ciByArm.B.meanExact)) < 1e-12);
    assert.ok(Math.abs(cmp.bootstrapMeanDiff - cmp.pointDiff) < 0.05, 'bootstrap 均值应接近点估计');
  });
});
