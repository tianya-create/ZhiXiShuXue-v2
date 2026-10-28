from pathlib import Path

server_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\server.js')
memory_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\memory-db.js')

server_text = server_path.read_text(encoding='utf-8')
server_text = server_text.replace("// 导入路由\nconst authRoutes = require('./routes/auth');\nconst teacherRoutes = require('./routes/teacher');\nconst studentRoutes = require('./routes/student');\nconst adminRoutes = require('./routes/admin');\nconst commonRoutes = require('./routes/common');\n", "require('./database/migrate-questions-to-sqlite');\n\n// 导入路由\nconst authRoutes = require('./routes/auth');\nconst teacherRoutes = require('./routes/teacher');\nconst studentRoutes = require('./routes/student');\nconst adminRoutes = require('./routes/admin');\nconst commonRoutes = require('./routes/common');\n")
server_text = server_text.replace("\nrequire('./database/migrate-questions-to-sqlite');\n\nconst server = app.listen(PORT, () => {\n", "\nconst server = app.listen(PORT, () => {\n")
server_path.write_text(server_text, encoding='utf-8')

memory_text = memory_path.read_text(encoding='utf-8')
memory_text = memory_text.replace("const { loadQuestionsFromStore, upsertQuestion, deleteQuestion: deleteQuestionFromStore } = require('./question-store');\n", "const { loadQuestionsFromStore, getAllQuestions, upsertQuestion, deleteQuestion: deleteQuestionFromStore } = require('./question-store');\n")
insert_after = "  constructor() {\n    this.data = db;\n  }\n\n"
replacement = "  constructor() {\n    this.data = db;\n  }\n\n  reloadQuestionsFromStore() {\n    this.data.questions = getAllQuestions();\n    return this.data.questions;\n  }\n\n"
memory_text = memory_text.replace(insert_after, replacement)
memory_path.write_text(memory_text, encoding='utf-8')
