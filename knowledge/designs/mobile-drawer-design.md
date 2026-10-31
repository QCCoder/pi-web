# 移动端导航重构：树抽屉（mobile drawer nav）

状态：M1 + M2 已实现（2026-09）。M2 = Android 返回键关抽屉、左缘右滑开抽屉、圆点查看即清除细粒度。
**2026-09-27 顶栏重排（§5 已被取代）+ 侧栏瘦身（§3 被取代，侧栏只剩会话）；2026-10-26 手机底部 tab 改版
（§2「抽屉是唯一定期导航」在 <768px 被反转：抽屉退役、MobileTabShell 底部 3 tab；≥768px 平板形态不动），
见文末三条补充记录（最新在最后）**。
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

---

## 补充记录：侧栏瘦身（2026-09-27，grill 会话三，用户确认）

### 决策（§3 被取代）

侧边栏**只剩会话**：工作区树（节点/hover 快捷键/拖拽）与模块行（§3）退役；「项目」区头 +
＋菜单、树底暗淡行一并迁出。侧栏新结构 = `headerSlot（移动端抽屉头切换块）+ 新建任务/搜索/
插件&技能 三行 + 当前工作区会话清单（显示更多 + 组尾归档行）+ 底部 设置/模型/Agents`。

- **WorkspaceSwitcherPanel（新组件，两端共用）**：工作区列表（点击切换；当前项高亮；运行/
  完成徽章；拖拽排序沿用全量 PATCH）+ ＋新建工作区/导入目录（承接「项目＋」）+ 停用/不可用
  暗淡行（⚙ 重启用路径不断）+ 当前工作区模块入口（总览/文件/工作项/知识库/Loops，capability
  门控与 active 高亮由宿主计算）。桌面 = 32px 工作区工具行「工作区名 ▾」下方弹出（点外部
  关闭，右侧只留 总览+文件 平铺捷径）；移动端 = 抽屉/常驻树头部 headerSlot 内联展开。
- **切工作区两端对齐 = 落总览**：桌面开家 tab（现状）；手机新增 `mobilePage:"overview"`
  目的地（WorkspaceOverview 全屏 + ‹返回=聊天；ensureWorkspaceContext(W) 先行）。手机此前
  无总览面——这是两端最大的交互差异，本次补齐。
- 手机模块入口 = 面板内点击 → ensureWorkspaceContext + mobilePage（§4.2 语义不变），active
  高亮跟 mobilePage；桌面 = dock 开合语义，active 跟 panelEffTabId。
- 模块入口结果形态差异保留（桌面右坞并排 / 手机全屏页）——形态所限，入口与语义已对齐。
- **同日晚追加：会话清单「# 分组」开关**（用户看 ZCode 截图后要求）：开 = 按项目分组（静态组头[文件夹+项目名+计数，不可点/不可折叠——工作区切换只走顶部面板] + 每组 5 条 + 组内显示更多）；关 = 全部会话最近活跃平铺（前 20 + 一次性显示更多）。持久化 `pi-sidebar-grouped`，缺省开；两端同构（同一组件自动继承）。上一轮「只显示当前工作区」的设定随之翻转——分组/平铺都列全部项目的会话。
- **同日晚再追加：「项目」分区行 + 手机模块条**。分区行 = `📁 项目 [#分组] …… ＋`（标题 13px 与导航行一致；＋ = 新建工作区/导入目录 body-portal 菜单，两端一致）。手机端工作区切换器撤下（分组清单已列全部项目、点会话即切上下文）——headerSlot 换成紧凑**模块条**（总览/文件/工作项/知识库/Loops 竖排图标 chip，作用于当前工作区，active 跟 mobilePage，capability 门控）；`WorkspaceSwitcherPanel` 与「切工作区=落总览」保留桌面（手机 overview 入口 = 模块条「总览」）。
- **同日收尾：项目行收起/展开 chevron**——一键收起整个项目列表（含归档行），极简侧栏态；持久化 `pi-projects-collapsed`，缺省展开。
- **组头折叠回归**：分组组头整行可点（头像+项目名+chevron+计数），收起/展开该项目会话；持久化沿用树时代 `pi-tree-collapsed`（老用户偏好自动延续）。彩色首字头像（名字 FNV-1a 哈希 → 12 色相板稳定配色）替代原灰文件夹图标。

### 实现

- `components/WorkspaceSwitcherPanel.tsx`（新）；`ProjectSidebar.tsx` 重写为会话侧栏（props
  增 `activeWorkspace`/`headerSlot`，删 onOpenWorkspace/onOpenWorkspaceSettings/
  onReorderWorkspaces/workspaceActivity/showModuleRows/onOpenModule/onNewSessionInWorkspace）；
  `DesktopShell.tsx`（32px 行改造）；`MobileShell.tsx`（MobilePage 增 "overview"、overview
  目的地渲染、切换块与面板接线）。`WorkspaceNavigation.test.mjs` 结构断言同步（905/905 过）；
  Playwright 19 项断言 + 截图（gui-test-screenshots/r4_*）验收。

## 补充记录：顶栏重排（2026-09-27，grill 会话二，用户确认）

### 背景与决策

M1 后顶栏实际状态 = ☰ + 主题 + 语言 + 4 个会话控件（图标）+ 右对齐标题 + 统计，最坏 8~9 个
控件挤 375px（标题仅剩 ~110px），且 36px 高低于 44px 触控标准。grill 二轮定案（方案 C）：

| Q | 决策 |
|---|---|
| Q2 顶栏职责 | **定位优先**：`☰ | 会话标题（居中）| 统计 | ⋯`；高度 36 → **44px**（仅移动端） |
| Q5 溢出菜单 | **设 ⋯**（方案 C）。理由：降级后 B 方案（抽屉+composer 分宿）与 ⋯ 的到达深度同为 2 击，C 单一收纳位心智更简单，分支/历史属「阅读场景」工具（顶栏比输入框旁更近），且实现面最小（复用 ChatToolbar 下拉面板框架） |
| Q3/Q7（取代） | 6 个降级控件（主题/语言/完整历史/自动命名/分支/系统提示词）**全部进 ⋯ 菜单**，分两组（全局 ｜ 会话，分隔线）；会话组沿用 `showChat` 门控；抽屉底部不加主题/语言快捷行（Q7 作废）；composer「更多控件」弹出条不动 |
| Q6 标题 | **点击标题打开会话信息面板**（复用 `toggleTopPanel("session")`，锚定顶栏下方全宽）；统计按钮保留（承担上下文用量颜色指示） |
| 其余 | PC 端 ChatToolbar 零改动（36px、主题/语言原位）；抽屉/子页面/手势/返回键全部不动 |

### 实现

- `ChatToolbar.tsx`：44px（`isMobile ? 44 : 36`）；主题/语言按钮与历史/命名/系统按钮 `!isMobile` 化；
  标题居中 + `role="button"` + 点击 `toggleTopPanel("session")`；新增 ⋯ 按钮（`activeTopPanel: "more"`，
  useAppShellState 类型扩展）与 `MoreMenuRow` 菜单体；统计按钮移动端 `paddingRight` 不再为桌面固定
  dock 开关预留 48px。
- `BranchNavigator.tsx`：新增 `hideTrigger`（inline 模式只挂面板不渲染触发钮）——移动端分支面板
  仍锚定 `containerRef`（顶栏），入口在 ⋯ 菜单。
- i18n：新增 `i18n.more`（中/英）。
- 验收：44px/居中/标题点面板/dock 交互共 8 项 playwright 断言全过 + 双端截图
  （gui-test-screenshots/r1~r3_*）。

## 补充记录：手机底部 tab 改版（2026-10-26，grill 会话，用户确认——最新）

### 背景与决策（§2「抽屉是唯一定期导航」在 <768px 被反转）

用户要求手机端「更符合手机操作」：底部 tab 页签（会话 / skill / 设置），先出 HTML 稿确认布局再实现。
grill 过程中挖出 §1 的历史：底部 tab 是 2026-09 被刻意删掉的，但删的理由是 **C「导航碎」=
tab + 头部 chips + 各模块子页栈三个导航表面并存**，而非 tab 本身；A「切工作区太深」是另一痛点。
本轮的两条规避：**tab 栏成为唯一定期导航**（抽屉、边缘右滑、头部模块条在 <768px 全部退役——不叠加）；
**首页组头一步进工作区页**（切工作区不再经设置）。

| Q | 决策 |
|---|---|
| Q1/Q7 骨架 | 底部 3 tab 会话 / Skill / 设置；☰ 抽屉彻底退役（不并存）；工作项不占 tab，走工作区语境二级页 |
| Q2 Skill tab | 一步到位：全量能力（列表/启停/搜索/安装/更新，全局+项目分组），不做只读阉割版。**实现后反馈修订**（「Skill/设置页面布局不好看，一页放不下就开详情页，不要硬塞」）：不再内嵌 `SkillsConfig` 分栏，改为手机原生三页 `MobileSkillsPages`（根页列表 + 开关 → 推入详情页 / 推入安装页），数据层 `useMobileSkills` 与桌面同一套 API |
| Q3 → 首页重排 | 首页 = **跨工作区分组**，每组约 3 条最近会话预览、最近活跃组在前；不可选工作区灰显组头 + ⚙；顶栏 = 「会话」+ 搜索（全局）+ ⋯；右下 FAB 新建（默认最近活跃工作区，composer 内 WorkspaceSelector 可换）；原「顶栏工作区 ▾ 切换器 + 按时间分组」方案被此取代 |
| 组头 / 行 | 组头 → 推入**工作区页**；会话行 → 推入**聊天页**。工作区页**实现后反馈修订**（「二级太简陋、布局不合理、样式太丑」）→ `MobileWorkspacePage`：顶栏 ‹ + 名 + ⋯；正文 hero（彩色首字头像 + 路径 + 会话数/能力 pills）→ 新建会话主按钮 → 会话列表卡片 → 已归档会话；模块 chips 行退役。**实现后反馈修订 ①**：「分组间隔不明显、没有分组的感觉」「会话能不能收缩」→ 先做了卡片 + 折叠；**修订 ②**（用户：「为什么不能直接把 PC 端左侧菜单→项目的样式搬过来」）→ 首页改为**复用 `ProjectSidebar`**（新增 `phoneHome`：只渲染项目头 + 分组体），样式零偏差、折叠/头像/显示更多/# 分组/长按排序全部继承；组头整行 = 收起/展开，头像 → 工作区页；自绘卡片列表删除 |
| Q13 顶栏 ⋯ | 保留；**作用于最近活跃会话所属工作区**（`defaultHomeNewSessionWorkspaceId`），菜单头标注作用域；项 = 文件 / 工作项 / 知识库 / Loops / 工作区设置。**实现后反馈修订（反转）**：用户「一级页面右侧 ⋯ 这些应该放在二级（工作区）、三级（会话里）」→ 首页 ⋯ 删除；同一组入口下沉到工作区页顶栏 ⋯（替掉 ⚙ 按钮与模块 chips 行，「顶部按键不用，用 ⋯ 就好」）与聊天页 ChatToolbar ⋯ 的「工作区」组（`moreMenuExtras`） |
| Q8 聊天页 | 从列表推入，**tab 栏隐藏**，‹ 返回上一页，composer 独占底边；ChatToolbar ⋯ 菜单内容不变 |
| Q14 统一规则 | **所有推入页（工作区页 / 聊天页 / 设置子页）一律隐藏 tab 栏** |
| Q4/Q11 设置 tab | 索引 = 偏好 / 模型 / Agents / 插件；工作区设置与 Skills **不在此**（分别经 ⋯ / 工作区页 ⚙ 推入、升一级 tab）；归档住工作区页底部。**实现后反馈修订**：索引改为 iOS 分组卡片 + 彩色图标瓷片 + 当前值 hint（`PhoneSettingsIndex`），与 Skill 页共用 `mobile-ui` 原语 |
| Q12 范围 | 首页跨工作区；搜索全局（复用 SearchPalette） |
| Q9 平板 | **≥768px 本轮不动**（树常驻贴左 + 目的地页）——抽屉本来只在 <768px 存在（`drawerOpen = mobileNavOpen && !showPermanentTree`），删除对平板零影响 |
| Q5/Q6 稿 | 单文件并排静态五屏（会话首页 / ⋯ 展开 / 工作区页 / 聊天 / Skill / 设置），沿用现有主题变量跟随明暗 |

### 实现

- **新文件 `components/shell/MobileTabShell.tsx`**（手机壳）：底部 tab 栏（`.mobile-tabbar`，底部安全区自理）、
  会话首页（`<ProjectSidebar phoneHome>` 复用桌面「项目」分组体：`ProjectSidebar` 新增 `phoneHome` 不渲染导航三行 / 内置
  SearchPalette / 组尾归档行 / 底部三入口，滚动区底部留 88px 给 FAB；页脚停用工作区入口；壳自挂 SearchPalette、⋯ 菜单、FAB）、推入栈
  `pushStack: PushPage[]`（kind ∈ chat | workspace | files | work-items | knowledge | loops | archive |
  ws-settings，带 workspaceId；最深 home → 工作区页 → 聊天；tab 切换清空；‹ 弹一层；`replaceTop`
  供 工作项→Loops 恢复换页）、`tabBarVisible = 栈空 && settingsPage==="index"`、聊天层持久挂载在最
  底（栈顶为聊天时上层全隐藏，与旧目的地页分层同构）、`chatFocusKey` → 推入聊天页（替代旧「关
  目的地页」语义）、work-items 深链映射（presence→push + deeplink 标记 + `closeWorkItemsDeeplink`
  URL 回写，与 MobileShell 同契约）、Android 返回键陷阱态移植（`piMobilePushPage`，每层一个
  history 态；UI 弹栈时立 ignore 标记再 `history.go(-n)`）、零工作区分支（HomeLanding 住会话 tab，
  设置 tab 天然可达 = 重启用逃生口）、文件/会话查看 overlay 同款。工作区设置推入页用局部
  `selectWorkspaceRequest` 驱动 WorkspaceManager（不走共享 `requestWorkspaceSettings`——它会把共享
  `settingsPage` 置 "workspace" 污染设置 tab）。
- **新文件 `components/shell/MobileWorkspaceSettings.tsx`**：工作区设置推入页手机原生重做（用户反馈「工作区设置 UI 太丑」——内嵌
  桌面 WorkspaceManager 双栏退役）。契约与桌面同一套：名称/启用 PATCH `expectedUpdatedAt`（409 → 重拉 + 提示）、能力只读 pills、
  Skill 入口（切 Skill tab）、仓库 GET/DELETE/PATCH（停用/恢复，新增走桌面）、交付自动化 GET /delivery + /delivery/roles 只读摘要、
  从列表移除两步确认（DELETE 仅注销列表）。响应 workspace 合并回壳列表。
- `ChatToolbar`：手机居中标题回归纯标签，「会话信息」面板入口移进 ⋯ 菜单会话组首项（用户反馈「会话信息页放到 ⋯ 里」；
  2026-09-27 顶栏重排 Q6「点击标题打开会话信息面板」就此作废）；随后用户再要求统计按钮也收进 ⋯ → 手机顶栏不再渲染统计按钮，
  「会话信息」行尾显示上下文用量 % + 预警色（桌面/平板统计按钮不变）。手机聊天页顶栏最终 = `‹ | 标题 | ⋯`。
- **新文件 `components/shell/MobileWorkspacePage.tsx`**：二级工作区页（顶栏 ⋯ 菜单 = 文件/工作项/知识库/Loops〔门控〕/工作区设置；hero 复用
  `ProjectSidebar.workspaceAvatarStyle`；会话数经 `workspaceForSession` 归属计数；`WorkspaceSessionList showHeader={false}` 装进卡片）。
  `ChatToolbar` 新增 `moreMenuExtras`（手机聊天页 ⋯ 的「工作区」组，MobileTabShell 注入同一组入口）。首页顶栏 ⋯ 删除。
- **新文件 `components/shell/useMobileSkills.ts` / `MobileSkillsPages.tsx` / `mobile-ui.tsx`**：Skill tab 数据层（GET/PATCH
  /api/skills、PATCH /api/workspaces/{id} 白名单、/api/skills/{search,install,check,update}，与 `SkillsConfig` 逐字同构的
  sourceLabel / 分组序 / isEnabled 谓词）、三页 UI、手机通用列表原语（MobilePageTitle / MobileSection / MobileCard / MobileRow /
  MobileSwitch / MobileSearchField / MobilePill / MobileNote / 按钮 / 错误条）。`SettingsPanel` 新增 `PhoneSettingsIndex`
  （phoneTab 分支），平板全量平铺索引不变。
- `MobileShell.tsx` → **平板壳**：删抽屉 JSX / Android 抽屉陷阱 / 边缘右滑三段与 `closeDrawer`；
  `ChatToolbar navToggle="hidden"` 固定；空态自动落 composer 的 effect 加 `wide` 门（手机壳自带
  `ensureWorkspaceContext` 版）；全部 hooks 之后 `if (!wide) return <MobileTabShell />`。
  mobilePage 目的地机 / 头部模块条 / renderPageContent 原样保留。
- `useAppShellState.ts`：`mobileNavOpen` 删除；新增 `MobileTab` 类型 + `mobileTab/setMobileTab`
  （共享层，跨 768 断点往返不丢 tab；推入栈留局部）。
- `ChatToolbar.tsx`：`ToolbarNavToggle` 只剩 `sidebar | hidden`；☰ 抽屉开关与后台状态圆点删除
  （后台活动改由首页行级徽章承载）；新增 `onBack`/`backLabel`（手机聊天页 ‹ 占原 ☰ 位）。
- `SettingsPanel.tsx`：新增 `phoneTab` prop——索引省略 工作区 / Skills / 归档 三行；平板壳缺省全量。
- `app/globals.css`：删 `.mobile-nav-scrim/.mobile-nav-drawer/@keyframes pi-nav-*`；新增 `.mobile-tabbar
  /.mobile-tabbar-item`（不写 app-height 变量，高度链仍走 `--app-vh`）；更新键盘注释（聊天页无 tab
  栏 → 无需旧「键盘弹出隐藏 tab 栏」内核分叉）与 640 媒体块注释。
- 测试：`WorkspaceNavigation.test.mjs` 抽屉块改写为「平板壳 + 手机壳」两块（头注释前置本次反转
  段）；`lib/work-items-entry.test.mjs` 增 MobileTabShell 深链同构断言；`MobilePwaLayout.test.mjs`
  头注释修正。
- 跨 768 断点：共享层会话/tab/工作区状态与 `mobileTab` 保留，两壳局部页态（mobilePage / pushStack）
  重置，聊天重挂载自动重连 SSE——与 640↔桌面跨断点现有行为一致。
- 未做（记为后续 polish）：平板形态改动、tab/推入页 URL 化、无 FAB 页面的新建会话补充入口。

## 补充记录 2：手机导航统一（2026-10-26，接上节；用户反馈「没有一个统一的 tab/nav 设计，每个页面自己画自己的，链路乱」）

底部 tab 改版落地后手机端仍残留四类碎片：页头四套并存（桌面规格 `PanelHeader` 36px 被直接搬上手机推入页 / `MobilePageTitle`
只用在 Skill 根页 / 会话首页手抄一份同样式 / `ChatToolbar`）；工作区模块入口（文件/工作项/知识库/Loops/工作区设置）的
id+label+图标+capability 门控抄了四份（聊天页 ⋯、工作区页 ⋯、平板模块条、壳内 ModuleIcon）；tab 栏显隐两条规则路径
（pushStack 与 SettingsPanel 自管子页各算各的）；‹ 文案有 bug（从聊天页 ⋯ 推入模块页，下一层是 chat 却落默认分支误标「会话」）。
本轮在**不改信息架构**（仍是 3 tab + 扁平推入栈）的前提下统一：

- **页头两形态**（`mobile-ui.tsx` 新原语）：tab 根页 = `MobilePageTitle`；推入页 = `MobileNavBar`（44px，‹ + 下一层页名 +
  标题 + meta + 动作槽，accent 返回钮）。八个手机推入页全部迁移；`PanelHeader` 退回平板壳/桌面面板；聊天页 `ChatToolbar`
  唯一特例（返回目标改为取栈里聊天层的下一层）。`WorkItemsPage` 加 `phone` prop 切 MobileNavBar 页头。
  **实现后反馈修订**（用户：「导航栏为什么有这么多文字？不应该是简洁的一个标题吗？」）：MobileNavBar / MobilePageTitle
  **撤下 meta 槽，单标题**——工作区名/路径与 ‹ 文案（来自哪层）重复，上下文由返回文案与页内 hero 承载；手机工作项改由
  手机原生页组 `MobileWorkItemsPages` 承载（自带 MobileNavBar 单标题页头），`WorkItemsPage` 的 phone prop 随之删除；
  `settingsSubpageHeader()` 的 meta 仅平板壳 PanelHeader 继续使用。
  **实现后反馈修订 ②**（用户：「标题大小不太好，统一和会话详情页——大小、居中」）：推入页 MobileNavBar 的标题统一为会话页
  ChatToolbar 同款 **13px/500、居中、超长省略**，高度统一 44px——标题绝对定位居中（两侧 padding 避让 ‹/动作钮，
  返回钮 maxWidth 116 防长工作区名挤位）。
  **实现后反馈修订 ③**（用户：「第一级 tab 页标题放左边、字体大点」）：`MobilePageTitle`（tab 根页）改回**左对齐大标题
  17px/600**（iOS large-title 语义），推入页保持居中 13/500——两级页头各自定位：根页大标题（在哪一栏），推入页居中小标题
  （在哪一页）。同轮用户反馈「工作项列表 cell 分两行」：`MobileWorkItemsPages` 列表行从三行（KEY 行/标题行/状态行 + 阶段
  轨迹点）收敛为**两行——第一行标题（单行省略），第二行状态（KEY · 优先级 · 阶段 · 待确认/状态 ⋯ 时间/待处理标记）**，
  PhaseTrack 轨迹点与来源 pill 退出 cell（详情页仍有完整轨迹），骨架屏随之两行。
- **模块入口唯一出处**：新文件 `components/shell/workspace-modules.tsx`——`WorkspaceModuleIcon` + `workspaceModuleEntries(
  workspace, {overview?, settings?})`，四份重复定义删成一份（同轮 `MobileMenu` 浮层原语替换工作区页手写下拉）。
- **一条栈、一条规则**：设置子页并入推入栈（`settings-sub`；`SettingsPanel` 加 `headerless` 只出正文 + 导出
  `settingsSubpageHeader()`，页头由壳出；PhoneSettingsIndex 行点击 = push）；tab 栏显隐收敛为唯一不变式
  **栈非空即隐藏**（`settingsPage !== "index"` 特判删除；共享 `settingsPage` 手机端不再消费）。
- **‹ 文案 = 栈里下一层页的标题**：`backLabelFor` 重写（栈底 = 当前 tab 名、聊天 = 「聊天」、工作区页 = 工作区名），
  修掉误标「会话」的 bug；聊天页 ChatToolbar 返回目标同理（工作区页推入的聊天 ‹ 文案 = 工作区名）。
- 测试：`WorkspaceNavigation.test.mjs` 手机壳测试改钉新不变式（tabBarVisible = 栈空 / settings-sub 入栈 / 注册表门控 /
  推入页无 PanelHeader）；`lib/work-items-entry.test.mjs` capability 断言改指注册表。
- 规则落 AGENTS.md「通用」节（页头两形态 / 模块入口唯一出处 / 栈非空藏 tab），细节本档与 `knowledge/reference/ui-shell.md`。
