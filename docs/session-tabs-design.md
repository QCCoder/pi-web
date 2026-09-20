# 会话 Tab 化设计（Phase 1）+ 工作区收敛（Phase 2）

> 状态：Phase 1 + Phase 2（W-中收敛）均已实施（2026-09，与用户逐题确认的十二项决策）；本文档是实施契约。
> 实施记录：lib/session-tabs.ts（纯逻辑+测试）、components/SessionTabBar.tsx（新，替换已删的 WorkspaceTabBar）、
> useAppShellState（模型切换+全部 handler 迁移+R2 持久化+hubView）、两 shell 接线、WorkspaceSidebar 手势（Cmd/中键/hover 新 tab）、
> lib/tab-types.ts（Tab 下沉）。Phase 2：ActivityBar 模块组只留工作台、中栏只剩会话列表、家 tab hub
> （hubView: overview/work-items/knowledge，新 KnowledgeBrowser.tsx；LoopsPanel.tsx 删除，「运行」由总览 onRunLoop 接管）、
> 移动端底部 tab 收敛为 会话/工作台/设置（旧存量 tab 值归 workbench，overview 栈扩展 work-items/knowledge 页）。
> 遗留细节：auto-name 后 tab 标签实时更新（当前依赖 sessionActivity 刷新）、tab 溢出 ▾ 列表（当前仅横向滚动）、
> loop 名字点击 reveal（loopFilesReveal 保留管道但暂无生产者）。
> 动机：A 同工作区多会话并行（列表重排、切换断直播）+ B 跨工作区监控 + D 浏览器心智。
> 非目标：并排分屏（正交，未来叠加）；工作区子系统本体（capability→extension、loops、
> 工作项、kb_search）零变化；首页流程不重构。

## 0. 决策记录（grill 共识）

| # | 主题 | 决策 |
|---|---|---|
| 1 | 模型 | **1a 纯会话 tab**：顶栏 tab = 会话（跨工作区混排）；工作区降级为跟随当前 tab 的环境上下文（`activeWorkspace = activeTab.workspace` 链保留） |
| 3 | 文件面板 | **F1** fileTabs/activeFileTabId/rightPanelOpen 跟会话 tab；文件树按工作区上下文挂载 |
| 4 | 挂载 | **M1** 只挂当前 tab 的 ChatWindow（切换成本=今天切会话）；tab 呼吸点靠 running/events 全局流；保活留作后续优化（HTTP/1.1 ~6 连接上限排除全挂载） |
| 5 | 列表点击 | **C1** 普通点击=当前 tab 内替换；Cmd/Ctrl-点击、中键=新 tab |
| 6 | Fork | **K1** 新 tab（原对话留在原处）；同文件内分支切换留在当前 tab |
| 7 | 关 tab | **X1** 邻居规则（先左后右）；最后一个 tab → 首页；会话删除/归档 → 自动关 tab |
| 8 | URL/恢复 | URL 语法不变；**R2** tab 条全量 localStorage 持久化，重载恢复，失效 id 静默跳过 |
| 9 | 移动端 | **N1** 共享会话 tab 状态（横向 chips 行）；工作区切换走工作台头部切换器+首页；状态层无 isMobile 分支 |
| 10 | tab 条按钮 | **P1** ＋=新会话（当前工作区上下文，无上下文隐藏）+ ⊞=工作区选择器 → 开/激活家 tab（overview 落地） |
| 11 | 工作区收敛 | **W-中**（Phase 2）：rail 撤模块组只留全局组；中栏瘦身为会话列表+切换器+新建；总览家 tab 成唯一模块枢纽；移动底部栏收敛为 会话/工作台/设置 |
| 12 | 唯一性 | **U1** 会话全局一个 tab（重复开=聚焦已有）；家 tab 每工作区一个；新会话占位 tab 豁免（草稿键按 tab id 隔离）；首条消息后占位 tab 原地转正并去重 |

## 1. Phase 1 数据模型（`components/shell/useAppShellState.ts`）

```ts
type SessionTabKind = "session" | "new-session" | "workspace-home";

interface SessionTabState {
  id: string;        // "s:<sessionId>" | "new:<uuid>" | "ws:<workspaceId>" —— 前缀保证跨 kind 唯一
  kind: SessionTabKind;
  workspace: WorkspaceSummary;   // 环境上下文；workspaces 同步 effect 持续刷新（现有机制复用）
  session: SessionInfo | null;   // kind === "session" 时非空（恢复期可先占位再水合）
  fileTabs: Tab[];               // F1：全套右栏状态跟 tab
  activeFileTabId: string | null;
  rightPanelOpen: boolean;
}
```

- **`view` 字段退役**：kind=workspace-home 即 overview，其余即 chat（`WorkspaceView` 删除）。
- `WorkspaceTabState` 删除；`tabs: SessionTabState[]`、`activeTabId` 主键换为上述 id。
- 派生值（`activeWorkspace`/`selectedSession`/`fileTabs`/`rightPanelOpen`/`activeCwd`/`windowTitle`…）全部照旧从 `activeTab` 派生，读法不变。

## 2. Handler 迁移表（旧 → 新）

| 旧 handler | 新行为 |
|---|---|
| `ensureTab(workspace)` | `ensureHomeTab(workspace)`——仅 ⊞/首页/导入进入工作区时用；已开则激活（U1） |
| `handleSelectSession`（列表普通点击） | **C1 分派**（`resolveOpenSessionTarget`）：活动 tab 是 session/new-session → 原地变身（id 换 `s:<新id>`）；活动 tab 是 workspace-home → 开新会话 tab（家 tab 是枢纽锚点，不被导航吃掉）；无活动 tab（首页）→ `handleOpenSessionFromHome` |
| `handleOpenConversation`（locate 打开，subagent 子会话/工作项关联会话） | 开新会话 tab（U1 去重聚焦） |
| `handleOpenSessionViewer` | 同上：开新 tab（保留父会话视图） |
| `handleSessionForked` | **K1**：新 tab 承接 fork 结果，原 tab 不动 |
| `handleCloseWorkspaceTab` → `closeTab(id)` | **X1** 邻居规则（先左后右，替代今天的 MRU 回落）；关占位 tab 前草稿确认（草稿键 `new:<tabId>`）；最后一个 tab → 首页 |
| `handleOpenWorkspaceToChat`（＋picker 落 chat） | **退役**；⊞ 统一走 `ensureHomeTab`（overview 落地，P1） |
| `handleWorkspaceNewSession`（中栏＋新建 / Ctrl+Alt+N / 总览与移动端工作区菜单的「新建会话」） | 活动 tab 是家 tab（工作区详情页）→ **原地变身**（2026-09：`resolveNewSessionTarget` morph 分支，家 tab 同位置换成 composer 占位，不新增 tab；首条消息后按现有转正流程变会话 tab）；否则开新 `new-session` 占位 tab（U1 豁免：同工作区可并存多个 composer） |
| `handleTabBarNewSession`（tab 条＋） | 显式加 tab 按钮：永远开新 `new-session` 占位 tab，不做家 tab 原地变身 |
| `handleShowOverview`（工作台「总览」按钮） | 开/激活当前工作区家 tab |
| `handleOpenSessionFromHome`（首页分组点会话） | 开会话 tab 并激活（今天开工作区 tab 的行为改为开会话 tab） |
| `runLoopAndOpen` / `handleOpenWorkItemConversation` / `handleRunContract` | 语义照旧，落点从「workspace tab + 选中会话」改为「（新）会话 tab」；run-contract 预填草稿键改 `new:<tabId>` |
| `handleSessionCreated`（composer 首发落地） | 占位 tab **原地转正**：id 换 `s:<sessionId>`；若该会话已有 tab（如另一占位同时首发同会话，理论边角）→ 并入既有 tab 并关占位 |
| `handleWorkspaceDeleted` | 关该工作区全部 tab（家 tab + 其会话/占位 tab） |

会话删除/归档对账：`onSessionDeleted` / 归档刷新路径调用 `closeTab`；恢复期（R2 restore）对账时失效 id 静默跳过。

## 3. URL（语法不变，`applyUrlToTabs` 重映射）

| URL | tab |
|---|---|
| `workspace=<id>&view=chat&session=<sid>` | 会话 tab |
| `workspace=<id>&view=chat`（无 session） | new-session 占位 tab |
| `workspace=<id>` / `…&view=overview` | 家 tab |
| `tab=home` / 无参数 | 首页（tab 条照常恢复，仅不激活） |

现有 owner-lookup（session.cwd → 最长前缀工作区，未注册时 on-the-fly import）原样保留；popstate 语义不变（仍是唯一 URL→state 读端）。

## 4. 持久化（R2）

`localStorage["pi-session-tabs"]`：

```json
{ "v": 1,
  "tabs": [
    { "kind": "session", "sessionId": "…" },
    { "kind": "new-session", "workspaceId": "…" },
    { "kind": "workspace-home", "workspaceId": "…" }
  ],
  "activeTabId": "s:…" }
```

- 写入：tabs/activeTabId 变化的 effect（纯数据序列化，便宜）。
- 恢复：workspaces + 会话列表加载完成后 resolve——session→SessionInfo（列表/locate）→ cwd 归属工作区；workspaceId→workspace；任一环节解析失败即跳过该条。**URL 深链优先**决定 active；URL 指向首页时用存储的 activeTabId。
- 占位 tab 的草稿在 draft store（`new:<tabId>` 键）天然跨重载；**顺带修复**今天 `new:<wsPath>` 多 composer 互踩的隐患。

## 5. 纯函数抽取（`lib/session-tabs.ts` + node:test）

- `serializeTabs(tabs)` / `restoreTabs(stored, { workspaces, sessions })` → `{ tabs, skipped }`
- `nextActiveTabId(tabs, closedId)` —— X1 邻居规则
- `tabQuery(tab)` —— URL 投影
- `resolveOpenSessionTarget(activeTab)` —— C1 分派（"morph" | "new-tab" | "from-home"）

## 6. 组件

- **新 `components/SessionTabBar.tsx`**（替换 `WorkspaceTabBar.tsx`，删除旧文件；两 shell 共用，保持无 isMobile 分支）：
  - 首页固定首 tab（现有 HomeIcon 语义保留）
  - chip 内容：工作区色点（id 哈希→调色板）+ 标签（会话标题（auto-name 后刷新）/ 家 tab=工作区名 / 占位=「新会话」）+ 运行呼吸点（`sessionActivity.runningIds`，替换今天的 `activityByWorkspaceId`；家 tab 保留工作区级聚合 ActivityIndicator）+ completed 未看点 + 关闭 ×
  - 拖拽排序、滚轮横滚、active scrollIntoView 沿用现有实现
  - 右端按钮区：＋（P1，无工作区上下文时隐藏）+ ⊞（工作区选择器下拉，选→`ensureHomeTab`；「已打开」标记改为「家 tab 已开」）
- `WorkspaceSidebar` 会话列表行：onClick 照旧（C1）、`onAuxClick`（中键）/ Cmd+click → `openSessionTab`；hover「新 tab 打开」小图标为可选增强
- `DesktopShell` 中区分支改 kind 判断：`workspace-home` → WorkspaceOverview；`session` → ChatWindow(session)；`new-session` → ChatWindow(newSessionCwd=tab.workspace.path)。文件面板 F1 天然成立（状态已在 tab 上），树按 `activeWorkspace` 挂载不变
- `MobileShell`：tab 行换 SessionTabBar（紧凑 chips：色点+短标题）；行显示条件 `activeTabId || homeSession || homeNewSession.open`（原 activeWorkspace 条件改写）；底部导航 Phase 1 不动

## 7. ChatWindow 挂载（M1）

现状即 M1（active tab 单挂 + `sessionKey` bump 重建 + SSE 重连对账），无需改造；确认点：切 tab 路径统一 bump `sessionKey`；tab 徽章不依赖每会话 SSE。

## 8. 任务拆分（每步可独立验证）

1. `lib/session-tabs.ts` 纯函数 + `lib/session-tabs.test.mjs`（X1/R2/C1 分派/URL 投影）
2. 状态层模型切换 + SessionTabBar + 两 shell 接线（类型联动，单 commit）——含迁移表全部 handler、中区分支、＋/⊞
3. 列表手势：WorkspaceSidebar Cmd/中键 → 新 tab
4. 家 tab/首页/工作项/loop 流迁移：handleShowOverview、handleOpenSessionFromHome、runLoopAndOpen、handleOpenWorkItemConversation、handleRunContract、handleOpenSessionViewer
5. R2 持久化 + 恢复 + 失效对账
6. 收尾：草稿键迁移确认、auto-name 实时标签、AGENTS.md 更新（导航章节改写）

验证：`node_modules/.bin/tsc --noEmit`、`npm run lint`、`npm test`；手测清单——
同工作区两会话并行切换 / Cmd 点开新 tab / fork 新 tab / 关 tab 邻居回落 / 刷新恢复全部 tab / 跨工作区 tab 色点切换中栏 / 首页点会话直达 / 工作项开始对话预填 / loop 起轮开 tab / 移动端 chips 行。

## 9. Phase 2 提纲（W-中，独立交付，建立在 Phase 1 之上）

- `ActivityBar` 模块组撤销（工作台/知识库/工作项/Loops 图标退役），只留全局组（模型/Skills/插件/归档/设置）
- 中栏瘦身：`WorkspaceSidebar` 只剩会话列表 + WorkspaceSwitcher + ＋新建会话；知识库/工作项/Loops 面板退役
- `WorkspaceOverview`（家 tab 本体）升级为唯一模块枢纽：工作项完整管理面、知识库浏览、Loops 管理、仓库管理入口区块化（现有内容重组为主）
- 移动端底部 tab 收敛为 会话/工作台/设置；知识库/工作项/Loops 入口 = 工作台 overview 栈页
- 配套：`ALL_WORKSPACE_CAPABILITIES` 不变（capability 仍门控 extension 挂载与设置开关）；`pi-active-view:<wsId>` 持久化语义随面板退役简化
