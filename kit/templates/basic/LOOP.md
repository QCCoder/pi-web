---
cron: "*/30 * * * *"
level: L1
max_minutes: 30
---

# 本轮合同指针

1. 读 loop-constraints.md 与 loop-budget.md（绑定，禁改）
2. 读 STATE.md 恢复上下文
3. 执行 /skill:{{pattern}}
4. 更新 STATE.md（Last run / 分区 / 复盘节必填）并按断路器规则追加 loop-ledger.json
5. L1 纪律：只读 + 只写 STATE.md/ledger，不动代码不做 git 操作
