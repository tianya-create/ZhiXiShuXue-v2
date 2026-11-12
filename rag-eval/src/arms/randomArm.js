/**
 * 等长随机臂（X 臂）采样器——设计 §2.2，本框架最容易做错的一环。
 *
 * 规则：
 *   1. 长度精确匹配：对每个 query 按 R 臂实际字符数 targetChars 截断（≤2% 容差自然满足）；
 *   2. 簇间不重复：每簇只取一个 chunk（避免近重复变相多给信息）；
 *   3. 与 R 臂 doc 簇无交集（excludeClusterIds）；
 *   4. 确定性：seed = fnv1a(configSeed + ':' + queryId)，同配置重跑逐位一致。
 */

const { mulberry32 } = require('../stats/core');

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @param {Object} p
 * @param {string} p.queryId
 * @param {number} p.targetChars  R 臂该 query 检索块总字符数
 * @param {Array<{clusterId, chunkIds: string[]}>} p.clusters  候选簇池
 * @param {Map<string,string>} p.chunkTextById  chunkId → 文本
 * @param {string} p.configSeed
 * @param {string[]} [p.excludeClusterIds]  R 臂已用簇，必须排除
 * @param {number} [p.tolerance]  长度容差（默认 0.02；精确截断下仅在池不足时触发）
 */
function sampleRandomContext({
  queryId,
  targetChars,
  clusters,
  chunkTextById,
  configSeed,
  excludeClusterIds = [],
  tolerance = 0.02
}) {
  if (!(targetChars > 0)) throw new Error(`sampleRandomContext: targetChars 必须 > 0（query ${queryId}）`);
  const excluded = new Set(excludeClusterIds);
  const pool = clusters.filter((c) => !excluded.has(c.clusterId) && c.chunkIds.length > 0 && chunkTextById.has(c.chunkIds[0]));
  if (!pool.length) throw new Error(`sampleRandomContext: 排除 R 簇后随机池为空（query ${queryId}）`);

  const rand = mulberry32(fnv1a(`${configSeed}:${queryId}`));
  const order = pool.map((c) => c.clusterId);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const parts = [];
  let acc = 0;
  const stopFloor = targetChars * (1 - tolerance);
  for (const cid of order) {
    // 容差停机：剩余块无法精确凑齐时（真实语料块长不均），允许提前停在容差带内
    if (acc >= stopFloor) break;
    const cl = pool.find((c) => c.clusterId === cid);
    const chunkId = cl.chunkIds[0];
    const t = chunkTextById.get(chunkId);
    if (acc + t.length <= targetChars) {
      parts.push({ clusterId: cid, chunkId, text: t });
      acc += t.length;
    } else {
      const need = targetChars - acc;
      if (need > 0) {
        parts.push({ clusterId: cid, chunkId, text: t.slice(0, need) });
        acc = targetChars;
      }
      break;
    }
  }

  if (acc < targetChars * (1 - tolerance)) {
    throw new Error(
      `sampleRandomContext: 随机池总长不足（query ${queryId}）：need ${targetChars}，got ${acc}，池簇数 ${pool.length}`
    );
  }

  return {
    texts: parts.map((p) => p.text),
    chars: acc,
    clusterIds: parts.map((p) => p.clusterId),
    chunkIds: parts.map((p) => p.chunkId)
  };
}

module.exports = { fnv1a, sampleRandomContext };
