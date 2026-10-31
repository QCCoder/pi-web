# Loop（pi-loop kit 协议 + Dev Loop 模式 + Learn + cxin 实例）

> 深细节基线，2026-10 自 AGENTS.md 迁出（AGENTS.md 现为总览与用法说明，细节住此）。

> 内容与迁移时点一致；后续变更直接更新本文档。



---



### Loop（pi-loop kit；`lib/session-host/loop-spawner.ts` + `packages/pi-loop/` + `kit/`）

**Loop = 定时巡逻：cron + max_minutes + 入口，跑完即走、无状态幂等。** v3 引擎（orchestrator session / seeder / RUNS.jsonl / gate 机器）已拆除
（设计：`knowledge/designs/pi-loop-kit-design.md`；宿主层修订——beat/补跑/锁/D13——见 `knowledge/designs/pi-loop-host-design.md`）。现行形态：

- **声明**：workspace 根 `.pi/loops/<name>/LOOP.md` 存在即 loop（frontmatter：cron/timezone/level/max_minutes/stall_minutes/pattern）；
  `PAUSED` 标记文件停单 loop，根 `.pi/loop/pause-all` 全停。无 capability、无 manifest 字段。`GET /api/workspaces/[id]/loops`
  返回全量状态（`collectStatus`，含 paused——管理面全量；纯 fs，导入 `packages/pi-loop/status.ts`，无宿主依赖），消费方自行
  过滤 paused（D11 门控语义：暂停即不存在）——工作项「开始对话/收养续跑」按钮的门控与 Overview Loops 区块都读它。
- **pi-loop 包**（`packages/pi-loop/`，npm workspaces 成员，独立 package.json 备发布；pi-web 以相对路径导入，不经 node_modules 链接——H5 的 Next server bundle 符号链接摩擦）：loop 宿主的**纯逻辑层 + CLI**——
  protocol/cron/due/round-lock/contract/reap/fire 全是纯函数，宿主 spawner（Next.js 进程内）与 beat CLI 共用同一实现（无双实现）。
- **心跳宿主有二，可并存（2026-10 M1 起宿主 = Next.js 进程本身）**：① Next.js 宿主内的 `LoopKitSpawner`
  （HostJob `loop-kit-heartbeats`，30s tick，**无条件注册，无旗子**；由 `instrumentation.ts` →
  `ensureHostBooted()`（`lib/session-host/background.ts`）装配）扫已注册 workspace；② **`pi-loop beat`** —— 一次性幂等进程
  （发现 → 补跑判定 → 锁 → 起轮 → 退出），无 pi-web 的 standalone 仓库挂进任意外部 cron 即获心跳
  （crontab `* * * * * pi-loop beat --root <path>`）。
  fire 序列统一（`packages/pi-loop/fire.ts`）：acquire `.round.lock` → 锁内复查 `.lastrun` 判定 → 写 `.lastrun` → 起轮 →
  finally release —— **双宿主并存安全**（宿主轮的锁写 `kind: "daemon"` + sessionId——字面值沿用历史命名，跨宿主互斥协议不变，
  beat 看到即跳过，反之亦然）。
  到点 → `startRpcSession` 起一次性会话（cwd=workspace 根 → workspace 装配照常），命名 `<loop> · <slot>`，
  开场合同 = LOOP.md 正文 + spawner 注入的硬规则 + `/skill:<pattern>` 展开；
  **时长治理两段（2026-10-27）**：`stall_minutes`（缺省 15）= 停滞判定——`waitForRoundSettle` 每 30s 读轮会话
  `activityIdleMs()`，整棵会话树连续静默超阈值即 reject；子代理活性经 `AgentSessionWrapper.touchActivity` 沿
  `parentSessionId`（`registerSubagentChild` 登记）向上传递，所以编排者阻塞在 `get_subagent_result {wait}` 等一个
  在干活的 implementer 不算静默，整棵树都停了才算。`max_minutes` 退为硬天花板（成本保险，不是正常收尾路径；
  编排型 loop 应放大到 180–240）。宿主级僵尸监视器（`heartbeat.ts` `STALL_KILL_MS` 缺省 20min，同样读
  `activityIdleMs`，现在也跨子代理）仍是全局兜底——实际停滞阈值 = min(stall_minutes, STALL_KILL_MS)。
  手动轮（`launchManualRound`）两者都不管（人在场）；turn 收尾由 detached settle 监听感知并放锁（见下文 run-contract 的锁活性化）。
  任一到点 → `destroy()` **定向杀**（SDK destroy→dispose→abortBash 按执行进程组 kill）；共享宿主
  **禁止 cwd 收敛收割**（spawner 的 reaper 依赖默认 NO-OP，注入点留给测试/独立宿主；beat CLI 自带收割不受影响），
  残余孤儿交由恢复期**只读探测**报告（`lib/loops/executions.ts` 的 `detectSurvivingRoundProcesses`）。
  **恢复门禁（spec §5.4）**：上次关停留下的未确认中断记录在场 → 该 loop 不起新轮；管理面「重新检查并恢复」=
  `POST …/loops/[name]/recover`（探测到存活残留进程 → 409；干净 → resolve 记录），loops GET 附带 `interruptions` 字段。
- **补跑语义（anacron-lite）**：fire 判定 = `now >= nextDue(cron, tz, .lastrun)`——宿主睡眠/停机错过的槽位恢复后
  至多**补一轮**（旧分钟槽语义是静默丢失；A 轮在跑也不再丢 B 的槽，`.lastrun` per-loop）。`.lastrun` / `.round.lock`
  是宿主文件，agent 禁改禁删（与 `PAUSED` 同级，写进协议条款与开场合同）。
- **运行状态（2026-10-26 终局：巡逻化，编排态退役）**：只有 `STATE.md` 的 `Last run:` 叙事行（叙事不机器读）+
  workspace git log。STATE 分区（High Priority / Watch List / Recent Noise / [BUDGET] / 复盘节）与断路器账本
  （`.pi/loops/<name>/loop-ledger.json`，曾 per-loop——D13 修订断路计数不跨 loop 混算）从协议退役；宪法两件
  （`.pi/loop/constraints.md` / `.pi/loop/budget.md`）同步退役——kit 不再创建/读取/展示，`lib/loops/manage.ts`
  写面只余知识文档与 LOOP 正文。工作集/进度/预算等执行状态归 delivery 引擎；现存退役文件留在原地不读，git 历史即审计。
- **digest 渠道（巡逻的标准产出）**：`GET /api/workspaces/[id]/attention?format=digest` = attention 队列的定时渲染
  （`renderAttentionDigest` 纯函数，`lib/work-items/attention.ts`）——业务语言 markdown 待处理清单
  （question→待您解答 / confirm→待确认设计 / acceptance→待人工验收 / release→可登记发布 / blocked→受阻待处理；
  每行 `- <KEY> <标题> — <detail>（已 N 天[，已催办][，已泊车]）`，空队列「今日无待处理」，零内部术语）。
  `kit/templates/patrol/` 模板的轮会话每夜拉取并原样播报（不在轮内逐条处理——人从轮会话/投递渠道接走）。
- **事后钩子（D9）**：轮结束（成功与失败路径都跑）扫工作项 events.jsonl 的 conversationId 回填 conversations；
  无待决 `loop.gate` 里程碑 → 自动归档轮会话（会话列表防污染；有待决 gate 的留在列表供人在 composer 答复）。
  （beat 轮无此钩子——standalone 根没有 work-items 域工具；轮会话自然沉淀为普通 pi 会话。）
- **run-contract**：工作项「开始对话/收养续跑」= 客户端预填（D11，无服务端 seed 路由）——`handleRunContract` in
  `useAppShellState` reads the workspace's kit loops (`GET /api/workspaces/[id]/loops`) and resolves the pattern via
  `resolveContractPattern`（`lib/loops/contract-prefill.ts`：绑定名命中 → 该 loop 的 pattern；paused = 不存在；未命中/未绑定
  且恰有 1 个 active loop → 该 loop；≥2 个 active loop → undefined 不猜——可能存在不消费工作项的 loop，盲取首个会误路由，
  调用方降级为裸 prompt，精确路由靠工作项的显式绑定）, writes `/skill:<pattern> 执行|收养 <KEY>` into the new-session draft (`setDraft("new:<wsPath>")`), bumps
  `composerEpoch` (ChatWindow keys its ChatInput mount on it so an already-mounted composer re-reads the draft) and switches to the
  fresh chat view — nothing is sent or created until the human presses send. The buttons' visibility gate in
  WorkspaceManager is kit-loops-driven (`hasKitLoops`, fetched once per selected workspace), not capability-driven.
  「继续对话」 = open the latest conversation as a chat tab (the skill is already in its context).
- **工作项绑定 + 管理面**（协议语义落文：`kit/README.md` 工作项绑定一节）：工作项可声明 `loop: <loop名>` 绑定（S1 软校验，
  两个 LLM 工具透传）；**绑定 = 巡逻参考**（2026-10-26 终局收窄——不再是流水线路由）：巡逻轮可把绑定项当作「与我有关」的
  提示，未命中/已删 loop 的绑定按未绑定处理；交付执行一律走 delivery 引擎，`item.loop` 不路由流水线。管理面：
  ① 工作项「立即跑一轮」（B 按钮，`lib/loops/rounds.ts` `launchManualRound`）走 `POST …/loops/[name]/run`——web 进程
  import pi-loop 纯逻辑组装开场合同，经**进程内宿主 facade 两步建会话**（`createSession` 不带 command → sessionId 进
  开场合同第 3 条 → `sendCommand` prompt；依赖全注入，无 HTTP 往返）；可选 `itemKey` → 合同追加「本轮优先处理 <KEY>」。
  手动轮**无 D9 自动归档**
  （人在场）。**锁活性化（2026-10-28）**：run 路由注入 `awaitSettle`（`facade.waitForSessionSettle` →
  `lib/session-host/turn-settle.ts` 被动等 prompt_done/destroy/错误/max_minutes 天花板），prompt 发出后挂
  detached 监听，**turn 收尾即放锁**（`releaseRoundLockIfOwner` 防迟到监听误删 stale 抢占后他者重取的锁；
  天花板到点不 destroy 会话——人在场，UI 可手动停）——锁活 = turn 活，「一个项同一时刻只归一个会话」从
  合同自觉升级为宿主机制，收养/新轮只发生在干净交接点（人手事后在旧会话插话由轮合同 §一.2 冗余副本守卫
  让位）；stale 窗（maxMinutes+15min）退为崩溃兜底。该路径的盲区——web 重启丢失监听，锁残留到 stale 窗，
  期间「假运行中」（按钮禁用 + 409 误报 + 心跳槽被吃，编排型 loop 一次可吃掉多个槽）——由 spawner tick
  兜底：busy 时同一 `isPhantomRoundLock` 判定（宿主锁带 sessionId、锁龄过 `PHANTOM_LOCK_GRACE_MS` 2min
  宽限、且不在宿主 running set）→ 放锁并**同 tick 重试**，残留窗口收窄到一个 30s tick。run/stop 路由注入
  `runningSessionIds` 做手动起轮/停止的幽灵锁活性接管；beat 锁与启动窗口锁不判，探测失败保守不接管。
  LoopRow 按钮 disabled 有视觉（opacity+cursor），不再「能点但没反应」。
  ② 停止 = `POST …/loops/[name]/stop`（`stopRound`）：宿主持有 → facade `destroySession`（定向中止在飞 prompt；
  共享宿主不做 cwd 收割——destroy 链路已按进程组定向杀）+ 释放锁
  （下轮可立即补跑）；beat 持有 → 409 提示走 `pi-loop stop`（web 不代杀本机 beat 进程）。③ frontmatter 编辑 =
  `PATCH …/loops/[name]`（「人的手」：仅 cron/timezone/level/max_minutes 四字段，frontmatter 重序列化、正文 byte 保留；
  cron 改后下一心跳自然生效，`.lastrun` 保留、next-due 按新 cron 重算）。④ Overview Loops 区块（常驻，无 loop 空态 +
  新建入口）：状态总览（cron 人话摘要 `summarizeCron`）/ 暂停恢复（写删 PAUSED）/ 停止本轮；配置/新建走下条。
- **Loop 配置面（2026-09；右坞 S1 修订）**：`components/LoopsConfig.tsx` —— 每个工作区的 loop 管理/创作 UI。
  桌面：Loops 管理/创作全部住**右坞 Loops 模块**（2026-10 rail；`LoopsDockPanel`，常驻渲染无 loop 空态+新建入口；「配置」/「新建」
  在 tab 内推入 LoopsConfig，‹ 返回列表；`loopConfig` 中心顶替与 `useAppShellState` 里的同名状态已退役）；
  总览区块瘦身为摘要行（计数+运行态+→）。移动端：抽屉目的地页 loops（LoopsDockPanel）。能力：创建向导（`pi-loop init`
  脚手架）、frontmatter 编辑（区块内联表单已迁入）、LOOP.md 指针正文编辑（frontmatter 字节保留）、
  知识文档编辑（任意命名，白名单）、STATE.md 只读、删除（锁活 409 / 绑定项二次确认 / SKILL 不删；
  宪法编辑面已随 2026-10-26 退役移除）。**不编辑 SKILL.md**。服务端逻辑全在 `lib/loops/manage.ts`
  （唯一 PUT 写入口 + 文件名白名单 + mtime 乐观并发 + 原子写），路由薄壳
  （`POST /loops`、`GET|PUT /loops/[name]/docs`、`DELETE /loops/[name]`）。
- **工作项工具**新增 `loop` 绑定透传（见上）；外部源同步已下放工作区脚本（见「外部源适配」节）；subagent 一律走内置体系（全局挂载，见下节——kit 轮会话 cwd=workspace 根，profile 按三级作用域发现：builtin < global < workspace < project，同名向上覆盖。2026-10-27 起 dev-loop kit 的四角色剧本住宿主全局 `agents/`、工作区不放同名件，项目差异走 `.pi/prompts/<role>.md` 由编排者派发时读取拼入任务包——合同见 cargoware LOOP.md §五派发通道）。
- **模板**：`kit/templates/basic/{loop,skill}/`（LOOP.md 巡逻指针 + STATE.md 单行 `Last run` 在 `loop/`，SKILL.md 入口合同
  骨架在 `skill/`；`pi-loop init` 由此脚手架，存在即跳过；2026-10-26 终局：`root/` 宪法模板与 ledger 模板已删除——
  LOOP.md 指针正文仍保留「本目录说明文件」步骤，人写知识文档约定如 chandao.md/selection.md，agent 只读、改知识不改 SKILL）、
  `kit/templates/patrol/{LOOP,SKILL}.md`（digest 播报巡逻——拉 attention digest、原样输出、结束）、
  `kit/templates/github/loop.yml`
  （Actions 场景）；`kit/README.md` 是协议契约（含 L1/L2/L3 分级、宿主/beat 用法与调参指引）。

**轮会话是一次性普通会话**：跑完一轮自然 settle，无状态恢复问题（无状态幂等——崩溃即该轮作废，下轮从 SKILL 入口冷启动
重来，不读上一轮残留）；v3 的
双开 guard / `loop.active_session` 戳 / 僵尸收割在「每轮短进程」模型下天然消失。

---

## 心跳宿主与收割口径（自 Key Design Decisions 迁入）

### Loop heartbeats run in the Next.js host; the web layer adds a management surface over the facade
`instrumentation.ts` → `ensureHostBooted()` 装配 `LoopKitSpawner`（HostJob `loop-kit-heartbeats`，**无条件注册**——
`PI_LOOP_KIT` 旗子已随 v3 引擎一起删除）。web 层 loop 面（`app/api/workspaces/[id]/loops/**` + `lib/loops/`）=
文件读取（`packages/pi-loop/status.ts`）+ 经 facade 的操作（「立即跑一轮」两步建会话、无 D9 自动归档；「终止本轮」
facade destroy + 释放锁）——**宿主没有 loop 专属路由**。kit 轮会话是一次性普通宿主会话——与用户会话同注册表，运行
记录 = `STATE.md` + workspace git log。宿主不是唯一心跳源：standalone 根（无 pi-web）由 `pi-loop` CLI 的 `beat`
驱动（任意外部 cron，见 Loop 章）——双宿主并存安全：同一 `packages/pi-loop/fire.ts` 序列 + `loops/<name>/.round.lock`
互斥。`pi-loop run`/`pi-loop stop` CLI 仍服务 standalone 宿主；web 的 run/stop 路由是宿主持有轮的 pi-web 侧对应物。

**Orphan processes after a kit-round kill — 定向杀，共享宿主禁 cwd 收割。** `destroy()` in the shared host is a **targeted** kill: the SDK destroy→dispose chain aborts bash and kills each execution's process group（pi 的 bash 工具把 shell 按进程组 detached spawn，进程级信号由 SDK 负责递达），所以 spawner 的 `max_minutes` 超时路径按设计不留孤儿。cwd 收敛收割器 `reapOrphanedRoundProcesses`（`packages/pi-loop/reap.ts`，SIGTERM→SIGKILL 该 workspace cwd 下的一切 build/shell 进程）因此是 spawner 的**默认 NO-OP 注入点**：同一 workspace 里并行着交互会话/其它轮的进程，按 cwd 杀会误伤它们；注入点留给测试/独立宿主。beat CLI 保留自带收割（standalone 根里只有它自己的轮）。漏网的残余（如硬崩溃）由恢复期**只读探测** `detectSurvivingRoundProcesses`（`lib/loops/executions.ts`：ppid=1 + build/shell 命令 + cwd ∈ workspace）上报为 409 pid，绝不静默击杀。

---

## 外部源适配 = 工作区脚本

### 外部源适配 = 工作区脚本（importer 已退役）

**pi-web 不再内置 importer**：`lib/work-items/importers/`、`app/api/workspaces/[id]/importers/**`、`components/ImporterConfig.tsx`、daemon 的 `ImporterScheduler`/`/v1/importers/sync` 路由及 `requirement-sources` capability 已全部删除（strangler 计划；capability 照 `overview`/`loop` 先例退役——读路径剥离，新写入 400）。外部需求/bug 源（禅道等）的同步 = **工作区自己的脚本**，参考实例 cxin（cxin-workspace 仓内）`scripts/chandao-sync.py`（凭据 `.pi/chandao.json`）：纯 stdlib、凭据存工作区本地（0600 且 gitignored）、日志不打印密码/token，由工作区自己的 cron/loop 触发；脚本直接调 pi-web HTTP API 创建/更新工作项，`external: {source, sourceId, ...}` 章即去重键（重新同步同一条不重复建项），LLM 工作项工具不透传该字段。同步摘要语义（脚本层继承自原 runner 约定）：单条 item 失败不中断同步（failed[] 记录）；结构性失败（登录失败/API 不可达/凭据缺失）退出码 2；已存在未归档项不盖 `imported` 里程碑（防 events 洪水，REQ-0012 教训），仅在摘要计数 synced。工作项的「来源」展示（`lib/work-items/source-labels.ts` 标签映射）保持不变。

---

### Dev Loop (pi-loop kit 实例；reference: cxin-workspace)

**Loops are per-workspace file protocols — pi-web ships no loop engine.** The generic surface is the kit spawner
(`lib/session-host/loop-spawner.ts`) + the `kit/` template library; every loop's behavior lives in its workspace
(`.pi/loops/<name>/LOOP.md` 巡逻声明 + `STATE.md` 的 `Last run:` 叙事行 + `.pi/skills/<pattern>/SKILL.md`
contract + `.pi/agents/*.md` roles). There is no loop authoring UI and no dev-loop code path in pi-web; cxin-workspace's
v3 leftovers (`loop.yaml`/`RUNS.jsonl`/`LEARN.jsonl`, v1/v2 baks) stay in place unread — git history is the audit
(design §8.7: no migration, no deletion).

The **dev Loop** is the R&D loop pattern deployed in cxin (cxin-workspace), migrated to kit form (v3 history:
`dev-loop-v3-design.md`, retired 2026-09, doc removed 2026-10 — see git history). **2026-10-26 终局：dev-loop 停编排**
——loop = 定时巡逻，交付执行一律走 delivery 引擎（loop 会话无 role grant，`delivery_*` 工具不可用）；编排态
（STATE 分区 / 断路器账本 / 宪法两件）随协议退役。cxin 实例的切换由人按 runbook 执行：
`docs/superpowers/specs/2026-10-26-dev-loop-retirement-runbook.md`——切换完成前，下面保留的是退役前的形态描述。
One heartbeat = ONE round session doing selection AND execution:

- **SKILL.md contract** (`.pi/skills/dev-loop/SKILL.md`): opening triple judgment (predictedConf immutable /
  verifiable / riskTier) + evidence pack + thin-SPEC write-through for pure-display items; hard invariants — L0
  branch/merge discipline plus orchestration bounds **N1 maker≠checker, N2 full gate exactly once before merge, N3
  never split across coupling points**; the **dispatch plan** as an explicit artifact (`loop.dispatch{steps[]}`
  milestone; illegal plans are re-composed, bounded); recovery = resume from dispatch plan + milestone gaps
  ("most mature artifact"). Gates: stamp `loop.gate{kind,question}` (via `workspace_record_milestone`) *before*
  asking, then end the turn — the human answers in the composer (also the UI's 待-decision audit signal).
- **Roles** (`.pi/agents/*.md`, injected per-session via `extraAgentDirs`, no approval gate): **brainstorm**
  (全链路 trace + 反证, produces `SPEC.md` = what-contract + task DAG), **writing-plans** (optional plan step for
  multi-task/sensitive items), **implementer** (TDD maker, one per task, worktree-isolated, draft branches only —
  human merges), **checker** (single check seat, review-then-run, rework list routed by source
  code/plan/spec), **learner** (knowledge consolidator, see Learn below).
- **Run state（2026-10-26 退役前形态）**: `STATE.md` 分区（High Priority / Watch List / Recent Noise / [BUDGET] / Post-run critique）+
  `.pi/loops/<name>/loop-ledger.json` 断路器（same error digest ×3 or >3 attempts on one item → escalated）与根级宪法
  （`.pi/loop/constraints.md` path blacklist + discipline、`.pi/loop/budget.md` caps，workspace 全 loop 共享，agent-immutable）
  **已从协议退役**——kit 不再创建/读取/展示，现存文件留在原地不读（git 历史即审计）；巡逻形态的运行态只有 `STATE.md`
  的 `Last run:` 叙事行，工作集/进度/预算归 delivery 引擎。
- **API**: the pi-web loop surface is `GET /api/workspaces/[id]/loops`（全量状态，附 `interruptions`）+ per-loop `run|pause|resume|stop|recover` / frontmatter `PATCH`（`lib/loops/`，见 Loop 章——全部经进程内宿主 facade，依赖注入，宿主无 loop 专属路由）。
  standalone 宿主用 `pi-loop` CLI（beat/run/stop/status/init）。

### Learn (archive inline; consolidation via the `learner` agent)

**Qualitative knowledge transfer via consolidation, not per-run archiving.** Knowledge lives ONLY in KB `learnings/` notes, kept sharp by merging; run records are archives nothing reads for decisions.

- **Learn step** (terminal; idle runs excluded): the round session ① writes `.pi/loops/<name>/LEARN/<run-id>.md` — a human-browsable archive (lesson candidate, learner's disposition, index fields incl. **both** `predictedConf` and `tracedConf` so the calibration chain closes; idempotent replace) and ② dispatches the **`learner`** only if a candidate exists. **`LEARN.jsonl` is retired/frozen** in place (its old `humanDecision` narrative was the "summarizing the run" failure mode).
- **learner = consolidator**: two-question generalization test — (1) is it still a rule with specifics deleted? (2) is it an instance of an existing rule (`kb_search`)? Then: merge-and-sharpen into an existing loop-owned note (abstraction lift **allowed but must stay instance-anchored**; trigger scenario inlined into the note's instance section) OR open a new file referencing near-kin. **`contentHash`** frontmatter guards against overwriting human edits — mismatch ⇒ the note is human-authoritative, degrade to new-file+reference.
- **Single home**: everything loop-written goes to `learnings/` (module traps too, with strong module tags); `standards/*` is **purely human-maintained** (the old "loop append" clause is gone — it had no executor). One note touched/created per run max.
- **Three artifacts, three purposes**: KB `learnings/*.md` = consolidated generalizable rules (loop-maintained via hash guard); `standards/*` = human-maintained; `.pi/loops/<name>/LEARN/<KEY>-<date>.md` = per-execution archive (nothing parses it; the SKILL opening may `ls -t` it for calibration).
### cxin reference (研发 Loop target workspace)

- **dev Loop instance**: `/Users/qiancheng/Documents/Workspace/cxin/`（2026-09 由 pi 托管的 workspace-c
  拆解搬入并退役，外部路径导入，workspace id 沿用 01KYRBBY917PW4X0VHMY5GC8TE）in **kit form**: `.pi/loops/dev-loop/LOOP.md`
  (kit frontmatter; cron `*/30 9-22 * * 1-5` Asia/Shanghai; **L2** — migration exception, dev-loop 已在 v3 真实运行多月视为已过
  L1 验证；全新 loop 一律 L1 起步)。`STATE.md` 分区脊柱、根级 `.pi/loop/constraints.md` / `.pi/loop/budget.md` /
  `.pi/loops/<name>/loop-ledger.json`（shared per D13）= **2026-10-26 退役前形态**（文件留存不读，切换按 runbook：
  `docs/superpowers/specs/2026-10-26-dev-loop-retirement-runbook.md`——dev-loop 停编排、禅道同步与 digest 改挂 `patrol` 模板）,
  contract in `.pi/skills/dev-loop/SKILL.md`（六点改造：选择/执行合并为一轮、gate 里程碑由**轮自己**盖、
  双开 guard / `loop.active_session` 戳删除）, roles in `.pi/agents/` (built-in discovery: flat `*.md` profiles — see Subagent below). v3 leftovers (`loop.yaml`, `RUNS.jsonl`,
  `LEARN.jsonl`, v1/v2 baks) stay in place unread. Sensitive module list + module→repo map:
  `cargo-knowledge/standards/dev-loop-modules.md`; consolidated process lessons in `cargo-knowledge/learnings/`
  (contentHash'd).
- **Host wiring**: `instrumentation.ts` boots the in-process host — `ensureHostBooted()`（`lib/session-host/background.ts`：
  老 daemon 迁移守卫 → LoopKitSpawner（`loop-kit-heartbeats`, unconditional）→ shutdown handlers）
  + 默认工作区补建，两者均 fire-and-forget。没有第二个进程。
