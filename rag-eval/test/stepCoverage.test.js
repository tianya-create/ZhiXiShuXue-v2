const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeMath,
  normalizeForMatch,
  skeletonize,
  splitSteps,
  isAnswerEcho,
  isUnusableAnalysis,
  containmentOf,
  shinglesOf,
  queryStepCoverage,
  coverageAtTau,
  extractExpressions,
  expressionCoverage,
  selectTau,
  STEM_RESIDUAL_MIN_SHARE,
} = require('../src/metrics/stepCoverage');

test('normalizeMath：LaTeX 与全角符号归一（doc 文本里 \div 必须变成 ÷）', () => {
  assert.strictEqual(normalizeMath('$3580\\div 20-80=99$'), '3580÷ 20-80=99');
  assert.strictEqual(normalizeMath('8\\times 4=32'), '8× 4=32');
  assert.strictEqual(normalizeMath('\\frac{1}{2}+1'), '(1)/(2)+1');
  assert.strictEqual(normalizeMath('\\sqrt{9}=3'), '√(9)=3');
  assert.strictEqual(normalizeMath('3－1＝2'), '3-1=2');
  assert.strictEqual(normalizeMath('5＊2'), '5×2');
});

test('normalizeForMatch：保留括号（(8-2)×(8-2) 与 8-2×8-2 是不同算式）', () => {
  assert.strictEqual(normalizeForMatch('(8-2)×(8-2)=36'), '(8-2)×(8-2)=36');
  assert.notStrictEqual(normalizeForMatch('(8-2)×(8-2)'), normalizeForMatch('8-2×8-2'));
  // 标点与空白被清掉，LaTeX 归一先于剥离
  assert.strictEqual(normalizeForMatch('$$8\\div 2$$，得：4'), '8÷2得4');
});

test('skeletonize：数字连续段归一为单个 #', () => {
  assert.strictEqual(skeletonize('100÷5=20'), '#÷#=#');
  assert.strictEqual(skeletonize('28÷4=7'), '#÷#=#');
  assert.strictEqual(skeletonize('8×8-2×8=48'), '#×#-#×#=#');
});

test('splitSteps：按句切分并剥标签', () => {
  const steps = splitSteps('解析：甲乙两地相距100千米，汽车每小时行50千米．需要$$100\\div 50=2$$小时；所以一共2小时．');
  assert.strictEqual(steps.length, 3); // 题干句 / 算式句 / 结论句 各为一步
  assert.ok(!steps[0].startsWith('解析'));
  assert.ok(steps[1].includes('100÷ 50=2'));
  assert.ok(steps[2].includes('所以一共2小时'));
});

test('splitSteps：剔除图片占位符与纯答案回声', () => {
  const steps = splitSteps('方法一：\n [图:analysis-1917-0] \n方法二：\n画流程图：\n [图:analysis-1917-1]\n故答案为：29');
  assert.deepStrictEqual(steps, []);
  assert.ok(isUnusableAnalysis('方法一：\n [图:analysis-1917-0] \n方法二：\n画流程图：'));
  assert.ok(isUnusableAnalysis('$$19$$．'));
  assert.ok(!isUnusableAnalysis('先求速度和，再用路程除以速度，得到时间为2小时'));
});

test('splitSteps：短算式碎片保留，短散文碎片并入上一步', () => {
  const keep = splitSteps('$$1+2+9$$；$$1+3+8$$');
  assert.deepStrictEqual(keep, ['1+2+9', '1+3+8']);
  const merge = splitSteps('先算出两个数的和，再除以二得到平均数，最后取整，结果如上');
  assert.strictEqual(merge.length, 1);
});

test('isAnswerEcho：识别纯答案句，但不误伤携带推理的句子', () => {
  assert.ok(isAnswerEcho('故答案为：29'));
  assert.ok(isAnswerEcho('所以答案是 29'));
  assert.ok(!isAnswerEcho('所以皮球最多的箱子里最少有29个皮球'));
});

test('containmentOf：自反为 1，不相交为 0', () => {
  const a = shinglesOf('需要先求速度和再除以二');
  const b = shinglesOf('需要先求速度和再除以二');
  const c = shinglesOf('完全无关的另一段文字内容');
  assert.strictEqual(containmentOf(a, b), 1);
  assert.strictEqual(containmentOf(a, c), 0);
});

test('queryStepCoverage：块内含该步骤 → 覆盖 1；无块 → 0', () => {
  const analysis = '需要求出速度和，再用总路程除以速度和，得到相遇时间2小时';
  const hit = queryStepCoverage({ analysis, questionContent: '甲乙相向而行', chunks: [{ text: analysis }], tau: 0.4 });
  const miss = queryStepCoverage({ analysis, questionContent: '甲乙相向而行', chunks: [], tau: 0.4 });
  assert.strictEqual(hit.coverageSkeletonNoEcho, 1);
  assert.strictEqual(miss.coverageSkeletonNoEcho, 0);
  assert.strictEqual(miss.nSteps, 1);
});

test('queryStepCoverage：残差匹配——只含题面的块不算覆盖推理步骤', () => {
  const stem = '小明有一些苹果，分给5个小朋友，每人分到3个，还剩2个，问小明原有多少个苹果';
  const step = '小明有一些苹果，分给5个小朋友，每人分到3个，还剩2个，所以原有3×5+2=17个苹果';
  const stemOnly = queryStepCoverage({ analysis: step, questionContent: stem, chunks: [{ text: stem }], tau: 0.4 });
  const full = queryStepCoverage({ analysis: step, questionContent: stem, chunks: [{ text: step }], tau: 0.4 });
  // 题干块只能蹭到「题面部分」，判别口径必须显著低于含完整步骤的块
  assert.ok(stemOnly.coverageSkeletonNoEcho < full.coverageSkeletonNoEcho);
  assert.ok(full.coverageSkeletonNoEcho >= 0.99);
});

test('queryStepCoverage：题面回声步骤被标记并从判别口径剔除', () => {
  const stem = '一块长8分米宽4分米的长方形纸板与两块边长4分米的正方形纸板拼成一个正方形';
  const cov = queryStepCoverage({ analysis: stem, questionContent: stem, chunks: [{ text: '无关内容' }], tau: 0.4 });
  assert.ok(cov.nStemEcho >= 1);
  assert.strictEqual(cov.coverageSkeletonNoEcho, null); // 无可判别步骤 → 不可定义即拒绝给数
});

test('queryStepCoverage：tau 非法值必须报错而不是静默', () => {
  assert.throws(() => queryStepCoverage({ analysis: 'a', chunks: [], tau: 0 }), /tau/);
  assert.throws(() => queryStepCoverage({ analysis: 'a', chunks: [], tau: 1.5 }), /tau/);
});

test('coverageAtTau：随 τ 单调不增，且与单点计算结果一致', () => {
  const step = '先求速度和再除以二';
  const chunk = { text: '先求速度和' };
  const cov = queryStepCoverage({ analysis: step, questionContent: '', chunks: [chunk], tau: 0.4 });
  const at04 = coverageAtTau(cov.detail, 0.4, { variant: 'skeletonResidual' });
  assert.strictEqual(at04, cov.coverageSkeletonNoEcho);
  const seq = [0.2, 0.4, 0.6, 0.8, 1.0].map((t) => coverageAtTau(cov.detail, t, { variant: 'skeletonResidual' }));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1] + 1e-12);
});

test('selectTau：必须用 detail 在该 τ 上重算，不能用已存字段（回归：扫描曾退化成常数）', () => {
  const mk = (max) => ({ stemEcho: false, stepClass: 'prose', literalMax: max, skeletonMax: max, literalResidualMax: max, skeletonResidualMax: max });
  const rows = [];
  // X 臂：包含度 0.45 → 在 τ ≤ 0.45 被判覆盖（1.0），τ ≥ 0.5 降为 0
  for (let i = 0; i < 4; i++) rows.push({ queryId: `q${i}`, arm: 'X', _detail: [mk(0.45)], coverageSkeletonNoEcho: 1 });
  // R 臂：包含度 0.9
  for (let i = 0; i < 4; i++) rows.push({ queryId: `q${i}`, arm: 'R', _detail: [mk(0.9)], coverageSkeletonNoEcho: 1 });
  const sel = selectTau(rows, { chanceCeiling: 0.15 });
  assert.strictEqual(sel.tau, 0.5, '若返回 0.3 说明仍在读常量字段而非按 τ 重算');
  assert.ok(sel.sweep.find((s) => s.tau === 0.3).X > 0.15);
  assert.strictEqual(sel.sweep.find((s) => s.tau === 0.5).X, 0);
});

test('selectTau：网格内无候选时返回 null 且给出原因，不放宽阈值', () => {
  const mk = (max) => ({ stemEcho: false, stepClass: 'prose', literalMax: max, skeletonMax: max, literalResidualMax: max, skeletonResidualMax: max });
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push({ queryId: `q${i}`, arm: 'X', _detail: [mk(0.05)] });
  for (let i = 0; i < 4; i++) rows.push({ queryId: `q${i}`, arm: 'R', _detail: [mk(0.9)] });
  const sel = selectTau(rows, { chanceCeiling: 0.15 });
  assert.strictEqual(sel.tau, 0.3); // τ 越低越容易覆盖，0.3 处 X 已 ≤ 0.15
  const none = selectTau(rows, { chanceCeiling: -1 });
  assert.strictEqual(none.tau, null);
  assert.match(none.fallback, /不可用/);
});

test('extractExpressions：等式抽取 + 裸算式去重 + 复合标记', () => {
  const exprs = extractExpressions('$$3580\\div 20-80=99$$（米/分）');
  assert.strictEqual(exprs.length, 1, '裸前缀 3580÷20-80 是等式前缀，不应重复计');
  assert.strictEqual(exprs[0].skeleton, '#÷#-#=#');
  assert.strictEqual(exprs[0].compound, true);

  const simple = extractExpressions('$$8\\times 4=32$$');
  assert.strictEqual(simple[0].compound, false);

  const bare = extractExpressions('$$1+2+9$$');
  assert.strictEqual(bare.length, 1);
  assert.strictEqual(bare[0].kind, 'bare');
});

test('expressionCoverage：同骨架不同数值算命中，同数值字面单独记', () => {
  const analysis = '需要算$$28\\div 4=7$$';
  const sameSkeleton = expressionCoverage({ analysis, chunks: [{ text: '例题：$$100\\div 5=20$$' }] });
  assert.strictEqual(sameSkeleton.coverageAny, 1);
  assert.strictEqual(sameSkeleton.coverageLiteral, 0);

  const sameLiteral = expressionCoverage({ analysis, chunks: [{ text: '例题：$$28\\div 4=7$$' }] });
  assert.strictEqual(sameLiteral.coverageLiteral, 1);
});

test('expressionCoverage：无算式时返回 null 而不是 0（不可定义即不给数）', () => {
  const r = expressionCoverage({ analysis: '如下图，平移即可', chunks: [{ text: '随便' }] });
  assert.strictEqual(r.nExpr, 0);
  assert.strictEqual(r.coverageAny, null);
});

test('残差阈值：题干占比过高即判为题面回声', () => {
  assert.ok(STEM_RESIDUAL_MIN_SHARE > 0 && STEM_RESIDUAL_MIN_SHARE < 0.5);
});
