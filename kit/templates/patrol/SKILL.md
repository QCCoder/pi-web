---
name: patrol
description: 每晚拉取待处理清单（attention digest）并播报到轮会话
---

# Patrol — attention digest 播报

每夜一拍的巡逻入口：取 digest → 播报 → 结束。无状态、幂等。

## 开场（每轮必做）

1. 拉取待处理清单：`GET /api/workspaces/<workspaceId>/attention?format=digest`
   （`<workspaceId>` 换成本工作区的 id；响应是业务语言的 markdown digest，直接可读）。
2. 把 digest 原文完整输出到本轮会话——人与各投递渠道从这里接走，不在轮内逐条处理。

## 收尾（每轮必做）

3. 结束。不写任何编排态（STATE.md 只留 `Last run:` 叙事行）。
