from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\question-store.js')
text = path.read_text(encoding='utf-8')

text = text.replace("function upsertQuestions(questions) {\n  const db = getDatabase();\n  const transaction = db.transaction((items) => {\n    items.forEach(item => upsertQuestion(item));\n  });\n  transaction(questions || []);\n}\n\nfunction replaceAllQuestions(questions) {\n  const db = getDatabase();\n  const transaction = db.transaction((items) => {\n    db.prepare('DELETE FROM questions').run();\n    (items || []).forEach(item => upsertQuestion(item));\n  });\n  transaction(questions || []);\n}\n",
"function upsertQuestions(questions) {\n  const db = getDatabase();\n  db.exec('BEGIN');\n  try {\n    (questions || []).forEach(item => upsertQuestion(item));\n    db.exec('COMMIT');\n  } catch (error) {\n    db.exec('ROLLBACK');\n    throw error;\n  }\n}\n\nfunction replaceAllQuestions(questions) {\n  const db = getDatabase();\n  db.exec('BEGIN');\n  try {\n    db.prepare('DELETE FROM questions').run();\n    (questions || []).forEach(item => upsertQuestion(item));\n    db.exec('COMMIT');\n  } catch (error) {\n    db.exec('ROLLBACK');\n    throw error;\n  }\n}\n")

path.write_text(text, encoding='utf-8')
