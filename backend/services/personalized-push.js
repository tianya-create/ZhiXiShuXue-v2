const db = require('../database/memory-db')
const { getQuestionBankByNode, ensureManualQuestionBank } = require('./manual-question-bank')

const STATUS_TO_PLAN = {
  red: [1, 1, 2, 2, 3],
  orange: [2, 2, 3, 3, 4],
  green: [4, 4, 5, 5]
}

const GRAPH_STATUS_BASELINE = {
  '未掌握': 50,
  '待巩固': 70,
  '已掌握': 86
}

function getNodeBase(knowledgePointId) {
  const graphNode = (db.data.knowledgeGraphNodes || []).find(item => item.id === knowledgePointId)
  const kp = db.findById('knowledgePoints', knowledgePointId)
  return {
    id: knowledgePointId,
    name: graphNode ? graphNode.name : (kp ? kp.name : knowledgePointId),
    domain: graphNode ? graphNode.domain : '',
    graphStatus: graphNode ? graphNode.masterStatus : '待巩固'
  }
}

function getRecentAttempts(studentId, knowledgePointId) {
  return db.find('student_answer')
    .filter(item => item.userId === studentId && item.kpCode === knowledgePointId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

function computeMastery(studentId, knowledgePointId) {
  const attempts = getRecentAttempts(studentId, knowledgePointId).slice(0, 5)
  const node = getNodeBase(knowledgePointId)
  const base = GRAPH_STATUS_BASELINE[node.graphStatus] || 68

  if (!attempts.length) {
    return base
  }

  const correctRate = attempts.filter(item => item.isCorrect).length / attempts.length
  const avgDifficulty = attempts.reduce((sum, item) => {
    const q = db.findById('questions', item.questionId)
    return sum + Number((q && q.difficultyLevel) || 2)
  }, 0) / attempts.length

  const recencyBoost = attempts.length >= 3 && attempts.slice(0, 3).every(item => item.isCorrect) ? 8 : 0
  const recencyPenalty = attempts.length >= 2 && attempts.slice(0, 2).every(item => !item.isCorrect) ? 12 : 0
  const difficultyFactor = (avgDifficulty - 3) * 4
  const mastery = Math.round(base + (correctRate - 0.5) * 38 + difficultyFactor + recencyBoost - recencyPenalty)

  return Math.max(20, Math.min(96, mastery))
}

function getColorStatus(studentId, knowledgePointId) {
  const mastery = computeMastery(studentId, knowledgePointId)
  if (mastery < 60) return { status: 'red', mastery, label: '未掌握' }
  if (mastery < 80) return { status: 'orange', mastery, label: '待巩固' }
  return { status: 'green', mastery, label: '已掌握' }
}

function wasPushedWithin24h(studentId, knowledgePointId, questionId) {
  const last = db.find('recommendationLogs')
    .filter(item => item.studentId === studentId && item.knowledgePointId === knowledgePointId && item.questionId === questionId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
  if (!last) return false
  return Date.now() - new Date(last.createdAt).getTime() < 24 * 60 * 60 * 1000
}

function createWrongSnapshot(studentId, knowledgePointId) {
  const node = getNodeBase(knowledgePointId)
  const count = Math.floor(Math.random() * 4)
  const rows = []
  for (let i = 0; i < count; i += 1) {
    rows.push({
      wrongId: `${studentId}-${knowledgePointId}-history-${i + 1}`,
      knowledgeId: knowledgePointId,
      questionBody: `${node.name} 演示错题 ${i + 1}`,
      studentAnswer: `错误作答 ${i + 1}`,
      correctAnswer: '标准答案',
      errorOption: 'A',
      errorAnalysis: '概念理解不牢，审题不够仔细。',
      reflection: '下次先标记题目中的关键信息，再列式。',
      tags: [node.domain || '初中数学', node.name],
      updateTime: new Date(Date.now() - i * 3600 * 1000).toISOString()
    })
  }
  return rows
}

function ensureDemoWrongHistory(studentId) {
  if (!db.data.knowledgeGraphWrong) db.data.knowledgeGraphWrong = []
  const graphNodes = db.data.knowledgeGraphNodes || []
  graphNodes.forEach(item => {
    const existed = db.data.knowledgeGraphWrong.filter(row => row.knowledgeId === item.id && String(row.wrongId || '').startsWith(studentId + '-'))
    if (!existed.length) {
      createWrongSnapshot(studentId, item.id).forEach(row => db.data.knowledgeGraphWrong.push(row))
    }
  })
}

function pickQuestions(studentId, knowledgePointId, status, limit) {
  ensureManualQuestionBank()
  const plan = STATUS_TO_PLAN[status] || STATUS_TO_PLAN.orange
  const pool = getQuestionBankByNode({ knowledgePointId })
  const chosen = []
  const seen = new Set()

  plan.forEach(level => {
    if (chosen.length >= limit) return
    const candidate = pool.find(item => Number(item.difficultyLevel) === Number(level) && !seen.has(item.id) && !wasPushedWithin24h(studentId, knowledgePointId, item.id))
    if (candidate) {
      seen.add(candidate.id)
      chosen.push(candidate)
    }
  })

  if (chosen.length < limit) {
    pool.forEach(item => {
      if (chosen.length >= limit) return
      if (seen.has(item.id)) return
      seen.add(item.id)
      chosen.push(item)
    })
  }

  return chosen.slice(0, limit)
}

function getPersonalizedPush(studentId, options = {}) {
  ensureManualQuestionBank()
  ensureDemoWrongHistory(studentId)
  const limit = Math.max(1, Math.min(3, Number(options.limit) || 3))
  const graphNodes = db.data.knowledgeGraphNodes || []
  const ranked = graphNodes.map(item => ({ ...item, ...getColorStatus(studentId, item.id) }))
    .sort((a, b) => a.mastery - b.mastery)

  for (const node of ranked) {
    if (node.status !== 'red' && node.status !== 'orange') continue
    const questions = pickQuestions(studentId, node.id, node.status, limit)
    if (questions.length) {
      questions.forEach(question => {
        db.create('recommendationLogs', {
          studentId,
          knowledgePointId: node.id,
          knowledgePointName: node.name,
          questionId: question.id,
          reason: node.label,
          createdAt: new Date().toISOString()
        })
      })
      return {
        knowledgePointId: node.id,
        knowledgePointName: node.name,
        mastery: node.mastery,
        status: node.label,
        questions: questions.map(item => {
          const options = Array.isArray(item.options) ? item.options : []
          const rawAnswer = String(item.answer || item.answer_text || '').trim()
          const answerIndex = options.findIndex(option => String(option || '').trim() === rawAnswer)
          const standardAnswer = answerIndex >= 0
            ? `${String.fromCharCode(65 + answerIndex)}（${rawAnswer}）`
            : rawAnswer

          return {
            ...item,
            standardAnswer,
            answerDisplay: standardAnswer,
            visibleQuestionNo: `第${item.difficultyLevel || item.difficulty || 1}层题`,
            recommendationReason: `${node.name} 当前为${node.label}，按规则推送 ${item.difficultyLevel} 级题目。`
          }
        })
      }
    }
  }

  return { knowledgePointId: '', knowledgePointName: '', mastery: 0, status: '已掌握', questions: [] }
}

module.exports = {
  computeMastery,
  getColorStatus,
  ensureDemoWrongHistory,
  getPersonalizedPush
}
