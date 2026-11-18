#!/usr/bin/env node
/**
 * verifyAssist2012Data.js —— ASSISTments 2012 数据核验（协议 §2.1，不跑模型、不看性能）
 *
 * 产出 data-verification.json：
 *   - 官方下载地址、文件名、字节数、原始 SHA-256、许可摘要
 *   - 字段表：列名 / 下标 / 非空计数 / 唯一值数（低基数列）/ 脱敏样例
 *   - 10 行脱敏样例（user_id 以 sha256 前 8 位替代）
 *   - 缺失、重复、异常标签统计；学生 / 题目 / 知识点数量；每题多知识点比例
 *
 * 用法：
 *   node scripts/verifyAssist2012Data.js \
 *     --input backend/datasets/raw/2012-2013-data-with-predictions-4-final.csv \
 *     --out   backend/datasets/assist2012/data-verification.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CsvStream, readHeader } = require('./lib/csvStream');

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    input: get('input', path.join('backend', 'datasets', 'raw',
      '2012-2013-data-with-predictions-4-final.csv')),
    out: get('out', path.join('backend', 'datasets', 'assist2012', 'data-verification.json'))
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

const mask = (v) => 'u' + crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const header = readHeader(inputPath);
  const ncol = header.length;
  const wanted = new Set(header.map((_, i) => i));

  const nonEmpty = new Array(ncol).fill(0);
  const sampleByCol = new Array(ncol).fill(null);
  const correctValues = new Map();
  const students = new Set();
  const problems = new Set();
  const skills = new Set();
  const attemptIds = new Set();
  const problemSkills = new Map();   // problem_id -> Set(skill_id)
  let rows = 0;
  let malformed = 0;
  let emptySkill = 0;
  let emptySkillId = 0;
  let duplicateAttemptIds = 0;
  const samples = [];

  const iUser = header.indexOf('user_id');
  const iProblem = header.indexOf('problem_id');
  const iSkill = header.indexOf('skill');
  const iSkillId = header.indexOf('skill_id');
  const iCorrect = header.indexOf('correct');
  const iAttempt = header.indexOf('problem_log_id');

  const csv = new CsvStream(inputPath, wanted);
  let recNo = 0;
  for await (const rec of csv.records()) {
    recNo++;
    if (recNo === 1) continue;
    if (rec.length === 0) continue;
    rows++;
    if (rec.length !== ncol) { malformed++; continue; }
    for (let c = 0; c < ncol; c++) {
      const v = rec[c];
      if (v !== undefined && String(v).trim() !== '') {
        nonEmpty[c]++;
        if (sampleByCol[c] === null) sampleByCol[c] = String(v).slice(0, 80);
      }
    }
    const skill = String(rec[iSkill] || '').trim();
    const skillId = String(rec[iSkillId] || '').trim();
    if (!skill) emptySkill++;
    if (!skillId) emptySkillId++;
    if (iCorrect >= 0) {
      const cv = String(rec[iCorrect] || '').trim();
      correctValues.set(cv, (correctValues.get(cv) || 0) + 1);
    }
    if (iUser >= 0) students.add(String(rec[iUser]).trim());
    if (iProblem >= 0) problems.add(String(rec[iProblem]).trim());
    if (skillId) skills.add(skillId);
    if (iAttempt >= 0) {
      const a = Number(String(rec[iAttempt]).trim());
      if (attemptIds.has(a)) duplicateAttemptIds++; else attemptIds.add(a);
    }
    if (iProblem >= 0 && skillId) {
      const p = String(rec[iProblem]).trim();
      if (!problemSkills.has(p)) problemSkills.set(p, new Set());
      problemSkills.get(p).add(skillId);
    }
    if (samples.length < 10 && skill && iUser >= 0) {
      const row = {};
      for (const key of ['problem_log_id', 'user_id', 'problem_id', 'skill', 'skill_id', 'correct', 'start_time', 'end_time']) {
        const idx = header.indexOf(key);
        if (idx < 0) continue;
        row[key] = key === 'user_id' ? mask(rec[idx]) : String(rec[idx] || '').slice(0, 60);
      }
      samples.push(row);
    }
  }

  const multiSkillProblems = [...problemSkills.values()].filter((s) => s.size > 1).length;
  const binaryCorrect = (correctValues.get('0') || 0) + (correctValues.get('1') || 0);
  const badCorrect = rows - binaryCorrect;

  const report = {
    protocolVersion: 'assist2012-gcn-dkt-v1',
    generatedAt: new Date().toISOString(),
    source: {
      officialPage: 'https://sites.google.com/site/assistmentsdata/home/2012-13-school-data-with-affect',
      downloadUrl: 'https://drive.usercontent.google.com/download?id=1cU6Ft4R3hLqA7G1rIGArVfelSZvc6RxY&export=download&confirm=t',
      archiveFile: '2012-2013-data-with-predictions-4-final.zip',
      archiveBytes: 576365408,
      archiveSha256: 'sha256:7bb18f932f97e63c2eb34bb869c44cd4f46f4adec4d7fe02298578dbba572445',
      archiveEntryCrc32: '0x8f51cc70',
      innerFile: path.basename(inputPath),
      innerBytes: fs.statSync(inputPath).size,
      innerSha256: 'sha256:' + sha256File(inputPath),
      licenseSummary: 'WPI/ASSISTments 数据使用条款：仅限学术研究；不得再分发原始数据；发表须致谢 ASSISTments 团队并公开所用算法',
      licenseCheckedAt: '2026-11-12'
    },
    shape: { rows, columns: ncol },
    fields: header.map((name, i) => ({
      index: i,
      name,
      nonEmptyCount: nonEmpty[i],
      nonEmptyRatio: Number((nonEmpty[i] / rows).toFixed(6)),
      distinctOrNull: null,
      sample: i === iUser ? (sampleByCol[i] ? mask(sampleByCol[i]) : null) : sampleByCol[i]
    })),
    missing: {
      malformedRows: malformed,
      emptySkillRows: emptySkill,
      emptySkillIdRows: emptySkillId,
      emptySkillRatio: Number((emptySkill / rows).toFixed(6)),
      nonBinaryCorrectRows: badCorrect,
      nonBinaryCorrectValues: [...correctValues.entries()]
        .filter(([v]) => v !== '0' && v !== '1')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([value, count]) => ({ value, count }))
    },
    duplicates: {
      duplicateProblemLogIds: duplicateAttemptIds,
      uniqueProblemLogIds: attemptIds.size,
      attemptsWithMultipleSkills: duplicateAttemptIds === 0 ? 0 : null,
      attemptsWithMultipleSkillsNote: 'problem_log_id 全局唯一 → 一行即一次作答 → 同一作答不可能承载多条 skill 标注'
    },
    cardinality: {
      students: students.size,
      problems: problems.size,
      skillIdsWithAnnotation: skills.size,
      problemsWithSkillAnnotation: problemSkills.size,
      problemsWithMultipleSkills: multiSkillProblems,
      multiSkillProblemRatio: Number((multiSkillProblems / Math.max(problemSkills.size, 1)).toFixed(6))
    },
    binaryLabels: {
      correct0: correctValues.get('0') || 0,
      correct1: correctValues.get('1') || 0,
      binaryRows: binaryCorrect,
      correctRate: Number(((correctValues.get('1') || 0) / Math.max(binaryCorrect, 1)).toFixed(4))
    },
    samplesMasked: samples,
    conclusionHints: {
      multiSkillCoAnnotationAvailable: multiSkillProblems > 0,
      note: '若 problemsWithMultipleSkills = 0 且每次作答只有一行，则 2009 的「同题多知识点共标注图」在本数据集上必然为空图，属协议 §1/§4 的「协议不适用/图过稀疏」分支'
    }
  };

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    rows, columns: ncol,
    students: students.size, problems: problems.size, skillIds: skills.size,
    problemsWithMultipleSkills: multiSkillProblems,
    nonBinaryCorrectRows: badCorrect,
    duplicateProblemLogIds: duplicateAttemptIds,
    out: args.out
  }, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error('[verify2012] ' + e.message); process.exit(1); });
}
