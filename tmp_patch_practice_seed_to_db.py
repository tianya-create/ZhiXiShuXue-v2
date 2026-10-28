from pathlib import Path

student_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\routes\student.js')
server_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\server.js')
migrate_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\migrate-questions-to-sqlite.js')

student_text = student_path.read_text(encoding='utf-8')
student_text = student_text.replace(
"const {\n  ensureKnowledgeGraph,\n  recordQuestionResults,\n  getWrongStats,\n  recommendQuestions,\n  ensureGeneratedQuestions\n} = require('../services/math-bank');\n",
"const {\n  ensureKnowledgeGraph,\n  recordQuestionResults,\n  getWrongStats,\n  recommendQuestions,\n  ensureGeneratedQuestions\n} = require('../services/math-bank');\nconst { getPracticeDifficulty } = require('../services/practice-question-seeds');\n")

start = student_text.index("function buildKnowledgePointSpecificQuestions(knowledgePoint, masteryRate) {")
end = student_text.index("function syncWrongQuestionStatusFromPractice")
student_text = student_text[:start] + "function buildKnowledgePointSpecificQuestions(knowledgePoint, masteryRate) {\n  if (!knowledgePoint) return [];\n\n  const level = getPracticeDifficulty(masteryRate);\n\n  return db.find('questions')\n    .filter(question => {\n      return question.source === 'practice-seed' && Array.isArray(question.knowledgePoints) && question.knowledgePoints.includes(knowledgePoint.id);\n    })\n    .filter(question => !question.difficulty || question.difficulty === level)\n    .map(question => ({\n      ...question,\n      answerDisplay: question.type === 'choice'\n        ? buildChoiceDisplay(question, question.answer)\n        : (question.answer || '-')\n    }));\n}\n\n" + student_text[end:]

student_path.write_text(student_text, encoding='utf-8')

migrate_text = migrate_path.read_text(encoding='utf-8')
migrate_text = migrate_text.replace(
"const { ensureGeneratedQuestions } = require('../services/math-bank');\n",
"const { ensureGeneratedQuestions } = require('../services/math-bank');\nconst { buildPracticeQuestionSeeds } = require('../services/practice-question-seeds');\n")
migrate_text = migrate_text.replace(
"  ensureGeneratedQuestions(9);\n  const merged = db.find('questions');\n",
"  ensureGeneratedQuestions(9);\n  buildPracticeQuestionSeeds().forEach(question => {\n    if (!db.findById('questions', question.id)) {\n      db.create('questions', question);\n    }\n  });\n  const merged = db.find('questions');\n")
migrate_path.write_text(migrate_text, encoding='utf-8')

server_text = server_path.read_text(encoding='utf-8')
if "migrate-questions-to-sqlite" not in server_text:
    server_text = server_text.replace(
"const commonRoutes = require('./routes/common');\n",
"const commonRoutes = require('./routes/common');\nrequire('./database/migrate-questions-to-sqlite');\n")
server_path.write_text(server_text, encoding='utf-8')
