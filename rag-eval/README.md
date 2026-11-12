# rag-eval

RAG 受控评测框架——三臂（N 无检索 / X 等长随机 / R 检索）+ O 诊断臂 + 双轴分组防泄漏 +
两阶段冻结配置 + 独立审计。设计文档见 `docs/RAG受控评测框架设计.md`。

## 运行

```bash
node --test        # 79 个测试（零依赖，Node ≥ 22.13 内置 test runner）
node src/demo.js   # 端到端骨架演示：合成教材语料 → 三臂 → bootstrap → 审计 22 项
node src/corpus/xes3g5mPreflight.js --questions data/xes3g5m/kt4eqg/data/dataset/XES3G5M/zh_question_info.json --out data/xes3g5m/preflight-subset-report.json
```

## 数据：XES3G5M 题库侧语料（已接入，full 模式）

- **官方完整版已落地**：`data/xes3g5m/XES3G5M.tar.gz`（373,235,093 字节，sha256
  `62d145bd…`，gzip 校验通过）→ `metadata/questions.json` 7,652 题（填空 6,142 /
  单选 1,510，全带解析与答案，中文），许可 MIT（`github.com/ai4ed/XES3G5M`）。
- 真实格式与 README 描述有出入，适配器已按实测修正：`options` 是 dict（非数组）、
  `type` 为 '填空'/'单选' 字符串、`answer` 是 list、`kc_routes` 用 `----` 分隔；
  **答案不进语料**（评测侧专用），13 道纯符号答案题（`<`/`>`/`=`）无探针意义已剔除并计数。
- **子集**（HF `Gyikoo/KT4EQG-data`，`kt4eqg/.../zh_question_info.json` 7,618 题，仅
  content/kc/difficulty）保留作管道验证对照（sha256 `758c51a9…`）。
- 附带资产：Atomi embedding parquet（query 簇聚类备用）、`dependency_mapping.json`（KC 依赖）。

**P0 预检（full，7,652 题）**：9,150 块（每 doc 均 1.20 块）｜doc 簇 7,157（多成员 381，
覆盖 876 docs——题库近重复真实存在）｜BM25 自检索 @1=0.886 @10=1.000｜
**answerInCorpusRate = 0.920**（填空 6,129 题）｜oracle recall @5=0.998 @10=1.000 →
**PASS，语料侧闸门通过，可进 Stage 0 噪声底测量**。
报告 `data/xes3g5m/preflight-full-report.json`；manifest 同目录。

## 结构

| 模块 | 职责 | 对应设计章节 |
|---|---|---|
| `src/stats/core.js` | `mulberry32 / percentile / ciPreciseOf / pValueOf`（逐字复制自 KT `bootstrapStats.js`，sha256 `dfcc9caa…`） | §9 复用映射 |
| `src/stats/sampler.js` | 组级重采样适配层（query 为重采样单位；groupKey 契约与 KT 一致） | §6.1 |
| `src/stats/evaluator.js` | `meanScoreEvaluator`（加权均值；KT `buildEvaluator` 是概率口径，不可复用） | §9 |
| `src/stats/bootstrap.js` | `bootstrapArms` 多臂配对 bootstrap（KT `bootstrapAllModels` 泛化 + 行对齐校验） | §1/§9 |
| `src/chunking/chunk.js` | recursive-character 分块（确定性，含 overlap） | §5.2 |
| `src/clustering/cluster.js` | shingle-Jaccard + union-find 近重复聚类（n≤1500 精确 O(n²)，更大走倒排候选对；doc 簇 / query 簇双轴底座） | §4 |
| `src/corpus/xes3g5m.js` | XES3G5M 语料适配器（full/subset 双模式、图片占位符改写、manifest 留痕） | §3 数据 |
| `src/corpus/xes3g5mPreflight.js` | P0 预检：分块统计 / doc 簇 / BM25 自检索冒烟（@10<0.95 直接 FAIL） | §3 Stage 0 |
| `src/retrieval/bm25.js` | 骨架内置检索器（CJK 2-gram），换 embedding 时保持 `search(query,k)` 接口 | §2 |
| `src/coverage/coverageAudit.js` | 覆盖率三口径预检（`generatorCeiling` 显式拒绝估计值） | §5.2 |
| `src/arms/randomArm.js` | 等长随机臂采样器（簇间不重复、与 R 簇无交集、fnv1a 种子确定性） | §2.2 |
| `src/audit/auditor.js` | 独立审计器 8 类 22 项检查（不重跑生成） | §7 |
| `src/demo.js` | 合成语料端到端演示（合成分数仅验证管道） | — |

## 下一步（P0，接真实教材/题库语料）

1. 语料接入：替换 `src/demo.js` 的合成 docs → 真实文档列表 + sha256 登记
2. query 集构造：`queryClusters` 目前是 char-3gram Jaccard 占位，生产换 embedding 余弦聚类（接口不变）
3. 生成接入：`synthScore` 占位 → 真实 LLM 生成 + 判分；`generatorCeiling` 接 O 臂实测
4. Stage 0 跑噪声底 → 填 `configs/rag-eval-config.template.json` 的四个 null → 冻结
