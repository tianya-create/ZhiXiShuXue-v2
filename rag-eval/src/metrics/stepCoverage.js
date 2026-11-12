/**
 * 替代 L1：步骤覆盖率（step coverage）——不依赖 gold doc 命中的检索有效性度量。
 *
 * 为什么需要它（设计 §7.3 / Stage 1 遗留项）：
 *   在题库语料 + leave-one-out 协议下，「gold doc 命中」按定义为 0——检索到的
 *   永远是别的题。此时 ret-strong 缺 L1 直接证据。本模块换一个问法：
 *   「检索到的上下文里，有没有出现解这道题所需要的推理步骤」，
 *   而不是「有没有检索到这道题」。
 *
 * 四层设计（每一层都在挡一种具体的伪信号）：
 *   1) 步骤化：gold 解析切成句子级步骤，剔除标签、图片占位符、纯答案回声。
 *   2) 残差匹配（核心）：把步骤的 n-gram 减去题干自身的 n-gram，只用「题干里
 *      没有的那部分」去匹配。理由：同题型相邻题的题干高度相似，任何题面照抄都会
 *      被白送覆盖；而「解这道题需要的推理」恰恰是题干里没有的内容。
 *   3) 双口径：literal（数值保留）与 skeleton（数字归一为 #）。跨题数值必然不同，
 *      literal 只抓得到近似原题；skeleton 才是「方法级迁移」。
 *   4) 零基线：数学语料共享大量套话（"所以"、"先求"），任何 chunk 都能蹭到一点
 *      覆盖率。因此主口径定义为 ΔStepCov = R − X（与主效应 ΔREL=R−X 同构），
 *      绝不用 R 的绝对值讲故事。
 *
 * 辅助口径（算式级）：把解析里的算式抽成 `a op b = c` 单元，比较「算子骨架」是否
 *   出现在检索块中。单句解析（本题库 56% 的题只有 1 步）在句子级只有 0/1 二分，
 *   算式级能给出更细的粒度，也最贴近数学题的「可迁移单元」。
 */

const { shingleSet, normalizeForShingle } = require('../clustering/cluster');

const STEP_MIN_CHARS = 6;            // 归一化后短于此且不含算式 → 视为碎片
const STEM_RESIDUAL_MIN_SHARE = 0.25; // 步骤 n-gram 中「非题干」占比低于此 → 判为题面回声
const SHINGLE_K = 3;                 // 中文短步骤：3-gram（5-gram 在 20 字步骤上过稀）

/** LaTeX 归一：只做与「文本可比」相关的替换，不做语义改写 */
function normalizeMath(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\times|\\cdot/g, '×');
  s = s.replace(/\\div/g, '÷');
  s = s.replace(/\\cdots|\\ldots|\\dots/g, '…');
  s = s.replace(/\\left|\\right|\\quad|\\qquad/g, '');
  s = s.replace(/\\[,;:! ]/g, '');
  s = s.replace(/\\%/g, '%');
  s = s.replace(/\\/g, '');
  s = s.replace(/\$/g, '');
  s = s.replace(/[－﹣−–—]/g, '-');
  s = s.replace(/＋/g, '+');
  s = s.replace(/[＊×✕]/g, '×');
  s = s.replace(/[／]/g, '/');
  s = s.replace(/[＝]/g, '=');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  return s.trim();
}

const STEP_LABEL = /^(?:解析|解答|解|分析|答|答案|考点|点评|点睛|思路|过程|方法)\s*[:：]\s*/;
const IMAGE_PLACEHOLDER = /^\[图:[^\]]*\]$/;

/** 纯答案回声（"故答案为：29"）不是步骤：不携带推理，且被任意 chunk 的答案段覆盖 */
function isAnswerEcho(step) {
  const n = normalizeForShingle(step);
  if (!n) return true;
  const stripped = n.replace(/^(?:故|所以|因此|综上|综上可得)/, '');
  if (/^(?:答案|答)(?:是|为)?/.test(stripped)) {
    return stripped.replace(/^(?:答案|答)(?:是|为)?/, '').length <= 10;
  }
  return false;
}

/** 含算式（数字+算子）的碎片即使短也保留：它本身就是一步计算 */
function hasArithmetic(step) {
  return /[0-9０-９]/.test(step) && /[+\-×÷/=]/.test(step);
}

/** 解析本身不可用（纯图片/纯答案/只有标签）：这类题无法构造步骤，必须计入剔除而非强行切分 */
function isUnusableAnalysis(analysis) {
  const s = normalizeMath(analysis).replace(/\[图:[^\]]*\]/g, '');
  const t = s
    .replace(/方法[一二三四五六七八九十\d]*|画流程图|如下图|如图|解析|解答|解|答|略|同上/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return t.length < 8;
}

/**
 * 把 gold 解析切成步骤。规则全部确定性（无随机、无模型），便于冻结与复现。
 * @returns {string[]}
 */
function splitSteps(analysis) {
  const norm = normalizeMath(analysis);
  if (!norm) return [];
  const parts = norm.split(/[。；;．\n]+/);
  const steps = [];
  for (const raw of parts) {
    let p = String(raw).trim();
    if (!p) continue;
    p = p.replace(STEP_LABEL, '').trim();
    if (!p) continue;
    if (IMAGE_PLACEHOLDER.test(p)) continue;      // 图片标记不是推理步骤
    if (isAnswerEcho(p)) continue;
    const key = normalizeForShingle(p);
    if (key.length < STEP_MIN_CHARS && !hasArithmetic(p)) {
      if (steps.length) steps[steps.length - 1] = steps[steps.length - 1] + '，' + p;
      continue;
    }
    steps.push(p);
  }
  const seen = new Set();
  const out = [];
  for (const s of steps) {
    const k = normalizeForShingle(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** 匹配用归一：先做 LaTeX 归一（否则 doc 里的 \div 会变成字面 "div"，
 *  与解析里的 ÷ 永远匹配不上），再留 CJK/字母/数字/#/算子/括号，去标点空白。
 *  括号必须保留：'(8-2)×(8-2)' 与 '8-2×8-2' 是两个不同的算式。 */
function normalizeForMatch(text) {
  return normalizeForShingle(normalizeMath(text)).replace(/[^\p{L}\p{N}#+\-×÷=√/%^()]/gu, '');
}

/** 数字连续段归一为单个 #（"100÷5=20" 与 "28÷4=7" 同骨架 → 方法级可比） */
function skeletonize(text) {
  return text.replace(/[0-9０-９]+/g, '#');
}

function shinglesOf(text, { skeleton = false, k = SHINGLE_K } = {}) {
  let s = normalizeForMatch(text);
  if (skeleton) s = skeletonize(s);
  return shingleSet(s, k);
}

function containmentOf(stepShingles, chunkShingles) {
  if (!stepShingles || stepShingles.size === 0) return 0;
  let inter = 0;
  for (const g of stepShingles) if (chunkShingles.has(g)) inter++;
  return inter / stepShingles.size;
}

/** 残差集：步骤 n-gram 去掉题干 n-gram 后剩下的部分（= 检索需要补上的推理内容） */
function residualOf(stepShingles, stemShingles) {
  const out = new Set();
  for (const g of stepShingles) if (!stemShingles.has(g)) out.add(g);
  return out;
}

function stepClassOf(step) {
  return /[0-9０-９]/.test(step) ? 'numeric' : 'prose';
}

/**
 * 单 query 的步骤覆盖率。detail 里的 max 值**与 tau 无关**，因此可用
 * coverageAtTau 在任意 τ 上精确复算（τ 扫描不必重算 n-gram，也不会与单点结果不一致）。
 */
function queryStepCoverage({ analysis, questionContent = '', chunks = [], tau = 0.5, k = SHINGLE_K }) {
  if (!Number.isFinite(tau) || tau <= 0 || tau > 1) {
    throw new Error(`queryStepCoverage: tau 必须在 (0,1]，收到 ${tau}`);
  }
  const steps = splitSteps(analysis);
  const stemLit = shinglesOf(questionContent, { skeleton: false, k });
  const stemSke = shinglesOf(questionContent, { skeleton: true, k });
  const chunkSets = chunks.map((c) => ({
    docId: c.docId || null,
    literal: shinglesOf(c.text, { skeleton: false, k }),
    skeleton: shinglesOf(c.text, { skeleton: true, k }),
  }));

  const detail = steps.map((step) => {
    const litStep = shinglesOf(step, { skeleton: false, k });
    const skeStep = shinglesOf(step, { skeleton: true, k });
    const litRes = residualOf(litStep, stemLit);
    const skeRes = residualOf(skeStep, stemSke);
    const shareFromStem = litStep.size ? 1 - litRes.size / litStep.size : 1;
    let litMax = 0;
    let skeMax = 0;
    let litResMax = 0;
    let skeResMax = 0;
    for (const c of chunkSets) {
      if (litMax < 1) litMax = Math.max(litMax, containmentOf(litStep, c.literal));
      if (skeMax < 1) skeMax = Math.max(skeMax, containmentOf(skeStep, c.skeleton));
      if (litResMax < 1) litResMax = Math.max(litResMax, containmentOf(litRes, c.literal));
      if (skeResMax < 1) skeResMax = Math.max(skeResMax, containmentOf(skeRes, c.skeleton));
    }
    return {
      text: step.length > 120 ? step.slice(0, 120) + '…' : step,
      stepClass: stepClassOf(step),
      shareFromStem,
      // 残差过小 = 这一步基本是把题干再说一遍，不携带推理
      stemEcho: litRes.size === 0 || litRes.size / litStep.size < STEM_RESIDUAL_MIN_SHARE,
      literalMax: litMax,
      skeletonMax: skeMax,
      literalResidualMax: litResMax,
      skeletonResidualMax: skeResMax,
      residualShingles: litRes.size,
    };
  });

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  const disc = detail.filter((d) => !d.stemEcho);
  const pick = (rows, key, t) => (rows.length ? rows.filter((d) => d[key] >= t).length / rows.length : null);

  return {
    k,
    nSteps: detail.length,
    nStemEcho: detail.length - disc.length,
    nNumeric: detail.filter((d) => d.stepClass === 'numeric').length,
    tau,
    coverageLiteral: pick(detail, 'literalMax', tau),
    coverageSkeleton: pick(detail, 'skeletonMax', tau),
    coverageLiteralNoEcho: pick(disc, 'literalResidualMax', tau),
    coverageSkeletonNoEcho: pick(disc, 'skeletonResidualMax', tau),
    coverageSkeletonNumericNoEcho: pick(disc.filter((d) => d.stepClass === 'numeric'), 'skeletonResidualMax', tau),
    coverageSkeletonProseNoEcho: pick(disc.filter((d) => d.stepClass === 'prose'), 'skeletonResidualMax', tau),
    meanContainmentSkeleton: mean(detail.map((d) => d.skeletonMax)),
    meanContainmentSkeletonResidual: mean(disc.map((d) => d.skeletonResidualMax)),
    detail,
  };
}

/** 由逐步骤最大包含度推导任意 τ 下的覆盖率（与单点计算逐位一致：同一份 detail） */
function coverageAtTau(detail, tau, { variant = 'skeletonResidual', noEchoOnly = true, stepClass = null } = {}) {
  const key = {
    literal: 'literalMax',
    skeleton: 'skeletonMax',
    literalResidual: 'literalResidualMax',
    skeletonResidual: 'skeletonResidualMax',
  }[variant];
  if (!key) throw new Error(`coverageAtTau: 未知 variant ${variant}`);
  const rows = detail.filter((d) => (!noEchoOnly || !d.stemEcho) && (!stepClass || d.stepClass === stepClass));
  if (!rows.length) return null;
  return rows.filter((d) => d[key] >= tau).length / rows.length;
}

// ---------------------------------------------------------------------------
// 辅助口径：算式级覆盖
// ---------------------------------------------------------------------------

/** 从解析抽算式单元：优先 "a op b = c"，其次算子数 ≥2 的裸算式（无等号） */
function extractExpressions(analysis) {
  const s = normalizeMath(analysis).replace(/\s+/g, '');
  const out = [];
  const seen = new Set();
  const push = (expr, kind) => {
    const lit = normalizeForMatch(expr);
    if (!lit) return;
    const ske = skeletonize(lit);
    const ops = (ske.match(/[+\-×÷]/g) || []).length;
    if (ops < 1) return;
    const key = `${kind}|${ske}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ expr, literal: lit, skeleton: ske, ops, compound: ops >= 2, kind });
  };
  // a op b ... = c
  const reEq = /[0-9()+\-×÷/√^.]*[0-9)][0-9()+\-×÷/√^.]*=[0-9.]+/g;
  for (const m of s.match(reEq) || []) push(m, 'equation');
  // 裸算式（无等号）：数字与算子交替 ≥3 个数字
  const reBare = /[0-9]+(?:[+\-×÷][0-9]+){2,}/g;
  for (const m of s.match(reBare) || []) {
    const lit = normalizeForMatch(m);
    // 已被某个等式包含（如 "3580÷20-80" 是 "3580÷20-80=99" 的前缀）→ 不重复计一步
    if (out.some((o) => o.literal === lit || o.literal.includes(lit))) continue;
    push(m, 'bare');
  }
  return out;
}

/**
 * 算式级覆盖：gold 解析里的算式，其「算子骨架」是否出现在检索块的骨架串里。
 * 用字符串包含而非 n-gram：算式是短符号串，精确结构相等才有意义。
 */
function expressionCoverage({ analysis, chunks = [] }) {
  const exprs = extractExpressions(analysis);
  if (!exprs.length) return { nExpr: 0, nCompound: 0, coverageAny: null, coverageCompound: null, coverageLiteral: null, detail: [] };
  const litChunks = chunks.map((c) => normalizeForMatch(c.text));
  const skeChunks = litChunks.map((t) => skeletonize(t));
  const detail = exprs.map((e) => {
    const literalHit = litChunks.some((t) => t.includes(e.literal));
    const skeletonHit = skeChunks.some((t) => t.includes(e.skeleton));
    return { expr: e.expr, skeleton: e.skeleton, ops: e.ops, compound: e.compound, literalHit, skeletonHit };
  });
  const frac = (rows, pred) => (rows.length ? rows.filter(pred).length / rows.length : null);
  const comp = detail.filter((d) => d.compound);
  return {
    nExpr: detail.length,
    nCompound: comp.length,
    coverageAny: frac(detail, (d) => d.skeletonHit),
    coverageCompound: frac(comp, (d) => d.skeletonHit),
    coverageLiteral: frac(detail, (d) => d.literalHit),
    detail,
  };
}

/**
 * 在 τ 网格上扫 dev 集，按预注册规则选 τ：
 *   取「X 臂（等长随机上下文）判别口径覆盖率 ≤ chanceCeiling」的最小 τ。
 * 规则先写死再看数——避免"挑一个让 R 好看"的 τ。
 */
function selectTau(devRows, {
  grid = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
  chanceCeiling = 0.15,
  variant = 'skeletonResidual',
  noEchoOnly = true,
} = {}) {
  const sweep = [];
  for (const tau of grid) {
    const perArm = {};
    for (const arm of ['X', 'R', 'O']) {
      // 必须用 detail（与 τ 无关）在此 τ 上重算；直接读行里已存的覆盖率会锁定在
      // 某一个 τ 上，让扫描退化成常数（这是实现时踩过的坑，留注释防复发）。
      perArm[arm] = meanOf(
        devRows
          .filter((r) => r.arm === arm && Array.isArray(r._detail))
          .map((r) => coverageAtTau(r._detail, tau, { variant, noEchoOnly }))
      );
    }
    sweep.push({
      tau,
      X: perArm.X, R: perArm.R, O: perArm.O,
      sep: perArm.R !== null && perArm.X !== null ? perArm.R - perArm.X : null,
    });
  }
  const ok = sweep.filter((s) => s.X !== null && s.X <= chanceCeiling);
  const chosen = ok.length ? ok[0] : null;
  return {
    field: `${variant}${noEchoOnly ? '（剔除题面回声）' : ''}`,
    chanceCeiling,
    grid,
    sweep,
    tau: chosen ? chosen.tau : null,
    rule: `最小 τ 使 X 臂判别口径覆盖率 ≤ ${chanceCeiling}（零基线不得自带信号）`,
    fallback: chosen ? null : '网格内无满足条件者：说明语料词汇重叠过强，此指标不可用，须如实报告而非放宽 ceiling',
  };
}

function meanOf(arr) {
  const v = arr.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

module.exports = {
  STEP_MIN_CHARS,
  STEM_RESIDUAL_MIN_SHARE,
  SHINGLE_K,
  normalizeMath,
  splitSteps,
  isUnusableAnalysis,
  isAnswerEcho,
  hasArithmetic,
  normalizeForMatch,
  skeletonize,
  shinglesOf,
  containmentOf,
  residualOf,
  queryStepCoverage,
  coverageAtTau,
  extractExpressions,
  expressionCoverage,
  selectTau,
  meanOf,
};
