---
cron: "*/30 * * * *"
level: L1
max_minutes: 30
---

# 定时巡逻

本 loop 是定时巡逻：读 SKILL 入口 → 干活 → 结束。无状态、幂等——跑完即走，
不依赖上一轮残留，也不为下一轮留运行态（不写 STATE 分区、无断路器、无宪法文件）。

1. 执行 /skill:{{pattern}}（合同本体在 SKILL.md，/skill: 展开会注入全文）
2. 结束。

禁改：宿主文件 `.lastrun` / `.round.lock` / `PAUSED` / `.pi/loop/pause-all`，
以及本文件 frontmatter 的 level / cron（晋级与改点是人的手）。
