from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\database\memory-db.js')
text = path.read_text(encoding='utf-8')

text = text.replace(
"const { v4: uuidv4 } = require('uuid');\nconst bcrypt = require('bcryptjs');\n",
"const { v4: uuidv4 } = require('uuid');\nconst bcrypt = require('bcryptjs');\nconst fs = require('fs');\nconst path = require('path');\n")

text = text.replace(
"// 内存存储\nconst db = {\n",
"const QUESTIONS_STORE_PATH = path.join(__dirname, 'questions.json');\n\n// 内存存储\nconst db = {\n")

text = text.replace(
"// 初始化默认数据\nfunction initializeData() {\n",
"function loadPersistedQuestions() {\n  try {\n    if (!fs.existsSync(QUESTIONS_STORE_PATH)) {\n      return null;\n    }\n\n    const raw = fs.readFileSync(QUESTIONS_STORE_PATH, 'utf-8');\n    const parsed = JSON.parse(raw);\n    if (!Array.isArray(parsed)) {\n      return null;\n    }\n\n    return parsed.map(item => ({\n      ...item,\n      options: Array.isArray(item.options) ? item.options : [],\n      knowledgePoints: Array.isArray(item.knowledgePoints) ? item.knowledgePoints : []\n    }));\n  } catch (error) {\n    console.error('加载持久化题库失败:', error.message);\n    return null;\n  }\n}\n\nfunction persistQuestions() {\n  try {\n    fs.writeFileSync(QUESTIONS_STORE_PATH, JSON.stringify(db.questions, null, 2), 'utf-8');\n  } catch (error) {\n    console.error('保存持久化题库失败:', error.message);\n  }\n}\n\n// 初始化默认数据\nfunction initializeData() {\n")

text = text.replace(
"  ]\n  questions.forEach(q => db.questions.push(q))\n\n  // 初始化模拟答题记录\n",
"  ]\n  questions.forEach(q => db.questions.push(q))\n\n  const persistedQuestions = loadPersistedQuestions();\n  if (Array.isArray(persistedQuestions)) {\n    db.questions = persistedQuestions;\n  } else {\n    persistQuestions();\n  }\n\n  // 初始化模拟答题记录\n")

text = text.replace(
"class Database {\n  constructor() {\n    this.data = db;\n  }\n\n  // 通用 CRUD 操作\n",
"class Database {\n  constructor() {\n    this.data = db;\n  }\n\n  persistCollection(collection) {\n    if (collection === 'questions') {\n      persistQuestions();\n    }\n  }\n\n  // 通用 CRUD 操作\n")

text = text.replace(
"    this.data[collection].push(newItem);\n    return newItem;\n  }\n",
"    this.data[collection].push(newItem);\n    this.persistCollection(collection);\n    return newItem;\n  }\n", 1)

text = text.replace(
"    this.data[collection][index] = {\n      ...this.data[collection][index],\n      ...updates,\n      updatedAt: new Date().toISOString()\n    };\n    return this.data[collection][index];\n  }\n",
"    this.data[collection][index] = {\n      ...this.data[collection][index],\n      ...updates,\n      updatedAt: new Date().toISOString()\n    };\n    this.persistCollection(collection);\n    return this.data[collection][index];\n  }\n")

text = text.replace(
"    this.data[collection].splice(index, 1);\n    return true;\n  }\n",
"    this.data[collection].splice(index, 1);\n    this.persistCollection(collection);\n    return true;\n  }\n")

text = text.replace(
"    const initialLength = this.data[collection].length;\n    this.data[collection] = this.data[collection].filter(item => {\n      return !Object.keys(query).every(key => item[key] === query[key]);\n    });\n    return initialLength - this.data[collection].length;\n  }\n",
"    const initialLength = this.data[collection].length;\n    this.data[collection] = this.data[collection].filter(item => {\n      return !Object.keys(query).every(key => item[key] === query[key]);\n    });\n    if (initialLength != this.data[collection].length) {\n      this.persistCollection(collection);\n    }\n    return initialLength - this.data[collection].length;\n  }\n")

path.write_text(text, encoding='utf-8')
