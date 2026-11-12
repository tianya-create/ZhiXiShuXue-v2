/**
 * 近重复聚类（设计 §4.1/§4.2 双轴分组的底座）。
 * n ≤ 1500：精确 O(n²) shingle-Jaccard（确定性真值，供测试）。
 * n > 1500：倒排索引候选对 + 最小共现过滤（Jaccard≥t ⇒ 共现数 ≥ 2t/(1+t)·min(|A|,|B|)，
 * 数学上不漏判），仅当某 shingle 的 posting 超过 POSTING_CAP 时跳过该 shingle——
 * 这在 boilerplate 极重的语料上是近似（会在 console.warn 提示）；文档级近似可接受，
 * 正式冻结前如需全量精确可换 MinHash+LSH，接口不变。
 * union-find 传递闭包：A~B、B~C 则 A/B/C 同簇。
 */

const EXACT_LIMIT = 1500;
const POSTING_CAP = 400;

function normalizeForShingle(text) {
  return String(text).toLowerCase().replace(/\s+/g, '');
}

/** k-shingle 集合；短于 k 的串整体作为一个 shingle */
function shingleSet(text, k = 5) {
  const s = normalizeForShingle(text);
  const set = new Set();
  if (!s) return set;
  if (s.length <= k) { set.add(s); return set; }
  for (let i = 0; i + k <= s.length; i++) set.add(s.slice(i, i + k));
  return set;
}

function jaccardOf(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * items: [{id, text, ...}]；返回
 *   assignments: Map(id → clusterId)
 *   clusters:    [{clusterId, memberIds}]（clusterId 按首个成员的出现顺序编号，确定）
 */
function clusterBySimilarity(items, { threshold, shingleK = 5, idKey = 'id', textKey = 'text' } = {}) {
  if (!(threshold > 0 && threshold <= 1)) throw new Error(`clusterBySimilarity: threshold 必须在 (0,1]，收到 ${threshold}`);
  const sets = items.map((it) => shingleSet(it[textKey] ?? '', shingleK));
  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const exact = items.length <= EXACT_LIMIT;
  if (exact) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (jaccardOf(sets[i], sets[j]) >= threshold) union(i, j);
      }
    }
  } else {
    // 倒排索引：shingle → 文档号列表
    const inverted = new Map();
    for (let i = 0; i < items.length; i++) {
      for (const g of sets[i]) {
        const list = inverted.get(g);
        if (list) list.push(i);
        else inverted.set(g, [i]);
      }
    }
    let skippedShingles = 0;
    const counts = new Map(); // key = i*N+j，值 = 共现 shingle 数
    const N = items.length;
    for (const list of inverted.values()) {
      if (list.length < 2) continue;
      if (list.length > POSTING_CAP) { skippedShingles += 1; continue; } // boilerplate shingle，跳过（近似来源）
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const i = Math.min(list[a], list[b]);
          const j = Math.max(list[a], list[b]);
          const k = i * N + j;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
    if (skippedShingles > 0) {
      console.warn(`[cluster] n=${N} 超过精确阈值，倒排模式下跳过 ${skippedShingles} 个 posting>${POSTING_CAP} 的 boilerplate shingle（近似模式）`);
    }
    // 精确必要条件：inter ≥ t(|A|+|B|)/(1+t) ≥ 2t/(1+t)·min(|A|,|B|)
    const minRatio = (2 * threshold) / (1 + threshold);
    for (const [k, c] of counts) {
      const i = Math.floor(k / N);
      const j = k % N;
      if (c >= minRatio * Math.min(sets[i].size, sets[j].size) && jaccardOf(sets[i], sets[j]) >= threshold) union(i, j);
    }
  }
  const rootToCluster = new Map();
  const clusters = [];
  const clusterById = new Map();
  const assignments = new Map();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    if (!rootToCluster.has(r)) {
      const cid = `C${rootToCluster.size}`;
      rootToCluster.set(r, cid);
      const cluster = { clusterId: cid, memberIds: [] };
      clusters.push(cluster);
      clusterById.set(cid, cluster);
    }
    const cid = rootToCluster.get(r);
    assignments.set(items[i][idKey], cid);
    clusterById.get(cid).memberIds.push(items[i][idKey]);
  }
  return { assignments, clusters };
}

/** 便捷封装：doc 簇（默认 shingleK=5）与 query 簇（默认 char-3gram） */
function docClusters(docs, { threshold, shingleK = 5 } = {}) {
  return clusterBySimilarity(docs, { threshold, shingleK, idKey: 'docId', textKey: 'text' });
}

function queryClusters(queries, { threshold, shingleK = 3 } = {}) {
  return clusterBySimilarity(queries, { threshold, shingleK, idKey: 'queryId', textKey: 'text' });
}

module.exports = { normalizeForShingle, shingleSet, jaccardOf, clusterBySimilarity, docClusters, queryClusters };
