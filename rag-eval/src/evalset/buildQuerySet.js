/**
 * Stage 0 第一步：从 XES3G5M 构造 dev/eval 评测 query 集。
 *
 * 本模块完全 LLM 无关，可在接入生成器之前先产出并冻结（sha256 留痕）。
 *
 * 构造规则（对应设计文档 §6）：
 *  - 每条 query 由一道「填空题」改写而来：query 文本 = 确定性模板之一包裹题面，
 *    gold answer = answerProbeOf（剥 $$..$$ 后的答案文本）。
 *  - 同一 qid 只产生一条 query → query 簇 = 单例簇（簇 id = qc-xes-<qid>），
 *    dev/eval 按 qid 分割，天然满足「同事实不同问法不跨集」防泄漏断言。
 *  - oracle doc = 该题自身 doc（xes-q<qid>），供 O 臂与 oracle recall 使用。
 *  - 分层抽样：按二级 KC（kc_routes[0] 的前两段）分层，比例分配 dev/eval 名额
 *    （最大余数法），组内用 seed 洗牌后先满足 eval（主战场）再满足 dev。
 *
 * 入选资格（不满足者记入 dropped，禁止静默丢弃）：
 *  - type === '填空'（单选答案为字母，无探针区分度）；
 *  - 探针含至少一个字母/数字（纯符号 <、>、= 剔除）；
 *  - 探针非单个字母 A-D（可能是漏标注的单选）。
 */
'use strict';

const { mulberry32 } = require('../stats/core');
const { sha256OfJson } = require('../util/hash');
const { answerProbeOf } = require('../corpus/xes3g5m');

/** 确定性改写模板池：同一题面在不同模板下是同一 query 簇的不同问法。 */
const QUERY_TEMPLATES = [
  (c) => `请回答下面这道数学题：\n${c}\n请直接给出最终答案。`,
  (c) => `下面是一道数学题：\n${c}\n它的答案是什么？`,
  (c) => `解答下面的题目，只需给出最终答案：\n${c}`,
];

/** 二级 KC 标识：kc_routes 首条路由的前两段，'组>子组' */
function kc2IdOf(q) {
  const routes = Array.isArray(q.kc_routes) ? q.kc_routes : [q.kc_routes];
  const parts = String(routes[0] || '').split(/-{2,}/).map((s) => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return '';
  return `${parts[0]}>${parts[1]}`;
}

/** 入选资格判定（返回 null 表示不合格，否则返回 gold answer 文本） */
function eligibilityOf(q) {
  if (q.type !== '填空') return null;
  const probe = answerProbeOf(q);
  if (!probe) return null;
  if (!/[\p{L}\p{N}]/u.test(probe)) return null; // 纯符号答案（<、>、= 等）
  if (/^[A-Da-d]$/.test(probe)) return null; // 单字母疑似漏标注单选
  return probe;
}

/** 最大余数法：把 total 个名额按各组份额分配，保证 sum === total */
function allocateQuotas(groupSizes, total) {
  const sum = groupSizes.reduce((a, b) => a + b, 0);
  if (sum === 0) return groupSizes.map(() => 0);
  const raw = groupSizes.map((n) => (n * total) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  // 名额不得组超出组容量：先按余数补，超容的名额顺延给下一名
  const assigned = new Array(groupSizes.length).fill(false);
  for (const { i } of order) {
    if (rest <= 0) break;
    if (out[i] < groupSizes[i]) { out[i] += 1; rest -= 1; assigned[i] = true; }
  }
  if (rest > 0) {
    for (let i = 0; i < groupSizes.length && rest > 0; i++) {
      if (!assigned[i] && out[i] < groupSizes[i]) { out[i] += 1; rest -= 1; }
    }
  }
  return out;
}

/**
 * 主入口。
 * @param {object} opts
 * @param {string} [opts.questionsPath] 元数据路径（与 questions 二选一）
 * @param {object} [opts.questions] 直接注入的元数据对象（测试用）
 * @param {number} [opts.devSize=100]
 * @param {number} [opts.evalSize=200]
 * @param {number} opts.seed 全局随机种子
 * @returns {{dev, eval, stats, dropped, seed}}
 */
function buildQuerySet({ questionsPath, questions, devSize = 100, evalSize = 200, seed }) {
  if (seed === undefined) throw new Error('buildQuerySet 必须显式传入 seed');
  if (questionsPath) questions = JSON.parse(require('fs').readFileSync(questionsPath, 'utf8'));
  if (!questions || typeof questions !== 'object') throw new Error('questions 元数据缺失');

  const rng = mulberry32(seed >>> 0);
  const dropped = [];
  const byKc = new Map(); // kc2 -> [{qid, probe}]

  for (const [qid, q] of Object.entries(questions)) {
    const kc2 = kc2IdOf(q);
    const probe = eligibilityOf(q);
    if (probe === null) {
      const reason = q.type !== '填空'
        ? `type=${q.type}（非填空，探针无区分度）`
        : (!answerProbeOf(q) ? '答案探针为空' : (/^[A-Da-d]$/.test(answerProbeOf(q)) ? '单字母答案（疑似漏标注单选）' : '纯符号答案'));
      dropped.push({ qid, reason });
      continue;
    }
    if (!kc2) { dropped.push({ qid, reason: 'kc_routes 无二级路由' }); continue; }
    if (!byKc.has(kc2)) byKc.set(kc2, []);
    byKc.get(kc2).push({ qid, probe });
  }

  const kcKeys = [...byKc.keys()].sort(); // 固定顺序，保证复现与组序无关
  const groupSizes = kcKeys.map((k) => byKc.get(k).length);
  const evalQuotas = allocateQuotas(groupSizes, Math.min(evalSize, groupSizes.reduce((a, b) => a + b, 0)));
  const devQuotas = allocateQuotas(
    groupSizes.map((n, i) => n - evalQuotas[i]),
    Math.min(devSize, groupSizes.reduce((a, b, i) => a + (b - evalQuotas[i]), 0)),
  );

  const dev = [];
  const evalSet = [];
  kcKeys.forEach((kc2, gi) => {
    const pool = byKc.get(kc2);
    // Fisher-Yates 洗牌（受全局 rng 驱动）
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let cursor = 0;
    const take = (n, sink) => {
      for (let t = 0; t < n && cursor < pool.length; t++, cursor++) {
        const { qid, probe } = pool[cursor];
        const q = questions[qid];
        const templateIndex = Math.floor(rng() * QUERY_TEMPLATES.length);
        const content = String(q.content || '').trim();
        sink.push({
          queryId: `q-xes-${qid}`,
          queryClusterId: `qc-xes-${qid}`,
          qid,
          kcId: kc2,
          templateIndex,
          queryText: QUERY_TEMPLATES[templateIndex](content),
          goldAnswer: probe,
          oracleDocId: `xes-q${qid}`,
        });
      }
    };
    take(evalQuotas[gi], evalSet);
    take(devQuotas[gi], dev);
  });

  const stats = {
    questionsTotal: Object.keys(questions).length,
    eligibleTotal: groupSizes.reduce((a, b) => a + b, 0),
    kc2Groups: kcKeys.length,
    devSize: dev.length,
    evalSize: evalSet.length,
    clusterDisjoint: queryClustersDisjoint(dev, evalSet),
  };
  return { dev, eval: evalSet, stats, dropped, seed, templateCount: QUERY_TEMPLATES.length };
}

function queryClustersDisjoint(dev, evalSet) {
  const devSet = new Set(dev.map((q) => q.queryClusterId));
  return evalSet.every((q) => !devSet.has(q.queryClusterId));
}

/** 冻结用 manifest：两集合分别留 sha256（对 queryId 有序集合 + 全记录），供配置回填 */
function querySetManifest(built) {
  const idsOf = (arr) => arr.map((q) => q.queryId).sort();
  return {
    seed: built.seed,
    stats: built.stats,
    droppedTotal: built.dropped.length,
    droppedReasons: built.dropped.reduce((m, d) => { m[d.reason] = (m[d.reason] || 0) + 1; return m; }, {}),
    dev: { n: built.dev.length, queryIdsSha256: sha256OfJson(idsOf(built.dev)), recordsSha256: sha256OfJson(built.dev) },
    eval: { n: built.eval.length, queryIdsSha256: sha256OfJson(idsOf(built.eval)), recordsSha256: sha256OfJson(built.eval) },
    clusterDisjointAssertion: queryClustersDisjoint(built.dev, built.eval),
  };
}

module.exports = { buildQuerySet, querySetManifest, QUERY_TEMPLATES, kc2IdOf, eligibilityOf, allocateQuotas, queryClustersDisjoint };
