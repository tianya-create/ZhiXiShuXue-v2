# deviation-log —— assist2012-gcn-dkt-v1

协议 §5 要求：任何失败重跑、统计口径修正、代码修复都留痕（发生时间、原因、影响范围、旧/新哈希、是否看过 test、是否重训）。

本次执行**未运行任何模型、未生成 test 目标、未查看任何 test 标签或性能**，因此下面每一条的「是否看过 test」均为「否」，「是否重训」均为「不适用」。

---

## D1 数据下载：并发写同一分块目录导致内容错位

- 时间：2026-11-12 14:40–14:58（UTC+8）
- 现象：分块下载曾出现两个后台任务同时写 `.parts`，拼接出的 zip 大小正确、CRC 校验失败；解压时在压缩流偏移 35,651,657 处报 `invalid block type`。
- 原因：Google Drive 的 `drive.usercontent` 端点忽略 `Range` 的结束边界（只认起点，一路发到 EOF），并发线程按「起点 + 已有长度」续写时，若有第二个进程同时扩充同一文件，`have` 读数竞争会让落在文件里的字节来自不同偏移。
- 处置：改为单进程 12 线程、独占 `.parts6`、每块读满 `need` 即主动断开；组装后按 zip 中央目录的 entry CRC 校验，失败则按 deflate 流解码定位坏块并只重下该块（`/tmp/dl6.py`，5 轮自愈）。
- 结果：`produced=3009494391`、`crc=8f51cc70`（与中央目录一致），`sha256=7bb18f93…572445`。
- 影响范围：仅下载过程；对协议规则无影响。
- 看过 test：否。重训：不适用。

## D2 CSV 解析：`actions` 列含引号内换行

- 时间：2026-11-12 15:00
- 现象：按行读取（readline）会把一条记录拆成多行，列数校验失败。
- 原因：`actions` 字段是引号包裹的、含真实换行的多行文本。
- 处置：新增 `backend/scripts/lib/csvStream.js`（引号状态机 + 只物化目标列 + 跨 chunk 的转义引号处理），清洗与构图共用；补 `backend/test/csvStream2012.test.js`（7 例，含「未请求列里的引号与换行也要正确跳过」）。
- 影响范围：解析层；不改变任何清洗规则。
- 看过 test：否。

## D3 Node 2 GiB 上限：整块读文件算哈希失败

- 时间：2026-11-12 15:15
- 现象：构图脚本报 `File size (3009494391) is greater than 2 GiB`。
- 原因：`crypto.createHash().update(fs.readFileSync(path))` 需要把 3.01 GB 一次性读入，超过 Buffer 上限（2009 的原始文件仅 30 MB，从未触发）。
- 处置：2012 构图脚本的 `sha256File` 改为 4 MB 分块喂入。
- 影响范围：仅哈希计算方式，哈希值不变。
- 看过 test：否。

## D4 manifest 统计口径修正（在产出任何结论之前）

- 时间：2026-11-12 15:09
- 现象：首版 `backend/datasets/assist2012/manifest.json` 中
  ① `sequenceCount` 用的是「有交互的学生数」而不是「(学生,知识点) 序列数」；
  ② `short-sequence` 的 `removed` 用 `rawRows - n` 计算，重复扣掉了前面各步已删除的行；
  ③ `rawRowsWithSkill` / `rowsWithSkillRatio` 标签与实际含义不符。
- 原因：实现笔误，三个字段各自独立计算，没有做「逐级递减」的一致性约束。
- 处置：改为 `cleaning` 逐步链式扣减（`removed` 之和 + 最终条数 = 原始行数）；`skillSequenceCount` 取 `(学生,知识点)` 组数；新增 `rowsPassingAllFilters`、`rowsWithSkillIdRatio`。
- 是否影响数据：**否**。修正前后 `interactions.csv` 的 SHA-256 均为 `8155ff18615c7a09…`，逐字节一致。
- 看过 test：否。重训：不适用（尚未训练）。

## D5 闸门判定：未冻结、未训练

- 时间：2026-11-12 15:22
- 事实：五种子真实图均为 **0 条边 / 228 节点全孤立**，validation 目标覆盖率 `0.00%`，低于预注册的 40% 闸门。
- 处置：按协议 §2.4 与 §4 停止正式训练，**不生成协议 commit、不生成冻结清单 commit**（协议 §2.5 规定只有通过预检才填写冻结记录）。
- 影响范围：无模型结果；`backend/实验结果文件/assist2012-gcn-dkt-v1/verdict.json` 记录判定与允许/禁止的结论。
- 看过 test：否（未生成 test 目标）。
- 备注：本文件记录的是「执行偏差与修复」，不改变协议规则。协议文档只更新了状态行与 §6 冻结记录（填「未冻结」及原因），规则条文一字未改。
