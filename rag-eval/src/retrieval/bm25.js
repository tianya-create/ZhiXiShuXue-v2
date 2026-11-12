/**
 * BM25 检索（骨架内置的本地 retriever，替代真实 embedding 服务）。
 * 分词：CJK 连续段切 2-gram，拉丁/数字按词。确定性：并列分数按 docId 升序。
 * 教材/题库语料的特点是术语重复率高、段落短，2-gram 对中文术语召回明显
 * 优于整词切分；换真实 embedding 时保持 search(query, k) 接口不变。
 */

const K1 = 1.2;
const B = 0.75;

function tokenize(text) {
  const out = [];
  const lower = String(text).toLowerCase();
  const re = /([\u4e00-\u9fff]+)|([a-z0-9]+)/g;
  let m;
  while ((m = re.exec(lower))) {
    if (m[1]) {
      const run = m[1];
      if (run.length === 1) { out.push(run); continue; }
      for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    } else {
      out.push(m[2]);
    }
  }
  return out;
}

function buildBm25Index(docs) {
  const df = new Map();
  const tfs = [];
  let totalLen = 0;
  for (const doc of docs) {
    const toks = tokenize(doc.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    tfs.push({ docId: doc.id, tf, len: toks.length });
    totalLen += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = docs.length;
  const avgdl = n ? totalLen / n : 0;
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));

  function search(query, topK = 5) {
    if (!n || topK < 1) return [];
    const qTerms = [...new Set(tokenize(query))];
    const scores = [];
    for (const d of tfs) {
      let s = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idfV = idf.get(t);
        s += idfV * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / (avgdl || 1)))));
      }
      scores.push({ docId: d.docId, score: s });
    }
    scores.sort((x, y) => y.score - x.score || (x.docId < y.docId ? -1 : 1));
    return scores.slice(0, topK);
  }

  return { search, docCount: n, avgdl };
}

module.exports = { tokenize, buildBm25Index };
