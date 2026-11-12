/**
 * 组级重采样适配层。
 *
 * 与 KT buildStudentSampler（backend/models/bootstrapStats.js）逻辑同构：
 * 按 rows[i][groupKey] 分组，每次重采样「有放回抽组」，返回每条记录被抽中次数的
 * 权重数组（复用同一缓冲区）。
 *
 * RAG 适配要点（设计 §6.1）：重采样单位是 query，不是生成样本——
 * 每个 query 的多次 sample 先聚合成一个分数（见 evaluator.js 的约定），
 * 这里每个 query 恰好一行。groupKey 默认 'userId' 是刻意保留的：
 * 与 KT 契约一致，适配层只需把 queryId 写进 userId 字段即可零改动对接。
 */

function buildGroupSampler(rows, { groupKey = 'userId' } = {}) {
  if (!rows.length) throw new Error('buildGroupSampler: rows 为空');
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = rows[i][groupKey];
    if (key === undefined || key === null) {
      throw new Error(`buildGroupSampler: 第 ${i} 行缺少分组字段 "${groupKey}"`);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const groupArr = [...groups.values()];
  const weights = new Float64Array(rows.length);

  function sampleWeights(rand) {
    weights.fill(0);
    for (let g = 0; g < groupArr.length; g++) {
      const picked = groupArr[Math.floor(rand() * groupArr.length)];
      for (let k = 0; k < picked.length; k++) weights[picked[k]] += 1;
    }
    return weights;
  }

  return { sampleWeights, groupCount: groupArr.length, weights };
}

module.exports = { buildGroupSampler };
