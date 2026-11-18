#!/usr/bin/env node
/**
 * ingest-assistments2012.js —— ASSISTments 2012-2013 School Data with Affect 清洗入口
 *
 * 协议：assist2012-gcn-dkt-v1（见 docs/ASSISTments2012第二数据集预注册协议.md）
 *
 * 原始文件特性（2026-11-12 实测，见 data-verification 记录）：
 *   - 6,123,270 行 × 35 列；每行 = 一次作答（problem_log_id 唯一，与 problemlogid 逐行相同）
 *   - 每行最多一个 skill 标注；skill_id 与 skill 名为 1:1（同一 id 不会对应多个 name）
 *   - ~57% 的行没有 skill 标注；~0.009% 的行 correct 为小数（部分得分），非二值
 *   - actions 列含引号包裹的换行，按行读取会被打断 → 必须用带引号状态的流式 CSV 解析
 *
 * 冻结规则（不得按模型性能调整）：
 *   1. attemptId = 原始 problem_log_id（a12-a<problem_log_id>）。脚本启动时断言其唯一性，
 *      不唯一即报错停止——这样「一次作答多 skill 标注」不会被静默拆成多次作答。
 *   2. kpCode = a12-s<原始 skill_id>。要求 skill_id 非空（skill 名可为空，名称表从同时具备
 *      名称的行回填）；skill 名为空的 id 保留但在 manifest 中单列。
 *   3. correct 只接受 "0"/"1"；小数（部分得分）等一律剔除并计数——不做阈值二值化。
 *   4. 排序按 (studentId, startTime, problem_log_id) 稳定升序；startTime 缺失/不可解析即剔除。
 *   5. (学生, 知识点) 序列交互数 < minInteractions(默认 2) 的整组剔除（首条无历史，无法预测）。
 *   6. 原始数据与逐人记录不提交公开仓库，只提交 manifest 与聚合统计。
 *
 * 用法：
 *   node scripts/ingest-assistments2012.js \
 *     --input backend/datasets/raw/2012-2013-data-with-predictions-4-final.csv \
 *     --out   backend/datasets/assist2012
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { CsvStream, readHeader, parseHeaderLine, parseTimeMs } = require('./lib/csvStream');

const PROTOCOL_VERSION = 'assist2012-gcn-dkt-v1';
const BASE_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0);
const STEP_MS = 60 * 1000;

const COLUMN_CANDIDATES = {
  studentId: ['userid', 'studentid', 'student'],
  problemId: ['problemid', 'problem', 'itemid'],
  skillId: ['skillid', 'skill'],
  skillName: ['skill', 'skillname'],
  correct: ['correct', 'iscorrect'],
  startTime: ['starttime', 'timestamp', 'start'],
  msFirstResponse: ['msfirstresponse', 'msfirstresponse'],
  attemptId: ['problemlogid', 'problemlog_id', 'attemptid', 'row']
};

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const has = (name) => argv.includes(`--${name}`);
  return {
    input: get('input', path.join('backend', 'datasets', 'raw',
      '2012-2013-data-with-predictions-4-final.csv')),
    out: get('out', path.join('backend', 'datasets', 'assist2012')),
    minInteractions: Number(get('min-interactions', 2)),
    quiet: has('quiet')
  };
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1 << 22);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim();
  } catch (err) {
    return null;
  }
}

const normHeader = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function detectColumns(header) {
  const normalized = header.map(normHeader);
  const picked = {};
  const report = {};
  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    const hits = [];
    for (const cand of candidates) {
      const idx = normalized.indexOf(cand);
      if (idx >= 0) hits.push(idx);
    }
    const uniq = [...new Set(hits)];
    if (uniq.length > 1) {
      // skillId / skillName 共享候选，按语义挑：skill_id 优先；其余字段不允许歧义
      if (field === 'skillId') {
        const idIdx = normalized.indexOf('skillid');
        if (idIdx >= 0) { picked[field] = idIdx; report[field] = { rawName: header[idIdx], index: idIdx }; continue; }
      }
      if (field === 'skillName') {
        const nameIdx = normalized.indexOf('skill');
        if (nameIdx >= 0) { picked[field] = nameIdx; report[field] = { rawName: header[nameIdx], index: nameIdx }; continue; }
      }
      throw new Error(`列探测不唯一：${field} 命中 ${uniq.map((i) => `${header[i]}@${i}`).join(' / ')}`);
    }
    if (uniq.length === 1) {
      picked[field] = uniq[0];
      report[field] = { rawName: header[uniq[0]], index: uniq[0] };
    } else {
      report[field] = null;
    }
  }
  return { picked, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`输入文件不存在：${inputPath}`);
    process.exit(1);
  }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const rawBytes = fs.statSync(inputPath).size;
  console.log(`原始文件 ${(rawBytes / 1e9).toFixed(2)}GB，计算 SHA-256…`);
  const rawSha256 = sha256File(inputPath);

  // ---------- 第一遍：表头探测 + 全量统计 + attemptId 唯一性断言 + 组计数 ----------
  let header = null;
  let picked = null;
  let colReport = null;
  let wantedIdx = null;

  let rawRows = 0;
  let validRows = 0;
  let malformedRows = 0;
  let missingStudent = 0;
  let missingProblem = 0;
  let missingSkillId = 0;
  let missingTime = 0;
  let invalidCorrect = 0;

  const studentSet = new Set();
  const questionSet = new Set();
  const skillSet = new Set();
  const skillNames = new Map();       // skillId -> name
  const attemptSeen = new Set();      // problem_log_id 唯一性
  let duplicateAttempts = 0;
  const groupCount = new Map();       // studentId|skillId -> 交互数

  let orderViolations = 0;
  let prevKey = '';
  let skillNameMissingRows = 0;

  let recordNo = 0;

  // 先读表头确定列，再重建 want 集合
  const headerCells = readHeader(inputPath);
  const det = detectColumns(headerCells);
  picked = det.picked;
  colReport = det.report;
  for (const required of ['studentId', 'problemId', 'skillId', 'correct', 'startTime', 'attemptId']) {
    if (picked[required] === undefined) {
      throw new Error(`必需列探测失败：${required}（表头：${headerCells.slice(0, 10).join(', ')}…）`);
    }
  }
  wantedIdx = new Set(Object.values(picked));
  const slot = {};
  {
    let s = 0;
    const ordered = [...wantedIdx].sort((a, b) => a - b);
    for (const idx of ordered) slot[idx] = s++;
  }
  const get = (rec, field) => rec[slot[picked[field]]];

  console.log('第一遍：统计 + attemptId 唯一性检查…');
  {
    const csv = new CsvStream(inputPath, wantedIdx);
    for await (const rec of csv.records()) {
      recordNo++;
      if (recordNo === 1) continue;   // 表头
      if (rec.length === 0) continue; // 末尾空行
      if (rec.length !== wantedIdx.size) { malformedRows++; continue; }
      rawRows++;
      const studentRaw = String(get(rec, 'studentId') || '').trim();
      const problemRaw = String(get(rec, 'problemId') || '').trim();
      const skillRaw = String(get(rec, 'skillId') || '').trim();
      const skillNameRaw = picked.skillName !== undefined ? String(get(rec, 'skillName') || '').trim() : '';
      const correctRaw = String(get(rec, 'correct') || '').trim();
      const timeRaw = get(rec, 'startTime');
      const attemptRaw = String(get(rec, 'attemptId') || '').trim();

      if (!studentRaw) { missingStudent++; continue; }
      if (!problemRaw) { missingProblem++; continue; }
      if (!skillRaw) { missingSkillId++; continue; }
      if (correctRaw !== '0' && correctRaw !== '1') { invalidCorrect++; continue; }
      const ts = parseTimeMs(timeRaw);
      if (ts === null) { missingTime++; continue; }
      if (!attemptRaw) { missingStudent++; continue; }

      validRows++;
      if (attemptSeen.has(Number(attemptRaw))) duplicateAttempts++; else attemptSeen.add(Number(attemptRaw));

      const studentId = `a12-u${studentRaw}`;
      const questionId = `a12-p${problemRaw}`;
      const kpCode = `a12-s${skillRaw}`;
      studentSet.add(studentId);
      questionSet.add(questionId);
      skillSet.add(kpCode);
      if (skillNameRaw) { if (!skillNames.has(kpCode)) skillNames.set(kpCode, skillNameRaw); }
      else skillNameMissingRows++;

      const gk = `${studentId}|${kpCode}`;
      groupCount.set(gk, (groupCount.get(gk) || 0) + 1);

      const key = `${studentId}|${String(ts).padStart(15, '0')}|${attemptRaw.padStart(12, '0')}`;
      if (prevKey && key < prevKey) orderViolations++;
      prevKey = key;

      if (rawRows % 1000000 === 0) console.log(`  ${(rawRows / 1e6).toFixed(0)}M 行…`);
    }
  }
  if (duplicateAttempts > 0) {
    throw new Error(`problem_log_id 不唯一（${duplicateAttempts} 条重复）：按本协议 attemptId 必须唯一标识一次作答，停止。`);
  }
  console.log(`  有效行 ${rawRows}，attemptId 唯一 ✓，学生 ${studentSet.size}，题目 ${questionSet.size}，知识点 ${skillSet.size}`);

  const keptGroups = new Set([...groupCount.entries()].filter(([, n]) => n >= args.minInteractions).map(([k]) => k));

  // ---------- 第二遍：收集保留行并按 (学生, 时间, attemptId) 排序 ----------
  console.log('第二遍：收集与排序…');
  const uIdx = new Map(); const qIdx = new Map(); const kIdx = new Map();
  const us = []; const qs = []; const ks = []; const cs = []; const ts = []; const ais = []; const costs = [];
  {
    const csv = new CsvStream(inputPath, wantedIdx);
    let first = true;
    for await (const rec of csv.records()) {
      if (first) { first = false; continue; }
      if (rec.length !== wantedIdx.size) continue;
      const studentRaw = String(get(rec, 'studentId') || '').trim();
      const problemRaw = String(get(rec, 'problemId') || '').trim();
      const skillRaw = String(get(rec, 'skillId') || '').trim();
      const correctRaw = String(get(rec, 'correct') || '').trim();
      const attemptRaw = String(get(rec, 'attemptId') || '').trim();
      if (!studentRaw || !problemRaw || !skillRaw || !attemptRaw) continue;
      if (correctRaw !== '0' && correctRaw !== '1') continue;
      const t = parseTimeMs(get(rec, 'startTime'));
      if (t === null) continue;

      const studentId = `a12-u${studentRaw}`;
      const kpCode = `a12-s${skillRaw}`;
      if (!keptGroups.has(`${studentId}|${kpCode}`)) continue;

      if (!uIdx.has(studentId)) uIdx.set(studentId, uIdx.size);
      const questionId = `a12-p${problemRaw}`;
      if (!qIdx.has(questionId)) qIdx.set(questionId, qIdx.size);
      if (!kIdx.has(kpCode)) kIdx.set(kpCode, kIdx.size);
      const ms = picked.msFirstResponse !== undefined
        ? Number(String(get(rec, 'msFirstResponse') || '').trim()) : NaN;
      us.push(uIdx.get(studentId));
      qs.push(qIdx.get(questionId));
      ks.push(kIdx.get(kpCode));
      cs.push(correctRaw === '1' ? 1 : 0);
      ts.push(t);
      ais.push(Number(attemptRaw));
      costs.push(Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0);
    }
  }

  const n = us.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const orderArr = Array.from(order);
  orderArr.sort((a, b) => (us[a] - us[b]) || (ts[a] - ts[b]) || (ais[a] - ais[b]));

  const userList = [...uIdx.keys()].sort();
  const questionList = [...qIdx.keys()].sort();
  const skillList = [...kIdx.keys()].sort();

  // ---------- 写出 ----------
  const outCsv = path.join(outDir, 'interactions.csv');
  const out = fs.createWriteStream(outCsv, { encoding: 'utf8' });
  out.write('userId,questionId,kpCode,isCorrect,costTime,createdAt,sequenceIndex,attemptId\n');
  const stepOf = new Map();
  let correctSum = 0;
  let seqCount = 0;
  let prevUser = -1;
  for (let i = 0; i < n; i++) {
    const r = orderArr[i];
    const u = us[r];
    const step = (stepOf.get(u) || 0) + 1;
    stepOf.set(u, step);
    if (u !== prevUser) { seqCount++; prevUser = u; }
    correctSum += cs[r];
    out.write([
      userList[u],
      questionList[qs[r]],
      skillList[ks[r]],
      cs[r],
      costs[r],
      new Date(BASE_EPOCH_MS + step * STEP_MS).toISOString(),
      step,
      `a12-a${ais[r]}`
    ].join(',') + '\n');
  }
  await new Promise((res) => out.end(res));

  const outBytes = fs.statSync(outCsv).size;
  const outSha = sha256File(outCsv);

  const manifest = {
    dataset: {
      name: 'ASSISTments 2012-2013 School Data with Affect',
      protocolVersion: PROTOCOL_VERSION,
      officialPage: 'https://sites.google.com/site/assistmentsdata/home/2012-13-school-data-with-affect',
      downloadUrl: 'https://drive.usercontent.google.com/download?id=1cU6Ft4R3hLqA7G1rIGArVfelSZvc6RxY&export=download&confirm=t',
      archiveFile: '2012-2013-data-with-predictions-4-final.zip',
      archiveBytes: 576365408,
      archiveSha256: 'sha256:7bb18f932f97e63c2eb34bb869c44cd4f46f4adec4d7fe02298578dbba572445',
      archiveEntryCrc32: '0x8f51cc70',
      license: 'WPI/ASSISTments 数据使用条款：仅限学术研究；不得再分发原始数据；发表须致谢 ASSISTments 团队并公开所用算法。本仓库不提交原始数据与逐人记录。',
      licenseCheckedAt: '2026-11-12',
      note: '原始文件不提交仓库；逐人记录同样不提交，只提交聚合统计'
    },
    source: {
      rawFile: path.basename(inputPath),
      rawBytes,
      rawSha256: 'sha256:' + rawSha256,
      rawColumns: headerCells,
      detectedColumns: colReport,
      rowCountInRaw: rawRows
    },
    output: {
      file: path.relative(path.join(__dirname, '..'), outCsv).split(path.sep).join('/'),
      sha256: 'sha256:' + outSha,
      bytes: outBytes,
      rowCount: n,
      columns: ['userId', 'questionId', 'kpCode', 'isCorrect', 'costTime', 'createdAt', 'sequenceIndex', 'attemptId']
    },
    cleaning: (() => {
      // removed 逐级递减，remaining 为「本步之后剩余」，保证 removed 之和 + 最终条数 = 原始行数
      const steps = [
        { step: 'read', description: '读取数据行数（不含表头）', removed: 0 },
        { step: 'malformed', description: '删除列数与目标列不一致的行', removed: malformedRows },
        { step: 'missing-student', description: '删除缺少 user_id / problem_log_id 的行', removed: missingStudent },
        { step: 'missing-problem', description: '删除缺少 problem_id 的行', removed: missingProblem },
        { step: 'missing-skill', description: '删除缺少 skill_id 的行（无知识点标注，无法定位输出端口）', removed: missingSkillId },
        { step: 'invalid-correct', description: '删除 correct 非 "0"/"1" 的行（含部分得分小数，不做阈值二值化）', removed: invalidCorrect },
        { step: 'missing-time', description: '删除 start_time 缺失或不可解析的行（排序依赖时间）', removed: missingTime },
        { step: 'short-sequence', description: `删除交互数 < ${args.minInteractions} 的 (学生,知识点) 序列（首条无历史，无法预测下一次）`, removed: validRows - n }
      ];
      let remaining = recordNo - 1;
      for (const s of steps) {
        if (s.step !== 'read') remaining -= s.removed;
        s.remaining = remaining;
      }
      return steps;
    })(),
    rules: {
      attempt: 'attemptId = problem_log_id（实测与 problemlogid 逐行相同且全局唯一）。脚本断言唯一性，不唯一即停止，避免把一次作答的多条 skill 标注拆成多次作答',
      primarySkill: '不适用：实测每个 problem_log_id 只有一行、每行至多一个 skill_id，不存在「同一作答多 skill」需要折叠的情形（见 stats.attemptsWithMultipleSkills）',
      correct: '仅接受字面 "0"/"1"；小数（0.25/0.5/0.75 等部分得分）一律剔除并计数',
      ordering: '按 (studentId, start_time, problem_log_id) 稳定升序；orderViolations 记录原始文件非升序的次数',
      timeModel: `createdAt = ${new Date(BASE_EPOCH_MS).toISOString()} + 学生内交互序号 × ${STEP_MS / 1000}s（仅用于构造可复现的相对顺序；原始 start_time 见源文件）`,
      ids: {
        userId: 'a12-u<原始 user_id>',
        questionId: 'a12-p<原始 problem_id>',
        kpCode: 'a12-s<原始 skill_id>',
        attemptId: 'a12-a<原始 problem_log_id>'
      },
      minInteractions: args.minInteractions
    },
    stats: {
      students: new Set(us).size,
      questions: new Set(qs).size,
      knowledgePoints: new Set(ks).size,
      interactions: n,
      skillSequenceCount: keptGroups.size,
      predictors: n - keptGroups.size,
      predictorDefinition: '可预测目标数 = 交互数 − (学生,知识点) 序列数（每条序列首条无历史）',
      correctRate: Number((correctSum / Math.max(n, 1)).toFixed(4)),
      attemptsWithMultipleSkills: 0,
      attemptsWithMultipleSkillsNote: '由 attemptId 唯一性断言推出：problem_log_id 全局唯一 → 一行即一次作答 → 不可能出现同一次作答的多条 skill 标注',
      rawRowsTotal: recordNo - 1,
      rowsWithSkillId: rawRows - missingSkillId,
      rowsWithSkillIdRatio: Number(((rawRows - missingSkillId) / Math.max(recordNo - 1, 1)).toFixed(6)),
      rowsPassingAllFilters: validRows,
      skillIdsWithoutName: skillSet.size - skillNames.size,
      rowsMissingSkillName: skillNameMissingRows,
      orderViolations,
      rawFileGloballyOrdered: orderViolations === 0
    },
    reproducibility: {
      script: 'scripts/ingest-assistments2012.js',
      scriptSha256: 'sha256:' + sha256File(__filename),
      gitCommit: gitCommit(),
      generatedAt: new Date().toISOString(),
      node: process.version,
      args
    }
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'skill-names.json'),
    JSON.stringify(Object.fromEntries([...skillNames.entries()].sort()), null, 2), 'utf8');

  if (!args.quiet) {
    console.log('\n== ASSISTments 2012 清洗完成 ==');
    console.log(`原始 ${(rawBytes / 1e9).toFixed(2)}GB / ${recordNo - 1} 行 → 交互 ${n} 条`);
    for (const s of manifest.cleaning) console.log(`  ${s.step.padEnd(18)} -${s.removed}`);
    console.log(`学生 ${manifest.stats.students} / 题目 ${manifest.stats.questions} / 知识点 ${manifest.stats.knowledgePoints}`);
    console.log(`正确率 ${manifest.stats.correctRate}，(学生,知识点) 序列 ${keptGroups.size}，可预测 ${n - keptGroups.size}`);
    console.log(`排序违例 ${orderViolations}`);
    console.log(`输出 ${outCsv} sha256 ${outSha.slice(0, 16)}…`);
  }
  console.log(JSON.stringify({
    outputFile: outCsv,
    manifest: path.join(outDir, 'manifest.json'),
    stats: manifest.stats
  }));
}

main().catch((err) => { console.error(err); process.exit(1); });
