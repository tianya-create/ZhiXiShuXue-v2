# smoke-seed-42 目录说明

- `run1-superseded-20261031T1607-smoke-results.json`：
  第一版冒烟记录（审计前）。其数值检查未覆盖训练曲线/梯度、内存为 setInterval
  无效采样（回调次数 0）、无 implementationHash 落盘——已被审计要求整改，
  保留仅供追溯，不得引用。
- `smoke-results.json`：整改后重跑的正式冒烟记录（当前有效版本）。

两次均为阶段 C 冒烟：非正式结果，不得用于论文数字、test 指标或架构选择。
