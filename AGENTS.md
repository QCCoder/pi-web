# Pi Web - Development Notes

Pi Web is a web UI for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It runs a Next.js
server that owns **AgentSessions in-process**, plus a **Workspace** subsystem (manifest/capability/repositories,
work-items, loop, subagent, git/changes) layered on top.

> **Read this first when changing the project.** It documents the *current baseline* code. When you add or change a
> module, update the corresponding section here so the next person doesn't reinvent it (see
> `docs/workspace-redesign.md` §1 for why this file drifted before).

---

## Quick Start

```bash
npm run dev    # Next.js dev server on http://127.0.0.1:30141
               # 单进程（2026-10 M1）：Next.js Node.js server 就是会话宿主——所有会话/
               # subagent/loop 轮都在这一个进程里（见 Key Design Decisions 的 Session Host 节），
               # 没有独立 daemon 进程了
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
Tests: `npm test` (node:test over `lib/**/*.test.mjs`)

**Optional — pi data home inside the repo**: `node scripts/adopt-pi-home.mjs` moves `~/.pi/{agent,workspaces,workspace.yaml}`
into `<repo>/.pi/{agent,workspaces,workspace-index.yaml}` and writes `.env.local` pointing the three env vars
(`PI_CODING_AGENT_DIR` / `PI_WORKSPACES_DIR` / `PI_WORKSPACE_INDEX_FILE`) there — workspaces, skills and sessions become
visible in the project tree. `.pi/agent` + `.pi/workspaces` are gitignored (auth tokens live there) and excluded from
tsc/eslint/git-discovery; `.env.local` is loaded by Next.js itself (single process — see "Local pi data home" under
Key Design Decisions).

**Never run `next build` during dev** — it pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

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

- **Session browsing** (read-only): list views are served from the **persistent session index** (`lib/session-index.ts`, mtime+size incremental over `~/.pi/agent/sessions` incl. `.archived/`, cache file `~/.pi/agent/sessions/.index.json`, rebuildable, tmp+rename atomic write, failed saves retried in background via a dirty flag; schemaVersion 2 — v1 clipped `/skill:` expansions mid-wrapper, so firstMessage is now skill-reduced BEFORE the 400-char truncation, and the bump discards the stale cache for a one-time rebuild). **The in-process memo is TTL-bound (`PI_SESSION_INDEX_MEMO_TTL_MS`, default 3s)** — once it served a forever-snapshot, session files written outside the walk (the host spawning subagent children / loop rounds — pre-M1 these came from a separate daemon process; today same-process writes are caught the same way) stayed invisible to locate/detail/list until a web restart, which resurfaced as "opening a subagent (child) does nothing / opens blank"; now every TTL expiry re-runs the cheap incremental walk (stat-heavy, not read-heavy) through the single in-flight promise. `listAllSessions()` in `lib/session-reader.ts` maps index entries to `SessionInfo` (firstMessage truncated to 160 chars for display — the raw text once inflated the payload to 1MB+); `GET /api/sessions?archived` and `listArchivedSessions()` derive from the same index; `GET /api/sessions/[id]/locate` resolves by id through `findSessionIndexEntry` (display title via the shared `firstMessageTitle`) and — on the live-registry probe hit (`facade.probeSession`) — also seeds `cacheSessionPath` from the probe's `sessionFile`, so a just-spawned child whose .jsonl isn't flushed yet still opens (detail answers the empty-but-valid placeholder, live SSE renders on top). Opening a session detail still reads the whole .jsonl via SDK `SessionManager`, but the response is a **tail window** (`?tail=100`): `buildSessionContext(..., { tailMessages })` maps only the last N entries and sets `hasEarlier`; older pages arrive via `GET /api/sessions/[id]/earlier?before=<entryId>&limit=&leafId=` (`buildEarlierContext` — needs an explicit leaf, defaults to the session's current leaf). The client (`useAgentSession.loadEarlier` + ChatWindow prepend detection) grows the window as the user scrolls up; `VISIBLE_PAGE_SIZE` render-windowing in `lib/chat-lazy-load.ts` sits on top of the loaded window — **first render is staged** (2026-09): `INITIAL_VISIBLE_COUNT = 10`, then a rAF chain in ChatWindow grows `visibleCount` by `STAGED_VISIBLE_STEP = 10` per frame up to `getStagedTargetCount`（= min(50, messages.length)；步长前保存距底距离，复用既有 restore effect 保位）。 Motivation: dev 冷 JIT 下首开大会话，消息到达与 loading=false 同 tick 批处理成一次同步挂载满窗 50 条（react-markdown 全家桶 + Prism），主线程被占满、「正在加载会话…」挂数秒（服务端/网络无率，实测亚秒）。 哨兵 observer 的滚动增长语义不变；短内容时哨兵可见直接整页跳满，天然兼容。
- **Sending a message**: the web routes call the **in-process session host facade** (`lib/session-host/facade.ts`, direct function call — no proxy, no second process), under which `startRpcSession()` in `lib/session-host/registry.ts` creates the AgentSession. At creation it resolves the enclosing **Workspace** (if any) and attaches that workspace's extensions + skills + AGENTS.md.
- **Workspace management**: `app/api/workspaces/**` reads/writes `~/.pi/workspaces/**` and `~/.pi/workspace.yaml` (the global index). Capability edits, repository add/remove, work-item CRUD) all flow through this surface. Kit loops are plain files under the workspace root — the loop management surface is `app/api/workspaces/[id]/loops/**` (status/pause/resume/frontmatter edit/manual round/stop/recover) + the WorkspaceOverview Loops block; heartbeats run inside the Next.js host (LoopKitSpawner, see Session Host).

---

## Workspace Subsystem

The largest subsystem and the one most often misunderstood. **Read this before touching anything workspace-related.**

### Model: manifest, capability, repository

A **Workspace** is a directory `~/.pi/workspaces/workspace-<slug>/` (root = `$PI_WORKSPACES_DIR` or `~/.pi/workspaces`)
with a manifest at `.pi/workspace.yaml` (`WorkspaceManifest`, schemaVersion 1, `lib/workspaces/types.ts`):

```yaml
schema_version: 1
id: <ULID>
slug: my-proj
name: My Project
template: { id: software-development, version: 1 }   # OPTIONAL/legacy — new workspaces omit this
template?: { id, version }                          # (see "Template selection removed" below)
skills: []                                          # new workspaces start with no skills
capabilities: [sessions, explorer, work-items, repositories, knowledge, ...]  # always written explicitly
repositories: [{ id, alias, name, kind: code|knowledge, path: <相对工作区根的 POSIX 路径>, status: active|removed, removed_at? }]
agent: { default_model?, thinking_level? }
disabled?: true                                   # 用户暂时停用（2026-09）：首页/选择器不可见，
                                                   # 不影响已开 tab/loop 心跳/会话装配；false 时键整个剥掉。
                                                   # 重启用面 = 设置›工作区（桌面项目树树底 ⚙ / 移动端首页
                                                   # ⊞ 暗淡行与 ⚙ 入口均深链预选直达——2026-09 修复：停用后
                                                   # 不能从所有面上消失到找不回）
git: { branch_rules: { requirement, bug }, create_after: plan_approved }      # only when work-items is on
work_items: { next_requirement_number, next_bug_number }
created_at / updated_at
```

- **Workspace index v2**: `~/.pi/workspace.yaml` is schemaVersion 2 —— strict，无迁移路径（2026-09 一次性迁移已收敛删除：读到非 v2 索引直接报错；索引文件缺失时才走 `rebuildWorkspaceIndexFromScan` 扫描重建）。条目可携带可选 `sort_order`（手动排序，2026-09：设置列表拖拽 → `PATCH /api/workspaces { order }` 重编 1..N，一次写；`registerWorkspacePath` 重建条目时透传保留；**项目树工作区节点同样可拖拽（2026-09）：drop 到节点上半/下半 = 插到它前面/后面（列表尾空区 = 移到末位；插入指示线 = globals.css 的 `workspace-drop-line` 入场动画，树与设置›工作区 rail 同构），同一 PATCH 全量期望序（未入树的停用/不可用项保持现序垫底——`updateWorkspaceOrder` 会删未提及条目的 sortOrder，不能传部分列表）**）。`discoverWorkspaces` 终排序 = 可用优先 → 手动序升序在前 → 未设置条目按 lastOpenedAt 降序（MRU 兜底；一旦拖过一次全部条目都有 sortOrder，列表即固定不再随活跃度跳动）。 `WorkspaceManifest.capabilities` is REQUIRED —— `parseWorkspaceManifest` throws "capabilities is required" without it; read `manifest.capabilities` directly.
- **WorkspaceRepository**: `{ id, alias, name, kind: "code"|"knowledge", path, status }`. **path** 是相对工作区根的
  POSIX 路径（校验：禁绝对路径/`..`/`.pi` 内）。**自动登记（2026-09「扫描为事实，manifest 只存记忆」）**：
  `listWorkspaceRepositories` 打开即跑 `syncRepositoriesFromScan`——`lib/workspaces/scan.ts` 从根扫 git 仓
  （`.git` 为目录；worktree 的 `.git` 文件不算）与 OKF 知识库（`index.md`+`log.md`，优先于 git 判定；点目录/
  node_modules/.worktrees 剪枝、发现即停、深度 4），新目录自动登记（alias=目录名规整、冲突加后缀）、消失自动
  停用、重现自动恢复；manifest 已有条目的 alias/kind 是钉住覆盖，扫描不改写。新仓顺带写入根 .gitignore。
  clone/init 仍是显式操作；`kind` 只驱动 UI 标签与（knowledge 时）**OKF seed**。Note: `knowledge` is *also* a
  top-level `WorkspaceCapability` (the UI "知识库" toggle); the repository `kind` and the capability are separate
  concerns — the capability gates the module/UI. (`docs/workspace-redesign.md` §5.1)
- **Template selection removed (redesign decision 5/7)**: creating a Workspace is **capability-driven** —
  `CreateWorkspaceInput = { name, slug, capabilities[] }`, no `templateId`. `createWorkspace()` validates the selection
  via `parseCapabilities`, force-includes the mandatory `sessions`+`explorer` (`normalizeInitCapabilities`), writes
  `manifest.capabilities` explicitly, and **omits `template`**. Per decision 6 (lazy directories) it does **not**
  pre-create `requirements/ bugs/ designs/ plans/ repositories/` — those are `mkdir -p`'d on first use (work-item
  creation, repo clone/init). It writes `.pi/workspace.yaml` + a capability-driven `AGENTS.md` always, and `git init`s
  the workspace repo only when a git-using capability (`repositories` **or** `work-items`) is selected (git branch
  rules are set only when `work-items` is on). Built-in templates are gone — manifests are capability-driven only.

**默认工作区（2026-09，初始化补建）**：web 进程启动时（`instrumentation.ts`，fire-and-forget）
`ensureDefaultWorkspace()`（`lib/workspaces/service.ts`）补一个轻量「默认」工作区（name `默认`、slug
`default`，capabilities 仅强制核心 `sessions+explorer`，不 git init、不建内容目录），供随手问答/搜索——
避免「不选工作区裸聊」：无归属会话会被 `groupSessionsByWorkspace` 丢弃、在首页/树里不可见，真工作区
是唯一安全落点。幂等规则：slug `default` 已登记（含外部路径导入的同 slug）→ 不动；墓碑
`<工作区根>/.pi-default-deleted`（`removeWorkspace` 删默认时写；删除是注销制、目录保留）在场 →
永不复活；目录在磁盘但未注册 → `importWorkspace` 自愈重注册。ensure 永不抛（初始化路径降级为日志）。
存量用户升级后也会补建一次；删掉后想要回 = 手动新建普通工作区。

### Capability system & extension mounting

`WorkspaceCapability` (`types.ts`) is the per-workspace module switch (includes `knowledge`, promoted from a mere
repository `kind` to a first-class capability — redesign decision 4, type layer). **`ALL_WORKSPACE_CAPABILITIES`** in
`lib/workspaces/service.ts` is the validation registry (the source of truth for which capabilities can be persisted):

```
sessions, explorer, work-items, repositories, knowledge, workflows
```

(PATCH capabilities are normalized by `normalizeUpdateCapabilities`: the mandatory `sessions`+`explorer` core can never be dropped. `parseCapabilities` rejects anything outside `ALL_WORKSPACE_CAPABILITIES` with "Unknown capability" —— retired values (`feishu-transport`/`feishu-channel`/`wecom-channel`/`overview`/`loop`/`requirement-sources`) are simply unknown now, no read-path strip, no migration: a manifest still carrying one is config-invalid.)

- `manifest.capabilities` is required and always present (see "Workspace index v2" above). Read it directly; there is no derivation helper.
- **`parseCapabilities()`** rejects anything not in `ALL_WORKSPACE_CAPABILITIES` (`WorkspaceValidationError` → **HTTP 400**). To add a toggleable module you must (1) add the value to `ALL_WORKSPACE_CAPABILITIES` *and* the `WorkspaceCapability` type, (2) add an extension factory, (3) add a config UI panel.
- **Extension factories** (`lib/workspaces/extensions.ts`, `WORKSPACE_EXTENSION_FACTORIES`) turn a capability into an LLM-callable tool extension: `work-items` → work-item tools, `work-items` ∧ `workflows`（合取——第二个 work-items 工厂条目在 build 内补 workflows 检查，Phase-2 交付自动化）→ `delivery_*` designer/developer tools, `knowledge` → `kb_search` (opt-in ranked retrieval; coexists with always-on L0). **`subagent` is deliberately NOT registered here** (see Subagent below).
- **Attachment point**: `buildWorkspaceExtensions(manifest, path)` filters factories by `manifest.capabilities`. `lib/session-host/registry.ts` (`startRpcSession`) always attaches the built-in subagent extension globally (`createSubagentExtension` — see Subagent below), then — when the session's cwd is inside a workspace — appends `buildWorkspaceExtensions(...)` and filters skills to `manifest.skills`.
### AGENTS.md auto-management (managed segments)

Each workspace may carry an `AGENTS.md` at its root. **`renderWorkspaceAgents(manifest, capabilities)`** is the
**capability-driven** generator (redesign decision 9): it emits a title, a collaboration-flow block when `work-items`
is on, a `<!-- workspace-managed:git:start/end -->` block when the manifest has `git` settings, and the repositories
block — **without depending on a template id**, so template-free workspaces still get a tailored policy. The legacy software-development template renderer was deleted alongside the template system.

The **repositories** block is *auto-maintained* between managed markers:

```
<!-- workspace-managed:repositories:start -->
## Workspace repositories
- `alias` (code, id: `...`): `repositories/code/alias`
<!-- workspace-managed:repositories:end -->
```

`updateManagedRepositoryInstructions()` (called on repo add/remove/restore) replaces the block by the regex
`<!-- workspace-managed:repositories:start -->[\s\S]*?<!-- workspace-managed:repositories:end -->` with a fresh
`renderWorkspaceRepositories(manifest)`. It is a **no-op if the markers are absent** (it never creates them) and only
runs when the `repositories` capability is effective. `pi` injects `AGENTS.md` into the system prompt **verbatim** —
there is no `@`-include expansion; large content must be *referenced* and the model follows the reference to `read` it.

### Navigation: tree sidebar | main area（2026-09 树形侧栏改版，grill 共识）

Desktop is three vertical strips: **`[ProjectSidebar tree sidebar 200–560px drag-resizable/collapsible] [main area: ChatToolbar + SessionTabBar + CenterPage/Overview/chat] [file dock 42%, default-OPEN]`** — the 44px icon rail + middle-column-panel pair is RETIRED (W-中收敛后栏里只剩一个模块图标，为它维持双轨不值）；左侧合并为单一树形侧栏。**作用域即位置：树 = 工作区资源（会话/归档），顶部+底部 = 全局配置入口（顶部 插件&技能，底部 设置/模型/Agents；打开时可带工作区上下文）。** The top tab bar is SESSION-keyed（2026-09 会话 tab 化，docs/session-tabs-design.md）：每个 tab = 一个会话/新会话占位/工作区家 tab（总览），跨工作区混排；`SessionTabState` 纯逻辑（C1 点击分派/X1 邻居回落/U1 去重/URL 投影/R2 持久化恢复）在 `lib/session-tabs.ts`（+测试）。工作区从一级容器降级为跟随当前 tab 的环境上下文（`activeWorkspace = activeTab.workspace` 链不变）。交互：列表普通点击=当前 tab 原地变身（家 tab 上点击=开新 tab）、Cmd/中键=新开、fork=新 tab、关 tab=先左后右邻居回落（最后一个→首页）、会话删除/归档自动关 tab；＋=当前工作区开新占位 tab（**2026-09 占位去重：`openNewSessionTab` 内置 `findReusableNewSessionTab` —— 同工作区已有「未发起」（composer 草稿为空：无文字/图片/文件）的占位 tab → 激活复用不重复创建；草稿非空不笫「未发起」（复用会冲字），照旧开新 tab；工作项预填/insertIfEmpty 因此天然安全**）；**＋ 新占位 tab 先渲染 HomeLanding 首页内容（问候语/最近分组/工作区面板，两 shell 同构——2026-09「都要变」；点大输入卡才展开 composer，显式「新建会话」入口经 newSessionDirect 标记绕过首页直落 composer）**；**⊞ 工作区选择器已删除（2026-09：桌面早退役走项目树，移动端亦删——工作区切换走 设置›工作区；组件内 picker 代码与 onPickWorkspace prop 一并移除）**；tab 条全量存 `pi-session-tabs`，重载恢复（失效 id 静默跳过，URL 深链优先决定 active）；只挂载当前 tab 的 ChatWindow，tab 徽章靠 running/events 全局流。**移动端不渲染 SessionTabBar（2026-09 树抽屉重构：chips 行删除，切会话走抽屉树，见「移动端抽屉」节；组件保留给桌面）**。** **2026-10 右坞三次改版（docs/right-dock-design.md §13，反转 §12「模块 tab 按需打开」——「打开 cxin 看不到工作项/Loops」）：右坞 = 44px 常驻图标列（rail）+ 展开面板，**IDEA 形态：图标列贴窗口最右缘、面板从其左侧展开（激活指示条 = 图标右缘 border-right）**。图标列五项 **文件 / Loops / 工作项 / 知识库 / 终端**（终端从文件条混排扶正为第五模块）；点未激活图标 = 切模块并展开，点**已激活**图标 = 收起到只剩 rail；**rail 在有工作区上下文的形态下永不消失**（配置整页打开/无工作区上下文时整个右坞隐藏）。激活模块 + 展开态 **per-workspace 持久化**（`pi-dock-rail`，useAppShellState 的 `dockRailMap` + `dockRailFor/openDockModule/setDockExpanded` 原语），默认 `{文件, 展开}`。**文件 tab 住「文件」模块面板内横条**（`[文件(树) | file1 | …]`，`FILES_TAB_ID` 仍是文件树伪 tab；F1 沿用：文件 tab 状态挂会话 tab，关最后一个回落文件树）；任何路径打开文件 → `handleOpenFile` 统一 `openDockModule(wsId, FILES)` 自动切模块+展开。**终端 tab 住「终端」模块面板内横条**（`[终端1 | 终端2…] + ＋新建`；per-cwd 复用/重启/常驻挂载语义保留，激活选中 = DesktopShell 自持 `activeTerminalId`，不再借道 `activeFileTabId`——后者回归纯文件语义）。`dockModuleTabs`/`ensureDockModule`/坞排空收起逻辑**退役**；工具行删「文件」捷径、WorkspaceSwitcherPanel 桌面不再传 `moduleEntries`（转可选，rail 是唯一桌面模块入口；总览 hub 按钮保留 = 激活 rail 项）；宽度语义 = 整个右坞（min 344 = 44+300，收起态固定 44px 无拖拽把手），顶部固定 toggle 按钮退役；门控沿用（knowledge/work-items capability 没开则图标不渲染，Loops/终端常驻）；模块体仍按 workspace key 常驻挂载（决策 #6）。**2026-09-27 二次改版（§12：模块 tab 按需打开 + 工具行/切换面板入口）与 2026-09 S1（tab 化扩展坞、`leadingTabs` 钉死模块组）均为历史形态，已被 §13 取代。**

**会话侧栏 = `components/ProjectSidebar.tsx`**（2026-09-27 侧栏瘦身：原项目树退役——工作区节点/模块行/hover 快捷键/拖拽排序/「项目＋」菜单/折叠持久化全部移除；工作区切换 + 模块入口 = 顶部工具行「工作区名 ▾」的 WorkspaceSwitcherPanel 两端共用面板；侧栏 = headerSlot（移动端抽屉头切换块）+ 新建任务/搜索/插件&技能 三行 + **「项目」分区行**（📁 图标 + 13px 标题与导航行同字号 + 「# 分组」chip + 右端 ＋ 新建工作区/导入目录菜单 + 收起/展开 chevron——收起整个项目列表[含归档行]，持久化 `pi-projects-collapsed` 缺省展开）。分组组头（2026-09-27 晚回归折叠）：整行可点收起/展开该项目会话（持久化沿用 `pi-tree-collapsed`，老用户偏好自动延续）+ **会话清单**（2026-09-27 晚「# 分组」开关：开 = 全部项目分组[静态组头，每组 5 条+显示更多]；关 = 最近活跃平铺[前 20+显示更多]；持久化 `pi-sidebar-grouped` 缺省开；归档行 = 当前工作区回收站）+ 底部 设置/模型/Agents。树时代描述存档：顶部「＋ 新建任务」= 上下文快速路径（有活动工作区→handleWorkspaceNewSession 开新占位 tab，首页→handleReturnHome 首页 composer）；**两 shell 的新会话占位 tab composer 控制行都带工作区选择器**（共享 `WorkspaceSelector`，从 HomeNewSession 抽出；占位 tab 改选 = 原地重定向，同 id 保草稿，DesktopShell/MobileShell 均经 ChatWindow inputLeadingControl 注入，2026-09 补齐移动端；家 tab workspace-home 不加——工作区是它自身的语义）；折叠/展开由 ChatToolbar 的 ☰ 开关承担；「工作区」分区标题（与新建任务左对齐）+ 右侧 ＋（新建工作区/导入目录菜单，body-portal）；工作区节点（缩进一级，**整行 = 展开/折叠开关**——文件夹开/合两种形态；**hover 右侧出 工作区首页🏠/归档🗑 两个快捷按钮**，取代徽章/计数，SessionRow 同款 hover-action 模式；不选中高亮；总览/归档由此入口）→ 会话行直挂（共享 `SessionRow` rounded：Cmd/中键新 tab + 行内归档 + 徽章 + 选中圆角高亮；**每组默认 5 条，超出收进「显示更多（共 N）」**，展开为会话内临时态）+ **组尾暗淡「归档」行**（作用域就地）；不可用工作区暗淡行挂树底；顶部第三行「插件&技能」导航行 + 底部三入口 strip（设置/模型/Agents；圆角按钮内缩）。折叠持久化 `pi-tree-collapsed`；骨架门控同旧（未加载渲染骨架行）。会话分组复用 `lib/home-quick-switch.ts` 的 `groupSessionsByWorkspace`（含空工作区的 header-only 组），但**树用 `orderBy:"workspaces"` 保持传入列表序（= 手动排序），不按活跃度自动重排（2026-09）；工作区节点可拖拽排序（drop 到节点上半/下半 = 插前/插后，列表尾空区 = 移到末位，插入指示线 `workspace-drop-line` 带入场动画）→ `onReorderWorkspaces` 全量 PATCH；移动端首页「最近」仍用默认 activity 序**。知识库/工作项/Loops/工作区切换不进侧栏（2026-09-27 瘦身：住顶部切换面板 + 右坞 + 总览 hub，见下）。
**中央区整页（CenterPage，`useAppShellState` 的 `centerPage` 状态；2026-09 配置页拆分）**：**设置 / 模型 / 插件&技能 / Agents 四个独立配置整页 + 归档**（工作区作用域）+ **工作项管理整页**（2026-10 M2，`kind: "work-items"`——不走 ConfigCenterPage，页面本体是 `components/work-items/WorkItemsPage`，深链 `?workspace=<id>&page=work-items[&item=<key>]` 见「工作项」条目与 Work Items 章）。此前四入口共用一个两栏设置页只换预选分区（页头永远是「设置」、左索引列永远全量六项），用户反馈「跳转的页面都一模一样」，拆分后每个入口一页：页面本体 = `ConfigCenterPage`（`components/ConfigCenterPage.tsx`）——**整页打开时 DesktopShell 隐藏会话 tab 条（2026-09 用户反馈「点击插件和技能的时候为什么还有顶部 tab」；tab 条隐藏后回聊天 = 页头 ✕ / 侧栏点会话 / toggle）**，页面 chrome 为 ZCode 市场页同款 hero：accent 图标章 + 大标题（19px/700）+ 描述行（`PAGE_DESCRIPTIONS`）+ meta + ✕，多分区页用**分区 pills**（ZCode「公开/个人」同款分段按钮：设置 = 工作区/偏好，插件&技能 = 插件/技能）；设置›工作区 = inline-split WorkspaceManager 经 workspaceSlot 注入（meta 用 workspaceSettingsName），偏好分区 = PreferencesPage（居中 700px 文档流），模型/Agents 单分区页直接宿主 Config 组件（内部 列表+详情 分栏即两栏视觉），**插件&技能页的 插件/技能 分区 = `market` 布局**（2026-09 ZCode 市场同款：`PluginsConfig`/`SkillsConfig` 的 `market` prop——搜索框 + 「已安装」卡片网格（图标章 + 名称 + 摘要/描述 + 启用开关 + 详情/检查更新/移除）+ 添加区（技能 = AddSkillPanel skills.sh 远程市场搜索安装）+ 详情弹窗（PackageDetail/SkillDetail 全量复用）；与分栏模式共用同一套状态与操作，移动端设置子页仍为 embedded 分栏）。设置›工作区 = inline-split WorkspaceManager 经 workspaceSlot 注入（meta 用 workspaceSettingsName）；偏好分区 = PreferencesPage（居中 700px 文档流）。页内分区切换写 `settingsPage`（兼作分区记忆，不动 centerPage 身份）；点任何会话 tab（activateTab）即关闭回聊天；从不持久化；toggle 语义（同页再点关，异页原地切换）；导航高亮 = 页粒度（DesktopShell 传 `activeConfigPage = centerPage.kind`，不再跟页内分区实时切换）。归档 = ArchiveModal embedded（带工作区名 meta）。移动端不经 ConfigCenterPage：抽屉导航四入口统一落设置目的地页对应子页，面板仍是 `SettingsPanel`（全行索引 + 内嵌子页；desktop 两栏模式与 `DESKTOP_NAV_SECTIONS` 已删除）。Skills/插件面板保持双作用域（全局 + 当前工作区项目层，`settingsCwd`/`globalOnly` 不变）；模型保持全局默认 + per-session 选择器（manifest.agent.default_model 死字段不激活）。**右坞面板内容体不变**（2026-09 S1/S2/S3；**2026-10 rail 改版：模块入口 = 常驻图标列，见 Navigation 右坞节**）：工作项 = WorkspaceManager panel 模式，知识库 = KnowledgeBrowser，Loops = LoopsDockPanel；总览 hub 不变（模块按钮经 `openRailModule` 激活 rail 项 + 展开）。配置整页打开时工作区工具行随 SessionTabBar 一起隐藏，右坞（rail + 面板）整体也隐藏。
**The standalone 仓库 view is REMOVED** — repo browsing lives in the 工作台 file tree, add/manage in 设置 › 工作区 + the overview dashboard. Stale `pi-active-view` values pointing at removed views fall back via the `visibleActivityViews` validation.

The panel bodies（树形侧栏改版后）：左栏只剩 `ProjectSidebar` 一棵树（见上）；配置/归档面全部走中央区整页（CenterPage，见上）。知识库/工作项/Loops 住**右坞**（S1/S2/S3 内容不变；2026-10 rail 化后 = 常驻图标列的模块面板）：工作项 = **右坞工作项模块（`WorkspaceManager` panel 模式：列表→详情面板内推进航；门控 = work-items capability（图标不渲染）；总览工作项按钮/新建 → 激活 rail 项；2026-10 M2 T10：面板列表数据走共享 `useWorkItems` store（与中央 `WorkItemsPage` 同一缓存/轮询器，mutation 一律 invalidate()，两面即时互见；「查看归档」从此有数据——旧本地拉取只取 items 恒空），面板顶部「打开完整管理」→ `openWorkItemsPage(wsId)` 开中央整页（rail 图标单击语义不变）；移动端 = 抽屉目的地页 work-items 宿 `WorkItemsPage` 本体（窄屏 ≤640px 自适应：页头瘦身、看板回落为阶段筛选列表、详情全屏覆盖；`createRequest`/`onBack(‹聊天)` 透传）**；知识库 = **右坞知识库模块（`KnowledgeBrowser` 直挂：chips 选 bundle + FileExplorer + open index.md 提示；门控 = knowledge capability；总览知识库行 → 激活 rail 项；移动端 = 抽屉目的地页 knowledge）**；Loops = **右坞 Loops 模块（`LoopsDockPanel`：列表+状态/暂停恢复/停止本轮/「运行」手动起轮 + 配置/新建内联 LoopsConfig 推导航）**；总览 Loops 区块瘦身为摘要行（`onOpenLoopsTab` → 激活 rail 项）；frontmatter 编辑在 LoopsConfig 配置面，见 Loop 章「Loop 配置面」；STATE.md + workspace git log remain the run observability。设置/模型/插件&技能/Agents 桌面 = `ConfigCenterPage` 独立整页（见上）；移动端 = `SettingsPanel` 全行索引 + 内嵌子页，归档行仅移动端。 The remaining `WorkspaceManager` modal is the home create-workspace wizard only.

**Persistence**: tab strip (`pi-session-tabs`), sidebar width (`pi-sidebar-width`), tree collapse (`pi-tree-collapsed`). The old panel keys (`pi-active-view:<wsId>` / `pi-active-panel`) are RETIRED with the middle column — centerPage 从不持久化。`applyUrlToTabs` only understands the URLs `buildTabQuery` emits (overview/chat); legacy `?view=` spellings are gone — stale bookmarks land on the workspace home tab.

- **项目树侧栏（桌面，`ProjectSidebar`）** — **2026-09 树形侧栏改版（取代图标栏 + 中栏工作台双轨）**：
  新建任务按钮（新会话 composer 入口）+ 工作区分区（工作区节点（整行=展开/折叠，hover 出 工作区首页/归档 快捷钮）→
  会话行直挂（默认 5 条 + 显示更多）+ 组尾归档行；不选中高亮；折叠持久化
  `pi-tree-collapsed`；运行/完成活动点）+ 不可用工作区
  暗淡行 + 分区 ＋（新建工作区/导入目录）+ 底部五入口（设置/模型/插件/Skills/Agents → 打开设置页预选对应分区）。会话行 = 共享
  `SessionRow`（rounded：选中圆角高亮；Cmd/中键新 tab、行内归档、徽章）；折叠/展开 = ChatToolbar 的 ☰；
  侧栏默认宽 300px（2026-09 两轮反馈：200 太挤 → 260 仍偏小；拖拽范围不变，双击把手重置到 300）。
  全局会话分组/排序复用 `lib/home-quick-switch.ts`；移动端首页 `HomeSessionGroups`（组头点击=进工作区）不受影响。
- **「文件」（桌面右栏钉死 tab / 移动端抽屉目的地页）** — `components/FilesExplorerPanel.tsx`：toolbar = `[ 文件 | 改动(N) ]` segmented switch
  (`pi-explorer-tab:<wsId>`, git repos only — one key for both surfaces) + ⟳ manual refresh
  (bumps a local key stacked onto the shell-driven `explorerRefreshKey`, feeding BOTH `FileExplorer.refreshKey` and `useGitStatus` —
  external deletions/edits have no event, only agent turns auto-refresh at `agent_end`; `FileExplorer`'s refresh effect invalidates the
  WHOLE cached directory subtree under cwd via `invalidateUnderPrefix`). Below: `FileExplorer` (cwd = workspace root) or `ChangesPanel`.
  The Loops panel's reveal signal (`loopFilesReveal`) routes here — DesktopShell activates the「文件」tab / MobileShell opens the
  文件目的地页, and the panel switches its segmented back to 文件 on reveal (tree invisible otherwise).
- **移动端抽屉（2026-09 树抽屉重构，docs/mobile-drawer-design.md）** — 底部 tab 栏、头部会话 chips 行、`MobileSideRail`、
  `WorkspaceHomeMenu` 全部退役：抽屉是唯一定期导航（内容 = `ProjectSidebar` 移动变体 `showModuleRows`：工作区树 + 展开节点下的
  模块行[文件/工作项/知识库/Loops，capability 门控] + 节点常显 ＋/🗑[触屏无 hover] + ⌘K 搜索 + 底部设置条），聊天是主区默认；
  非聊天目的地（文件/工作项/知识库/Loops/设置/归档）是带 ‹返回 的全屏页，**‹返回永远 = 回聊天**（`mobilePage` 状态，扁平导航、
  无历史栈，深层导航留在各面板内部）。≥768px 同一棵树常驻贴左（`showPermanentTree`，推挤内容不覆盖，☰ 隐藏）。上下文规则
  「跟着屏幕走」：抽屉/切换面板里以 W 为目标的动作 = `ensureWorkspaceContext(W)`（幂等建/激活 W 锚定占位 tab，纯状态**不 focusChat**——2026-09-27：切工作区显式化 = `ensureWorkspaceContext(W)` + 落 W 总览（mobilePage:"overview"，与桌面家 tab 对齐）——
  否则会误关目的地页；已处 W 上下文则 no-op）+ 目的地；空态自动落回 = 给默认工作区开占位 composer（replace 写 URL）。
  头部 ☰ 由 `ChatToolbar` 的 `navToggle` prop 驱动（"sidebar"桌面 / "drawer"手机带后台状态圆点 / "hidden"宽屏常驻树），
  工具栏右侧显示当前会话标题（无会话显示工作区名）。**这条反转并取代旧决策「Don't reintroduce a drawer」**——该决策针对
  的是「旧抽屉装模块面板、没有统一工作区/会话树」的时代；树已被证明是正确的导航内容，痛点是移动端缺树而非抽屉形态本身。
- **知识库** — **only `kind === "knowledge"`** repositories; each is an **OKF (Open Knowledge Format v0.2)** bundle
  (Markdown + YAML frontmatter) browsed via a `FileExplorer` pointed at the repo's registered `path`（路径登记制，通常根级 `<alias>/`，per `workspaceRepositoryPath`）. A newly
  `init`'d bundle is seeded with `index.md` (progressive-disclosure entry), `log.md`, and a `concepts/welcome.md`
  example concept (`lib/workspaces/okf.ts`, `renderOkfSeed`); a `clone`d bundle keeps the remote structure untouched.
  **L0 access is always built-in** — `read`/`ls`/`grep` need no tool. The view has an "open index.md" hint as the L0
  entry point. Ranked retrieval augmentation (`kb_search`) is **opt-in**: the tool is mounted automatically when the
  `knowledge` capability is on, and searches across all active bundles (see "kb_search" below).
- **工作项** — the FULL WorkspaceManager work-item surface (筛选/详情/对话链接/归档)；宿主（右坞 S3 后）：桌面 = 右坞工作项模块（2026-10 rail；`embedded + panel` 模式，列表→详情面板内推进航，`key=workspace.id` 挂载）；移动端 = 抽屉目的地页 work-items（M2 T10 起宿中央同款 `WorkItemsPage`，不再走 panel 模式）。**M2 T8–T10 中央管理整页**：`CenterPage kind="work-items"`（页面身份显式绑 workspaceId，深链 `?workspace=<id>&page=work-items&item=<key>`，`openWorkItemsPage(workspaceId, itemKey?)` 入口在 shell context）；入口 = 快捷面板/总览工作项区头部「打开完整管理」；中央页「查看会话」= 关页开聊天 tab + `openDockModule(页面工作区, WORK_ITEMS)` 定位右坞快捷面板。`panel` mode: manager chrome header hidden — the tab bar/PanelHeader already titles it — rail hidden **仅限 work-items section**（工作项面板单工作区作用域，列表是死路；2026-09 修复：设置›工作区 subpage（section=workspaces）例外——rail 以堆叠列表保留在所有面板宽度，原先只靠 ≤640px media query 救回，横屏/平板/折叠屏等 >640px 移动视口上工作区列表完全消失、已停用工作区无法再启用，该 rail 是隐藏工作区的唯一管理面）, single column; rows/toolbars/detail compact below a 480px container query（右坞可拖窄 + 中栏可拖窄两处都受益）. NOTE: same-specificity panel overrides in WorkspaceManager's styled-jsx sheet must stay AFTER the base rules — placed before them the cascade silently reverts them (the original bug: body kept the 280px rail track and the whole pane overflowed the column).

Mobile is a **separate shell with drawer navigation**（2026-09 树抽屉重构，docs/mobile-drawer-design.md；详见上方「移动端抽屉」节）: `MobileShell` renders **44px tool strip（2026-09-27 顶栏重排，docs/mobile-drawer-design.md 补充记录）** (`ChatToolbar`，`navToggle="drawer"`：☰ 开抽屉 + 后台状态圆点 + **居中会话标题（点击 → 会话信息面板）** + 统计 + **⋯ 溢出菜单**收纳 主题/语言/完整历史/生成标题/分支/系统提示词 六个降级控件——全局组+会话组分隔；分支面板由 `hideTrigger` 的 BranchNavigator 承载) → 全屏主区（聊天永远挂载持久，SSE 跨页不断；非聊天目的地 = `mobilePage` 全屏页，‹返回永远 = 回聊天）→ 抽屉（`mobileNavOpen`，scrim + 滑入，内容 = `ProjectSidebar`（头部模块条[总览/文件/工作项/知识库/Loops] + 「项目」分区行 + 分组/平铺会话清单，2026-09-27）；点目标/遮罩即关；**Android 返回键经 pushState 陷阱态只关抽屉不退页，左缘右滑（横移 >56px 且明显横向）也可开**）。**底部 tab 栏、头部 chips 行、`MobileSideRail`、`WorkspaceHomeMenu`、`pi-mobile-tab:<wsId>` 持久化均已删除**。空态（冷启动/关光 tab）自动给默认工作区开占位 composer 作上下文锚（`openNewSessionTab(target, { replace: true })`）；**≥768px（平板竖屏/手机横屏/折叠屏展开）同一侧栏常驻贴左（`showPermanentTree`，推挤内容，☰ 隐藏）**，跨断点切换不丢 mobilePage 与会话状态。零可用工作区时 HomeLanding 接手（创建/重启用引导 + ⚙ 设置逃生口，抽屉重构后它只剩这一个宿主角色）。新建会话直落 composer（占位 tab，控制行带 WorkspaceSelector）；HomeLanding 两段式（大输入卡先出）仅桌面保留。**设计决策反转记录：旧「Don't reintroduce a drawer」（commit 0d96111）针对的是「抽屉装模块面板、没有统一工作区/会话树」的时代；2026-09 树抽屉重构反转它——树已是正确且唯一的导航内容，痛点是移动端缺树（切工作区深/chips 放不下/导航碎）而非抽屉形态本身。新增模块的落点演变：抽屉树模块行（`showModuleRows`，已退役）→ 切换面板（已撤）→ **抽屉头部模块条**（2026-09-27 晚，`headerSlot`，作用于当前工作区），不是新 tab 也不是新 overlay。**

**Shell split (mobile tab refactor):** `AppShell` is a thin dispatcher — `useAppShellState()` (`components/shell/useAppShellState.ts`) owns ALL shared state (workspace tabs, sessions, SSE wiring, panel selection, persistence) and provides it via `components/shell/context.tsx` (`useShell()`); the state layer has **no `isMobile` branches** — cross-shell navigation intents travel as focus signals (`chatFocusKey` bumped by every chat-opening handler, `panelFocus` for the work-items create flow) that only MobileShell reacts to. **The shell choice must be correct in the FIRST HTML response**: `app/page.tsx` (async server component) sniffs the User-Agent into `initialIsMobile` and passes it to `AppShell`, which seeds `useViewportIsMobile(initial)` — the value drives BOTH the SSR render and the hydration render (no mismatch), then a mount effect corrects a wrong UA guess via `decideIsMobile` (`lib/shell-is-mobile.ts`, pure + tested): ① viewport ≤640px → mobile; ② **UA-mobile seed never downgrades** — a phone stays mobile even at a wide CSS viewport (landscape, foldables, remembered zoom-out); ③ touch-only device (`pointer: coarse` and NO `any-pointer: fine`) → mobile, which catches「电脑版网站」mode (it rewrites the UA *and* widens the layout viewport to ~980px — both width and UA go blind, only the pointer media feature survives; this was the 2026-09 "PC 端首页、底部没有 tab" bug). `AppShell` provides the resolved flag via `IsMobileContext`; every `useIsMobile()` caller reads that context (zero per-caller subscriptions, one source of truth) and falls back to a standalone viewport hook only outside the shell tree. Without the server seed phones SSR the desktop shell and flip only after full hydration — seconds on a slow device. **The DATA must be in the first HTML response too (2026-09 方案二 SSR 预取)**: without it the server renders a data-less shell —「尚无工作区」+「加载中」— and the client then jumps TWICE (workspaces arrive → empty groups in letter order; /api/sessions arrives ~400ms cold → activity-ordered filled groups; the session index walk is ~8× slower than the workspaces fetch, holding the real content hostage). `app/page.tsx` now prefetches BOTH in-process — `discoverWorkspaces()` + `buildSessionsPayload()` (shared with `GET /api/sessions` in `lib/session-payload.ts`) — and seeds `useAppShellState({ initialWorkspaces, initialSessions, initialRunningIds })` → `workspacesLoaded`/`useSessionActivity(seed)` start true; the post-hydration refreshes are silent same-data updates. Two guards: the SSR running-id merge is a plain in-process call (`buildSessionsPayload()` reads `facade.runningStatus()` — fail-fast, a render must never block); and EITHER seed failing (null) falls back to client fetch with **skeleton gating** — `ProjectSidebar` (`workspacesLoaded`/`sessionsLoaded` props) renders skeleton rows instead of「尚无工作区」or empty groups, killing the lying empty states on the fallback path too. `DesktopShell.tsx` renders the desktop layout (tree sidebar + center + right dock, see Navigation); `MobileShell.tsx` renders the drawer navigation (see「移动端抽屉」). `ChatToolbar.tsx` is the shared tool strip (desktop 36px: theme/language/history/auto-name/branch/system/token stats inline; **mobile 44px, 2026-09-27: ☰ / 居中标题(点击→会话信息) / 统计 / ⋯ overflow menu hosting theme+language+history+auto-name+branch+system**) + dropdown panels (branches/system/session/language/**more**) + `navToggle`-driven ☰, rendered by both shells. Shell-agnostic overlays (home create-workspace wizard, DirectoryPicker, ProjectTrustDialog) render in AppShell for both.

**Mobile keyboard（键盘↔输入框空白修复，双策略分治）：** `useVisualViewportKeyboard`（`hooks/useVisualViewportKeyboard.ts`，AppShell 挂载一次，`pointer: coarse` 门控）是唯一的键盘适配层：可编辑元素聚焦且 visualViewport 比 **`documentElement.clientHeight` 基准**（绝不用 `window.innerHeight` —— iOS 键盘弹出时它也跟着缩；基准只在“前后都不在键盘态”时采样）小 ≥150px 时判为键盘开启，加 `.pi-keyboard-open`，然后按 **`resolveKeyboardStrategy`（`lib/keyboard-layout.ts`，纯函数+测试）分两条路**：

- **native（不接管变形）**：resizes-visual 类内核（Android Chrome/Edge、iOS —— vv 缩而布局视口不缩）。这类内核的键盘 reveal 是【窗口级平移】：浏览器把整页渲染层上提以露出聚焦输入框，该平移发生在 JS 所有可读信号之外（scrollY/vvTop/html rect.top 全读 0 或不可信，2026-09-06 Edge 151 真机截图实测），页面既测不到也撤不掉；若 JS 再压短应用高度，平移不随重排撤回，应用被悬在可视区上方、下方留大段空画布 —— “键盘与输入框之间大片空白”的根因。所以 native 只做一件事：把应用钉在布局视口全高（`--app-height=<live>`，此内核的 100dvh 会随键盘缩，Edge 实测键盘开启时 dvh=535<live 682，放任 dvh 会在可视带下方留画布空带；2026-09 树抽屉重构后底部无导航条，原「隐藏底部 tab 栏」一招随之消失）；不压高、不平移、不锁滚动。注意：这类浏览器（如 Edge 底部地址栏形态）键盘弹出时底部地址栏仍叠在页面与键盘之间（约 126px），网页无法在那里渲染 —— 输入框贴地址栏顶就是网页能做到的极限，想贴键盘只能靠浏览器层（地址栏放顶部 / PWA standalone）。
- **squeeze（压高+平移补偿）**：布局视口自己缩的内核（微信 XWeb 等 resizes-content 但 dvh 不跟随）、无 vv 老内核（innerHeight 随键盘缩）、vk overlaysContent（`navigator.virtualKeyboard` 存在且启用时浏览器完全不管布局，必须自压，键盘真实顶边用 `computeVkKeyboardState` 从 boundingRect 取）。CSS（globals.css）只在 `.pi-keyboard-open.pi-kb-squeeze` 下把 html+body 压到 `--app-height`（正常流，不用 fixed），**reveal 平移补偿**：每帧实测 `-html.getBoundingClientRect().top` 与 `vv.offsetTop` 取 max（同屏平移会在两个信号里重复，求和=双重补偿）设 `--app-lift`，body `translateY(var(--app-lift))` 反向抵消，键盘开启时 `window.scrollTo(0,0)` 锁滚。

配套：应用根（layout.tsx body / MobileShell / DesktopShell）统一 `height: var(--app-vh)` —— `--app-vh` 在 globals.css 上定义（`:root { --app-vh: var(--app-height, 100%) }` + `@supports (height: 100dvh)` 升级为 `var(--app-height, 100dvh)`）。**绝不直接写 `height: var(--app-height, 100dvh)`**：不支持 dvh 的老内核（Windows 微信/企微内置浏览器，Chromium<108）里 var() 的 fallback 在【计算值阶段】整体失效（invalid at computed-value time → height:auto），整条高度链塌成内容高度 —— 输入框悬在半空、下方大片空白（PC 端“键盘位置和底部有非常大间距”的老内核成因）；直写 `100dvh` 是解析期丢弃、能回落到 `html,body{height:100%}`，反而无害，所以用 @supports 分层 + % 回落保证任何内核拿到的都是合法值，hook 写的 --app-height 是纯 px、老触屏内核（X5）同样能压短；`@media (pointer: coarse)` 输入控件 ≥16px（iOS/Android 对 <16px 输入框聚焦会自动放大页面，缩放会持续污染几何信号）；**不设** `interactive-widget` meta —— 键盘适配统一走 JS 路径；双判据（vv 缩了 **或 clientHeight 自己缩了** ≥150px）、无 visualViewport 的老内核回退 innerHeight、聚焦期间及关闭后 1.2s 内 250ms 轮询实测（不少内核键盘/平移不发事件）、**scale 守卫 [0.95, 3]**（zoom-out<0.95 必拦：手机上“电脑版网站”缩放显示时 vv 天然只是布局视口的窗口，gap 恒>0 却没有键盘，不设下界会把应用错误压短；zoom-in 放宽到 3 —— gap 判据本身能区分键盘与放大，且 native pin 的误触发与关闭态高度相同无副作用；收紧到 1.05 会在站点缩放被记住的内核上致盲全部检测，2026-09-06 Edge 真机事故：scale 停在 1.0999 后适配全盲）、URL `?kbdebug=1`（存 localStorage，`?kbdebug=0` 关）在左上角显示实时指标用于真机定位。聊天流式期间的上滑停跟随修复是 PC+手机端的姊妹修复，决策逻辑在 `lib/chat-scroll-follow.ts`（纯逻辑，与 `useAgentSession` 及测试共用同一实现）：**用户上滑判定先于 120px 近底恢复分支**（旧顺序里小幅上滑先撞上“恢复跟随”，下一个流式增量又拽回底部 —— “AI 回复时上滑一点就抖动”）、单事件上滑阈值 0.5px（慢触控板/高刷触屏每帧 delta 常仅 1~4px）、**touchmove 也刷新滚动意图窗口**（否则长按拖动 >1.2s 窗口过期，跟随中途恢复，拖到一半被拽回）、**近底恢复跟随需要佐证**（二轮修复：本就跟随 / 意图新鲜 / scrollTop 在增大，三选一 —— 输入事件覆盖不到的滚动路径【滚动条/最小地图长拖超过 1.2s 意图窗、抬指后 >1.2s 的惯性滚动】会持续产生带内 scroll 事件却无意图佐证，旧逻辑无条件在带内恢复跟随，流式增量贴底与未停稳的上滑逐帧拉锯；“ scrollTop 增大”是安全佐证：allowed=false 期间程序化贴底已被 gate 拦住，增大只能是用户向下滚回）。

**Desktop sidebar（项目树）is drag-resizable.** The width is a CSS var (`--pi-sidebar-width`, default `300px`, min 200) set inline on
`.sidebar-container` from the shared `sidebarWidth` state; a thin `.sidebar-resize-handle` strip (sibling of the
container, desktop + open only) drives it via `onMouseDown` window listeners. Width persists in `localStorage`
(`pi-sidebar-width`), clamped `[200, 560]`; double-click the handle resets to 200. Mobile keeps a fixed 280px drawer
(its CSS overrides the var, and the handle isn't rendered). During drag a `sidebar-resizing` class disables the
open/close `width` transition so it tracks the cursor instantly.

**The right file panel is drag-resizable the same way** (`startRightPanelResize` in `useAppShellState`, mirror of the
sidebar resize): a `.right-panel-resize-handle` strip sits BETWEEN the center chat area and the right panel (sibling
BEFORE `.right-panel-container`, rendered only while open). The width is a CSS var (`--pi-right-panel-width`, px) set
inline on the container — **unset → the CSS `42%` default** (`rightPanelWidth: number | null`; null means default).
Drag persists the px in `localStorage` (`pi-right-panel-width`), clamped `[300, window.innerWidth - 620]` (the chat
area keeps ≥620px; a CSS `max-width: calc(100vw - 620px)` guards windows shrunk AFTER a wide drag); double-click the
handle resets to the 42% default (removes the key). During drag a `right-panel-resizing` class on the container
disables the transition; the handle itself gets `right-panel-resize-active` from JS for the accent highlight (the
handle precedes the container, so no sibling selector can reach it).

### Work Items (`lib/work-items/`)

File-backed **Requirements (`REQ-####`)** and **Bugs (`BUG-####`)**. Storage under
`<workspace>/.pi/work-items/<requirements|bugs>/<KEY>-<slug>/`（2026-09 布局，`lib/work-items/service.ts` 的
`workItemRoot`；旧根级 requirements//bugs/ 目录已一次性收进 .pi/，迁移脚本已删）:

- `item.yaml` — structured metadata (status/phase/priority/repositories/conversations/… + optional top-level `loop?: string` kit-loop binding by loop NAME, S1 soft validation — existence NOT checked; protocol semantics in `kit/README.md` 工作项绑定一节; + optional `delivery` 标准交付流块, see below), `schemaVersion 1`.
- `README.md` — human body. **Original Description is preserved verbatim**; later analysis is appended, never overwriting it.
- `events.jsonl` — **append-only** timeline (id/at/type/actor/optional conversationId/data). Never rewrite it.
- `delivery/artifacts/design.md` — 设计文档（仅 `enableDelivery` 项；`start-design` 时若不存在则播种模板「# 设计：… ## 方案 ## 验收条件」）。空/纯空白视同未编写——`confirm-design` 会以 400 拒绝（缺设计依据）。

Key behavior:
- `listWorkItems()` reads ONLY `item.yaml` per directory (README/events are detail payloads — reading them here was the list hotspot) and returns `{ items, archivedItems, trashedItems, invalid }` in ONE pass — the sidebar's active+archived fetches, the recycle-bin read-only list, and external-source sync scripts' dedup scans (active ∪ archived) all consume this single result.
- The `KEY` counter lives in `manifest.work_items.next{Requirement,Bug}Number` and is incremented under the workspace
  write lock (`reserveWorkItemKey`; createWorkItem 在自己的锁窗内改用不可重入变体 `reserveWorkItemKeyUnlocked`——见下条)。
- **跨进程短写锁（2026-10 M2，spec §8.2）**：`withWorkspaceWriteLock`（lib/workspaces/service.ts）= **双层锁** —— 进程内
  per-workspace Promise 队列（同进程写串行）套 `withWorkspaceFileLock`（`lib/workspaces/file-lock.ts`：O_EXCL 创建
  `<ws>/.pi/.write-lock`，内容 = owner token `${pid}@${host}:${uuid}:${createdAt}`；获取失败读持有者——pid 已死或超 stale 窗
  （默认 30s，短事务）删锁重试一次，仍失败抛 `WorkItemConflictError`（HTTP 409）；释放前核对 token 再删，不误删被抢占重写
  的他人锁；不可解析的锁以 mtime 兜底防抢占「创建窗」内的锁）。文件层让 web 宿主与外部写者（pi-loop CLI / 外部脚本加载
  同一 workspace）互斥；**锁不可重入**——锁内路径要再取 key 计数/查重必须走 unlocked 变体。file-keyed 调用方（如 session
  index）用 sibling `<file>.write-lock`（`resolveLockPath`：目录 → `.pi/.write-lock`，文件 → sibling，不存在 → null 跳过文件层）。
- **导入去重（2026-10 M2，spec §8.1）**：`createWorkItem` 带 `external` 时，去重查找（`findExistingByExternal`：
  活动 ∪ 归档（`listWorkItems`）∪ 回收站——trash 里的 item.yaml 即来源去重墓碑，坏墓碑跳过不阻塞）+ key 预留 +
  落盘全在**同一工作区写锁窗**内（并发同源导入只建一项；锁不可重入故 key 预留走 unlocked 变体）。命中即**原样返回
  既有项**（`existing` 从活动布局读，`existing_trashed` 从 `.pi/trash/work-items/<dir>/` 读——`readWorkItemDirectory`
  支持显式目录），不覆盖任何字段、不消耗 key 计数。返回值 `{ detail, importOutcome: "created"|"existing"|"existing_trashed" }`；
  POST `/work-items` 响应 = detail 展开 + `importOutcome`，状态码 201 created / 200 existing*（旧脚本按 detail 字段读仍兼容）；
  extension `workspace_create_work_item` 取 `.detail` 附加 outcome；WorkspaceManager 创建流程把 existing 视为
  「已存在，未重复创建」提示（existing 打开既有项详情，existing_trashed 仅提示——回收站项路径不在活动布局，详情操作会 404）。
- **标准交付流 / delivery flow（2026-10 M2，`lib/work-items/delivery-types.ts` + `delivery.ts`；动作面是人工的——Phase-2/3 在其上加了 designer（intake→design）与 developer（ready_for_implementation→implementation）两段自动执行，见下节「Delivery 自动执行」）**：
  创建表单勾选「标准交付流程」（`CreateWorkItemInput.enableDelivery`，HTTP 表单专用——LLM 工具不透传；缺省不勾）即给
  `item.yaml` 顶层播种 `delivery: { protocolVersion: 1, mode: "manual" }` 块（`parseDelivery` 逐字段校验；未知
  protocolVersion / 非 manual mode 是硬错误 = 配置错误，不静默降级）。块内子结构：`designConfirmed`（requirementDigest +
  designDigest 双绑定）、`candidates[]`（{repositoryId, commit}）、`verification`（requirementDigest + candidateDigest +
  checks[]）、`releasePlan`、`release`（version + candidates + notes/rollback）、`lastRequest`（幂等指纹）。**七阶段**（phase 枚举
  扩展，与老子阶段共存）：`intake → design → ready_for_implementation → implementation → verification → release_ready →
  released`；`block`/`unblock` 改 status 不动 phase，`cancel` 终止。**状态机**：`planDeliveryTransition`（纯函数，无 fs——
  README/design.md 的 sha256 digest 由 apply 计算注入；`contentDigest`/`candidatesDigest` 在 delivery-types.ts）产出
  {phase, status, delivery, eventType, eventData}；`applyDeliveryAction` 在工作区写锁内编排（读现态 → 幂等检查 → revision
  检查 → plan → design.md 播种 → 写 item.yaml + appendEvent + workspace git commit）。**requestId 幂等**（spec §9）：同
  requestId+action 重放直接返回现态 `{detail, replayed: true}`，不 bump revision、不追加事件；每次受理把指纹写进
  `delivery.lastRequest`。**证据绑定**：confirm-design 绑定当时的 requirement+design digest、record-verification 绑定
  requirement+candidates digest——缺依据（无 design.md / 无 candidates / 有未通过检查项）一律 400 拒绝推进；rework 回退时
  撤销全部下游证据（designConfirmed/candidates/verification/releasePlan 清空，须重新挣得）。**失效回退（确定性，spec §7.3）**：
  已确认设计后修改需求（README 正文，`updateWorkItemContent`）或修改已确认的 design.md（`updateDesignContent`）→ 清
  designConfirmed/candidates/verification + phase 回 `design` + 追加 `delivery.invalidated` 事件（reason
  requirement-changed / design-changed）。**门禁与冻结**：generic PATCH 对 managed 项改 phase/status → 400（阶段只走流程动作）；
  `released` 基线冻结——非展示性动作（block/unblock/cancel 外）、PATCH 的 repositories/loop、design.md 编辑均拒绝（「请创建关联后续项」）；
  released 上 unblock 恢复 `done`（不是 in_progress——冻结基线上没有别的写者能修复它）。**动作 API**：
  `POST /api/workspaces/[id]/work-items/[key]/delivery/[action]`（body {expectedRevision, requestId, payload}；slug 门 =
  delivery-types 的 `DELIVERY_ACTIONS` 权威表；错误 400 Validation/404 NotFound|未播种 design.md/409 Conflict=revision 或锁忙）；
  `GET|POST .../[key]/design` = 设计文档读/写（POST 即 updateDesignContent，同样走失效回退）。**合法动作计算**：
  `legalDeliveryActions` 的 client-safe 家在 `lib/work-items/legal-actions.ts`（纯类型导入，浏览器 bundle 安全；delivery.ts
  re-export 保服务端旧消费面）；动作条投影 `legalActionBarActions` 在 released 上额外去掉 cancel（released+cancelled
  是不可能态——WorkItemActionbar 据此不渲染 cancel）。事件类型：`delivery.<action>` + `work_item.design_updated` +
  `delivery.invalidated`。错误类住在 `lib/work-items/errors.ts`（叶子模块；service.ts re-export——web.ts 的 instanceof →
  HTTP 映射要求所有 thrower 共享同一 class 身份）。
- **回收站（trash，2026-10 M2）**：DELETE（trash）把条目 rename 进 `.pi/trash/work-items/<KEY>-<ISO 时间戳>/`（同一 key 多次
  移入取最新 mtime）；恢复 = `restoreWorkItemFromTrashInRoot(workspacePath, key)`（锁内原子 rename 回 type 目录 + `work_item.restored`
  事件；key 已被任何活目录承载 → 409；墓碑 item.yaml 坏 → 400 不把垃圾搬回活树；无命中 → 404）——HTTP
  `POST .../work-items/[key]/restore-from-trash`，测试经 workspacePath 缝注入。回收站在 `listWorkItems().trashedItems`
  只读列出（中央页「回收站」筛选 + 恢复入口）；其 item.yaml 兼任外部源去重墓碑（见上条）。
- Updates take `expectedRevision` (optimistic concurrency); appending a milestone via `recordWorkItemMilestone` does
  **not** bump the revision.
- **会话自链接（服务层不变式，2026-09）**：任何带 `conversationId` 的事件/更新都把该会话合并进 `item.conversations` ——
  `updateWorkItem` 在锁内合并（bump revision），`recordWorkItemMilestone` 只写元数据不 bump。此前合并只存在于
  `workspace_update_work_item`（扩展显式预读全量再传回，存在覆盖其它会话新链接的竞窗，已删），而 conversations
  事后回填（D9）仅宿主心跳轮才有 —— loop 轮/交互会话只盖里程碑时（`loop.parked`/`loop.gate`/…）会话与工作项
  断链，详情页「关联会话」为空、回复结果无处可寻（cxin REQ-0013/0014 实证）。调用方（LLM 扩展 / D9 回填 /
  HTTP API）一律只传 `conversationId`，不传全量列表。UI 侧：详情页「执行里程碑」每行带 `conversationId` 时渲染
  「查看会话」按钮（`onOpenConversation` → locate 打开，含已归档轮会话）；详情头部为两行结构——第一排按钮区、
  第二排编号+标题（2026-09 反馈）；仓库范围在详情页只读展示（仅非空时，勾选交互已撤——2026-09 反馈无实际作用，
  字段仍由创建表单/外部源脚本/LLM 工具写入，loop 选品 verifiable 判定读它）。历史孤儿数据不迁移——旧行的「查看会话」按钮同样可达。
- The pi extension (`work-items/extension.ts`) registers `workspace_list_work_items`, `workspace_get_work_item`,
  `workspace_create_work_item`, `workspace_update_work_item`, `workspace_record_milestone`. create/update **透传可选 `loop` 绑定字段**（string；update 接受 null 清除——S1，软校验：存 loop 名、不验存在性，未命中按未绑定处理）。UI 入口 = 详情「Loop」下拉（WorkspaceManager，空=未绑定）。
  **LLM 工具 managed 门控（2026-10 M2）**：`list` 默认**排除 managed 项**（= 挂 delivery 块的标准流程项——loop 取项不该捡走
  流程管着的项），`include_managed: true` 显式opt-in 才附带；每项带 `managed` 标记（`get` 恒附）；`update` 不绕 service
  （直调 `updateWorkItem`，managed 项改 phase/status 即吃到 service 层 400 门禁，工具描述里写明引导走 delivery 动作）。
- **来源展示**: items carrying `external` (外部源脚本经 HTTP API 盖章) render their provenance — 详情「来源」行（禅道 #id ↗ + 最近同步时间）+ 列表 KEY 旁「禅道」小徽章（`source-labels.ts` 的标签映射；手动创建的项无此字段，不加徽章）。
- **附件（attachments）**: `addWorkItemAttachments`（service.ts）把上传文件落 `<item>/attachments/`（basename 剥离路径、去控制字符、磁盘/批内重名自动 `-1` 后缀，中文名保留）并在 README 维护单个 `## 附件` 小节（图片 `![]()`、其余 `[]()`，目标 URL 编码，重复引用不追加；README 变更时与 content 更新同构地 bump revision）。事件类型 `work_item.attachment_added`（data.files）。路由 `POST …/work-items/[key]/attachments`（multipart `files`，限额同 /api/files：单文件 25MB / 总 100MB）；创建表单（WorkspaceManager）在创建成功后上传，失败不静默丢——报错并保留已建工作项。详情页 `MarkdownBody cwd` 直接渲染这些相对引用（与外部源脚本同机制）。
- **前端（2026-10 M2 T7–T10）**：**共享缓存层** = `lib/work-items/store.ts`（per-workspace 模块级 snapshot
  {items, archivedItems, trashedItems, invalid} + listener 广播 + `shouldRefetch` 5s 年龄门——双宿主秒开不拉请求风暴）+
  `hooks/useWorkItems.ts`（**单轮询器引用计数**：同 workspaceId 无论挂几个宿主只有一个 interval（默认 5s，仅可见时轮询；
  visibilitychange 停表/回可见立即校验，focus 校验一次；单飞 in-flight 合并）；mutation 成功统一 `invalidate()`（清快照+强制
  重取，两宿主经订阅即时互见）；workspaceId 热切换时 loading/error 从新工作区的 store 状态复位（在飞的旧请求不得把错误漏到
  新工作区））。**中央管理整页** = `components/work-items/`：`WorkItemsPage`（页头 工作区选择器+列表|看板分段+＋新建 →
  Toolbar 筛选（活动|归档|回收站）→ `WorkItemsList`/`WorkItemsBoard`（七列看板，无拖拽跳阶段）→ `WorkItemDetailView`
  （概况/设计编辑/证据（确认/候选/验证/发布）/动作条 `WorkItemActionbar`/事件审计 `WorkItemEvents`）+ `WorkItemCreateForm`
  （`enableDelivery` 复选框**缺省不勾**）。**交付自动执行区（Phase-2 T9；Phase-3 T5 增量）**：`WorkItemExecution.tsx`（managed 项专属，
  挂在 DetailView 动作条下）：四态——活动 claim 卡（**role 徽标 designer/developer**/代数/心跳 + 查看会话[claim.sessionId→onOpenConversation] +
  「停止执行」+ **claim.worktrees 列表**[每仓一条 `alias ?? repositoryId · 分支`——alias 由 GET delivery-execution 路由**读取时 manifest 联表富化**（展示元数据可改名、不落盘；无 alias/未登记回退 ULID id），完整检出路径进 title 提示])、`paused` 横幅（原因/连续失败计数 + 「恢复自动领取」）、`pendingInterruption` 横幅（「重新检查并恢复」）、
  最近 attempts（末 5 新→旧，outcome 徽章 + **role 徽标** + needsAttention「待处理」标记 + **submitted 项的候选摘要**[内联串 `repo@commit 前 8 位`]）；busy 全按钮禁用防双击，动作结果
  `{ok}|{ok:false,error}` 出参 → 内联 role=alert（recover 409 的 pids 由 WorkItemsPage 拼进 error 文案）。执行状态由
  WorkItemsPage 拉取（GET `.../delivery-execution`，仅 `item.delivery` 存在的非回收站选中项拉；revision 变化 + 动作成功
  重拉，effect 带切项取消守卫）；三动作 = POST `.../delivery-execution/stop|recover`（manual:true）与
  `/api/workspaces/[id]/delivery/resume`（body {key}），成功 → invalidate + 重拉。设置›工作区（WorkspaceManager）：
  work-items+workflows 双开时显示「交付自动化」配置块（enabled 开关 + **designer/developer profile 文本框（T5 双行同形）** + 预算只读「失败上限 N 次 ·
  执行上限 M 分钟」+ 保存 PUT `/delivery`——budget 与两角色既有 model 覆写原样回传保 round-trip；配置结构是
  delivery-runner/config 的客户端镜像类型，不 import 服务端模块）。
  看板投影在 `work-item-phases.ts`（纯模块）：老子阶段（analysis/
  requirement_approval/plan_approval）投影进 design 列但**显示原始 phase 标签**（不谎报已进标准列）；老 `complete` 投影进
  released 列但经 `isHistoricalComplete` 收进「历史已完成」折叠组——**不推断已发布**（「旧 complete ≠ 已发布」）。筛选/排序
  纯逻辑在 `work-item-queries.ts`，HTTP 封装在 `work-item-api.ts`。**深链**：`?workspace=<id>&page=work-items[&item=<key>]`
  （builder/parse 同居 `lib/work-items-page-url.ts`，`buildWorkItemsPageUrl` 返回**裸 query**——navigateUrl 自补 `?`；
  解析在 `applyUrlToTabs` 里先于 tab 投影，页面是 CenterPage 不是会话 tab；✕ 关闭/选中项变化 replace 重写 URL 不埋历史
  陷阱）。**入口**：右坞快捷面板顶部「打开完整管理」+ 总览工作项区头部同款（rail 图标单击语义不变）；快捷面板列表已切
  `useWorkItems` 共享层（与中央页单轮询器）。移动端 work-items 目的地页宿 `WorkItemsPage` 本体（capability 门控沿用模块条——入口不渲染则
  页面不可达；窄屏 ≤640px：看板回落为阶段筛选列表、详情全屏覆盖；`onBack`=‹返回回聊天；「查看会话」= 关目的地页回聊天再
  locate 开会话；`onOpenLoopsRecovery` → loops 目的地页）。中央页「查看会话」= 关中央页开会话 tab + `openDockModule(ws,
  WORK_ITEMS)` 定位快捷面板；工作项详情的**执行中断跳转**：`item.loop` 命中 loops interruptions → 「去处理」跳 Loops rail
  模块（`onOpenLoopsRecovery`）。
- **Archive cascade** (`lib/archive-cascade.ts`): archiving a work item tucks its conversations into the session
  archive **only if no other active work item references them**; restoring brings them back. Sessions are physically
  moved to a `.archived/` subdirectory (`lib/session-archive.ts`) so `SessionManager.listAll()` no longer sees them.

### Delivery 自动执行（designer + developer + verifier 三角色；`lib/work-items/delivery-runner/`，2026-10 Phase-2 → Phase-3 → Phase-4）

Phase-2 落了**首个自动化角色 designer**（intake 需求 → design.md + 验收条件 → 等人
confirm-design）；Phase-3（2026-10）**第二个角色 developer 上岗**（ready_for_implementation
领取 → `prepareWorktrees` 每仓 worktree 隔离 → 候选 commit 提交进 verification 等人
record-verification）；Phase-4（2026-10）**第三角色 verifier 上岗**（verification 领取 →
`prepareVerifyCheckouts` 候选 detached checkout + `verification.checks` 配置冻结快照进
claim → 服务端 `runConfiguredCheck` 执行 + `recordCheckResult` 证据累积 → submit 按 M2
record-verification/rework 语义推进 release_ready 或返工）——**检查证据只能出自
`delivery_run_check`（LLM 自述/bash 自跑不构成证据）**。合并角色池 + 按条目角色分派，
三角色共享单槽位/工作区与同一失败预算。release-preparer 角色、多槽位并发、任务依赖图、
worktree 自动清理均**未实现**（spec §2/§12 留后续阶段——worktree 由人手动清理，
不合并不推送是合同纪律）。

- **配置 `.pi/delivery.yaml`**（`config.ts`；路由 `GET|PUT /api/workspaces/[id]/delivery`）：
  `{schemaVersion: 1, enabled, roles: { designer?: {profile?, model?}, developer?: {profile?, model?} }（Phase-3 T5 显式双字段，两键同规校验；旧单键文件照常解析；无 verifier 键——verifier 会话回落默认模型）, budget: {maxAttemptsPerInput, maxExecutionMinutes}, verification?: {checks: [{name, repositoryId?, command, timeout_seconds? 1–3600}]}}（Phase-4 T1：人维护的验证命令——agent 只能触发不能自造；repositoryId 缺省 = 候选首仓）}`，
  budget 缺省 **3 次 / 30 分钟**、enabled **缺省 false**（文件缺失 = GET 返回 `{config: null}` = disabled）；
  坏 YAML/坏结构 → Validation（HTTP 400）；PUT 写入前过 capability 门 `assertAutomationCapable`——manifest 须
  同时含 **work-items + workflows**（`workflows` capability 自此激活自动执行含义：配置写入 + 工具挂载 +
  dispatcher 每拍复验都吃这道门）。UI = 设置›工作区「交付自动化」配置区（WorkspaceManager，双 capability 开
  时显示；`config:null` 播种默认镜像，budget 与两角色既有 model 覆写原样回传——见「前端」条目）。
- **池子（`pool.ts`，Phase-3 合并双角色 / Phase-4 增 verifier 第三角色）**：就绪任务不是存储实体——
  `projectDeliveryPool` 是**纯投影**
  （零 fs，全部输入含每项 requirementDigest 与 manifest 仓库登记表由调用方传入，只比较/排序/只分桶）；
  `listDeliveryPool` 是读取端装配器（`listWorkItems` 活动项 + 配置 + 每项运行时信号 claim/未确认中断/
  paused/失败计数 + `contentDigest(README)` + 登记仓表）。**角色由项所处阶段决定**（`DeliveryRole`）：
  `ready_for_implementation` → developer，`verification` → verifier，其余 → designer——designer 谓词
  P2 行为逐字节不变（phase===intake，非 intake 照旧 wrong-phase）。共用检查（三角色同）：无 claim ∧ 无未确认中断 ∧ 未 paused
  ∧ 尾部连续失败未达上限 ∧ **status ∈ {open, blocked}（白名单而非黑名单**——claim 事务写 in_progress 后
  即便 claim.json 未落盘也不再投影 ready，双派发窗口两头堵死）∧ 未归档；developer 谓词另加 **designConfirmed
  真值 ∧ 仓库范围非空 ∧ 范围内每仓已登记且 active**（新 reason：`design-unconfirmed` / `no-repo-scope` /
  `repo-not-registered`；manifest 缺失/损坏 → 空登记表，developer 项以 repo-not-registered 可见、designer 项不受影响）；
  verifier 谓词（Phase-4 §3）另加 **designConfirmed 真值 ∧ 候选非空 ∧ checks 非空（`no-checks-configured`）
  ∧ 每 check 的 repositoryId（缺省=候选首仓）在候选仓集合内且登记 active**。输出**三角色合并同一队列**
  P0→P3→key 排序（角色不作 tiebreaker），每条目带 role，原因累积不短路。
- **worktree 预建与候选核验（`worktrees.ts`，Phase-3 T2；Phase-4 T2 增候选 checkout）**：`prepareWorktrees`——项仓库范围内每**登记且
  active** 的仓建一个 git worktree（复用 `lib/worktree.ts` 的 `addWorktree`：分支 `pi-delivery/<KEY>/gen<N>`，
  目录在仓旁 `<repoRoot>-worktrees/<sanitized branch>`）；先整表解析登记（未登记/removed 建任何 worktree 之前
  拒绝），再逐仓建/复用；**幂等 = 同 generation 复用既有 worktree**（`listWorktrees` 按分支找现 path）；
  任一仓失败整体抛、**已建的不回滚**——孤儿 worktree 无害（下代领取用新分支，不与旧代冲突）。
  `verifyCandidateCommits`——每候选 `git rev-parse --verify <commit>^{commit}` 核验（repoPaths 必须含该
  repositoryId；ref 非 40-hex 也接受——rev-parse 语义，提交时原样存储展示）；同步 spawnSync（锁内纯读，毫秒级）。
  `prepareVerifyCheckouts`（Phase-4 T2，verifier claim 前置）——每候选仓一个 detached checkout：两步法
  `addWorktree(repoPath, pi-verify/<KEY>/gen<N>)`（分支仅作目录名载体）→ `git checkout --detach <候选 commit>`；
  幂等 = 同 gen 目录在场则跳过创建但**仍 checkout 目标 commit**（修复半建残留；预检用确定性 existsSync——
  detached 后 porcelain 不报分支）；失败零状态已建不回滚（generation 单调）。
- **运行态与审计（`attempts.ts`）**：`<item>/delivery/runtime/{claim.json, automation-paused.json,
  failure-window.json}` 是 advisory 运行态（claim.json 带 `role`（designer|developer|verifier）；developer 领取另附
  `designDigest`（锁内自算的 design.md 摘要快照）与 `worktrees`（prepareWorktrees 产物清单）；verifier 领取另附
  `candidateDigest`（候选集摘要快照）+ `worktrees`（候选 detached checkout 清单）+ `checkContexts`（领取时冻结的
  检查配置快照 [{name, repositoryId 已解析, command, timeout_seconds}]——配置变更不追溯）+ `checkResults`
  （证据仓：`recordCheckResult` 累积，同名覆盖/新名追加——LLM 无注入口）；**claim 首写
  runtime/ 时幂等接进工作区 .gitignore**；读路径宽松——缺失/坏 JSON 一律按「无」）；`<item>/delivery/attempts/
  <attemptId>.json` 是追加式审计（含中断记录与 role，developer 的 submit/fail 附 candidates/worktrees；verifier 的
  submit 附 verificationOutcome（verified|rework）与全量 checkResults；永不删
  除；resolveInterruptions 只清 needsAttention + 记诊断）。**ownerToken 只存 sha256 哈希**（`hashOwnerToken`）——
  明文只在进程内 role grant 存活，永不落盘。claim/paused 走同步原子写（`writeAtomicSync` 镜像 service 习语），
  attempts 异步追加（复用 `writeAtomic`）。
- **领取事务（`claim.ts`，designer 三函数 P2 + developer 三函数 Phase-3 T3 + verifier 三函数 Phase-4 T3 共用同一套重放/并发/复验骨架）**：
  `claimDesignerTask` / `claimDeveloperTask` 全程 `withWorkspaceWriteLock`——幂等重放（claim.lastRequest 同
  requestId → 现 grant、ownerToken 空串不重建）→ **事务内双检**（manifest capability + 配置 + 复用
  `projectDeliveryPool` 谓词且要求投影角色与本事务一致——claim 与池子读同一套规则，永不漂移）。designer：
  design.md 播种（复用 M2 `DESIGN_SEED`，缺失才播）→ claim.json（先于 item.yaml：崩溃窗口两头堵死）→ phase
  intake→design + status=in_progress + `delivery.claimed` 事件 + workspace git commit（产物先落盘、状态后改）。
  developer：**`prepareWorktrees` 在任何状态落盘之前**（任一仓失败整体抛 = 零状态，已建孤儿不回滚）→ designDigest
  锁内快照 → claim.json（带 worktrees 清单）→ phase ready_for_implementation→implementation（事件 data 带
  worktrees）。`submitDesignerResult`：写 design.md（正文 + 合成「## 验收条件」节）→ 清 claim → attempt
  submitted → status 回 **open**、phase 保持 design 等人 confirm-design（designer 不推进确认；人在领取窗口内
  抢先 confirm → Conflict 409，不让确认证据静默过期）。`submitDeveloperResult`：`requireActiveClaim` 三凭据 +
  **role 匹配**（developer 凭证不得释放 designer 的 claim，反之亦然）+ **双 digest 复验**（requirementDigest
  ∧ designDigest——任一漂移 → Conflict）+ designConfirmed 仍真值 + **项仍在 implementation**（人推进过阶段 →
  迟到提交不覆写新状态）→ `verifyCandidateCommits` 候选核验（范围仓 = 领取时预建的 worktree 集）→ 按 M2
  submit-verification 语义**同构内联**（不调 `applyDeliveryAction`——其自取写锁不可重入；candidates 写入、
  verification 清空、phase→verification、status→open；候选是既有 commit，无新产物落盘）。`failDesignerTask`
  /`failDeveloperTask`：blocked 可选（白名单内仍可领）→ **回退守卫**（designer 仅 design→intake、developer 仅
  implementation→ready_for_implementation——人中途动作改了阶段则不回滚人的状态）+ `delivery.attempt_failed`；
  verifier 三函数（Phase-4 T3，spec §5）：claim = 候选 detached checkout（`prepareVerifyCheckouts`）预建在
  **任何状态落盘之前** + **phase 不变**（verification 就是验证活动的阶段）+ claim 冻结 candidateDigest/
  checkContexts/checkResults 空仓；submit = 三凭据 + role 门 + candidateDigest 复验 + 阶段守卫 + **证据只从
  claim.checkResults 取**（按冻结快照逐名比对：缺名/unverified → Validation 零变化；有 failed → M2 rework 四清
  同构 + `delivery.rework_suggested` + 回 ready_for_implementation；全 passed → `delivery.verification`
  （actor=agent，evidence 命令取自冻结快照）+ phase→release_ready）；fail = **phase 不动**（无阶段可归还，
  只归还 status）；`recordCheckResult` 无业务锁轻量（heartbeat 习语：claim.sessionId 匹配才写）。服务端检查
  执行器 `checks.ts` 的 `runConfiguredCheck`——在候选 checkout 内 spawnSync `/bin/sh`（timeout 缺省 600s，
  超时/ENOBUFS → unverified + exitCode null），日志尾部 32KiB/流写 `<logDir>/<safeName(name)>.log`、logRef
  相对工作项根；**logDir 传 spec §7 布局 `<item>/delivery/artifacts/verification-logs/<attemptId>/`**（tools.ts
  的 run_check）。
  凭证过期/README 摘要变化 → Conflict；**全部 submit/fail 共用的 `requireActiveClaim` 另有一道 cancelled 守卫
  （final-review 修复）：人在领取窗口内 cancel（M2 cancel 只写 status=cancelled）→ 迟到 submit/fail 一律 409
  零状态（claim 保留给 recordInterruption 清——恢复路径不经 requireActiveClaim，不受守卫影响），终态不被复活**。
  `heartbeatActiveClaim` 20s 轻量续约 lastSeenAt（不 bump revision/不产
  事件/不进 git）；`recordInterruption`（锁内清 claim + needsAttention attempt[role 随 claim 流动] +
  `delivery.exec_interrupted`；**状态归还（final-fix，runtime-proven）：claim 借走的 status=in_progress 复位
  open + claim 推进的阶段退回可领阶段（designer design→intake / developer implementation→rfi，守卫同
  fail——人窗口内改过阶段/状态不回滚；终态 cancelled/done 的 item.yaml 整个不动），否则 recover 后项被池
  白名单 + wrong-phase 双重排除、dispatcher 永不重派**；不进 git——关停路径不 spawn git，events.jsonl
  落盘即持久）；`resumeAutomation`
  （人显式恢复：清 paused + 写 failure-window（since=now）+ `delivery.resumed`；未暂停 → 400）。
- **失败预算**：= **自最近 resume 起的尾部连续失败**（`countRecentFailures`：从最新往回数 outcome=failed ∧
  digest 匹配 ∧ 窗口内的记录，**遇第一个 submitted 即停**——成功提交重新起算；interrupted 不计也不断），
  **单工作项作用域**（fix-round 裁定：不跨项按 digest 聚合）且**跨角色共享**（Phase-3 §8：按 digest 计数不问
  角色——designer 与 developer 的失败互相消耗同一预算，防两角色互刷次数绕上限）。同 digest 连续失败 ≥
  maxAttemptsPerInput → writePaused + `delivery.automation_paused`，自动领取停等人显式 resume（resume 重置窗口）。
- **角色授权（`role-grants.ts`）**：**globalThis 单例** Map（sessionId → RoleGrant——`role` 为 `DeliveryRole`
  （designer|developer），Phase-3 泛化；HMR/jiti 双载共享同一张表——Map 分裂会让授予与校验落在两个登记簿、
  身份门全瞎）。dispatcher 拉起会话时 `grantRole`、结束钩子 `revokeRole`；`setGrantToken` 只由工具回调把 claim
  服务一次性核发的 ownerToken（连同 attemptId/generation）补进**已有** grant（工具层不能自授身份）；
  `hasAnyActiveExecution`——**裸授权即占槽**（授予到领取的窗口不许起第二个会话双派发；不问角色——跨角色
  单槽位天然成立）。
- **LLM 工具（`tools.ts`，`createDeliveryRunnerExtension`，extension 名 `pi-delivery-runner`）**：五件
  `delivery_list_ready_tasks / delivery_claim_task / delivery_submit_result / delivery_fail_task /
  delivery_run_check`（list 列三角色合并池、每条带 role；Phase-3 T4 起 claim/submit/fail 按 `grant.role` 分派
  designer/developer 对应服务，Phase-4 T4 增 verifier 三路分派；submit 参数是**扁平可选字段组**——key 必填 +
  design_markdown/acceptance_criteria（designer）、candidates/notes（developer）与 notes（**verifier——只需 key，
  检查结果服务端自 claim.checkResults 取，参数里没有任何检查字段**）全可选；**禁止 union/any-of 形参数
  schema**（2026-10-24 Phase-3 smoke 实测：联合
  schema 在该 pi SDK 的调用侧解析不工作，真 LLM 会话参数全落 `{}` 被 schema 校验全拒，测试钉死不回潮），**服务端按
  grant.role 校验形状**，错形状 → validation 结果文本不进服务）。**`delivery_run_check({name})`（Phase-4 T4，
  verifier 专属——他角色 → denied 文本非异常）**：按 name 在 claim.checkContexts（冻结快照）找配置 → 对应仓的
  候选 checkout（claim.worktrees 按 repositoryId 匹配）→ 服务端 `runConfiguredCheck`（spawnSync 在业务锁外）→
  `recordCheckResult` 累积进 claim.checkResults（**同名覆盖 = 幂等重试**）→ 返回 {name, outcome, exitCode,
  durationMs, logRef}；item 定位 = 本会话名下 verifier claim 扫描（结束钩子兜底同习语）；未知名 → validation
  文本带可用名单。**身份 = `ctx.sessionManager.getSessionId()` +
  `roleGrantOf` 核对**（无 grant / grant 属他工作区 → denied 结果文本，非异常——cxin loop 轮/普通交互会话天然
  无角色身份，拿到拒绝）；凭证三元组（ownerToken/attemptId/generation）全程住进程内 grant，**不进参数
  schema、不进 LLM**；claim 工具结果 **developer/verifier 附 worktrees 清单**（claim.json 随领取落盘，重放同样
  在场——开场合同不写死路径、以它为准；verifier 另附 checks 冻结清单——run_check 的名字来源）；requestId 确定性
  （`claim:<sessionId>:<key>` 等）——传输层重试命中服务幂等重放分支；submit/fail 成功后 grant 重置回裸授权
  （过期凭证不得复用）。confirm-design /
  record-verification / release / block / unblock / cancel / rework 等**人工/动作面刻意不做 LLM 工具**
  （住 M2 delivery 路由——确认与放行是人的手）。
- **角色会话（`role-session.ts`，Phase-3 T4 泛化 `launchRoleSession` / `buildRoleContract`）**：两步创建序——
  `createSession` 不带 command → **`grantRole`（先于 prompt）** → `markDeliveryExecutionActive` →
  `set_session_name`（`${role} · <KEY>`）→ 开场 prompt（fire-and-forget，不 await 轮结束）；开场合同经
  `buildRoleContract(role, …)` 产出、走 facade `CreateSessionInput.appendSystemPrompt` 注入，**限定只领取指派项**
  ——designer = `DESIGNER_CONTRACT` 原文（逐字节保留）；developer 合同（Phase-3 新写）：**只在 claim 返回的
  worktree 清单内改代码**（主工作区与其它目录只读）、**不合并不推送**（合并到主分支由人做）、完成后提交
  candidates（每仓 commit sha）+ notes、**验证结论由人给**（无验证登记动作）；verifier 合同（Phase-4 新写）：
  **检查只经 delivery_run_check 触发（不要自己用 bash 跑替代命令——其结果不作证据）**、对领取返回的 checks
  清单逐项跑完后 submit（只需 key）、**验证环境只读**（发现问题走 rework 反馈，不自行修复代码）、
  **不合并不推送**、环境问题 fail(blocked)——launch 时领取未发生，合同不
  写死路径、指向 `delivery_claim_task` 返回的清单。模型覆写按角色取 = `config.roles[role].model`（roles 显式
  双字段 designer/developer——T5；无 verifier 键，verifier 会话回落默认模型；`CreateSessionInput.model` 透传
  StartSessionOptions）；model 缺省而
  `roles[role].profile` 在场时**从工作区 subagent profile 解析模型**（final review fix——profile 字段曾
  inert，两角色共用）：读 `<workspace>/.pi/agents/<profile>.md` frontmatter 的 `model:` 字段（`provider/model`
  或裸 modelId，复用 `parseFrontmatter`；缺文件/无 model/名字非法/解析抛错 → 静默回落默认模型，至多日志；
  注入缝 `LaunchDeps.readProfileModel`，默认实现 `readDesignerProfileModel`）。**心跳** 20s 续约（interval
  unref，两角色共用同一常量）；**结束钩子**（`wrapper.onDestroy`，先于开场 prompt 武装）：launch key 快路径 +
  **全活动项 claim 扫描兜底**（兜住违约领取——本会话 sessionId 名下每个未清 claim 都 recordInterruption）→
  revokeRole → 清 delivery 登记 → 停心跳（钩子/心跳/登记 role 无关——claim.sessionId 匹配，不问角色）；装配
  失败显式收尾 + destroy 后重抛。
- **Dispatcher（`dispatcher.ts`，HostJob `delivery-dispatcher`）**：30s tick（首拍立即，timer unref），由
  `ensureHostBooted` 装配为**第二个 HostJob**（**lazy import**——work-item 服务不进 resident bundle；
  `PI_TEST_NO_BACKGROUND=1` 同豁免；关停 `stopBackgroundSafely` 双 stop）。每拍每可用工作区两件事：
  ① **超时清道夫**——claim.claimedAt **起算**（lastSeenAt 只是续约不重置上限）超 maxExecutionMinutes →
  probeSession 仍活则定向 destroy + recordInterruption("execution timeout")（记录幂等，与 destroy 触发的
  结束钩子竞写安全）；会话已死（宿主重启遗留）→ 跳过 destroy 仍记录（否则陈旧 claim 经 activeExecution
  永久占死槽位；清道夫 role 无关——claimedAt 起算不变，developer/verifier claim 同样适用）。② **单槽位派发（跨角色
  共享）**——activeExecution（内存 role-grant ∪ claim 扫描，不问角色）在场跳过；ready 池空跳过；否则取**合并
  队列首条**并按 `entry.role` 起 `launchRoleSession`（fire-and-forget；角色由池子投影自带、dispatcher 只透传
  ——消除过渡窗口误派发；Phase-4：verifier 为第三角色经同一分派，零机制变化；launch 的 grantRole 即时占槽，
  同 tick 多余 ready 与下一拍都被 activeExecution 拦住）。
- **路由（T8）**：`GET|PUT /api/workspaces/[id]/delivery`（配置）；`GET .../work-items/[key]/
  delivery-execution`（四读拼装：claim[**剥 ownerTokenHash**] / attempts 末 5 新→旧 / paused /
  pendingInterruption）；`POST .../delivery-execution/stop`（probeSession 活 → 定向 destroy →
  recordInterruption("stopped by user")——中断门禁挡自动重领等人 recover；无 claim → 404）；`POST .../
  delivery-execution/recover`（探测作用域 = **工作区根**——角色会话 cwd；`detectSurvivingRoundProcesses` 残留
  进程 → 409 带 pids，manual 也不放行；干净 → resolveInterruptions + `delivery.exec_recovered`）；`POST
  /api/workspaces/[id]/delivery/resume`（body `{key}`）。
- **事件**：`delivery.claimed / submitted / attempt_failed / automation_paused / exec_interrupted /
  exec_recovered / resumed / rework_suggested` + `work_item.design_updated`（designer 写 design.md 对齐 M2 事件名；
  verifier 全过 submit 复用 `delivery.submitted`（data.outcome=verified），有失败走 `delivery.rework_suggested`）。
- **挂载与泛化**：`buildWorkspaceExtensions` 第二个 `work-items` 工厂条目——build 内补
  `manifest.capabilities.includes("workflows")` 合取门（单 capability 注册表表达不了合取；不满足返回
  undefined 静默不挂载），挂载后工具运行时另有角色授权身份门。M1 的 ActiveRoundInfo **泛化**
  `kind: "loop-round" | "delivery"` + `itemKey`（loop 调用方不写 kind，语义零变化；关停对 kind="delivery"
  且仍在跑的执行写 claim 中断而非 loop 中断记录——`buildShutdownPlan` 双产物）；facade `CreateSessionInput`
  增 `appendSystemPrompt` / `model` 透传（StartSessionOptions）。
- **已知边角（如实记录）**：workspace.disabled **不参与 dispatch**（dispatcher 只看 `available`——与 loop
  心跳先例一致：停用影响 UI 可见性，不停后台自动化）；delivery 的中断横幅/「重新检查并恢复」与 M1 loop
  面板同习语但**文件分离**（中断住 attempts 审计文件 ≠ `lib/loops/executions.ts`；recover 路由复用同一
  `detectSurvivingRoundProcesses` 做只读探测）。

### Loop（pi-loop kit；`lib/session-host/loop-spawner.ts` + `packages/pi-loop/` + `kit/`）

**Loop = 文件协议 + 心跳。** v3 引擎（orchestrator session / seeder / RUNS.jsonl / gate 机器）已拆除
（设计：`docs/pi-loop-kit-design.md`；宿主层修订——beat/补跑/锁/D13——见 `docs/pi-loop-host-design.md`）。现行形态：

- **声明**：workspace 根 `.pi/loops/<name>/LOOP.md` 存在即 loop（frontmatter：cron/timezone/level/max_minutes/pattern）；
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
  `max_minutes` 超时 → `destroy()` **定向杀**（SDK destroy→dispose→abortBash 按执行进程组 kill）；共享宿主
  **禁止 cwd 收敛收割**（spawner 的 reaper 依赖默认 NO-OP，注入点留给测试/独立宿主；beat CLI 自带收割不受影响），
  残余孤儿交由恢复期**只读探测**报告（`lib/loops/executions.ts` 的 `detectSurvivingRoundProcesses`）。
  **恢复门禁（spec §5.4）**：上次关停留下的未确认中断记录在场 → 该 loop 不起新轮；管理面「重新检查并恢复」=
  `POST …/loops/[name]/recover`（探测到存活残留进程 → 409；干净 → resolve 记录），loops GET 附带 `interruptions` 字段。
- **补跑语义（anacron-lite）**：fire 判定 = `now >= nextDue(cron, tz, .lastrun)`——宿主睡眠/停机错过的槽位恢复后
  至多**补一轮**（旧分钟槽语义是静默丢失；A 轮在跑也不再丢 B 的槽，`.lastrun` per-loop）。`.lastrun` / `.round.lock`
  是宿主文件，agent 禁改禁删（与 `PAUSED` 同级，写进协议条款与开场合同）。
- **运行状态**：只有 `STATE.md`（记忆脊柱：Last run / 优先级分区 / [BUDGET] / 复盘节）+ `.pi/loops/<name>/loop-ledger.json`（断路器，
  **per-loop**：`.pi/loops/<name>/loop-ledger.json`，D13 修订——断路计数跨 loop 混算无意义）+ workspace git log。
  宪法文件（LOOP.md 的 level/cron、`.pi/loop/constraints.md`、`.pi/loop/budget.md`）agent 一律禁改；constraints/budget 维持
  根共享（budget 是全 workspace 总帽）。
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
  两个 LLM 工具透传）；**绑定 = 路由收窄**——loop 轮拾取候选 = 「绑给我的项 + 未绑定项」，未命中/已删 loop 的绑定按未绑定
  处理；SKILL.md 的选择段声明该过滤语义（候选 = 绑定项 ∪ 未绑定项）。管理面：
  ① 工作项「立即跑一轮」（B 按钮，`lib/loops/rounds.ts` `launchManualRound`）走 `POST …/loops/[name]/run`——web 进程
  import pi-loop 纯逻辑组装开场合同，经**进程内宿主 facade 两步建会话**（`createSession` 不带 command → sessionId 进
  开场合同第 3 条 → `sendCommand` prompt；依赖全注入，无 HTTP 往返）；可选 `itemKey` → 合同追加「本轮优先处理 <KEY>」。
  手动轮**无 D9 自动归档**
  （人在场），锁**保持持有**靠 stale 窗（maxMinutes+15min）兜底回收，至多丢一个后续心跳槽（anacron-lite 不放大）；
  轮收尾后锁在 stale 窗内仍是「假运行中」（按钮禁用 + 409 误报 + 心跳槽被吃）——run/stop 路由注入
  `runningSessionIds` 做**幽灵锁活性接管**（`isPhantomRoundLock`：宿主锁带 sessionId、锁龄过
  `PHANTOM_LOCK_GRACE_MS` 2min 宽限、且不在宿主 running set（`facade.runningStatus().ids`）→ 证明轮已死，清锁重取/直接停；beat 锁与
  启动窗口锁不判，探测失败保守不接管），假窗口从最长 maxMinutes+15min 收窄到分钟级；LoopRow 按钮
  disabled 有视觉（opacity+cursor），不再「能点但没反应」。
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
  知识文档编辑（任意命名，白名单）、根级宪法编辑（缺失预填模板）、STATE.md 只读、删除（锁活 409 /
  绑定项二次确认 / SKILL 与宪法不删）。**不编辑 SKILL.md**。服务端逻辑全在 `lib/loops/manage.ts`
  （唯一 PUT 写入口 + 文件名白名单 + mtime 乐观并发 + 原子写），路由薄壳
  （`POST /loops`、`GET|PUT /loops/[name]/docs`、`DELETE /loops/[name]`）。
- **工作项工具**新增 `loop` 绑定透传（见上）；外部源同步已下放工作区脚本（见「外部源适配」节）；subagent 一律走内置体系（全局挂载，见下节——kit 轮会话 cwd=workspace 根，profile 自动按 `<cwd>/.pi/agents/` 发现，无需 per-session 注入）。
- **模板**：`kit/templates/basic/{loop,root,skill}/`（D13 布局：LOOP/STATE/ledger 在 `loop/`，constraints/budget 在
  `root/`，SKILL.md 骨架在 `skill/`（spec §4）；`pi-loop init` 由此脚手架；LOOP.md 指针含「本目录说明文件」步骤——人写
  知识文档约定，如 chandao.md/selection.md，agent 只读、改知识不改 SKILL）、`kit/templates/github/loop.yml`
  （Actions 场景）；`kit/README.md` 是协议契约（含 L1/L2/L3 分级、宿主/beat 用法与调参指引）。

**轮会话是一次性普通会话**：跑完一轮自然 settle，无状态恢复问题（崩溃 → 下轮冷启动读 STATE.md 接续）；v3 的
双开 guard / `loop.active_session` 戳 / 僵尸收割在「每轮短进程」模型下天然消失。
### Subagent (built-in, upstream v0.9.1 port)

**In-process child AgentSessions** owned by the same in-process host registry as
interactive sessions and kit rounds (live SSE / steer / abort through the
existing session surface). Ported from upstream v0.9.1 + fixes `9d282da`/`20a2579`;
the community `@henryqw/pi-subagent` package was removed (its `delegate_task`
result panel remains for history rendering). Canonical doc: `docs/subagent.md`.

- **Tools**: `Agent` (profile, prompt, run_in_background, resume, input_files,
  model/thinking/max_turns/inherit_context/isolation overrides),
  `get_subagent_result`, `steer_subagent`. Children strip them again
  (`SUBAGENT_CONTROL_TOOL_NAMES`) — no recursive orchestration.
- **Always global**: `lib/session-host/registry.ts` attaches
  `createSubagentExtension` to **every** session (same posture the community
  package had); still NOT in `WORKSPACE_EXTENSION_FACTORIES` /
  `ALL_WORKSPACE_CAPABILITIES`.
- **Profiles** (builtin `general-purpose`/`explore`/`plan` < global
  `~/.pi/agent/agents/*.md` < workspace `<cwd>/.agents/agents/*.md` < project
  `<cwd>/.pi/agents/*.md` — FLAT, not the community package's `pi-subagent/`
  subdir; same name wins upward). Frontmatter: `display_name`/`description`/
  `tools`(+`ext:` selectors)/`skills|load_skills`/`extensions|load_extensions`/
  `model`/`thinking`/`max_turns`/`inherit_context`/`run_in_background`/
  `prompt_mode`/`isolation`/`persist_session`/`enabled`; unmanaged keys
  round-trip on save. CRUD in the settings panel `Agents` section
  (`AgentsConfig.tsx`).
- **Settings**: `~/.pi/agent/agents/settings.json` — `builtInEnabled`
  (fork default ON — replaces the always-on community package; damaged file
  fails OPEN) + `maxConcurrent` (per-parent FIFO, default 10, max 32).
- **Timeouts — upstream semantics**: NO idle kill, NO runtime cap; opt-in
  `max_turns` soft limit only. The heartbeat monitor EXEMPTS subagent children
  (killing a hidden silent child was the community kill policy this fork
  rejected); the settled-idle 10-min teardown is ordinary registry cleanup.
- **Child sessions**: in-process, persisted by default, keep the
  `pi-subagent-<uuid>` id prefix (via `NewSessionOptions.id`) so
  `lib/subagent-child.ts` tagging, sidebar hiding and locate/open work
  unchanged across eras. Run status/status transitions are custom entries in
  the child file (`pi-web:subagent[-status|-result]`) — crash recovery derives
  `interrupted`.
- **Result shape** (MessageView): `details = {kind: "pi-web-subagent",
  sessionId, profile, status, error?, worktreePath?}` with an open-session
  button; `lib/session-subagents.ts` derives the drawer from BOTH transports.
- **Model routing**: per-profile `model`, else inherit the parent's. The old
  `pi-task-models.json` `pi-subagent/delegateTask` key is inert.

### Git & Changes (`lib/git-changes.ts`, `lib/git-status.ts`, `lib/git-discover.ts`)

- `getGitStatus(cwd)`: walks the tree once (`git-discover.ts`) to find **every** nested repo root, queries each, and
  builds per-repo `RepoGroup[]` (the cwd-enclosing repo, scoped to cwd, first; then nested repos by relative path).
  Nested-repo boundary entries reported by a parent are deduped against the nested repo's own group. Returns groups +
  grand `additions`/`deletions` totals.
- `getGitFileDiff(cwd, filePath)`: resolves the repo from the **file's** location, builds a unified patch (synthesized
  "new file" patch for untracked; `git diff HEAD` otherwise; respects rename pairs).
- APIs: `GET /api/git/status?cwd=`, `GET /api/git/diff?cwd=&path=` — guarded by the file-access allow-list. Polled by
  `hooks/useGitStatus.ts`; rendered by `components/ChangesPanel.tsx` — **always grouped by repository** (even a
  single dirty repo gets a named group header with file count + +/- subtotal; the cwd-enclosing repo group defaults to
  expanded, nested repo groups to collapsed; only clean repos produce no group). The Changes list surfaces via the
  `[ 文件 | 改动(N) ]` segmented switch in `FilesExplorerPanel` — ONE component, two hosts (desktop right panel's pinned「文件」tab /
  mobile「文件」tab; both persist the choice in `localStorage` key `pi-explorer-tab:<wsId>` so the surfaces agree) — both
  follow the Explorer's current cwd scope; `ChangesPanel` itself is unchanged.
  Non-git directories hide the "改动" segment. `SessionSidebar` keeps its own standalone Changes section.

### 外部源适配 = 工作区脚本（importer 已退役）

**pi-web 不再内置 importer**：`lib/work-items/importers/`、`app/api/workspaces/[id]/importers/**`、`components/ImporterConfig.tsx`、daemon 的 `ImporterScheduler`/`/v1/importers/sync` 路由及 `requirement-sources` capability 已全部删除（strangler 计划；capability 照 `overview`/`loop` 先例退役——读路径剥离，新写入 400）。外部需求/bug 源（禅道等）的同步 = **工作区自己的脚本**，参考实例 cxin（cxin-workspace 仓内）`scripts/chandao-sync.py`（凭据 `.pi/chandao.json`）：纯 stdlib、凭据存工作区本地（0600 且 gitignored）、日志不打印密码/token，由工作区自己的 cron/loop 触发；脚本直接调 pi-web HTTP API 创建/更新工作项，`external: {source, sourceId, ...}` 章即去重键（重新同步同一条不重复建项），LLM 工作项工具不透传该字段。同步摘要语义（脚本层继承自原 runner 约定）：单条 item 失败不中断同步（failed[] 记录）；结构性失败（登录失败/API 不可达/凭据缺失）退出码 2；已存在未归档项不盖 `imported` 里程碑（防 events 洪水，REQ-0012 教训），仅在摘要计数 synced。工作项的「来源」展示（`lib/work-items/source-labels.ts` 标签映射）保持不变。

### Dev Loop (pi-loop kit 实例；reference: cxin-workspace)

**Loops are per-workspace file protocols — pi-web ships no loop engine.** The generic surface is the kit spawner
(`lib/session-host/loop-spawner.ts`) + the `kit/` template library; every loop's behavior lives in its workspace
(`.pi/loops/<name>/LOOP.md` declaration + `STATE.md` spine + root constitution files + `.pi/skills/<pattern>/SKILL.md`
contract + `.pi/agents/*.md` roles). There is no loop authoring UI and no dev-loop code path in pi-web; cxin-workspace's
v3 leftovers (`loop.yaml`/`RUNS.jsonl`/`LEARN.jsonl`, v1/v2 baks) stay in place unread — git history is the audit
(design §8.7: no migration, no deletion).

The **dev Loop** is the R&D loop pattern deployed in cxin (cxin-workspace), migrated to kit form (v3 history:
`docs/dev-loop-v3-design.md`, retired 2026-09). One heartbeat = ONE round session doing selection AND execution:

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
- **Run state**: `STATE.md` (High Priority / Watch List / Recent Noise / [BUDGET] / Post-run critique) +
  `.pi/loops/<name>/loop-ledger.json` breaker (same error digest ×3 or >3 attempts on one item → escalated). Constitution
  (`.pi/loop/constraints.md` path blacklist + discipline, `.pi/loop/budget.md` caps) is root-level shared by all loops of the
  workspace (D13) and agent-immutable.
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
  L1 验证；全新 loop 一律 L1 起步), `STATE.md` spine, root-level `.pi/loop/constraints.md` / `.pi/loop/budget.md` / `.pi/loops/<name>/loop-ledger.json`
  (shared per D13), contract in `.pi/skills/dev-loop/SKILL.md`（六点改造：选择/执行合并为一轮、gate 里程碑由**轮自己**盖、
  双开 guard / `loop.active_session` 戳删除）, roles in `.pi/agents/` (built-in discovery: flat `*.md` profiles — see Subagent below). v3 leftovers (`loop.yaml`, `RUNS.jsonl`,
  `LEARN.jsonl`, v1/v2 baks) stay in place unread. Sensitive module list + module→repo map:
  `cargo-knowledge/standards/dev-loop-modules.md`; consolidated process lessons in `cargo-knowledge/learnings/`
  (contentHash'd).
- **Host wiring**: `instrumentation.ts` boots the in-process host — `ensureHostBooted()`（`lib/session-host/background.ts`：
  老 daemon 迁移守卫 → LoopKitSpawner（`loop-kit-heartbeats`, unconditional）→ shutdown handlers）
  + 默认工作区补建，两者均 fire-and-forget。没有第二个进程。

### Workspace directory layout (reference)

**2026-09 一套约定：pi 机制与数据统一收在工作区根的 `.pi/` 下（`packages/pi-loop/paths.ts` 是路径唯一源）；
工作区根留人的内容** —— 代码仓/知识库是根下的普通目录，由 manifest 按相对路径登记
（`repositories[].path`，`repositories/<kind>/<alias>` 固定布局已废除；`AddWorkspaceRepositoryInput.mode`
含 `register` 用于登记已有目录）。工作区可以是任意外部路径（index 条目直接指过去，如
`/Users/qiancheng/Documents/Workspace/cxin-workspace`），不必住在 workspaces 目录下。

Default locations are under `~/.pi` — but local dev can relocate the whole data home INTO the repo via
`scripts/adopt-pi-home.mjs` + `.env.local` (see "Local pi data home" under Key Design Decisions): `agent/` and
`workspaces/` then live at `<repo>/.pi/`, the global index becomes `<repo>/.pi/workspace-index.yaml` (renamed —
`.pi/workspace.yaml` in this repo is the pi-web workspace MANIFEST), and `.pi/agent` + `.pi/workspaces` are
strictly gitignored / tsc+eslint excluded / pruned by git-discovery.

```
~/.pi/
  workspace.yaml                         global workspace index
  workspaces/                            ($PI_WORKSPACES_DIR; 2026-09 起工作区也可以是任意外部路径)
    workspace-<slug>/                    （或任意外部路径的工作区根）
      AGENTS.md                          （永远在根：pi 从 cwd 根注入）
      .pi/workspace.yaml                 manifest（repositories[].path = 仓库相对路径）
      .pi/work-items/{requirements,bugs}/
                                         work items: <KEY>-<slug>/{item.yaml, README.md, events.jsonl, attachments/
                                         [, delivery/artifacts/design.md][, delivery/attempts/*.json][, delivery/runtime/]}
                                         （attempts = 追加审计；runtime/ = claim/paused/failure-window 运行态，
                                         gitignored、advisory——Phase-2 交付自动化）
      .pi/trash/work-items/<KEY>-<ts>/   回收站（DELETE 移入；item.yaml 兼任外部源去重墓碑；restore-from-trash 恢复）
      .pi/skills/<pattern>/SKILL.md      项目技能合同（pi 原生发现 <cwd>/.pi/skills/；旧 .agents/skills/ 已迁移）
      .pi/loops/<name>/{LOOP.md, STATE.md, loop-ledger.json, .lastrun, .round.lock, [PAUSED], LEARN/}
                                         kit loop declaration + memory spine (D5 文件即声明)
      .pi/loop/{constraints.md, budget.md, pause-all}
                                         根级共享宪法 + 全局停机旗（原根级 loop-constraints/loop-budget/loop-pause-all）
      .pi/delivery.yaml                   交付自动化配置（2026-10 Phase-2/3：enabled 缺省 false / roles
                                         designer+developer 各自 profile+model / budget——见 Work Items 章
                                         「Delivery 自动执行」）
      .pi/agents/*.md                    subagent 项目 profile（平铺）；.pi/cache/ 可重建缓存
      <alias>/                           代码仓 / 知识库（根级目录，路径登记；各自独立 git）
      docs/ scripts/ …                   人的内容
    .pi/workspace-templates/<id>/        custom templates (template.yaml + seed/)
  agent/                                 (~/.pi/agent)
    sessions/<encoded-cwd>/*.jsonl
    agents/*.md                          legacy built-in subagent agents (retired; see lib/subagent-child.ts)
    config/pi-subagent/*.md               community subagent user-level roles (frontmatter: name/description/tools/extensions/skills)
    config/pi-task-models.json           task-model profiles required by delegate_task
```

---

## File Map

```
scripts/
  adopt-pi-home.mjs               one-time migration of ~/.pi into <repo>/.pi (moves data, rewrites absolute-path
                                   references — index entries / encoded session dir names / .jsonl cwd+parentSession —
                                   writes .env.local, patches shell rc; idempotent repair mode)

bin/
  pi-web.js                       npm bin wrapper — node 版本检查 + 直接 spawn next CLI（单进程：没有别的进程要拉起）

app/api/
  sessions/route.ts                      GET  list all sessions (grouped by project/worktree root)
  sessions/[id]/route.ts                 GET/PATCH/DELETE session
  sessions/[id]/context/route.ts         GET ?leafId= — context for a specific leaf (tail-windowed via ?tail=)
  sessions/[id]/earlier/route.ts         GET ?before=&limit=&leafId= — older-messages page for tail-first loading
  sessions/[id]/export/route.ts          GET exported HTML for a session
  sessions/[id]/state|archive|restore|locate|auto-name/route.ts   session lifecycle helpers
  sessions/[id]/entries/[entryId]/thinking/route.ts               GET a thinking block
  agent/new/route.ts                     POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts                    GET state | POST any command（全部直连 lib/session-host/facade，下同）
  agent/[id]/events/route.ts             GET SSE stream（进程内 Web-stream，lib/session-host/sse.ts）
  agent/[id]/bash-output/route.ts        GET bash output for a tool call
  agent/running/events/route.ts          GET SSE stream of currently-running session ids
  subagents/[id]/route.ts                GET subagent run status | POST steer/abort（facade getSubagentRunStatus/controlSubagent）
  subagents/profiles|settings/route.ts   subagent profiles / builtInEnabled+maxConcurrent settings
  workspaces/route.ts                    GET list+templates | POST create/import a workspace | PATCH { order: [ids] } 手动排序（索引 sortOrder 重编，一次写；不碰 manifest/git）
  workspaces/[id]/route.ts               GET | PATCH (capabilities/name/skills/disabled) | DELETE
  workspaces/[id]/repositories/route.ts  GET | POST add(clone/init) | DELETE soft-remove | PATCH restore
  workspaces/[id]/work-items/route.ts            GET list | POST create
  workspaces/[id]/work-items/[key]/route.ts      GET | PATCH (revision-safe) | DELETE trash
  workspaces/[id]/work-items/[key]/events/route.ts   POST record milestone
  workspaces/[id]/work-items/[key]/attachments/route.ts  POST multipart attachments upload（service.addWorkItemAttachments：attachments/ 落盘 + README「## 附件」小节 + attachment_added 事件）
  workspaces/[id]/work-items/[key]/content/route.ts  PUT update README body
  workspaces/[id]/work-items/[key]/delivery/[action]/route.ts  POST 标准交付流动作（body {expectedRevision, requestId, payload}；slug 门 = DELIVERY_ACTIONS 权威表；applyDeliveryAction 锁内 + requestId 幂等，replay 返回 replayed:true；400 Validation/404 NotFound|未播种 design.md/409 revision|锁忙）
  workspaces/[id]/work-items/[key]/design/route.ts   GET 设计文档（readDesign：未播种 404）| POST 编辑（updateDesignContent：失效回退 + revision bump）
  workspaces/[id]/work-items/[key]/restore-from-trash/route.ts  POST 从回收站恢复（restoreWorkItemFromTrashInRoot：key 被占 409 / 墓碑损坏 400 / 无命中 404）
  workspaces/[id]/delivery/route.ts               GET|PUT 交付自动化配置 .pi/delivery.yaml（Phase-2；PUT 前 assertAutomationCapable 门 work-items+workflows；文件缺失 GET = {config:null} = disabled；坏 YAML/结构 → 400）
  workspaces/[id]/delivery/resume/route.ts        POST 恢复自动领取（body {key}：清 automation-paused + 重置失败窗口 + delivery.resumed，actor=user；未暂停 → 400）
  workspaces/[id]/work-items/[key]/delivery-execution/route.ts       GET 执行状态四读（claim[剥 ownerTokenHash] / attempts 末 5 新→旧 / paused / pendingInterruption；item 不存在 404）
  workspaces/[id]/work-items/[key]/delivery-execution/stop|recover/route.ts  POST 停止执行（probeSession 活→定向 destroy→recordInterruption "stopped by user"，无 claim 404）| 重新检查并恢复（探测作用域=工作区根；残留进程 → 409 带 pids——manual 也不放行；干净 → resolveInterruptions + delivery.exec_recovered）
  workspaces/[id]/loops/route.ts                  GET kit loops 全量状态（collectStatus：frontmatter 摘要 + .lastrun/next-due/锁活性/paused + 附 additive interruptions[执行中断记录]，管理面全量；web spec §5.1；D5 文件即声明 — no capability）| POST 创建（initLoop 脚手架）
  workspaces/[id]/loops/[name]/route.ts           PATCH frontmatter 四字段（cron/timezone/level/max_minutes）round-trip — 正文 byte 保留（「人的手」，S5；纯逻辑 pi-loop/frontmatter.ts，tmp+rename 原子写）| DELETE 删除（锁活/绑定守卫）
  workspaces/[id]/loops/[name]/run/route.ts       POST 立即跑一轮（launchManualRound，可选 itemKey → 合同追加优先项；返回 sessionId 供 UI 打开轮会话 tab；facade 两步建会话）
  workspaces/[id]/loops/[name]/pause/route.ts     POST 写 PAUSED 标记（幂等；在跑轮靠开场合同规则 6 合作收尾）
  workspaces/[id]/loops/[name]/resume/route.ts    POST 删 PAUSED 标记（幂等）
  workspaces/[id]/loops/[name]/stop/route.ts      POST 终止本轮（宿主持有 → facade destroy+释放锁[定向杀，不 cwd 收割]；beat 持有 → 409 提示走 pi-loop stop）
  workspaces/[id]/loops/[name]/recover/route.ts   POST 重新检查并恢复（spec §5.4）：detectSurvivingRoundProcesses 只读探测——残留命令进程 → 409 报 pid；干净 → resolveExecutionRecords（manual=true 记 recovered-manual/actor=user，否则 recovered-auto）解除恢复门禁
  workspaces/[id]/loops/[name]/docs/route.ts      GET 配置面板数据包 | PUT 唯一写入口（doc|body|constitution，mtime 乐观并发）
  git/status/route.ts                    GET ?cwd= — per-repo changed files + totals
  git/diff/route.ts                      GET ?cwd=&path= — unified patch for one file
  auth/all-providers|providers/route.ts  GET provider lists (OAuth)
  auth/api-key/[provider]/route.ts       GET/POST/DELETE API-key status/storage
  auth/login/[provider]/route.ts         GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts        POST OAuth logout
  cwd/validate|browse/route.ts           POST validate/select | browse a cwd
  default-cwd/route.ts                   POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts               GET file contents for viewer
  uploads/route.ts                       POST 聊天文件附件上传（multipart files；落盘位置服务端定：lib/uploads-root.ts 的 <agentDir>/uploads/<yyyymmdd>/，同名不覆盖；25MB/个、100MB/次）
  file-index/route.ts                    GET per-repo ls-files + scattered files for fuzzy open
  health/route.ts                        GET server health
  home/route.ts                          GET user home directory
  models/route.ts                        GET { models, modelList, defaultModel }
  models-config/route.ts                 GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog|discover|test/route.ts  pricing presets / upstream discovery / test
  plugins/route.ts                       GET/POST package plugin management
  project-trust/route.ts                 GET/POST untrusted-project extension gating
  skills/route.ts                        GET/PATCH loaded skills and disable-model-invocation
  skills/install|update|search|check/route.ts  install / update / search.sh / lockfile check
  worktrees/route.ts                     GET/POST/DELETE git worktrees

lib/
  abort-race.ts             raceAbort (promise vs AbortSignal, with onLateSettle cleanup) + creationTimeoutSignal — bounds session CREATION everywhere a startRpcSession hang would pin a turn/run (interactive create, kit round)
  session-host/                       THE in-process session host (2026-10 M1 single-process): the Next.js Node.js server owns every AgentSession
    registry.ts            session registry (globalThis) + AgentSessionWrapper + startRpcSession + subagent controller（自 lib/daemon/rpc-manager.ts 迁入；attaches the global built-in subagent extension + wires SUBAGENT_CONTROLLER；routes 一律经 facade 消费，不直接 import 本模块）
    facade.ts              typed in-process facade — createSession/sendCommand/probeSession/destroySession/autoNameSession/busyForCwd/reloadCwdSessions/liveSessions/runningStatus/getSubagentRunStatus/controlSubagent；SessionHostError(.status) owns error→HTTP mapping；live-first + cold-start-from-.jsonl revive（旧 daemon /v1/sessions 面的进程内移植）；CreateSessionInput 增 appendSystemPrompt/model 透传 StartSessionOptions（delivery 角色会话用——designer/developer，Phase-2/3）
    sse.ts                 Web-stream SSE（serveSessionEventStream/serveRunningEventStream/openSessionEventStream）——ByteLengthQueuingStrategy + desiredSize<=0 的 drain-aware stall cap（SSE_STALL_BYTES_DEFAULT 1MB：慢客户端只看未排水字节，健康观看者总量再大也不切断）；connected 帧先行、30s 心跳注释、destroy 即断流、req.signal 只取消订阅不碰会话
    heartbeat.ts           stall classify/warn/kill 纯逻辑（warn 5min / kill 20min，env PI_SESSION_STALL_*_MS）
    jobs.ts                HostJob {id,start,stop} + HostJobRegistry —— 宿主后台 job 注册表（静态装配，无运行时发现）
    loop-spawner.ts        LoopKitSpawner（HostJob loop-kit-heartbeats, 30s tick）+ runKitRound/waitForRoundSettle/settleRoundBookkeeping（D9）；deps 全注入；恢复门禁（pendingInterruption——未确认中断记录在场不起轮）；轮登记（markActive/clearActive，关停据此写中断记录）；reaper 默认 NO-OP（共享宿主禁 cwd 收割——destroy 定向杀，残余孤儿交恢复期只读探测）
    background.ts          ensureHostBooted（globalThis 单次装配：老 daemon 迁移守卫 → LoopKitSpawner + DeliveryDispatcher 并行懒加载链（Phase-2 T7 第二 HostJob，见 work-items/delivery-runner/dispatcher.ts）→ shutdown handlers；PI_TEST_NO_BACKGROUND=1 测试缝同豁免两个 job）+ markRoundActive/clearRoundMark/listActiveRounds（ActiveRoundInfo 泛化 kind: loop-round|delivery + itemKey——Phase-2；另 markDeliveryExecutionActive/clearDeliveryExecutionMark 对称原语）+ registerShutdownHandlers/buildShutdownPlan（关停序列：停新轮（stopBackgroundSafely 双 job）→ 快照 running → destroy 全部 → 写中断记录（loop 轮写 ExecutionRecord，kind=delivery 写 claim 中断——双产物）→ exit 0）
  workspaces/
    types.ts                WorkspaceManifest / WorkspaceCapability / WorkspaceRepository / templates
    service.ts              manifest CRUD, capability validation (ALL_WORKSPACE_CAPABILITIES), repos, index, managed AGENTS.md (repositories + knowledge segments); **ensureDefaultWorkspace** — 初始化时补建默认「默认」工作区（name 默认 / slug default，最小能力集，见 Workspace Subsystem 章；幂等 + 墓碑 `.pi-default-deleted`，removeWorkspace 删默认时写，删后永不复活；目录在磁盘未注册 → importWorkspace 自愈重注册）; **withWorkspaceWriteLock** = 双层写锁（进程内 Promise 队列 × file-lock.ts 文件层，见 Work Items 章锁条目）
    file-lock.ts            跨进程短写锁（2026-10 M2）：withWorkspaceFileLock（O_EXCL + owner token + stale 30s 抢占 + token 校验释放）+ resolveLockPath（目录 `.pi/.write-lock` / 文件 sibling `<file>.write-lock`）；busy → WorkItemConflictError(409)
    templates.ts            capability init constants (MANDATORY/INIT checklist, normalizeInitCapabilities) + renderWorkspaceAgents (capability-driven) + renderWorkspaceRepositories + renderKnowledgeSection + legacy built-in templates
    okf.ts                  OKF v0.2 structure constants + renderOkfSeed (index.md/log.md/example concept for newly init'd knowledge repos)
    kb-search/              opt-in L1 `kb_search` tool + pure-JS BM25 index (self-healing, cross-bundle)
      index.ts              ensureIndex() (mtime-incremental, .pi/cache rebuildable) + searchIndex() (Okapi BM25, CJK-aware tokenize)
      extension.ts          createKbSearchExtension() — `kb_search` InlineExtension (query/limit/filters), re-resolves active bundles per call
    extensions.ts           WORKSPACE_EXTENSION_FACTORIES + buildWorkspaceExtensions (tool modules；第二个 work-items 条目 = delivery-runner 工厂——build 内补 workflows 合取门，Phase-2)
    id.ts                   ULID generator
  work-items/
    types.ts                WorkItemRecord / phases（七阶段 delivery 扩展 + 老子阶段）/ events (incl. optional `external` source ref) / WorkItemImportOutcome / CreateWorkItemInput.enableDelivery
    delivery-types.ts       DeliveryAction 11 个 + DeliveryMetadata（protocolVersion 1 / mode manual；designConfirmed/candidates/verification/releasePlan/release/lastRequest）+ contentDigest/candidatesDigest（sha256）+ parseDelivery（未知 protocolVersion/非 manual 硬错误）+ DELIVERY_ACTIONS 权威表
    delivery.ts             标准交付流（2026-10 M2）：planDeliveryTransition（纯，digest 注入）+ applyDeliveryAction（锁内 + requestId 幂等 + design.md 播种）+ readDesign/updateDesignContent（design.md 编辑 + 失效回退）；re-export legalDeliveryActions
    delivery-runner/        交付自动执行（2026-10 Phase-2 designer 首角色 + Phase-3 developer 第二角色——详见 Work Items 章「Delivery 自动执行」节；verifier/release-preparer/多槽位/依赖图/worktree 自动清理未实现，跨角色共享单槽位/工作区）
      config.ts             .pi/delivery.yaml 读写 + parseDeliveryRunnerConfig（roles 显式双字段 designer/developer 同规校验、enabled 缺省 false、budget 缺省 3/30、字段级 Validation）+ assertAutomationCapable（manifest 须含 work-items+workflows）
      pool.ts               双角色池子（Phase-3 合并）：projectDeliveryPool 纯投影（角色由阶段决定：rfi→developer 其余→designer；designer 谓词 managed∧enabled∧intake；developer 另加 designConfirmed 真值∧仓库范围非空∧每仓登记且 active（reason no-repo-scope/design-unconfirmed/repo-not-registered）；共用 无claim∧无中断∧未暂停∧失败未达上限∧status∈{open,blocked} 白名单∧未归档；两角色合并队列 P0→P3→key）+ listDeliveryPool 读取端装配（运行时信号 + contentDigest + manifest 登记仓表）
      worktrees.ts          developer 领取的 worktree 预建与候选核验（Phase-3 T2）：prepareWorktrees（分支 pi-delivery/<KEY>/gen<N>、仓旁 <repoRoot>-worktrees/ 目录、同代幂等复用、先整表登记复验、失败零状态已建不回滚）+ verifyCandidateCommits（rev-parse ^{commit} 核验，ref 非 40-hex 也接受）
      attempts.ts           claim.json/automation-paused/failure-window（runtime/ advisory 运行态，claim 首写时幂等接进 .gitignore；宽松读）+ attempts/ 追加审计 + resolveInterruptions + countRecentFailures（自最近 resume 起的尾部连续失败，遇 submitted 断）+ ownerToken 只存 sha256（hashOwnerToken）
      claim.ts              领取事务（designer + developer + verifier 九函数共用骨架）：claimDesignerTask（intake→design + design.md 播种）/ claimDeveloperTask（worktree 预建先于状态落盘 + designDigest 快照，rfi→implementation）/ claimVerifierTask（Phase-4：候选 detached checkout 预建 + candidateDigest/checkContexts/checkResults 冻结，phase 不变）/ submitDesignerResult（等人 confirm）/ submitDeveloperResult（双 digest+designConfirmed+phase 门复验 + 候选核验 → M2 submit-verification 语义内联进 verification）/ submitVerifierResult（证据只取 claim.checkResults 按冻结快照逐名比对 → 全过 delivery.verification+release_ready / 有失败 rework 四清+rework_suggested）/ failDesignerTask|failDeveloperTask（回退守卫 design→intake / implementation→rfi）/ failVerifierTask（phase 不动）+ recordCheckResult（heartbeat 习语证据累积）+ heartbeatActiveClaim（20s 续约）+ recordInterruption + resumeAutomation
      role-grants.ts        globalThis 单例角色授权表（grantRole/revokeRole/roleGrantOf/setGrantToken——token 只进进程内 grant；hasAnyActiveExecution 裸授权即占槽）
      tools.ts              delivery_list_ready_tasks/claim/submit/fail/run_check 五工具（pi-delivery-runner extension；claim/submit/fail 按 grant.role 三路分派 designer/developer/verifier 服务，submit 扁平可选字段组（union/any-of schema 被 SDK 调用侧解析毁掉，禁用）服务端按角色校验（verifier 只需 key），claim 结果 developer/verifier 附 worktrees 清单 + verifier 附 checks 冻结清单；run_check（Phase-4 verifier 专属）：按冻结快照找配置 → 候选 checkout 服务端 runConfiguredCheck → recordCheckResult 累积（同名覆盖）；身份=ctx.sessionManager.getSessionId()+grant 核对，无 grant → denied 文本；凭证不进参数 schema；人工动作面刻意不做工具）
      role-session.ts       launchRoleSession/buildRoleContract（Phase-3 T4 泛化双角色、Phase-4 T4 增 verifier 合同；designer 合同逐字节保留，developer 合同 = 只在 claim 返回的 worktree 内改码/不合并不推送/提交 candidates/验证由人，verifier 合同 = 检查只经 delivery_run_check（bash 替代不作证据）/验证环境只读不自行修复/不合并不推送/submit 只需 key）：两步创建（sessionId→grantRole 先于 prompt→登记→命名 `${role} · KEY`→开场合同 appendSystemPrompt 限定只领指派项）+ 20s 心跳 + 结束钩子（onDestroy：launch key 快路径 ∪ 全活动项 claim 扫描兜底 → recordInterruption → revoke/clear）
      dispatcher.ts         DeliveryDispatcher（HostJob delivery-dispatcher，30s tick：超时清道夫[claim.claimedAt 起算超 maxExecutionMinutes → probe 活则定向 destroy + recordInterruption；死会话仍记录；role 无关] + 单槽位派发[activeExecution = 内存 grant ∪ claim 扫描，跨角色共享；合并队列取首、按 entry.role 起 launchRoleSession]）
    legal-actions.ts        legalDeliveryActions / legalActionBarActions 的 client-safe 家（纯类型导入，详情页动作条不拖 node:fs 进浏览器 bundle；delivery.ts re-export 保服务端消费面）
    errors.ts               错误类叶子模块（Validation/Conflict/NotFound）—— service/delivery-types/file-lock 共用，web.ts 的 instanceof→HTTP 映射要求同一 class 身份（service.ts re-export）
    service.ts              item.yaml + README.md + events.jsonl CRUD, revision locking, key reservation, import dedup (findExistingByExternal: active ∪ archived ∪ trash; createWorkItem 锁内查+建, returns { detail, importOutcome }), managed 门禁（PATCH phase/status 400）+ released 冻结 + 失效回退（updateWorkItemContent）, trash/restoreWorkItemFromTrashInRoot
    extension.ts            pi extension: list/get/create/update/record-milestone tools（managed 门控：list 默认排除标准流程项 include_managed opt-in + managed 标记；get 附标记；update 不绕 service）
    store.ts                per-workspace 共享 snapshot 缓存（module 级 Map + listener + shouldRefetch 5s 年龄门）—— 中央页与右坞快捷面板同缓存，纯数据层（fetch/轮询在 hooks/useWorkItems）
    web.ts                  error → HTTP mapping
    source-labels.ts        UI-safe source→中文标签 map (禅道) — 外部源脚本盖章的来源展示
  loops/                             web-side loop control + prefill resolution (loop-surface spec §3–§5; imports pi-loop pure logic, no host-side deps of its own)
    lookup.ts              findKitLoopByName — loop 名→declaration（name 字段优先，回落目录名；绑定存名，文件操作以 dir 为准）
    rounds.ts              stopRound / launchManualRound（依赖全注入：facade createSession/sendCommand/destroySession + 可选 reap + runningSessionIds）+ RoundBusyError —— 全走进程内宿主 facade（launch 两步建会话，stop 定向 destroy+释放锁；无 HTTP 往返）；手动轮锁保持持有靠 stale 窗（maxMinutes+15min）回收，无 D9 钩子；幽灵锁活性接管（isPhantomRoundLock + PHANTOM_LOCK_GRACE_MS 2min 宽限，见 Loop 章）：带 sessionId 的宿主锁不在 running set 即清锁重取（launch）/直接清锁返回 stopped（stop）
    executions.ts          执行中断记录（spec §5.4）：ExecutionRecord（kind loop-round / runId / loopName / sessionId / workspacePath / host{pid,hostname} / startedAt/stoppedAt / stopResult interrupted-on-shutdown|recovered-auto|recovered-manual|confirmed-dead / needsAttention / diagnostic）+ writeExecutionRecord（tmp+rename 原子写）+ listPendingExecutionRecords（恢复门禁数据源）+ resolveExecutionRecords + detectSurvivingRoundProcesses（只读探测残留进程：ppid=1 + build/shell 命令 + cwd ∈ workspace）
    contract-prefill.ts    resolveContractPattern（纯函数）：工作项绑定 loop 名 → pattern（paused = 不存在；未命中/未绑定且恰 1 个 active → 该 loop；≥2 个 active → undefined 不猜，防误路由到不消费工作项的 loop）
    cron-summary.ts        summarizeCron（纯函数）：cron 人话摘要（常见形态；其它 → null，UI 回落原始 cron）
    manage.ts               loop 配置面服务端逻辑：getLoopDocs/writeLoopFile/createLoop/deleteLoop + 守卫（白名单/原子写/mtime 并发/锁活/绑定扫描）
  subagent-child.ts          subagentChild tagging by `pi-subagent-` id/name prefix (both eras: builtin children keep the prefix)
                             (id/name prefix `pi-subagent` — the only child-detection mechanism)
  (dev-loop/ retired — loops are per-workspace custom definitions; the R&D loop pattern lives in cxin-workspace, see Dev Loop section above)  git-changes.ts            getGitStatus (multi-repo groups) + getGitFileDiff (patch)
  git-status.ts             porcelain-v1 parse, status classify, buildRepoGroups (pure)
  git-discover.ts           walk tree to find nested repo roots (+ scattered files for file-index); IGNORED_NAMES prunes
                            node_modules/dist/… and `.pi` — the latter can hold the relocated pi data home (dozens of
                            nested git repos, GBs) inside a project tree; a workspace's own `.pi/` never contains `.git`, so
                            pruning costs nothing on the normal path
  git-types.ts              GitFileStatus / RepoGroup / response shapes
  chat-scroll-follow.ts     聊天流式跟随的滚动决策状态机（纯逻辑 + 测试，`useAgentSession` 挂监听共用）：上滑判定先于近底恢复 / 0.5px 阈值 / touchmove 刷新意图窗 / 近底恢复需佐证（跟随中 ∣ 意图新鲜 ∣ scrollTop 增大）
  shell-is-mobile.ts        mobile-shell 路由决策（纯函数 + 测试，`useViewportIsMobile` 消费）：①视口≤640 ②UA 手机种子不降级（宽视口手机：横屏/折叠/记住的缩小） ③纯触屏设备（pointer:coarse 且无 any-pointer:fine，兑住「电脑版网站」改写 UA+撑宽视口）→ mobile，否则 desktop
  session-tabs.ts           会话 tab 模型纯逻辑层（+测试）：SessionTabState（session/new-session/workspace-home 三种 kind，id 前缀 s:/new:/ws:）、createX 工厂、resolveOpenSessionTarget（C1 分派）、findReusableNewSessionTab（占位去重：同工作区 + 空草稿谓词注入）、nextActiveTabId（X1 邻居回落）、contextCloseTargetIds/nextActiveAfterBatchClose（右键批量关闭：其他/左侧/右侧目标集合 + 批量版 X1 激活回落）、tabQuery（URL 投影）、serializeTabs/parseStoredTabs/restoreTabs（R2 持久化，失效 id 静默跳过）
  tab-types.ts              Tab 类型（file/session 文件 tab）+ 右坞 rail 模块 id（FILES/LOOPS/KNOWLEDGE/WORK_ITEMS/TERMINALS_TAB_ID + MODULE_TAB_IDS/isModuleTabId，+测试；2026-10 rail 改版：模块激活走 dockRailMap，activeFileTabId 回归纯文件语义）——从 TabBar.tsx 下沉到此供 lib 层引用
  work-items-page-url.ts    中央工作项管理页深链（+测试）：`?workspace=<id>&page=work-items[&item=<key>]` 的 build/parse 同居模块；builder 返回裸 query（navigateUrl 契约，带 ? 会拼出 `??` 杀死深链）；解析先于 applyUrlToTabs 的 tab 投影（页面是 CenterPage 不是会话 tab）
  dropdown-layout.ts        body-portal 弹层定位（纯函数 computeMenuLayout + 测试，SessionTabBar 右键菜单与 WorkspaceSwitcher 共用）：top/right/maxHeight 一律钳进可视窗口（visualViewport 换算，scale=1 时即普通视口）——锚点被横向滚动裁剪出屏（rect.right > innerWidth 曾使 right 为负、菜单整体滑出屏幕右缘，2026-09 手机端报告）或贴左锚点向左生长被中栏 overflow:hidden 裁剪（2026-09 PC 端工作台切换器报告）都不再把菜单推出可视区
  session-reader.ts         index-backed SessionInfo mapping + buildSessionContext (tail window) + buildEarlierContext + path caches
  session-payload.ts        buildSessionsPayload — the /api/sessions payload builder shared by the route and the SSR prefetch in app/page.tsx（方案二首帧真数据；live 合并 best-effort = 同进程 facade liveSessions/runningStatus，无传输可失败；daemonDown 恒 false，字段保留仅为客户端兼容）
  session-index.ts          persistent mtime-incremental session index (~/.pi/agent/sessions/.index.json, active + .archived; rebuildable cache)
  session-changed-files.ts  PURE deriveSessionChangedFiles — files written/edited in a session from the message stream (write/edit toolCalls; relative `file_path` args resolved against session cwd so openFile passes the /api/files allow-list; NOT git state; survives commits); isEditToolName consolidated here
  session-archive.ts        move .jsonl to/from .archived/ to hide/restore sessions
  archive-cascade.ts        work-item archive ↔ session archive bridge
  worktree.ts               project/worktree resolution (worktree→main repo) + git worktree ops
  file-access.ts            allowed file roots for /api/files, /api/git, worktrees
  agent-client.ts           typed fetch helper for /api/agent commands
  agent/                    agent event reducer + helpers + types
  stores/                   models-store, session-messages-cache, session-runtime-store, file-resource-cache, map-store
  sse/global-agent-events.ts  global running-session event fan-out
  types.ts, normalize.ts, tool-presets.ts, api-types.ts  shared types + toolCall normalization + presets
  model-catalog.ts, model-discovery.ts, models-cache.ts   model list/discovery/caching
  markdown.ts, ansi.ts, compaction-summary.ts, message-display.ts   rendering helpers
  file-paths.ts, file-types.ts, file-fuzzy.ts, file-index.ts, file-links.ts   file viewer/open helpers
  chat-attachments.ts       聊天文件附件纯逻辑（+测试）：AttachedFile / MAX_ATTACHED_FILES(10)、25MB 限制、appendAttachmentReferences（发送时把 `[附件 name](abs path)` Markdown 链接追加进消息文本——渲染端可点击、模型读原始路径）
  uploads-root.ts           附件上传家（server-only）：chatUploadsRoot（<agentDir>/uploads，git 外不污染仓库）/ sanitizeUploadFileName / buildUploadDestination（<yyyymmdd>/<HHmmss>-<rand6>-<name>）/ writeUploadFile（mkdir -p + wx 不覆盖）；getAllowedFileRoots 常驻含此根（lib/file-access.ts）→ 附件链接可经 /api/files 预览
  home-quick-switch.ts       首页快速切换纯逻辑（groupSessionsByWorkspace 的 orderBy:"workspaces" = 保持输入序，桌面项目树手动排序用；默认 activity 序服务移动端首页）：workspaceForSession（最长前缀归属）/ groupSessionsByWorkspace（按工作区分组+活跃度排序，排除 subagentChild 与无归属）/ defaultHomeNewSessionWorkspaceId（最近会话所属 → MRU tab → 第一个可用），有 node:test 覆盖；选择谓词统一 isWorkspaceSelectable（lib/workspaces/types.ts，available && !disabled——停用工作区首页不可见）
  format-time.ts             formatRelativeTime — 会话列表相对时间（首页分组列表共用）
  patch.ts, project-trust.ts, request-security.ts, path-security.ts, http-dispatcher.ts   security + routing
  npx.ts, skill-lock.ts, skill-message.ts, skills-service.ts, skill-updates.ts   skills/plugins plumbing (skill-message.ts also powers session titles: `skillMessageTitle` reduces pi's `/skill:` expansion wrapper — `header + SKILL.md body + </skill> + args` — back to the args or `/skill:name`, incl. a truncated-wrapper fallback for pre-v2 index clips; used by the session index, session-reader, locate route, auto-name, MessageView)

packages/pi-loop/                      THE loop-host package: pure protocol logic + beat CLI (design: docs/pi-loop-host-design.md; npm workspace, independent package.json for future publish, imported by relative path — see Loop section)
  protocol.ts             LoopDeclaration / parseLoopDeclaration / discoverKitLoops (.pi/loops/*/LOOP.md frontmatter; PAUSED skipped) / isWorkspaceHalted (loop-pause-all) — pure fs+yaml, standalone (no pi-web/host deps); the web loops route imports it too
  cron.ts                 cronMatches (Vixie-cron matcher with timezone, never throws on bad input) + nextDue (first cron hit after a moment, minute granularity) — the fire judgment's clock
  round-lock.ts           .round.lock cross-host round mutex — acquire/read/update/releaseRoundLock + isRoundLockStale（唯一权威公式）; O_EXCL atomic create, stale = 无 sessionId 且 pid 死（启动窗口/beat 轮）或超 maxMinutes+15min 窗（带 sessionId 的锁一律窗口治理——web 手动轮锁 pid=web 进程，web 重启不得触发心跳双发）
  due.ts                  .lastrun machine truth (host-written ISO timestamp; STATE.md Last run stays narrative) + shouldFire = now >= nextDue(cron, tz, .lastrun) — anacron-lite catch-up (at most one round after downtime)
  contract.ts             buildRoundPrompt — opening-contract assembly shared by the in-process host spawner (with sessionId, D9) and beat (without); D13 ledger path is per-loop
  fire.ts                 runDueRound/runNow — the unified fire sequence (acquire lock → re-check shouldFire in-lock → write .lastrun → run → finally release); host tick and beat share it, cross-host TOCTOU-safe
  beat.ts                 beat round runner — spawns `pi --name "<loop> · <slot>" -p --approve "<contract>"` (cwd=root, detached own process group); max_minutes timeout → group SIGTERM→3s→SIGKILL
  cli.ts                  pi-loop CLI entry (bin) — beat/run/stop/pause/resume/status/init/watch commands (host spec §4)
  status.ts               collectStatus — per-loop frontmatter summary + .lastrun + next-due + running (lock alive) / paused for `pi-loop status`
  init.ts                 initLoop — scaffold the kit/templates/basic five-piece set (D13 layout: loop/ + root/ + skill/) + SKILL.md skeleton; writes .lastrun = now (first round waits for a natural slot)

kit/                                  pi-loop kit template library + protocol README (consumed by copy, not imported — see Loop section)
  README.md                       the protocol contract: file layout (incl. host files .lastrun/.round.lock, agent-forbidden), host section (宿主自动心跳 / pi-loop beat + crontab, dual-host lock safety, catch-up semantics), L1/L2/L3 levels, breaker + budget rules, GitHub Actions scenario
  templates/basic/               D13 two-level layout — loop/ {LOOP.md, STATE.md, loop-ledger.json} + root/ {loop-constraints.md, loop-budget.md} + skill/ {SKILL.md skeleton, spec §4}; pi-loop init scaffolds from here
  templates/github/loop.yml      GitHub Actions cron heartbeat template (pi -p + community subagent package)

components/
  AppShell.tsx              thin dispatcher: useAppShellState → AppShellProvider → DesktopShell|MobileShell by viewport + shell-agnostic overlays (create-workspace wizard, DirectoryPicker, ProjectTrustDialog)
  shell/
    useAppShellState.ts     the shared shell-state hook — SESSION-keyed tabs（lib/session-tabs 模型：openSessionTab/openNewSessionTab/ensureHomeTab/closeTab + C1/X1/U1/R2 语义）, URL restore, sessions, SSE wiring, panel selection/persistence, run-contract composer prefill (D11), dockRailMap（右坞 rail 激活模块+展开态 per-workspace 持久化，pi-dock-rail）; NO isMobile branches (mobile intents = chatFocusKey/panelFocus signals)
    context.tsx             AppShellProvider/useShell — the shells consume the shared state
    DesktopShell.tsx        the desktop render（2026-09 树形侧栏改版；同月首页退役：空态自动落回当前项目家 tab（desktopCloseTab + 空态 effect，同移动端），HomeNewSession 首页页只在零可用工作区时接手引导）：ProjectSidebar（可拖宽/折叠，复用 sidebar-container 类）+ center（ChatToolbar + SessionTabBar + CenterPage/总览/聊天）+ right dock（2026-10 rail：44px 常驻图标列 文件/Loops/工作项/知识库/终端 + 展开面板，dockRailMap 驱动；终端 tab 状态与 activeTerminalId 也归本组件）；中央区整页渲染分派在本组件（renderCenterPage）
    MobileShell.tsx         the mobile shell（2026-09 树抽屉重构，docs/mobile-drawer-design.md）：ChatToolbar（navToggle="drawer"：☰+状态圆点+会话标题）+ 全屏主区（聊天持久挂载；mobilePage 目的地页 files/work-items/knowledge/loops/settings/archive，‹返回=回聊天，backLabel="聊天"）+ 抽屉（mobileNavOpen，ProjectSidebar 移动变体 showModuleRows：模块行+常显＋/🗑）+ ≥768px 树常驻贴左（showPermanentTree）；空态自动落回 = openNewSessionTab(target,{replace:true}) 占位 composer 作上下文锚；HomeLanding 只剩零可用工作区引导宿主；搜索深跳转 searchTarget 壳自有（同 DesktopShell）
    ChatToolbar.tsx         the shared 36px tool strip (theme/language/chat-scoped buttons/token stats + dropdowns); ☰ 由 navToggle prop 驱动："sidebar"桌面切侧栏（默认）/ "drawer"手机切抽屉（带后台运行/完成未看状态圆点）/ "hidden"宽屏常驻树；手机另显示当前会话标题（右侧弹性区，无会话显工作区名）
  HomeLanding.tsx           首页内容（宿主剩二：① 桌面 ＋ 占位 tab（居中窄栏 720px，⊞ 面板改居中浮卡）；② 零可用工作区时的移动端整页引导（创建/重启用 + ⚙ 设置逃生口）——移动端 ＋新建任务已直落 composer，两段式仅桌面保留。onSelectSession 走 handleSelectSession 的 C1 分派；onSelectWorkspace 桌面=开家 tab / 移动端=openNewSessionTab；**会话列表由 shell 注入（sessions prop，SSR 预取 + 5s 版本轮询常驻内存——不自取 /api/sessions，修「每次打开 ＋ 最近加载慢」）**。内容：问候语（按时段）+ 大输入卡 + 右上角 ⚙ 设置 + ⊞ 工作区底部面板（完整列表点选=进入；**已停用工作区暗淡行 + 已停用徽章，点击深链设置›工作区预选重启用**；+ 新建/导入，管理入口）+ 最近会话按工作区分组（HomeSessionGroups）；「是否有工作区」看全量列表（全部停用时不得掉进「创建第一个工作区」引导，2026-09 修复）；**⚙ 是零工作区态唯一全局配置入口——没有它，把唯一工作区停用后手机端找不到设置›工作区就无法自救（2026-09 修复）**
  HomeSessionGroups.tsx    全局会话分组列表（按工作区分组：组头点击=打开工作区，chevron 折叠默认全展开不持久化；会话行=共享 SessionRow）。宿主（树形侧栏改版后）：仅移动端 HomeLanding 最近区（过滤空组，不传管理 props）；桌面的会话树在 ProjectSidebar 内直构（复用 groupSessionsByWorkspace + SessionRow，不用本组件）；排序由 lib/home-quick-switch.ts 的 groupSessionsByWorkspace 负责（活跃度降序、空组沉底）
  SessionRow.tsx            会话行共享组件（运行/完成徽章 + Cmd/中键新 tab C1 手势 + 行内归档 + 可选相对时间；hover 只留归档按钮）——HomeSessionGroups 与移动端首页最近区共用
  HomeNewSession.tsx       首页无主新会话页（B1 原地切换，反馈修订后无定制外壳）：直接渲染普通工作区同构的 ChatWindow 新会话视图（只有 composer，可直接发起对话；返回 = tab 栏首页按钮，activateTab 重置无主页模式）；工作区选择器经 ChatWindow inputLeadingControl → ChatInput leadingControl 槽渲染在 composer 控制行、上传图片按钮左侧（下拉向上展开；旧版挂在 PanelHeader meta 槽会被头部容器裁剪——即「点击无选项」bug 的成因），默认最近活跃（共识 Q11=a），草稿 draftKeyOverride="new:__home__"；首次发送走现有 /api/agent/new（cwd=所选工作区根，宿主 registry 解析装配），onSessionCreated → useAppShellState.handleHomeSessionCreated **原地**落为首页会话聊天（反馈修订：不跳工作区 tab）。首页打开的会话由 useAppShellState.homeSession 承载：两 shell 首页分支渲染 ChatWindow(session=homeSession)，左侧中栏保持首页菜单并在列表里高亮；activateTab（含点首页按钮）重置。无可用工作区时显示创建引导
  ProjectSidebar.tsx         项目树侧栏（桌面左侧单一侧栏 + 移动端抽屉/平板常驻的宿主，2026-09 改版 + 同月抽屉变体）：顶部导航三行（新建任务⌘N/搜索⌘K/插件&技能）+ 工作区分区（工作区节点整行=展开/折叠（桌面 hover 出 工作区首页/归档 钮；**移动变体 mobileActions = 常显 ＋ 新建会话/🗑 归档**——触屏无 hover）→会话行直挂（默认 5 条 + 显示更多，SessionRow rounded）+ 组尾归档行；折叠持久化 pi-tree-collapsed）+ 树底暗淡行（**已停用工作区：整行可点 + hover ⚙ → 设置›工作区预选重启用（停用后不能从所有面上消失）/ 目录不可用工作区：纯展示**）+ 分区 ＋（新建/导入工作区）+ 底部三入口 strip（设置/模型/Agents → 各自独立配置整页，高亮 = 页粒度 activeConfigPage）；**移动端变体（showModuleRows）：展开的工作区节点下渲染模块行（文件/工作项[capability]/知识库[capability]/Loops 常驻，ModuleRow 两列网格，onOpenModule）**；会话分组复用 lib/home-quick-switch；骨架门控
  PanelHeader.tsx           unified ~36px middle-column panel header (title + back + context actions + mobile ×) + PanelHeaderButton
  SettingsPanel.tsx         the 设置 panel — 移动端专用（2026-09 配置页拆分后 desktop 两栏模式删除）：全行索引 + 内嵌子页（‹设置 返回，归档行仅移动端）；PreferencesPage 也供桌面偏好分区复用
  ConfigCenterPage.tsx      桌面配置整页族（2026-09 拆分）：设置/模型/插件&技能/Agents 四个独立中央区整页——hero 页头（accent 图标章+大标题+描述+meta+✕）+ 分区 pills（仅多分区页：设置=工作区/偏好，插件&技能=插件/技能），插件&技能页两个分区 = PluginsConfig/SkillsConfig `market` 布局（搜索+已安装卡片网格+添加区+详情弹窗）；整页打开时会话 tab 条隐藏（DesktopShell 条件渲染）

  FilesExplorerPanel.tsx   the「文件」面板体（桌面右栏钉死 tab + 移动端抽屉文件目的地页同体）— [ 文件 | 改动(N) ] toolbar + ⟳ + FileExplorer/ChangesPanel (cwd = workspace root); exports ExplorerSegmentedTabs; reveal switches its segmented back to 文件
  WorkspaceManager.tsx      workspace create/import + settings (`embedded` in-panel, `panel` narrow single-column variant — 宿主：桌面右坞工作项 tab + 移动抽屉目的地页 work-items / 设置›工作区 workspaceSlot（右坞 S3；workItemSplit portal 机制已退役）; `split={{ inline: true }}` = 列表+详情并排单容器（设置›工作区的中央区页面，2026-09 搬家）; the settings detail carries the 基本信息 card — rename (PATCH name) + 暂时停用 toggle (PATCH disabled; disabled workspaces keep a settings-only「已停用」badge, the sole re-enable surface — 到达路径：桌面项目树树底暗淡行 ⚙ / 移动抽屉树底暗淡行 ⚙ / 零工作区态 HomeLanding ⊞ 暗淡行与 ⚙，均经 `requestWorkspaceSettings` → `selectWorkspaceRequest` 深链预选，2026-09 修复；**预选同时触发详情优先（detailFocus）：rail（全部工作区列表）收起、目标工作区详情独占 +「‹ 全部工作区」返回**（带工作区上下文的入口只看该工作区，不带上下文的底部设置入口仍落全局列表）；两 shell 在设置面关闭/离开时 `clearWorkspaceSettingsRequest` 防闪回)；the rail is drag-sortable (HTML5 DnD，同 SessionTabBar 模式：drop 到目标上=插到它前面，列表尾空区=移到末尾；一次拖放 = PATCH /api/workspaces 全量期望序)；设置详情含「交付自动化」配置区（Phase-2 T9 + Phase-3 T5 双角色：work-items+workflows 双开时显示 enabled 开关 + designer/developer profile 文本框（双行同形）+ 预算只读，GET|PUT /delivery，config:null 播种默认镜像——见 Work Items 章「Delivery 自动执行」）; remaining modal = home create-workspace wizard
  work-items/               中央工作项管理整页组件族（2026-10 M2；宿主 = DesktopShell CenterPage kind"work-items" + MobileShell work-items 目的地页，同一本体）：WorkItemsPage（页骨架 + 深链消费 + 交付执行状态/三动作——Phase-2 T9）/ WorkItemsToolbar（活动|归档|回收站筛选 + 看板阶段筛选）/ WorkItemsList / WorkItemsBoard（七列，无拖拽）/ WorkItemRow / WorkItemDetailView（概况/设计/证据/动作/审计 + 自动执行区挂载）/ WorkItemActionbar（legalActionBarActions 投影，released 不渲染 cancel）/ WorkItemExecution（交付自动执行四态区，Phase-2 T9）/ WorkItemCreateForm（enableDelivery 缺省不勾）/ WorkItemEvents / WorkItemMeta；纯逻辑 = work-item-phases.ts（看板投影 + 标签，老 complete ≠ 已发布）+ work-item-queries.ts（筛选/排序）+ work-item-api.ts（HTTP 封装），均有 node:test
  WorkspaceOverview.tsx     workspace dashboard — the DESKTOP 家 tab landing (移动端不渲染——抽屉目的地页取代；更早的 WorkspaceHomeMenu 已随树抽屉重构退役)：quick actions, 活跃工作项 with 「立即跑一轮」B-button + Loop 绑定下拉, 仓库/知识库 rows, 「会话」区块（WorkspaceSessionList），Loops 摘要行（onOpenLoopsTab → 右坞 Loops rail 模块，必传）
  WorkspaceSessionList.tsx  本工作区会话列表（拉 /api/sessions 后前缀过滤、排除 subagent 子会话）：默认前 20 条 + 显示全部，行内删除（RecentSessionRow）；宿主 = 移动端工作区 tab「会话」子页（showHeader=false）+ WorkspaceOverview「会话」区块（桌面家 tab）
  SessionTabBar.tsx          the SESSION tab strip（桌面 only；2026-09 树抽屉重构后移动端不再渲染，切会话走抽屉树，组件保留给桌面）：会话/占位/家 tab chips（运行呼吸点/未看完成点 + 拖拽排序）+ ＋新会话（无活动 tab 时隐藏；**sticky right——tab 多到溢出时吸附在条的最右不被滚走**，scrollPaddingRight 让活跃 chip 不被＋盖住）；**「首页」 chip 已删除（桌面 `showHomeTab={false}`，prop 默认 true 仅为兼容）**；⊞工作区选择器已删除（桌面走项目树；picker/WorkspaceIcon/色点板已从组件移除）+ tab 右键菜单（关闭/关闭其他/关闭左侧/关闭右侧——目标集合 contextCloseTargetIds，批量关闭走 useAppShellState.closeTabs：合并草稿确认只弹一次、运行中 tab 照常摘除不终止会话；菜单定位复用 computeMenuLayout + portal 遮罩，Escape/滚轮/拖拽关闭）；无 isMobile 分支
  SessionSidebar.tsx        in-workspace session tree + FileExplorer + Changes section
  ChangesPanel.tsx          git changes list (flat or per-repo grouped)
  FileExplorer.tsx          file tree inside sidebar
  FileViewer.tsx            file content in a tab
  CapabilityToggle.tsx      the capability on/off switch used in settings panels
  LoopsConfig.tsx           loop 配置视图（创建向导 + frontmatter/指针正文/知识文档/宪法编辑 + STATE 只读 + 删除）——桌面右坞 / 移动抽屉 loops 目的地页共用
  LoopRow.tsx               loop 单行（name/cron 摘要/级别/状态 + 配置/暂停/停止/可选运行）——右坞 Loops tab 与总览（移动端）共用
  LoopsDockPanel.tsx        右坞 Loops 模块本体（右坞 S1→2026-10 rail）+ 移动端工作区 tab「Loops」子页（2026-09 菜单化，listHeader 接 ‹返回头）：loop 列表+状态/操作 + 内联 LoopsConfig 推导航；key=workspace.id 挂载（同工作区切 tab 状态存活）
  KnowledgeBrowser.tsx      知识库浏览（chips 选 bundle + FileExplorer + open index.md 提示；宿主：桌面右坞知识库模块（S2→2026-10 rail，knowledge capability 门控） / 移动抽屉 knowledge 目的地页）
  ChatWindow.tsx            chat composition + completion sound wrapper
  SessionChangedFiles.tsx   "本会话改动 N 个文件" toolbar button (right of the sound toggle in ChatInput) + slide-in drawer (desktop) / full-screen list (mobile); entries open the file via the openFile/file-tab pipeline
  ChatInput.tsx             input bar + model/thinking/tools/compact controls; optional leadingControl ReactNode slot at the very LEFT of the controls row (before the attach button — hosts the home new-session workspace selector); 附件（2026-09）：图片内联 base64 不变，任意文件走 POST /api/uploads 上传 + 路径引用（发送时 appendAttachmentReferences 追加 `[附件 name](path)` 进文本，useAgentSession/传输协议零改动；上传中 chip 阻塞发送），选择器/粘贴/拖拽均放开为任意文件（useDragDrop.hasFiles=kind==="file"）
  MessageView.tsx           renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx       in-session branch switcher
  ChatMinimap.tsx           scroll minimap alongside the message list
  MarkdownBody.tsx / MermaidBlock.tsx   markdown + mermaid renderers
  ModelsConfig.tsx          models.json editor (`split` mode = list in middle column + detail/footer portaled into the right column; `embedded` mode = settings-subpage body; `onSaved` refresh hook)
  PluginsConfig.tsx         installed package plugins panel body (`split`/`embedded` modes as above)
  SkillsConfig.tsx          loaded/search/installable skills panel body (`split`/`embedded` modes as above)
  ArchiveModal.tsx          archived sessions/items (embedded = the 归档 panel body)
  TabBar.tsx                chat + open-file tabs; exports FILES_TAB_ID; `leadingTabs` renders the right dock's pinned module tabs（文件/Loops/…，窄面板容器查询图标化）非可关
  FileIcons.tsx / git-ui.tsx   file icon + git-status UI helpers

hooks/
  useAgentSession.ts        messages + streaming + SSE + fork/navigate/reconciliation logic
  useWorkItems.ts           per-workspace 工作项共享层（2026-10 M2，+store 测试）：单轮询器引用计数（同 workspaceId 多宿主一个 interval，默认 5s 可见轮询 + visibilitychange/focus 校验 + 单飞合并）；snapshot 订阅自 lib/work-items/store；invalidate = 清快照强取；workspaceId 热切换复位 loading/error
  useGitStatus.ts           polls /api/git/status for the Changes panel
  useKitLoops.ts            loops 状态 hook（GET /api/workspaces/:id/loops + pause/resume/stop，refreshKey 驱动）——右坞 Loops tab 与 WorkspaceOverview 共用
  useSessionActivity.ts     running-session activity signals
  useGlobalAgentEvents.ts   global running-session SSE subscription
  useAudio.ts               completion sound + AudioContext unlock
  useDragDrop.ts            shared drag/drop state
  useKeyboardShortcuts.ts   global keyboard shortcuts
  useI18n.tsx / useTheme.ts / useIsMobile.ts   i18n / theme / responsive hooks (useIsMobile reads IsMobileContext — server-seeded UA guess, see Shell split)
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/session-host/registry.ts` — Next.js host process)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`.
- **Session CREATION is abortable + bounded** (`StartSessionOptions.signal`): `startRpcSession` races creation against the signal (`raceAbort`, `lib/abort-race.ts`) — an already-aborted signal throws immediately, a hung creation (e.g. stuck network call in model resolution) rejects on abort/timeout, and a session that materializes late (after the caller gave up) is destroyed on arrival so no live zombie wrapper stays in the registry. Callers bound it: subagent `runWorker` (parent tool signal + 5-min timeout; failure degrades to a failed WorkerResult, not a throw), kit rounds (`lib/session-host/loop-spawner.ts`, `creationTimeoutSignal` 5-min). Without this, a creation hang pinned the parent's turn, the host's `abort` path (which awaits idle), and the running set forever. The start-lock key for NEW sessions is a one-time `__new__<uuid>` — never `""`, which made concurrent creations (parallel subagents) coalesce onto the first session.
- **Heartbeat monitor — the zombie safety net** (`lib/session-host/heartbeat.ts` pure logic + `startSessionHeartbeatMonitor` in registry.ts, started from `getRegistry()` init): every 60s (unref'd) each RUNNING wrapper is checked for time-since-last-activity (any agent event — streaming deltas, tool partials — or inbound command, tracked in `lastActivityAt`). Silent past `STALL_WARN_MS` (5min) → listed in `facade.runningStatus()`'s additive `stalled` snapshot and `get_state`'s `stalledMs`; silent past `STALL_KILL_MS` (20min, env `PI_SESSION_STALL_*_MS`) → synthetic `prompt_error` (visible as a chat notice, NOT persisted) then `destroy()` (aborts in-flight prompt, drops registry, closes SSE → badges clear; human resends to resume). Rationale: a false kill costs one resend, a zombie costs a host restart (REQ-0026: 4 silent hours). NOT covered: creation-phase hangs (bounded by `StartSessionOptions.signal`/raceAbort above), gate-paused sessions (not `running`, never monitored — human waits can be arbitrarily long), and sessions with a **pending extension UI request** (`hasPendingUiRequests()` — running but human-paused on a confirm/select dialog; exempt like gate-paused, since the dialog is replayed to any reconnecting viewer and stays answerable). The KILL margin exists for QUIET BUILDS: pi's bash tool only emits partials when there IS output, so a legit `npm install`/`mvn` (and a subagent parent waiting on such a child) is genuinely eventless — kill must outlive the longest normal build.
- The registry lives in the **Next.js Node.js server process**. The `globalThis` guard means Next.js route cold-loading and dev hot reload (HMR) can never create a second owner — a reloaded module graph re-attaches to the same `__piSessions` Map, wrappers survive, only code is swapped; a server restart cold-starts sessions from their .jsonl on demand (same revive semantics as commands).
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`).
- **`destroy()` aborts an in-flight prompt** (`promptRunning || isStreaming → inner.abort()`). Without this, destroying a wrapper mid-run (Loop round timeout/abort) only unsubscribes events and drops the registry entry — the inner prompt keeps executing as an invisible zombie: still writing the .jsonl and spawning subagents for many minutes after every surface (run status, running badge, host probe) says it is gone. The idle-timer path is unaffected (it guards on `isRunning()` and never destroys a busy session), and fork is idle-only, so the abort branch fires only where a kill is intended.
- Session creation resolves the enclosing **Workspace** (`findWorkspaceForPath`) and attaches its extensions + filtered skills. If none, only the global `subagent` extension is attached.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets already-forked state and subsequent forks produce a corrupt `parentSession` chain. **Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning; the next request for the original id reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on a user message): creates a new independent `.jsonl` file. Shown as a sidebar-tree child via the `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Switching between siblings calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — it has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `lib/session-host/registry.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

### Workspace capability registry is the source of truth
`ALL_WORKSPACE_CAPABILITIES` (`lib/workspaces/service.ts`) is **the** validation list. `parseCapabilities()` throws on any value not in it, so a capability missing from this array — e.g. `subagent`, or historically `knowledge` before it was registered — **cannot be persisted** (a `PATCH …/capabilities` with it returns **400 "Unknown capability"**). The `WorkspaceCapability` *type* union contains `subagent` anyway because the tool is global; treat the type as a superset, not the validatable set. (`workflows` is registered and — since 2026-10 Phase-2 — **meaningful**: it activates 交付自动化（delivery automation）——the `delivery_*` designer/developer tools mount is the work-items∧workflows conjunction in `extensions.ts`, `assertAutomationCapable` gates `.pi/delivery.yaml` writes and the dispatcher re-checks it per tick（see Work Items 章的「Delivery 自动执行」小节）. The former `overview` capability is RETIRED — the overview dashboard renders unconditionally; manifests still listing `overview` get it stripped on read, see the capability system section.)

### Capabilities are required — no fallback path
`WorkspaceManifest.capabilities` is non-optional. `parseWorkspaceManifest` throws on a manifest without it, and the deleted `effectiveCapabilities` helper is NOT to be reintroduced — read `manifest.capabilities` directly. (The one-shot v2 migration and its read-path strip are gone; a manifest still carrying retired values is config-invalid.)

### AGENTS.md managed-segment replacement is a no-op without markers
`updateManagedRepositoryInstructions()` only rewrites content **between** the managed markers, and now maintains **two**
segments — `<!-- workspace-managed:repositories:start/end -->` and `<!-- workspace-managed:knowledge:start/end -->`.
Each is touched only when its capability (`repositories` / `knowledge`) is effective. If a user deletes a segment's
markers it will silently stop syncing — it never recreates them. The git block (`<!-- workspace-managed:git:start/end -->`)
is emitted once by `renderWorkspaceAgents` (when `git` settings exist) and not re-managed afterwards.

### Knowledge repos use OKF; L0 is always built-in, clone never overwrites
A `knowledge` repo initialized with `mode: "init"` is seeded with an **OKF v0.2** structure via `renderOkfSeed`
(`lib/workspaces/okf.ts`): `index.md` (progressive-disclosure entry, frontmatter `type: index`), `log.md` (`type: log`),
and `concepts/welcome.md` (`type: concept` + tags). `mode: "clone"` is **never** overwritten — the remote brings its own
structure. **L0 access (read/ls/grep) is always built-in** and needs no tool (redesign decisions 11/12); existing
frontmatter-less bundles (e.g. legacy ones) are **not force-migrated** (decision 13, progressive) — they still work via
L0. The AGENTS.md knowledge segment **references** each bundle's `index.md` rather than inlining it (decision 10).

### kb_search is opt-in, self-healing, cross-bundle (L1)
The `knowledge` capability carries **two coexisting layers** (redesign decisions 11/14, §6.1): **L0** (always built-in
`read`/`ls`/`grep` — needs no tool) and **L1 `kb_search`** (an enhancement mounted by `buildWorkspaceExtensions` when
the capability is on). `kb_search` is implemented by `lib/workspaces/kb-search/` and is **pure-JS** (no native deps):
frontmatter (`type`/`tags`) + body are tokenized and ranked with **BM25**. It searches across **all active knowledge
bundles** of the workspace and merges results.

- **Self-healing index (decision 14)**: each `kb_search` call runs `ensureIndex()` first, which walks each bundle's
  `.md` files and compares **mtime** to the cached entry, re-parsing only new/changed files (deleted files are dropped).
  The index is a **rebuildable cache** at `<workspacePath>/.pi/cache/kb-index/<repoAlias>.json` (git-ignored). A
  missing or corrupt cache simply triggers a full rebuild — never a failure. Index writes are serialized with
  `withWorkspaceWriteLock`; a torn write (interrupted) is made harmless by tmp+rename atomic write.
- **Degrades gracefully**: if indexing fails for a bundle it is skipped; if all bundles fail, the tool returns an L0
  hint (`grep`/`ls`). L0 never depends on `kb_search`.
- The tool re-resolves the live active-knowledge-repo set on **each call**, so bundles added/removed during a session
  are picked up without a restart.
- The factory passes an initial repo snapshot at mount time; the source of truth at execution is the fresh manifest
  read (so `kb_search` and L0 always agree on which bundles exist).

### Subagent is global, not a workspace capability
The built-in subagent tools (`Agent` / `get_subagent_result` / `steer_subagent`) are attached to **every** session in `lib/session-host/registry.ts` via `createSubagentExtension` (`lib/subagent-extension.ts` + `SUBAGENT_CONTROLLER` wiring in the same file), regardless of workspace or capability. They are intentionally absent from `WORKSPACE_EXTENSION_FACTORIES` and `ALL_WORKSPACE_CAPABILITIES`. Profile discovery is cwd-based (`listSubagentProfiles(cwd)` reads `<cwd>/.pi/agents/` flat) and loop sessions run with cwd = workspace root, so workspace profiles load with zero wiring. Timeouts follow upstream semantics — no idle kill, no runtime cap; the heartbeat monitor exempts subagent children (see the Subagent section).
### Session Host (`lib/session-host/`): the Next.js process owns every AgentSession（2026-10 M1 单进程）

The pi-daemon process is **GONE** — every session, subagent child and kit loop round runs inside the Next.js Node.js
server. `instrumentation.ts` boots the host fire-and-forget (`ensureHostBooted()`, `lib/session-host/background.ts`);
`lib/daemon/`、`lib/session-daemon/`、`lib/agent-proxy.ts`、`bin/pi-daemon.js`、`bin/load-env-local.js` 与 `npm run
daemon` 已删除；原 daemon HTTP 面的所有调用方（/api/agent/** + SSE、/api/subagents/[id]、会话生命周期路由、
project-trust、session-archive、session-payload + SSR 预取、loop run/stop）如今全部直连进程内 facade。历史：该
单进程形态是 C2「daemon 单一会话宿主」strangler 的终态——两进程时代为「谁是会话 X 的 owner」在六处打的补丁簇
（state probe / pin-reprobe / badge merge / host probe / locate bypass / reducer promotion）随 proxy 层一起消失。

- **`registry.ts`** — 单一会话宿主：`AgentSessionWrapper` + `startRpcSession` + subagent controller 单例
  （`globalThis.__piSubagentController`）。**globalThis 单例**：registry/start-locks/running-listeners 全挂
  `globalThis`，Next.js 路由冷加载与 dev HMR 重载模块图后重新附着同一个 Map——**热重载永不出第二个 owner**（HMR
  语义：wrapper 存活，只换代码）；服务器重启后按 .jsonl 冷启动 revive（与命令路径同一语义）。routes 不直接 import
  本模块——一律经 facade（错误→状态映射与冷 revive 语义归 facade 所有）。
- **`facade.ts`** — 类型化进程内 facade：`createSession/sendCommand/probeSession/destroySession/
  autoNameSession/busyForCwd/reloadCwdSessions/liveSessions/runningStatus/getSubagentRunStatus/controlSubagent`；
  `SessionHostError(.status)` 负责错误→HTTP 映射。live-first + cold-start-from-.jsonl revive（旧 daemon
  `/v1/sessions` 面的进程内移植；wire 字段名 `liveInDaemon` 为客户端兼容保留，语义 = 「宿主注册表里有它」）。
- **`sse.ts`** — 进程内 Web-stream SSE（`serveSessionEventStream`/`serveRunningEventStream`，外接入
  `openSessionEventStream`）：connected 帧先行、30s 心跳注释、wrapper destroy 即断流（`onDestroy(cleanup)`）、
  `req.signal` 只取消订阅不碰会话。慢客户端 stall 上限是 **drain-aware** 的：`ByteLengthQueuingStrategy({
  highWaterMark: SSE_STALL_BYTES_DEFAULT /* 1MB 常量 */ })` + `desiredSize <= 0` —— 只按**未排水字节**判死，健康
  观看者无论累计流过多少数据都不会被误切。
- **`heartbeat.ts`** — stall classify/warn/kill 纯逻辑（warn 5min / kill 20min，env `PI_SESSION_STALL_*_MS`；
  语义见上面 AgentSession lifecycle 节）。
- **`jobs.ts`** — `HostJob {id,start,stop}` + `HostJobRegistry`，静态装配、无运行时发现。
- **`loop-spawner.ts`** — `LoopKitSpawner`（HostJob `loop-kit-heartbeats`，30s tick，无条件注册，deps 可注入）。
  **恢复门禁**：起轮前查 `listPendingExecutionRecords` —— 未确认中断记录在场则该 loop 不起新轮。**轮登记**：
  `markActive/clearActive` 写入 background 的 active-round 表，关停据此决定给哪些轮写中断记录。reaper 依赖默认
  **NO-OP**——共享宿主禁止按 cwd 收割（见下条 reaping 口径）；beat CLI 自带收割不受影响。
- **`background.ts`** — `ensureHostBooted`（globalThis 单次装配：**老 daemon 迁移守卫** → LoopKitSpawner +
  DeliveryDispatcher（Phase-2 T7 交付自动化心跳——并行懒加载链，各自 catch；见
  `lib/work-items/delivery-runner/dispatcher.ts`）→
  shutdown handlers；`PI_TEST_NO_BACKGROUND=1` 测试缝同时跳过守卫、默认 spawner 与 delivery dispatcher）+ 轮登记原语
  （`markRoundActive/clearRoundMark/listActiveRounds`）+ `registerShutdownHandlers`/`buildShutdownPlan`。
  **关停序列**（SIGINT/SIGTERM）：停后台 job（stopBackgroundSafely——loop spawner 与 delivery dispatcher 双覆盖，任一未启动 no-op、抛错不挡另一个）→ 快照 running（必须在 destroy 前取——destroy 后
  isRunning 恒 false）→ destroy **全部** wrapper → 为仍在跑的轮写中断记录（写失败不吞销毁流程，单条只记日志）→
  exit 0。不承诺恢复内存中的模型调用现场，重启后按文件记录接续。**迁移守卫**：boot 时探测 `PI_DAEMON_URL`
  （默认 `127.0.0.1:30142`，该 env 仅此一处幸存）的 `/health`——健康且 `service === "pi-daemon"` 说明旧 daemon
  仍持有会话，拒绝启动（console error + `exit(1)`），杜绝双写会话文件；spawner 必须在守卫放行后才启动（注定
  夭折的 boot 不许真起轮）。

**执行中断记录与恢复门禁（`lib/loops/executions.ts`）**：关停为每个在跑轮写 `ExecutionRecord`（kind
`loop-round`，runId/loopName/sessionId/workspacePath/host{pid,hostname}/startedAt/stoppedAt，`stopResult:
interrupted-on-shutdown | recovered-auto | recovered-manual | confirmed-dead`，needsAttention，diagnostic）——
tmp+rename 原子写。`listPendingExecutionRecords` 是 fire 门禁的数据源；管理面 `GET …/loops` 附带 `interruptions`
字段呈现，`POST …/loops/[name]/recover` = `detectSurvivingRoundProcesses` **只读探测**（ppid=1 + build/shell 命令
+ cwd ∈ workspace）——残留进程在场 → 409（带 pid，manual 也不放行）；干净 → `resolveExecutionRecords`
（manual=true 记 recovered-manual/actor=user，否则 recovered-auto）解除门禁。

### Loop heartbeats run in the Next.js host; the web layer adds a management surface over the facade
`instrumentation.ts` → `ensureHostBooted()` 装配 `LoopKitSpawner`（HostJob `loop-kit-heartbeats`，**无条件注册**——
`PI_LOOP_KIT` 旗子已随 v3 引擎一起删除）。web 层 loop 面（`app/api/workspaces/[id]/loops/**` + `lib/loops/`）=
文件读取（`packages/pi-loop/status.ts`）+ 经 facade 的操作（「立即跑一轮」两步建会话、无 D9 自动归档；「终止本轮」
facade destroy + 释放锁）——**宿主没有 loop 专属路由**。kit 轮会话是一次性普通宿主会话——与用户会话同注册表，运行
记录 = `STATE.md` + workspace git log。宿主不是唯一心跳源：standalone 根（无 pi-web）由 `pi-loop` CLI 的 `beat`
驱动（任意外部 cron，见 Loop 章）——双宿主并存安全：同一 `packages/pi-loop/fire.ts` 序列 + `loops/<name>/.round.lock`
互斥。`pi-loop run`/`pi-loop stop` CLI 仍服务 standalone 宿主；web 的 run/stop 路由是宿主持有轮的 pi-web 侧对应物。

**Watching a live session (any session — interactive, subagent child or kit loop round) is one mechanism.** The host owns every session; `/api/agent/[id]/events` = `openSessionEventStream`（`lib/session-host/sse.ts`）— live-first（`getRpcSession` 命中即流式接上），miss 则按 .jsonl 冷启动一个 wrapper 供观看（idle timer 稍后回收）；kit 轮与交互会话同注册表，同一解析路径。(已删除的 community 包子会话曾是独立 OS 进程、只能冷看盘上 `.jsonl`；builtin 子会话是注册表会话，可 live 观看。) Two subtleties remain:

1. `globalAgentEvents.pinSession(sid)` (`lib/sse/global-agent-events.ts`) — a host session that is **alive but idle** (between turns, e.g. a gate-paused kit round session or any warm idle session) appears in NO running set, and `syncRunningIds` **disconnects** any source not in that set. A pinned sid is exempt from the sweep and stays connected while viewed (so a resumed turn's `agent_start` arrives live). `useAgentSession` pins on mount when the state response says `liveInDaemon` (wire field name kept for client compat — it now means "in the host registry") and unpins the previous session on switch/unmount. On a fatal SSE error a pinned session re-probes the state route before retrying (bounded retries; unpin when the host no longer holds it).
2. The event reducer promotes `agentPhase` to `running_tools` on a `tool_execution_update` partial even without a prior `tool_execution_start` — a viewer joining mid-tool-run never saw the start event, and the streamed partials are the only proof the tool is running. Without this the phase sits on `waiting_model` (「思考中」) for the whole multi-minute run.

**Opening a subagent child by click goes through `/api/sessions/[id]/locate`, never the cached `/api/sessions` list.** `handleOpenSessionViewer` resolves the child id via locate (registry probe via `facade.probeSession` first — then a forced disk scan that bypasses the list cache). The old list lookup silently no-op'd for a freshly spawned running child (it isn't in the cached list yet), which felt like "you must wait for the subagent to finish before you can open it". Locate also enriches a probe-hit from disk (real firstMessage/stats for the tab label, keeping the probe's authoritative path/cwd).

**Running badges come from one server-side set.** `/api/agent/running/events` = `serveRunningEventStream`（进程内 `subscribeRunningSessions`，快照先行）; because the host registry holds interactive sessions + subagent children + kit loop rounds alike (keyed by real session id), the sidebar/tab badges need no client-side merge anymore (the old `loopRunningSnapshot` merge existed only because the web set could never contain Loop sessions). Subagent children never show a running badge — the sidebar/tab strip hide them by prefix (`lib/subagent-child.ts`), so no row renders one even though their id may be in the set.
**The host's session SSE ends on destroy.** `serveSessionEventStream` registers `session.onDestroy(cleanup)` — when a wrapper is destroyed (kit round `max_minutes` timeout, session delete/teardown) the stream closes, the browser's pinned EventSource fails fatally, `reprobePinned` sees the host no longer holds the session, unpins and clears the badge. Without this a destroyed round leaves the pinned runtime `agentRunning=true` forever (no `agent_end` is ever emitted after destroy), spinning the tab badge indefinitely.

**Orphan processes after a kit-round kill — 定向杀，共享宿主禁 cwd 收割。** `destroy()` in the shared host is a **targeted** kill: the SDK destroy→dispose chain aborts bash and kills each execution's process group（pi 的 bash 工具把 shell 按进程组 detached spawn，进程级信号由 SDK 负责递达），所以 spawner 的 `max_minutes` 超时路径按设计不留孤儿。cwd 收敛收割器 `reapOrphanedRoundProcesses`（`packages/pi-loop/reap.ts`，SIGTERM→SIGKILL 该 workspace cwd 下的一切 build/shell 进程）因此是 spawner 的**默认 NO-OP 注入点**：同一 workspace 里并行着交互会话/其它轮的进程，按 cwd 杀会误伤它们；注入点留给测试/独立宿主。beat CLI 保留自带收割（standalone 根里只有它自己的轮）。漏网的残余（如硬崩溃）由恢复期**只读探测** `detectSurvivingRoundProcesses`（`lib/loops/executions.ts`：ppid=1 + build/shell 命令 + cwd ∈ workspace）上报为 409 pid，绝不静默击杀。

### Session changed-files quick access (SessionChangedFiles)
"本会话改动 N 个文件" — a compact icon+count button at the end of the ChatInput controls row (right of the sound toggle; on mobile it lives inside the "更多控件" pill; not rendered in `embedded` view mode), opening a slide-in drawer (full-screen list on mobile). **Data source is the message stream, not git**: `deriveSessionChangedFiles` (`lib/session-changed-files.ts`, pure + tested) walks write/edit toolCalls (incl. `isEditToolName` variants) plus the streaming message for **real-time** counting. Subagent children no longer contribute — community-package children are separate pi processes whose file operations never appear in the parent stream. Scope is the **whole session file** (not just the current branch path), deduped **most-recent-first** with a ×N badge; bash-written files (`cat >`, `git commit`) are deliberately not counted. Clicking an entry → `openFile` (existing file-tab pipeline; `/api/files` allow-list already covers session cwds). The list intentionally **survives commits** — it answers "what did this session touch", not "what is uncommitted" (that's the Explorer 改动 tab). Drawer state is not persisted; switching sessions closes it.

### Chat file attachments (upload + path reference; 2026-09)
pi 的消息协议只支持图片内联（`ImageContent`），所以聊天附件是**双通道**：**图片**走原有 base64 内联（≤10MB/张、≤10 张，`validateAgentImages` 服务端校验不变）；**任意文件**在选择/粘贴/拖拽后立即 `POST /api/uploads` 落盘到 `<agentDir>/uploads/<yyyymmdd>/<HHmmss>-<rand6>-<name>`（lib/uploads-root.ts；全局目录——独立于任何 git 仓库，不制造未跟踪噪音；同名不覆盖；≤25MB/个），发送时把 `[附件 name](abs path)` Markdown 链接追加进消息文本尾部（`appendAttachmentReferences`）。这样：① 传输协议零改动（文件以纯文本路径骑在 message text 上）；② 渲染端经 MarkdownBody 的 `resolveLocalFileHref` 可点击打开（`getAllowedFileRoots()` 常驻含 uploads 根）；③ 模型读原始文本拿到绝对路径后用 read/bash 自行消费（PDF 等二进制它自己走 pdftotext 等——预期行为）。上传中 chip 阻塞发送；草稿持久化已完成的附件路径（`ChatDraft.files`，无附件时不带键保持旧存储形态）；发送失败回填不重新生成 chip（引用已在恢复文本里，避免下次发送重复追加）。占位 tab 去重（同日）：`openNewSessionTab` 复用同工作区空草稿占位（`findReusableNewSessionTab`，见 Navigation 交互节）。

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
pi emits `compaction_start` / `compaction_end`; `handleAgentEvent` handles exactly these (the old `auto_compaction_*` spellings are gone — pi's version is pinned by this repo). Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state SSE + reconciliation
- The sidebar listens to `/api/agent/running/events` — the in-process running-id SSE (`lib/session-host/sse.ts`, the complete set: interactive + children + kit rounds), so running badges update without polling.
- `useAgentSession` treats per-session SSE as primary, but while a run is active it periodically calls `GET /api/agent/[id]` and reconciles on `visibilitychange`/`online`. This fixes missed `agent_end` events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo group together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` and `/api/git/*` are intentionally not general filesystem browsers. Allowed roots come from session cwds, their resolved project roots, workspace paths, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, `/api/worktrees`, and `/api/workspaces` (GET/POST) call `allowFileRoot()` when they make a new location browsable.

### Local pi data home (`.env.local`)
The pi data home is env-driven everywhere: `PI_CODING_AGENT_DIR` (SDK `getAgentDir()` — sessions, settings, models,
skills, agents, auth, importer credentials, subagent registry), `PI_WORKSPACES_DIR` (`workspacesRoot()`),
`PI_WORKSPACE_INDEX_FILE`. Docker deployments already set these (docker-compose.yml); `scripts/adopt-pi-home.mjs`
pointed them at `<repo>/.pi/` for local dev. Wiring rules that must NOT regress:
- **`.env.local` is loaded by Next.js itself** — single process (2026-10 M1): every env consumer (session host,
  spawner, workspaces) lives in the one server process, so there is no second boot path that could miss it (the old
  `bin/load-env-local.js` self-loader died with `bin/pi-daemon.js`). Next.js NEVER overrides values already in
  `process.env`, so explicit environments (docker-compose, shell) always win.
- **`.pi/agent` + `.pi/workspaces` are gitignored and carry secrets** (auth tokens, importer credentials, 19G of
  cloned repos). `.pi/workspace.yaml` (the pi-web workspace manifest) and `.pi/workspace-templates/` stay tracked.
- **`git-discover.ts` prunes `.pi`** — walking a workspace root that contains the data home must never crawl GBs of
  nested repos into the Changes panel / file index. tsc (`exclude`) and eslint (`ignores`) exclude the data dirs the
  same way; `.vscode/settings.json` watcher-excludes them.
- **The migration script owns path rewriting**: session dirs are NAMED after the encoded session cwd (`/` → `-`), and
  `.jsonl` entries embed absolute `cwd`/`parentSession` paths — after a move, two plain substring replacements
  (old workspaces root, old agent root) fix names, JSON content and the global index consistently.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them. Per-workspace, skills are filtered to `manifest.skills` at session creation (`skillsOverride`).
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd. **Timeout is 5 min** (`runNpx`), because installs `git clone` whole source repos (e.g. `anthropics/skills` ≈ 15MB, >60s even on a fast link). If installs hang forever at `Cloning repository…`, the machine can't reach github.com directly — `runNpx` passes `process.env` through, so start the dev server with `https_proxy` set, or scope it in git: `git config --global http.https://github.com.proxy http://127.0.0.1:<clash-port>`. `npm warn exec ... will be installed: skills@x` in the output is harmless (npx cache priming).

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

---

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — it maps each displayed message back to its `.jsonl` entry id, used for fork and `navigate_tree` calls. Subagent children (`pi-subagent-<uuid>` ids — builtin children are created with this prefix; the legacy community-package children used it too) use the same format; the sidebar hides them via the id/name prefix check in `lib/subagent-child.ts`. Builtin children additionally carry a `parentSession` link + `pi-web:subagent` meta entries (crash recovery + resume read them).
---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
