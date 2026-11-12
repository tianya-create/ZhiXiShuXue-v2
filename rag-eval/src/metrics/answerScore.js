/**
 * 答案评分：token-F1（主指标）+ exact-match（次指标）。
 *
 * 口径（预注册，运行后不得改）：
 *  - 归一化：NFKC → 小写 → 去 LaTeX 定界符 $ / \left \right / 空白 → 去中英文标点与句末单位前的空白；
 *    保留数字、字母、CJK、小数点、负号与分数斜杠以外的内容一律丢弃。
 *  - 切词：CJK 逐字；拉丁/数字连续段为一个 token（小数、百分数保持整体）。
 *  - F1：token 多重集上的 P/R 调和平均；两串皆空视为 1，仅一方为空视为 0。
 *  - EM：归一化后逐字相等。
 */

// 注意：不删小数点和负号（"3.5"、"−5" 是有意义的答案），只删分隔性标点
const PUNCT = /[，。、；：？！,;:?!"'“”‘’（）()\[\]【】{}<>《》—–_/\\|~`@#$%^&*+=]/g;

function normalizeAnswer(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\$\$?/g, '')
    .replace(/\\left|\\right|\\text|\\mathrm/g, '')
    .replace(/\s+/g, '')
    .replace(PUNCT, '')
    .trim();
}

function tokenize(s) {
  const out = [];
  const re = /([\u4e00-\u9fff])|([a-z]+)|(\d+(?:\.\d+)?%?)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] || m[2] || m[3]);
  return out;
}

function f1Of(pred, gold) {
  const p = tokenize(normalizeAnswer(pred));
  const g = tokenize(normalizeAnswer(gold));
  if (p.length === 0 && g.length === 0) return 1;
  if (p.length === 0 || g.length === 0) return 0;
  const cnt = new Map();
  for (const t of g) cnt.set(t, (cnt.get(t) || 0) + 1);
  let hit = 0;
  for (const t of p) {
    const c = cnt.get(t) || 0;
    if (c > 0) { hit += 1; cnt.set(t, c - 1); }
  }
  const precision = hit / p.length;
  const recall = hit / g.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function exactMatch(pred, gold) {
  return normalizeAnswer(pred) === normalizeAnswer(gold) ? 1 : 0;
}

/** 从模型输出中抽最终答案：取最后一个非空行；行内若含「答案：」只取冒号后 */
function extractFinalAnswer(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  let last = lines[lines.length - 1];
  const m = last.match(/^(?:最终)?答案(?:是|为)?[：:]?\s*(.+)$/);
  if (m) last = m[1].trim();
  return last.replace(/^[\s"'“”]+|[\s"'“”。.]+$/g, '');
}

/** 单条记录评分 */
function scoreRecord({ output, goldAnswer }) {
  const pred = extractFinalAnswer(output);
  return { pred, tokenF1: f1Of(pred, goldAnswer), exactMatch: exactMatch(pred, goldAnswer) };
}

module.exports = { normalizeAnswer, tokenize, f1Of, exactMatch, extractFinalAnswer, scoreRecord };
