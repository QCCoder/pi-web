# pi-web loop 产品面设计（工作项绑定 + 管理面）

> 状态：待评审（2026-08-30）
> 前置：`docs/pi-loop-host-design.md`（host 层：pi-loop 纯逻辑包、`.round.lock`、`.lastrun`、beat）——本篇依赖其纯逻辑模块与多 loop 语义。
> 定位重申：pi-web 是壳。本篇全部功能都是「人的手」——写协议文件、发停止信号、起轮——不新增引擎状态（D9 钩子之外的 loop 运行状态一律不存在于 pi-web 内存）。

## 1. 背景

1. **多 loop 使 run-contract 的假设失效**：`handleRunContract`（D11 预填）取 workspace **第一个** loop 的 pattern——dev-loop + triage-loop 并存后，「开始对话/收养续跑」不知道该用哪份合同；
2. **协议有、壳没有**：暂停（`PAUSED` 标记）、cron 编辑（LOOP.md frontmatter）、「停止在跑轮」在 kit 协议/宿主层都已定义或即将定义（host 篇），但 pi-web 无任何入口——用户只能手改文件、干等 `max_minutes`；
3. 发现层细节：`discoverKitLoops` 现状**跳过 PAUSED 的 loop**（S5 文件即声明 + 暂停即不存在）——会话预填的门控语义正确，但管理面必须能看到暂停中的 loop，需要发现变体。

## 2. 目标与非目标

**目标**：
1. 工作项 loop 绑定（方案 A）：`item.yaml` 可选字段 + 详情选择器 + 预填改用绑定 + SKILL 选择过滤语义；
2. 「立即跑一轮」（方案 B）：工作项详情按钮 → daemon 起一轮（复用既有会话面）；
3. WorkspaceOverview Loops 管理区块：状态总览 / 暂停恢复 / frontmatter 编辑 / 停止本轮。

**非目标**：
- loop 创建向导（`pi-loop init` 是 CLI；UI 化另行议）；
- STATE.md viewer（kit 设计的后续可选增强，不在本篇）；
- 通用 trigger API（起轮仍只属 cron/beat/本篇 B 按钮）；
- beat 持有轮的远程停止（`pi-loop stop` 本机命令，web 不代杀）。

## 3. 工作项 loop 绑定

### 3.1 Schema

- `WorkItemRecord.loop?: string`——存 **loop 名**（目录名/name 字段），不存 pattern（pattern 可改，名字稳定）；
- `item.yaml` 序列化为顶层可选标量 `loop: dev-loop`（与 `external` 同层的可选字段先例）；
- `CreateWorkItemInput` / `UpdateWorkItemInput` 加可选 `loop`；LLM 工具 `workspace_create_work_item` / `workspace_update_work_item` 入参透传（工具描述注明：绑定的 loop 名，留空表示未绑定）；
- **软校验**：不校验 loop 存在性（loop 可能后建/暂删），绑定未命中的项按未绑定处理（见 3.2），UI 显示「未生效」角标。

### 3.2 语义（协议层，写入 kit/README）

- **绑定 = 路由（intake）**：loop 轮拾取候选时 = 「绑给我的项 + 未绑定项」——**绑定收窄、不放大**；未绑定项维持现状（轮的开场三重判断自主决定）；
- **STATE.md High Priority = 执行状态**（不变）：工作集、进度、gate 全在 loop 侧 STATE；绑定只影响「谁能捡」，不影响「怎么跑」；
- workspace-c 的 SKILL.md 选择段加一行过滤约束（协议文档同步）。

### 3.3 UI

- 工作项详情加「Loop」行：下拉（workspace loops 列表 + 「未绑定」默认）→ 走现有 revision-safe PATCH 面；`panel` 窄列模式自适应（现有详情行的容器查询）；
- 预填改造（`handleRunContract`）：`item.loop` 命中 loops 列表 → 用该 loop 的 pattern；未命中/未绑定 → 回落第一个 loop（现状）；无 loops → 裸 prompt（现状降级）。

## 4. 「立即跑一轮」（B）

- **入口**：工作项详情按钮，gate = `hasKitLoops && (item.loop 命中 || loops.length > 0)`；未绑定且多 loop 时按钮菜单选 loop（单 loop 默认即它）；
- **流程**（新 web route `POST /api/workspaces/[id]/loops/[name]/run`，body `{ itemKey? }`）：
  1. import pi-loop 包（protocol + contract + round-lock）——纯逻辑，web 进程可导入（loops route 先例）；
  2. 读 LOOP.md 组装开场合同（`buildRoundPrompt` daemon 形态；`itemKey` 存在则追加「本轮优先处理 <KEY>」）；
  3. `acquire .round.lock`（kind: daemon，sessionId 占位）——占用中 → 409「本轮已在跑」；
  4. `daemonProxy.createSession({ cwd: workspace 根, message: 合同 })`（复用 `POST /v1/sessions`，**不新增 daemon 路由**，对齐 host 篇 §10）；
  5. 回填锁内 sessionId；`set_session_name` `<loop> · 手动 <slot>`；
  6. 返回 sessionId → UI 打开会话 tab（SSE 实时观看，gate 里程碑照常经工作项 events 流转）；
  7. createSession 失败 → release lock → 502。
- **无 D9 钩子**：手动轮跑完不自动归档（人在场，自己看）；conversations 回填靠开场合同里的 sessionId 规则（合同第 3 条）自然生效。

## 5. Overview Loops 管理区块

### 5.1 数据（`GET /api/workspaces/[id]/loops` 扩展）

- `discoverKitLoops(path, { includePaused: true })`——**pi-loop 包 protocol.ts 加参数**（默认 false 保持现语义：暂停即不存在，D11 门控不变）；
- 每项返回：`{ name, pattern, level, cron, timezone, maxMinutes, paused, running, lastRun, nextDue }`；
  - `running` = `.round.lock` 存在且持有者未 stale（判定用包内 stale 逻辑，跨宿主一致）；
  - `lastRun`/`nextDue` 读 `.lastrun` + `nextDue`（host 篇 §6）。

### 5.2 操作（新 web routes，均纯 fs + daemonProxy）

| Route | 行为 |
|---|---|
| `POST .../loops/[name]/pause` / `resume` | 写/删 `loops/<name>/PAUSED`（web 进程 fs 操作，loops route 先例）；在跑的轮靠开场合同规则 6 合作收尾 |
| `PATCH .../loops/[name]` | **frontmatter round-trip**：只接受 `cron/timezone/level/max_minutes` 四字段；yaml 库重序列化 frontmatter（frontmatter 内注释会丢失——kit frontmatter 为机器书写风格，可接受），**正文 byte 保留**；校验：cron 干跑（`cronMatches` 解析）、level 枚举、`max_minutes > 0`、timezone `Intl` 检查；非法 → 400 |
| `POST .../loops/[name]/stop` | 读 `.round.lock`：kind daemon → `daemonProxy` 调 `DELETE /v1/sessions/:id`（**现有面**：wrapper destroy，中止在飞 prompt）+ 孤儿收割（包内 reap）；kind beat → 409「由 pi-loop beat 持有，请用 `pi-loop stop`」 |

- cron 编辑后**下一心跳自然生效**（宿主每 tick 重读文件，无通知机制——文件即真相的红利）；`.lastrun` 保留，next-due 按新 cron 重算（anacron-lite 语义自洽：新 cron 若已过 due 即补跑一轮，符合预期）；
- 「人可改、agent 禁改」口径不变：PATCH 是人的手，宪法条款不动。

### 5.3 UI

- `WorkspaceOverview` 加 Loops 区块（**有 loop 才渲染**，无管理对象不占位）：
  - 行 = loop 名 / cron 摘要（人性化，如「工作日 9–22 每 30 分钟」）/ level / 状态徽章（`running` · `idle · next 10:30` · `paused`）/ 行内操作（暂停|恢复 · 编辑 · 停止[仅 running]）；
  - 编辑弹层：cron / timezone / level / max_minutes 四字段 + 校验错误内联；
  - 停止仅 running 态显示，确认弹层（「终止本轮进程，未完成工作由下轮补」）；
- 移动端：Overview 自适应，无专属设计。

## 6. 测试面

- **service**：`loop` 字段 item.yaml round-trip（有/无）；create/update 透传；绑定未命中不报错；
- **预填**：绑定命中 / 未绑定回落第一个 / 无 loops 降级——`handleRunContract` 三分支；
- **管理面数据**：includePaused 变体（paused 可见且标 paused）；running 判定（活锁/stale 锁）；
- **PATCH round-trip**：正文 byte 不变、非法 cron/level/max_minutes/timezone → 400、合法改动下次发现即生效；
- **run route**：锁互斥（重复点击 → 409）、createSession 失败释放锁、命名与 `--item` 优先行进入合同；
- **stop route**：daemon 持有 → DELETE 转发 + reap；beat 持有 → 409。

## 7. 交付顺序（依赖 host 篇交付 1–3 完成）

1. schema + service + LLM 工具透传 + 单测；
2. loops route 扩展（includePaused + 状态计算）+ pause/resume/PATCH/stop 四组 routes；
3. Overview Loops 区块 + 工作项详情「Loop」行；
4. run route + B 按钮 + `handleRunContract` 绑定改造；
5. 协议文档：kit/README 绑定语义一节；workspace-c SKILL.md 选择过滤行。

## 8. 验收标准

1. 绑定 dev-loop 的项，「开始对话」预填 `/skill:dev-loop 执行 REQ-xxxx`；未绑定项回落现状；
2. SKILL 过滤生效：轮的候选 = 绑定项 + 未绑定项（观察 workspace-c 演练一轮）；
3. 暂停的 loop 在 Overview 可见、可恢复；恢复后按补跑语义最多补一轮；
4. cron 编辑后下一心跳按新节奏起轮；
5. 停止按钮：daemon 持有轮被终止（badge 清、SSE 断、孤儿收割），beat 持有给 409 提示；
6. B 按钮起轮（会话出现、命名正确、锁互斥、`--item` 优先行在合同里）。

## 已确认决策（对话记录）

| # | 决策 |
|---|---|
| S1 | 绑定字段 = loop **名**（非 pattern），软校验不校验存在性，未命中按未绑定处理 |
| S2 | 绑定 = 路由收窄（绑给我的 + 未绑定）；STATE.md = 执行状态——分工不重叠 |
| S3 | B 按钮 = web route 组装合同（import pi-loop 纯逻辑）+ 复用 `POST /v1/sessions`，不新增 daemon 路由；手动轮无 D9 自动归档 |
| S4 | 停止 = `DELETE /v1/sessions/:id` 现有面 + 包内 reap；beat 持有 → 409 |
| S5 | frontmatter 编辑 = 人的手（yaml round-trip，正文不动）；「人可改 agent 禁改」口径不变 |
| S6 | `discoverKitLoops` 加 `includePaused` 参数：默认 false（D11 门控语义不变），管理面用 true |
