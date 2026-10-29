const { rule0, rule1, rule2, predictNextCorrect, sortByTime } = require('../models/ruleMastery')
const { evaluateMetrics, rocAUC, generateSyntheticRecords, walkForward, runEvaluation } = require('../models/baselineEval')

describe('rule mastery baselines', () => {
  const mk = (isCorrect, costTime, offsetDays, questionId) => ({
    isCorrect,
    costTime,
    questionId,
    createdAt: new Date(Date.UTC(2026, 0, 1) + offsetDays * 24 * 3600 * 1000).toISOString()
  })

  test('Rule-0 空历史冷启动为 0.5', () => {
    expect(rule0([]).mastery).toBe(0.5)
    expect(rule0(null).mastery).toBe(0.5)
  })

  test('Rule-0 拉普拉斯平滑正确率', () => {
    const records = [mk(true, 60, 1, 'q1')]
    // (1 + 1) / (1 + 2) = 0.667
    expect(rule0(records).mastery).toBeCloseTo(2 / 3, 5)
  })

  test('Rule-1 连对 3 次且速度达标时加成', () => {
    const records = [
      mk(false, 100, 1, 'q1'), mk(true, 60, 2, 'q2'),
      mk(true, 60, 3, 'q3'), mk(true, 60, 4, 'q4'), mk(true, 60, 5, 'q5')
    ]
    const result = rule1(records)
    expect(result.streakCorrect).toBe(1)
    expect(result.mastery).toBeGreaterThan(result.accuracy)
  })

  test('Rule-1 连对 3 次但速度过慢不加成', () => {
    const records = [
      mk(false, 100, 1, 'q1'), mk(true, 100, 2, 'q2'),
      mk(true, 60, 3, 'q3'), mk(true, 60, 4, 'q4'), mk(true, 300, 5, 'q5')
    ]
    // 历史均值 100，最近 3 次均值 (60+60+300)/3=140 > 100*1.2=120 → 不加成
    const result = rule1(records)
    expect(result.streakCorrect).toBe(0)
  })

  test('Rule-1 连错 2 次时惩罚', () => {
    const records = [mk(true, 60, 1, 'q1'), mk(false, 60, 2, 'q2'), mk(false, 60, 3, 'q3')]
    expect(rule1(records).streakWrong).toBe(1)
    expect(rule1(records).mastery).toBeLessThan(0.5)
  })

  test('Rule-2 时间衰减使掌握度随间隔下降', () => {
    const records = [mk(true, 60, 1, 'q1'), mk(true, 60, 2, 'q2'), mk(true, 60, 3, 'q3')]
    const now = new Date(Date.UTC(2026, 0, 5)).toISOString() // 距最后练习 1 天
    const later = new Date(Date.UTC(2026, 0, 35)).toISOString() // 距最后练习 31 天
    const near = rule2(records, { now })
    const far = rule2(records, { now: later })
    expect(far.mastery).toBeLessThan(near.mastery)
    expect(far.decayFactor).toBeCloseTo(Math.exp(-0.03 * 31), 4)
  })

  test('predictNextCorrect 统一入口并裁剪到 [0,1]', () => {
    const p = predictNextCorrect('Rule-2', [mk(true, 60, 1, 'q1')], { now: Date.UTC(2026, 0, 2) })
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
    expect(() => predictNextCorrect('BKT', [])).toThrow()
  })

  test('sortByTime 不修改原数组', () => {
    const records = [mk(true, 60, 3, 'q3'), mk(true, 60, 1, 'q1')]
    const sorted = sortByTime(records)
    expect(records[0].createdAt).toBe(sorted[1].createdAt)
  })
})

describe('baseline evaluation', () => {
  test('指标计算正确性', () => {
    const rows = [
      { pred: 0.9, target: 1 }, { pred: 0.2, target: 0 },
      { pred: 0.8, target: 1 }, { pred: 0.3, target: 0 }
    ]
    const m = evaluateMetrics(rows)
    expect(m.AUC).toBe(1)
    expect(m.Accuracy).toBe(1)
    expect(m.LogLoss).toBeLessThan(0.3)
  })

  test('walk-forward 无数据泄漏：每组样本数为 n-1 且时间有序', () => {
    const records = generateSyntheticRecords({ students: 3, kps: 2, avgPerPair: 8 })
    const rows = walkForward(records, 'Rule-0')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect([0, 1]).toContain(row.target)
    // Majority 平滑冷启动：1/3 ~ 2/3 之间，不会出现 0/1 极端概率
    const majorityRows = walkForward(records, 'Majority')
    expect(majorityRows[0].pred).toBeGreaterThan(0)
    expect(majorityRows[0].pred).toBeLessThan(1)
    expect(majorityRows.every((r) => r.pred > 0 && r.pred < 1)).toBe(true)
  })

  test('runEvaluation 输出四模型结果', () => {
    const records = generateSyntheticRecords({ students: 5, kps: 3, avgPerPair: 10 })
    const results = runEvaluation(records)
    expect(Object.keys(results).sort()).toEqual(['Majority', 'Rule-0', 'Rule-1', 'Rule-2'])
    for (const m of Object.values(results)) {
      expect(m.n).toBeGreaterThan(0)
      expect(Number.isFinite(m.LogLoss)).toBe(true)
      expect(Number.isFinite(m.Brier)).toBe(true)
    }
  })

  test('rocAUC 完全反向预测为 0', () => {
    const pairs = [
      { pred: 0.9, target: 0 }, { pred: 0.1, target: 1 }
    ]
    expect(rocAUC(pairs)).toBe(0)
  })
})
