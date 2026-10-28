import sharedKnowledgeTree from '../../../shared/knowledge-tree.json'

export const KNOWLEDGE_TREE_SHARED_CONFIG = sharedKnowledgeTree

export const MAJOR_CATEGORY_CONFIG = KNOWLEDGE_TREE_SHARED_CONFIG.categories.map(function (item) {
  return { name: item.name, aliases: item.aliases.slice() }
})

export const KNOWLEDGE_NODE_ID_SET = new Set(
  KNOWLEDGE_TREE_SHARED_CONFIG.categories.flatMap(function (category) {
    return category.nodes.map(function (node) { return node.id })
  })
)

export const KNOWLEDGE_CATEGORY_LEAF_MAP = KNOWLEDGE_TREE_SHARED_CONFIG.categories.reduce(function (acc, category) {
  acc[category.id] = category.nodes.map(function (node) { return node.id })
  return acc
}, {
  [KNOWLEDGE_TREE_SHARED_CONFIG.root.id]: KNOWLEDGE_TREE_SHARED_CONFIG.categories.flatMap(function (category) {
    return category.nodes.map(function (node) { return node.id })
  })
})

export function buildSharedKnowledgeTree() {
  return [{
    id: KNOWLEDGE_TREE_SHARED_CONFIG.root.id,
    name: KNOWLEDGE_TREE_SHARED_CONFIG.root.name,
    children: KNOWLEDGE_TREE_SHARED_CONFIG.categories.map(function (category) {
      return {
        id: category.id,
        name: category.name,
        children: category.nodes.map(function (node) {
          return { id: node.id, name: node.name }
        })
      }
    })
  }]
}

export function parseMasteryRate(value) {
  const num = parseInt(value || 0, 10)
  if (Number.isNaN(num)) return 0
  if (num < 0) return 0
  if (num > 100) return 100
  return num
}

export function getMasteryStatus(value) {
  const score = parseMasteryRate(value)
  if (score >= 80) return 'mastered'
  if (score >= 60) return 'learning'
  return 'weak'
}

export function getMasteryLabel(value) {
  const status = getMasteryStatus(value)
  if (status === 'mastered') return '已掌握'
  if (status === 'learning') return '待巩固'
  return '薄弱'
}

export function getMasteryTagType(value) {
  const status = getMasteryStatus(value)
  if (status === 'mastered') return 'success'
  if (status === 'learning') return 'warning'
  return 'danger'
}

function normalizeCategoryName(name) {
  const text = String(name || '').trim()
  const matched = MAJOR_CATEGORY_CONFIG.find((config) => config.aliases.includes(text))
  return matched ? matched.name : ''
}

function categoryByIdPrefix(id) {
  const text = String(id || '').trim()
  if (!text) return ''

  for (const category of KNOWLEDGE_TREE_SHARED_CONFIG.categories) {
    if (category.nodes.some(node => node.id === text)) return category.name
  }

  if (text.startsWith('kp-001') || text.startsWith('kp-002')) return '数与式'
  if (text.startsWith('kp-003')) return '方程与不等式'
  if (text.startsWith('kp-004')) return '函数'
  if (text.startsWith('kp-005')) return '几何'
  if (text.startsWith('kp-006')) return '统计概率'
  return ''
}

function categoryByNameKeyword(name) {
  const text = String(name || '').trim()
  if (!text) return ''

  if (/方程|不等式|等式|移项|代入|消元/.test(text)) return '方程与不等式'
  if (/函数|坐标|象限|抛物线|反比例|一次函数|二次函数/.test(text)) return '函数'
  if (/几何|三角形|圆|平行线|角|线段|射线|直线|图形|全等|相似|勾股/.test(text)) return '几何'
  if (/统计|概率|样本|中位数|众数|方差|频率|随机|数据/.test(text)) return '统计概率'
  if (/有理数|实数|整式|因式|乘法公式|平方根|立方根|代数式|同类项/.test(text)) return '数与式'
  return ''
}

export function inferMajorCategory(item, fallback = '数与式') {
  const directCategory = normalizeCategoryName(
    item && (item.categoryName || item.majorCategory || item.topCategory || item.majorCategoryName)
  )
  if (directCategory) return directCategory

  const selfIdCategory = categoryByIdPrefix(item && item.id)
  if (selfIdCategory) return selfIdCategory

  const ancestorNames = Array.isArray(item && item.ancestorNames) ? item.ancestorNames : []
  for (const name of ancestorNames) {
    const categoryName = normalizeCategoryName(name)
    if (categoryName) return categoryName
  }

  const ancestorIds = Array.isArray(item && item.ancestorIds) ? item.ancestorIds : []
  for (const id of ancestorIds) {
    const categoryName = categoryByIdPrefix(id)
    if (categoryName) return categoryName
  }

  const selfNameCategory = normalizeCategoryName(item && item.name ? item.name : '')
  if (selfNameCategory) return selfNameCategory

  const keywordCategory = categoryByNameKeyword(item && item.name ? item.name : '')
  if (keywordCategory) return keywordCategory

  return fallback
}
