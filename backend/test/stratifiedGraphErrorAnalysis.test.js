'use strict';

/**
 * stratifiedGraphErrorAnalysis.test.js —— 分层误差分析纯函数测试（探索性工具）
 *
 * 覆盖：度数表/分层桶边界、AUC 平均秩（含并列与单类拒绝）、LogLoss 截断、
 * 分层聚合的确定性、interactions 元数据对齐。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  degreeMapFromEdges,
  bucketOfDegree,
  bucketOfHistory,
  bucketOfActivity,
  aucOf,
  logLossOf,
  stratify,
  metricsForPairs,
  loadInteractionMeta,
} = require('../models/stratifiedGraphErrorAnalysis');

describe('degreeMapFromEdges / 分层桶边界', () => {
  test('无权度与加权度', () => {
    const { deg, weighted } = degreeMapFromEdges([
      'sourceIndex,targetIndex,sourceKp,targetKp,support',
      '0,5,s1,s13,60',
      '0,6,s1,s15,44',
      '5,6,s13,s15,10',
    ]);
    expect(deg.get('s1')).toBe(2);
    expect(deg.get('s13')).toBe(2);
    expect(deg.get('s15')).toBe(2);
    expect(weighted.get('s1')).toBe(104);
    expect(weighted.get('s13')).toBe(70);
  });

  test('表头行被跳过，坏行抛错', () => {
    expect(() => degreeMapFromEdges(['0,5,s1,,x'])).toThrow(/格式异常/);
    expect(degreeMapFromEdges(['sourceIndex,targetIndex,sourceKp,targetKp,support']).deg.size).toBe(0);
  });

  test('度数桶：0 / 1-2 / 3+', () => {
    expect(bucketOfDegree(0)).toBe('isolated');
    expect(bucketOfDegree(1)).toBe('low(1-2)');
    expect(bucketOfDegree(2)).toBe('low(1-2)');
    expect(bucketOfDegree(3)).toBe('hub(3+)');
    expect(bucketOfDegree(7)).toBe('hub(3+)');
    expect(() => bucketOfDegree(-1)).toThrow();
    expect(() => bucketOfDegree(1.5)).toThrow();
  });

  test('历史长度与活跃度桶', () => {
    expect(bucketOfHistory(0)).toBe('h0-5');
    expect(bucketOfHistory(5)).toBe('h0-5');
    expect(bucketOfHistory(6)).toBe('h6-15');
    expect(bucketOfHistory(15)).toBe('h6-15');
    expect(bucketOfHistory(16)).toBe('h16plus');
    expect(bucketOfActivity(1)).toBe('act1-10');
    expect(bucketOfActivity(10)).toBe('act1-10');
    expect(bucketOfActivity(11)).toBe('act11-30');
    expect(bucketOfActivity(30)).toBe('act11-30');
    expect(bucketOfActivity(31)).toBe('act31plus');
    expect(() => bucketOfActivity(0)).toThrow();
  });
});

describe('aucOf 平均秩', () => {
  test('完全可分 = 1，完全反向 = 0', () => {
    expect(aucOf([{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }, { p: 0.2, y: 0 }, { p: 0.1, y: 0 }])).toBeCloseTo(1);
    expect(aucOf([{ p: 0.1, y: 1 }, { p: 0.2, y: 1 }, { p: 0.8, y: 0 }, { p: 0.9, y: 0 }])).toBeCloseTo(0);
  });

  test('并列值用平均秩：与手算一致', () => {
    // pos=[0.5,0.5], neg=[0.3]：秩 0.5→1.5+2/2=1.75? 平均秩=(1+2)/2=1.5（并列两名），0.3→3
    // rankSumPos = 1.5*2=3, U=3-3=0? n1=2,n0=1 → AUC=(3-3)/2=0
    // 手算核对：正类两个 0.5 都大于 0.3 → AUC 应为 1
    // 平均秩: 0.3 秩1；两个0.5并列秩 (2+3)/2=2.5 → rankSumPos=5, U=5-3=2, AUC=2/2=1
    expect(aucOf([{ p: 0.5, y: 1 }, { p: 0.5, y: 1 }, { p: 0.3, y: 0 }])).toBeCloseTo(1);
  });

  test('随机打分 AUC=0.5（并列），单类返回 null', () => {
    expect(aucOf([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }])).toBeCloseTo(0.5);
    expect(aucOf([{ p: 0.4, y: 1 }, { p: 0.6, y: 0 }])).toBeCloseTo(0);
    expect(aucOf([{ p: 0.4, y: 1 }, { p: 0.5, y: 1 }])).toBeNull();
    expect(aucOf([{ p: 0.4, y: 0 }])).toBeNull();
  });
});

describe('logLossOf / metricsForPairs', () => {
  test('LogLoss 手算一致（p=0.5 两类对称）', () => {
    expect(logLossOf([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }])).toBeCloseTo(-Math.log(0.5));
  });

  test('p 越界截断到 [1e-7, 1-1e-7]', () => {
    const ll = logLossOf([{ p: 0, y: 1 }]);
    expect(ll).toBeCloseTo(-Math.log(1e-7), 5);
  });

  test('metricsForPairs 配对差值：dAuc = B − A', () => {
    const recs = [
      { predFull: 0.9, predGcn: 0.1, predRandom: 0.1, target: 1 },
      { predFull: 0.1, predGcn: 0.9, predRandom: 0.9, target: 0 },
    ];
    const m = metricsForPairs(recs, 'predFull', 'predGcn');
    expect(m.aucA).toBeCloseTo(1); // Full：正例 0.9 > 负例 0.1
    expect(m.aucB).toBeCloseTo(0); // GCN：正例 0.1 < 负例 0.9
    expect(m.dAuc).toBeCloseTo(-1);
  });
});

describe('stratify / loadInteractionMeta', () => {
  const recs = [
    { target: 1, predFull: 0.8, predGcn: 0.9, predRandom: 0.85, degree: 0, history: 3, activity: 5 },
    { target: 0, predFull: 0.7, predGcn: 0.6, predRandom: 0.65, degree: 4, history: 20, activity: 40 },
    { target: 1, predFull: 0.6, predGcn: 0.7, predRandom: 0.5, degree: 1, history: 10, activity: 15 },
    { target: 0, predFull: 0.3, predGcn: 0.2, predRandom: 0.4, degree: 2, history: 30, activity: 50 },
  ];

  test('三个维度都产出桶且记录归桶正确', () => {
    const s = stratify(recs);
    expect(Object.keys(s.degree).sort()).toEqual(['hub(3+)', 'isolated', 'low(1-2)'].sort());
    expect(s.degree.isolated.n).toBe(1);
    expect(s.history['h6-15'].n).toBe(1);
    expect(s.activity.act31plus.n).toBe(2);
    // isolated 桶只有 1 条正例 → 单类，AUC 必须拒绝为 null
    expect(s.degree.isolated.aucFull).toBeNull();
    expect(s.degree.isolated.dAucGcnMinusFull).toBeNull();
    // 两类齐全的桶 AUC 可用
    expect(s.degree['low(1-2)'].aucFull).not.toBeNull();
  });

  test('loadInteractionMeta：键对齐与活跃度取最大 sequenceIndex', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-'));
    const csvPath = path.join(tmp, 'interactions.csv');
    fs.writeFileSync(csvPath, [
      'userId,questionId,kpCode,isCorrect,costTime,createdAt,sequenceIndex',
      'u1,q1,k1,1,10,2000-01-01T00:01:00.000Z,1',
      'u1,q2,k2,0,10,2000-01-01T00:02:00.000Z,2',
      'u2,q3,k1,1,10,2000-01-01T00:01:00.000Z,1',
    ].join('\n'));
    const meta = loadInteractionMeta(csvPath);
    expect(meta.rows).toBe(3);
    expect(meta.duplicateKeys).toBe(0);
    expect(meta.seqByKey.get('u1|2000-01-01T00:02:00.000Z')).toBe(2);
    expect(meta.activity.get('u1')).toBe(2);
    expect(meta.activity.get('u2')).toBe(1);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
