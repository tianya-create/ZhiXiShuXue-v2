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
 *   3. 一道题关联多个知识点时，选择「主知识点」单一策略并固定（默认保留 skill_id 最小者，
 *      可用 --multi-skill min|max|multi 切换，用于敏感性分析）；
 *   4. 输出 manifest.json，记录数据来源、hash、清洗统计、协议、随机种子、代码版本。
 *
 * 用法：
 *   node scripts/ingest-assistments2009.js \
 *     --input backend/datasets/raw/skill_builder_data.csv \
 *     --out   backend/datasets/assist2009
 *
 * 可选参数：
 *   --min-interactions 2   每个 (学生, 知识点) 序列最少交互数
 *   --multi-skill min|max|multi
 *                          多知识点策略（默认 min；max/multi 用于敏感性分析）
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
    multiSkill: get('multi-skill', 'min'),
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
  if (!['min', 'max', 'multi'].includes(args.multiSkill)) {
    console.error(`--multi-skill 只支持 min | max | multi，收到：${args.multiSkill}`)
    process.exit(1)
  }
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
  let duplicateWrites = 0      // 同键且 problem_id/correct/ms_first_response 完全一致 → 重复写入，可删
  let duplicateConflicts = 0   // 同键但上述字段存在差异 → 不能当重复删，保留并单独报告
  let emptyOrderIdRows = 0     // order_id 为空 → 去重键退化，不参与去重，全部保留
  let multiSkillCollapsed = 0

  const duplicateState = new Map()      // (user_id, order_id, skill_id) → 首次出现的比较字段
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

    // 重复写入去重：仅当 order_id 非空时，(user_id, order_id, skill_id) 才唯一标识一次交互。
    // order_id 为空时该键会退化为 user_id|skill_id，把同一学生同一知识点的多条不同交互
    // 误判为重复，因此空 order_id 的记录全部保留，并在 manifest 中单独报告数量。
    // 同键的后续行先比对 problem_id / correct / ms_first_response：
    //   完全一致 → 判定为同一交互的重复写入，删除，保留原始文件中首次出现的行；
    //   存在差异 → 不能按重复删除，保留该行并单独计数报告。
    // 注意：脚本比较的是文件中的出现顺序，不比较 opportunity 数值（opportunity 与
    // opportunity_original 均不进入输出，同组记录除这两列外字段完全一致，
    // 因此保留哪一行对结果无影响）；同时统计每组重复键的实际最小 opportunity，
    // 用于事后验证「首次出现 = 最小 opportunity」在本数据集上是否成立。
    const msRaw = sanitizeText(cell('ms_first_response'))
    const oppNum = Number(sanitizeText(columnIndex.opportunity >= 0 ? cell('opportunity') : ''))
    if (!orderId) {
      emptyOrderIdRows++
    } else {
      const rowKey = `${userId}|${orderId}|${skillId}`
      const prev = duplicateState.get(rowKey)
      if (prev) {
        if (prev.problemId === problemId && prev.correctRaw === correctRaw && prev.msRaw === msRaw) {
          duplicateWrites++
          prev.count++
          if (Number.isFinite(oppNum) && (!Number.isFinite(prev.minOpp) || oppNum < prev.minOpp)) {
            prev.minOpp = oppNum
          }
          continue
        }
        duplicateConflicts++
      } else {
        duplicateState.set(rowKey, { problemId, correctRaw, msRaw, firstOpp: oppNum, minOpp: oppNum, count: 1 })
      }
    }

    const ms = Number(msRaw)
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

  // 事后验证：重复键中「首次出现 = 最小 opportunity」是否成立（不改变保留行为，
  // 仅用于在 manifest 中给出实测依据；opportunity 不进入输出，保留哪一行结果一致）
  let duplicateMultiKeys = 0
  let duplicateFirstNotMinOpp = 0
  for (const s of duplicateState.values()) {
    if (s.count > 1) {
      duplicateMultiKeys++
      if (Number.isFinite(s.firstOpp) && Number.isFinite(s.minOpp) && s.minOpp !== s.firstOpp) {
        duplicateFirstNotMinOpp++
      }
    }
  }

  // 多知识点题目：同一 order 关联多个 skill 时按 --multi-skill 策略处理
  //   min（默认）: 保留 skill_id 数值最小者作为主知识点
  //   max        : 保留 skill_id 数值最大者（敏感性分析对照）
  //   multi      : 全部保留（同一作答在多个知识点序列中各计一次，敏感性分析对照）
  const replacedIdx = new Set()
  if (args.multiSkill !== 'multi') {
    for (const [, idxList] of orderToSkill) {
      if (idxList.length < 2) continue
      const sorted = [...idxList].sort((a, b) => {
        const na = Number(raw[a].skillId)
        const nb = Number(raw[b].skillId)
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
          return args.multiSkill === 'min' ? na - nb : nb - na
        }
        return String(raw[a].skillId).localeCompare(String(raw[b].skillId))
      })
      for (const idx of sorted.slice(1)) { replacedIdx.add(idx); multiSkillCollapsed++ }
    }
  }
  const rawAfterMultiSkill = args.multiSkill === 'multi' ? raw.slice() : raw.filter((_, idx) => !replacedIdx.has(idx))

  addDrop('malformed', '删除列数与表头不一致的行', malformedRows)
  addDrop('missing-user', '删除缺少 user_id 的行', missingUser)
  addDrop('missing-skill', '删除缺少 skill_id / skill_name 的行（缺失知识点）', missingSkill)
  addDrop('invalid-correct', '删除 correct 不是 0/1 的行', invalidCorrect)
  addDrop('duplicate-write', '删除同一 (user_id, order_id, skill_id) 的重复写入：problem_id/correct/ms_first_response 完全一致（实测仅 opportunity 不同），保留原始文件中首次出现的行', duplicateWrites)
  addDrop('duplicate-conflict', `同键但 problem_id/correct/ms_first_response 存在差异的记录：不按重复删除，全部保留并单独报告（共 ${duplicateConflicts} 条）`, 0)
  addDrop('empty-order-id', `order_id 为空的记录：去重键会退化为 user_id|skill_id 造成误删风险，故不参与去重、全部保留（共 ${emptyOrderIdRows} 条）`, 0)
  addDrop('multi-skill', `同一 order 多知识点：按 --multi-skill ${args.multiSkill} 策略处理${args.multiSkill === 'multi' ? '（全部保留，不折叠）' : `，保留 skill_id ${args.multiSkill === 'min' ? '最小' : '最大'}者作为主知识点`}`, multiSkillCollapsed)

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
  // 短序列删除前的口径（描述性统计用）：删除短序列只服务 walk-forward 任务定义，
  // 会改变样本组成（单次交互学生被排除、正确率/学生分布可能变化），因此两组统计都保留
  const studentsBeforeShort = new Set(sampled.map((r) => r.userId))
  const kpsBeforeShort = new Set(sampled.map((r) => r.kpCode))
  const questionsBeforeShort = new Set(sampled.map((r) => r.questionId))
  const correctBeforeShort = sampled.filter((r) => r.isCorrect).length
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
      duplicate: `仅当 order_id 非空时按 (user_id, order_id, skill_id) 去重：同键后续行只在 problem_id/correct/ms_first_response 完全一致时判定为「重复写入」，保留原始文件中首次出现的记录（不比较 opportunity 数值、不保证保留最小 opportunity；同组记录除 opportunity/opportunity_original 外字段完全一致且这两列不进入输出，保留哪一行不影响结果）。实测出现重复写入的键 ${duplicateMultiKeys} 组，其中首次出现即最小 opportunity 的 ${duplicateMultiKeys - duplicateFirstNotMinOpp} 组。存在差异的行保留并单独计数（duplicate-conflict：${duplicateConflicts} 条）。order_id 为空的记录不参与去重、全部保留（empty-order-id：${emptyOrderIdRows} 条）`,
      multiSkill: `同一 order_id 关联多个知识点时按固定策略 --multi-skill ${args.multiSkill} 处理（${args.multiSkill === 'multi' ? '全部保留，同一作答在多个知识点序列各计一次' : `保留 skill_id 数值${args.multiSkill === 'min' ? '最小' : '最大'}者作为主知识点`}）。注意：skill_id 数值大小不代表教学上的主知识点，该规则仅用于构造单知识点预测任务；策略切换必须重跑并做敏感性分析`,
      shortSequence: `每个 (学生, 知识点) 序列至少 ${args.minInteractions} 次交互，否则无法定义「预测下一次」任务。注意：短序列删除只针对 walk-forward 预测实验；描述性统计应使用未删除短序列的口径（见 stats.statsBeforeShortSequence）`,
      costTime: 'ms_first_response 毫秒转秒后取整；缺失或非正值记为 0（速度条件视为不满足）',
      timeModel: {
        type: 'relative-sequence-index',
        description: `数据集无真实答题时间戳（order_id 非时序），因此用「学生内交互序号」构造相对时间轴：createdAt = ${new Date(BASE_EPOCH_MS).toISOString()} + 序号 × ${STEP_MS / 1000}s。序列顺序取原始文件中同一学生记录的出现顺序（不按 order_id 排序），仅用于构造可复现的相对顺序，不代表真实答题时间，也不是真实日期`,
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
      studentsBeforeShortSequence: studentsBeforeShort.size,
      studentsAfterShortSequence: students.size,
      shortSequenceNote: '删除短序列会改变样本组成（单次交互学生被排除、正确率与学生分布可能变化）；walk-forward 实验用本层统计，描述性统计用 statsBeforeShortSequence',
      statsBeforeShortSequence: {
        students: studentsBeforeShort.size,
        knowledgePoints: kpsBeforeShort.size,
        questions: questionsBeforeShort.size,
        interactions: sampled.length,
        correctRate: Number((correctBeforeShort / sampled.length).toFixed(4))
      },
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
