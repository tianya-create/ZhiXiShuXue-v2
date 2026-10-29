# 数据集目录说明

本目录保存知识追踪实验使用的公开数据集：**原始文件不入库**（体量与许可原因），
只提交清洗后的**元信息**（manifest、知识点名称映射），数据本身按下面的命令可完全复现。

```
backend/datasets/
├── README.md                  # 本文件
├── raw/                       # 原始数据（git 忽略）
│   └── skill_builder_data.csv
└── assist2009/                # 清洗产物
    ├── interactions.csv       # 统一格式记录（git 忽略，17MB）
    ├── manifest.json          # 数据版本、来源、hash、清洗统计、协议（提交）
    └── skill-names.json        # skill_id → 知识点名称映射（提交）
```

## 1. 获取原始数据

ASSISTments 2009-2010 Skill Builder（官方页面）：
<https://sites.google.com/site/assistmentsdata/home/2009-2010-assistment-data/skill-builder-data-2009-2010>

本次实验实际使用的镜像（官方页面若无法访问时可用）：

```bash
mkdir -p backend/datasets/raw
curl -L -o backend/datasets/raw/skill_builder_data.csv \
  https://raw.githubusercontent.com/WalidAlsafadi/SkillMap-AI-Student-Support-Prediction/main/data/raw/skill_builder_data.csv
```

校验（必须与 `assist2009/manifest.json` 中 `source.rawSha256` 一致）：

```bash
sha256sum backend/datasets/raw/skill_builder_data.csv
# 408698925fc3488672431e4...（完整值见 manifest）
```

## 2. 生成统一格式

```bash
node scripts/ingest-assistments2009.js
```

输出 `backend/datasets/assist2009/interactions.csv` 与 `manifest.json`，
清洗规则与每一步的记录数都写在 manifest 的 `cleaning` 字段里。

## 3. 用现有评估器复现基线

```bash
cd backend
node models/baselineEval.js --source csv \
  --file datasets/assist2009/interactions.csv \
  --bootstrap 2000 --label assist2009
```

结果写入 `backend/实验结果文件/baseline-results-assist2009.json`。
