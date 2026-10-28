from pathlib import Path

student_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\routes\student.js')
migrate_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\migrate-questions-to-sqlite.js')

student_text = student_path.read_text(encoding='utf-8')

student_text = student_text.replace(
"function buildKnowledgePointSpecificQuestions(knowledgePoint, masteryRate) {\n  if (!knowledgePoint) return [];\n\n  const level = getPracticeDifficulty(masteryRate);\n\n  return db.find('questions')\n    .filter(question => {\n      return question.source === 'practice-seed' && Array.isArray(question.knowledgePoints) && question.knowledgePoints.includes(knowledgePoint.id);\n    })\n    .filter(question => !question.difficulty || question.difficulty === level)\n    .map(question => ({\n      ...question,\n      answerDisplay: question.type === 'choice'\n        ? buildChoiceDisplay(question, question.answer)\n        : (question.answer || '-')\n    }));\n}\n",
"function getPracticeQuestionsFromDatabase(knowledgePoint, masteryRate) {\n  if (!knowledgePoint) return [];\n\n  const level = getPracticeDifficulty(masteryRate);\n\n  return db.find('questions')\n    .filter(question => {\n      return Array.isArray(question.knowledgePoints) && question.knowledgePoints.includes(knowledgePoint.id);\n    })\n    .filter(question => question.source === 'practice-seed')\n    .filter(question => !question.difficulty || question.difficulty === level)\n    .map(question => ({\n      ...question,\n      answerDisplay: question.type === 'choice'\n        ? buildChoiceDisplay(question, question.answer)\n        : (question.answer || '-')\n    }));\n}\n\nfunction getPracticeQuestionsForKnowledgePoint(studentId, knowledgePointId) {\n  const relationData = buildKnowledgePointRelations();\n  const knowledgePoint = relationData.map[knowledgePointId] || db.findById('knowledgePoints', knowledgePointId);\n  if (!knowledgePoint) {\n    return [];\n  }\n\n  const weakSummary = buildWeakPointSummary(studentId);\n  const matchedWeak = weakSummary.find(item => item.id === knowledgePointId);\n  const masteryRate = matchedWeak ? parseInt(matchedWeak.masteryRate || 0, 10) : 100;\n\n  if (matchedWeak && matchedWeak.isLeaf && masteryRate >= 80) {\n    return [];\n  }\n\n  const questions = getPracticeQuestionsFromDatabase(knowledgePoint, masteryRate);\n  const targetLevel = masteryRate < 40 ? 35 : (masteryRate < 60 ? 60 : 85);\n\n  return questions\n    .slice()\n    .sort((a, b) => {\n      const scoreA = Math.abs((a.difficulty === 'easy' ? 35 : a.difficulty === 'medium' ? 60 : 85) - targetLevel);\n      const scoreB = Math.abs((b.difficulty === 'easy' ? 35 : b.difficulty === 'medium' ? 60 : 85) - targetLevel);\n      return scoreA - scoreB;\n    })\n    .slice(0, Math.max(3, Math.min(6, masteryRate < 40 ? 5 : masteryRate < 60 ? 4 : 3)));\n}\n")

student_text = student_text.replace(
"    const practiceCount = buildKnowledgePointSpecificQuestions(item, directMasteryRate).length + db.find('questions').filter(question => {\n      return Array.isArray(question.knowledgePoints) && question.knowledgePoints.includes(item.id);\n    }).length;\n",
"    const practiceCount = getPracticeQuestionsFromDatabase(item, directMasteryRate).length;\n")

student_text = student_text.replace("ensurePracticeQuestionsForKnowledgePoint(student.id, item.id).length", "getPracticeQuestionsForKnowledgePoint(student.id, item.id).length")
student_text = student_text.replace("questions = ensurePracticeQuestionsForKnowledgePoint(student.id, knowledgePointId);", "questions = getPracticeQuestionsForKnowledgePoint(student.id, knowledgePointId);")
student_text = student_text.replace("buildKnowledgePointSpecificQuestions(", "getPracticeQuestionsFromDatabase(")

student_path.write_text(student_text, encoding='utf-8')

migrate_text = migrate_path.read_text(encoding='utf-8')
migrate_text = migrate_text.replace("const { ensureGeneratedQuestions } = require('../services/math-bank');\n", "")
migrate_text = migrate_text.replace("  ensureGeneratedQuestions(9);\n", "")
migrate_path.write_text(migrate_text, encoding='utf-8')
