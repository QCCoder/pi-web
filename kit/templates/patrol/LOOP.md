---
name: patrol
cron: "0 20 * * 1-5"
timezone: Asia/Shanghai
level: L1
max_minutes: 15
---

# 定时巡逻（digest 播报）

本 loop 是定时巡逻：读 SKILL 入口 → 干活 → 结束。无状态、幂等——跑完即走。

1. 执行 /skill:patrol（把本文件与 LOOP.md 复制进工作区后按需调整）
2. 结束。

禁改：宿主文件 `.lastrun` / `.round.lock` / `PAUSED` / `.pi/loop/pause-all`，
以及本文件 frontmatter 的 level / cron（改点与晋级是人的手）。
