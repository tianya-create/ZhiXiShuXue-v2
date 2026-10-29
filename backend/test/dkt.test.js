/**
 * GRU-DKT 最小实现测试
 *
 * 覆盖：输入编码、学生级划分（无重叠/可复现/固定种子）、序列构建与排序、
 * GRU 前向确定性、BPTT 数值梯度（有限差分抽查）、训练收敛、早停与最优参数回滚。
 * 全部使用小维度模型，保证测试快速。
 */

const {
  buildStudentSequences,
  buildVocab,
  encodeInteractionId,
  splitStudents,
  sigmoid,
  GruDkt
} = require('../models/dkt');

const VOCAB = {
  kpList: ['k1', 'k2'],
  kpIndex: new Map([['k1', 0], ['k2', 1]]),
  vocabSize: 4,
  numSkills: 2
};

// 可学习信号的小数据：答对率随练习次数上升
function makeSeq(seed, len, userId) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const items = [];
  let m = 0.3;
  for (let t = 0; t < len; t++) {
    items.push({ kpCode: t % 2 ? 'k2' : 'k1', correct: rnd() < m ? 1 : 0 });
    m = Math.min(0.95, m + 0.04);
  }
  return { userId, items };
}

describe('输入编码', () => {
  test('interaction_id = 2 × kp_index + isCorrect（经典 DKT 方式）', () => {
    expect(encodeInteractionId(VOCAB.kpIndex, 'k1', 1)).toBe(1); // skill_1_correct = 2×0+1
    expect(encodeInteractionId(VOCAB.kpIndex, 'k1', 0)).toBe(0); // skill_1_wrong   = 2×0+0
    expect(encodeInteractionId(VOCAB.kpIndex, 'k2', 1)).toBe(3); // skill_2_correct = 2×1+1
    expect(encodeInteractionId(VOCAB.kpIndex, 'k2', 0)).toBe(2); // skill_2_wrong   = 2×1+0
  });

  test('未知知识点报错', () => {
    expect(() => encodeInteractionId(VOCAB.kpIndex, 'kX', 1)).toThrow(/未知知识点/);
  });

  test('buildVocab：kpCode 升序、词表 = 2 × 知识点数', () => {
    const seqs = [
      { userId: 'u1', items: [{ kpCode: 'b', correct: 1 }, { kpCode: 'a', correct: 0 }] }
    ];
    const v = buildVocab(seqs);
    expect(v.kpList).toEqual(['a', 'b']);
    expect(v.vocabSize).toBe(4);
    expect(v.numSkills).toBe(2);
  });
});

describe('学生级划分', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, '0')}`);

  test('70/15/15、无重叠、并集完整', () => {
    const sp = splitStudents(ids, {});
    expect(sp.train.length).toBe(70);
    expect(sp.validation.length).toBe(15);
    expect(sp.test.length).toBe(15);
    const all = new Set([...sp.train, ...sp.validation, ...sp.test]);
    expect(all.size).toBe(100);
  });

  test('同一划分规则下固定种子可复现', () => {
    const a = splitStudents(ids, { seed: 42 });
    const b = splitStudents(ids, { seed: 42 });
    expect(a.train).toEqual(b.train);
    expect(a.test).toEqual(b.test);
  });

  test('不同种子给出不同划分', () => {
    const a = splitStudents(ids, { seed: 42 });
    const b = splitStudents(ids, { seed: 43 });
    expect(a.train).not.toEqual(b.train);
  });
});

describe('序列构建', () => {
  test('按学生分组、时间升序、userId 字典序、minLen 过滤', () => {
    const records = [
      { userId: 'u2', kpCode: 'k1', isCorrect: true, createdAt: '2026-01-02T00:00:00Z' },
      { userId: 'u1', kpCode: 'k1', isCorrect: true, createdAt: '2026-01-01T00:00:00Z' },
      { userId: 'u2', kpCode: 'k2', isCorrect: false, createdAt: '2026-01-03T00:00:00Z' },
      { userId: 'u1', kpCode: 'k1', isCorrect: false, createdAt: '2026-01-04T00:00:00Z' },
      { userId: 'u3', kpCode: 'k1', isCorrect: true, createdAt: '2026-01-05T00:00:00Z' }
    ];
    const seqs = buildStudentSequences(records, { minLen: 2 });
    expect(seqs.map((s) => s.userId)).toEqual(['u1', 'u2']); // u3 只有 1 条被过滤
    expect(seqs[0].items.map((i) => i.ts)).toEqual([...seqs[0].items.map((i) => i.ts)].sort((a, b) => a - b));
    expect(seqs[1].items[0].correct).toBe(1);
    expect(seqs[1].items[1].correct).toBe(0);
  });
});

describe('GRU 前向', () => {
  test('预测值在 (0,1) 且同种子完全可复现', () => {
    const items = [
      { kpCode: 'k1', correct: 1 }, { kpCode: 'k2', correct: 0 },
      { kpCode: 'k1', correct: 1 }, { kpCode: 'k2', correct: 1 }
    ];
    const m1 = new GruDkt(VOCAB, { embedDim: 4, hiddenSize: 6, seed: 7 });
    const m2 = new GruDkt(VOCAB, { embedDim: 4, hiddenSize: 6, seed: 7 });
    const p1 = m1.predictSequence(items);
    const p2 = m2.predictSequence(items);
    expect(p1.length).toBe(3); // t = 1..3
    for (const o of p1) {
      expect(o.pred).toBeGreaterThan(0);
      expect(o.pred).toBeLessThan(1);
    }
    expect(p1.map((o) => o.pred)).toEqual(p2.map((o) => o.pred));
  });

  test('变长序列可用（无需 padding，逐序列处理）', () => {
    const m = new GruDkt(VOCAB, { embedDim: 4, hiddenSize: 6 });
    expect(m.predictSequence([{ kpCode: 'k1', correct: 1 }]).length).toBe(0);
    expect(m.predictSequence([
      { kpCode: 'k1', correct: 1 }, { kpCode: 'k2', correct: 0 },
      { kpCode: 'k1', correct: 0 }, { kpCode: 'k2', correct: 1 },
      { kpCode: 'k1', correct: 1 }
    ]).length).toBe(4);
  });
});

describe('BPTT 数值梯度检查', () => {
  test('解析梯度与有限差分一致（相对误差 < 1e-3）', () => {
    const model = new GruDkt(VOCAB, { embedDim: 4, hiddenSize: 6, dropout: 0, seed: 7 });
    const items = [
      { kpCode: 'k1', correct: 1 }, { kpCode: 'k2', correct: 0 },
      { kpCode: 'k1', correct: 1 }, { kpCode: 'k2', correct: 1 }, { kpCode: 'k1', correct: 0 }
    ];
    model.training = true;
    model.zeroGrad();
    model._forwardTrain(items);
    const ana = {};
    for (const k of Object.keys(model.grads)) ana[k] = Float64Array.from(model.grads[k]);
    const lossOf = () => {
      model.zeroGrad();
      return model._forwardTrain(items).logLoss;
    };
    const keys = ['E', 'Wz', 'Wr', 'Wh', 'Uz', 'Ur', 'Uh', 'bz', 'br', 'bh', 'Wout', 'bout'];
    for (const key of keys) {
      const p = model.params[key];
      const idxs = [0, Math.floor(p.length / 2), p.length - 1];
      for (const i of idxs) {
        const orig = p[i];
        const h = 1e-6;
        p[i] = orig + h;
        const l1 = lossOf();
        p[i] = orig - h;
        const l2 = lossOf();
        p[i] = orig;
        const num = (l1 - l2) / (2 * h);
        const rel = Math.abs(num - ana[key][i]) / Math.max(1e-5, Math.abs(num) + Math.abs(ana[key][i]));
        expect(rel).toBeLessThan(1e-3);
      }
    }
  });
});

describe('训练', () => {
  test('在有信号的合成数据上验证 LogLoss 下降', () => {
    const train = Array.from({ length: 30 }, (_, i) => makeSeq(i + 1, 16, `tr${i}`));
    const val = Array.from({ length: 8 }, (_, i) => makeSeq(1000 + i, 16, `va${i}`));
    const model = new GruDkt(VOCAB, { maxEpochs: 20, earlyStoppingPatience: 20 });
    const res = model.fit(train, val);
    expect(res.curve[0].valLogLoss).toBeGreaterThan(res.curve[res.curve.length - 1].valLogLoss);
    expect(res.bestValLogLoss).toBeLessThan(0.69);
  });

  test('早停触发并回滚到验证集最优参数', () => {
    // 无信号数据：验证 LogLoss 停滞 → 早停
    let s = 1;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const noise = (id) => ({
      userId: id,
      items: Array.from({ length: 12 }, () => ({ kpCode: rnd() < 0.5 ? 'k1' : 'k2', correct: rnd() < 0.5 ? 1 : 0 }))
    });
    const train = Array.from({ length: 20 }, (_, i) => noise(`tr${i}`));
    const val = Array.from({ length: 6 }, (_, i) => noise(`va${i}`));
    const model = new GruDkt(VOCAB, { maxEpochs: 30, earlyStoppingPatience: 3 });
    const res = model.fit(train, val);
    expect(res.stoppedEarly).toBe(true);
    expect(res.epochsRun).toBeLessThan(30);
    // 回滚验证：当前参数在验证集上的 LogLoss = 最优值
    const valNow = model.meanLogLoss(val).logLoss;
    expect(Math.abs(valNow - res.bestValLogLoss)).toBeLessThan(1e-4);
  });

  test('评估模式的 meanLogLoss 与手动 BCE 一致', () => {
    const items = [
      { kpCode: 'k1', correct: 1 }, { kpCode: 'k2', correct: 0 }
    ];
    const model = new GruDkt(VOCAB, { embedDim: 4, hiddenSize: 6 });
    const seqs = [{ userId: 'u1', items }];
    const { logLoss, targets } = model.meanLogLoss(seqs);
    expect(targets).toBe(1);
    const p = model.predictSequence(items)[0].pred;
    const y = items[1].correct;
    const manual = -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    expect(Math.abs(logLoss - manual)).toBeLessThan(1e-9);
  });
});
