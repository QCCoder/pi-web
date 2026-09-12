# Loop Constraints（宪法文件 — agent 禁改）

- 路径黑名单：.env*、secrets/**、auth/**、payments/**、migrations/** 一律只读不写。
- 先测试后修：修复必须先有失败用例（或明确说明为何不可测）。
- 单轮单修：一轮只处理一个 High Priority 项。
- 尝试上限：单项 ≤3 次，同一错误连续 3 次即 escalated（见 loop-ledger.json）。
- push/merge：本轮（L1）不执行任何 git 写操作；升级 level 需人手动改 LOOP.md。
- 宪法文件（本文件 / loop-budget.md / LOOP.md 的 level 字段）agent 一律禁改。
- 发现 loops/{{name}}/PAUSED 或根目录 loop-pause-all 存在 → 立即收尾退出本轮。
