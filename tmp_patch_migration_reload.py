from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\migrate-questions-to-sqlite.js')
text = path.read_text(encoding='utf-8')
text = text.replace("  replaceAllQuestions(merged);\n\n  const all = getAllQuestions();\n", "  replaceAllQuestions(merged);\n  db.reloadQuestionsFromStore();\n\n  const all = getAllQuestions();\n")
path.write_text(text, encoding='utf-8')
