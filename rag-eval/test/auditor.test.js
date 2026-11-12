const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { auditRun, ksStatistic, cohensKappa } = require('../src/audit/auditor');
const { bootstrapArms } = require('../src/stats/bootstrap');

/** 构造一个应全绿的最小合法 run（4 query × N/R/X × 2 samples） */
function makeGoodInput(overrides = {}) {
  const queries = [0, 1, 2, 3].map((i) => ({
    queryId: `q${i}`,
    queryClusterId: `qg-${i}`,
    goldDocClusterIds: [`DC${i}`]
  }));
  const perQuery = {};
  for (const q of queries) {
    const i = Number(q.queryId.slice(1));
    const id = q.queryId;
    // 逐 query 分数不同：保证 bootstrap 重采样分布依赖种子（否则 H8.3 无法测出种子错配）
    perQuery[id] = {
      N: { scores: [0.30 + 0.02 * i, 0.34 + 0.02 * i] },
      R: { chars: 500, chunkCount: 3, docClusterIds: [`DC${i}`], scores: [0.80 - 0.01 * i, 0.84 - 0.01 * i] },
      X: { chars: 500, chunkCount: 3, docClusterIds: [`DX${i}`], scores: [0.45 + 0.015 * i, 0.47 + 0.015 * i] }
    };
  }
  const rowsByArm = {};
  for (const arm of ['N', 'R', 'X']) {
    rowsByArm[arm] = queries.map((q) => {
      const s = perQuery[q.queryId][arm].scores;
      return { userId: q.queryId, score: (s[0] + s[1]) / 2 };
    });
  }
  const boot = bootstrapArms(rowsByArm, { reps: 200, seed: 7 });
  const armMeans = {};
  for (const [arm, v] of Object.entries(boot.ciByArm)) armMeans[arm] = v.meanExact;
  const summary = {
    armMeans,
    comparisons: boot.comparisons
      .filter((c) => (c.a === 'R' && c.b === 'X') || (c.a === 'N' && c.b === 'R') || (c.a === 'N' && c.b === 'X'))
      .map((c) => ({ a: c.a, b: c.b, deltaMeanExact: c.pointDiff, deltaCI: c.deltaCI, deltaCI4: c.deltaCI4, supportFlag: c.supportFlag }))
  };
  const config = {
    protocolVersion: 'test-v1', frozenBeforeRun: true, frozenAt: '2026-11-12',
    bootstrap: { reps: 200, seed: 7 }
  };
  const base = {
    config,
    hashes: {
      configSha256: 'sha256:cfg', evalSetSha256: 'sha256:eval',
      corpusSha256: 'sha256:corpus', chunkManifestSha256: 'sha256:chunks', judgeRubricSha256: 'sha256:rubric'
    },
    freezeManifest: { configSha256: 'sha256:cfg', evalSetSha256: 'sha256:eval' },
    queries,
    perQuery,
    devQueryClusterIds: ['qg-d0'],
    devDocClusterIds: ['DD0'],
    fewShotQueryIds: ['dev0'],
    fewShotQueryClusterIds: ['qg-d0'],
    indexQueryIds: ['idx0'],
    judge: {
      minRejudgeAgreement: 0.9, minHumanKappa: 0.6,
      rejudge: Array.from({ length: 10 }, (_, i) => ({ original: i % 3, rejudged: i % 3 })),
      humanCalibration: Array.from({ length: 12 }, (_, i) => ({ judge: i % 3, human: i % 3 }))
    },
    summary,
    bootstrap: { reps: 200, seed: 7 },
    lengthTolerance: 0.02,
    ksThreshold: 0.2,
    requiredArms: ['N', 'R', 'X'],
    samplesPerQuery: 2
  };
  return deepMerge(base, overrides);
}

function deepMerge(target, patch) {
  const out = JSON.parse(JSON.stringify(target));
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const get = (r, id) => r.checks.find((c) => c.id === id);

describe('auditRun：合法输入全绿', () => {
  it('22 项检查全部通过', () => {
    const r = auditRun(makeGoodInput());
    assert.equal(r.checks.length, 22);
    assert.equal(r.allPassed, true, '失败项: ' + r.checks.filter((c) => !c.passed).map((c) => `${c.id} ${c.detail}`).join(' | '));
    assert.equal(r.failed, 0);
    assert.equal(Object.keys(r.byCategory).length, 8);
  });
});

describe('auditRun：C1 产物哈希', () => {
  it('freeze-manifest 不匹配 → H1.2 失败（配置被改过的信号）', () => {
    const r = auditRun(makeGoodInput({ freezeManifest: { configSha256: 'sha256:OTHER', evalSetSha256: 'sha256:eval' } }));
    assert.equal(get(r, 'H1.2').passed, false);
    assert.equal(r.allPassed, false);
  });

  it('缺 chunkManifest 哈希 → H1.1 失败', () => {
    const input = makeGoodInput();
    input.hashes.chunkManifestSha256 = null; // deepMerge 只覆盖不删键，显式置空
    const r = auditRun(input);
    assert.equal(get(r, 'H1.1').passed, false);
  });

  it('未冻结的配置 → H1.3 失败', () => {
    const input = makeGoodInput();
    input.config.frozenBeforeRun = false;
    input.config.frozenAt = null;
    const r = auditRun(input);
    assert.equal(get(r, 'H1.3').passed, false);
  });
});

describe('auditRun：C2 预算等长', () => {
  it('X 比 R 短 5% → H2.1 失败', () => {
    const input = makeGoodInput();
    for (const q of Object.keys(input.perQuery)) input.perQuery[q].X.chars = 475;
    const r = auditRun(input);
    assert.equal(get(r, 'H2.1').passed, false);
  });

  it('块数不等 → H2.2 失败', () => {
    const input = makeGoodInput();
    for (const q of Object.keys(input.perQuery)) input.perQuery[q].X.chunkCount = 4;
    const r = auditRun(input);
    assert.equal(get(r, 'H2.2').passed, false);
  });
});

describe('auditRun：C3 X 臂真实性', () => {
  it('X 偷用了 R 的簇 → H3.1 失败', () => {
    const input = makeGoodInput();
    for (const q of Object.keys(input.perQuery)) input.perQuery[q].X.docClusterIds[0] = input.perQuery[q].R.docClusterIds[0];
    const r = auditRun(input);
    assert.equal(get(r, 'H3.1').passed, false);
  });

  it('长度分布KS：一致分布 D≈0 通过', () => {
    const input = makeGoodInput();
    const r = auditRun(input);
    assert.equal(get(r, 'H3.2').passed, true);
    assert.ok(get(r, 'H3.2').detail.includes('D = 0.0000'));
  });
});

describe('auditRun：C4 泄漏断言', () => {
  it('dev/eval 共享 query 簇 → H4.1 失败', () => {
    const input = makeGoodInput();
    input.queries[0].queryClusterId = 'qg-d0';
    const r = auditRun(input);
    assert.equal(get(r, 'H4.1').passed, false);
  });

  it('eval gold doc 簇出现在 dev → H4.2 失败', () => {
    const r = auditRun(makeGoodInput({ devDocClusterIds: ['DD0', 'DC0'] }));
    assert.equal(get(r, 'H4.2').passed, false);
  });

  it('few-shot 示例取自 eval → H4.3 失败', () => {
    const r = auditRun(makeGoodInput({ fewShotQueryIds: ['dev0', 'q0'] }));
    assert.equal(get(r, 'H4.3').passed, false);
  });

  it('建索引用了 eval 查询（自检索）→ H4.4 失败', () => {
    const r = auditRun(makeGoodInput({ indexQueryIds: ['idx0', 'q1'] }));
    assert.equal(get(r, 'H4.4').passed, false);
  });
});

describe('auditRun：C5 指标可复算', () => {
  it('summary 臂均值被篡改 → H5.1 失败（聚合器不接受改过的成绩）', () => {
    const input = makeGoodInput();
    input.summary.armMeans.R += 0.01;
    const r = auditRun(input);
    assert.equal(get(r, 'H5.1').passed, false);
  });

  it('比较的点估计差与臂均值不一致 → H5.2 失败', () => {
    const input = makeGoodInput();
    input.summary.comparisons[0].deltaMeanExact += 0.005;
    const r = auditRun(input);
    assert.equal(get(r, 'H5.2').passed, false);
  });

  it('分数越界 → H5.3 失败', () => {
    const input = makeGoodInput();
    input.perQuery.q0.R.scores[0] = 1.5;
    const r = auditRun(input);
    assert.equal(get(r, 'H5.3').passed, false);
  });
});

describe('auditRun：C6 judge 一致性', () => {
  it('复判一致率 < 0.9 → H6.1 失败', () => {
    const input = makeGoodInput();
    input.judge.rejudge = Array.from({ length: 10 }, (_, i) => ({ original: i % 3, rejudged: i % 3 === 0 ? 1 : i % 3 }));
    const r = auditRun(input);
    assert.equal(get(r, 'H6.1').passed, false);
  });

  it('缺人工校准 → H6.2 失败（L3 不可用）', () => {
    const input = makeGoodInput();
    input.judge.humanCalibration = [];
    const r = auditRun(input);
    assert.equal(get(r, 'H6.2').passed, false);
  });
});

describe('auditRun：C7 三臂齐全', () => {
  it('某 query 缺 X 臂 → H7.1 失败', () => {
    const input = makeGoodInput();
    delete input.perQuery.q2.X;
    const r = auditRun(input);
    assert.equal(get(r, 'H7.1').passed, false);
  });

  it('样本数不符 → H7.2 失败；含 NaN → H7.3 失败', () => {
    const input = makeGoodInput();
    input.perQuery.q0.N.scores = [0.3];
    const r = auditRun(input);
    assert.equal(get(r, 'H7.2').passed, false);
    const input2 = makeGoodInput();
    input2.perQuery.q1.X.scores = [0.4, NaN];
    const r2 = auditRun(input2);
    assert.equal(get(r2, 'H7.3').passed, false);
  });
});

describe('auditRun：C8 CI 与标志自洽', () => {
  it('supportFlag 与未舍入 CI 矛盾 → H8.1 失败', () => {
    const input = makeGoodInput();
    input.summary.comparisons[0].supportFlag = !input.summary.comparisons[0].supportFlag;
    const r = auditRun(input);
    assert.equal(get(r, 'H8.1').passed, false);
  });

  it('deltaCI4 与 deltaCI 舍入关系破坏 → H8.2 失败', () => {
    const input = makeGoodInput();
    input.summary.comparisons[0].deltaCI4 = [0, 0];
    const r = auditRun(input);
    assert.equal(get(r, 'H8.2').passed, false);
  });

  it('summary CI 用了不同种子 → H8.3 失败（复跑不可复现）', () => {
    const input = makeGoodInput();
    const other = bootstrapArms(
      Object.fromEntries(Object.entries({ N: 0, R: 0, X: 0 }).map(([a]) => [a,
        input.queries.map((q) => {
          const s = input.perQuery[q.queryId][a].scores;
          return { userId: q.queryId, score: (s[0] + s[1]) / 2 };
        })
      ])),
      { reps: 200, seed: 999 }
    );
    input.summary.comparisons = other.comparisons
      .filter((c) => (c.a === 'R' && c.b === 'X'))
      .map((c) => ({ a: c.a, b: c.b, deltaMeanExact: c.pointDiff, deltaCI: c.deltaCI, deltaCI4: c.deltaCI4, supportFlag: c.supportFlag }));
    const r = auditRun(input);
    assert.equal(get(r, 'H8.3').passed, false);
  });
});

describe('统计辅助', () => {
  it('ksStatistic：相同分布 D=0，完全分离 D=1', () => {
    assert.equal(ksStatistic([1, 2, 3, 4], [1, 2, 3, 4]), 0);
    assert.equal(ksStatistic([1, 2], [3, 4]), 1);
  });

  it('cohensKappa：完全一致 → 1；已知手算例', () => {
    const perfect = Array.from({ length: 10 }, (_, i) => ({ rater1: i % 2, rater2: i % 2 }));
    assert.equal(cohensKappa(perfect), 1);
    // 5 对 (1,1) + 5 对 (0,1)：po=0.5, pe=0.5*1=0.5 → κ=0
    const known = [...Array(5).fill({ rater1: 1, rater2: 1 }), ...Array(5).fill({ rater1: 0, rater2: 1 })];
    assert.ok(Math.abs(cohensKappa(known)) < 1e-12);
  });
});
