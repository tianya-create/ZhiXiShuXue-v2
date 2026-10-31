/**
 * DKT 消融实验：Full / Same-KP / Shuffled-KP / NoResponse
 *
 * 目的：回答「DKT 的提升来自跨知识点历史、真实知识点顺序，还是 response 本身」。
 * 定位：消融是为了判断图结构（GCN-DKT）是否有必要；本身不引入任何新结构。
 *
 * 协议（v2 = dkt-ablation-v2-input-kp-only，与 dktEval 完全一致，四种模式在同一进程内训练）：
 *   - 学生级 70/15/15 划分，同一 --seed 控制划分 + 初始化 + dropout/洗牌随机流；
 *   - 超参完全相同（embedding 32 / GRU 64 / dropout 0.2 / lr 1e-3 / batch 64 /
 *     max 50 epoch / patience 5 / 梯度裁剪 5.0）；
 *   - 目标集：test 学生中「非 (学生,知识点) 组首条」的记录，四模式逐条对齐；
 *   - v2 关键修正：kpCode（原始知识点）只决定输出端口与目标身份，
 *     inputKpCode（历史输入知识点）只决定 GRU 输入编码——Shuffled-KP 只置换后者，
 *     目标端口保持原始知识点（v1 曾把两者混用，Shuffle 同时改变了约 81% 目标的端口）；
 *   - Same-KP 按 (学生,KP) 子序列训练/验证，监督位置与整序列模式不同（supervisionCounts 披露）；
 *   - 学生级 bootstrap（重采样单位 = test 学生，同一批权重用于四个模型），
 *     报告相对 Full-DKT 的点估计差值与配对 CI（AUC 看下界>0、LogLoss 看上界<0）。
 *
 * 输入模式（统一接口，禁止复制四套 GRU）：
 *   full          知识点 + response + 原始顺序（参照）
 *   same-kp       只保留同一 (学生,知识点) 内的历史（屏蔽其他知识点历史）
 *   shuffled-kp   学生内部打乱知识点标签（保 response 序列 / 频数 / 标签）
 *   no-response   只输入知识点（独立词表，不把缺失 response 编码成答错）
 *
 * 用法：
 *   node models/dktAblation.js --source csv \
 *     --file datasets/assist2009/interactions.csv \
 *     --seed 42 --bootstrap 2000 --label dkt-ablation-s42
 * 可选：--epochs 50 --patience 5 --hidden 64 --embed 32 --dropout 0.2
 *       --lr 1e-3 --batch 64 --train-fraction 0.7 --val-fraction 0.15 --out
 *
 * 断点续跑：每完成一个模式，立即把该模式的逐目标预测写入
 *   ablation-checkpoint-<label>.json（与结果同目录）。
 * 重新运行相同命令时，已完成的模式从 checkpoint 恢复、跳过训练；
 * checkpointId 校验（数据哈希 + seed + 目标集指纹）不匹配时自动忽略旧断点。
 * 可选 --modes full,same-kp,shuffled-kp,no-response 只训练指定模式
 *（其余模式仍需 checkpoint 或后续补跑；四模式齐后才会计算指标与 bootstrap）。
 */
const fs = require('fs');
const path = require('path');
const {
  loadFromCsv,
  loadFromDb,
  generateSyntheticRecords,
  evaluateMetrics,
  calibrationBins,
  datasetStats,
  bootstrapAllModels
} = require('./baselineEval');
const {
  DEFAULT_HYPERPARAMS,
  buildStudentSequences,
  buildVocab,
  transformSequences,
  collectPredictions,
  splitStudents,
  GruDkt
} = require('./dkt');

const MODES = [
  { key: 'Full-DKT', mode: 'full', desc: '知识点 + response + 原始顺序' },
  { key: 'Same-KP-DKT', mode: 'same-kp', desc: '仅同一 (学生,知识点) 内的历史' },
  { key: 'Shuffled-KP-DKT', mode: 'shuffled-kp', desc: '学生内部打乱知识点标签（response/频数/标签不变）' },
  { key: 'NoResponse-DKT', mode: 'no-response', desc: '只输入知识点，不输入历史对错' }
];

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    source: get('source', 'csv'),
    file: get('file', null),
    bootstrap: Number(get('bootstrap', 2000)),
    seed: Number(get('seed', DEFAULT_HYPERPARAMS.seed)),
    label: get('label', null),
    out: get('out', null),
    modes: get('modes', null),
    trainFraction: Number(get('train-fraction', 0.7)),
    valFraction: Number(get('val-fraction', 0.15)),
    hyper: {
      embedDim: Number(get('embed', DEFAULT_HYPERPARAMS.embedDim)),
      hiddenSize: Number(get('hidden', DEFAULT_HYPERPARAMS.hiddenSize)),
      dropout: Number(get('dropout', DEFAULT_HYPERPARAMS.dropout)),
      learningRate: Number(get('lr', DEFAULT_HYPERPARAMS.learningRate)),
      batchSize: Number(get('batch', DEFAULT_HYPERPARAMS.batchSize)),
      maxEpochs: Number(get('epochs', DEFAULT_HYPERPARAMS.maxEpochs)),
      earlyStoppingPatience: Number(get('patience', DEFAULT_HYPERPARAMS.earlyStoppingPatience)),
      seed: Number(get('seed', DEFAULT_HYPERPARAMS.seed))
    }
  };
}

const log = (s) => process.stdout.write(s + '\n');

function main() {
  const args = parseArgs(process.argv.slice(2));

  let records;
  let csvFile = null;
  if (args.source === 'db') {
    records = loadFromDb();
  } else if (args.source === 'csv') {
    if (!args.file) { console.error('--source csv 需要 --file <路径>'); process.exit(1); }
    csvFile = args.file;
    records = loadFromCsv(csvFile);
  } else {
    records = generateSyntheticRecords();
  }
  if (!records.length) { console.error('没有可用答题记录。'); process.exit(1); }

  const stats = datasetStats(records);
  log(`数据源: ${args.source}，答题记录 ${records.length} 条，学生 ${stats.studentCount}`);

  // ---------- 基准序列 + 划分（四模式共享） ----------
  const baseSeqs = buildStudentSequences(records, { minLen: 2 });
  const split = splitStudents(baseSeqs.map((s) => s.userId), {
    train: args.trainFraction,
    validation: args.valFraction,
    seed: args.seed
  });
  const testSet = new Set(split.test);
  log(`学生级划分（seed ${split.seed}）: train ${split.train.length} / validation ${split.validation.length} / test ${split.test.length}`);

  // ---------- 目标集：按原始 (学生,知识点) 组定义，四模式共用同一批身份 ----------
  // 规则与 dktEval 一致：组内首条记录（ts 最早）不作目标；目标身份 = userId|ts。
  const targets = [];
  for (const seq of baseSeqs) {
    if (!testSet.has(seq.userId)) continue;
    const firstTs = new Map();
    for (const it of seq.items) {
      if (!firstTs.has(it.kpCode) || it.ts < firstTs.get(it.kpCode)) firstTs.set(it.kpCode, it.ts);
    }
    for (const it of seq.items) {
      if (it.ts <= firstTs.get(it.kpCode)) continue;
      targets.push({ key: `${seq.userId}|${it.ts}`, userId: seq.userId, kpCode: it.kpCode, createdAt: it.record.createdAt, target: it.correct });
    }
  }
  const targetIds = new Set(targets.map((t) => t.key));
  log(`目标集: ${targets.length} 条（${testSet.size} 名 test 学生，四模式共用，组首条已跳过）`);
  if (targetIds.size !== targets.length) { console.error('目标身份存在重复（userId|ts 不唯一），请检查时间轴构造。'); process.exit(1); }

  // ---------- 逐模式训练 + 预测 ----------
  // 序列顺序必须与 dktEval 完全一致（按 split 的乱序 id 顺序取），
  // 否则同一 seed 下 SGD 批次组成不同，Full-DKT 复现不出 dktEval 的正式结果。
  const pickUsers = (map, ids) => {
    const out = [];
    for (const id of ids) {
      const list = map.get(id);
      if (list) out.push(...list);
    }
    return out;
  };

  // ---------- 断点续跑（checkpoint，v2）----------
  // 指纹对协议版本、数据内容、超参、完整学生划分、完整目标清单与相关源码内容敏感；
  // 旧协议或旧实现的 checkpoint 一律拒绝自动恢复，不会因为行数相同就被复用。
  // bootstrap 次数等统计配置不进训练指纹：逐目标预测通过校验后可单独重算统计。
  const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, '..', '实验结果文件');
  fs.mkdirSync(outDir, { recursive: true });
  const label = args.label ? String(args.label).replace(/[^\w.-]/g, '') : `dkt-ablation-${args.source}`;
  const checkpointFile = path.join(outDir, `ablation-checkpoint-${label}.json`);
  const crypto = require('crypto');
  const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const fingerprint = (o) => sha256Hex(Buffer.from(JSON.stringify(o)));

  const PROTOCOL_VERSION = 'dkt-ablation-v2-input-kp-only';
  const SCHEMA_VERSION = 2;

  // 数据内容哈希：csv 用整文件 sha256；db/synthetic 用记录快照的确定性序列化哈希
  const inputHashFull = csvFile
    ? sha256Hex(fs.readFileSync(path.resolve(csvFile)))
    : sha256Hex(Buffer.from(JSON.stringify(records)));
  // 完整目标清单哈希（不只头尾几条）
  const targetManifestHash = sha256Hex(Buffer.from(JSON.stringify(
    targets.map((t) => [t.key, t.userId, t.kpCode, t.createdAt, t.target])
  )));
  // 相关源码内容组合哈希（模型 / 消融脚本 / 统计实现）
  const implementationHash = sha256Hex(Buffer.from(
    ['dkt.js', 'dktAblation.js', 'baselineEval.js', 'bootstrapStats.js']
      .map((f) => sha256Hex(fs.readFileSync(path.join(__dirname, f))))
      .join('')
  ));

  const checkpointId = fingerprint({
    protocolVersion: PROTOCOL_VERSION,
    source: args.source,
    inputHash: inputHashFull,
    hyperParams: args.hyper,
    split: { seed: split.seed, train: split.train, validation: split.validation, test: split.test },
    targetManifestHash,
    implementationHash
  });

  // 恢复断点 / bootstrap 前逐行核对：目标身份、原始 KP、时间、标签与预测合法性
  function assertRowsMatchTargets(rows, modelName) {
    if (!Array.isArray(rows) || rows.length !== targets.length) {
      throw new Error(`目标数量不匹配（${Array.isArray(rows) ? rows.length : '非数组'} vs ${targets.length}）`);
    }
    for (let i = 0; i < targets.length; i++) {
      const r = rows[i];
      const t = targets[i];
      if (!r || r.targetKey !== t.key || r.userId !== t.userId || r.kpCode !== t.kpCode ||
          r.createdAt !== t.createdAt || r.target !== t.target ||
          !Number.isFinite(r.pred) || r.pred < 0 || r.pred > 1) {
        throw new Error(`第 ${i} 行目标身份、标签或预测不合法`);
      }
    }
  }

  const rowsByModel = {};
  const modelMeta = {};
  if (fs.existsSync(checkpointFile)) {
    try {
      const cp = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
      if (cp.checkpointId === checkpointId && cp.protocolVersion === PROTOCOL_VERSION) {
        for (const k of Object.keys(cp.rowsByModel || {})) {
          try {
            assertRowsMatchTargets(cp.rowsByModel[k], k);
            rowsByModel[k] = cp.rowsByModel[k];
            modelMeta[k] = cp.modelMeta[k];
          } catch (e) {
            log(`断点中 ${k} 未通过逐行校验（${e.message}），该模式将重新训练。`);
          }
        }
        log(`断点恢复（协议 ${PROTOCOL_VERSION}，checkpointId 匹配）：已完成 ${Object.keys(rowsByModel).join(', ') || '无'}`);
      } else {
        log('断点文件协议/指纹不匹配（协议版本、数据、超参、划分、目标清单或源码已变化），忽略旧断点。');
      }
    } catch (e) {
      log('断点文件损坏，忽略。');
    }
  }
  const saveCheckpoint = () => {
    const tmp = checkpointFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      checkpointId,
      seed: split.seed,
      label,
      targetCount: targets.length,
      targetManifestHash,
      savedAt: new Date().toISOString(),
      rowsByModel,
      modelMeta
    }, null, 2));
    fs.renameSync(tmp, checkpointFile);
  };

  const requestedModes = args.modes
    ? String(args.modes).split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  for (const { key, mode, desc } of MODES) {
    if (rowsByModel[key]) {
      log(`\n===== ${key}（inputMode=${mode}）: ${desc} =====`);
      log(` checkpoint 已含该模式（目标 ${rowsByModel[key].length} 条），跳过训练。`);
      continue;
    }
    if (requestedModes && !requestedModes.includes(mode) && !requestedModes.includes(key)) {
      log(`\n===== ${key}（inputMode=${mode}）: 跳过（--modes 未包含）=====`);
      continue;
    }
    log(`\n===== ${key}（inputMode=${mode}）: ${desc} =====`);
    const transformed = transformSequences(baseSeqs, mode, { shuffleSeed: args.seed });
    const vocab = buildVocab(transformed, { inputMode: mode });
    const byUser = new Map();
    for (const s of transformed) {
      if (!byUser.has(s.userId)) byUser.set(s.userId, []);
      byUser.get(s.userId).push(s);
    }
    const trainSeqs = pickUsers(byUser, split.train);
    const valSeqs = pickUsers(byUser, split.validation);
    const testSeqs = pickUsers(byUser, split.test);

    const model = new GruDkt(vocab, { ...args.hyper, inputMode: mode });
    log(` 序列: train ${trainSeqs.length} / val ${valSeqs.length} / test ${testSeqs.length}；词表 ${vocab.vocabSize}；参数量 ${model.paramCount()}`);
    const t0 = Date.now();
    const fit = model.fit(trainSeqs, valSeqs, {
      onEpoch: (c) => log(`  epoch ${c.epoch}: train ${c.trainLogLoss} / val ${c.valLogLoss}${c.stoppedEarly ? '（早停）' : ''}`)
    });
    const fitSeconds = ((Date.now() - t0) / 1000).toFixed(1);

    const preds = collectPredictions(model, testSeqs, { targetIds });
    const missing = targets.filter((t) => !preds.has(t.key));
    if (missing.length) {
      console.error(`${key}: ${missing.length} 个目标没有预测（示例 ${missing[0].key}），四模式目标集不一致，已中止。`);
      process.exit(1);
    }
    // 监督目标数：训练/验证 = 各序列 t ≥ 1 位置数（Same-KP 按 (学生,KP) 子序列计，
    // 因此与 Full/Shuffle/NoResponse 不完全相同，如实写入 supervisionCounts 披露）
    const supervision = (seqs) => seqs.reduce((s, q) => s + Math.max(0, q.items.length - 1), 0);
    rowsByModel[key] = targets.map((t) => ({
      targetKey: t.key,
      userId: t.userId,
      kpCode: t.kpCode,
      createdAt: t.createdAt,
      target: t.target,
      pred: Number(preds.get(t.key).toFixed(6))
    }));
    modelMeta[key] = {
      inputMode: mode,
      description: desc,
      vocabSize: vocab.vocabSize,
      paramCount: model.paramCount(),
      sequenceCounts: { train: trainSeqs.length, validation: valSeqs.length, test: testSeqs.length },
      supervisionCounts: {
        train: supervision(trainSeqs),
        validation: supervision(valSeqs),
        test: targets.length
      },
      training: {
        epochsRun: fit.epochsRun,
        bestEpoch: fit.bestEpoch,
        bestValLogLoss: fit.bestValLogLoss,
        stoppedEarly: fit.stoppedEarly,
        fitSeconds: Number(fitSeconds),
        curve: fit.curve
      },
      coverage: `${preds.size}/${targets.length}`
    };
    log(` → ${key}: val LogLoss ${fit.bestValLogLoss}（epoch ${fit.bestEpoch} / ${fit.epochsRun}）`);
    saveCheckpoint();
    log(` 已写入断点 ${path.basename(checkpointFile)}`);
  }

  // ---------- 完整性检查：四模式齐了才算完成 ----------
  const missingModes = MODES.filter((m) => !rowsByModel[m.key]).map((m) => m.key);
  if (missingModes.length) {
    log(`\n尚缺模式：${missingModes.join(', ')}。断点已保存，用相同命令重跑即可续训（或用 --modes 只补缺失模式）。`);
    return;
  }

  // ---------- 一致性校验（目标数 / 标签 / 身份；恢复断点后 bootstrap 前再查一遍） ----------
  const keys = Object.keys(rowsByModel);
  for (const k of keys) assertRowsMatchTargets(rowsByModel[k], k);
  const n = rowsByModel[keys[0]].length;
  for (const k of keys) {
    if (rowsByModel[k].length !== n) throw new Error(`目标数不一致: ${k} ${rowsByModel[k].length} vs ${n}`);
    for (let i = 0; i < n; i++) {
      if (rowsByModel[k][i].targetKey !== rowsByModel[keys[0]][i].targetKey ||
          rowsByModel[k][i].target !== rowsByModel[keys[0]][i].target ||
          rowsByModel[k][i].userId !== rowsByModel[keys[0]][i].userId) {
        throw new Error(`第 ${i} 行身份/标签不一致: ${k} vs ${keys[0]}`);
      }
    }
  }
  log(`\n一致性校验通过：四模式目标数均为 ${n}，逐行标签与身份完全相同。`);

  // ---------- 指标 + 学生级 bootstrap（同一批权重用于四模型） ----------
  const results = {};
  const calibration = {};
  for (const k of keys) {
    results[k] = evaluateMetrics(rowsByModel[k]);
    calibration[k] = calibrationBins(rowsByModel[k]);
  }
  const boot = bootstrapAllModels(rowsByModel, { reps: args.bootstrap, seed: args.seed });

  log('\n== 消融结果（test 学生目标集）==');
  for (const k of keys) {
    const r = results[k], ci = boot.ciByModel[k];
    log(`  ${k.padEnd(16)} AUC ${r.AUC.toFixed(4)} [${ci.AUC[0]}, ${ci.AUC[1]}]  LogLoss ${r.LogLoss.toFixed(4)} [${ci.LogLoss[0]}, ${ci.LogLoss[1]}]  Brier ${r.Brier.toFixed(4)}  Acc ${r.Accuracy.toFixed(4)}  F1 ${r.F1.toFixed(4)}`);
  }
  log('\n== 相对 Full-DKT 的配对差值（Δ 为「Full-DKT − 消融」的点估计差：ΔAUC > 0 表示 Full 更好，ΔLogLoss < 0 表示 Full 更好）==');
  const vsFull = boot.comparisons
    .filter((c) => c.a === 'Full-DKT' || c.b === 'Full-DKT')
    .map((c) => {
      const sign = c.a === 'Full-DKT' ? 1 : -1; // 统一为「Full-DKT − 消融」
      const other = c.a === 'Full-DKT' ? c.b : c.a;
      const flip = (ci) => (sign > 0 ? ci.slice() : [-ci[1], -ci[0]]);
      const dAucPoint = c.dAUC.pointDiff;
      const dLlPoint = c.dLogLoss.pointDiff;
      if (!Number.isFinite(dAucPoint) || !Number.isFinite(dLlPoint)) {
        throw new Error(`Full-DKT vs ${other}: 点估计差不可用（AUC 单类不可定义或数据异常），拒绝输出。`);
      }
      const aucCi = flip(c.dAUC.ci);
      const llCi = flip(c.dLogLoss.ci);
      if ([...aucCi, ...llCi].some((v) => !Number.isFinite(v))) {
        throw new Error(`Full-DKT vs ${other}: bootstrap CI 缺失或非有限，拒绝输出。`);
      }
      const dAUC = sign * dAucPoint;
      const dLogLoss = sign * dLlPoint;
      return {
        comparison: `Full-DKT − ${other}`,
        // Δ 为未舍入点估计差（报告口径）
        dAUC: Number(dAUC.toFixed(4)),
        dAUCCI: [Number(aucCi[0].toFixed(4)), Number(aucCi[1].toFixed(4))],
        aucExcludesZero: aucCi[0] * aucCi[1] > 0,
        aucCISupportsFull: aucCi[0] > 0, // AUC：CI 下界 > 0 才支持 Full 更好
        dAUCBootstrapMean: Number((sign * c.dAUC.bootstrapMeanDiff).toFixed(4)),
        dLogLoss: Number(dLogLoss.toFixed(4)),
        dLogLossCI: [Number(llCi[0].toFixed(4)), Number(llCi[1].toFixed(4))],
        logLossExcludesZero: llCi[0] * llCi[1] > 0,
        logLossCISupportsFull: llCi[1] < 0, // LogLoss：CI 上界 < 0 才支持 Full 更好
        dLogLossBootstrapMean: Number((sign * c.dLogLoss.bootstrapMeanDiff).toFixed(4))
      };
    });
  for (const c of vsFull) {
    log(`  ${c.comparison.padEnd(30)} ΔAUC ${c.dAUC} [${c.dAUCCI.join(', ')}] ${c.aucCISupportsFull ? '（CI 支持 Full 更好）' : c.aucExcludesZero ? '（CI 不含 0 但支持消融更好）' : '（CI 含 0）'}  ΔLogLoss ${c.dLogLoss} [${c.dLogLossCI.join(', ')}] ${c.logLossCISupportsFull ? '（CI 支持 Full 更好）' : c.logLossExcludesZero ? '（CI 不含 0 但支持消融更好）' : '（CI 含 0）'}`);
  }

  // ---------- 结果 JSON ----------
  const outFile = path.join(outDir, `baseline-results-${label}.json`);

  let gitCommit = null;
  try {
    gitCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..', '..') }).toString().trim();
  } catch (e) { /* 非 git 环境忽略 */ }

  // 逐目标预测（JSONL）+ 目标 manifest：供独立重算 CI 与审计（可能含学生标识，按数据许可保存）
  const predsFile = path.join(outDir, `ablation-predictions-${label}.jsonl`);
  const manifestFile = path.join(outDir, `ablation-targets-${label}.json`);
  const predsLines = [];
  for (let i = 0; i < n; i++) {
    const row0 = rowsByModel[keys[0]][i];
    predsLines.push(JSON.stringify({
      targetKey: row0.targetKey,
      userId: row0.userId,
      kpCode: row0.kpCode,
      createdAt: row0.createdAt,
      target: row0.target,
      preds: Object.fromEntries(keys.map((k) => [k, rowsByModel[k][i].pred]))
    }));
  }
  fs.writeFileSync(predsFile, predsLines.join('\n') + '\n');
  fs.writeFileSync(manifestFile, JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    seed: split.seed,
    targetCount: n,
    targetManifestHash,
    targets: targets.map((t) => ({ targetKey: t.key, userId: t.userId, kpCode: t.kpCode, createdAt: t.createdAt, target: t.target }))
  }, null, 2));
  const predsHash = sha256Hex(fs.readFileSync(predsFile));

  fs.writeFileSync(outFile, JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
    source: args.source,
    label,
    inputFile: csvFile ? path.resolve(csvFile) : null,
    inputHash: 'sha256:' + inputHashFull,
    gitCommit,
    generatedAt: new Date().toISOString(),
    seed: split.seed,
    trainStudents: split.train.length,
    validationStudents: split.validation.length,
    testStudents: split.test.length,
    targetCount: n,
    dataset: stats,
    evalProtocol: {
      positioning: 'DKT 消融实验：判断 DKT 的提升来自跨知识点历史、知识点与作答位置的对应关系还是 response 本身；为是否引入图结构（GCN-DKT）提供依据',
      split: `学生级 train/validation/test = ${args.trainFraction}/${args.valFraction}/${(1 - args.trainFraction - args.valFraction).toFixed(2)}，种子 ${split.seed}，同一学生不跨集合`,
      targetRule: '目标 = test 学生中 (学生,知识点) 组非首条记录（与 dktEval / 规则基线同一规则）；目标身份 = 学生 + 答题时刻，四模式逐条对齐',
      supervisionDisclosure: '四模式共享学生划分与测试目标身份、标签；Same-KP 按 (学生,知识点) 拆序列，训练与验证监督位置与 Full/Shuffle/NoResponse 不完全相同（见各模型 supervisionCounts），差异同时受历史长度、序列切分与优化过程影响',
      sharedHyperParams: '四模式超参完全相同（见 ablationHyperParams），仅输入信息不同',
      bootstrap: '学生级聚类 bootstrap（重采样单位 = test 学生），同一批权重用于四个模型 → 天然配对；Δ 为未舍入点估计差，与 bootstrap 差值均值分开报告',
      bootstrapReps: boot.reps,
      comparisonDirection: 'Δ 统一为「Full-DKT − 消融」的点估计差：ΔAUC > 0 表示 Full 更好；ΔLogLoss < 0 表示 Full 更好。CI 支持计数的判定：AUC 看下界 > 0，LogLoss 看上界 < 0',
      ablationIsolation: '同一进程顺序训练，模型之间不共享参数，各自用同一 --seed 初始化；四模式均从原始序列独立变换，不做链式变换'
    },
    ablationHyperParams: args.hyper,
    ablationProtocol: {
      inputKpSeparation: 'v2：kpCode（原始知识点）只决定输出端口与目标身份；inputKpCode（历史输入知识点）只决定 GRU 输入编码。Shuffled-KP 只置换 inputKpCode，目标端口保持原始 kpCode',
      sameKp: '拆成 (学生,知识点) 子序列，模型只能看到该知识点内的历史；子序列位置 0 即组首条，可预测位与 Full-DKT 目标集逐条一致；训练/验证监督位置与整序列模式不同（见 supervisionCounts）',
      shuffledKp: '每个学生内部置换历史输入知识点标签（离线置换对照：使用整名学生的 KP 多重集，可能把未来才出现的 KP 放进较早输入位置，不构成严格前缀可见的在线协议）；交互数、时间顺序、response 序列、每学生知识点频数、目标身份/标签/输出端口全部不变（变换种子 = --seed 与 userId 混合）',
      noResponse: '独立词表（id = kpIndex，大小 = 知识点数），不把缺失 response 编码为答错；真实 response 仍用于训练监督、验证早停与测试评分；输出层仍按知识点'
    },
    reproducibility: {
      targetManifestHash: 'sha256:' + targetManifestHash,
      implementationHash: 'sha256:' + implementationHash,
      predictionsFile: path.basename(predsFile),
      predictionsSha256: 'sha256:' + predsHash,
      targetsManifestFile: path.basename(manifestFile),
      checkpointId
    },
    models: modelMeta,
    results,
    bootstrap: {
      reps: boot.reps,
      units: boot.students,
      ci: boot.ciByModel,
      comparisons: boot.comparisons.map((c) => ({ a: c.a, b: c.b, dAUC: c.dAUC, dLogLoss: c.dLogLoss })),
      versusFull: vsFull
    },
    calibration
  }, null, 2));

  log(`\n结果已写入 ${outFile}`);
  log(`逐目标预测已写入 ${predsFile}（sha256 前 16 位 ${predsHash.slice(0, 16)}）`);
}

if (require.main === module) main();

module.exports = { parseArgs, MODES };
