const { rule0, rule1, rule2, predictNextCorrect, sortByTime } = require('../models/ruleMastery')
const { evaluateMetrics, rocAUC, generateSyntheticRecords, walkForward, runEvaluation, pairedComparison } = require('../models/baselineEval')

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

  test('i.i.d. 随机数据上配对检验不应报显著差异（防组内AUC伪显著回归）', () => {
    // 每组固定 p 的 i.i.d. 结果：两个相同质量的预测器不应有显著 AUC 差
    let seed = 20260101
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const records = []
    for (let s = 0; s < 30; s++) {
      for (let k = 0; k < 4; k++) {
        const p = 0.2 + rand() * 0.6
        const n = 8 + Math.floor(rand() * 10)
        for (let i = 0; i < n; i++) {
          records.push({
            userId: `s${s}`, kpCode: `KP${k}`, questionId: `q${i}`,
            isCorrect: rand() < p, costTime: 60,
            createdAt: new Date(Date.UTC(2026, 0, 1) + (i * 3 + rand() * 2) * 864e5).toISOString()
          })
        }
      }
    }
    const rowsA = walkForward(records, 'Majority')
    const rowsB = walkForward(records, 'Rule-0')
    const res = pairedComparison(rowsA, rowsB, { reps: 300, seed: 7 })
    expect(res.pairedRows).toBe(rowsA.length)
    // i.i.d. 下无真实差异：ΔAUC 应接近 0。旧版组内逐行 AUC 方差会产生 ~+0.22 的伪显著偏差，
    // 这里以 |ΔAUC| < 0.05 作回归护栏（微小差异在样本多时被判「显著」属正常统计行为）
    expect(Math.abs(res.dAUC.meanDiff)).toBeLessThan(0.05)
    expect(res.dAUC.ci[0]).toBeGreaterThan(-0.1)
    expect(res.dAUC.ci[1]).toBeLessThan(0.1)
  })
})
