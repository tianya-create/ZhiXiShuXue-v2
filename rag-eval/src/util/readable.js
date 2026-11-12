'use strict';

/**
 * 把 XES3G5M 的原始文本（含 $$LaTeX$$ 与内部图片文件名）转成人类可读形式。
 *
 * 为什么需要：人工校准表直接给人看，而题库原文是 `$$46\times 99$$` 与
 * `question_3124-image_0` 这种机器记号。直接落 CSV 会被人当成「乱码」。
 *
 * 设计边界（重要）：
 * - 本模块**只用于展示**（人工校准表 / HTML 审阅器 / 报告引用）。
 * - 绝不用于评测管线：语料分块、BM25 索引、步骤覆盖率匹配仍用原文，
 *   否则等于在评测中途换数据，冻结清单失效。
 * - 转换必须是无损可追溯的：图片占位符换成【图N】但同时在 attachments 里
 *   返回真实文件名，调用方可选择在旁边列出。
 */

/** 图片占位符：question_3124-image_0 / analysis_1198-image_1 */
const IMAGE_REF = /(question|analysis)_([A-Za-z0-9_-]+)-image_(\d+)/g;

/** 从文本中抽出图片引用（去重、保序） */
function extractImageRefs(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(IMAGE_REF)) {
    const file = `${m[0]}.png`;
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({ placeholder: m[0], file, origin: m[1] });
  }
  return out;
}

/** 常用 LaTeX 命令 → unicode / 普通字符。顺序有讲究：长的先替换。 */
const CMD_MAP = [
  // 分式先处理（带参数），见 replaceFractions
  ['\\dfrac', '/'],
  ['\\tfrac', '/'],
  ['\\times', '×'],
  ['\\div', '÷'],
  ['\\cdot', '·'],
  ['\\pm', '±'],
  ['\\mp', '∓'],
  ['\\leq', '≤'],
  ['\\geq', '≥'],
  ['\\le', '≤'],
  ['\\ge', '≥'],
  ['\\neq', '≠'],
  ['\\ne', '≠'],
  ['\\approx', '≈'],
  ['\\equiv', '≡'],
  ['\\angle', '∠'],
  ['\\triangle', '△'],
  ['\\parallel', '∥'],
  ['\\perp', '⊥'],
  ['\\because', '∵'],
  ['\\therefore', '∴'],
  ['\\infty', '∞'],
  ['\\pi', 'π'],
  ['\\alpha', 'α'],
  ['\\beta', 'β'],
  ['\\theta', 'θ'],
  ['\\circ', '°'],
  ['\\degree', '°'],
  ['\\%', '%'],
  ['\\$', '$'],
  ['\\{', '{'],
  ['\\}', '}'],
  ['\\_', '_'],
  ['\\&', '&'],
  ['\\#', '#'],
];

/** 上标数字 → unicode */
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', '+': '⁺', '-': '⁻' };

function replaceSuperscripts(s) {
  return s.replace(/\^\{?([0-9n+\-]{1,3})\}?/g, (m, g) => {
    const conv = [...g].map((c) => SUP[c]).join('');
    return conv || m;
  });
}

/** 花括号参数：\dfrac{1}{2} → 1/2；\sqrt{3} → √(3)；\text{厘米} → 厘米 */
function replaceBracedCommands(s) {
  let prev;
  let out = s;
  // 迭代处理嵌套（内层先解）
  for (let i = 0; i < 6; i++) {
    prev = out;
    out = out
      .replace(/\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) => `${stripBraces(a)}/${stripBraces(b)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, a) => `√(${stripBraces(a)})`)
      .replace(/\\(?:text|mathrm|mathbf|mathit|textrm|mbox)\s*\{([^{}]*)\}/g, (m, a) => stripBraces(a));
    if (out === prev) break;
  }
  return out;
}

function stripBraces(s) {
  return String(s).replace(/[{}]/g, '');
}

/** 转义正则元字符（CMD_MAP 里的键都含反斜杠） */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 主入口：LaTeX → 可读文本。
 * @param {string} text
 * @param {{imageMode?: 'filename'|'numbered'|'keep'}} [opts]
 *   filename：保留真实文件名（便于核对）；numbered：换【图N】；keep：不动
 */
function toReadable(text, opts = {}) {
  const { imageMode = 'numbered' } = opts;
  let s = String(text == null ? '' : text);

  // 1) 图片占位符先抽出计数
  const refs = extractImageRefs(s);
  if (refs.length) {
    let idx = 0;
    const map = new Map(refs.map((r) => [r.placeholder, ++idx]));
    if (imageMode === 'numbered') {
      s = s.replace(IMAGE_REF, (m) => `【图${map.get(m)}】`);
    } else if (imageMode === 'keep') {
      // 不动
    } else {
      s = s.replace(IMAGE_REF, (m) => `【图:${m}.png】`);
    }
  }

  // 2) 数学定界符：直接删。LaTeX 里 $$ 只是定界，不是空格；
  //    留空格会把 `$$63$$只` 变成 `63 只`，反而制造虚假分词。
  s = s.replace(/\$\$/g, '');
  s = s.replace(/\$/g, '');

  // 3) 带参命令（分式/根号/文本）
  s = replaceBracedCommands(s);

  // 4) 布局类命令直接删；细空格（\, \; \: \!）删，粗空格（\quad）留一个空格
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '');
  s = s.replace(/\\(?:qquad|quad)\b/g, ' ');
  s = s.replace(/\\[,;:!]/g, '');
  s = s.replace(/\\\s/g, ' ');

  // 5) 简单命令映射（长串优先，避免 \le 吃掉 \leq 的前缀）。
  //    同时吃掉命令后的空格：LaTeX 里 `\times 99` 的空格无语义，
  //    留着会得到 `46× 99`，与原文 `46×99` 不符。
  const sorted = [...CMD_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [cmd, rep] of sorted) {
    s = s.replace(new RegExp(`${escapeRe(cmd)}\\s*`, 'g'), rep);
  }

  // 6) 剩余未知命令：去反斜杠，保留名字（好过留一堆 \foo 给人看）
  s = s.replace(/\\([a-zA-Z]+)/g, '$1');

  // 7) 上标、花括号
  s = replaceSuperscripts(s);
  s = s.replace(/[{}]/g, '');

  // 8) 空白整理（尊重原有换行结构：先把换行占位）
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 单行版（用于 CSV 单元格）：换行 → 空格 */
function toReadableInline(text, opts) {
  return toReadable(text, opts).replace(/\n+/g, ' ');
}

/** 是否依赖图片才能作答（题面引用图片，或出现「如图/下图/图中」等提示） */
function needsImage(text) {
  const s = String(text || '');
  if (extractImageRefs(s).length > 0) return true;
  return /如图|如下图|下图中|图中|图所示|见图|如图所示/.test(s);
}

module.exports = { toReadable, toReadableInline, extractImageRefs, needsImage, IMAGE_REF };
