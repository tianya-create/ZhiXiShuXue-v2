#!/usr/bin/env node
/**
 * buildAssist2012ValTargets.js —— 为图覆盖率预检生成「validation 目标身份」清单
 *
 * 为什么需要单独一步：2009 的构图脚本要用 --targets 计算「非孤立节点目标覆盖率」，
 * 而 2009 是冒烟训练先产出 targets.json、构图再读。2012 协议要求先构图预检、
 * 预检通过才允许训练，因此这里在训练之前、只用 validation 学生生成目标清单。
 *
 * 只导出目标身份与 kpCode，**不导出 test 目标**（协议 §2.4：预检不得看 test 标签）。
 *
 * 用法：
 *   node scripts/buildAssist2012ValTargets.js \
 *     --interactions backend/datasets/assist2012/interactions.csv \
 *     --graphs-root  backend/实验结果文件/assist2012-gcn-dkt-v1 \
 *     --seeds 42,43,44,45,46
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadDkt() {
  const candidates = [
    path.join(__dirname, '..', 'models', 'dkt.js'),
    path.join(__dirname, '..', 'model', 'dkt.js')
  ];
  for (const p of candidates) {
    try { return require(p); } catch (e) { /* 下一个 */ }
  }
  throw new Error('找不到 dkt.js');
}

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    interactions: get('interactions', path.join('backend', 'datasets', 'assist2012', 'interactions.csv')),
    graphsRoot: get('graphs-root', path.join('backend', '实验结果文件', 'assist2012-gcn-dkt-v1')),
    seeds: get('seeds', '42,43,44,45,46').split(',').map(Number)
  };
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function buildTargets(sequences, studentSet) {
  const targets = [];
  for (const seq of sequences) {
    if (!studentSet.has(seq.userId)) continue;
    const firstTs = new Map();
    for (const it of seq.items) {
      if (!firstTs.has(it.kpCode) || it.ts < firstTs.get(it.kpCode)) firstTs.set(it.kpCode, it.ts);
    }
    for (const it of seq.items) {
      if (it.ts <= firstTs.get(it.kpCode)) continue;
      targets.push({
        targetKey: `${seq.userId}|${it.ts}`,
        userId: seq.userId,
        kpCode: it.kpCode,
        createdAt: it.record.createdAt,
        target: it.correct
      });
    }
  }
  return targets;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dkt = loadDkt();
  const interPath = path.resolve(args.interactions);
  const lines = fs.readFileSync(interPath, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  const records = [];
  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(',');
    records.push({
      userId: c[ix.userId], questionId: c[ix.questionId], kpCode: c[ix.kpCode],
      isCorrect: Number(c[ix.isCorrect]), createdAt: c[ix.createdAt]
    });
  }
  const sequences = dkt.buildStudentSequences(records);
  const userIds = sequences.map((s) => s.userId);
  const root = path.resolve(args.graphsRoot);
  console.log(`交互 ${records.length} 条，学生 ${userIds.length} 名`);

  for (const seed of args.seeds) {
    const split = dkt.splitStudents(userIds, { train: 0.7, validation: 0.15, seed });
    const valSet = new Set(split.validation);
    const targets = buildTargets(sequences, valSet);
    const targetManifestHash = 'sha256:' + sha256Hex(Buffer.from(JSON.stringify(
      targets.map((t) => [t.targetKey, t.userId, t.kpCode, t.createdAt, t.target])
    )));
    const dir = path.join(root, `seed-${seed}`);
    fs.mkdirSync(dir, { recursive: true });
    const out = {
      protocolVersion: 'assist2012-gcn-dkt-v1',
      seed,
      splitPartition: 'validation',
      targetRule: 'validation 学生中 (学生,知识点) 组非首条记录（与 graphDktExperiment.buildTargetManifest 同一规则，仅换学生集合）',
      note: '本文件只用于图覆盖率预检，不参与训练；test 目标在冻结前不生成、不读取',
      targetCount: targets.length,
      targetManifestHash,
      targets
    };
    fs.writeFileSync(path.join(dir, 'val-targets.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log(`seed=${seed} validation 目标 ${targets.length}（val 学生 ${split.validation.length}），hash ${targetManifestHash.slice(0, 20)}…`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[valTargets] ' + e.message); process.exit(1); }
}

module.exports = { buildTargets };
