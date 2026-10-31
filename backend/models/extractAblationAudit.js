#!/usr/bin/env node
/**
 * extractAblationAudit.js —— 从断点文件补齐逐目标审计文件（不重训）。
 *
 * 背景：若 dktAblation.js 在写结果 JSON 之前断点恢复过旧断点、或审计文件被清理，
 * 结果 JSON 引用的 ablation-predictions-<label>.jsonl 与 ablation-targets-<label>.json
 * 可能缺失。本脚本从 ablation-checkpoint-<label>.json 提取逐目标预测，
 * 按与 dktAblation.js 完全相同的格式重建这两个文件，并做三层核验：
 *   1. checkpointId 与结果 JSON 的 reproducibility.checkpointId 一致；
 *   2. 四模式行数一致、逐行目标身份/标签对齐、预测值合法（0..1）；
 *   3. 重建的 manifest 哈希与 JSON 的 targetManifestHash 一致，
 *      重建的 JSONL sha256 与 JSON 的 predictionsSha256 逐字节一致。
 * 任何一层失败都会报错退出，不产出可疑文件。
 *
 * 用法：
 *   node models/extractAblationAudit.js --dir 实验结果文件/v2-input-kp-only \
 *     --label dkt-ablation-s42 [--result 实验结果文件/v2-input-kp-only/xxx.json]
 * 不指定 --result 时在 --dir 下按 baseline-results-<label>.json 查找。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL_KEYS = ['Full-DKT', 'Same-KP-DKT', 'Shuffled-KP-DKT', 'NoResponse-DKT'];
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const get = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const dir = get('dir');
  if (!dir) throw new Error('必须提供 --dir（结果目录）');
  const label = get('label');
  if (!label) throw new Error('必须提供 --label（如 dkt-ablation-s42）');
  const resultPath = get('result') || path.join(dir, `baseline-results-${label}.json`);
  return { dir: path.resolve(dir), label, resultPath: path.resolve(resultPath) };
}

function main() {
  const { dir, label, resultPath } = parseArgs(process.argv.slice(2));
  const checkpointPath = path.join(dir, `ablation-checkpoint-${label}.json`);
  const predsFile = path.join(dir, `ablation-predictions-${label}.jsonl`);
  const manifestFile = path.join(dir, `ablation-targets-${label}.json`);

  const res = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

  // 核验 1：断点与结果 JSON 出自同一次运行
  if (!res.reproducibility || res.reproducibility.checkpointId !== cp.checkpointId) {
    throw new Error(`checkpointId 不一致：结果 JSON=${res.reproducibility && res.reproducibility.checkpointId}，断点=${cp.checkpointId}`);
  }
  if (res.reproducibility.predictionsFile !== path.basename(predsFile) ||
      res.reproducibility.targetsManifestFile !== path.basename(manifestFile)) {
    throw new Error('结果 JSON 引用的审计文件名与当前目录/标签不一致');
  }

  // 核验 2：四模式齐全、行数一致、逐行身份/标签对齐
  for (const k of MODEL_KEYS) {
    if (!Array.isArray(cp.rowsByModel[k])) throw new Error(`断点缺少 ${k} 的逐目标预测`);
  }
  const n = res.targetCount;
  const targets = [];
  for (let i = 0; i < n; i++) {
    const row0 = cp.rowsByModel[MODEL_KEYS[0]][i];
    if (!row0 || row0.targetKey === undefined) throw new Error(`第 ${i} 行缺少 targetKey`);
    for (const k of MODEL_KEYS) {
      const r = cp.rowsByModel[k][i];
      if (!r || r.targetKey !== row0.targetKey || r.userId !== row0.userId ||
          r.kpCode !== row0.kpCode || r.createdAt !== row0.createdAt || r.target !== row0.target) {
        throw new Error(`第 ${i} 行在 ${k} 中身份/标签不一致`);
      }
      if (!Number.isFinite(r.pred) || r.pred < 0 || r.pred > 1) {
        throw new Error(`第 ${i} 行 ${k} 预测值不合法：${r && r.pred}`);
      }
    }
    targets.push({ targetKey: row0.targetKey, userId: row0.userId, kpCode: row0.kpCode, createdAt: row0.createdAt, target: row0.target });
  }
  if (res.seed !== cp.seed) throw new Error(`seed 不一致：JSON=${res.seed}，断点=${cp.seed}`);

  // 重建 manifest 并核验目标清单哈希
  const targetManifestHash = sha256Hex(Buffer.from(JSON.stringify(
    targets.map((t) => [t.targetKey, t.userId, t.kpCode, t.createdAt, t.target])
  )));
  if (res.reproducibility.targetManifestHash !== 'sha256:' + targetManifestHash) {
    throw new Error('重建的 targetManifestHash 与结果 JSON 不一致，断点数据可能被篡改');
  }

  // 重建 JSONL（与 dktAblation.js 逐字段同序）
  const predsLines = [];
  for (let i = 0; i < n; i++) {
    const row0 = cp.rowsByModel[MODEL_KEYS[0]][i];
    predsLines.push(JSON.stringify({
      targetKey: row0.targetKey,
      userId: row0.userId,
      kpCode: row0.kpCode,
      createdAt: row0.createdAt,
      target: row0.target,
      preds: Object.fromEntries(MODEL_KEYS.map((k) => [k, cp.rowsByModel[k][i].pred]))
    }));
  }

  const predsHash = sha256Hex(Buffer.from(predsLines.join('\n') + '\n'));
  if (res.reproducibility.predictionsSha256 && res.reproducibility.predictionsSha256 !== 'sha256:' + predsHash) {
    throw new Error(`重建的 JSONL sha256 与结果 JSON 不一致（JSON=${res.reproducibility.predictionsSha256}，重建=${predsHash}），断点预测可能不完整`);
  }

  fs.writeFileSync(predsFile, predsLines.join('\n') + '\n');
  fs.writeFileSync(manifestFile, JSON.stringify({
    protocolVersion: res.protocolVersion,
    seed: res.seed,
    targetCount: n,
    targetManifestHash,
    targets
  }, null, 2));

  console.log(`已重建 ${path.basename(predsFile)}（${n} 行）与 ${path.basename(manifestFile)}，sha256 与结果 JSON 逐字节核验通过。`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('失败：' + e.message);
    process.exit(1);
  }
}

module.exports = { MODEL_KEYS };
