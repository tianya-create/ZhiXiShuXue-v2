from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\memory-db.js')
text = path.read_text(encoding='utf-8')
text = text.replace("const fs = require('fs');\nconst path = require('path');\nconst fs = require('fs');\nconst path = require('path');\n", "const fs = require('fs');\nconst path = require('path');\n")
path.write_text(text, encoding='utf-8')
