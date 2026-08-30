---
name: {{pattern}}
description: <一句话：本 loop 每轮做什么>
---

# Loop 合同骨架

> init 生成的骨架 —— 按本 loop 的职责改写各节，删除残留占位后投入使用。

## 开场（每轮必做）

1. 读 STATE.md 恢复上下文（Last run / 分区 / 复盘节）；宪法文件（constraints/budget/ledger）禁改只读。
2. TODO 候选三重判断（按 loop 职责裁剪）：predictedConf（预判置信）/ verifiable（可验证面）/ riskTier（风险分级）。

## 执行

- TODO：写明本轮具体动作与产出物（写到哪个文件、什么格式）。
- L1 默认 report-only：只读 + 只写 STATE.md/ledger，不动代码不做 git 操作。
- 需要人决策 → 先盖 loop.gate 里程碑再收尾，人在 composer 答复。

## 收尾（每轮必做）

1. 更新 STATE.md：Last run / 优先级分区 / 复盘节。
2. 按断路器规则追加 loop-ledger.json（同一错误 ×3 或单项 >3 次尝试 → 上报停跑）。
