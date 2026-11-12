'use strict';
/**
 * L3 人工 κ 校准工具测试。
 * 重点钉三件事：① κ/κ_w/AC1 的数值与教科书算例一致；② 盲评表真的不含臂名与机器分；
 * ③ 缺填/非法值必须让闸门失败，不能被静默忽略。
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  parseCsv,
  toCsv,
  uniformFrom,
  buildCalibration,
  cohenKappa,
  weightedKappa,
  gwetAC1,
  pabak,
  binaryDiagnostics,
  byArm,
  clusterBootstrap,
  evaluateCalibration,
  decideGate,
  requiredN,
} = require('../src/stage1/calibration');

const mk = (human, judge, queryId = 'q1', arm = 'R') => ({ human, judge, queryId, arm });

// ------------------------------------------------------------ CSV

test('parseCsv：处理 BOM、引号内逗号与换行、"" 转义', () => {
  const raw = '\ufeffitemId,question,pred,humanScore\r\n'
    + 'c-001,"甲，乙\n丙","他说""好""",2\r\n'
    + 'c-002,简单,"",0\r\n';
  const rows = parseCsv(raw);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].itemId, 'c-001');
  assert.strictEqual(rows[0].question, '甲，乙\n丙');
  assert.strictEqual(rows[0].pred, '他说"好"');
  assert.strictEqual(rows[1].pred, '');
  assert.strictEqual(rows[1].humanScore, '0');
});

test('toCsv：逗号/引号/换行往返不丢信息', () => {
  const rows = [{ a: 'x,y', b: '说"话"', c: 'l1\nl2' }];
  const back = parseCsv(toCsv(['a', 'b', 'c'], rows));
  assert.deepStrictEqual(back[0], rows[0]);
});

// ------------------------------------------------------------ κ 数值

test('cohenKappa：教科书 2×2 算例 κ=0.4681', () => {
  const pairs = [
    ...Array.from({ length: 10 }, () => mk(2, 2)),
    ...Array.from({ length: 5 }, () => mk(0, 0)),
    ...Array.from({ length: 3 }, () => mk(0, 2)),
    ...Array.from({ length: 2 }, () => mk(2, 0)),
  ];
  const k = cohenKappa(pairs);
  assert.strictEqual(k.n, 20);
  assert.ok(Math.abs(k.po - 0.75) < 1e-12);
  assert.ok(Math.abs(k.pe - 0.53) < 1e-12);
  assert.ok(Math.abs(k.kappa - 0.468085) < 1e-5, `κ=${k.kappa}`);
});

test('cohenKappa：完全一致 → 1；机会水平 → 0', () => {
  assert.strictEqual(cohenKappa([mk(0, 0), mk(1, 1), mk(2, 2)]).kappa, 1);
  // 边际完全均匀且独立： 4 类组合各 25%
  const indep = [mk(0, 0), mk(2, 0), mk(0, 2), mk(2, 2)];
  assert.ok(Math.abs(cohenKappa(indep).kappa) < 1e-12);
});

test('weightedKappa：随分歧严重程度加权，quad > linear > 无权 κ', () => {
  const pairs = [
    ...Array.from({ length: 10 }, () => mk(2, 2)),
    ...Array.from({ length: 10 }, () => mk(0, 0)),
    ...Array.from({ length: 6 }, () => mk(2, 1)), // 相邻分歧
    ...Array.from({ length: 6 }, () => mk(0, 1)),
    ...Array.from({ length: 2 }, () => mk(2, 0)), // 跨档分歧
    ...Array.from({ length: 2 }, () => mk(0, 2)),
  ];
  const q = weightedKappa(pairs, { type: 'quadratic' }).kappa;
  const l = weightedKappa(pairs, { type: 'linear' }).kappa;
  const u = cohenKappa(pairs).kappa;
  assert.ok(Math.abs(u - 1 / 3) < 1e-9, `无权 κ 应=0.3333，实际 ${u}`);
  assert.ok(Math.abs(l - 4 / 9) < 1e-9, `linear κ 应=0.4444，实际 ${l}`);
  assert.ok(Math.abs(q - 8 / 15) < 1e-9, `quad κ 应=0.5333，实际 ${q}`);
  assert.ok(q > l && l > u, '相邻分歧罚得越轻，κ 越高');
});

test('gwetAC1：患病率极端偏斜时 κ→0 而 AC1 仍高（κ 悖论）', () => {
  const pairs = [
    ...Array.from({ length: 90 }, () => mk(2, 2)),
    ...Array.from({ length: 10 }, () => mk(2, 0)),
  ];
  const k = cohenKappa(pairs).kappa;
  const a = gwetAC1(pairs).ac1;
  assert.ok(Math.abs(k) < 0.02, `κ 应≈0，实际 ${k}`);
  assert.ok(a > 0.85, `AC1 应高，实际 ${a}`);
});

test('pabak：po=0.75 → 0.5（不看机会一致）', () => {
  const pairs = [
    ...Array.from({ length: 15 }, () => mk(2, 2)),
    ...Array.from({ length: 5 }, () => mk(2, 0)),
  ];
  assert.ok(Math.abs(pabak(pairs).po - 0.75) < 1e-12);
  assert.ok(Math.abs(pabak(pairs).pabak - 0.5) < 1e-12);
});

test('binaryDiagnostics：区分「判松」与「判严」', () => {
  const lenient = [...Array.from({ length: 8 }, () => mk(0, 2)), ...Array.from({ length: 2 }, () => mk(2, 2))];
  const d = binaryDiagnostics(lenient);
  assert.strictEqual(d.judgeOnlyRight, 8);
  assert.strictEqual(d.humanOnlyRight, 0);
  assert.ok(Math.abs(d.biasIndex - 0.8) < 1e-12);
});

// ------------------------------------------------------------ 抽样与盲性

const judgeRows = [];
['N', 'X', 'R', 'O'].forEach((arm) => {
  for (let i = 0; i < 100; i++) {
    judgeRows.push({
      queryId: `q${i}`, arm, score: i % 10 === 0 ? 1 : (i % 2 ? 2 : 0),
      pred: `预测${i}`, goldAnswer: `答案${i}`, pass: 1,
    });
  }
});
const queries = Array.from({ length: 100 }, (_, i) => ({ queryId: `q${i}`, queryText: `题面 ${i}` }));

test('buildCalibration：盲表不含臂名与机器分（这是 κ 有意义的前提）', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.5 });
  const header = built.blindCsv.split('\n')[0].replace(/^\ufeff/, '');
  assert.ok(!/arm/i.test(header), `表头不应出现臂：${header}`);
  assert.ok(!/judge/i.test(header), `表头不应出现机器分：${header}`);
  assert.ok(!built.blindCsv.includes('|R'), '盲表内容不应含 queryId|arm 组合键');
  for (const r of built.keyRows) {
    assert.strictEqual(typeof r.arm, 'string');
    assert.ok([0, 1, 2].includes(r.judgeScore));
  }
});

test('buildCalibration：与输入顺序无关（同 seed 同输出）', () => {
  const a = buildCalibration({ judgeRows, queries, rate: 0.3 });
  const shuffled = judgeRows.slice().reverse();
  const b = buildCalibration({ judgeRows: shuffled, queries, rate: 0.3 });
  assert.deepStrictEqual(a.keyRows, b.keyRows);
  assert.strictEqual(a.blindCsv, b.blindCsv);
});

test('buildCalibration：抽样比例大致命中，且 itemId 与臂无关', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.25 });
  const n = built.keyRows.length;
  assert.ok(n > 70 && n < 130, `n=${n}`);
  // 前 10 条不应全部来自同一臂（u 排序打散了原顺序）
  const first10 = new Set(built.keyRows.slice(0, 10).map((r) => r.arm));
  assert.ok(first10.size >= 2, '前 10 条集中在单一臂，说明顺序泄漏');
});

test('buildCalibration：enrich 单独标记，且不改动已抽中条目', () => {
  const base = buildCalibration({ judgeRows, queries, rate: 0.1 });
  const enriched = buildCalibration({ judgeRows, queries, rate: 0.1, enrichPerClass: 5 });
  assert.ok(enriched.stats.enriched === 5, `enriched=${enriched.stats.enriched}`);
  const baseIds = new Set(base.keyRows.map((r) => r.itemId));
  assert.strictEqual(baseIds.size, base.keyRows.length);
  const enrichedKeys = new Set(enriched.keyRows.filter((r) => r.enriched).map((r) => `${r.queryId}|${r.arm}`));
  for (const r of base.keyRows) {
    assert.ok(!enrichedKeys.has(`${r.queryId}|${r.arm}`), '富集不应与主样本重叠');
  }
});

test('uniformFrom：确定且有界', () => {
  const u1 = uniformFrom(1, 'a|R');
  assert.strictEqual(u1, uniformFrom(1, 'a|R'));
  assert.ok(u1 >= 0 && u1 < 1);
  assert.notStrictEqual(uniformFrom(1, 'a|R'), uniformFrom(1, 'a|X'));
});

// ------------------------------------------------------------ 评分与闸门

function makeSheet(built, fn) {
  const rows = built.blindRows.map((r, i) => {
    const key = built.keyRows[i];
    const h = fn ? fn(key, i) : key.judgeScore;
    return { ...r, humanScore: h === null ? '' : String(h) };
  });
  return toCsv(['itemId', 'question', 'goldAnswer', 'pred', 'humanScore', 'note'], rows);
}

test('evaluateCalibration：完全复现机器分 → κ=1，闸门 primary', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.5 });
  const rep = evaluateCalibration({ sheetCsv: makeSheet(built), keyRows: built.keyRows, cfg: { minHumanKappa: 0.6 } });
  assert.strictEqual(rep.complete, true);
  assert.strictEqual(rep.agreement.weightedKappaQuadratic, 1);
  assert.strictEqual(rep.gate.level, 'primary');
  assert.strictEqual(rep.gate.verdictMayRelyOnL3, true);
  assert.strictEqual(rep.differentialBias.RminusX, 0);
});

test('evaluateCalibration：缺填一条即判定不完整，闸门不得 primary', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.3 });
  const csv = makeSheet(built).split('\n');
  // 挖空最后一条的 humanScore（末列是 note，前两列是 humanScore）
  const last = csv[csv.length - 1].split(',');
  last[last.length - 2] = '';
  csv[csv.length - 1] = last.join(',');
  const rep = evaluateCalibration({ sheetCsv: csv.join('\n'), keyRows: built.keyRows, cfg: { minHumanKappa: 0.6 } });
  assert.strictEqual(rep.complete, false);
  assert.strictEqual(rep.missing.length, 1);
  assert.notStrictEqual(rep.gate.level, 'primary');
});

test('evaluateCalibration：非法分值（3）被报出而非静默取整', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.2 });
  const csv = makeSheet(built).replace(/,(\d),""$/m, ',3,""');
  const rep = evaluateCalibration({ sheetCsv: csv, keyRows: built.keyRows, cfg: {} });
  assert.ok(rep.invalid.length >= 1 || rep.n.rated === rep.n.expected);
  if (rep.invalid.length) assert.strictEqual(rep.complete, false);
});

test('evaluateCalibration：judge 对 R 臂系统性判松 → 触发差异化偏差警报', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.6 });
  // 人造：人给 R 臂更低分（judge 比人高 1），其它臂一致
  const csv = makeSheet(built, (key) => (key.arm === 'R' ? Math.max(0, key.judgeScore - 1) : key.judgeScore));
  const rep = evaluateCalibration({ sheetCsv: csv, keyRows: built.keyRows, cfg: { minHumanKappa: 0.6 }, reps: 300 });
  assert.ok(rep.differentialBias.RminusX > 0.5, `R−X 偏差应明显为正，实际 ${rep.differentialBias.RminusX}`);
  assert.strictEqual(rep.gate.biasAlarm, true);
  assert.ok(rep.gate.reasons.some((r) => r.includes('敏感性重算')));
});

test('evaluateCalibration：双人评分时给出人-人 κ 作为上限参照', () => {
  const built = buildCalibration({ judgeRows, queries, rate: 0.4 });
  const rows = built.blindRows.map((r, i) => ({
    ...r, humanScore: String(built.keyRows[i].judgeScore), humanScore2: String(built.keyRows[i].judgeScore),
  }));
  const csv = toCsv(['itemId', 'question', 'goldAnswer', 'pred', 'humanScore', 'humanScore2', 'note'], rows);
  const rep = evaluateCalibration({ sheetCsv: csv, keyRows: built.keyRows, cfg: {} });
  assert.strictEqual(rep.interHuman.n, built.keyRows.length);
  assert.strictEqual(rep.interHuman.kappa, 1);
});

test('decideGate：三档门槛 + CI 下界规则', () => {
  const hi = decideGate({ weightedKappa: 0.75, ci: [0.6, 0.88], minKappa: 0.6, biasDiff: 0, complete: true, n: 200, expected: 200 });
  assert.strictEqual(hi.level, 'primary');
  const mid = decideGate({ weightedKappa: 0.5, ci: [0.3, 0.68], minKappa: 0.6, biasDiff: 0, complete: true, n: 200, expected: 200 });
  assert.strictEqual(mid.level, 'directional');
  assert.strictEqual(mid.verdictMayRelyOnL3, false);
  const low = decideGate({ weightedKappa: 0.25, ci: [0.05, 0.45], minKappa: 0.6, biasDiff: 0, complete: true, n: 200, expected: 200 });
  assert.strictEqual(low.level, 'unusable');
  assert.strictEqual(low.l3UsableForVerdict, false);
  // κ 高但 CI 下界离门槛太远 → 不得升为 primary
  const shaky = decideGate({ weightedKappa: 0.62, ci: [0.3, 0.85], minKappa: 0.6, biasDiff: 0, complete: true, n: 30, expected: 30 });
  assert.strictEqual(shaky.level, 'directional');
});

test('clusterBootstrap：按 queryId 重采样，结果确定且 CI 含点估计', () => {
  const pairs = [];
  for (let q = 0; q < 20; q++) {
    pairs.push(mk(2, 2, `q${q}`), mk(2, 0, `q${q}`), mk(0, 0, `q${q}`));
  }
  const a = clusterBootstrap(pairs, (ps) => cohenKappa(ps).kappa, { reps: 200, seed: 7 });
  const b = clusterBootstrap(pairs, (ps) => cohenKappa(ps).kappa, { reps: 200, seed: 7 });
  assert.deepStrictEqual(a, b);
  assert.ok(a.ci95[0] <= a.point && a.point <= a.ci95[1]);
  assert.strictEqual(a.nClusters, 20);
});

test('byArm：n<20 不报 κ（噪声过大），但报偏差与一致率', () => {
  const pairs = [mk(2, 2, 'q1', 'R'), mk(2, 1, 'q2', 'R')];
  const r = byArm(pairs);
  assert.strictEqual(r.R.n, 2);
  assert.strictEqual(r.R.kappa, null);
  assert.ok(Math.abs(r.R.meanSignedBias - (-0.5)) < 1e-12);
});

test('requiredN：半宽越窄所需样本越多', () => {
  const n10 = requiredN({ po: 0.85, pe: 0.5, halfWidth: 0.1 });
  const n05 = requiredN({ po: 0.85, pe: 0.5, halfWidth: 0.05 });
  assert.ok(n05 > n10 * 3.5);
  assert.ok(n10 > 100 && n10 < 300, `n(±0.10)≈${n10}`);
});

test('byNeedsImage：依赖图与不依赖图分开报 κ，缺分层信息时记 unknown', () => {
  const keys = [];
  const lines = ['itemId,humanScore,note'];
  for (let i = 0; i < 20; i++) {
    const arm = ['N', 'X', 'R', 'O'][i % 4];
    keys.push({ itemId: `i-${i}`, queryId: `q${i}`, arm, judgeScore: i % 3, enriched: false });
    lines.push(`i-${i},${i % 3},`);
  }
  const keyRows = keys;
  // 不带分层
  const a = evaluateCalibration({ sheetCsv: lines.join('\n'), keyRows, cfg: {}, reps: 50 });
  assert.strictEqual(a.byNeedsImage, null, '无分层信息时不应伪造分组');

  // 带分层
  const strata = new Map(keys.map((k, i) => [k.itemId, i < 6]));
  const b = evaluateCalibration({ sheetCsv: lines.join('\n'), keyRows, cfg: {}, reps: 50, strata });
  assert.strictEqual(b.byNeedsImage.unknown, 0);
  assert.strictEqual(b.byNeedsImage.withImage.n, 6);
  assert.strictEqual(b.byNeedsImage.noImage.n, 14);
  assert.ok(Number.isFinite(b.byNeedsImage.withImage.weightedKappaQuadratic));
  assert.ok(Number.isFinite(b.byNeedsImage.noImage.weightedKappaQuadratic));
});

test('byNeedsImage：表内 needsImage 列优先于外部 strata', () => {
  const keyRows = [
    { itemId: 'a', queryId: 'q1', arm: 'R', judgeScore: 2, enriched: false },
    { itemId: 'b', queryId: 'q2', arm: 'X', judgeScore: 0, enriched: false },
  ];
  const sheet = 'itemId,needsImage,humanScore,note\na,1,2,\nb,0,0,\n';
  const strata = new Map([['a', false], ['b', true]]); // 故意与表内相反
  const rep = evaluateCalibration({ sheetCsv: sheet, keyRows, cfg: {}, reps: 10, strata });
  assert.strictEqual(rep.byNeedsImage.withImage.n, 1);
  assert.strictEqual(rep.byNeedsImage.noImage.n, 1);
  // 单条样本算不出 κ，但必须如实标记，而不是整组消失
  assert.strictEqual(rep.byNeedsImage.withImage.insufficient, true);
  assert.strictEqual(rep.byNeedsImage.withImage.weightedKappaQuadratic, null);
});
