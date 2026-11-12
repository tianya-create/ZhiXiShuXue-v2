/**
 * XES3G5M 题库侧语料接入适配器。
 *
 * 数据来源与许可（必须随 corpus manifest 留痕）：
 *  - 官方：github.com/ai4ed/XES3G5M（MIT），完整 questions.json（content/kc_routes/
 *    answer/options/analysis/type）存于 Google Drive，国内网络不可直连，需手动下载。
 *  - 已落地子集：HF Gyikoo/KT4EQG-data 中的 data/dataset/XES3G5M/zh_question_info.json
 *    （7,618 题，仅 content/kc/difficulty，无解析与答案；content 约 99.4% 为英译文本，
 *    KC 名保留中文），仅用于管道验证，禁止作为正式评测语料——P0 报告必须标注 degraded。
 *
 * 支持两种输入（自动识别）：
 *  - full   : questions.json   { qid: { content, kc_routes, answer, options, analysis, type } }
 *  - subset : zh_question_info.json { qid: { content, kc, difficulty } }
 *
 * 转换规则：
 *  - 每题一个 doc（docId = `xes-q<qid>`），full 模式 doc text = content + "\n解析：" + analysis；
 *    options 单选题拼入题面（与线上题目呈现一致）。
 *  - 剔除空 content / 空 kc 路由的题，剔除数写进 manifest（不得静默丢弃）。
 *  - img 占位符（question_qid-image_index 等）统一改写为 `[图:<name>]`，防止分块器
 *    把下划线长 token 当成普通词。
 */
'use strict';

const fs = require('fs');
const { sha256OfText } = require('../util/hash');

const LICENSE_NOTE = {
  dataset: 'XES3G5M',
  license: 'MIT',
  officialSource: 'https://github.com/ai4ed/XES3G5M',
  note: '原始数据由 TAL 通过 Google Drive 分发；使用即视为同意其许可。',
};

/** 识别文件格式 */
function detectMode(raw) {
  const sample = raw[Object.keys(raw)[0]];
  if (sample && typeof sample === 'object' && 'analysis' in sample) return 'full';
  if (sample && typeof sample === 'object' && 'kc' in sample && 'difficulty' in sample) return 'subset';
  throw new Error('无法识别的 XES3G5M 元数据格式（既无 analysis 也无 kc/difficulty 字段）');
}

/** 归一图片占位符 */
function rewriteImagePlaceholders(text) {
  return text.replace(/(question|analysis)_([A-Za-z0-9_-]+)-image_(\d+)/g, '[图:$1-$2-$3]');
}

/** docText 组装（full 与 subset 通用入口）。真实格式（2023 官方包验证）：
 *  options 是 dict {A:'$$25$$',...}，type 为 '填空'/'单选'，answer 是 list，kc_routes
 *  是 list of 'A----B----C' 字符串。doc 文本不含答案（答案属于评测侧，不入语料）。 */
function docTextOf(q, mode) {
  const content = rewriteImagePlaceholders(String(q.content || '').trim());
  if (mode === 'subset') return content;
  let options = '';
  const opt = q.options;
  if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
    const parts = Object.entries(opt).map(([letter, val]) => `${letter}. ${String(val).trim()}`);
    if (parts.length > 0) options = '\n选项：' + parts.join(' ');
  } else if (Array.isArray(opt) && opt.length > 0) {
    options = '\n选项：' + opt.map((o, i) => `${'ABCD'[i] || '?'}. ${String(o).trim()}`).join(' ');
  }
  const analysis = q.analysis ? '\n解析：' + rewriteImagePlaceholders(String(q.analysis).trim()) : '';
  return content + options + analysis;
}

/** KC 标识：full 用 kc_routes 首条的顶层模块（'----' 分隔）；subset 用 kc 字段 */
function kcIdOf(q, mode) {
  if (mode === 'subset') return String(q.kc || '').trim();
  const routes = Array.isArray(q.kc_routes) && q.kc_routes.length > 0 ? q.kc_routes : [q.kc_routes];
  const r = routes[0];
  if (typeof r === 'string' && r.trim()) return r.trim().split(/-{2,}|→|>/)[0].trim();
  if (Array.isArray(r) && r.length > 0) return String(r[0]).trim();
  return '';
}

/** 答案探针文本（评测侧用）：list → join，剥 $$..$$ LaTeX 定界；单选返回选项字母时
 *  由调用方决定是否跳过（单字母探针无区分度）。 */
function answerProbeOf(q) {
  const ans = Array.isArray(q.answer) ? q.answer.join(' ') : String(q.answer || '');
  return ans.replace(/\$\$?/g, '').trim();
}

/**
 * 主入口：读元数据 JSON → docs
 * @returns {{ mode, docs: Array<{docId,text,kcId,qid}>, dropped: Array<{qid,reason}>, stats }}
 */
function loadXes3g5mCorpus({ questionsPath }) {
  const raw = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
  const mode = detectMode(raw);
  const docs = [];
  const dropped = [];
  for (const [qid, q] of Object.entries(raw)) {
    const text = docTextOf(q, mode);
    const kcId = kcIdOf(q, mode);
    if (!text || text.length < 10) { dropped.push({ qid, reason: 'content 为空或过短' }); continue; }
    if (!kcId) { dropped.push({ qid, reason: 'kc 路由为空' }); continue; }
    docs.push({ docId: `xes-q${qid}`, qid, kcId, text });
  }
  const chars = docs.map((d) => d.text.length);
  const stats = {
    questionsTotal: Object.keys(raw).length,
    docsKept: docs.length,
    dropped: dropped.length,
    charMin: Math.min(...chars),
    charMedian: median(chars),
    charMax: Math.max(...chars),
  };
  return { mode, docs, dropped, stats, license: LICENSE_NOTE };
}

function median(a) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 原始题目索引（评测侧用）：qid → {content, analysis, type, kcId}。
 *  与 loadXes3g5mCorpus 的区别：这里不做 doc 组装、不丢题，供 gold 解析类指标读取。 */
function loadRawQuestions({ questionsPath }) {
  const raw = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
  const mode = detectMode(raw);
  const map = new Map();
  for (const [qid, q] of Object.entries(raw)) {
    map.set(String(qid), {
      qid: String(qid),
      content: rewriteImagePlaceholders(String(q.content || '').trim()),
      analysis: rewriteImagePlaceholders(String(q.analysis || '').trim()),
      type: q.type || null,
      kcId: kcIdOf(q, mode),
    });
  }
  return { mode, map };
}

/** 语料 manifest（sha256 留痕 + 来源声明），落盘给 Stage 冻结用 */
function corpusManifest(corpus) {
  return {
    source: corpus.license,
    mode: corpus.mode,
    stats: corpus.stats,
    dropped: corpus.dropped,
    docs: corpus.docs.map((d) => ({ docId: d.docId, qid: d.qid, kcId: d.kcId, textSha256: sha256OfText(d.text) })),
  };
}

module.exports = {
  loadXes3g5mCorpus,
  loadRawQuestions,
  corpusManifest,
  rewriteImagePlaceholders,
  kcIdOf,
  docTextOf,
  answerProbeOf,
  detectMode,
  LICENSE_NOTE,
};
