# Pi Web — 架构总览

Pi Web 是 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的 Web UI。一个 Next.js 服务器进程就是**会话宿主**：所有 AgentSession（交互会话、subagent 子会话、loop 轮、交付自动化角色会话）都活在这一个进程里；其上叠加 **Workspace 子系统**——工作区清单 / 能力开关 / 仓库 / 工作项 / 标准交付流与四角色自动化 / loops。

> 本文档 = 面向开发者与 AI 的项目介绍与架构总览。AI 干活的工作规则在 [`AGENTS.md`](../AGENTS.md)；深细节基线在 `knowledge/reference/`（文末索引）；设计决策与历史在 `knowledge/designs/` 与 `knowledge/adr/`。

## 整体架构

```
Browser                       Next.js Server (single process, :30141)
  │                                 │ — THE single session owner
  │  ┌──────── Workspace layer ────┐  (lib/session-host/registry.ts,
  │  │ manifest .pi/workspace.yaml │   globalThis registry: interactive +
  │  │ capabilities → extensions   │   subagent children + kit rounds)
  │  │ repositories / work-items / │
  │  │ loops (kit files)           │
  │  └──────────────┬──────────────┘
  │                 │
  ├─ GET /api/sessions ──────▶ reads ~/.pi/agent/sessions/ (persistent index)
  ├─ GET /api/sessions/[id] ─▶ reads .jsonl directly
  │                 │  (+ in-process facade liveSessions() for fresh ones)
  │                 │
  ├─ send message ──▶ POST /api/agent/[id] ── facade.sendCommand() ──▶ wrapper.send()
  │                   (lib/session-host/facade.ts — direct call, no proxy)
  │                 │
  ├─ SSE connect ───▶ GET /api/agent/[id]/events ── Web-stream SSE served in-process
  │◀── data: {...} ──│◀────────── session.subscribe() (lib/session-host/sse.ts)
  │                 │
  ├─ running ids ───▶ GET /api/agent/running/events ── facade.runningStatus() in-process
```

- **会话宿主**（`lib/session-host/`）：`registry.ts` 的 globalThis 注册表持有每个 `AgentSessionWrapper`；routes 一律经 `facade.ts`（createSession/sendCommand/probeSession/destroySession/runningStatus…，`SessionHostError` 负责错误→HTTP 映射），不直接 import registry。globalThis 单例保证 Next.js 冷加载与 dev HMR 永不出第二个 owner；服务器重启后按 `.jsonl` 冷启动 revive。后台 HostJob 由 `instrumentation.ts` → `ensureHostBooted()` 装配：LoopKitSpawner（loop 心跳）+ DeliveryDispatcher（交付自动化派发）。
- **会话浏览**：列表来自持久化索引（`lib/session-index.ts`，mtime+size 增量、`.index.json` 可重建缓存；进程内 memo TTL 3s，新生会话文件不滞留）；详情为 tail 窗口（`?tail=100`），更早页经 `/earlier?before=&leafId=` 分页；前端渲染窗口 `VISIBLE_PAGE_SIZE` + 首屏分段挂载。深细节：`knowledge/reference/session-host.md`。
- **消息发送**：`POST /api/agent/[id]` → facade → wrapper.send()，无代理无第二进程。会话创建时解析所在 Workspace，装配其 extensions + AGENTS.md（skill 自 2026-10 起不区分工作区：生效面 = 全局 frontmatter 开关 + 安装位置）。
- **Shell 架构**：`AppShell` 是薄分派器；共享状态全部集中在 `useAppShellState()`（无 isMobile 分支，跨 shell 意图走 focus 信号）；桌面 `DesktopShell` / 移动端按 768px 分两壳：平板 `MobileShell`（树常驻贴左 + 目的地页）与手机 `MobileTabShell`（底部 3 tab 会话/Skill/设置 + 跨工作区分组首页 + 推入页，2026-10 底部 tab 改版）；首帧正确性靠 UA 种子（`lib/shell-is-mobile.ts`）+ 工作区/会话数据 SSR 预取。会话 tab 模型纯逻辑在 `lib/session-tabs.ts`。布局/移动端/键盘适配细节：`knowledge/reference/ui-shell.md`。

## Workspace 子系统

**模型**：工作区 = 目录 + `.pi/workspace.yaml` manifest（`WorkspaceManifest`，`lib/workspaces/types.ts`）。核心字段：`capabilities[]`（**必填**，直读）、`repositories[]`（id/alias/kind `code|knowledge`/path 相对工作区根的 POSIX 路径/status）、`git`（work-items 开时）、`work_items`（KEY 计数器）、`disabled?`。仓库**自动登记**：`listWorkspaceRepositories` 打开即跑 `syncRepositoriesFromScan`——扫描为事实，manifest 只存记忆。全局索引 `~/.pi/workspace.yaml` v2 严格无迁移（缺失才扫描重建），条目可带 `sort_order`（手动排序）。启动时 `ensureDefaultWorkspace()` 幂等补建「默认」工作区（slug `default`；墓碑 `.pi-default-deleted` 在场则永不复活）。

**能力开关（capability）**：`ALL_WORKSPACE_CAPABILITIES`（`lib/workspaces/service.ts`）= `sessions, explorer, work-items, repositories, knowledge, workflows`；`sessions`+`explorer` 强制核心不可 drop。**新增可开关模块三步**：① 值加进 `ALL_WORKSPACE_CAPABILITIES` 与 `WorkspaceCapability` 类型；② 加 extension factory（`lib/workspaces/extensions.ts` 的 `WORKSPACE_EXTENSION_FACTORIES`）；③ 加设置 UI 面板。`work-items ∧ workflows` 合取挂载 `delivery_*` 四角色工具（合取门在 build 内补检查——单 capability 注册表表达不了合取）。

**工作区 AGENTS.md 自动管理**：`renderWorkspaceAgents(manifest)` 按能力生成；仓库段住 `<!-- workspace-managed:repositories:start/end -->` 标记之间自动维护（标记被用户删掉则静默停止同步、永不重建）。pi 把 AGENTS.md **逐字**注入 system prompt、不展开任何引用——大内容必须引用出去，模型自己 follow 引用去 read。

深细节（index v2 排序 / 扫描剪枝 / 模板移除决策 / OKF 知识库 / kb_search / managed segments）：`knowledge/reference/workspace.md`

## 工作项与标准交付流

**存储**：`<workspace>/.pi/work-items/<requirements|bugs>/<KEY>-<slug>/` —— `item.yaml`（元数据 + 可选 `loop` 绑定 + 可选 `delivery` 块）、`README.md`（原始描述逐字保留，分析只追加）、`events.jsonl`（**只追加**的时间线，永不重写）、`attachments/`、`delivery/artifacts/design.md`。回收站 = `.pi/trash/work-items/`。服务面：`lib/work-items/service.ts`。

**关键规则**：

- 写并发走 `withWorkspaceWriteLock` **双层锁**（进程内 Promise 队列 × 文件锁 `.pi/.write-lock`，与 pi-loop CLI/外部脚本跨进程互斥）；**锁不可重入**——锁内取 key 计数/查重必须走 `*Unlocked` 变体。更新带 `expectedRevision` 乐观并发。
- `listWorkItems()` 单趟只读 item.yaml，返回 `{ items, archivedItems, trashedItems, invalid }`（列表/归档/回收站/去重扫描共用）。
- 导入去重：`external` 章即去重键；命中原样返回既有项（201 created / 200 existing）。
- **会话自链接**：任何带 `conversationId` 的事件/更新都会把该会话合并进 `item.conversations`——调用方只传 conversationId，不传全量列表。
- LLM 工具（`lib/work-items/extension.ts`）：list/get/create/update/record-milestone；`list` 默认排除 managed 项（`include_managed` opt-in）；`update` 不绕 service（managed 项改 phase/status 直接吃到 400 门禁）。

**七阶段标准交付流**（创建表单勾「标准交付流程」即播种 `delivery` 块）：

```
intake → design → ready_for_implementation → implementation → verification → release_ready → released
```

- 人工动作面：`POST …/work-items/[key]/delivery/[action]`（confirm-design / record-verification / record-acceptance / prepare-release / record-release / block / unblock / cancel / rework …；requestId 幂等 + revision 检查 + 证据 digest 绑定——缺设计/缺候选/检查未过一律 400）。**确认、验收、放行与发布登记是人的手，刻意不做 LLM 工具。**
- 人的通道统一为 attention 队列（问题 / 确认 / 发布 / 验收 / 阻塞）：`GET …/attention` 只读投影 + 中央页「待处理」条 + 详情答复面板；agent 侧问人 = 第六件工具 `delivery_ask_human`，答复走人工动作 `answer-clarification`。
- 已确认设计后改需求或改 design.md → 确定性失效回退（清下游证据、phase 回 design）。`released` 基线冻结。
- 合法动作的 client-safe 计算：`lib/work-items/legal-actions.ts`。

**四角色 + 引擎系统步自动执行**（`lib/work-items/delivery-runner/`；配置 `.pi/delivery.yaml`，capability 门 = work-items + workflows，缺省 disabled，预算缺省 3 次/30 分钟）：

```
designer（intake 起草 design.md + 验收条件）→ 人 confirm-design
  → developer（rfi 领取，每仓 worktree 隔离实现，提交候选 commit）→ verification
  →〔stages.review.enabled 开启时〕reviewer（人工评审——pass 放行 / rework 按 code|spec 打回）
  → 引擎 system 检查步（无 LLM 会话，system claim 占槽执行人配置的 checks——
    机器证据只认 delivery.verification actor "system"；
    checks 全过后〔stages.integrate.enabled 开启时〕在同一候选 checkout 内逐仓执行集成命令——
    失败 = blocked，不写 verification、不进预算，unblock 后整回合重跑）
  → release-preparer（release_ready 起草发布说明/回滚办法）
  → 人 record-release（〔stages.acceptance.enabled 开启时〕须先人工 record-acceptance——验收门）→ released
```

- 池子是纯投影（`projectDeliveryPool`，角色由所处阶段决定）；领取事务 claim/submit/fail 全程写锁 + 幂等重放 + 事务内双检；失败预算 = 自最近 resume 起的尾部连续失败（各角色共享，达上限 automation-paused 等人 resume；reviewer 裁定与检查结果不计预算）；每工作区单槽位（dispatcher 30s tick 顺序固定：超时清道夫 → system 检查步 → 单槽位派发 → attention）。ownerToken 只存哈希；凭证三元组住进程内 role grant，不进参数 schema、不进 LLM。
- 检查是引擎 system 步：dispatcher 每拍先于派发按 `checksDue` 找 due 项，`runChecksStep` 三段事务（system claim → 锁外跑命令 → finalizeChecks 结算）——verified → release_ready / rework → 打回 / unverified → blocked 等人 unblock（不自动重试）；integrate 是 checks 步的延伸段（结算前锁外逐仓跑，事件 `delivery.integrate_failed`、attempt outcome `integrate-failed` 不进预算）。验收门只卡 record-release（`stages.acceptance.enabled` 时无当前候选摘要的 `delivery.acceptance` 即拒），与 release-preparer 起草并行；`record-acceptance` 刻意不做 LLM 工具（不通过走 rework）。
- 角色会话 `launchRoleSession` 两步建（先 grantRole 后 prompt），开场合同限定只领指派项；工具参数**禁止 union/any-of schema**（该 pi SDK 调用侧解析不工作，测试钉死）。
- 交付角色的剧本是工作区资源 `.pi/agents/<role>.md`（缺省同名，`roles.<role>.profile` 可覆写；保存交付配置时缺文件才播种模板、永不改写）——lib 只持四角色一致的不变式合同与剧本模板。
- **第 N 个项目从初始化向导开始**（final-arch step-6）：`POST …/delivery/init` 只补缺只建议（配置缺才写默认、剧本缺才播种、from 目录缺才复制；探测命令只作草稿永不执行），`GET …/delivery/readiness` 常驻只读投影（非门禁）；模板升级后可另存副本 `<role>.template.md`（永不覆盖 `<role>.md`）。
- 运行态 `<item>/delivery/runtime/`（claim/paused/failure-window，advisory、gitignored）；审计 `<item>/delivery/attempts/`（追加式，永不删除）。
- 前端：共享缓存 `lib/work-items/store.ts` + `hooks/useWorkItems.ts`（单轮询器引用计数）；管理页 `components/work-items/`（深链 `?workspace=<id>&page=work-items[&item=<key>]`，中央页/大弹窗/右坞快捷面板三宿主共用 store）。

逐字段状态机、池子谓词、claim 事务、已知边角：`knowledge/reference/work-items.md`

## Loop

**Loop = 定时巡逻（文件协议 + 心跳）。** 工作区根 `.pi/loops/<name>/LOOP.md` 存在即 loop（frontmatter：cron/timezone/level/max_minutes/pattern）；`PAUSED` 标记停单 loop，`.pi/loop/pause-all` 全停。无 capability、无 manifest 字段。巡逻轮跑完即走、无状态幂等：运行记录 = `STATE.md` 的 `Last run:` 叙事行 + workspace git log（2026-10-26 终局：宪法两件 `.pi/loop/constraints.md` / `.pi/loop/budget.md` 与断路器 `loop-ledger.json` 从协议退役，编排态不再存在——交付执行一律走 delivery 引擎，loop 不承担流水线）。

- **agent 禁改禁删**：`.lastrun`、`.round.lock`、`PAUSED`、LOOP.md 的 level/cron。
- **digest 渠道（巡逻的标准产出）**：`GET /api/workspaces/[id]/attention?format=digest` 把 attention 队列定时渲染成业务语言的 markdown 待处理清单（`renderAttentionDigest`，零内部术语）；`kit/templates/patrol/` 模板的轮会话每夜拉取并原样播报。
- 心跳宿主有二、可并存：宿主进程内 `LoopKitSpawner`（30s tick）与 `pi-loop beat` CLI（外部 cron）；统一 fire 序列（`packages/pi-loop/fire.ts`：acquire 锁 → 锁内复查 → 写 `.lastrun` → 起轮 → finally release）跨宿主互斥。补跑 anacron-lite：停机错过的槽恢复后至多补一轮。
- 轮会话 = 一次性普通会话（cwd = 工作区根，照常装配工作区），开场合同 = LOOP.md 正文 + 硬规则 + `/skill:<pattern>` 展开；`max_minutes` 超时定向 destroy（共享宿主禁 cwd 收割，残余交恢复期只读探测）。
- 恢复门禁：未确认中断记录在场不起轮；`POST …/loops/[name]/recover` 只读探测残留进程（在场 → 409 带 pids）。
- 管理面：`GET /api/workspaces/[id]/loops`（全量状态 + interruptions）+ run/pause/resume/stop/recover 与 frontmatter PATCH（「人的手」：仅 cron/timezone/level/max_minutes 四字段）。
- dev Loop 模式（cxin 实例，退役切换：`docs/superpowers/specs/2026-10-26-dev-loop-retirement-runbook.md`）、Learn、外部源适配：`knowledge/reference/loops.md`；协议契约：`kit/README.md`。

## Subagent

进程内子 AgentSession，与交互会话同一注册表（live SSE / steer / abort 走既有会话面）。工具 `Agent` / `get_subagent_result` / `steer_subagent` **全局挂载到每个会话**（`registry.ts`，刻意不进 capability 体系）；子会话再剥掉这些工具——无递归编排。Profile 发现（平铺，同名向上胜）：builtin < `~/.pi/agent/agents/*.md` < 工作区 `<cwd>/.agents/agents/*.md` < 项目 `<cwd>/.pi/agents/*.md`。超时 = 上游语义：无 idle kill、无 runtime cap，仅 opt-in `max_turns`；心跳监控豁免子会话。子会话 id 保留 `pi-subagent-<uuid>` 前缀（侧栏隐藏/locate 依赖它）。canonical doc：`knowledge/designs/subagent.md`。

## Git & Changes / 文件访问 / 附件

- `getGitStatus(cwd)` 一次遍历发现**所有**嵌套仓库根，按仓库分组（`lib/git-changes.ts` / `git-discover.ts` / `git-status.ts`；`git-discover` 剪枝 `.pi`——里面可能是搬进来的整个数据家）；`/api/git/status|diff` 受文件访问允许清单保护；改动面板永远按仓库分组。
- `/api/files`、`/api/git/*` 不是通用文件浏览器：允许根 = 会话 cwd 及其 project root、工作区路径、`~/pi-cwd-*`、显式 `allowFileRoot()` 登记的根。
- 聊天附件双通道：图片 base64 内联（≤10MB/张）；任意文件 `POST /api/uploads` 落 `<agentDir>/uploads/`（≤25MB/个），发送时把 `[附件 name](abs path)` Markdown 链接追加进消息文本——传输协议零改动。
- Worktree 新建于 `<repoRoot>-worktrees/<branch>`；会话列表按 projectRoot 归组（worktree 归属主仓）。

## 目录速览

```
app/api/            HTTP 面：sessions / agent(SSE) / subagents / workspaces
                    （manifest·仓库·工作项·delivery·loops）/ git / auth / skills / uploads…
lib/session-host/   会话宿主：registry / facade / sse / heartbeat / background(HostJob) / loop-spawner
lib/workspaces/     manifest CRUD / capability / 扫描登记 / file-lock / kb-search
lib/work-items/     工作项服务 + delivery 状态机 + delivery-runner 四角色 / 共享 store
lib/loops/          loop 管理面（rounds / executions / manage / contract-prefill）
packages/pi-loop/   loop 纯逻辑层 + beat CLI（npm workspace 成员，可独立发布，相对路径导入）
kit/                loop 模板库 + 协议 README（被复制消费，不被 import）
components/         UI 组件（shell/ · work-items/ · 配置页 · 聊天窗 · 侧栏…）
hooks/              共享 hooks（useAgentSession / useWorkItems / useGitStatus / …）
```

带注释的完整文件地图：`knowledge/reference/file-map.md`

## 深细节索引

| 文档 | 何时读 |
|---|---|
| `AGENTS.md` | AI 干活的工作规则（命令、硬规则、不变式） |
| `knowledge/reference/session-host.md` | 改会话宿主 / SSE / 会话索引 / 生命周期与 fork / 认证·插件·技能 / 会话文件格式 |
| `knowledge/reference/workspace.md` | 改 manifest / capability / 仓库扫描登记 / 索引 v2 / OKF 知识库 / kb_search / managed segments |
| `knowledge/reference/work-items.md` | 改工作项服务 / delivery 状态机 / 四角色自动执行 / 工作项前端 |
| `knowledge/reference/loops.md` | 改 loop 协议 / 心跳 / 恢复门禁；了解 dev Loop 模式、Learn 与 cxin 实例 |
| `knowledge/reference/ui-shell.md` | 改布局 / 导航 / 移动端 / 键盘适配 / 附件与改动文件 UI |
| `knowledge/reference/file-map.md` | 找文件、看全仓结构与逐文件注释 |
| `knowledge/designs/`（设计稿）· `knowledge/adr/`（决策记录） | 设计决策与历史；`workspace-redesign.md` §1 = 文档失同步的教训 |
