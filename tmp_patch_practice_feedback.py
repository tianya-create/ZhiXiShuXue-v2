from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\frontend\src\views\student\Practice.vue')
text = path.read_text(encoding='utf-8')

text = text.replace(
"                <div class=\"result-kp-meta\">\n                  题目 {{ item.questionCount }} · 正确 {{ item.correctCount }} · 错误 {{ item.wrongCount }}\n                </div>\n              </div>\n              <div class=\"result-kp-rate\">掌握度 {{ item.masteryAfter }}%</div>\n",
"                <div class=\"result-kp-meta\">\n                  题目 {{ item.questionCount }} · 正确 {{ item.correctCount }} · 错误 {{ item.wrongCount }}\n                </div>\n                <div class=\"result-kp-meta\">\n                  掌握度 {{ item.masteryBefore ?? item.masteryAfter }}% → {{ item.masteryAfter }}%\n                </div>\n              </div>\n              <div class=\"result-kp-rate\">当前掌握 {{ item.masteryAfter }}%</div>\n")

text = text.replace(
"              <div class=\"progress-meta\">\n                正确 {{ item.correctCount }} / {{ item.questionCount }}\n              </div>\n",
"              <div class=\"progress-meta\">\n                掌握度 {{ item.masteryBefore ?? item.masteryAfter }}% → {{ item.masteryAfter }}%\n              </div>\n")

text = text.replace(
"function openKnowledgePointPractice(item) {\n  if (!item || !item.id) return\n  router.push({ path: '/student/practice', query: { kpId: item.id, parentId: item.parentId || '' } })\n}\n\nfunction kpIdFromRoute() {\n  return route.query.kpId || practiceMeta.knowledgePointId || 'custom'\n}\n\nfunction buildQuestionAnalysis(question, isCorrect) {\n",
"function openKnowledgePointPractice(item) {\n  if (!item || !item.id) return\n  router.push({ path: '/student/practice', query: { kpId: item.id, parentId: item.parentId || '' } })\n}\n\nfunction buildQuestionAnalysis(question, isCorrect) {\n")

text = text.replace(
"function resetAnswers() {\n  Object.keys(answers).forEach((key) => {\n    delete answers[key]\n  })\n  Object.keys(questionFeedbackMap).forEach((key) => {\n    delete questionFeedbackMap[key]\n  })\n  resultVisible.value = false\n}\n\nfunction submitPractice() {\n",
"function resetAnswers() {\n  Object.keys(answers).forEach((key) => {\n    delete answers[key]\n  })\n  Object.keys(questionFeedbackMap).forEach((key) => {\n    delete questionFeedbackMap[key]\n  })\n  resultVisible.value = false\n}\n\nfunction syncMasteryMetaAfterSubmit(changes = []) {\n  if (!practiceMeta.chatPractice || !Array.isArray(practiceMeta.chatPractice.relatedKnowledgePoints)) return\n\n  const changeMap = changes.reduce((acc, item) => {\n    acc[item.knowledgePointId] = item\n    return acc\n  }, {})\n\n  practiceMeta.chatPractice.relatedKnowledgePoints = practiceMeta.chatPractice.relatedKnowledgePoints.map((item) => {\n    const change = changeMap[item.id]\n    if (!change) return item\n    return {\n      ...item,\n      masteryRate: change.masteryAfter,\n      wrongCount: change.wrongCount\n    }\n  })\n\n  if (practiceMeta.chatPractice.knowledgePoint) {\n    const currentChange = changeMap[practiceMeta.chatPractice.knowledgePoint.id]\n    if (currentChange) {\n      practiceMeta.chatPractice.knowledgePoint = {\n        ...practiceMeta.chatPractice.knowledgePoint,\n        masteryRate: currentChange.masteryAfter\n      }\n    }\n  }\n}\n\nfunction submitPractice() {\n")

text = text.replace(
"        resultData.totalScore = data.totalScore || 0\n        resultData.questionResults = Array.isArray(data.questionResults) ? data.questionResults : []\n        resultData.knowledgePointChanges = Array.isArray(data.knowledgePointChanges) ? data.knowledgePointChanges : []\n        resultData.status = data.status || 'completed'\n        resultData.allCorrect = !!data.allCorrect\n\n        questions.value.forEach((question) => {\n",
"        resultData.totalScore = data.totalScore || 0\n        resultData.questionResults = Array.isArray(data.questionResults) ? data.questionResults : []\n        resultData.knowledgePointChanges = Array.isArray(data.knowledgePointChanges) ? data.knowledgePointChanges : []\n        resultData.status = data.status || 'completed'\n        resultData.allCorrect = !!data.allCorrect\n        practiceMeta.latestPractice = data\n        syncMasteryMetaAfterSubmit(resultData.knowledgePointChanges)\n\n        questions.value.forEach((question) => {\n")

path.write_text(text, encoding='utf-8')
