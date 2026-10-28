from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\memory-db.js')
text = path.read_text(encoding='utf-8')

text = text.replace("const fs = require('fs');\nconst path = require('path');\n\nconst QUESTIONS_STORE_PATH = path.join(__dirname, 'questions.json');\n", "const { loadQuestionsFromStore, upsertQuestion, deleteQuestion: deleteQuestionFromStore } = require('./question-store');\n")

start = text.index("function loadPersistedQuestions() {")
end = text.index("// 初始化默认数据")
text = text[:start] + "// 初始化默认数据\n" + text[end + len("// 初始化默认数据\n"):]

text = text.replace(
"  const persistedQuestions = loadPersistedQuestions();\n  if (Array.isArray(persistedQuestions)) {\n    db.questions = persistedQuestions;\n  } else {\n    persistQuestions();\n  }\n",
"  db.questions = loadQuestionsFromStore(db.questions);\n")

text = text.replace(
"  persistCollection(collection) {\n    if (collection === 'questions') {\n      persistQuestions();\n    }\n  }\n",
"  persistCollection(collection, payload) {\n    if (collection !== 'questions') {\n      return;\n    }\n\n    if (payload && payload.type === 'delete') {\n      deleteQuestionFromStore(payload.id);\n      return;\n    }\n\n    if (payload && payload.item) {\n      upsertQuestion(payload.item);\n    }\n  }\n")

text = text.replace(
"    this.data[collection].push(newItem);\n    this.persistCollection(collection);\n",
"    this.data[collection].push(newItem);\n    this.persistCollection(collection, { item: newItem });\n")

text = text.replace(
"    this.persistCollection(collection);\n    return this.data[collection][index];\n",
"    this.persistCollection(collection, { item: this.data[collection][index] });\n    return this.data[collection][index];\n")

text = text.replace(
"    this.data[collection].splice(index, 1);\n    this.persistCollection(collection);\n",
"    const removed = this.data[collection][index];\n    this.data[collection].splice(index, 1);\n    this.persistCollection(collection, { type: 'delete', id: removed.id });\n")

text = text.replace(
"    if (initialLength != this.data[collection].length) {\n      this.persistCollection(collection);\n    }\n",
"    if (initialLength != this.data[collection].length && collection === 'questions') {\n      this.data[collection].forEach(item => this.persistCollection(collection, { item }));\n    }\n")

path.write_text(text, encoding='utf-8')
