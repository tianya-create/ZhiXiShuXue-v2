# ASSISTments 2012 第二数据集验证：数据核验、图预检与判定

- 协议：《ASSISTments2012第二数据集预注册协议》（材料包 `docs/ASSISTments2012第二数据集预注册协议.md`）
- 协议版本：`assist2012-gcn-dkt-v1`
- 执行日期：2026-11-12
- 执行顺序：核验数据与许可 → 固定清洗/划分/构图规则 → 图覆盖率预检 → （闸门）→ 五种子对照

## 0. 结论先行

**判定：`protocol-not-applicable-graph-too-sparse`（协议不适用 / 图过稀疏）。未训练任何模型。**

原因是数据本身的结构性事实，而不是模型结果：

| 事实 | 数值 |
|---|---|
| 题目（problem_id）总数 | 179,999 |
| 带 skill 标注的题目 | 53,091 |
| **带 ≥2 个 skill 的题目** | **0** |
| 每次作答（problem_log_id）行数 | 恒为 1（6,123,270 行 / 6,123,270 个不同 id） |

2009 的图规则是「同一次作答内，不同知识点两两成边」。2012 里一次作答只有一个 skill 标注、一个题目也只对应一个 skill，因此该规则在数学上只能产出 **0 条边**。五个种子实测：`228` 个节点、`0` 条边、`228/228` 全孤立、validation 目标覆盖率 `0%`，远低于预注册的 40% 可行性闸门。

按协议 §2.4 与 §4 的表格，此时**不做正式 GCN 训练**，也不得把「未训练」解释成「再次证明无增益」。

## 1. 数据来源与许可核验

| 项 | 值 |
|---|---|
| 官方页面 | <https://sites.google.com/site/assistmentsdata/home/2012-13-school-data-with-affect> |
| 归档文件 | `2012-2013-data-with-predictions-4-final.zip` |
| 归档字节数 | 576,365,408 |
| 归档 SHA-256 | `7bb18f932f97e63c2eb34bb869c44cd4f46f4adec4d7fe02298578dbba572445` |
| 归档内条目 CRC-32 | `0x8f51cc70`（`zipfile.testzip()` 校验通过，解压后重算一致） |
| 内层文件 | `2012-2013-data-with-predictions-4-final.csv`，3,009,494,391 字节 |
| 内层 SHA-256 | `1d06aee9e649c5ba9db49052fe9a86e68d0c3ccb4709a7487289d7721f5464db` |
| 许可摘要 | WPI / ASSISTments 数据使用条款：仅限学术研究；不得再分发原始数据；发表须致谢 ASSISTments 团队并公开所用算法 |
| 条款核对日期 | 2026-11-12 |

原始数据与逐人记录均未提交仓库，只提交聚合统计与清单。

### 1.1 字段结构（35 列）

关键列：`problem_log_id`（作答 id，全局唯一）、`skill`（知识点名）、`skill_id`、`problem_id`、`user_id`、`start_time`、`end_time`、`correct`、`ms_first_response`；其余为 `assignment_id`、`hint_count`、`actions`（含跨行文本）、`answer_text` 以及 4 列 affect 置信度。

完整字段表（含非空计数与脱敏样例）见 `backend/datasets/assist2012/data-verification.json`。

### 1.2 缺失与异常

| 项 | 行数 | 占比 |
|---|---|---|
| 总行数 | 6,123,270 | 100% |
| skill 为空 | 3,493,190 | 57.05% |
| skill_id 为空 | 3,411,457 | 55.71% |
| correct 非 0/1（部分得分小数） | 5,323 | 0.087% |
| problem_log_id 重复 | 0 | — |
| 列数错行 | 0 | — |

非二值标签全部是部分得分（`0.5` 2,395、`0.75` 1,629、`0.25` 1,211 等），没有 `true/false` 或空值冒充。

**57% 的行没有知识点标注**，这是本数据集与 2009 最大的差别：2009 每行都带 skill。

## 2. 冻结的清洗规则与产物

规则（写死在 `backend/scripts/ingest-assistments2012.js`，含理由）：

1. `attemptId = a12-a<problem_log_id>`；脚本启动断言其唯一性，不唯一即停止（避免把一次作答的多 skill 行拆成多次作答）。
2. `kpCode = a12-s<skill_id>`；要求 `skill_id` 非空，`skill` 名可为空（名称表从同时具备两者的行回填）。
3. `correct` 只接受字面 `"0"/"1"`，小数不做阈值二值化。
4. 按 `(studentId, start_time, problem_log_id)` 稳定升序；时间不可解析即剔除。
5. `(学生, 知识点)` 序列交互数 < 2 的整组剔除。
6. 原始数据与逐人记录不入库。

> 解析注意：`actions` 列是引号包裹的多行文本，**不能按行切分 CSV**。已抽 `backend/scripts/lib/csvStream.js`（带引号状态机）供清洗与构图共用，并补 7 例回归测试 `backend/test/csvStream2012.test.js`。

清洗结果：

| 项 | 值 |
|---|---|
| 交互数 | 2,626,275（原始 6,123,270 行的 42.9%） |
| 删除：无 skill_id | 3,411,457 |
| 删除：非二值标签 | 211 |
| 删除：短序列（<2 次交互） | 85,327 |
| 学生 / 题目 / 知识点 | 27,306 / 52,478 / 228（原始带标注 skill_id 265 个，短序列过滤后剩 228） |
| (学生,知识点) 序列 | 293,301 |
| 可预测目标 | 2,332,974 |
| 正确率 | 0.6979 |
| 输出 SHA-256 | `8155ff18615c7a09…`（完整值见 manifest） |

对照 2009（267k 交互、3,931 学生、100 知识点），2012 清洗后规模约为 **9.8 倍交互、7 倍学生**，作为非图 DKT 的数据集是充足的。

## 3. 划分与构图

- 学生级 70/15/15，种子 `42,43,44,45,46`，每种子 `19,114 / 4,096 / 4,096`，同一学生不跨组。
- 词表 = 完整任务固定词表（`dkt.buildVocab`），K = 228，不随种子变化。
- 图边只取该种子 **train 学生**的原始行，且题目限定在 train 学生的 questionId 集合内；实测 `graphStudentsOutsideTrain = 0`。
- 边权 = 支持该边的不同 questionId 数，`minSupport = 1`，不读正误。

五种子构图结果：

| seed | 节点 | 边 | 孤立 | train 作答组 | 多 skill 作答组 | train 目标覆盖 | val 目标覆盖 |
|---|---|---|---|---|---|---|---|
| 42 | 228 | 0 | 228 | 1,787,246 | 0 | 0/1,621,756 | 0/361,614 |
| 43 | 228 | 0 | 228 | 1,825,366 | 0 | 0/1,641,506 | 0/340,807 |
| 44 | 228 | 0 | 228 | 1,825,251 | 0 | 0/1,630,370 | 0/346,806 |
| 45 | 228 | 0 | 228 | 1,782,122 | 0 | 0/1,623,640 | 0/352,189 |
| 46 | 228 | 0 | 228 | 1,817,574 | 0 | 0/1,624,124 | 0/360,839 |

RandomGraph 与 SelfLoop 同样为 0 边。三张邻接矩阵都退化为单位矩阵。

## 4. 闸门判定

| 项 | 值 |
|---|---|
| 规则（预注册） | 五种子 validation 目标覆盖率均值 < 40% → 停止正式 GCN 训练 |
| 实测均值 | **0.00%** |
| 结论 | **未通过** |
| 处置 | 不训练；报告「同口径图仍过稀疏，不能用本次实验验证模型增益」；保留全部图统计 |

产物：`precheck-coverage.json`、`verdict.json`（机器可读判定，含允许/禁止的结论清单）。

## 5. 该怎么读这个结果

**能说的：**

1. 2012-2013 with Affect 在同口径共标注图上为 **0 条边**，不是「稀疏」，是「不存在」。
2. 本数据集**无法**用来检验「图增强是否有预测增益」——这是数据的结构限制，不是模型表现。
3. 2009 的「无增益」结论**没有被推翻**，也**没有被第二数据集确认**；它仍只是单个数据条件下的观测。

**不能说的：**

1. 不能说「2012 上再次证明无增益」。未训练不构成证据。
2. 不能把 2012 换成「全体学生共现图 / 先修图 / 题目相似度图」后仍称本协议复现——那是另一个假设，需要另立协议。
3. 不能把 2009 与 2012 的绝对 AUC 排名。

## 6. 与 2009 放在一起看

| | 2009 Skill Builder | 2012-2013 with Affect |
|---|---|---|
| 知识点数 K | 100 | 228 |
| 共标注图边数 | 42 | **0** |
| 孤立节点 | 64 / 100 | 228 / 228 |
| 目标落在非孤立节点 | ≈50%（test 目标） | 0%（val 目标） |
| ΔAUC（GCN − Full） | −0.00074，1/5 种子为正，0/5 CI 支持 | 未训练 |

2009 的图本来就只有 42 条边、64 个孤立节点，也就是说「图增强」在 2009 上能起作用的节点不到四成；2012 直接没有任何共标注边。两个数据集指向同一件事：**K12 数学题库的知识点标注基本是一题一技能，靠「同题多技能共标注」构造的图在结构上没有供给**。

所以「个性化数学练习中的知识追踪是否需要图增强」这个问题，当前证据能给出的最诚实的答案是：

> 在两个公开数据集上，所需的那种图**要么几乎不存在（2009：42 条边），要么完全不存在（2012：0 条边）**。因此现有实验既没有支持图增强的证据，也没有真正把图增强放到「图足够稠密」的条件下检验过。要回答这个问题，必须换一类图语义或换一类数据，而不是在这两个数据集上再加模型。

## 7. 下一步（需另立协议，不能并入本次结果）

1. **换图语义**：改用课程先修关系（如 `shared/knowledge-tree.json` 的层级）或题目-知识点二部图的投影，这是「先修图」假设，与 2009 的共标注图不是同一件事，必须新协议。
2. **换数据集**：有多知识点标注的数据（如 ASSISTments 2017 的 skill builder 多标签、Junyi、EdNet 的 KC 多标签），才能让共标注图有边。
3. **先做供给侧的描述统计再决定是否训练**：本次的教训是，图预检应该在训练前、用结构指标而非模型指标判定可行性。这个 40% 闸门是有效的，它挡住了一次没有意义的 25 组训练。

## 8. 复现命令

```bash
# 1) 数据核验（不跑模型）
node backend/scripts/verifyAssist2012Data.js \
  --input backend/datasets/raw/2012-2013-data-with-predictions-4-final.csv \
  --out backend/datasets/assist2012/data-verification.json

# 2) 清洗
node --max-old-space-size=6144 backend/scripts/ingest-assistments2012.js \
  --input backend/datasets/raw/2012-2013-data-with-predictions-4-final.csv \
  --out backend/datasets/assist2012

# 3) 每种子 validation 目标（预检用，不含 test）
node backend/scripts/buildAssist2012ValTargets.js \
  --interactions backend/datasets/assist2012/interactions.csv \
  --graphs-root "backend/实验结果文件/assist2012-gcn-dkt-v1" --seeds 42,43,44,45,46

# 4) 构图（每种子）
for s in 42 43 44 45 46; do
  node --max-old-space-size=6144 backend/scripts/buildAssist2012SkillGraph.js \
    --raw backend/datasets/raw/2012-2013-data-with-predictions-4-final.csv \
    --interactions backend/datasets/assist2012/interactions.csv \
    --manifest backend/datasets/assist2012/manifest.json \
    --seed $s --out "backend/实验结果文件/assist2012-gcn-dkt-v1" \
    --targets "backend/实验结果文件/assist2012-gcn-dkt-v1/seed-$s/val-targets.json"
done

# 5) 预检 + 判定
node backend/scripts/graphCoveragePrecheck2012.js \
  --interactions backend/datasets/assist2012/interactions.csv \
  --graphs-root "backend/实验结果文件/assist2012-gcn-dkt-v1"
node backend/scripts/assist2012Verdict.js \
  --data-dir backend/datasets/assist2012 \
  --results-dir "backend/实验结果文件/assist2012-gcn-dkt-v1"
```

## 9. 产物清单

| 文件 | 说明 |
|---|---|
| `backend/datasets/assist2012/data-verification.json` | 数据核验：来源/哈希/字段表/缺失/重复/基数/10 行脱敏样例 |
| `backend/datasets/assist2012/interactions.csv` | 清洗后任务文件（2,626,275 行） |
| `backend/datasets/assist2012/manifest.json` | 清洗清单与统计 |
| `backend/datasets/assist2012/skill-names.json` | `skill_id → 名称` |
| `backend/实验结果文件/assist2012-gcn-dkt-v1/seed-{42..46}/` | split / vocabulary / 三种图 manifest / 边表 / val 目标 |
| `backend/实验结果文件/assist2012-gcn-dkt-v1/precheck-coverage.json` | 预检报告 |
| `backend/实验结果文件/assist2012-gcn-dkt-v1/verdict.json` | 机器可读判定 |
| `backend/实验结果文件/assist2012-gcn-dkt-v1/deviation-log.md` | 偏差与踩坑记录 |
| `backend/scripts/lib/csvStream.js` | 引号状态流式 CSV 解析（两链路共用） |
| `backend/test/csvStream2012.test.js` | 解析器回归测试（7 例） |
