# 过程记录：接入 LLM 并跑通 Stage 0 四臂 pilot（2026-11-12）

> 约定：每次操作完成后产出一份「过程记录 + 结果说明」。本文件是 rag-eval 项目的第 1 份。
> 结果报告的独立版本见 `docs/Stage0-噪声底与闸门判定.md`（只讲结论），本文件讲**怎么做到的**。

---

## 一、本次要解决的问题

Stage 0 上半场（query 集）已完成，卡在「没有 LLM，测不了噪声底」。本次拿到模型与 key：

- 模型：`qwen3.7-flash-2026-07-15`
- key：`sk-ws-…`（只经环境变量 `DASHSCOPE_API_KEY` 传递，未写入任何入库文件；已全仓 grep 确认无残留）

目标：把四臂（N/X/R/O）跑起来，测出 σ，回填阈值。

---

## 二、过程记录（按实际发生顺序）

### 1. 端点探测

先用 curl 打两个 DashScope 兼容端点：

| 端点 | 结果 |
|---|---|
| `dashscope.aliyuncs.com/compatible-mode/v1` | **200**，正常返回 |
| `dashscope-intl.aliyuncs.com/...` | 401 invalid_api_key |

结论：中国区端点 + 当前 key 可用。

### 2. 两个必须先确认的模型行为

1. **thinking 默认开启**：首次调用返回里带 `reasoning_content`，`content` 才是答案。
   → 传 `enable_thinking: false` 后不再返回 reasoning，答案干净（`"91"`），usage 仅 78 tokens。
   → 该开关写入配置 `generator.enableThinking=false`，属生成口径，冻结后不得改。
2. **答案格式**：模型直接输出数字，不带解释；prompt 里要求「只给最终答案」有效。

### 3. 新增/改写的代码

| 文件 | 作用 |
|---|---|
| `src/llm/llmClient.js` | DashScope 客户端：参数只从配置读、429/5xx 指数退避重试 4 次、超时 90s、回传 usage/延迟；key 缺失时 `configured=false` 并显式抛错（不返回估计值） |
| `src/metrics/answerScore.js` | token-F1 + EM 评分：NFKC 归一、剥 `$$`、CJK 逐字 / 数字整体切词；`extractFinalAnswer` 取末行并剥「答案：」 |
| `src/stage0/contexts.js` | 四臂上下文构造 + 统一 prompt 模板（sha256 `474f5ccc…`）+ `buildArtifacts`（分块 300/40、BM25、doc 簇） |
| `src/stage0/runStage0.js` | pilot runner：断点续跑、并发池、逐条落盘、bootstrap 配对 CI、σ 推导、KC 分层表 |
| `test/answerScore.test.js`（8 例） | 归一化/切词/F1/EM/答案抽取边界 |
| `test/llmClient.test.js`（8 例） | mock fetch：未配置、429 重试、4xx 不重试、重试耗尽、缺 choices |
| `test/stage0-contexts.test.js`（6 例） | N 空 / O 含解析 / X 等长且簇不相交 / 确定性 / 报错路径 / LOO |

### 4. 踩到并修掉的问题

| # | 现象 | 原因 | 修复 |
|---|---|---|---|
| 1 | 归一化把 `3.5` 变成 `35` | 标点正则里包含 `.` 和 `-` | 从 PUNCT 中移除 `.` `-`，保留小数与负号 |
| 2 | `答案是 91` 抽取失败 | 正则只认 `答案：` | 改为 `答案(?:是\|为)?[：:]?` |
| 3 | 汇总里 recall@5 = 0，但手查是 gold@1 | contexts.jsonl 记录结构与读取代码不一致，`diag` 丢失 | 改为「每条 query×臂 一行，diag 随行落盘」 |
| 4 | ΔREL 显示为负（−0.598），实际 R>X | `bootstrapArms` 的 pair 顺序固定为 N,X,R,O，取到的是 X−R | 按调用意图归一化：点估计取反、CI 端点取反再交换、support 标志随之翻转 |
| 5 | σ 一开始算出 0.47 / 0.18，阈值 0.37 | 用了「逐 query 的采样 SD」，与设计 §6.2「n=200 可检出 8.9pp」口径不一致 | 改口径为 **noiseSigma = σ_within/√n**（Δ 点估计的标准误），得 0.0209 |

### 5. 运行记录

| 轮次 | 命令参数 | 规模 | 耗时 | 失败 |
|---|---|---|---|---|
| 冒烟 | `--limit 3 --concurrency 3` | 36 次调用 | 7s | 0 |
| pilot A（含自身） | `--concurrency 6` | 1,200 次调用 | 1m49s | 0 |
| pilot B（LOO） | `--exclude-self --concurrency 6` | 1,200 次调用 | 1m54s | 0 |

### 6. 协议层的关键发现（本次最重要的判断）

pilot A 里 **R=0.893、O=0.910，只差 1.7pp**。查 `diag.goldRankInR` 发现 99% 的 query 检索到的是**题目自身 doc**，而语料 doc 里的「解析」直接写着答案。
→ 这不是 RAG 效果，是「开卷抄答案」。
→ 加 `--exclude-self`（leave-one-out）重跑：R 降到 0.518，ΔREL 从 +59.8pp 回落到 +22.1pp。
→ **配置 revision 2**：R 臂冻结为 LOO，自答版本降级为诊断项。

### 7. 纪律层面的一次自查

计算 dev/eval 覆盖率时读了 eval 集的 `goldAnswer`（Stage 0 本应零读取）。
已按 `antiCheat` 第 4 条补写 `data/evalset/audit-log.jsonl`：记录读取目的、字段、条数、`usedForTuning: false`。
未据此调整任何阈值或参数（σ 与阈值只来自 dev）。

---

## 三、结果说明

### 3.1 四臂结果（dev n=100，每臂 3 采样）

| 臂 | pilot A（含自身） | pilot B（LOO，**主协议**） |
|---|---|---|
| N 无上下文 | 0.3053 | 0.2936 |
| X 等长随机 | 0.2950 | 0.2972 |
| R 检索 | 0.8933 | **0.5183** |
| O gold 解析 | 0.9103 | 0.9203 |

| 对比 | 点估计 | 95% CI | p |
|---|---|---|---|
| ΔREL = R−X（LOO） | **+0.2211** | [0.1267, 0.3156] | 0.001 |
| ΔRN = R−N（LOO） | +0.2247 | [0.1297, 0.3194] | 0.001 |
| ΔRO = R−O（LOO） | −0.4020 | [−0.4936, −0.3122] | 0.001 |

### 3.2 噪声底与阈值

- σ_within = 0.2091（同 query 跨 3 采样的 ΔREL 组内 SD，df=200）
- **noiseSigma = 0.0209** = 0.2091/√100
- **strongDeltaRel = 0.0418** = 2σ
- 旁证：两轮 N 臂 prompt 逐字相同，结果 0.3053 vs 0.2936，差 1.2pp ≈ σ 量级

### 3.3 覆盖率与检索

- answerInCorpusRate：dev 0.920（92/100）、eval 0.925（185/200）→ 同分布
- gold doc 检索：recall@5 = 0.990、MRR = 0.917（允许含自身时）
- X 臂长度最大偏差 1.98%（贴 2% 容差上限，Stage 2 需复核是否作废该 query）
- 调用失败 0 / 2,400 次

### 3.4 判定

`rel-strong（0.221 > 0.0418，5.3×）+ coverage 0.92 ≥ 0.8` → **build（带条件）**。
条件：LOO 口径下 L1「gold doc 检索率」按定义为 0，Stage 2 必须补「检索到的同类题是否含可迁移解题步骤」的替代指标。

### 3.5 产出文件

| 文件 | 说明 |
|---|---|
| `src/llm/llmClient.js` | DashScope 客户端 |
| `src/metrics/answerScore.js` | token-F1 / EM 评分 |
| `src/stage0/contexts.js` | 四臂上下文 + prompt 模板 |
| `src/stage0/runStage0.js` | pilot runner（`--limit/--exclude-self/--summarize-only/--dry-run`） |
| `test/{answerScore,llmClient,stage0-contexts}.test.js` | +22 测试，全仓 120/120 |
| `data/stage0/dev-pilot/` | 含自身 pilot（1,200 条响应 + 汇总） |
| `data/stage0/dev-pilot-loo/` | LOO pilot（主协议） |
| `configs/rag-eval-config.json` | revision 2：σ/阈值/协议已回填 |
| `docs/Stage0-噪声底与闸门判定.md` | 结果报告 |
| `data/evalset/audit-log.jsonl` | eval 集读取留痕 |
| `.gitignore` | 排除 key、tar.gz、响应日志 |

### 3.6 下一步（按优先级）

1. **Stage 1 冻结**：写 `freeze-manifest.json`（config / evalSet / prompt / bm25 四个 sha256）+ 实测四项泄漏断言。
2. **解封 eval**：200 条 × 4 臂 × 3 采样 ≈ 2,400 次调用（约 4 分钟），主协议 LOO。
3. **补 L3 judge**：rubric + 10% 人工校准（κ ≥ 0.6），否则只能报 L2。
4. **补替代 L1 指标**：LOO 下「检索结果里有没有可迁移的解题步骤」。
