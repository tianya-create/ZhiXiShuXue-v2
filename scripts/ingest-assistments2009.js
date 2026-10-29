#!/usr/bin/env node
/**
 * ASSISTments 2009-2010 Skill Builder 数据清洗入口
 *
 * 目标：把原始 skill_builder_data.csv 转换为项目统一记录格式：
 *   userId, questionId, kpCode, isCorrect, costTime, createdAt
 *
 * 设计原则（对应《规则基线完成后的下一阶段路线》§三）：
 *   1. 清洗规则固定、可复现，每一步都记录「删了多少、剩多少」；
 *   2. 数据集无真实答题时间 → 用学生内交互序号构造「相对时间」，绝不伪造真实日期；
 *   3. 一道题关联多个知识点时，选择「主知识点」单一策略并固定（保留 skill_id 最小者）；
 *   4. 输出 manifest.json，记录数据来源、hash、清洗统计、协议、随机种子、代码版本。
 *
 * 用法：
 *   node scripts/ingest-assistments2009.js \
 *     --input backend/datasets/raw/skill_builder_data.csv \
 *     --out   backend/datasets/assist2009
 *
 * 可选参数：
 *   --min-interactions 2   每个 (学生, 知识点) 序列最少交互数
 *   --sample-students N    仅保留前 N 名学生（调试用，正式实验禁止使用）
 *   --quiet                只输出摘要 JSON
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { execSync } = require('child_process')

const REQUIRED_COLUMNS = ['user_id', 'problem_id', 'skill_id', 'skill_name', 'correct', 'ms_first_response']

// 相对时间基准：数据本身没有时间戳，用固定基准 + 学生内交互序号生成单调时间轴
const BASE_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0)
const STEP_MS = 60 * 1000 // 每一步（一次交互）代表 1 分钟的相对时间

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
  }
  const has = (name) => argv.includes(`--${name}`)
  return {
    input: get('input', path.join('backend', 'datasets', 'raw', 'skill_builder_data.csv')),
    out: get('out', path.join('backend', 'datasets', 'assist2009')),
    minInteractions: Number(get('min-interactions', 2)),
    sampleStudents: get('sample-students', null) === null ? null : Number(get('sample-students')),
    quiet: has('quiet')
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const buf = fs.readFileSync(filePath)
  hash.update(buf)
  return 'sha256:' + hash.digest('hex')
}

/** 最小 CSV 行解析：支持双引号包裹与 "" 转义（不含跨行字段） */
function parseCsvLine(line) {
  const cells = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else if (ch !== '\r') {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

function sanitizeText(value) {
  // 原始文件为 latin1 编码的英文，非 ASCII 多为编码残留字符，统一转为空格以保持 CSV 干净
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim()
  } catch (err) {
    return null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const inputPath = path.resolve(args.input)
  if (!fs.existsSync(inputPath)) {
    console.error(`输入文件不存在：${inputPath}`)
    process.exit(1)
  }
  const outDir = path.resolve(args.out)
  fs.mkdirSync(outDir, { recursive: true })

  const rawBytes = fs.statSync(inputPath).size
  const rawHash = sha256File(inputPath)

  // ---------- 逐行读取（latin1 保持字节原样，避免编码猜测出错） ----------
  const stream = fs.createReadStream(inputPath, { encoding: 'latin1' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let header = null
  let columnIndex = null
  // 每步删除计数按「原始行数逐级递减」写回，保证 removed/remaining 自洽
  const dropCounts = []
  const addDrop = (id, description, removed) => dropCounts.push({ step: id, description, removed })

  let totalRows = 0
  let malformedRows = 0
  let missingUser = 0
  let missingSkill = 0
  let invalidCorrect = 0
  let exactDuplicates = 0
  let multiSkillCollapsed = 0

  const seenRowKey = new Set()          // 完全重复行去重
  const orderToSkill = new Map()        // user_id|order_id → 该 order 下的行下标列表
  const raw = []                        // { userId, problemId, skillId, skillName, isCorrect, ms, orderId, rowSeq }
  const skillNames = new Map()

  for await (const line of rl) {
    if (!line || !line.trim()) continue
    if (!header) {
      header = parseCsvLine(line).map((s) => s.trim())
      columnIndex = {}
      for (const col of REQUIRED_COLUMNS) {
        const idx = header.indexOf(col)
        if (idx < 0) {
          console.error(`输入文件缺少必需列：${col}`)
          process.exit(1)
        }
        columnIndex[col] = idx
      }
      for (const optional of ['order_id', 'original', 'opportunity']) {
        columnIndex[optional] = header.indexOf(optional)
      }
      continue
    }

    totalRows++
    const cells = parseCsvLine(line)
    if (cells.length !== header.length) { malformedRows++; continue }

    const cell = (name) => (columnIndex[name] >= 0 ? cells[columnIndex[name]] : '')
    const userId = sanitizeText(cell('user_id'))
    const skillId = sanitizeText(cell('skill_id'))
    const skillName = sanitizeText(cell('skill_name'))
    const problemId = sanitizeText(cell('problem_id'))
    const correctRaw = sanitizeText(cell('correct'))
    const orderId = sanitizeText(cell('order_id'))

    if (!userId) { missingUser++; continue }
    if (!skillId || !skillName) { missingSkill++; continue }
    if (correctRaw !== '0' && correctRaw !== '1') { invalidCorrect++; continue }

    // 完全重复行（同一 order + 同一 skill 的重复写入）
    const rowKey = `${userId}|${orderId}|${skillId}`
    if (seenRowKey.has(rowKey)) { exactDuplicates++; continue }
    seenRowKey.add(rowKey)

    const ms = Number(sanitizeText(cell('ms_first_response')))
    if (!skillNames.has(skillId)) skillNames.set(skillId, skillName)
    const row = {
      userId,
      problemId,
      skillId,
      skillName,
      isCorrect: correctRaw === '1',
      costTime: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0,
      orderId,
      rowSeq: totalRows
    }
    raw.push(row)
    // 记录同一 order 分组，稍后统一做「主知识点」选择（避免逐条 O(n) 查找）
    if (orderId) {
      const orderKey = `${userId}|${orderId}`
      if (!orderToSkill.has(orderKey)) orderToSkill.set(orderKey, [])
      orderToSkill.get(orderKey).push(raw.length - 1)
    }
  }

  // 多知识点题目：同一 order 关联多个 skill 时，保留 skill_id 数值最小者作为主知识点
  const replacedIdx = new Set()
  for (const [, idxList] of orderToSkill) {
    if (idxList.length < 2) continue
    const sorted = [...idxList].sort((a, b) => {
      const na = Number(raw[a].skillId)
      const nb = Number(raw[b].skillId)
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
      return String(raw[a].skillId).localeCompare(String(raw[b].skillId))
    })
    for (const idx of sorted.slice(1)) { replacedIdx.add(idx); multiSkillCollapsed++ }
  }
  const rawAfterMultiSkill = raw.filter((_, idx) => !replacedIdx.has(idx))

  addDrop('malformed', '删除列数与表头不一致的行', malformedRows)
  addDrop('missing-user', '删除缺少 user_id 的行', missingUser)
  addDrop('missing-skill', '删除缺少 skill_id / skill_name 的行（缺失知识点）', missingSkill)
  addDrop('invalid-correct', '删除 correct 不是 0/1 的行', invalidCorrect)
  addDrop('exact-duplicate', '删除 (user_id, order_id, skill_id) 完全重复的记录', exactDuplicates)
  addDrop('multi-skill', '同一 order 多知识点：保留 skill_id 最小者作为主知识点', multiSkillCollapsed)

  const buildSteps = (extra) => {
    const steps = [{ step: 'read', description: '读取原始记录行数', removed: 0, remaining: totalRows }]
    let remaining = totalRows
    for (const d of [...dropCounts, ...extra]) {
      remaining -= d.removed
      steps.push({ step: d.step, description: d.description, removed: d.removed, remaining })
    }
    return steps
  }

  let kept = rawAfterMultiSkill

  // ---------- 相对时间：学生内交互序号（保持原始行序） ----------
  const studentStep = new Map()
  const records = kept.map((row) => {
    const step = (studentStep.get(row.userId) || 0) + 1
    studentStep.set(row.userId, step)
    return {
      userId: `a09-u${row.userId}`,
      questionId: `a09-p${row.problemId}`,
      kpCode: `a09-s${row.skillId}`,
      isCorrect: row.isCorrect,
      costTime: row.costTime,
      createdAt: new Date(BASE_EPOCH_MS + step * STEP_MS).toISOString(),
      sequenceIndex: step
    }
  })

  // ---------- 学生采样（仅调试） ----------
  let sampled = records
  const extraSteps = []
  if (args.sampleStudents && args.sampleStudents > 0) {
    const keepUsers = new Set()
    for (const rec of records) {
      if (keepUsers.size < args.sampleStudents) keepUsers.add(rec.userId)
      if (keepUsers.size >= args.sampleStudents) break
    }
    sampled = records.filter((rec) => keepUsers.has(rec.userId))
    extraSteps.push({ step: 'sample-students', description: `调试模式：仅保留前 ${args.sampleStudents} 名学生`, removed: records.length - sampled.length })
  }

  // ---------- 过滤过短序列：每个 (学生, 知识点) 至少 minInteractions 次交互 ----------
  const groupCount = new Map()
  for (const rec of sampled) {
    const key = `${rec.userId}|${rec.kpCode}`
    groupCount.set(key, (groupCount.get(key) || 0) + 1)
  }
  const keptGroups = new Set([...groupCount.entries()].filter(([, n]) => n >= args.minInteractions).map(([k]) => k))
  const finalRecords = sampled.filter((rec) => keptGroups.has(`${rec.userId}|${rec.kpCode}`))
  const droppedShort = sampled.length - finalRecords.length
  const droppedShortGroups = groupCount.size - keptGroups.size
  extraSteps.push({
    step: 'short-sequence',
    description: `删除交互数 < ${args.minInteractions} 的 (学生,知识点) 序列（无法做下一题预测；共 ${droppedShortGroups} 个序列）`,
    removed: droppedShort
  })
  const steps = buildSteps(extraSteps)

  // ---------- 写出统一格式 ----------
  const outCsv = path.join(outDir, 'interactions.csv')
  const lines = ['userId,questionId,kpCode,isCorrect,costTime,createdAt,sequenceIndex']
  for (const rec of finalRecords) {
    lines.push([
      rec.userId,
      rec.questionId,
      rec.kpCode,
      rec.isCorrect ? 1 : 0,
      rec.costTime,
      rec.createdAt,
      rec.sequenceIndex
    ].join(','))
  }
  fs.writeFileSync(outCsv, lines.join('\n') + '\n', 'utf8')

  // ---------- 统计 ----------
  const students = new Set(finalRecords.map((r) => r.userId))
  const kps = new Set(finalRecords.map((r) => r.kpCode))
  const questions = new Set(finalRecords.map((r) => r.questionId))
  const correctCount = finalRecords.filter((r) => r.isCorrect).length
  const groupSizes = [...keptGroups].map((key) => groupCount.get(key)).sort((a, b) => a - b)
  const medianGroup = groupSizes.length ? groupSizes[Math.floor(groupSizes.length / 2)] : 0
  // 可做预测的样本数 = 交互数 - 序列数（每个 (学生,知识点) 序列的首条没有历史，无法预测）
  const opportunity = finalRecords.length - keptGroups.size

  const outHash = sha256File(outCsv)
  const manifest = {
    dataset: {
      name: 'ASSISTments 2009-2010 Skill Builder',
      officialPage: 'https://sites.google.com/site/assistmentsdata/home/2009-2010-assistment-data/skill-builder-data-2009-2010',
      mirrorUsed: 'https://github.com/WalidAlsafadi/SkillMap-AI-Student-Support-Prediction/blob/main/data/raw/skill_builder_data.csv',
      license: 'ASSISTments 数据使用协议（学术研究用途，引用 ASSISTments 团队）',
      note: '本仓库不提交原始数据文件，仅提交清洗结果元信息与统计；原始文件请按 manifest.source 自行下载'
    },
    source: {
      rawFile: path.relative(path.join(__dirname, '..'), inputPath).split(path.sep).join('/'),
      rawBytes,
      rawSha256: rawHash,
      rawColumns: header,
      rowCountInRaw: totalRows
    },
    output: {
      file: path.relative(path.join(__dirname, '..'), outCsv).split(path.sep).join('/'),
      sha256: outHash,
      bytes: fs.statSync(outCsv).size,
      rowCount: finalRecords.length,
      columns: ['userId', 'questionId', 'kpCode', 'isCorrect', 'costTime', 'createdAt', 'sequenceIndex']
    },
    cleaning: steps,
    rules: {
      missingSkill: '缺少 skill_id 或 skill_name 的记录直接删除（不猜测知识点）',
      duplicate: '按 (user_id, order_id, skill_id) 去重，保留首次出现',
      multiSkill: `同一 order_id 关联多个知识点时，复制记录会重复计数，因此保留 skill_id 数值最小者作为主知识点（固定策略，切换需重跑并记录）`,
      shortSequence: `每个 (学生, 知识点) 序列至少 ${args.minInteractions} 次交互，否则无法定义「预测下一次」任务`,
      costTime: 'ms_first_response 毫秒转秒后取整；缺失或非正值记为 0（速度条件视为不满足）',
      timeModel: {
        type: 'relative-sequence-index',
        description: `数据集无真实答题时间戳（order_id 非时序），因此用「学生内交互序号」构造相对时间轴：createdAt = ${new Date(BASE_EPOCH_MS).toISOString()} + 序号 × ${STEP_MS / 1000}s。它不是真实日期，只用于定义先后顺序与时间间隔`,
        important: '相对时间下的「间隔天数」不具现实含义，涉及时间衰减的模型（Rule-2）在本数据集上的结论需谨慎解读'
      },
      ids: {
        userId: 'a09-u<原始 user_id>',
        questionId: 'a09-p<原始 problem_id>',
        kpCode: 'a09-s<原始 skill_id>',
        skillNames: 'skill_id → skill_name 映射见 skill-names.json'
      }
    },
    split: {
      protocol: '时间顺序 walk-forward：预测第 t 次交互只使用同一 (学生, 知识点) 序列中前 t-1 次记录；不做随机划分，测试样本与训练样本按时间严格分离',
      seed: 42,
      bootstrap: '学生级聚类 bootstrap（重采样单位为学生）'
    },
    stats: {
      students: students.size,
      knowledgePoints: kps.size,
      questions: questions.size,
      interactions: finalRecords.length,
      predictors: opportunity,
      predictorDefinition: 'walk-forward 可预测样本数 = 交互数 − (学生,知识点) 序列数（每条序列首条无历史，无法预测）',
      correctRate: Number((correctCount / finalRecords.length).toFixed(4)),
      groupCount: keptGroups.size,
      groupSizeMedian: medianGroup,
      groupSizeMax: groupSizes.length ? groupSizes[groupSizes.length - 1] : 0
    },
    reproducibility: {
      script: 'scripts/ingest-assistments2009.js',
      scriptSha256: sha256File(__filename),
      gitCommit: gitCommit(),
      generatedAt: new Date().toISOString(),
      node: process.version,
      args
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  fs.writeFileSync(
    path.join(outDir, 'skill-names.json'),
    JSON.stringify(Object.fromEntries([...skillNames.entries()].sort()), null, 2),
    'utf8'
  )

  if (!args.quiet) {
    console.log(`\n== ASSISTments 2009 清洗完成 ==`)
    console.log(`原始文件 ${(rawBytes / 1024 / 1024).toFixed(1)}MB，${totalRows} 行`)
    console.log(`\n清洗步骤（removed = 本步删除，remaining = 本步剩余）`)
    for (const step of steps) {
      console.log(`  ${step.step.padEnd(16)} -${String(step.removed).padStart(7)}  → ${step.remaining}`)
    }
    console.log(`\n输出：${manifest.output.file}（${finalRecords.length} 条交互）`)
    console.log(`学生 ${students.size} / 知识点 ${kps.size} / 题目 ${questions.size} / 正确率 ${(correctCount / finalRecords.length).toFixed(4)}`)
    console.log(`可预测样本 ${opportunity}，(学生,知识点) 序列 ${keptGroups.size}，序列长度中位数 ${medianGroup}`)
    console.log(`原始文件 sha256 ${rawHash.slice(0, 30)}…`)
    console.log(`输出文件 sha256 ${outHash.slice(0, 30)}…`)
  }

  console.log(JSON.stringify({ outputFile: outCsv, manifest: path.join(outDir, 'manifest.json'), stats: manifest.stats }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
