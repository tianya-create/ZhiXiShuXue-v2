/**
 * graphData.test.js —— 构图与无泄漏测试（方案 §11.1 G01–G14）
 *
 * 纯函数测试直接调用 buildAssist2009SkillGraph.js 导出的构图核心；
 * CLI 集成测试用独立标识的合成 fixture 走正式入口。
 *
 * 脚本定位兼容两种目录布局：
 *   仓库：backend/test/ → backend/scripts/buildAssist2009SkillGraph.js
 *   材料包：backend/test/ → backend/scripts/…（副本）或根目录 scripts/…（独立查看副本）
 */
const path = require('path');
const fs = require('fs');

function resolveModule(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('找不到模块，尝试过：' + candidates.join(' ; '));
}

const scriptCandidates = [
  path.join(__dirname, '..', 'scripts', 'buildAssist2009SkillGraph.js'),
  path.join(__dirname, '..', '..', 'scripts', 'buildAssist2009SkillGraph.js')
];
const {
  buildEdgeTable, adjacencyFromEdges, symmetricNormalize, randomizeEdges,
  sameTopology, selfloopAdjacency, nonIsolatedTargetCoverage,
  mulberry32, deriveGraphSeed, canonicalHashOfIds
} = resolveModule(scriptCandidates);

// dkt.js 同样双入口解析（仓库 backend/models，材料包 backend/models 或 model/）
const dkt = resolveModule([
  path.join(__dirname, '..', 'models', 'dkt.js'),
  path.join(__dirname, '..', 'model', 'dkt.js')
]);

const KP = { A: 'a09-s1', B: 'a09-s2', C: 'a09-s3', D: 'a09-s4' };
const kpIndex = new Map(Object.values(KP).map((k, i) => [k, i]));

const grp = (problemId, skillIds) => ({ problemId, skillIds });
const edgeOf = (edges, a, b) => {
  const i = Math.min(kpIndex.get(a), kpIndex.get(b));
  const j = Math.max(kpIndex.get(a), kpIndex.get(b));
  return edges.get(`${i}|${j}`);
};

describe('构图核心纯函数（G04–G07、G09–G11）', () => {
  test('G05: 同题重复作答十次，support 仍为 1', () => {
    const groups = Array.from({ length: 10 }, () => grp('q1', [KP.A, KP.B])); // 同一题 q1 重复十次
    const { edges } = buildEdgeTable(groups, kpIndex);
    expect(edges.size).toBe(1);
    expect(edgeOf(edges, KP.A, KP.B).support).toBe(1);
  });

  test('G06: 方案 §4.4 小图例逐项：q1 十次 + q2 三技能 → A-B=2、A-C=1、B-C=1，无自环', () => {
    const groups = [
      ...Array.from({ length: 10 }, () => grp('q1', [KP.A, KP.B])), // 同一题 q1 重复出现十次
      grp('q2', [KP.A, KP.B, KP.C])
    ];
    const { edges, stats } = buildEdgeTable(groups, kpIndex);
    expect(edges.size).toBe(3); // 三条无向边，不是六条
    expect(edgeOf(edges, KP.A, KP.B).support).toBe(2);
    expect(edgeOf(edges, KP.A, KP.C).support).toBe(1);
    expect(edgeOf(edges, KP.B, KP.C).support).toBe(1);
    expect(stats.multiSkillGroups).toBe(11); // q1 十次 + q2 一次，均为多技能组
    expect(stats.singleSkillGroups).toBe(0);
    // 无自环：所有边 i !== j
    for (const e of edges.values()) expect(e.i).not.toBe(e.j);
  });

  test('G07: 同题在不同作答中分别只出现单标签，不自动产生共现边', () => {
    const groups = [grp('q9', [KP.A]), grp('q9', [KP.B]), grp('q9-2', [KP.C])];
    const { edges } = buildEdgeTable(groups, kpIndex);
    expect(edges.size).toBe(0);
  });

  test('G09: A 对称且对角为 0；加单位自环归一化后对角 = 1/度，孤立节点对角 = 1', () => {
    const groups = [grp('q1', [KP.A, KP.B])];
    const { edges } = buildEdgeTable(groups, kpIndex);
    const edgeList = [...edges.values()].map((e) => ({ i: e.i, j: e.j, w: e.support }));
    const K = 4;
    const A = adjacencyFromEdges(edgeList, K);
    for (let i = 0; i < K; i++) {
      expect(A[i * K + i]).toBe(0);
      for (let j = 0; j < K; j++) expect(A[i * K + j]).toBe(A[j * K + i]);
    }
    const { Anorm, degree } = symmetricNormalize(A, K);
    expect(Anorm[0 * K + 1]).toBeCloseTo(1 / Math.sqrt(2 * 2), 12);
    expect(Anorm[0 * K + 0]).toBeCloseTo(1 / 2, 12); // D[A] = 1 + 1 = 2
    expect(Anorm[2 * K + 2]).toBe(1); // 孤立节点 C：D=1 → 对角 1
    expect(degree[0]).toBe(2);
  });

  test('G10: 手算 2 节点小矩阵逐元素吻合、对称、有限（行和不必为 1）', () => {
    const K = 2;
    const A = adjacencyFromEdges([{ i: 0, j: 1, w: 3 }], K);
    const { Anorm } = symmetricNormalize(A, K);
    // Atilde = [[1,3],[3,1]]，D = [4,4]
    expect(Anorm[0]).toBeCloseTo(1 / 4, 12);
    expect(Anorm[1]).toBeCloseTo(3 / 4, 12);
    expect(Anorm[1 * K + 0]).toBeCloseTo(3 / 4, 12);
    expect(Anorm[1 * K + 1]).toBeCloseTo(1 / 4, 12);
    for (const v of Anorm) expect(Number.isFinite(v)).toBe(true);
    // 对称归一化行和一般不为 1（本例恰好为 1 是 2 节点特例）；用 4 节点例验证行和 ≠ 1
    const A4 = adjacencyFromEdges([{ i: 0, j: 1, w: 1 }, { i: 0, j: 2, w: 1 }], 4);
    const { Anorm: An4 } = symmetricNormalize(A4, 4);
    const rowSum0 = An4[0] + An4[1] + An4[2] + An4[3];
    expect(rowSum0).not.toBe(1);
  });

  test('G11: 孤立节点保留（SelfLoop 图 Anorm=I，全部节点对角为 1）', () => {
    const I = selfloopAdjacency(5);
    expect(I.length).toBe(25);
    for (let i = 0; i < 5; i++) {
      expect(I[i * 5 + i]).toBe(1);
      for (let j = 0; j < 5; j++) if (i !== j) expect(I[i * 5 + j]).toBe(0);
    }
  });

  test('G12: RandomGraph 约束——同边数、同权多重集、无重复边、无自环、确定性', () => {
    const real = [
      { i: 0, j: 1, w: 5 }, { i: 1, j: 2, w: 3 }, { i: 2, j: 3, w: 1 },
      { i: 0, j: 3, w: 2 }, { i: 0, j: 2, w: 4 }
    ];
    const rng1 = mulberry32(12345);
    const g1 = randomizeEdges(real, 6, rng1);
    const rng2 = mulberry32(12345);
    const g2 = randomizeEdges(real, 6, rng2);
    expect(g1).toEqual(g2); // 同种子确定性
    expect(g1.length).toBe(real.length);
    expect([...g1.map((e) => e.w)].sort((a, b) => a - b)).toEqual([...real.map((e) => e.w)].sort((a, b) => a - b));
    const seen = new Set();
    for (const e of g1) {
      expect(e.i).toBeLessThan(e.j);
      expect(seen.has(`${e.i}|${e.j}`)).toBe(false);
      seen.add(`${e.i}|${e.j}`);
    }
    expect(g1.some((e) => e.i === e.j)).toBe(false);
    expect(sameTopology(real, real)).toBe(true);
    expect(sameTopology(real, g1)).toBe(false); // M=5/15 对，几乎必然不同；固定种子下应确定
  });

  test('nonIsolatedTargetCoverage：分子/分母/口径字段逐项正确', () => {
    const kpIdx = new Map([['a09-s11', 0], ['a09-s12', 1], ['a09-s13', 2], ['a09-s14', 3]]);
    const edges = [{ i: 0, j: 1, w: 2 }]; // s11-s12 非孤立；s13 孤立；s14 无目标kp在词表外的情形单独测
    const targets = [
      { kpCode: 'a09-s11' }, { kpCode: 'a09-s12' },
      { kpCode: 'a09-s13' }, { kpCode: 'a09-s13' },
      { kpCode: 'a09-s11' },
      { kpCode: 'a09-s99' } // 不在词表
    ];
    const cov = nonIsolatedTargetCoverage(edges, kpIdx, targets, 'sha256:manifest', 'sha256:file');
    expect(cov.numerator).toBe(3); // s11 两条 + s12 一条
    expect(cov.denominator).toBe(6);
    expect(cov.targetKpNotInVocab).toBe(1);
    expect(cov.nonIsolatedNodeCount).toBe(2);
    expect(cov.nodeCount).toBe(4);
    expect(cov.ratio).toBeCloseTo(3 / 6, 6);
    expect(cov.targetManifestHash).toBe('sha256:manifest');
    expect(cov.targetsFileSha256).toBe('sha256:file');
    expect(cov.rule).toContain('非孤立节点');
    // 空边集（SelfLoop 图）：分子 = 0
    const cov0 = nonIsolatedTargetCoverage([], kpIdx, targets, null, 'sha256:file');
    expect(cov0.numerator).toBe(0);
    expect(cov0.nonIsolatedNodeCount).toBe(0);
  });
});

describe('G13: 独立随机流与派生规则', () => {
  test('graphSeed 派生确定、独立于训练种子数值、不同用途不同', () => {
    const a = deriveGraphSeed(42, 'random-graph');
    const b = deriveGraphSeed(42, 'random-graph');
    const c = deriveGraphSeed(43, 'random-graph');
    const d = deriveGraphSeed(42, 'other-purpose');
    expect(a.seed).toBe(b.seed);
    expect(a.seed).not.toBe(c.seed);
    expect(a.seed).not.toBe(d.seed);
    expect(a.rule).toContain('fnv1a');
    expect(a.prng).toBe('mulberry32');
    // mulberry32 同种子同序列，异种子异序列
    const r1 = mulberry32(a.seed); const v1 = [r1(), r1(), r1()];
    const r2 = mulberry32(a.seed); const v2 = [r2(), r2(), r2()];
    expect(v1).toEqual(v2);
  });
});

describe('CLI 集成（G01–G04、G08、G14）：独立标识合成 fixture 走正式入口', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const crypto = require('crypto');
  const SCRIPT = scriptCandidates.find((p) => fs.existsSync(p));
  const sha = (p) => 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  // 独立标识：本 fixture 专用 KP，不与其他 fixture 共用
  const KP1 = 'a09-s11', KP2 = 'a09-s12', KP3 = 'a09-s13', KP4 = 'a09-s14';
  const USERS = Array.from({ length: 10 }, (_, i) => `a09-u${200 + i}`);
  const split = dkt.splitStudents(USERS, { train: 0.7, validation: 0.15, seed: 42 });

  /**
   * fixture 布局：
   * - interactions（全任务）：所有学生 s11+s12；非 train 学生额外 s13（→ 完整任务词表含 s13，
   *   但 train 学生从未交互 s13）；s14 完全不出现在 interactions（不在词表）。
   * - raw：train 学生给出 s11-s12 共现边；validation/test 学生提供「端点均在词表内、
   *   训练中不存在」的独有多技能组（s11+s13、s12+s13）→ 必须被学生过滤排除。
   * - raw 含 correct / ms_first_response 列，构图不读它们（G04 行为验证）。
   */
  function buildFixture(dir, { rawFile = 'raw.csv' } = {}) {
    fs.mkdirSync(path.join(dir, 'assist2009'), { recursive: true });
    const t = (n) => `2000-01-01T00:${String(n).padStart(2, '0')}:00.000Z`;
    const rows = ['userId,questionId,kpCode,isCorrect,costTime,createdAt,sequenceIndex'];
    const nonTrain = new Set([...split.validation, ...split.test]);
    for (const u of USERS) {
      let si = 0;
      rows.push(`${u},a09-p1,${KP1},1,5,${t(1)},${si++}`);
      rows.push(`${u},a09-p2,${KP2},0,5,${t(2)},${si++}`);
      if (nonTrain.has(u)) rows.push(`${u},a09-p3,${KP3},1,5,${t(3)},${si++}`); // 仅非 train 学生交互 s13
    }
    const interactionsPath = path.join(dir, 'assist2009', 'interactions.csv');
    fs.writeFileSync(interactionsPath, rows.join('\n') + '\n');

    // raw：correct 与 ms_first_response 参与的是被忽略的列（构图只用 order/user/problem/skill）
    const rawRows = ['order_id,user_id,problem_id,skill_id,correct,ms_first_response'];
    const line = (o, u, p, s, c, ms) => rawRows.push(`${o},${u.replace('a09-u', '')},${p.replace('a09-p', '')},${s.replace('a09-s', '')},${c},${ms}`);
    const tr = split.train;
    line(1, tr[0], 'a09-p1', KP1, 1, 12000); line(1, tr[0], 'a09-p1', KP2, 0, 45000);        // train 边 s11-s12
    for (let k = 0; k < 10; k++) { line(10 + k, tr[1], 'a09-p1', KP1, 1, 9000); line(10 + k, tr[1], 'a09-p1', KP2, 1, 8000); } // 同题十次
    line(30, tr[2], 'a09-p2', KP2, 1, 7000);                                                  // 单技能组：进构图学生集，无边
    line(40, split.validation[0], 'a09-p1', KP1, 1, 11000); line(40, split.validation[0], 'a09-p1', KP3, 0, 22000); // val 独有边 s11-s13（端点均在词表内）
    line(50, split.test[0], 'a09-p1', KP2, 1, 13000); line(50, split.test[0], 'a09-p1', KP3, 0, 14000);             // test 独有边 s12-s13
    line(60, split.test[0], 'a09-p1', KP4, 1, 15000);                                          // s4 不在词表 → 过滤
    const rawPath = path.join(dir, rawFile);
    fs.writeFileSync(rawPath, rawRows.join('\n') + '\n');

    // 目标清单 fixture（覆盖率口径）：2×s11（非孤立）+ 1×s12（非孤立）+ 2×s13（孤立）+ 1×s14（不在词表）
    const targets = [
      { targetKey: 't1', kpCode: KP1 }, { targetKey: 't2', kpCode: KP1 },
      { targetKey: 't3', kpCode: KP2 },
      { targetKey: 't4', kpCode: KP3 }, { targetKey: 't5', kpCode: KP3 },
      { targetKey: 't6', kpCode: KP4 }
    ];
    const targetsPath = path.join(dir, 'targets.json');
    fs.writeFileSync(targetsPath, JSON.stringify({
      protocolVersion: 'fixture', seed: 42, targetCount: targets.length,
      targetManifestHash: 'sha256:fixture-target-manifest',
      targets
    }));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ source: { rawSha256: sha(rawPath) }, output: { sha256: sha(interactionsPath) } }));
    return { rawPath, interactionsPath, manifestPath, targetsPath };
  }

  function runCli(rawPath, manifestPath, targetsPath, outDir, seed = 42) {
    execFileSync('node', [SCRIPT, '--raw', rawPath, '--interactions',
      path.join(path.dirname(manifestPath), 'assist2009', 'interactions.csv'),
      '--manifest', manifestPath, '--targets', targetsPath,
      '--seed', String(seed), '--out', outDir], { encoding: 'utf8', stdio: 'pipe' });
  }

  test('G01: 原始文件哈希不一致 → 报错停止，不产出', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    const fx = buildFixture(dir);
    const badManifest = path.join(dir, 'bad-manifest.json');
    fs.writeFileSync(badManifest, JSON.stringify({
      source: { rawSha256: 'sha256:' + '0'.repeat(64) },
      output: { sha256: sha(fx.interactionsPath) }
    }));
    let err = null;
    try {
      execFileSync('node', [SCRIPT, '--raw', fx.rawPath, '--interactions', fx.interactionsPath,
        '--manifest', badManifest, '--targets', fx.targetsPath, '--seed', '42',
        '--out', path.join(dir, 'out')], { stdio: 'pipe' });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.stderr.toString()).toMatch(/哈希不一致/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readArtifacts(seedDir) {
    const r = (n) => fs.readFileSync(path.join(seedDir, n), 'utf8');
    return {
      edges: r('graph-real-edges.csv'),
      evidence: r('graph-edge-evidence.jsonl'),
      vocab: JSON.parse(r('vocabulary.json')),
      real: JSON.parse(r('graph-real-manifest.json')),
      rand: JSON.parse(r('graph-random-manifest.json')),
      self: JSON.parse(r('graph-selfloop-manifest.json'))
    };
  }
  // 图数据哈希（不含 generatedAt / rawSha256 等会随输入变化的字段）
  const graphFingerprints = (a) => [a.edges, a.evidence, a.vocab.kpList.join(','), a.real.adjacencySha256, a.real.graphEdgesSha256, a.real.evidenceSha256].join('\n');

  test('G02: 词表 = 完整任务固定词表（与 dktEval 的 buildVocab(全任务) 逐位一致）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    const fx = buildFixture(dir);
    const out = path.join(dir, 'out');
    runCli(fx.rawPath, fx.manifestPath, fx.targetsPath, out);
    const a = readArtifacts(path.join(out, 'seed-42'));
    // 全任务词表：s13 只由非 train 学生交互，也必须在词表中
    expect(a.vocab.kpList).toEqual([KP1, KP2, KP3]);
    // 与 dktEval 同规则重算：全任务序列 → buildVocab
    const lines = fs.readFileSync(fx.interactionsPath, 'utf8').trim().split('\n');
    const hi = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
    const recs = lines.slice(1).map((l) => { const c = l.split(','); return { userId: c[hi.userId], questionId: c[hi.questionId], kpCode: c[hi.kpCode], isCorrect: Number(c[hi.isCorrect]), createdAt: c[hi.createdAt] }; });
    expect(a.vocab.kpList).toEqual(dkt.buildVocab(dkt.buildStudentSequences(recs)).kpList);
    expect(a.vocab.vocabRule).toContain('完整任务固定词表');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('G03: train-only 硬验证——val/test 学生提供的独有边（端点均在词表内）不进图', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    const fx = buildFixture(dir);
    const out = path.join(dir, 'out');
    runCli(fx.rawPath, fx.manifestPath, fx.targetsPath, out);
    const a = readArtifacts(path.join(out, 'seed-42'));
    // train 边存在
    expect(a.edges).toContain(`${KP1},${KP2}`);
    // val/test 学生提供的独有多技能边（s11+s13、s12+s13）：端点均在词表内、train 中不存在 → 必须被排除
    expect(a.edges).not.toContain(KP3); // 边 CSV 中根本不出现 s13
    expect(a.evidence).not.toContain(KP3);
    // 诊断：val/test 学生的行确实到达了学生过滤层（未被题目/词表过滤提前拦截）
    expect(a.real.diagnostics.userOutsideTrainRows).toBeGreaterThanOrEqual(5);
    // 纳入构图学生集合 = 实际贡献作答组的 train 学生（tr[0..2]），⊆ train 且 ≠ train 全集
    const contributors = [split.train[0], split.train[1], split.train[2]].sort();
    expect(a.real.graphStudentIdsHash).toBe(canonicalHashOfIds(contributors));
    expect(a.real.graphStudentIdsHash).not.toBe(a.real.trainStudentsHash);
    expect(a.real.graphStudentCount).toBe(3);
    expect(a.real.graphStudentsOutsideTrain).toBe(0);
    expect(a.real.graphStudentRule).toContain('⊆ train');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('G04: 行为测试——改 train 的 response/用时、增删 val/test 原始行，图逐字节不变', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    const fx = buildFixture(dir);
    const out1 = path.join(dir, 'out1');
    runCli(fx.rawPath, fx.manifestPath, fx.targetsPath, out1);
    const base = readArtifacts(path.join(out1, 'seed-42'));

    // (a) 修改全部 train 行的 correct 与 ms_first_response → 图不变
    const modified = fs.readFileSync(fx.rawPath, 'utf8').split('\n').map((l, i) => {
      if (i === 0 || !l.trim()) return l;
      const c = l.split(',');
      const isTrainUser = split.train.includes('a09-u' + c[1]);
      if (isTrainUser) { c[4] = c[4] === '1' ? '0' : '1'; c[5] = String(Number(c[5]) + 777); }
      return c.join(',');
    }).join('\n');
    const rawDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    fs.mkdirSync(path.join(rawDir2, 'assist2009'), { recursive: true });
    fs.copyFileSync(fx.interactionsPath, path.join(rawDir2, 'assist2009', 'interactions.csv'));
    const raw2 = path.join(rawDir2, 'raw.csv');
    fs.writeFileSync(raw2, modified);
    const manifest2 = path.join(rawDir2, 'manifest.json');
    fs.writeFileSync(manifest2, JSON.stringify({ source: { rawSha256: sha(raw2) }, output: { sha256: sha(fx.interactionsPath) } }));
    const out2 = path.join(rawDir2, 'out');
    runCli(raw2, manifest2, fx.targetsPath, out2);
    expect(graphFingerprints(readArtifacts(path.join(out2, 'seed-42')))).toBe(graphFingerprints(base));

    // (b) 删除全部 validation/test 原始行 → 图不变（证明这些行从未参与构图）
    const onlyTrain = fs.readFileSync(fx.rawPath, 'utf8').split('\n')
      .filter((l, i) => i === 0 || !l.trim() || split.train.includes('a09-u' + l.split(',')[1]))
      .join('\n');
    const rawDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    fs.mkdirSync(path.join(rawDir3, 'assist2009'), { recursive: true });
    fs.copyFileSync(fx.interactionsPath, path.join(rawDir3, 'assist2009', 'interactions.csv'));
    const raw3 = path.join(rawDir3, 'raw.csv');
    fs.writeFileSync(raw3, onlyTrain);
    const manifest3 = path.join(rawDir3, 'manifest.json');
    fs.writeFileSync(manifest3, JSON.stringify({ source: { rawSha256: sha(raw3) }, output: { sha256: sha(fx.interactionsPath) } }));
    const out3 = path.join(rawDir3, 'out');
    runCli(raw3, manifest3, fx.targetsPath, out3);
    expect(graphFingerprints(readArtifacts(path.join(out3, 'seed-42')))).toBe(graphFingerprints(base));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(rawDir2, { recursive: true, force: true });
    fs.rmSync(rawDir3, { recursive: true, force: true });
  });

  test('回归：train 未见的 KP（s13）保留为孤立节点，其上目标保留在覆盖率分母中', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    const fx = buildFixture(dir);
    const out = path.join(dir, 'out');
    runCli(fx.rawPath, fx.manifestPath, fx.targetsPath, out);
    const a = readArtifacts(path.join(out, 'seed-42'));
    // s13 在词表与节点表中（完整任务词表），但没有任何边
    expect(a.vocab.kpList).toContain(KP3);
    expect(a.edges).not.toContain(KP3);
    expect(a.real.nodeCount).toBe(3);
    expect(a.real.isolatedNodeCount).toBe(1);
    // 覆盖率：非孤立 = {s11,s12}；分子 = 2×s11 + 1×s12 = 3，分母 = 6，s14 记为不在词表
    const cov = a.real.nonIsolatedTargetCoverage;
    expect(cov).not.toBeNull();
    expect(cov.numerator).toBe(3);
    expect(cov.denominator).toBe(6);
    expect(cov.targetKpNotInVocab).toBe(1);
    expect(cov.targetManifestHash).toBe('sha256:fixture-target-manifest');
    expect(cov.targetsFileSha256).toBe(sha(fx.targetsPath));
    expect(cov.rule).toContain('非孤立节点');
    expect(cov.isolatedNodeNote).toContain('孤立节点仍有逐节点编码器');
    // RandomGraph / SelfLoop 也各有覆盖率（同口径、同目标清单）
    expect(a.rand.nonIsolatedTargetCoverage.targetManifestHash).toBe('sha256:fixture-target-manifest');
    expect(a.rand.nonIsolatedTargetCoverage.denominator).toBe(6);
    expect(a.self.nonIsolatedTargetCoverage.numerator).toBe(0);
    // SelfLoop：全部节点孤立
    expect(a.self.isolatedNodeCount).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('G08/G14: 预测 CSV 逐字节不变；同输入同种子两次运行图哈希一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdata-'));
    const fx = buildFixture(dir);
    const out1 = path.join(dir, 'out1');
    const before = sha(fx.interactionsPath);
    runCli(fx.rawPath, fx.manifestPath, fx.targetsPath, out1);
    expect(sha(fx.interactionsPath)).toBe(before); // G08
    const out2 = path.join(dir, 'out2');
    runCli(fx.rawPath, fx.manifestPath, fx.targetsPath, out2);
    const a1 = readArtifacts(path.join(out1, 'seed-42'));
    const a2 = readArtifacts(path.join(out2, 'seed-42'));
    expect(graphFingerprints(a2)).toBe(graphFingerprints(a1)); // G14
    expect(a1.rand.graphSeed).toEqual(expect.any(Number));
    // 随机图：同边数同权多重集
    const randEdges = a1.rand ? fs.readFileSync(path.join(out1, 'seed-42', 'graph-random-edges.csv'), 'utf8').trim().split('\n').slice(1) : [];
    expect(randEdges.length).toBe(a1.real.undirectedEdgeCount);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
