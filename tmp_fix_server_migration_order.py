from pathlib import Path

server_path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\server.js')
text = server_path.read_text(encoding='utf-8')
text = text.replace("require('./database/migrate-questions-to-sqlite');\n", "")
text = text.replace(
"const server = app.listen(PORT, () => {\n",
"require('./database/migrate-questions-to-sqlite');\n\nconst server = app.listen(PORT, () => {\n")
server_path.write_text(text, encoding='utf-8')
