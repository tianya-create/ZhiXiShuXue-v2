const { evaluateMetrics, rocAUC } = require('../models/baselineEval')
const { buildEvaluator, bootstrapAllModels, bootstrapCIs, pairedComparison } = require('../models/bootstrapStats')

// 固定种子构造一组带并列预测值的样本，用于对照两条计算路径
function fixture(n = 500, seed = 7) {
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  const rows = []
  for (let i = 0; i < n; i++) {
    // 刻意把预测值量化到 0.1 的网格上，制造大量并列
    const pred = Math.round((0.2 + rand() * 0.6) * 10) / 10
    rows.push({
      userId: `u${i % 40}`,
      kpCode: `kp${i % 7}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      pred,
      target: rand() < 0.6 ? 1 : 0
    })
  }
  return rows
}

describe('加权 bootstrap 引擎与直接计算一致', () => {
  test('权重全为 1 时五项指标逐项等于 evaluateMetrics', () => {
    const rows = fixture()
    const direct = evaluateMetrics(rows)
    const evaluator = buildEvaluator(rows)
    const weighted = evaluator.evaluate(new Float64Array(rows.length).fill(1))
    // evaluateMetrics 对外输出保留 4 位小数，因此按 4 位比较
    expect(weighted.AUC).toBeCloseTo(direct.AUC, 4)
    expect(weighted.LogLoss).toBeCloseTo(direct.LogLoss, 4)
    expect(weighted.Brier).toBeCloseTo(direct.Brier, 4)
    expect(weighted.Accuracy).toBeCloseTo(direct.Accuracy, 4)
    expect(weighted.F1).toBeCloseTo(direct.F1, 4)
  })

  test('并列预测值的 AUC 与 rocAUC 一致（平均秩处理）', () => {
    const pairs = [
      { pred: 0.5, target: 1 }, { pred: 0.5, target: 0 },
      { pred: 0.9, target: 1 }, { pred: 0.1, target: 0 },
      { pred: 0.5, target: 1 }, { pred: 0.5, target: 0 }
    ]
    const rows = pairs.map((p, i) => ({
      userId: `u${i}`, kpCode: 'k', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...p
    }))
    const evaluator = buildEvaluator(rows)
    const weighted = evaluator.evaluate(new Float64Array(rows.length).fill(1))
    expect(weighted.AUC).toBeCloseTo(rocAUC(pairs), 10)
  })

  test('复制权重等价于复制样本（AUC 只依赖相对权重）', () => {
    const rows = fixture(200, 3)
    const evaluator = buildEvaluator(rows)
    const doubled = evaluator.evaluate(new Float64Array(rows.length).fill(2))
    const single = evaluator.evaluate(new Float64Array(rows.length).fill(1))
    expect(doubled.AUC).toBeCloseTo(single.AUC, 10)
    expect(doubled.LogLoss).toBeCloseTo(single.LogLoss, 10)
    expect(doubled.n).toBe(rows.length * 2)
  })
})

describe('多模型联合 bootstrap', () => {
  test('置信区间包含点估计，且配对差均值等于两模型点估计之差', () => {
    const rowsA = fixture(600, 11)
    // B 模型是 A 的噪声版本，二者预测相关
    const rowsB = rowsA.map((r, i) => ({ ...r, pred: Math.min(0.99, Math.max(0.01, r.pred + (i % 5 === 0 ? 0.1 : -0.05))) }))
    const boot = bootstrapAllModels({ A: rowsA, B: rowsB }, { reps: 200, seed: 5 })
    const pointA = evaluateMetrics(rowsA).AUC
    const pointB = evaluateMetrics(rowsB).AUC

    expect(boot.ciByModel.A.AUC[0]).toBeLessThanOrEqual(pointA)
    expect(boot.ciByModel.A.AUC[1]).toBeGreaterThanOrEqual(pointA)
    expect(boot.comparisons).toHaveLength(1)
    expect(boot.comparisons[0].dAUC.meanDiff).toBeCloseTo(pointA - pointB, 2)
    expect(boot.comparisons[0].dAUC.ci[0]).toBeLessThanOrEqual(boot.comparisons[0].dAUC.ci[1])
  })

  test('同种子下结果可复现', () => {
    const rows = fixture(300, 13)
    const a = bootstrapAllModels({ A: rows }, { reps: 50, seed: 99 })
    const b = bootstrapAllModels({ A: rows }, { reps: 50, seed: 99 })
    expect(a.ciByModel.A.AUC).toEqual(b.ciByModel.A.AUC)
  })

  test('两模型预测完全相同时 Δ=0 且 p=1（不能因为平滑而误报显著）', () => {
    const base = fixture(200, 31)
    const boot = bootstrapAllModels({ A: base, B: base.map((r) => ({ ...r })) }, { reps: 100, seed: 9 })
    expect(boot.comparisons[0].dAUC.meanDiff).toBe(0)
    expect(boot.comparisons[0].dAUC.ci).toEqual([0, 0])
    expect(boot.comparisons[0].dAUC.p).toBe(1)
  })

  test('样本数不一致的模型会显式报错（避免错位配对）', () => {
    const rowsA = fixture(100, 1)
    const rowsB = fixture(99, 1)
    expect(() => bootstrapAllModels({ A: rowsA, B: rowsB }, { reps: 5 })).toThrow(/预测样本数一致/)
  })

  test('bootstrapCIs / pairedComparison 兼容旧接口', () => {
    // A 的预测带真实信号，B 是反向预测 → A 的 AUC 应显著更高
    const rowsA = fixture(300, 21).map((r, i) => ({
      ...r,
      pred: r.target === 1 ? 0.8 + (i % 3) * 0.02 : 0.2 + (i % 3) * 0.02
    }))
    const rowsB = rowsA.map((r) => ({ ...r, pred: 1 - r.pred }))
    const ci = bootstrapCIs(rowsA, { reps: 40, seed: 3 })
    expect(ci.AUC).toHaveLength(2)
    expect(ci.LogLoss).toHaveLength(2)
    const paired = pairedComparison(rowsA, rowsB, { reps: 40, seed: 3 })
    expect(paired.pairedRows).toBe(rowsA.length)
    expect(paired.dAUC.meanDiff).toBeGreaterThan(0.5)
  })
})
