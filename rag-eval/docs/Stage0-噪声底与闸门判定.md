# Stage 0 噪声底与闸门判定（dev 集 pilot）

**日期**：2026-11-12
**模型**：`qwen3.7-flash-2026-07-15`（DashScope 兼容模式，temperature=0，top_p=1，thinking 关闭，`max_tokens=512`）
**样本**：dev 集 100 条 × 4 臂 × 3 采样 = 1,200 次调用/轮，失败 0
**配置**：`configs/rag-eval-config.json` revision 2
**原始记录**：`data/stage0/dev-pilot{,-loo}/responses.jsonl`（逐条含 usage、延迟、prompt sha256）

---

## 1. 先撞上的问题：题库语料会「自答」

第一轮按设计跑「R = BM25 top5」，结果：

| 臂 | token-F1 | 说明 |
|---|---|---|
| N（无上下文） | 0.3053 | 参数记忆下界 |
| X（等长随机块） | 0.2950 | 与 N 基本持平 → 随机上下文不帮忙 |
| R（检索 top5） | **0.8933** | ΔREL = **+59.8pp** [50.8, 68.8] |
| O（gold 解析） | 0.9103 | 生成器上限 |

检索 gold doc 的 recall@5 = 0.990、MRR = 0.917。**R 与 O 只差 1.7pp**——因为语料就是同一题库，检索到题目自身 doc 时，解析里直接写着答案。这测的是「能不能抄到本题解析」，不是「能不能用同类题迁移」。

## 2. 修正协议：R 臂改 leave-one-out

R 臂排除题目自身 doc（`--exclude-self`），其余不变，重跑：

| 臂 | token-F1 | 变化 |
|---|---|---|
| N | 0.2936 | — |
| X | 0.2972 | — |
| R（LOO） | **0.5183** | ΔREL = **+22.1pp** [12.7, 31.6] |
| O | 0.9203 | 上限不变 |

结论：即使检索不到本题，只靠同类题的题干与解析，仍带来 22pp 提升；但距 oracle 上限还有 40pp 差距——这是检索质量与「类比迁移能力」共同决定的真实空间。

**协议冻结为 LOO**（revision 2），自答版本仅作诊断保留（`protocol.diagnosticRuns.R-self`）。

## 3. 噪声底

| 项 | 值 | 口径 |
|---|---|---|
| σ_within | 0.2091 | 同 query 跨 3 次采样，ΔREL 的组内标准差 |
| n | 100 | dev query 数 |
| **noiseSigma** | **0.0209** | σ_within / √n，即 Δ 点估计的种子噪声标准误 |
| strongDeltaRel | **0.0418** | 2σ，写入 `thresholds` |

旁证：两轮独立运行的 N 臂（prompt 逐字相同）分别为 0.3053 / 0.2936，差 1.2pp，与 σ≈2.1pp 的量级一致——温度 0 下服务端仍有非确定性，σ 不是零，也不是拍脑袋。

## 4. 判定

按决策矩阵 `rel-strong_and_ret-strong_and_coverage>=0.8`：

| 条件 | 实测 | 判定 |
|---|---|---|
| ΔREL > strongDeltaRel | 0.221 > 0.0418（5.3×） | ✅ |
| 覆盖率 | answerInCorpusRate = 0.92（dev 92/100，eval 185/200=0.925） | ✅ ≥0.8 |
| X 臂护栏 | X − N = +0.4pp，未通过「有资料」暗示作弊 | ✅ |
| L1 检索指标 | LOO 下 gold doc 检索率按定义为 0，需换替代指标 | ⚠️ Stage 2 补 |

**判定：build（带条件）**——可进入 Stage 1 冻结与 eval 解封；Stage 2 必须补报「R 臂检索到的同类题中是否含可迁移的解题步骤」这一替代 L1 指标，否则「ret-strong」缺少直接证据。

## 5. 已回填的配置

```json
"stage0Preflight": {
  "answerInCorpusRate": 0.92,
  "oracleRecallAtK": { "k": 5, "value": 0.99, "mrr": 0.9167 },
  "generatorCeiling": 0.9203,
  "noiseSigma": 0.0209
},
"thresholds": { "strongDeltaRel": 0.0418, "strongMinPositiveSeeds": 4, "guardDeltaRel": 0.001 }
```

## 6. 限制

1. **单一模型单次测量**：σ 只反映 qwen3.7-flash 的服务端抖动；换模型必须重测，不得沿用。
2. **主指标是 token-F1**：答案多为短数字，F1 接近 EM；开放式解答的评分要靠 L3 judge（尚未接），judge 噪声未进入 σ。
3. **X 臂长度偏差最大 1.98%**，贴着 2% 容差上限，属规则允许范围但需在 Stage 2 复核该 query 是否作废。
4. **O 臂上限 0.92 而非 1.0**：8% 的题连给了解析也答不对（抄错/答案格式怪），构成「generator 不是瓶颈」的证据；若正式 eval 中 O 显著下降，说明分块或 prompt 与新语料冲突。

## 7. 下一步（Stage 1）

1. 冻结配置：写 `freeze-manifest.json`（config sha256 + evalSet sha256 + prompt sha256 + retriever hash）。
2. 实测四项泄漏断言（`docClusterDisjoint` 等）并写入 manifest。
3. 解封 eval 集（200 条 × 4 臂 × 3 采样 = 2,400 次调用，约 4 分钟）。
4. 补 L3 judge（rubric + 10% 人工校准，κ ≥ 0.6）后再谈「答案质量」，当前只谈 L2。
