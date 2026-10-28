from pathlib import Path

base = Path(r'c:\Users\32328\Desktop\zhiXiShuXue')
questions_vue = base / 'frontend' / 'src' / 'views' / 'admin' / 'Questions.vue'
practice_vue = base / 'frontend' / 'src' / 'views' / 'student' / 'Practice.vue'
admin_js = base / 'backend' / 'routes' / 'admin.js'

text = questions_vue.read_text(encoding='utf-8')
text = text.replace(
"var form = reactive({ id: '', type: 'choice', content: '', answer: '', score: 5, difficulty: 'medium' })",
"var form = reactive({ id: '', type: 'choice', content: '', optionsText: '', answer: '', score: 5, difficulty: 'medium' })")
text = text.replace(
"  form.content = ''\n  form.answer = ''\n  form.score = 5",
"  form.content = ''\n  form.optionsText = ''\n  form.answer = ''\n  form.score = 5")
text = text.replace(
"  form.content = row.content\n  form.answer = row.answer\n  form.score = row.score",
"  form.content = row.content\n  form.optionsText = Array.isArray(row.options) ? row.options.join('\\n') : ''\n  form.answer = row.answer\n  form.score = row.score")
text = text.replace(
"function submitForm() {\n  formRef.value.validate()\n    .then(function() {\n      var request\n      if (isEdit.value) {\n        request = api.put('/admin/questions/' + form.id, form)\n      } else {\n        request = api.post('/admin/questions', form)\n      }\n      \n      request\n        .then(function(res) {\n          if (res.success) {\n            ElMessage.success(isEdit.value ? '更新成功' : '添加成功')\n            dialogVisible.value = false\n            loadQuestions()\n          }\n        })\n        .catch(function(error) {\n          ElMessage.error('操作失败')\n        })\n    })\n    .catch(function() {})\n}\n",
"function submitForm() {\n  formRef.value.validate()\n    .then(function() {\n      var payload = {\n        id: form.id,\n        type: form.type,\n        content: form.content,\n        answer: form.answer,\n        score: form.score,\n        difficulty: form.difficulty,\n        options: form.type === 'choice'\n          ? form.optionsText.split('\\n').map(function(item) { return item.trim() }).filter(Boolean)\n          : []\n      }\n\n      if (payload.type === 'choice' && payload.options.length < 2) {\n        ElMessage.warning('选择题至少需要填写两个选项')\n        return\n      }\n\n      var request\n      if (isEdit.value) {\n        request = api.put('/admin/questions/' + form.id, payload)\n      } else {\n        request = api.post('/admin/questions', payload)\n      }\n      \n      request\n        .then(function(res) {\n          if (res.success) {\n            ElMessage.success(isEdit.value ? '更新成功' : '添加成功')\n            dialogVisible.value = false\n            loadQuestions()\n          }\n        })\n        .catch(function(error) {\n          ElMessage.error('操作失败')\n        })\n    })\n    .catch(function() {})\n}\n")
questions_vue.write_text(text, encoding='utf-8')

text = admin_js.read_text(encoding='utf-8')
text = text.replace(
"router.put('/questions/:id', (req, res) => {\n  try {\n    const { id } = req.params;\n    const { content, options, answer, knowledgePoints, difficulty, score } = req.body;\n    \n    const updated = db.updateById('questions', id, {\n      content, options, answer, knowledgePoints, difficulty, score\n    });\n",
"router.put('/questions/:id', (req, res) => {\n  try {\n    const { id } = req.params;\n    const { content, options, answer, knowledgePoints, difficulty, score } = req.body;\n    const normalizedOptions = Array.isArray(options)\n      ? options.map(item => String(item || '').trim()).filter(Boolean)\n      : [];\n    const normalizedAnswer = String(answer || '').trim();\n\n    if (!normalizedAnswer) {\n      return res.status(400).json({ success: false, message: '答案不能为空' });\n    }\n    if (normalizedOptions.length > 0 && normalizedOptions.length < 2) {\n      return res.status(400).json({ success: false, message: '选择题至少需要两个选项' });\n    }\n    \n    const updated = db.updateById('questions', id, {\n      content,\n      options: normalizedOptions,\n      answer: normalizedAnswer,\n      knowledgePoints,\n      difficulty,\n      score\n    });\n")
admin_js.write_text(text, encoding='utf-8')

text = practice_vue.read_text(encoding='utf-8')
text = text.replace(
"import { ElMessage, ElMessageBox } from 'element-plus'",
"import { ElMessage, ElMessageBox } from 'element-plus'")
text = text.replace(
"const resultVisible = ref(false)\nconst overviewCategoryExpandedMap = ref({})\n",
"const resultVisible = ref(false)\nconst answerDialogVisible = ref(false)\nconst answerDialogItems = ref([])\nconst overviewCategoryExpandedMap = ref({})\n")
text = text.replace(
"        <el-card v-if=\"resultVisible\" class=\"result-card gradient-card\">",
"        <el-dialog v-model=\"answerDialogVisible\" title=\"本次作答答案反馈\" width=\"680px\">\n          <div class=\"answer-dialog-list\">\n            <div v-for=\"item in answerDialogItems\" :key=\"item.id\" class=\"answer-dialog-item\">\n              <div class=\"answer-dialog-title\">{{ item.title }}</div>\n              <div class=\"answer-dialog-meta\">你的答案：{{ item.studentAnswer || '-' }}</div>\n              <div class=\"answer-dialog-meta\">正确答案：{{ item.correctAnswer || '-' }}</div>\n            </div>\n          </div>\n          <template #footer>\n            <el-button type=\"primary\" @click=\"answerDialogVisible = false\">我知道了</el-button>\n          </template>\n        </el-dialog>\n\n        <el-card v-if=\"resultVisible\" class=\"result-card gradient-card\">")
text = text.replace(
"function submitPractice() {",
"function openAnswerDialog(questionList, resultList) {\n  answerDialogItems.value = questionList.map((question, index) => {\n    const result = resultList.find(item => item.questionId === question.id) || {}\n    return {\n      id: question.id || index,\n      title: `第 ${index + 1} 题`,\n      studentAnswer: result.answer || answers[question.id] || '-',\n      correctAnswer: result.correctAnswer || question.answerDisplay || question.answer || '-'\n    }\n  })\n  answerDialogVisible.value = answerDialogItems.value.length > 0\n}\n\nfunction submitPractice() {")
text = text.replace(
"        ElMessage.success(res.message || '提交成功')",
"        openAnswerDialog(questions.value, resultData.questionResults)\n        ElMessage.success(res.message || '提交成功')")
text = text.replace(
".section-desc,\n.overview-item-desc,\n.overview-item-meta,\n.submit-summary,\n.result-kp-meta,\n.progress-meta,\n.advice-item {\n",
".section-desc,\n.overview-item-desc,\n.overview-item-meta,\n.submit-summary,\n.result-kp-meta,\n.progress-meta,\n.advice-item,\n.answer-dialog-meta {\n")
text += "\n.answer-dialog-list {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n}\n\n.answer-dialog-item {\n  border-radius: 14px;\n  padding: 14px 16px;\n  background: linear-gradient(135deg, #ffffff, #f8fbff);\n  border: 1px solid #e8eef8;\n}\n\n.answer-dialog-title {\n  font-size: 15px;\n  font-weight: 800;\n  color: #111827;\n  margin-bottom: 8px;\n}\n"
practice_vue.write_text(text, encoding='utf-8')
