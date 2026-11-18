#!/usr/bin/env node
/**
 * assist2012Verdict.js —— 汇总 2012 数据核验 / 清洗 / 图预检，产出机器可读判定
 *
 * 协议 §2.4：五种子 validation 目标覆盖率均值 < 40% → 停止正式 GCN 训练，
 * 报告「同口径图仍过稀疏，不能用本次实验验证模型增益」；不得把未训练解释成再次证明无增益。
 *
 * 用法：
 *   node scripts/assist2012Verdict.js \
 *     --data-dir    backend/datasets/assist2012 \
 *     --results-dir backend/实验结果文件/assist2012-gcn-dkt-v1
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    dataDir: get('data-dir', path.join('backend', 'datasets', 'assist2012')),
    resultsDir: get('results-dir', path.join('backend', '实验结果文件', 'assist2012-gcn-dkt-v1'))
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.dataDir);
  const resultsDir = path.resolve(args.resultsDir);

  const verification = JSON.parse(fs.readFileSync(path.join(dataDir, 'data-verification.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
  const precheck = JSON.parse(fs.readFileSync(path.join(resultsDir, 'precheck-coverage.json'), 'utf8'));

  const gate = precheck.gate;
  const noMultiSkill = verification.cardinality.problemsWithMultipleSkills === 0;

  const verdict = {
    protocolVersion: 'assist2012-gcn-dkt-v1',
    generatedAt: new Date().toISOString(),
    stage: 'precheck-gate',
    verdict: gate.passes ? 'proceed-to-five-seed-comparison' : 'protocol-not-applicable-graph-too-sparse',
    dataVerification: {
      source: verification.source,
      rows: verification.shape.rows,
      columns: verification.shape.columns,
      students: verification.cardinality.students,
      problems: verification.cardinality.problems,
      skillIds: verification.cardinality.skillIdsWithAnnotation,
      problemsWithSkillAnnotation: verification.cardinality.problemsWithSkillAnnotation,
      problemsWithMultipleSkills: verification.cardinality.problemsWithMultipleSkills,
      emptySkillRows: verification.missing.emptySkillRows,
      nonBinaryCorrectRows: verification.missing.nonBinaryCorrectRows,
      duplicateProblemLogIds: verification.duplicates.duplicateProblemLogIds,
      file: 'backend/datasets/assist2012/data-verification.json'
    },
    cleaning: {
      interactions: manifest.stats.interactions,
      students: manifest.stats.students,
      questions: manifest.stats.questions,
      knowledgePoints: manifest.stats.knowledgePoints,
      skillSequenceCount: manifest.stats.skillSequenceCount,
      predictors: manifest.stats.predictors,
      correctRate: manifest.stats.correctRate,
      attemptsWithMultipleSkills: manifest.stats.attemptsWithMultipleSkills,
      interactionsSha256: manifest.output.sha256,
      file: 'backend/datasets/assist2012/interactions.csv'
    },
    graphPrecheck: {
      threshold: gate.threshold,
      meanValidationCoverage: gate.meanValidationCoverage,
      meanTrainCoverage: gate.meanTrainCoverage,
      perSeedValidationCoverage: gate.perSeedValidationCoverage,
      passes: gate.passes,
      perSeed: precheck.seedReports.map((r) => ({
        seed: r.seed,
        nodeCount: r.nodeCount,
        undirectedEdgeCount: r.undirectedEdgeCount,
        isolatedNodeCount: r.isolatedNodeCount,
        isolatedNodeRatio: r.isolatedNodeRatio,
        multiSkillAttemptGroups: r.multiSkillAttemptGroups,
        validationCoverage: r.validationTargetCoverage.coverage
      })),
      file: 'backend/实验结果文件/assist2012-gcn-dkt-v1/precheck-coverage.json'
    },
    rootCause: {
      statement: noMultiSkill
        ? '本数据集每个 problem_id 只对应一个 skill_id，且每次作答（problem_log_id）只有一行 → 「同一作答多 skill 共标注」不存在 → 2009 的共现图规则必然产出 0 条边'
        : '存在多 skill 标注，但 train 侧仍未成边，需要进一步排查',
      problemsWithMultipleSkills: verification.cardinality.problemsWithMultipleSkills,
      attemptsWithMultipleSkills: manifest.stats.attemptsWithMultipleSkills
    },
    decision: {
      trainedModels: false,
      fiveSeedComparisonRun: false,
      reason: gate.verdict,
      allowedConclusions: [
        '2012-2013 with Affect 在本协议的同口径共标注图下为 0 条边（228/228 孤立），validation 目标覆盖率 0%',
        '按预注册的 40% 可行性闸门，本次实验不能用于检验「图增强是否有增益」',
        '2009 的「无增益」结论未被推翻，也未被第二数据集确认——它仍只是单个数据条件下的观测'
      ],
      forbiddenConclusions: [
        '不得说「2012 上再次证明图增强无增益」——未训练不是证据',
        '不得把 2012 换成全体学生共现图/先修图/题目相似度图后称为本协议复现',
        '不得把 2009 与 2012 的绝对 AUC 直接排名'
      ]
    }
  };

  const outPath = path.join(resultsDir, 'verdict.json');
  fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2), 'utf8');
  console.log(`判定：${verdict.verdict}`);
  console.log(`validation 覆盖率均值 ${(gate.meanValidationCoverage * 100).toFixed(2)}%（门槛 ${gate.threshold * 100}%）`);
  console.log(`写出 ${outPath}`);
  if (!gate.passes) process.exitCode = 3;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[verdict] ' + e.message); process.exit(1); }
}
