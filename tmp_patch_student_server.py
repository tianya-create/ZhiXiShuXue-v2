from pathlib import Path

student_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\routes\student.js')
text = student_path.read_text(encoding='utf-8')
anchor = "const { getPracticeDifficulty } = require('../services/practice-question-seeds');"
insert = anchor + "\nconst { getSmartRecommendations } = require('../services/recommendation');\nconst { gradeAnswer } = require('../services/autoGrade');\nconst { updateMastery, getTrend } = require('../services/masteryEngine');\nconst { buildMistakeTags, normalizeErrorType } = require('../services/mistakeTagging');\nconst { broadcastToUser } = require('../websocket/server');"
if anchor in text and 'getSmartRecommendations' not in text:
    text = text.replace(anchor, insert)

append_anchor = "module.exports = router;"
append_block = """
router.get('/recommendations', (req, res) => {
  try {
    const studentId = req.headers['x-user-id'];
    const student = getStudentByUserId(studentId);
    if (!student) return res.status(404).json({ success: false, message: '学生不存在' });

    const limit = Math.max(1, Math.min(10, Number(req.query.limit) || 10));
    const refresh = String(req.query.refresh || 'false') === 'true';
    const data = getSmartRecommendations(student.id, limit, refresh);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/answer/submit', (req, res) => {
  try {
    const studentId = req.headers['x-user-id'];
    const student = getStudentByUserId(studentId);
    if (!student) return res.status(404).json({ success: false, message: '学生不存在' });

    const { questionId, userAnswer, costTime, errorType } = req.body || {};
    const question = db.findById('questions', questionId);
    if (!question) return res.status(404).json({ success: false, message: '题目不存在' });

    const grade = gradeAnswer(question, userAnswer);
    const kpCode = question.kpCode || question.knowledgePointId || ((question.knowledgePoints || [])[0] || '');
    const normalizedErrorType = normalizeErrorType(errorType, question, userAnswer);

    db.create('student_answer', {
      userId: student.id,
      questionId,
      kpCode,
      isCorrect: grade.isCorrect,
      costTime: Number(costTime || 0),
      errorType: normalizedErrorType,
      userAnswer: grade.userAnswer,
      createdAt: new Date().toISOString()
    });

    const mastery = updateMastery(student.id, kpCode);
    broadcastToUser(student.id, 'mastery-updated', { kpCode, newMastery: mastery.mastery });

    if (!grade.isCorrect) {
      const tags = buildMistakeTags(question, normalizedErrorType);
      db.upsertStudentMistake(student.id, {
        questionId,
        questionContent: question.content,
        kpCode: tags.kpCode,
        kpName: (db.findById('knowledgePoints', tags.kpCode) || {}).name || tags.kpCode,
        difficulty: tags.difficulty,
        errorType: tags.errorType,
        wrongCount: 1,
        lastPracticeTime: new Date().toISOString(),
        masteryStatus: mastery.status,
        isResolved: false
      });
    } else {
      db.resolveStudentMistake(student.id, questionId);
    }

    res.json({
      success: true,
      data: {
        isCorrect: grade.isCorrect,
        correctAnswer: grade.correctAnswer,
        explanation: grade.explanation,
        userAnswer: grade.userAnswer,
        mastery: mastery.mastery,
        kpCode
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/mastery/trend', (req, res) => {
  try {
    const studentId = req.headers['x-user-id'];
    const student = getStudentByUserId(studentId);
    if (!student) return res.status(404).json({ success: false, message: '学生不存在' });
    const kpCode = String(req.query.kpCode || '');
    const days = Math.max(1, Math.min(30, Number(req.query.days) || 30));
    res.json({ success: true, data: getTrend(student.id, kpCode, days) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const originalWrongQuestionsHandler = router.stack.find(layer => layer.route && layer.route.path === '/wrong-questions' && layer.route.methods.get);
if (originalWrongQuestionsHandler) {
  originalWrongQuestionsHandler.route.stack[0].handle = (req, res) => {
    try {
      const studentId = req.headers['x-user-id'];
      const student = getStudentByUserId(studentId);
      if (!student) return res.status(404).json({ success: false, message: '学生不存在' });
      const mistakes = db.getAllMistakesForStudent(student.id).map(item => ({
        id: item.questionId,
        questionId: item.questionId,
        content: item.questionContent,
        kpCode: item.kpCode,
        errorType: item.errorType,
        difficulty: item.difficulty,
        wrongCount: item.wrongCount || 1,
        lastPracticeTime: item.lastPracticeTime,
        masteryStatus: item.masteryStatus || '待强化',
        question: db.findById('questions', item.questionId)
      }));
      res.json({ success: true, data: mistakes });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
}
"""
if append_anchor in text and '/answer/submit' not in text:
    text = text.replace(append_anchor, append_block + "\nmodule.exports = router;")
student_path.write_text(text, encoding='utf-8')
print('patched student.js')

server_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\server.js')
server_text = server_path.read_text(encoding='utf-8')
if "initWebSocketServer" not in server_text:
    server_text = server_text.replace("const fs = require('fs');", "const fs = require('fs');\nconst { initWebSocketServer } = require('./websocket/server');\nconst { startDailySnapshotJob } = require('./cron/dailySnapshot');\nconst { initializeSmartLearningModels } = require('./models');")
    server_text = server_text.replace("require('./database/migrate-questions-to-sqlite');", "require('./database/migrate-questions-to-sqlite');\ninitializeSmartLearningModels();")
    server_text = server_text.replace("const server = app.listen(PORT, () => {", "const server = app.listen(PORT, () => {")
    server_text += "\ninitWebSocketServer(server);\nstartDailySnapshotJob();\n"
server_path.write_text(server_text, encoding='utf-8')
print('patched server.js')
