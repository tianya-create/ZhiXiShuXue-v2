const {
  fitBkt,
  fitBktByKp,
  predictNextCorrect,
  splitSequence,
  toBinary,
  buildEstimationData,
  _internal
} = require('../models/bkt');
const { walkForward, generateSyntheticRecords } = require('../models/baselineEval');

// 确定性伪随机（不依赖 Math.random，保证测试可复现）
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('BKT 前向-后向（E 步）', () => {
  const params = { L0: 0.3, T: 0.2, G: 0.2, S: 0.2 };

  test('每个时刻的 gamma 两状态之和为 1', () => {
    const fb = _internal.forwardBackward([1, 0, 1, 1, 0], params);
    for (let t = 0; t < 5; t++) {
      expect(fb.gamma[t][0] + fb.gamma[t][1]).toBeCloseTo(1, 6);
    }
  });

  test('全对序列的掌握概率后验单调上升到接近 1', () => {
    const fb = _internal.forwardBackward([1, 1, 1, 1, 1], params);
    for (let t = 1; t < 5; t++) {
      expect(fb.gamma[t][1]).toBeGreaterThanOrEqual(fb.gamma[t - 1][1]);
    }
    expect(fb.gamma[4][1]).toBeGreaterThan(0.95);
  });

  test('长序列（290 步）不发生数值下溢', () => {
    const long = Array.from({ length: 290 }, () => 1);
    const fb = _internal.forwardBackward(long, { L0: 0.3, T: 0.2, G: 0.05, S: 0.4 });
    expect(fb).not.toBeNull();
    expect(fb.gamma[289][1]).toBeGreaterThan(0.99);
  });
});

describe('BKT EM 拟合（M 步收敛）', () => {
  test('从模拟序列恢复真实参数（误差 < 0.05）', () => {
    const truth = { L0: 0.5, T: 0.2, G: 0.25, S: 0.1 };
    const rnd = makeRng(42);
    const seqs = [];
    for (let s = 0; s < 300; s++) {
      let l = rnd() < truth.L0 ? 1 : 0;
      const obs = [];
      for (let t = 0; t < 10; t++) {
        obs.push(l === 1 ? (rnd() < 1 - truth.S ? 1 : 0) : (rnd() < truth.G ? 1 : 0));
        if (l === 0 && rnd() < truth.T) l = 1;
      }
      seqs.push(obs);
    }
    const fit = fitBkt(seqs, { maxIter: 200 });
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.params.L0 - truth.L0)).toBeLessThan(0.05);
    expect(Math.abs(fit.params.T - truth.T)).toBeLessThan(0.05);
    expect(Math.abs(fit.params.G - truth.G)).toBeLessThan(0.05);
    expect(Math.abs(fit.params.S - truth.S)).toBeLessThan(0.05);
  });

  test('参数始终落在夹紧范围内（防退化）', () => {
    // 退化数据：全对序列，未夹紧的 EM 会把 P(S) 推到 0
    const seqs = [Array.from({ length: 8 }, () => 1)];
    const fit = fitBkt([seqs[0], seqs[0], seqs[0]], { maxIter: 50 });
    expect(fit.params.S).toBeGreaterThanOrEqual(0.05);
    expect(fit.params.S).toBeLessThanOrEqual(0.4);
    expect(fit.params.G).toBeGreaterThanOrEqual(0.05);
    expect(fit.params.G).toBeLessThanOrEqual(0.4);
  });

  test('EM 迭代使对数似然不下降', () => {
    const rnd = makeRng(7);
    const seqs = [];
    for (let s = 0; s < 50; s++) {
      const obs = [];
      for (let t = 0; t < 6; t++) obs.push(rnd() < 0.6 ? 1 : 0);
      seqs.push(obs);
    }
    let prev = -Infinity;
    let params = { L0: 0.4, T: 0.15, G: 0.2, S: 0.15 };
    for (let iter = 0; iter < 5; iter++) {
      let ll = 0;
      for (const obs of seqs) {
        const fb = _internal.forwardBackward(obs, params);
        if (fb) ll += fb.logLik;
      }
      expect(ll).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = ll;
      params = _internal.mStep(seqs, params);
    }
  });
});

describe('BKT 预测', () => {
  const p = { L0: 0.3, T: 0.2, G: 0.2, S: 0.2 };

  test('连续答对预测单调上升，答错后下降', () => {
    const one = predictNextCorrect(p, [1]);
    const two = predictNextCorrect(p, [1, 1]);
    const three = predictNextCorrect(p, [1, 1, 1]);
    const wrong = predictNextCorrect(p, [0]);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(three);
    expect(wrong).toBeLessThan(one);
  });

  test('空历史预测 = 先验预测 P(L0)·(1-P(S)) + (1-P(L0))·P(G)', () => {
    const expected = p.L0 * (1 - p.S) + (1 - p.L0) * p.G;
    expect(predictNextCorrect(p, [])).toBeCloseTo(expected, 10);
  });

  test('预测值始终在 (0, 1) 内', () => {
    for (const hist of [[], [0], [1], [1, 0], [0, 0, 0], [1, 1, 0, 1]]) {
      const v = predictNextCorrect(p, hist);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('估计段/评估段切分（无泄漏协议）', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ isCorrect: i % 2 === 0 }));

  test('切分比例与边界', () => {
    expect(splitSequence(mk(5), 0.5)).toEqual({ est: mk(5).slice(0, 2), eval: mk(5).slice(2) });
    expect(splitSequence(mk(2), 0.5).est).toHaveLength(1);
    expect(splitSequence(mk(2), 0.5).eval).toHaveLength(1);
    expect(splitSequence(mk(1), 0.5).eval).toHaveLength(0); // 长度 1 无法做预测目标
  });

  test('估计段与评估段不重叠、拼接还原原序列', () => {
    const items = mk(7);
    const { est, eval: ev } = splitSequence(items, 0.5);
    expect([...est, ...ev]).toEqual(items);
  });

  test('buildEstimationData 只把估计段送入 EM 输入，并按知识点分组', () => {
    const groups = [
      [{ kpCode: 'A', isCorrect: true }, { kpCode: 'A', isCorrect: false }, { kpCode: 'A', isCorrect: true }, { kpCode: 'A', isCorrect: true }],
      [{ kpCode: 'B', isCorrect: false }, { kpCode: 'B', isCorrect: true }]
    ];
    const { sequencesByKp, splitOf } = buildEstimationData(groups, 0.5);
    expect(sequencesByKp.get('A')).toEqual([[1, 0]]); // 只有序列前半
    expect(sequencesByKp.get('B')).toEqual([[0]]);
    expect(splitOf).toEqual([{ estLen: 2, evalLen: 2 }, { estLen: 1, evalLen: 1 }]);
  });

  test('fitBktByKp 对数据不足的知识点回退默认参数', () => {
    const { paramsByKp, fitInfo } = fitBktByKp(new Map([['rare', [[1, 0]]]]), { minObservations: 30 });
    expect(fitInfo.rare.fallback).toBe(true);
    expect(paramsByKp.rare).toEqual({ L0: 0.4, T: 0.15, G: 0.2, S: 0.15 });
  });
});

describe('walkForward 与 BKT 目标过滤器集成', () => {
  test('targetFilter 只保留评估段目标，且各模型目标完全一致', () => {
    const records = generateSyntheticRecords({ students: 8, kps: 3, avgPerPair: 8 });
    const { groupByStudentKp } = require('../models/baselineEval');
    const groups = groupByStudentKp(records);
    const { splitOf } = buildEstimationData(groups, 0.5);

    const rowsWithout = walkForward(records, 'Rule-0');
    const rowsBkt = walkForward(records, 'BKT', {
      targetFilter: (gi, t) => t >= splitOf[gi].estLen,
      bktPredict: () => 0.5
    });
    const rowsRule = walkForward(records, 'Rule-0', { targetFilter: (gi, t) => t >= splitOf[gi].estLen });
    const rowsMaj = walkForward(records, 'Majority', { targetFilter: (gi, t) => t >= splitOf[gi].estLen });

    // 过滤后目标数 = Σ evalLen（注意：首批次整体跳过，若首批次落在评估段内也被跳过）
    let expected = 0;
    groups.forEach((group, gi) => {
      const minTs = new Date(group[0].createdAt).getTime();
      for (let t = splitOf[gi].estLen; t < group.length; t++) {
        if (new Date(group[t].createdAt).getTime() !== minTs) expected++;
      }
    });
    expect(rowsBkt).toHaveLength(expected);

    // 三个模型的目标键（userId/kpCode/createdAt/target）逐条一致
    const key = (r) => `${r.userId}|${r.kpCode}|${r.createdAt}|${r.target}`;
    expect(rowsBkt.map(key)).toEqual(rowsRule.map(key));
    expect(rowsBkt.map(key)).toEqual(rowsMaj.map(key));

    // 未过滤的全量目标多于过滤后
    expect(rowsWithout.length).toBeGreaterThan(rowsRule.length);
  });

  test('bktPredict 收到的历史是二值数组且不含目标自身', () => {
    const records = generateSyntheticRecords({ students: 4, kps: 2, avgPerPair: 6 });
    const { groupByStudentKp } = require('../models/baselineEval');
    const groups = groupByStudentKp(records);
    const { splitOf } = buildEstimationData(groups, 0.5);
    const calls = [];
    walkForward(records, 'BKT', {
      targetFilter: (gi, t) => t >= splitOf[gi].estLen,
      bktPredict: (kp, hist) => {
        calls.push({ kp, hist });
        return 0.5;
      }
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const { hist } of calls) {
      expect(Array.isArray(hist)).toBe(true);
      for (const v of hist) expect(v === 0 || v === 1).toBe(true);
    }
    // 至少有一条调用的历史非空（评估段目标必有估计段历史）
    expect(calls.some((c) => c.hist.length > 0)).toBe(true);
  });

  test('toBinary 输出 0/1 数组', () => {
    expect(toBinary([{ isCorrect: true }, { isCorrect: false }])).toEqual([1, 0]);
  });
});
