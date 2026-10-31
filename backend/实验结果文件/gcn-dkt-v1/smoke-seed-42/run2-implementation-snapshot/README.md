# run2 运行时实现快照（64c6a166）

run2 冒烟（generatedAt 2026-10-31T09:37:34.481Z）的 `implementationMetadata.sourceHashes['graphDktExperiment.js']`
= `sha256:64c6a16625ce9210606267a46f48e2878a5ec2710fb1abd040ab0530358959f8`。
当时该文件未纳入 git，审计指出"包内缺少历史源码，暂时无法独立确认'仅修改打印'"。
本目录补齐该运行时版本的**字节级精确快照**。

## 文件

- `graphDktExperiment.js`：run2 运行时版本的精确快照，
  sha256 = `64c6a16625ce9210606267a46f48e2878a5ec2710fb1abd040ab0530358959f8`（已复核）。
- `diff-a3bd1a2e-to-64c6a166.patch`：中间版本（a3bd1a2e，打印修复后、监控整改前）
  与本快照的 unified diff——**仅 1 处 emit 行差异**（RSS 字段名
  `rssPeakBytes`→`rssPeakSampledBytes` + 文案加「batch 边界采样」），
  证实「run2 之后仅修改控制台打印」属实。

## 重建与验证方法

本快照并非从磁盘旧副本复制，而是**重建后哈希验证**：a3bd1a2e 版本在打印修复后
曾完整存在于材料包 `backend/models/graphDktExperiment.js`（现已随二次整改更新为
f523fedf 版本，a3bd 原始字节不再单独留存）；将其中 emit 行按会话转录中
Edit 调用的 old/new 原文逆向替换后，sha256 恰等于 run2 记录的
`64c6a166…` —— 字节级匹配成功，非近似重建。a3bd 版本可由本目录的
`graphDktExperiment.js` 反向应用 `diff-a3bd1a2e-to-64c6a166.patch` 还原。

## 其余源码对照

run2 记录的 `dkt.js`（f6acfa26…）与 `graphDkt.js`（aca2d2a8…）
与当前仓库 `backend/models/` 下同名文件哈希一致（未改动），无需快照。

## 后续版本说明

- a3bd1a2e → f523fedf（当前 `backend/models/graphDktExperiment.js`）：审计 P1 整改
  （clipGrad 三层检查：裁剪前逐元素 → 原始范数 → 裁剪后）+ 披露文案 M12→M11。
- run2 结果文件 `smoke-results.json` 于 2026-10-31 做过**唯一一处文本修订**：
  `earlyStopDisclosure` 中「回滚路径由 M12 单元测试保证」改为「由 M11（图缓存失效/最优参数回滚）
  单元测试保证」（M11/M12 编号勘误）。该文件的全部实现哈希字段未做任何改动。
