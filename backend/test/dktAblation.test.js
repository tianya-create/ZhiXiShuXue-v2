const {
  buildStudentSequences,
  buildVocab,
  encodeInteractionId,
  inputKpOf,
  transformSequences,
  collectPredictions,
  splitStudents,
  GruDkt
} = require('../models/dkt');
const { calibrationBins } = require('../models/baselineEval');
const { parseSeeds, loadRun, assertSameProtocol } = require('../models/aggregateDktAblation');

// ---------- 测试用固定数据（确定性构造，不用 Math.random） ----------
function makeRecords() {
  const records = [];
  let t = 0;
  for (let s = 1; s <= 12; s++) {
    const userId = `stu-${String(s).padStart(3, '0')}`;
    const kps = ['KP01', 'KP02', 'KP03'];
    for (let i = 0; i < 9; i++) {
      const kp = kps[i % 3];
      // 每位学生前 6 条答错偏多，后 3 条答对偏多（有可学习信号）
      const isCorrect = i < 6 ? (i + s) % 3 === 0 : (i + s) % 4 !== 0;
      t += 60;
      records.push({
        userId,
        kpCode: kp,
        questionId: `q-${s}-${i}`,
        isCorrect,
        costTime: 40,
        createdAt: new Date(Date.UTC(2026, 0, 1) + t * 1000).toISOString()
      });
    }
  }
  return records;
}

// 目标集：与 dktEval / dktAblation 同一规则（组内首条不算目标）
function buildTargets(seqs, testSet) {
  const targets = [];
  for (const seq of seqs) {
    if (testSet && !testSet.has(seq.userId)) continue;
    const firstTs = new Map();
    for (const it of seq.items) {
      if (!firstTs.has(it.kpCode) || it.ts < firstTs.get(it.kpCode)) firstTs.set(it.kpCode, it.ts);
    }
    for (const it of seq.items) {
      if (it.ts <= firstTs.get(it.kpCode)) continue;
      targets.push({ key: `${seq.userId}|${it.ts}`, target: it.correct, kpCode: it.kpCode });
    }
  }
  return targets;
}

const TINY = { embedDim: 4, hiddenSize: 6, dropout: 0, maxEpochs: 2, batchSize: 8, seed: 7 };

describe('消融输入模式：目标集与标签一致性', () => {
  const records = makeRecords();
  const seqs = buildStudentSequences(records);
  const split = splitStudents(seqs.map((s) => s.userId), { seed: 42 });
  const testSet = new Set(split.test);
  const targets = buildTargets(seqs, testSet);
  const targetIds = new Set(targets.map((t) => t.key));

  test('四种模式都覆盖同一批目标身份，顺序与标签一致', () => {
    for (const mode of ['full', 'same-kp', 'shuffled-kp', 'no-response']) {
      const transformed = transformSequences(seqs, mode, { shuffleSeed: 42 });
      const vocab = buildVocab(transformed, { inputMode: mode });
      const model = new GruDkt(vocab, { ...TINY, inputMode: mode });
      const testSeqs = transformed.filter((s) => testSet.has(s.userId));
      const preds = collectPredictions(model, testSeqs, { targetIds });
      expect(preds.size).toBe(targets.length);
      // 逐条能取到预测、标签来自原始数据
      for (const t of targets) expect(typeof preds.get(t.key)).toBe('number');
    }
  });

  test('same-kp 的可预测位恰好等于「非组首条」目标（结构等价）', () => {
    const transformed = transformSequences(seqs, 'same-kp', { shuffleSeed: 42 });
    const vocab = buildVocab(transformed, { inputMode: 'same-kp' });
    const model = new GruDkt(vocab, { ...TINY, inputMode: 'same-kp' });
    const testSeqs = transformed.filter((s) => testSet.has(s.userId));
    const all = collectPredictions(model, testSeqs, { targetIds: null });
    // same-kp 的每个子序列只有一条记录不可预测（位置 0 = 组首条）
    const totalItems = testSeqs.reduce((a, s) => a + s.items.length, 0);
    expect(all.size).toBe(totalItems - testSeqs.length);
    // 目标集是它的子集
    for (const t of targets) expect(all.has(t.key)).toBe(true);
  });
});

describe('shuffled-kp（v2）：只置换历史输入 KP，目标端口不动', () => {
  const records = makeRecords();
  const seqs = buildStudentSequences(records);

  test('变换后 kpCode/correct/ts/record 逐项不变，仅 inputKpCode 被置换', () => {
    const shuffled = transformSequences(seqs, 'shuffled-kp', { shuffleSeed: 42 });
    for (let i = 0; i < seqs.length; i++) {
      const orig = seqs[i].items;
      const sh = shuffled[i].items;
      expect(sh.length).toBe(orig.length);
      for (let j = 0; j < orig.length; j++) {
        expect(sh[j].kpCode).toBe(orig[j].kpCode); // 原始目标 KP 不变（输出端口不变）
        expect(sh[j].correct).toBe(orig[j].correct);
        expect(sh[j].ts).toBe(orig[j].ts);
        expect(sh[j].record).toBe(orig[j].record);
        expect(sh[j].inputKpCode).toBeDefined();
        expect(inputKpOf(sh[j])).toBe(sh[j].inputKpCode);
      }
    }
  });

  test('inputKpCode 是每学生 KP 多重集的置换（频数不变）', () => {
    const shuffled = transformSequences(seqs, 'shuffled-kp', { shuffleSeed: 42 });
    for (let i = 0; i < seqs.length; i++) {
      const count = (items, f) => {
        const m = new Map();
        for (const it of items) {
          const k = f(it);
          m.set(k, (m.get(k) || 0) + 1);
        }
        return [...m.entries()].sort().map(([k, v]) => `${k}:${v}`).join(',');
      };
      expect(count(shuffled[i].items, (it) => it.inputKpCode))
        .toBe(count(seqs[i].items, (it) => it.kpCode));
    }
  });

  test('同一 shuffleSeed 两次变换完全一致；不同 seed 产生不同排列', () => {
    const a = transformSequences(seqs, 'shuffled-kp', { shuffleSeed: 42 });
    const b = transformSequences(seqs, 'shuffled-kp', { shuffleSeed: 42 });
    const c = transformSequences(seqs, 'shuffled-kp', { shuffleSeed: 43 });
    const flat = (x) => x.map((s) => s.items.map((it) => it.inputKpCode).join(',')).join('|');
    expect(flat(a)).toBe(flat(b));
    expect(flat(a)).not.toBe(flat(c));
  });

  test('目标端口反例：Wout 清零、各 KP 输出偏置不同时，Full 与 Shuffle 的同一目标预测相同（都取原始 KP 偏置）', () => {
    const vocab = buildVocab(seqs, { inputMode: 'full' });
    const fullM = new GruDkt(vocab, { ...TINY, inputMode: 'full' });
    const shufM = new GruDkt(buildVocab(transformSequences(seqs, 'shuffled-kp', { shuffleSeed: 42 }), { inputMode: 'full' }), { ...TINY, inputMode: 'full' });
    for (const m of [fullM, shufM]) {
      m.params.Wout.fill(0);
      m.params.bout.set([0.9, 0.1, -0.5]);
    }
    const items = seqs[0].items;
    const shItems = transformSequences([seqs[0]], 'shuffled-kp', { shuffleSeed: 42 })[0].items;
    // Wout=0 时预测 = sigmoid(bout[原始 KP])；输入 KP 无论怎样置换都不应影响端口
    const fa = fullM.predictSequence(items).map((o) => o.pred);
    const fb = shufM.predictSequence(shItems).map((o) => o.pred);
    expect(fb).toEqual(fa);
    const orig = items.slice(1).map((it) => Math.abs(vocab.kpIndex.get(it.kpCode)));
    expect(orig.length).toBeGreaterThan(0);
  });

  test('当前输入不泄漏：改 t 的 inputKpCode 不改变 t 的预测，后续预测可变', () => {
    const seqs2 = buildStudentSequences(makeRecords());
    const items = seqs2[0].items.map((it) => ({ ...it }));
    const altered = seqs2[0].items.map((it) => ({ ...it }));
    // 找一个 t≥1 且其原始 KP 与可用替换 KP 不同的位置
    const tIdx = 1;
    const replace = items[tIdx].kpCode === 'KP01' ? 'KP02' : 'KP01';
    altered[tIdx].inputKpCode = replace;
    const vocab = buildVocab(seqs2, { inputMode: 'full' });
    const m = new GruDkt(vocab, { ...TINY, inputMode: 'full' });
    const a = m.predictSequence(items);
    const b = m.predictSequence(altered);
    expect(b[tIdx - 1].pred).toBe(a[tIdx - 1].pred); // t 的预测只依赖 t 之前的状态
    // 后续位置（若存在）大概率受影响；此 fixture 下 9 条序列应有后续位
    if (a.length > tIdx) {
      expect(b[tIdx].pred).not.toBe(a[tIdx].pred);
    }
  });

  test('训练端口正确：目标 KP 固定为 B、输入 KP 改成 A 时，bout 梯度只落在 B', () => {
    const vocab = buildVocab(seqs, { inputMode: 'full' });
    const iA = vocab.kpIndex.get('KP01');
    const iB = vocab.kpIndex.get('KP02');
    const items = [
      { kpCode: 'KP03', inputKpCode: 'KP03', correct: 1, ts: 1, record: {} },
      { kpCode: 'KP02', inputKpCode: 'KP01', correct: 0, ts: 2, record: {} } // 目标 B，输入 A
    ];
    const m = new GruDkt(vocab, { ...TINY, maxEpochs: 1, batchSize: 1, dropout: 0, seed: 7 });
    const before = Float64Array.from(m.params.bout);
    m.fit([{ userId: 'u', items }], [{ userId: 'u', items }]);
    expect(m.params.bout[iA]).toBe(before[iA]); // A 的监督端口梯度为 0 → Adam 不更新
    expect(m.params.bout[iB]).not.toBe(before[iB]); // 只有 B 收到监督梯度
  });
});

describe('same-kp：不读取其他知识点的历史', () => {
  test('改动其他知识点的作答结果，same-kp 的预测完全不变；full 会变', () => {
    const records = makeRecords();
    const seqs = buildStudentSequences(records);

    const modelOf = (mode, sequences) => {
      const vocab = buildVocab(sequences, { inputMode: mode });
      const m = new GruDkt(vocab, { ...TINY, inputMode: mode });
      m.training = false;
      return { m, vocab };
    };

    // 原始 vs 篡改：把 KP02 的所有作答取反
    const flipRecords = records.map((r) => (r.kpCode === 'KP02' ? { ...r, isCorrect: !r.isCorrect } : r));
    const flipSeqs = buildStudentSequences(flipRecords);

    const sameA = modelOf('same-kp', transformSequences(seqs, 'same-kp', { shuffleSeed: 42 }));
    const sameB = modelOf('same-kp', transformSequences(flipSeqs, 'same-kp', { shuffleSeed: 42 }));
    const pA = sameA.m.predictSequence(sameA.m ? transformSequences(seqs, 'same-kp', { shuffleSeed: 42 }).find((s) => s.kpCode === 'KP01').items : []);
    const pB = sameB.m.predictSequence(transformSequences(flipSeqs, 'same-kp', { shuffleSeed: 42 }).find((s) => s.kpCode === 'KP01').items);
    expect(pA.map((o) => o.pred)).toEqual(pB.map((o) => o.pred));

    // 对照：full 模式下同一批 KP01 目标会因 KP02 历史改变而改变（学生级前向）
    const fullSeqs = transformSequences(seqs, 'full');
    const fullFlip = transformSequences(flipSeqs, 'full');
    const { m: fullA } = modelOf('full', fullSeqs);
    const { m: fullB } = modelOf('full', fullFlip);
    const student = fullSeqs[0].items;
    const studentFlip = fullFlip[0].items;
    const fa = fullA.predictSequence(student).map((o) => o.pred);
    const fb = fullB.predictSequence(studentFlip).map((o) => o.pred);
    expect(fa).not.toEqual(fb);
  });

  test('same-kp 子序列只含单一知识点，且保持组内时间顺序', () => {
    const seqs = buildStudentSequences(makeRecords());
    const transformed = transformSequences(seqs, 'same-kp', { shuffleSeed: 42 });
    for (const s of transformed) {
      const kps = new Set(s.items.map((it) => it.kpCode));
      expect(kps.size).toBe(1);
      for (let i = 1; i < s.items.length; i++) {
        expect(s.items[i].ts).toBeGreaterThanOrEqual(s.items[i - 1].ts);
      }
    }
  });
});

describe('no-response：不读取作答结果', () => {
  test('词表大小 = 知识点数，编码不含 response 位', () => {
    const seqs = buildStudentSequences(makeRecords());
    const vocab = buildVocab(seqs, { inputMode: 'no-response' });
    expect(vocab.vocabSize).toBe(vocab.numSkills);
    expect(encodeInteractionId(vocab.kpIndex, 'KP01', 1, 'no-response')).toBe(vocab.kpIndex.get('KP01'));
    expect(encodeInteractionId(vocab.kpIndex, 'KP01', 0, 'no-response')).toBe(vocab.kpIndex.get('KP01'));
    // full 模式仍然区分对错
    expect(encodeInteractionId(vocab.kpIndex, 'KP01', 1, 'full'))
      .not.toBe(encodeInteractionId(vocab.kpIndex, 'KP01', 0, 'full'));
  });

  test('固定同一组（随机初始化、未训练）权重：翻转全部历史 response，NoResponse 预测逐项不变（含当前位）', () => {
    const seqs2 = buildStudentSequences(makeRecords());
    const flipped = seqs2.map((s) => ({ userId: s.userId, items: s.items.map((it) => ({ ...it, correct: 1 - it.correct })) }));
    const vocab = buildVocab(seqs2, { inputMode: 'no-response' });
    const a = new GruDkt(vocab, { ...TINY, inputMode: 'no-response' });
    // 用同一套固定权重（a.copy()）对原始与翻转序列前向
    const b = a.copy();
    expect(a.predictSequence(seqs2[0].items).map((o) => o.pred))
      .toEqual(b.predictSequence(flipped[0].items).map((o) => o.pred));
    // 对照：full 模式对取反敏感
    const fullVocab = buildVocab(seqs2, { inputMode: 'full' });
    const fa = new GruDkt(fullVocab, { ...TINY, inputMode: 'full' });
    const fb = fa.copy();
    expect(fa.predictSequence(seqs2[0].items).map((o) => o.pred))
      .not.toEqual(fb.predictSequence(flipped[0].items).map((o) => o.pred));
  });
});

describe('aggregateDktAblation：输入校验', () => {
  test('parseSeeds 拒绝空项、非法字符串与重复种子', () => {
    expect(() => parseSeeds('')).toThrow();
    expect(() => parseSeeds('42,,43')).toThrow();
    expect(() => parseSeeds('42,x')).toThrow();
    expect(() => parseSeeds('42,42')).toThrow(/重复/);
    expect(() => parseSeeds('-1,42')).toThrow();
    expect(parseSeeds('42,43')).toEqual([42, 43]);
  });

  test('loadRun 拒绝内部 seed 不一致、缺模型、指标非有限、coverage 不完整与标志/CI 矛盾', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aggtest-'));
    const base = {
      protocolVersion: 'dkt-ablation-v2-input-kp-only',
      schemaVersion: 2,
      source: 'synthetic',
      inputHash: 'sha256:abc',
      seed: 42,
      targetCount: 10,
      trainStudents: 700,
      validationStudents: 150,
      testStudents: 150,
      ablationHyperParams: { hiddenSize: 64, seed: 42 },
      evalProtocol: {
        split: '学生级 train/validation/test = 0.7/0.15/0.15，种子 42，同一学生不跨集合',
        targetRule: '目标 = test 学生中 (学生,知识点) 组非首条记录'
      },
      reproducibility: { predictionsFile: 'ablation-predictions-t.jsonl', targetsManifestFile: 'ablation-targets-t.json' },
      bootstrap: {
        reps: 100,
        versusFull: ['Same-KP-DKT', 'Shuffled-KP-DKT', 'NoResponse-DKT'].map((m) => ({
          comparison: `Full-DKT − ${m}`,
          dAUC: 0.01, dAUCCI: [0.005, 0.02], aucExcludesZero: true, aucCISupportsFull: true,
          dLogLoss: -0.01, dLogLossCI: [-0.02, -0.005], logLossExcludesZero: true, logLossCISupportsFull: true,
          dAUCBootstrapMean: 0.01, dLogLossBootstrapMean: -0.01
        }))
      },
      results: Object.fromEntries(['Full-DKT', 'Same-KP-DKT', 'Shuffled-KP-DKT', 'NoResponse-DKT'].map((m) => [m, { n: 10, AUC: 0.7, LogLoss: 0.6, Brier: 0.2, Accuracy: 0.7, F1: 0.8 }])),
      models: Object.fromEntries(['Full-DKT', 'Same-KP-DKT', 'Shuffled-KP-DKT', 'NoResponse-DKT'].map((m) => [m, { training: { epochsRun: 1, bestEpoch: 1 } }]))
    };
    const write = (name, obj) => fs.writeFileSync(path.join(tmp, name), JSON.stringify(obj));
    // 引用的审计文件必须存在
    fs.writeFileSync(path.join(tmp, 'ablation-predictions-t.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'ablation-targets-t.json'), '{}');
    write('baseline-results-dkt-ablation-s42.json', base);
    expect(() => loadRun(42, tmp)).not.toThrow();
    // 引用的审计文件缺失 → 拒绝
    fs.rmSync(path.join(tmp, 'ablation-predictions-t.jsonl'));
    expect(() => loadRun(42, tmp)).toThrow(/ablation-predictions/);
    fs.writeFileSync(path.join(tmp, 'ablation-predictions-t.jsonl'), '');
    // reproducibility 为空对象 / 引用字段缺失或空串 → 一律拒绝（不得静默跳过检查）
    const noRp = JSON.parse(JSON.stringify(base));
    noRp.reproducibility = {};
    write('baseline-results-dkt-ablation-s42.json', noRp);
    expect(() => loadRun(42, tmp)).toThrow(/predictionsFile/);
    const noPred = JSON.parse(JSON.stringify(base));
    noPred.reproducibility.predictionsFile = '';
    write('baseline-results-dkt-ablation-s42.json', noPred);
    expect(() => loadRun(42, tmp)).toThrow(/predictionsFile/);
    const noMan = JSON.parse(JSON.stringify(base));
    delete noMan.reproducibility.targetsManifestFile;
    write('baseline-results-dkt-ablation-s42.json', noMan);
    expect(() => loadRun(42, tmp)).toThrow(/targetsManifestFile/);
    write('baseline-results-dkt-ablation-s42.json', { ...base, seed: 43 });
    expect(() => loadRun(42, tmp)).toThrow(/seed/);
    write('baseline-results-dkt-ablation-s42.json', { ...base, results: { ...base.results, 'Full-DKT': undefined } });
    expect(() => loadRun(42, tmp)).toThrow(/Full-DKT/);
    const bad = JSON.parse(JSON.stringify(base));
    bad.results['Full-DKT'].AUC = null;
    write('baseline-results-dkt-ablation-s42.json', bad);
    expect(() => loadRun(42, tmp)).toThrow(/有限/);
    // coverage：targetCount 与样本数不一致 → 拒绝
    const badCov = JSON.parse(JSON.stringify(base));
    badCov.targetCount = 9;
    write('baseline-results-dkt-ablation-s42.json', badCov);
    expect(() => loadRun(42, tmp)).toThrow(/coverage/);
    // 划分比例异常 → 拒绝
    const badSplit = JSON.parse(JSON.stringify(base));
    badSplit.trainStudents = 100;
    badSplit.validationStudents = 700;
    write('baseline-results-dkt-ablation-s42.json', badSplit);
    expect(() => loadRun(42, tmp)).toThrow(/划分比例/);
    // 缺必填协议字段（疑似旧协议）→ 拒绝
    const legacy = { ...base };
    delete legacy.protocolVersion;
    write('baseline-results-dkt-ablation-s42.json', legacy);
    expect(() => loadRun(42, tmp)).toThrow(/protocolVersion/);
    // 支持标志与 CI 数值矛盾 → 拒绝
    const badFlag = JSON.parse(JSON.stringify(base));
    badFlag.bootstrap.versusFull[0].aucExcludesZero = false; // CI [0.005,0.02] 明明排除 0
    write('baseline-results-dkt-ablation-s42.json', badFlag);
    expect(() => loadRun(42, tmp)).toThrow(/矛盾/);
    // CI 数值本身含 0 但 supportsFull=true → 拒绝
    const badSup = JSON.parse(JSON.stringify(base));
    badSup.bootstrap.versusFull[1].dAUCCI = [-0.001, 0.02];
    badSup.bootstrap.versusFull[1].aucCISupportsFull = true;
    write('baseline-results-dkt-ablation-s42.json', badSup);
    expect(() => loadRun(42, tmp)).toThrow(/矛盾/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('assertSameProtocol 拒绝混合协议，但允许超参仅 seed 不同', () => {
    const mk = (protocolVersion, hpSeed) => ({
      json: {
        protocolVersion,
        schemaVersion: 2,
        source: 'synthetic',
        inputHash: 'sha256:abc',
        ablationHyperParams: { hiddenSize: 64, seed: hpSeed },
        bootstrap: { reps: 100 }
      }
    });
    expect(() => assertSameProtocol([mk('v2', 42), mk('v2', 43)])).not.toThrow();
    expect(() => assertSameProtocol([mk('v2', 42), mk('v1-legacy', 43)])).toThrow(/协议/);
    const hp = (hidden) => ({ json: { protocolVersion: 'v2', schemaVersion: 2, source: 'synthetic', inputHash: 'x', ablationHyperParams: { hiddenSize: hidden, seed: 42 }, bootstrap: { reps: 100 } } });
    expect(() => assertSameProtocol([hp(64), hp(128)])).toThrow(/超参/);
  });

  test('两个入口（backend/models 与 独立 model/ 副本）：默认输出跟随输入目录、拒绝跨协议覆盖', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    // 入口 1：仓库脚本；入口 2：材料包独立 model/ 副本（若存在，未同步时跳过）
    const entries = [
      path.join(__dirname, '..', 'models', 'aggregateDktAblation.js'),
      path.join(__dirname, '..', '..', '..', '知识追踪实验材料', 'model', 'aggregateDktAblation.js')
    ].filter((p) => fs.existsSync(p));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aggentry-'));
    try {
      for (const entry of entries) {
        // 删除 require 缓存，确保每个入口都被真实加载
        delete require.cache[require.resolve(entry)];
        const mod = require(entry);
        const inputDir = path.join(tmp, 'v2-in');
        fs.mkdirSync(inputDir, { recursive: true });
        // 默认输出 = <inputDir>/baseline-results-dkt-ablation-multiseed.json
        expect(mod.resolveOutPath(undefined, inputDir)).toBe(path.join(inputDir, 'baseline-results-dkt-ablation-multiseed.json'));
        expect(mod.resolveOutPath(path.join(tmp, 'x.json'), inputDir)).toBe(path.join(tmp, 'x.json'));
        // 防覆盖：旧协议汇总（缺 protocolVersion）→ 拒绝
        const legacyOut = path.join(tmp, 'legacy-multiseed.json');
        fs.writeFileSync(legacyOut, JSON.stringify({ seeds: [42] }));
        expect(() => mod.assertSafeOverwrite(legacyOut, 'dkt-ablation-v2-input-kp-only')).toThrow(/拒绝覆盖/);
        // 异协议汇总 → 拒绝
        const v1Out = path.join(tmp, 'v1-multiseed.json');
        fs.writeFileSync(v1Out, JSON.stringify({ protocolVersion: 'dkt-ablation-v1-legacy' }));
        expect(() => mod.assertSafeOverwrite(v1Out, 'dkt-ablation-v2-input-kp-only')).toThrow(/拒绝覆盖/);
        // 同协议 → 允许
        const v2Out = path.join(tmp, 'v2-multiseed.json');
        fs.writeFileSync(v2Out, JSON.stringify({ protocolVersion: 'dkt-ablation-v2-input-kp-only' }));
        expect(() => mod.assertSafeOverwrite(v2Out, 'dkt-ablation-v2-input-kp-only')).not.toThrow();
        // 不存在 → 允许
        expect(() => mod.assertSafeOverwrite(path.join(tmp, 'new.json'), 'dkt-ablation-v2-input-kp-only')).not.toThrow();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('消融 CLI 端到端（synthetic 小数据）', () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const SCRIPT = path.join(__dirname, '..', 'models', 'dktAblation.js');

  test('生成四模式结果 JSON：新字段齐全、manifest 一致、含相对 Full-DKT 的配对差值', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablation-'));
    execFileSync('node', [
      SCRIPT,
      '--source', 'synthetic', '--seed', '42', '--epochs', '2',
      '--bootstrap', '100', '--label', 'ablation-smoke', '--out', tmp
    ], { encoding: 'utf8', stdio: 'pipe' });
    const j = JSON.parse(fs.readFileSync(path.join(tmp, 'baseline-results-ablation-smoke.json'), 'utf8'));
    expect(j.protocolVersion).toBe('dkt-ablation-v2-input-kp-only');
    expect(j.schemaVersion).toBe(2);
    expect(Object.keys(j.results)).toEqual(['Full-DKT', 'Same-KP-DKT', 'Shuffled-KP-DKT', 'NoResponse-DKT']);
    for (const k of Object.keys(j.results)) {
      expect(j.models[k].coverage.split('/')[0]).toBe(j.models[k].coverage.split('/')[1]);
      expect(j.results[k]).toHaveProperty('AUC');
      // supervisionCounts 披露（Same-KP 与整序列模式的训练监督数不同属预期）
      expect(j.models[k].supervisionCounts.test).toBe(j.targetCount);
    }
    expect(j.models['Full-DKT'].supervisionCounts.train)
      .toBe(j.models['Shuffled-KP-DKT'].supervisionCounts.train);
    // 三条 vs Full 的配对比较（点估计差 + CI 支持计数）
    expect(j.bootstrap.versusFull.length).toBe(3);
    for (const c of j.bootstrap.versusFull) {
      expect(c).toHaveProperty('dAUCCI');
      expect(c).toHaveProperty('aucCISupportsFull');
      expect(c).toHaveProperty('logLossCISupportsFull');
      expect(c).toHaveProperty('dAUCBootstrapMean');
    }
    // 逐目标预测 JSONL 与目标 manifest 落盘，且行数 = 目标数
    const predsFile = path.join(tmp, `ablation-predictions-ablation-smoke.jsonl`);
    const lines = fs.readFileSync(predsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(j.targetCount);
    const first = JSON.parse(lines[0]);
    expect(Object.keys(first.preds).sort()).toEqual(['Full-DKT', 'NoResponse-DKT', 'Same-KP-DKT', 'Shuffled-KP-DKT']);
    expect(fs.existsSync(path.join(tmp, 'ablation-targets-ablation-smoke.json'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 180000);

  test('被篡改的 checkpoint 拒绝自动恢复（身份错位 → 重新训练该模式）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ablation-cp-'));
    const cli = ['--source', 'synthetic', '--seed', '42', '--epochs', '2',
      '--bootstrap', '50', '--label', 'cp-tamper', '--out', tmp];
    execFileSync('node', [SCRIPT, ...cli], { encoding: 'utf8', stdio: 'pipe' });
    const cpFile = path.join(tmp, 'ablation-checkpoint-cp-tamper.json');
    const cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
    // 篡改：交换两条同标签但身份不同的目标行（行数与标签总数不变，仅身份错位）
    const rows = cp.rowsByModel['Full-DKT'];
    const swapAt = [];
    for (let i = 0; i < rows.length - 1 && swapAt.length < 2; i++) {
      if (rows[i].target === rows[i + 1].target) swapAt.push(i, i + 1);
    }
    expect(swapAt.length).toBe(2);
    const a = rows[swapAt[0]];
    rows[swapAt[0]] = { ...rows[swapAt[1]], pred: a.pred };
    rows[swapAt[1]] = { ...a, pred: rows[swapAt[1]].pred };
    fs.writeFileSync(cpFile, JSON.stringify(cp));
    // 第二次运行必须检测出身份错位并重新训练，最终结果仍与 manifest 一致
    execFileSync('node', [SCRIPT, ...cli], { encoding: 'utf8', stdio: 'pipe' });
    const j = JSON.parse(fs.readFileSync(path.join(tmp, 'baseline-results-cp-tamper.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'ablation-targets-cp-tamper.json'), 'utf8'));
    const predsLines = fs.readFileSync(path.join(tmp, 'ablation-predictions-cp-tamper.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(predsLines.length).toBe(manifest.targetCount);
    for (let i = 0; i < manifest.targetCount; i++) {
      expect(predsLines[i].targetKey).toBe(manifest.targets[i].targetKey);
      expect(predsLines[i].target).toBe(manifest.targets[i].target);
    }
    expect(j.targetCount).toBe(manifest.targetCount);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 240000);
});
