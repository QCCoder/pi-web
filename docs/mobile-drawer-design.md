# 移动端导航重构：树抽屉（mobile drawer nav）

状态：M1 + M2 已实现（2026-09）。M2 = Android 返回键关抽屉、左缘右滑开抽屉、圆点查看即清除细粒度。
设计经用户逐条确认（grill 会话），决策记录见文末。

---

## 1. 问题

当前移动端导航 = 顶部 ChatToolbar + SessionTabBar（会话 chips 行）+ 底部 4 tab（会话/工作区/文件/设置）。三个真实痛点（用户确认 A+B+C 全部成立）：

- **A. 切工作区太深**：唯一常规路径是 设置›工作区（或新会话 composer 的选择器）；首页退役后跨工作区找会话也变难。
- **B. 头部 chips 放不下**：手机宽度下会话 chips 很快横滚，找不到目标会话。
- **C. 导航碎**：底部 tab + 头部 chips + 各模块子页栈，多个导航表面并存，没有统一的「我要去哪」的表面。

根因：2026-09 首页退役 + 菜单化之后，「工作区/会话的全局视图」在移动端没有家——树只存在于桌面 ProjectSidebar，移动端只有 tab 条和菜单页。

## 2. 方案一句话

**手机 = 抽屉承载唯一定期导航**（内容 = 桌面 ProjectSidebar 同一棵树 + 工作区节点下新增模块行），**聊天常为主区**，**≥768px 树常驻贴左**。底部 tab 栏、头部 chips 行全部删除。

```
手机（<768px）                      平板/宽视口（≥768px）
平时              点☰后
┌────────────┐   ┌──────┬─────┐    ┌────────┬──────────┐
│ ☰  标题    │   │ 树    │░░░░░│    │ 树(常驻)│ ☰  标题  │
│   聊天     │   │(覆盖) │░遮罩░│    │        │   聊天   │
│  (全屏)    │   │      │░░░░░│    │        │          │
└────────────┘   └──────┴─────┘    └────────┴──────────┘
```

同一棵树、两种外壳：窄 = 滑出覆盖，宽 = 常驻推挤内容。跨过 768px 断点实时切换，tab 状态与会话不丢（沿用现有断点机制）。

## 3. 抽屉内容

复用 `components/ProjectSidebar.tsx`（含 ⌘K 搜索面板、顶部导航行、底部设置条），新增一个**移动端变体**（prop，如 `variant="drawer"` 或 `showModuleRows`），差异仅一处：

**工作区节点展开后、会话行上方，插入模块行**（桌面树没有模块行，桌面零改动）：

```
＋ 新建任务   ⌘N
🔍 搜索       ⌘K
🧩 插件&技能
项目             ＋
 ▼ cxin
    📄 文件      📋 工作项     ← 模块行（2 列紧凑网格）
    📚 知识库    🔁 Loops
    ────────────────────
    · 会话 A（运行中）
    · 会话 B
    归档
 ▸ workspace-b
（暗淡行：已停用工作区 ⚙ / 不可用工作区）
─────────────
设置  模型  Agents
```

- **门控**：工作项/知识库按 `workspace.capabilities`（同 WorkspaceHomeMenu 现状）；Loops 常驻（文件即声明）；文件常驻（改动分段 git-only 的逻辑 FilesExplorerPanel 自带）。
- 模块行点击 = 该工作区的对应目的地全屏打开（见 §4）。
- WorkspaceHomeMenu **退役**：新建会话→树「＋新建任务」、会话→树内直挂、模块组→模块行、工作区设置→底部设置条。菜单这层导航不再存在。

## 4. 导航语义

### 4.1 扁平主区（Q5）

- shell 层只有两层：**聊天 ⇄ 当前目的地**。`‹返回` 永远 = 回聊天，与进入路径无关。
- 目的地集合（全屏渲染，复用现有嵌入模式，一行都不重写）：
  - `{page:"files"}` → FilesExplorerPanel（[文件|改动] 分段 + ⟳ 照旧）
  - `{page:"work-items"}` → WorkspaceManager `embedded + panel`
  - `{page:"knowledge"}` → KnowledgeBrowser
  - `{page:"loops"}` → LoopsDockPanel
  - `{page:"settings"}` → SettingsPanel（移动端全行索引模式；归档 = 其内子页，照现状）
- 深层导航（工作项列表→详情、Loops→配置、设置→子页、文件→打开文件）**全部留在面板内部**，机制不变（含聊天附件/文件全屏 overlay、subagent 子会话查看器）。
- 模块内点会话（如工作项「查看会话」）→ 现有 chatFocusKey 信号切回聊天，照旧。
- 不存在目的地之间横跳的路径（想去别处 = 再开抽屉），因此**不需要历史栈**。

### 4.2 上下文规则（Q7）：跟着屏幕走

抽屉里以工作区 W 为目标的任何动作（会话行、模块行）都使 **W 成为当前工作区**。实现走现有 tab 状态模型，不新增移动端专属状态：

**ensureWorkspaceContext(W)**：幂等地「建或激活」W 锚定的占位 tab（复用 `openNewSessionTab` + `findReusableNewSessionTab` 去重：已有 W 的空草稿占位 tab 就激活它），纯状态操作、不切走当前画面。然后：

- 点 W 的会话行 → `handleSelectSession`（现有 C1 分派，tab.workspace 天然 = W）。
- 点 W 的模块行 → ensureWorkspaceContext(W) + 设置 `mobilePage` 目的地。
- `activeWorkspace = activeTab.workspace` 的共享推导**原样成立**；新建任务默认归属、工具栏工作区名、面板 cwd 全部自动正确。
- ‹返回 回聊天后，屏幕上是 V 工作区的会话 → 上下文自然回到 V（所见即所指）。

### 4.3 新建任务（Q6）

抽屉「＋新建任务」= **直落 composer**（新建占位 tab，控制行带 WorkspaceSelector 可改归属，草稿持久化照旧）。手机侧不再有 HomeLanding 两段式（问候语+大输入卡）；HomeLanding 在手机只剩一个职责：**零可用工作区时的创建/重启用引导**（全部停用/未建时接手，含 ⚙ 进设置的逃生口——保留现有逻辑）。桌面侧 HomeLanding 一切角色不动。

## 5. 头部（Q4）

- SessionTabBar **手机不渲染**（组件保留，桌面照用；tab **状态模型**两层共用：草稿、URL 深链、会话 tab 语义全部不变）。
- ChatToolbar：
  - ☰ 按钮**手机恢复渲染**，点击开/关抽屉。挂**状态小圆点**：后台会话运行中 → accent 呼吸点；有已完成未查看 → 次级色点。数据源 = 现有 `sessionActivity.runningIds/completedIds`；「未查看」在抽屉打开或查看该会话时清除。
  - 工具栏中段显示**当前会话标题**（手机 only，省略号截断；无会话时显示当前工作区名）。
- 键盘适配层：`html.pi-keyboard-open .mobile-bottom-tabbar { display:none }` 规则随底部栏删除（键盘开启时工具栏在顶部仍可见，☰ 仍可点，抽屉可开）。

## 6. 抽屉本体（Q8）

| 参数 | 值 |
|---|---|
| 宽度 | `min(300px, 85vw)` |
| 打开 | 点 ☰ ＋ **左缘右滑手势**（M2：起点距左缘 <28px、横移 >56px、明显横向 \|dx\|>1.5\|dy\|，passive 监听不劫内容滚动） |
| 关闭 | 点中目标即关 / 点遮罩即关 / **Android 返回键**（M2：抽屉打开时 pushState 陷阱态，popstate 只关抽屉不退页；其他方式关闭时 cleanup 消费陷阱态） |
| 动画 | 滑入 ~200ms + 遮罩淡入（respect prefers-reduced-motion） |
| 展开状态 | 工作区节点折叠持久化共用 `pi-tree-collapsed`（手机/桌面不同浏览器天然隔离，同设备两端一致） |
| 层级 | 全屏高度覆盖（含工具栏区域），z-index 在内容之上（fixed inset-0 z1000） |
| ☰ 状态圆点 | 后台运行 → accent 点；已完成未查看 → 次级点；抽屉打开 = 全部标记已看，**查看该会话 = 单个标记已看**（M2 细粒度） |

状态放 `useAppShellState`（如 `mobileNavOpen`），保持无 isMobile 分支原则：ChatToolbar 按 `useIsMobile()` 决定 ☰ 的 onClick 落到 `setSidebarOpen`（桌面）还是 `setMobileNavOpen`（手机）。

## 7. 宽视口（Q9）

- ≥768px（`useMediaQuery`，现有断点）：**树常驻贴左**，不覆盖、推挤内容（桌面同款 flex 行布局），抽屉形态关闭、☰ 隐藏（无东西可开）。
- MobileSideRail 组件**删除**。
- 手机抽屉 / 平板常驻是同一棵树的两种宿主形态；跨断点切换保留 `mobilePage` 与会话状态。

## 8. 删除清单

| 删除 | 说明 |
|---|---|
| 底部 tab 栏 JSX + `mobile-bottom-tabbar` CSS（含键盘隐藏规则） | MobileShell + globals.css |
| `MobileTab` / `TAB_ORDER` / `readStoredTab` / `pi-mobile-tab:<wsId>` | 底部 tab 状态机整体 |
| `overviewStack`（工作区 tab 子页栈） | 被 mobilePage 目的地 + 树内直挂取代 |
| `WorkspaceHomeMenu.tsx` | 组件退役删除（职能见 §3） |
| SessionTabBar 手机渲染 + `showTabBarRow` | 组件保留（桌面用） |
| HomeLanding 手机占位 tab 两段式（`composerTabId`/`explicitComposeRef`） | 手机侧；桌面不动 |
| `MobileSideRail` | §7 |

**保留不动**：会话 tab 状态模型（`lib/session-tabs.ts` 及测试）、各模块面板及其内部导航、`useAgentSession`/SSE/键盘双策略适配、subagent 查看器、文件 overlay、URL 深链（`applyUrlToTabs` 语义不变——手机只是不渲染条子）。

## 9. 边界情况

- **零可用工作区**（全部停用/未建）：HomeLanding 引导接手（现有逻辑，含停用工作区 ⚙ 重启用路径），无底部栏依赖。
- **已停用工作区**：树底暗淡行 ⚙ → 设置›工作区预选（现有路径，随树复用自动带过来）。
- **设置›工作区深链**（原 WorkspaceHomeMenu「工作区设置」行）：随菜单退役；常规路径 = 底部「设置」→ 工作区分区列表点选（分区 rail 在所有面板宽度保留，功能不丢）。不顺手再加速捷。
- **运行徽章**：会话行 SessionRow 自带（树复用即得）；☰ 圆点补足「抽屉关着时」的感知。
- **subagent 子会话**：不在树中（现有 `subagentChild` 过滤照旧），从结果卡打开的路径不变。

## 10. 实现切分

- **M1（已完成）**：mobileNavOpen 状态 + ChatToolbar ☰/标题/圆点 → 抽屉（ProjectSidebar drawer 变体 + 模块行）→ mobilePage 目的地渲染 → 删除清单执行 → 键盘 CSS 清理 → AGENTS.md 更新。
- **M2（已完成）**：Android 返回键拦抽奖屉；左缘右滑开抽屉；☰ 圆点查看即清除细粒度。
- **候选（未排期）**：设置›工作区捷径（若实际使用觉得绕）。

## 11. AGENTS.md 需同步的段落

- Navigation/Shall split 章节：移动端描述整体重写（抽屉 + 常驻树 + 扁平目的地 + ensureWorkspaceContext）。
- **设计决策反转记录**：「Don't reintroduce a drawer」（`0d96111`）——记录反转原因：该决策针对的是「旧抽屉装模块面板 + 没有统一会话/工作区树」的时代；现树已存在且被证明是正确的导航内容，痛点是移动端缺树而非抽屉形态本身。
- ChatToolbar（☰ 手机渲染 + 圆点 + 标题）、ProjectSidebar（drawer 变体 + 模块行）、File Map（删 WorkspaceHomeMenu/MobileSideRail 行）。
- 键盘章节：`.mobile-bottom-tabbar` 隐藏规则删除的说明。

---

## 决策记录（grill 会话，2026-09，用户逐条确认）

| Q | 决策 |
|---|---|
| Q1 痛点 | A（切工作区深）+ B（chips 放不下）+ C（导航碎）全部成立 |
| Q2 骨架 | 抽屉唯一导航，底部 tab 栏删除，聊天默认全屏 |
| Q3 模块入口 | 模块行长在展开的工作区节点下；WorkspaceHomeMenu 退役 |
| Q4 头部 | chips 行删除；工具栏会话标题；☰ 挂后台状态圆点 |
| Q5 主区语义 | 扁平：‹返回 永远 = 回聊天；深层导航留面板内部 |
| Q6 新建任务 | 直落 composer（带工作区选择器）；HomeLanding 只剩零工作区引导 |
| Q7 上下文 | 跟着屏幕走（点 W 下的东西 ⇒ W 成为当前；ensureWorkspaceContext 实现） |
| Q8 抽屉参数 | 300px/85vw；☰ 开；点目标/遮罩关；共用 pi-tree-collapsed；返回键拦截延后 |
| Q9 宽视口 | ≥768px 树常驻贴左；MobileSideRail 删除；不引入 DesktopShell |
