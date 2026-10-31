/**
 * DKT 消融汇总（v2）：读取 dktAblation.js 在不同种子下的结果，聚合
 *   - 各模式 AUC/LogLoss/Brier/Accuracy/F1 的 mean ± 总体标准差（除以 n）
 *   - 逐种子「Full-DKT − 消融」点估计差值及方向/CI 支持统计
 * 写入 baseline-results-dkt-ablation-multiseed.json。
 *
 * 口径（与多种子 DKT 实验一致）：
 *   - 各种子的 test 学生集合不同 → 跨种子绝对数字不可配对比较，
 *     禁止把多个种子的 test 目标合并成「合并测试集」重算总指标；
 *   - 每个种子内部的配对 bootstrap CI 只说明该划分内差异稳定，
 *     不是对种子均值的跨种子显著性检验；
 *   - std 为种子间总体标准差（÷n），描述这几次运行的实际波动；
 *   - Δ 方向：ΔAUC > 0 表示 Full 更好；ΔLogLoss < 0 表示 Full 更好；
 *     CI 支持计数的判定：AUC 看 CI 下界 > 0，LogLoss 看 CI 上界 < 0。
 *
 * 输入校验：拒绝空/重复/非法种子；文件内部 seed 必须与指定种子一致；
 * 四模型齐全、指标有限、coverage 一致；协议/数据/超参（除 seed）/bootstrap 配置
 * 跨种子一致，否则报错退出——禁止把不同协议（如 v1 Shuffle 与 v2）混入同一汇总。
 *
 * 用法：node models/aggregateDktAblation.js --seeds 42,43,44,45,46
 *       [--input-dir 实验结果文件/v2-input-kp-only] [--out <路径>]
 */
const fs = require('fs');
const path = require('path');

const MODEL_ORDER = ['Full-DKT', 'Same-KP-DKT', 'Shuffled-KP-DKT', 'NoResponse-DKT'];
const COMPARED_MODELS = MODEL_ORDER.filter((m) => m !== 'Full-DKT');
const METRICS = ['AUC', 'LogLoss', 'Brier', 'Accuracy', 'F1'];

function parseSeeds(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('--seeds 不能为空，例如 --seeds 42,43,44,45,46');
  }
  const parts = raw.split(',');
  const seeds = [];
  for (const p of parts) {
    if (!/^\s*\d+\s*$/.test(p)) {
      throw new Error(`--seeds 含非法项「${p}」：只允许非负整数，拒绝空项/字符串（如 "42,,43" 或 "42,x"）`);
    }
    const v = Number(p.trim());
    if (!Number.isInteger(v) || v < 0) throw new Error(`--seeds 含非法种子「${p}」`);
    seeds.push(v);
  }
  const dup = seeds.filter((s, i) => seeds.indexOf(s) !== i);
  if (dup.length) throw new Error(`--seeds 存在重复种子: ${[...new Set(dup)].join(', ')}`);
  return seeds;
}

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    seedsRaw: get('seeds', null),
    inputDir: get('input-dir', path.join(__dirname, '..', '实验结果文件')),
    // 缺省 --out 在 main() 里解析为 <inputDir>/baseline-results-dkt-ablation-multiseed.json，
    // 避免「指定了 --input-dir 却漏写 --out」时把 v2 汇总写进旧协议目录（曾覆盖 v1 汇总）。
    out: get('out', null)
  };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2))); // 总体标准差（÷n）

function requireFinite(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${what} 不是有限数值（${v}），拒绝聚合`);
  }
  return v;
}

function loadRun(seed, inputDir) {
  const file = path.join(inputDir, `baseline-results-dkt-ablation-s${seed}.json`);
  if (!fs.existsSync(file)) throw new Error(`缺少结果文件: ${file}（--input-dir 指向的目录必须只含同协议结果，不做旧目录兜底）`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`结果文件无法解析: ${file}（${e.message}）`);
  }
  // 必填协议字段：缺失即视为旧协议（如 v1），禁止聚合
  const required = ['protocolVersion', 'schemaVersion', 'targetCount', 'evalProtocol', 'ablationHyperParams', 'reproducibility'];
  for (const f of required) {
    if (json[f] === undefined) throw new Error(`${path.basename(file)} 缺少必填协议字段 ${f}（疑似旧协议，禁止聚合）`);
  }
  if (!json.bootstrap || !Number.isFinite(json.bootstrap.reps)) {
    throw new Error(`${path.basename(file)} 缺少 bootstrap.reps`);
  }
  if (!json.evalProtocol || typeof json.evalProtocol.split !== 'string' || !json.evalProtocol.targetRule) {
    throw new Error(`${path.basename(file)} evalProtocol.split/targetRule 缺失`);
  }
  if (json.seed !== seed) throw new Error(`${path.basename(file)} 内部 seed=${json.seed} 与指定种子 ${seed} 不一致`);
  for (const m of MODEL_ORDER) {
    if (!json.results || !json.results[m]) throw new Error(`${path.basename(file)} 缺少模型 ${m} 的结果`);
    for (const metric of METRICS) {
      requireFinite(json.results[m][metric], `${path.basename(file)} ${m}.${metric}`);
    }
  }
  const ns = MODEL_ORDER.map((m) => json.results[m].n);
  if (new Set(ns).size !== 1) throw new Error(`${path.basename(file)} 各模型样本数不一致: ${ns.join(', ')}`);
  // coverage：每模型样本数必须等于目标数（预测覆盖完整，缺一条即拒绝）
  if (json.targetCount !== ns[0]) {
    throw new Error(`${path.basename(file)} coverage 不完整：targetCount(${json.targetCount}) ≠ 各模型样本数(${ns[0]})`);
  }
  // 划分规模：三分量齐全、合计 = 学生总数、比例符合声明的 70/15/15（容差 2%）
  for (const f of ['trainStudents', 'validationStudents', 'testStudents']) {
    if (!Number.isFinite(json[f])) throw new Error(`${path.basename(file)} 缺少 ${f}`);
  }
  const total = json.trainStudents + json.validationStudents + json.testStudents;
  if (Math.abs(json.trainStudents / total - 0.70) > 0.02 || Math.abs(json.validationStudents / total - 0.15) > 0.02) {
    throw new Error(`${path.basename(file)} 学生划分比例异常（train ${json.trainStudents}/${total}、val ${json.validationStudents}/${total}），与协议 70/15/15 不符`);
  }
  // 引用的审计文件（逐目标预测/manifest）：两个字段必须是非空字符串，且文件
  // 必须存在于同目录。禁止 reproducibility 为 {} 时静默跳过检查。
  const rp = json.reproducibility || {};
  for (const [k, f] of [['predictionsFile', rp.predictionsFile], ['targetsManifestFile', rp.targetsManifestFile]]) {
    if (typeof f !== 'string' || !f.trim()) {
      throw new Error(`${path.basename(file)} reproducibility.${k} 缺失或为空（审计文件引用不完整，拒绝聚合）`);
    }
    if (!fs.existsSync(path.join(inputDir, f))) {
      throw new Error(`${path.basename(file)} 引用的 ${k}=${f} 不存在于 ${inputDir}（先用 extractAblationAudit.js 补齐）`);
    }
  }
  // versusFull：每个被比较模型必须恰好出现一次，字段齐全且有限；
  // 支持标志一律从 CI 数值重推导，不信任文件内布尔值（防「标志与数值矛盾」）。
  const vf = (json.bootstrap && json.bootstrap.versusFull) || [];
  for (const m of COMPARED_MODELS) {
    const matches = vf.filter((c) => c.comparison === `Full-DKT − ${m}`);
    if (matches.length !== 1) {
      throw new Error(`${path.basename(file)} 中「Full-DKT − ${m}」比较出现 ${matches.length} 次（应恰好 1 次）`);
    }
    const c = matches[0];
    requireFinite(c.dAUC, `${path.basename(file)} ${m} ΔAUC`);
    requireFinite(c.dLogLoss, `${path.basename(file)} ${m} ΔLogLoss`);
    for (const [label, ci] of [['dAUCCI', c.dAUCCI], ['dLogLossCI', c.dLogLossCI]]) {
      if (!Array.isArray(ci) || ci.length !== 2 || !ci.every(Number.isFinite) || ci[0] > ci[1]) {
        throw new Error(`${path.basename(file)} ${m} 的 ${label} 缺失、非有限或上下界颠倒: ${JSON.stringify(ci)}`);
      }
    }
    // 标志与数值矛盾 → 拒绝（例：文件写 aucExcludesZero=true 但 CI 明明含 0）
    if (!!c.aucExcludesZero !== (c.dAUCCI[0] * c.dAUCCI[1] > 0)) {
      throw new Error(`${path.basename(file)} ${m} 的 aucExcludesZero=${c.aucExcludesZero} 与 CI 数值 ${JSON.stringify(c.dAUCCI)} 矛盾`);
    }
    if (c.logLossExcludesZero !== undefined && !!c.logLossExcludesZero !== (c.dLogLossCI[0] * c.dLogLossCI[1] > 0)) {
      throw new Error(`${path.basename(file)} ${m} 的 logLossExcludesZero=${c.logLossExcludesZero} 与 CI 数值 ${JSON.stringify(c.dLogLossCI)} 矛盾`);
    }
    if (c.aucCISupportsFull !== undefined && !!c.aucCISupportsFull !== (c.dAUCCI[0] > 0)) {
      throw new Error(`${path.basename(file)} ${m} 的 aucCISupportsFull=${c.aucCISupportsFull} 与 CI 下界 ${c.dAUCCI[0]} 矛盾`);
    }
    if (c.logLossCISupportsFull !== undefined && !!c.logLossCISupportsFull !== (c.dLogLossCI[1] < 0)) {
      throw new Error(`${path.basename(file)} ${m} 的 logLossCISupportsFull=${c.logLossCISupportsFull} 与 CI 上界 ${c.dLogLossCI[1]} 矛盾`);
    }
  }
  return { seed, file: path.basename(file), json };
}

// 跨种子协议一致性：数据内容/协议版本/超参（除 seed）/bootstrap 配置必须一致；
// 学生集合、目标清单哈希与目标数量随 seed 合法变化，不作要求。
function assertSameProtocol(runs) {
  const protoFields = [
    ['protocolVersion', (j) => j.protocolVersion],
    ['schemaVersion', (j) => j.schemaVersion],
    ['source', (j) => j.source],
    ['inputHash', (j) => j.inputHash]
  ];
  for (const [name, get] of protoFields) {
    const vals = new Set(runs.map((r) => JSON.stringify(get(r.json))));
    if (vals.size !== 1) {
      throw new Error(`跨种子 ${name} 不一致（疑似混合协议，禁止汇总）: ${[...vals].join(' | ')}`);
    }
  }
  const stripSeed = (hp) => {
    const c = { ...hp };
    delete c.seed;
    return c;
  };
  const hps = new Set(runs.map((r) => JSON.stringify(stripSeed(r.json.ablationHyperParams || {}))));
  if (hps.size !== 1) {
    throw new Error(`跨种子超参不一致（比较时已排除 seed 字段）: ${[...hps].join(' | ')}`);
  }
  const boots = new Set(runs.map((r) => JSON.stringify([r.json.bootstrap && r.json.bootstrap.reps])));
  if (boots.size !== 1) {
    throw new Error(`跨种子 bootstrap 配置不一致: ${[...boots].join(' | ')}`);
  }
  // 评估协议文本一致性（split 文本含种子号，归一化后再比较；划分规则必须跨种子一致）。
  // evalProtocol 缺失在 loadRun 已拒绝；这里再防御一次（assertSameProtocol 也可能单独调用）。
  const normSplit = (s) => String(s).replace(/种子\s*\d+/g, '种子');
  const protoText = (r) => JSON.stringify([
    r.json.evalProtocol ? normSplit(r.json.evalProtocol.split) : null,
    r.json.evalProtocol ? r.json.evalProtocol.targetRule : null
  ]);
  const splits = new Set(runs.map(protoText));
  if (splits.size !== 1) {
    throw new Error(`跨种子评估协议（划分规则/目标规则）不一致，禁止汇总: ${[...splits].join(' | ')}`);
  }
}

// 缺省输出跟随输入目录，杜绝「--input-dir 指到 v2 目录但输出写进主目录」的覆盖事故
function resolveOutPath(outArg, inputDir) {
  return outArg ? path.resolve(outArg) : path.join(inputDir, 'baseline-results-dkt-ablation-multiseed.json');
}

// 防跨协议覆盖：目标文件已存在且协议版本不同（或缺 protocolVersion）→ 拒绝写入
function assertSafeOverwrite(outPath, newProtocol) {
  if (!fs.existsSync(outPath)) return;
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { /* 损坏文件按可覆盖处理 */ }
  const existingProto = existing && existing.protocolVersion;
  if (existingProto !== undefined && existingProto !== newProtocol) {
    throw new Error(`拒绝覆盖：${outPath} 已存在且协议为「${existingProto}」，与本次聚合协议「${newProtocol}」不同（请显式指定 --out 到对应协议目录）`);
  }
  if (existingProto === undefined) {
    throw new Error(`拒绝覆盖：${outPath} 已存在但缺少 protocolVersion（疑似旧协议汇总），请显式指定 --out 或先归档`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seeds = parseSeeds(args.seedsRaw);
  const inputDir = path.resolve(args.inputDir);
  const runs = seeds.map((s) => loadRun(s, inputDir));
  assertSameProtocol(runs);

  const outPath = resolveOutPath(args.out, inputDir);
  assertSafeOverwrite(outPath, runs[0].json.protocolVersion);

  const perModel = {};
  for (const m of MODEL_ORDER) {
    perModel[m] = {};
    for (const metric of METRICS) {
      const vals = runs.map((r) => r.json.results[m][metric]);
      perModel[m][metric] = {
        perSeed: vals.map((v) => Number(v.toFixed(4))),
        mean: Number(mean(vals).toFixed(4)),
        std: Number(std(vals).toFixed(4))
      };
    }
    perModel[m].epochs = runs.map((r) => r.json.models[m].training.epochsRun);
    perModel[m].bestEpoch = runs.map((r) => r.json.models[m].training.bestEpoch);
  }

  // 逐种子「Full-DKT − 消融」点估计差值（结果文件已按该方向给出，直接取用）。
  // 结果 JSON 中 Δ 与 CI 已四位舍入，方向/支持计数以舍入后值判定（与展示一致）。
  // 支持标志一律从 CI 数值重推导（loadRun 已校验文件内布尔值与数值无矛盾）。
  const versusFull = COMPARED_MODELS.map((m) => {
    const perSeed = runs.map((r) => {
      const c = r.json.bootstrap.versusFull.find((x) => x.comparison === `Full-DKT − ${m}`);
      return {
        seed: r.seed,
        dAUC: c.dAUC, // 点估计差：>0 = Full 更好
        dAUCCI: c.dAUCCI,
        aucCIExcludesZero: c.dAUCCI[0] * c.dAUCCI[1] > 0, // 从 CI 数值重推导
        aucCISupportsFull: c.dAUCCI[0] > 0,               // AUC 看 CI 下界 > 0
        dAUCBootstrapMean: c.dAUCBootstrapMean,
        dLogLoss: c.dLogLoss, // 点估计差：<0 = Full 更好
        dLogLossCI: c.dLogLossCI,
        logLossCIExcludesZero: c.dLogLossCI[0] * c.dLogLossCI[1] > 0, // 从 CI 数值重推导
        logLossCISupportsFull: c.dLogLossCI[1] < 0,       // LogLoss 看 CI 上界 < 0
        dLogLossBootstrapMean: c.dLogLossBootstrapMean
      };
    });
    return {
      comparison: `Full-DKT − ${m}`,
      perSeed,
      // 方向计数（点估计差）
      seedsWithFullBetterAUC: perSeed.filter((p) => p.dAUC > 0).length,
      seedsWithFullBetterLogLoss: perSeed.filter((p) => p.dLogLoss < 0).length,
      // CI 支持计数（AUC 下界>0 / LogLoss 上界<0 才算支持 Full；排除 0 但方向相反的不计入）
      seedsWithAucCISupportingFull: perSeed.filter((p) => p.aucCISupportsFull).length,
      seedsWithLogLossCISupportingFull: perSeed.filter((p) => p.logLossCISupportsFull).length,
      seedsWithAucCIExcludingZero: perSeed.filter((p) => p.aucCIExcludesZero).length,
      seedsWithLogLossCIExcludingZero: perSeed.filter((p) => p.logLossCIExcludesZero).length,
      totalSeeds: perSeed.length
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    protocolVersion: runs[0].json.protocolVersion,
    experimentType: `DKT 消融实验：同一协议/超参/目标集下比较四种输入模式（${runs.length} 个随机种子重复：${seeds.join(', ')}）`,
    aggregation: `各种子指标取 mean ± 总体标准差（÷n，本次 n=${runs.length}）；差值方向按「Full-DKT − 消融」的点估计差统计：ΔAUC > 0 表示 Full 更好，ΔLogLoss < 0 表示 Full 更好`,
    caveatMergedTestSet: '各种子 test 学生集合不同，禁止把多份 test 目标合并成一个「合并测试集」重算总指标或做配对检验',
    perSeedCiMeaning: '每个种子内部的配对 bootstrap CI 只说明该划分内差异稳定，不是对种子均值的跨种子显著性检验',
    seeds: runs.map((r) => ({
      seed: r.seed,
      file: r.file,
      targetCount: r.json.targetCount,
      trainStudents: r.json.trainStudents,
      testStudents: r.json.testStudents,
      epochs: Object.fromEntries(MODEL_ORDER.map((m) => [m, r.json.models[m].training.epochsRun]))
    })),
    perModel,
    versusFull,
    judgmentRule: '按方案 §6：仅当「Full-DKT − 消融」的优势在多数种子中方向一致、且配对 CI 多数支持 Full 时，才可认为该信息源有独立贡献；否则如实写「当前数据规模与短序列条件下未观察到稳定边际收益」'
  };

  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log('写入', outPath);
  console.log(`\n== 各模式 mean ± std（n=${runs.length}）==`);
  for (const m of MODEL_ORDER) {
    const a = perModel[m];
    console.log(`${m.padEnd(16)} AUC ${a.AUC.mean} ± ${a.AUC.std}  LogLoss ${a.LogLoss.mean} ± ${a.LogLoss.std}  Brier ${a.Brier.mean}  Acc ${a.Accuracy.mean}  F1 ${a.F1.mean}`);
  }
  console.log('\n== Full-DKT − 消融（点估计差方向统计；AUC>0 / LogLoss<0 = Full 更好）==');
  for (const v of versusFull) {
    console.log(`${v.comparison.padEnd(30)} ΔAUC>0 ${v.seedsWithFullBetterAUC}/${v.totalSeeds}  AUC CI 支持 Full ${v.seedsWithAucCISupportingFull}/${v.totalSeeds}（排除0 ${v.seedsWithAucCIExcludingZero}/${v.totalSeeds}）  ΔLogLoss<0 ${v.seedsWithFullBetterLogLoss}/${v.totalSeeds}  LL CI 支持 Full ${v.seedsWithLogLossCISupportingFull}/${v.totalSeeds}（排除0 ${v.seedsWithLogLossCIExcludingZero}/${v.totalSeeds}）`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[aggregateDktAblation] ${e.message}`);
    process.exit(1);
  }
}

module.exports = { parseSeeds, parseArgs, loadRun, assertSameProtocol, resolveOutPath, assertSafeOverwrite, MODEL_ORDER, METRICS };
