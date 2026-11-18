'use strict';

/**
 * priorSignalProbe.test.js —— 先修信息探针纯函数测试（方案 §6.3 十条全覆盖）
 */

const fs = require('fs');
const path = require('path');

const {
  logitClip,
  log1pSafe,
  aucOf,
  logLossOf,
  neighborSetsFromEdges,
  parseEdgeCsv,
  emptyStudentState,
  updateStudentState,
  computeTargetFeatures,
  groupKFold,
  trainLR,
  predictLR,
  fitScaler,
  transformRows,
  stumpBoostTrain,
  stumpBoostPredict,
} = require('../models/priorSignalProbe');

describe('数值边界（§6.3-8）', () => {
  test('logitClip：p=0 / p=1 不产生 Infinity', () => {
    expect(Number.isFinite(logitClip(0))).toBe(true);
    expect(Number.isFinite(logitClip(1))).toBe(true);
    expect(logitClip(0.5)).toBeCloseTo(0);
    expect(logitClip(0)).toBe(logitClip(1e-12));
  });

  test('log1pSafe：负数输入钳为 0', () => {
    expect(log1pSafe(-5)).toBe(0);
    expect(log1pSafe(0)).toBe(0);
    expect(log1pSafe(9)).toBeCloseTo(Math.log(10));
  });

  test('aucOf：单类返回 null 而不报错（§6.3-10）', () => {
    expect(aucOf([{ p: 0.9, y: 1 }])).toBeNull();
    expect(aucOf([{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }])).toBeCloseTo(1);
  });
});

describe('邻居表构造（§6.3-4/5）', () => {
  const rows = [['a', 'k', 3], ['k', 'b', 5], ['a', 'k', 1]];

  test('有向：N(k)={a}，且 N(a) 为空', () => {
    const adj = neighborSetsFromEdges(rows, { directed: true });
    expect([...adj.get('k').keys()]).toEqual(['a']);
    expect(adj.has('a')).toBe(false);
  });

  test('无向：(a,k) 与 (k,a) 都进 N；同邻居重复边取最大权重（§6.3-5）', () => {
    const adj = neighborSetsFromEdges(rows, { directed: false });
    expect(adj.get('k').get('a')).toBe(3);
    expect(adj.get('a').get('k')).toBe(3);
    expect(adj.get('k').get('b')).toBe(5);
    expect(adj.get('b').get('k')).toBe(5);
  });

  test('parseEdgeCsv：prior（confidence 权重）与 graph（support/one）两种格式', () => {
    const prior = parseEdgeCsv('sourceKp,targetKp,confidence,votes,reason\ns1,s2,3,2,"x"\n', 'confidence');
    expect(prior).toEqual([['s1', 's2', 3]]);
    const graph = parseEdgeCsv('sourceIndex,targetIndex,sourceKp,targetKp,support\n0,1,s1,s2,44\n', 'support');
    expect(graph).toEqual([['s1', 's2', 44]]);
    const one = parseEdgeCsv('sourceIndex,targetIndex,sourceKp,targetKp,support\n0,1,s1,s2,44\n', 'one');
    expect(one).toEqual([['s1', 's2', 1]]);
  });
});

describe('目标特征与因果性（§6.3-1/2/3）', () => {
  const kcTrainAcc = { K: 0.7, N1: 0.7, N2: 0.4 };
  const neighbors = new Map([['N1', 3], ['N2', 1]]);
  const target = { predFull: 0.8, kcCode: 'K', seqIndex: 4, ts: 10 * 60000 };

  function feed(state, recs) {
    for (const r of recs) updateStudentState(state, r);
    return state;
  }

  test('m=0：六项邻居特征按缺失口径（§6.3-2）', () => {
    const state = feed(emptyStudentState(), [
      { kpCode: 'K', isCorrect: 1, ts: 60000 },
      { kpCode: 'K', isCorrect: 0, ts: 2 * 60000 },
      { kpCode: 'K', isCorrect: 1, ts: 3 * 60000 },
    ]);
    const f = computeTargetFeatures({ ...target, state, neighbors: null, kcTrainAcc });
    expect(f.nb.nb_missing).toBe(1);
    expect(f.nb.nb_cov).toBe(0);
    expect(f.nb.nb_recent20).toBe(0);
    expect(f.nb.nb_recent_acc).toBeNull();
    expect(f.nb.nb_last_correct).toBeNull();
    expect(f.nb.nb_gap_log).toBeNull();
    expect(f.base.kc_train_acc).toBeCloseTo(0.7);
    expect(f.base.hist_len_log).toBeCloseTo(Math.log(4));
  });

  test('有邻居作答：加权平均 + 权重归一（§6.3-3）', () => {
    // N1 最近5次全对(acc=1)，N2 最近5次全错(acc=0)；权重 3:1 → (3*1+1*0)/4=0.75
    const state = emptyStudentState();
    for (let i = 1; i <= 5; i += 1) updateStudentState(state, { kpCode: 'N1', isCorrect: 1, ts: i * 60000 });
    for (let i = 1; i <= 5; i += 1) updateStudentState(state, { kpCode: 'N2', isCorrect: 0, ts: i * 60000 });
    updateStudentState(state, { kpCode: 'K', isCorrect: 1, ts: 6 * 60000 });
    const f = computeTargetFeatures({ ...target, ts: 7 * 60000, seqIndex: 12, state, neighbors, kcTrainAcc });
    expect(f.nb.nb_missing).toBe(0);
    expect(f.nb.nb_cov).toBeCloseTo(1);
    expect(f.nb.nb_recent_acc).toBeCloseTo(0.75);
    expect(f.nb.nb_last_correct).toBe(1); // N1 最后一次 ts=5min 更近
    expect(f.nb.nb_recent20).toBe(10);
  });

  test('删掉一个邻居后 nb_recent_acc 仍在 [0,1]', () => {
    const state = emptyStudentState();
    for (let i = 1; i <= 5; i += 1) updateStudentState(state, { kpCode: 'N1', isCorrect: 1, ts: i * 60000 });
    updateStudentState(state, { kpCode: 'K', isCorrect: 1, ts: 6 * 60000 });
    const f = computeTargetFeatures({ ...target, ts: 7 * 60000, seqIndex: 7, state, neighbors: new Map([['N1', 3], ['N2', 1]]), kcTrainAcc });
    expect(f.nb.nb_recent_acc).toBeGreaterThanOrEqual(0);
    expect(f.nb.nb_recent_acc).toBeLessThanOrEqual(1);
    expect(f.nb.nb_recent_acc).toBeCloseTo(1);
  });

  test('因果性：注入 t 之后的交互，特征输出不变（§6.3-1）', () => {
    const before = [
      { kpCode: 'K', isCorrect: 1, ts: 60000 },
      { kpCode: 'K', isCorrect: 0, ts: 2 * 60000 },
      { kpCode: 'N1', isCorrect: 1, ts: 3 * 60000 },
    ];
    const future = { kpCode: 'N2', isCorrect: 0, ts: 20 * 60000 };
    const run = (recs) => {
      // 复刻主循环：目标时刻先取特征，再并入状态
      const state = emptyStudentState();
      let out = null;
      for (const r of recs) {
        if (r.isTarget) {
          out = computeTargetFeatures({ ...target, ts: r.ts, seqIndex: r.seqIndex, state, neighbors, kcTrainAcc });
        }
        updateStudentState(state, { kpCode: r.kpCode, isCorrect: r.isCorrect, ts: r.ts });
      }
      return out;
    };
    const seq = [...before.map((r, i) => ({ ...r, seqIndex: i + 1 })), { kpCode: 'K', isCorrect: 1, ts: 10 * 60000, seqIndex: 4, isTarget: true }, { ...future, seqIndex: 5 }];
    const withFuture = run(seq);
    const withoutFuture = run(seq.slice(0, 4));
    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(withoutFuture));
  });
});

describe('GroupKFold（§6.3-6）', () => {
  test('同一学生只出现在一折；所有学生都被分配', () => {
    const users = Array.from({ length: 40 }, (_, i) => `u${i}`);
    const a = groupKFold(users, 5, 20261109);
    const b = groupKFold(users, 5, 20261109);
    expect(JSON.stringify([...a])).toBe(JSON.stringify([...b])); // 确定性
    const counts = new Array(5).fill(0);
    for (const f of a.values()) counts[f] += 1;
    expect(counts.reduce((x, y) => x + y, 0)).toBe(40);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe('LR / 复核模型 / 缺失处理', () => {
  test('IRLS 逻辑回归在可分数据上 AUC=1（§6.3 无报错收敛）', () => {
    const rows = [];
    const y = [];
    for (let i = 0; i < 50; i += 1) {
      rows.push([i / 50, 1]);
      y.push(0);
      rows.push([1 + i / 50, 1]);
      y.push(1);
    }
    const scaler = fitScaler(rows, ['x']);
    const X = transformRows(rows, scaler);
    const w = trainLR(X, y, 1.0);
    const p = predictLR(w, X);
    expect(aucOf(Array.from({ length: y.length }, (_, i) => ({ p: p[i], y: y[i] })))).toBeCloseTo(1);
  });

  test('transformRows：缺失补 0 + 缺失指示列=1', () => {
    const rows = [[0, 1], [2, Number.NaN]];
    const scaler = fitScaler(rows, ['a', 'nb_recent_acc']);
    const X = transformRows(rows, scaler, [1]);
    expect(Number.isFinite(X[0][0])).toBe(true);
    expect(X[1][1]).toBe(0); // 缺失标准化后补 0
    expect(X[1][2]).toBe(1); // 缺失指示
    expect(X[0][2]).toBe(0);
    expect(X[0][3]).toBe(1); // 截距
  });

  test('桩提升复核：非线性可分数据上 OOF 风格损失优于常数基线', () => {
    const rows = [];
    const y = [];
    for (let i = 0; i < 60; i += 1) {
      const x = i / 60;
      rows.push([x, 1]);
      y.push(x > 0.5 ? 1 : 0);
    }
    const model = stumpBoostTrain(rows, y, { bins: 8, rounds: 60, lr: 0.5 });
    const p = stumpBoostPredict(model, rows);
    const ll = logLossOf(Array.from({ length: y.length }, (_, i) => ({ p: p[i], y: y[i] })));
    const base = logLossOf(Array.from({ length: y.length }, (_, i) => ({ p: 0.5, y: y[i] })));
    expect(ll).toBeLessThan(base);
  });
});

describe('索引与边文件一致性（§6.3-9，集成）', () => {
  const backend = path.join(__dirname, '..');
  const pkgRoot = path.join(backend, '..');
  // 仓库布局：backend/datasets/...；材料包布局：<pkg>/dataset/...
  const priorEdgesPath = [
    path.join(backend, 'datasets/assist2009/prior-edges.csv'),
    path.join(pkgRoot, 'dataset/assist2009/prior-edges.csv'),
  ].find((p) => fs.existsSync(p));
  test('prior-edges 的 kpCode 都在 graph-nodes.json 索引表内且逐条一致', () => {
    expect(priorEdgesPath).toBeDefined(); // 两种布局至少一处存在
    const graphNodesPath = [
      path.join(backend, '实验结果文件/gcn-dkt-v1/seed-42/graph-nodes.json'),
      path.join(pkgRoot, '实验结果文件/gcn-dkt-v1/seed-42/graph-nodes.json'),
    ].find((p) => fs.existsSync(p));
    expect(graphNodesPath).toBeDefined();
    const nodesDoc = JSON.parse(fs.readFileSync(graphNodesPath, 'utf8'));
    const nodeArr = Array.isArray(nodesDoc) ? nodesDoc : nodesDoc.nodes;
    const kpIndex = new Map(nodeArr.map((n) => [n.kpCode, n.index]));
    const rows = parseEdgeCsv(fs.readFileSync(priorEdgesPath, 'utf8'), 'confidence');
    expect(rows.length).toBeGreaterThanOrEqual(40);
    for (const [a, b] of rows) {
      expect(kpIndex.has(a)).toBe(true);
      expect(kpIndex.has(b)).toBe(true);
      expect(a).not.toBe(b); // 无自环
    }
  });

  test('OOF 覆盖：GroupKFold 折预测条数之和=总数、targetKey 无重复（§6.3-7，构造验证）', () => {
    const users = Array.from({ length: 12 }, (_, i) => `u${i}`);
    const assign = groupKFold(users, 5, 20261109);
    const keys = users.map((u) => `${u}|t1`);
    const foldRows = Array.from({ length: 5 }, () => []);
    keys.forEach((k) => foldRows[assign.get(k.split('|')[0])].push(k));
    const all = foldRows.flat();
    expect(all.length).toBe(12);
    expect(new Set(all).size).toBe(12);
  });
});
