import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 2026-09 ZCode 风格导航改版（原树形侧栏改版延续）导航结构断言：
 * 桌面左侧 = 单一项目树侧栏（顶部 新建任务⌘N/搜索⌘K/插件&技能 三行导航 +
 * 项目→会话树 / 组尾归档 / 底部 设置·模型·Agents 三入口——插件/Skills 上移
 * 为顶部导航行），图标栏 + 中栏面板双轨退役；配置面全部走中央区整页
 * （CenterPage）。桌面 SessionTabBar 的 ⊞ 工作区选择器退役。
 *
 * 2026-09 配置页拆分（用户反馈「插件&技能/设置/模型/Agents 跳转的页面都一
 * 模一样」）：四个导航入口各自打开独立中央区整页（ConfigCenterPage：各带
 * 页头 + 页内作用域索引列），SettingsPanel 的 desktop 两栏模式退役、退为
 * 移动端设置目的地页专用。
 *
 * 2026-09 移动端树抽屉重构（knowledge/designs/mobile-drawer-design.md）：底部 tab 栏、
 * 头部会话 chips 行、MobileSideRail、WorkspaceHomeMenu 全部退役——抽屉是
 * 唯一定期导航（ProjectSidebar：头部工作区切换块 + 当前工作区会话），聊天
 * 是主区默认，非聊天目的地是带 ‹返回（= 回聊天）的全屏页；≥768px 树常驻
 * 贴左。上下文规则「跟着屏幕走」由 ensureWorkspaceContext 实现。
 *
 * 2026-09-27 侧栏瘦身改版（grill 会话三）：侧边栏只剩「会话」——工作区树、
 * 模块行退役；工作区切换 + 模块入口（总览/文件/工作项/知识库/Loops）收进
 * 两端共用的 WorkspaceSwitcherPanel（桌面 = 32px 工作区工具行「工作区名 ▾」
 * 弹出；移动端 = 抽屉头部内联展开）。切工作区两端对齐 = 落该工作区总览
 * （桌面开家 tab→2026-10 改为总览整页 centerPage "overview"，见文末测试与
 * knowledge/designs/overview-center-page-design.md；手机新增 mobilePage:"overview" 目的地）。
 *
 * 2026-10 右坞 rail 改版（grill 会话，反转 2026-09-27「模块 tab 按需打开」）：
 * 桌面右坞 = 36px 常驻纯 icon 图标列（文件/Loops/工作项/知识库/终端）+ 展开面板——
 * 点未激活图标切模块并展开、点已激活图标收起到只剩 rail；激活模块 + 展开态
 * per-workspace 持久化（pi-dock-rail）。工具行删「文件」捷径、切换面板不再
 * 传模块入口（回归纯工作区管理）；activeFileTabId 回归纯文件语义。
 *
 * 2026-10-26 手机底部 tab 改版（grill 会话，反转 2026-09「抽屉是唯一定期导航」，
 * knowledge/designs/mobile-drawer-design.md 文末补充记录）：<768px 由新壳 MobileTabShell 承
 * 载——底部 3 tab 会话/Skill/设置 = 唯一定期导航；☰ 抽屉、边缘右滑、Android 抽屉
 * 陷阱态全部退役（当年删 tab 的痛点「导航碎」靠「tab 唯一」规避，「切工作区太深」
 * 靠首页组头一步进工作区页解决）。会话首页 = 跨工作区分组 × 3 条预览（组头 →
 * 推入工作区页，会话行 → 推入聊天页，顶栏 ⋯ 作用于最近活跃会话所属工作区）；
 * 推入栈扁平、所有推入页隐藏 tab 栏；Skills 升一级 tab（SkillsConfig 全量）；
 * 设置 tab 索引 = 偏好/模型/Agents/插件（phoneTab 省略 工作区/Skills/归档）。
 * ≥768px 平板壳（MobileShell：树常驻 + 目的地页）本轮零改动——抽屉只在 <768px
 * 存在，删除即零影响。
 */
const projectSidebarSource = await readFile(
  new URL("./ProjectSidebar.tsx", import.meta.url),
  "utf8",
);
const desktopShellSource = await readFile(
  new URL("./shell/DesktopShell.tsx", import.meta.url),
  "utf8",
);
const shellStateSource = await readFile(
  new URL("./shell/useAppShellState.ts", import.meta.url),
  "utf8",
);
const sessionTabBarSource = await readFile(
  new URL("./SessionTabBar.tsx", import.meta.url),
  "utf8",
);
const mobileShellSource = await readFile(
  new URL("./shell/MobileShell.tsx", import.meta.url),
  "utf8",
);
const mobileTabShellSource = await readFile(
  new URL("./shell/MobileTabShell.tsx", import.meta.url),
  "utf8",
);
const mobileSkillsPagesSource = await readFile(
  new URL("./shell/MobileSkillsPages.tsx", import.meta.url),
  "utf8",
);
const useMobileSkillsSource = await readFile(
  new URL("./shell/useMobileSkills.ts", import.meta.url),
  "utf8",
);
const mobileUiSource = await readFile(
  new URL("./shell/mobile-ui.tsx", import.meta.url),
  "utf8",
);
const mobileWorkspacePageSource = await readFile(
  new URL("./shell/MobileWorkspacePage.tsx", import.meta.url),
  "utf8",
);
const mobileWorkspaceSettingsSource = await readFile(
  new URL("./shell/MobileWorkspaceSettings.tsx", import.meta.url),
  "utf8",
);
const workspaceModulesSource = await readFile(
  new URL("./shell/workspace-modules.tsx", import.meta.url),
  "utf8",
);
const mobileWorkItemsPagesSource = await readFile(
  new URL("./shell/MobileWorkItemsPages.tsx", import.meta.url),
  "utf8",
);
const chatToolbarSource = await readFile(
  new URL("./shell/ChatToolbar.tsx", import.meta.url),
  "utf8",
);
const settingsPanelSource = await readFile(
  new URL("./SettingsPanel.tsx", import.meta.url),
  "utf8",
);
const configCenterPageSource = await readFile(
  new URL("./ConfigCenterPage.tsx", import.meta.url),
  "utf8",
);
const workspaceOverviewSource = await readFile(
  new URL("./WorkspaceOverview.tsx", import.meta.url),
  "utf8",
);
const workspaceManagerSource = await readFile(
  new URL("./WorkspaceManager.tsx", import.meta.url),
  "utf8",
);
const homeLandingSource = await readFile(
  new URL("./HomeLanding.tsx", import.meta.url),
  "utf8",
);
const globalsCssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const skillsConfigSource = await readFile(
  new URL("./SkillsConfig.tsx", import.meta.url),
  "utf8",
);
const modelsConfigSource = await readFile(
  new URL("./ModelsConfig.tsx", import.meta.url),
  "utf8",
);
const pluginsConfigSource = await readFile(
  new URL("./PluginsConfig.tsx", import.meta.url),
  "utf8",
);
const workspaceSwitcherPanelSource = await readFile(
  new URL("./WorkspaceSwitcherPanel.tsx", import.meta.url),
  "utf8",
);

test("project sidebar: sessions-only body (2026-09-27 侧栏瘦身), nav rows on top, three bottom entries", () => {
  // 顶部三行导航（ZCode 风格安静行）：新建任务 ⌘N / 搜索 ⌘K / 插件&技能。
  // ⌘/Ctrl+N·K 全局快捷键；搜索 = 弹框（SearchPalette 命令面板）。
  assert.match(projectSidebarSource, /新建任务/);
  assert.match(projectSidebarSource, /label="搜索"/);
  assert.match(projectSidebarSource, /插件&技能/);
  assert.match(projectSidebarSource, /function NavRow/);
  assert.match(projectSidebarSource, /"k"/);
  assert.match(projectSidebarSource, /<SearchPalette/);
  assert.match(projectSidebarSource, /onSelectSession=\{onSelectSearchHit\}/);
  assert.doesNotMatch(projectSidebarSource, /<SessionSearch/);
  assert.doesNotMatch(projectSidebarSource, /onCollapse/);
  assert.match(desktopShellSource, /<WorkspaceSelector/);
  assert.match(desktopShellSource, /createNewSessionTab\(target, tab\.id\)/);
  // 2026-09-27 侧栏瘦身：工作区树 / 模块行 / 节点 hover 动作 / 折叠持久化 /
  // 「项目」区头 + ＋菜单全部退役——侧栏 = 当前工作区的会话清单。
  assert.doesNotMatch(projectSidebarSource, /showModuleRows/);
  assert.doesNotMatch(projectSidebarSource, /WorkspaceNodeRow/);
  assert.doesNotMatch(projectSidebarSource, /ModuleRow/);
  // 组头折叠（2026-09-27 晚回归）：整行可点收起/展开该项目会话，持久化沿用
  // 树时代的 pi-tree-collapsed（老用户折叠偏好自动延续）。
  assert.match(projectSidebarSource, /pi-tree-collapsed/);
  assert.match(projectSidebarSource, /toggleGroup\(group\.workspace\.id\)/);
  assert.match(projectSidebarSource, /aria-expanded=\{!groupCollapsed\}/);
  // 「项目」分区标题随分组开关回归（2026-09-27 晚，ZCode 同款）：只在分组态
  // 渲染，组头仍是纯视觉。
  assert.match(projectSidebarSource, /分区标题「项目」/);
  // 只渲染当前工作区（activeWorkspace）的会话：groupSessionsByWorkspace 做
  // 会话→工作区归属，取当前组；SessionRow 共享（rounded）+ 默认 5 条截断 +
  // 显示更多；组尾「归档」行 = 当前工作区回收站。
  assert.match(projectSidebarSource, /activeWorkspace: WorkspaceSummary \| null/);
  assert.match(projectSidebarSource, /groupSessionsByWorkspace\(workspaces, allSessions, \{ orderBy: "workspaces" \}\)/);
  assert.match(projectSidebarSource, /SessionRow/);
  assert.match(projectSidebarSource, /SESSION_PREVIEW_COUNT = 5/);
  assert.match(projectSidebarSource, /显示更多/);
  assert.match(projectSidebarSource, /onOpenArchive/);
  // 移动端抽屉/常驻树头部切换块以 headerSlot 注入（桌面不传——切换器在顶部
  // 工作区工具行）。
  assert.match(projectSidebarSource, /headerSlot\?: ReactNode/);
  // 底部三入口：设置/模型/Agents，kind 顺序固定；顶部「插件&技能」→ plugins 整页。
  const bottomBlock = projectSidebarSource.slice(
    projectSidebarSource.indexOf("BOTTOM_ENTRIES"),
    projectSidebarSource.indexOf("export function ProjectSidebar"),
  );
  const kinds = [...bottomBlock.matchAll(/kind: "(settings|models|plugins|agents)",/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ["settings", "models", "agents"]);
  assert.match(projectSidebarSource, /onOpenCenterPage\(\{ kind: entry\.kind \}\)/);
  assert.match(projectSidebarSource, /onOpenCenterPage\(\{ kind: "plugins" \}\)/);
  // 骨架门控（未加载不渲染假空态）。
  assert.match(projectSidebarSource, /workspacesLoaded \|\| !sessionsLoaded/);
  // 「# 分组」开关（2026-09-27 晚，ZCode 同款 chip）：开 = 按项目分组（静态
  // 组头，不可点/不可折叠）；关 = 全部会话最近活跃平铺。状态持久化
  // pi-sidebar-grouped，缺省开；两种形态各自带「显示更多」。
  assert.match(projectSidebarSource, /pi-sidebar-grouped/);
  assert.match(projectSidebarSource, /role="switch"/);
  assert.match(projectSidebarSource, /FLAT_PREVIEW_COUNT = 20/);
  assert.match(projectSidebarSource, /分组头（整行可点/);
  // 「项目」分区行右侧 ＋ = 新建工作区/导入目录菜单（body-portal，原「项目＋」承接）。
  assert.match(projectSidebarSource, /新建工作区…/);
  assert.match(projectSidebarSource, /导入目录…/);
  assert.match(projectSidebarSource, /aria-label="新建 \/ 导入工作区"/);
  // 「项目」分区收起（2026-10 用户反馈去箭头）：标题图标+「项目」整体可点 =
  // 收起/展开（无 chevron），收起整个项目列表（含归档行），持久化
  // pi-projects-collapsed，缺省展开。
  assert.match(projectSidebarSource, /pi-projects-collapsed/);
  assert.match(projectSidebarSource, /aria-expanded=\{!projectsCollapsed\}/);
  assert.match(projectSidebarSource, /\{!projectsCollapsed && \(</);
  assert.match(projectSidebarSource, /fontVariantNumeric: "tabular-nums"/);
  // 全文件无折叠 chevron（组头 + 分区行都去箭头，2026-10 用户反馈）。
  assert.doesNotMatch(projectSidebarSource, /rotate\(-90deg\)/);
  // 项目分组行长按拖拽排序（2026-10 用户反馈）：300ms 长按进入拖拽、位移超
  // 6px 取消；上半/下半 = 插前/插后（与切换面板同语义）；全量 PATCH 序
  //（停用/不可用项保持现序垫底）；长按松手不触发组折叠；两端 shell 接线。
  assert.match(projectSidebarSource, /onReorderWorkspaces\?: \(ids: string\[\]\) => void/);
  assert.match(projectSidebarSource, /DRAG_LONG_PRESS_MS = 300/);
  assert.match(projectSidebarSource, /DRAG_MOVE_SLOP_PX = 6/);
  assert.match(projectSidebarSource, /commitReorder/);
  assert.match(projectSidebarSource, /className="workspace-drop-line"/);
  assert.match(projectSidebarSource, /suppressClickRef/);
  assert.match(projectSidebarSource, /setPointerCapture/);
  assert.match(desktopShellSource, /onReorderWorkspaces=\{handleReorderWorkspaces\}/);
  assert.match(mobileShellSource, /onReorderWorkspaces: s\.handleReorderWorkspaces/);
  // 分组头项目头像 → 打开项目首页（2026-10 用户反馈）：桌面 = 工作区家 tab
  //（handleOpenWorkspace）；移动端 = 切上下文 + 总览目的地页；头像点击
  // stopPropagation 不触发整行收起。
  assert.match(projectSidebarSource, /onOpenWorkspaceHome\?: \(workspace: WorkspaceSummary\) => void/);
  assert.match(projectSidebarSource, /onOpenWorkspaceHome\(group\.workspace\)/);
  assert.match(desktopShellSource, /onOpenWorkspaceHome=\{handleOpenWorkspace\}/);
  assert.match(mobileShellSource, /onOpenWorkspaceHome: \(workspace: WorkspaceSummary\) => \{/);
});

test("workspace switcher panel: shared workspace list + module entries (2026-09-27)", () => {
  // 工作区列表（点击 = 切换；当前项高亮 menuitemradio；运行/完成徽章）+
  // ＋新建工作区/导入目录（原「项目＋」菜单承接）+ 拖拽排序（全量 PATCH，
  // 停用/不可用项现序垫底）+ 暗淡停用行 ⚙ 重启用路径（「找得回」不断）+
  // 模块入口区（宿主组装，menuitemcheckbox + aria-checked）。
  assert.match(workspaceSwitcherPanelSource, /onSelectWorkspace: \(workspace: WorkspaceSummary\) => void/);
  assert.match(workspaceSwitcherPanelSource, /role="menuitemradio"/);
  assert.match(workspaceSwitcherPanelSource, /新建工作区…/);
  assert.match(workspaceSwitcherPanelSource, /导入目录…/);
  assert.match(workspaceSwitcherPanelSource, /onReorderWorkspaces\?: \(ids: string\[\]\) => void/);
  assert.match(workspaceSwitcherPanelSource, /moveDraggedWorkspace/);
  assert.match(workspaceSwitcherPanelSource, /draggable=\{onReorderWorkspaces \? true : undefined\}/);
  assert.match(workspaceSwitcherPanelSource, /dropPositionOf/);
  assert.match(workspaceSwitcherPanelSource, /className="workspace-drop-line"/);
  assert.match(workspaceSwitcherPanelSource, /!workspace\.available \|\| workspace\.disabled/);
  assert.match(workspaceSwitcherPanelSource, /onOpenWorkspaceSettings\?\.\(workspace\)/);
  assert.match(workspaceSwitcherPanelSource, /role="menuitemcheckbox"/);
  assert.match(workspaceSwitcherPanelSource, /SwitcherModuleEntry/);
});

test("desktop shell: single tree sidebar, no icon rail; center pages precede overview/chat", () => {
  // 图标栏退役：不再渲染 ActivityBar；中栏机制（renderMiddleColumn）由
  // ProjectSidebar 常驻取代。
  assert.doesNotMatch(desktopShellSource, /ActivityBar/);
  assert.match(desktopShellSource, /<ProjectSidebar/);
  assert.doesNotMatch(desktopShellSource, /renderMiddleColumn/);
  // 中央区整页分支优先于 总览/聊天：点任何会话 tab 即回。
  assert.match(desktopShellSource, /centerPage \? renderCenterPage\(\)/);
  // 配置页拆分（2026-09）：设置/模型/插件&技能/Agents 四个独立整页渲染在
  // ConfigCenterPage（DesktopShell 仍不直接挂四个 Config 组件；工作区 slot
  // 的 inline-split WorkspaceManager 照旧注入）。
  assert.doesNotMatch(desktopShellSource, /configPortalNode/);
  assert.doesNotMatch(desktopShellSource, /<ModelsConfig/);
  assert.doesNotMatch(desktopShellSource, /<SkillsConfig/);
  assert.doesNotMatch(desktopShellSource, /<PluginsConfig/);
  assert.doesNotMatch(desktopShellSource, /<AgentsConfig/);
  assert.match(desktopShellSource, /<ConfigCenterPage/);
  // 桌面 SessionTabBar 不传 onPickWorkspace（⊞ 退役）；SettingsPanel 退为
  // 移动端专用——DesktopShell 不再渲染它。
  assert.doesNotMatch(desktopShellSource, /onPickWorkspace/);
  assert.doesNotMatch(desktopShellSource, /<SettingsPanel/);
  assert.match(mobileShellSource, /<SettingsPanel/);
  assert.match(desktopShellSource, /split=\{\{ inline: true \}\}/);
  // 整页心智（2026-09 用户反馈「点击插件和技能的时候为什么还有顶部 tab」）：
  // 遮 chrome 的中央区整页（配置/归档/工作项管理）打开时隐藏会话 tab 条；总览
  // 整页不遮——2026-10 单栏合并后 tab 条最左就是「🏠 工作区名 ⌄」chip，总览 =
  // chip 高亮的那一态（门控 `chromeHidden` = centerPage 非空且 kind ≠ overview；
  // 纯首页无工作区上下文且无 tab 时不渲染空条）。
  assert.match(desktopShellSource, /const overviewOpen = centerPage\?\.kind === "overview";/);
  assert.match(desktopShellSource, /const chromeHidden = Boolean\(centerPage\) && !overviewOpen;/);
  assert.match(desktopShellSource, /\{!chromeHidden && \(activeWorkspace !== null \|\| tabs\.length > 0\) && \([\s\S]*?<SessionTabBar/);
});

test("shell state: centerPage replaces sidebarView/configView; any tab activation closes it", () => {
  // CenterPage 是唯一中央区整页状态（含工作区作用域的 archive）。
  assert.match(shellStateSource, /export type CenterPage =/);
  assert.match(shellStateSource, /\| \{ kind: "archive"; workspaceId: string \}/);
  assert.doesNotMatch(shellStateSource, /setSidebarView|useState<SidebarView/);
  assert.doesNotMatch(shellStateSource, /setConfigView|useState<ConfigView/);
  assert.doesNotMatch(shellStateSource, /configPortalNode/);
  // activateTab 清 centerPage（配置页只是盖在聊天上的一层）。
  assert.match(shellStateSource, /setCenterPage\(null\);/);
  // 旧持久化键（pi-active-panel / pi-active-view）退役。
  assert.doesNotMatch(shellStateSource, /pi-active-panel/);
  assert.doesNotMatch(shellStateSource, /pi-active-view/);
  // toggle 语义：同页再点一次 = 关。
  assert.match(shellStateSource, /sameCenterPage\(current, page\) \? null : page/);
});

test("session tab bar: ⊞ removed; mobile drops the strip entirely (drawer nav)", () => {
  // ⊞ 选择器已删（2026-09 移动端反馈）：两个 shell 都不再传 onPickWorkspace，
  // 组件里也不再有 picker 代码。
  assert.doesNotMatch(sessionTabBarSource, /onPickWorkspace/);
  assert.doesNotMatch(sessionTabBarSource, /WorkspaceIcon/);
  // 「首页」chip 退役（2026-10 单栏合并）：桌面首页早已退役、chip 永远 false；
  // 其位置改为 `leading` 槽——DesktopShell 把「🏠 工作区名 ⌄」工作区 chip +
  // 切换面板嵌进 tab 条最左，原独立 32px 工具行整行删除（用户反馈「打开会话
  // 就出现两个栏」）。移动端整个 chips 行已删（2026-09 树抽屉重构 Q4）。
  assert.doesNotMatch(sessionTabBarSource, /showHomeTab\?: boolean|onSelectHome: \(\)|function HomeIcon/);
  assert.match(sessionTabBarSource, /leading\?: React\.ReactNode;/);
  assert.match(sessionTabBarSource, /\{leading\}/);
  assert.match(sessionTabBarSource, /onNewSession\?: \(\) => void;/);
  assert.doesNotMatch(mobileShellSource, /<SessionTabBar/);
  assert.match(desktopShellSource, /<SessionTabBar/);
  // 空态自动落回：移动端给默认工作区开占位 composer 作上下文锚（replace 写
  // URL，防历史陷阱）；桌面落总览整页。关最后一个 tab 不落空态。
  assert.match(mobileShellSource, /defaultHomeNewSessionWorkspaceId/);
  assert.match(mobileShellSource, /openNewSessionTab\(target, \{ replace: true \}\)/);
  assert.match(desktopShellSource, /leading=\{activeWorkspace \? \(/);
  assert.match(desktopShellSource, /onNewSession=\{activeWorkspace \? handleTabBarNewSession : undefined\}/);
  assert.doesNotMatch(desktopShellSource, /height: 32, flexShrink: 0, position: "relative"/);
  assert.match(desktopShellSource, /defaultHomeNewSessionWorkspaceId/);
  assert.match(desktopShellSource, /handleOpenWorkspace\(target, \{ replace: true \}\)/);
  assert.match(desktopShellSource, /desktopCloseTab/);
  // ＋ 新占位 tab 桌面先展示首页内容（HomeLanding，2026-09「都要变」）；
  // 移动端 ＋新建任务直落 composer（抽屉重构 Q6——抽屉树即首页全貌）。
  assert.match(desktopShellSource, /<HomeLanding/);
  assert.match(desktopShellSource, /composerTabId/);
  assert.match(desktopShellSource, /newSessionDirect/);
  assert.doesNotMatch(mobileShellSource, /composerTabId/);
  assert.doesNotMatch(homeLandingSource, /Desktop: retired/);
  // ＋ 沾性固定：tab 溢出时吸附在条的最右，不被滚出屏幕。
  assert.match(sessionTabBarSource, /position: "sticky"/);
  assert.match(sessionTabBarSource, /scrollPaddingRight: 36/);
});

test("tablet shell (≥768px): permanent tree + destination pages; narrow delegates to MobileTabShell (2026-10 底部 tab 改版)", () => {
  // 旧 2026-09 抽屉全链退役：scrim / 滑入面板 / Android 抽屉陷阱态 / 边缘右滑 /
  // ☰ 开关状态——两壳源码与 CSS 均不再出现。
  assert.doesNotMatch(mobileShellSource, /mobile-nav-drawer/);
  assert.doesNotMatch(mobileShellSource, /mobile-nav-scrim/);
  assert.doesNotMatch(mobileShellSource, /piMobileNavDrawer/);
  assert.doesNotMatch(mobileShellSource, /touchstart/);
  assert.doesNotMatch(mobileShellSource, /mobileNavOpen/);
  assert.doesNotMatch(shellStateSource, /mobileNavOpen/);
  assert.doesNotMatch(chatToolbarSource, /mobileNavOpen/);
  assert.doesNotMatch(globalsCssSource, /mobile-nav-drawer/);
  assert.doesNotMatch(globalsCssSource, /mobile-nav-scrim/);
  assert.doesNotMatch(globalsCssSource, /@keyframes pi-nav-drawer-in/);
  // 更早退役项继续缺席。
  assert.doesNotMatch(mobileShellSource, /MobileSideRail/);
  assert.doesNotMatch(mobileShellSource, /WorkspaceHomeMenu/);
  assert.doesNotMatch(mobileShellSource, /showModuleRows/);
  assert.doesNotMatch(globalsCssSource, /mobile-bottom-tabbar/);
  assert.doesNotMatch(globalsCssSource, /pi-mobile-tab/);
  // <768px 整体委托（放在全部 hooks 之后）；≥768px 平板形态零改动：树常驻
  // 贴左、头部模块条、扁平目的地页（‹返回 = 回聊天）、ChatToolbar ☰ 隐藏。
  assert.match(mobileShellSource, /import \{ MobileTabShell \} from "\.\/MobileTabShell"/);
  assert.match(mobileShellSource, /if \(!wide\) \{\s*return <MobileTabShell \/>;\s*\}/);
  assert.match(mobileShellSource, /<ProjectSidebar/);
  assert.match(mobileShellSource, /headerSlot: mobileSwitcherSlot/);
  assert.match(mobileShellSource, /showPermanentTree/);
  assert.match(mobileShellSource, /useMediaQuery\("\(min-width: 768px\)"\)/);
  assert.match(mobileShellSource, /type MobilePage =/);
  assert.match(mobileShellSource, /backLabel="聊天"/);
  assert.match(mobileShellSource, /<ChatToolbar navToggle="hidden" \/>/);
  // 上下文规则（「跟着屏幕走」）：ensureWorkspaceContext 纯状态锚定，不 focusChat。
  assert.match(shellStateSource, /ensureWorkspaceContext = useCallback/);
  assert.match(shellStateSource, /不 focusChat/);
  assert.match(mobileShellSource, /ensureWorkspaceContext\(workspace\)/);
  // ChatToolbar：navToggle 只剩 sidebar/hidden；新增 onBack（手机聊天页 ‹）。
  assert.match(chatToolbarSource, /export type ToolbarNavToggle = "sidebar" \| "hidden";/);
  assert.match(chatToolbarSource, /onBack\?: \(\) => void/);
});

test("phone shell (<768px): bottom 3-tab bar is the only recurring navigation (2026-10 底部 tab 改版)", () => {
  // 共享层：mobileTab 提升到 useAppShellState（跨 768 断点往返不丢 tab）。
  assert.match(shellStateSource, /export type MobileTab = "sessions" \| "skills" \| "settings";/);
  assert.match(shellStateSource, /const \[mobileTab, setMobileTab\] = useState<MobileTab>\("sessions"\);/);
  // 底部 tab 栏：会话 / Skill / 设置，role=tab，样式类 .mobile-tabbar（CSS 让出
  // 底部安全区，不写 app-height 变量——AGENTS.md 高度链硬规则）。
  assert.match(mobileTabShellSource, /className="mobile-tabbar"/);
  assert.match(mobileTabShellSource, /label: "会话"/);
  assert.match(mobileTabShellSource, /label: "Skill"/);
  assert.match(mobileTabShellSource, /label: "设置"/);
  assert.match(mobileTabShellSource, /role="tab"/);
  assert.match(globalsCssSource, /\.mobile-tabbar \{[\s\S]*?env\(safe-area-inset-bottom/);
  assert.doesNotMatch(globalsCssSource, /\.mobile-tabbar[\s\S]{0,400}--app-height/);
  // 推入栈（扁平小栈）：chat / workspace / files / work-items / knowledge / loops /
  // archive / ws-settings / skill-detail / skill-install / settings-sub。tab 栏显隐
  // 唯一规则 = 栈非空即隐藏（2026-10-26 导航统一：设置子页 settings-sub 也进推入栈，
  // 旧的 settingsPage 特判删除）。
  assert.match(mobileTabShellSource, /type PushPage =/);
  assert.match(mobileTabShellSource, /type WorkspacePushKind = "workspace" \| "files" \| "work-items" \| "knowledge" \| "loops" \| "archive" \| "ws-settings";/);
  assert.match(mobileTabShellSource, /\| \{ kind: "settings-sub"; page: SettingsSubpage \}/);
  assert.match(mobileTabShellSource, /const tabBarVisible = top === null;/);
  assert.doesNotMatch(mobileTabShellSource, /settingsPage !== "index"/);
  // 共享焦点信号（打开会话/新建会话）= 推入聊天页；聊天页 ChatToolbar 带 ‹。
  assert.match(mobileTabShellSource, /if \(chatFocusKey === 0\) return;[\s\S]*?\{ kind: "chat" \}/);
  assert.match(mobileTabShellSource, /<ChatToolbar onBack=\{handleBackFromChat\}/);
  // 会话首页 = 桌面左栏「项目」同一组件（用户反馈：直接把 PC 左侧菜单→项目的样式
  // 搬过来）。ProjectSidebar 新增 phoneHome：只渲染项目头 + 分组/平铺体——导航三行 /
  // 内置 SearchPalette / 组尾归档行 / 底部三入口不渲染；折叠（pi-tree-collapsed）、
  // 彩色首字头像、每组 5 条 + 显示更多、# 分组、长按排序全部继承；头像 → 工作区页。
  assert.match(mobileTabShellSource, /<ProjectSidebar\s+phoneHome/);
  assert.match(mobileTabShellSource, /onOpenWorkspaceHome=\{openWorkspacePage\}/);
  assert.match(projectSidebarSource, /phoneHome\?: boolean;/);
  assert.match(projectSidebarSource, /\{!phoneHome && \(\s*<nav aria-label="主导航"/);
  assert.match(projectSidebarSource, /\{!phoneHome && \(\s*<SearchPalette/);
  assert.match(projectSidebarSource, /\{activeWorkspace && !phoneHome && \(/);
  assert.match(projectSidebarSource, /paddingBottom: phoneHome \? 88 : 0/);
  // 手机壳自己不再维护一份分组列表（无自绘组头 / SessionRow / groupSessionsByWorkspace）。
  assert.doesNotMatch(mobileTabShellSource, /groupSessionsByWorkspace/);
  assert.doesNotMatch(mobileTabShellSource, /<SessionRow/);
  // 一级首页只管找会话：顶栏 = 「会话」+ 搜索，**没有 ⋯**（用户反馈：模块入口应在
  // 二级工作区页 / 三级聊天页，首页没有明确作用对象）；FAB 默认落最近活跃工作区。
  assert.doesNotMatch(mobileTabShellSource, /aria-label="更多"/);
  assert.match(mobileTabShellSource, /defaultHomeNewSessionWorkspaceId\(workspaces, sessions, s\.mruIds\)/);
  // 工作区模块入口（文件/工作项/知识库/Loops/工作区设置）唯一出处 = 注册表
  // （capability 门控在注册表里做；手机两处 ⋯ 菜单与平板模块条同一份，
  // 2026-10-26 导航统一——此前同一组内容抄了四份）。
  assert.match(mobileTabShellSource, /workspaceModuleEntries\(workspace, \{ settings: true \}\)/);
  assert.match(workspaceModulesSource, /export function workspaceModuleEntries/);
  assert.match(workspaceModulesSource, /capabilities\.includes\("work-items"\)/);
  assert.match(workspaceModulesSource, /capabilities\.includes\("knowledge"\)/);
  assert.match(mobileTabShellSource, /ensureWorkspaceContext\(workspace\)/);
  assert.match(mobileTabShellSource, /个工作区已停用\/不可用 · 管理/);
  // 二级工作区页 = MobileWorkspacePage：顶栏 ‹ + 名 + ⋯（文件/工作项/知识库/Loops/
  // 工作区设置，capability 门控——原首页 ⋯ 下沉至此，替掉旧 ⚙ 按钮与 chips 行）；
  // 正文 = hero（彩色首字头像 workspaceAvatarStyle + 路径 + 会话数/能力 pills）→
  // 新建会话主按钮 → 会话列表卡片（WorkspaceSessionList）→ 已归档会话。
  assert.match(mobileTabShellSource, /<MobileWorkspacePage/);
  assert.match(mobileWorkspacePageSource, /aria-label="更多"/);
  assert.match(mobileWorkspacePageSource, /workspaceModuleEntries\(workspace, \{ settings: true \}\)/);
  assert.match(mobileWorkspacePageSource, /workspaceAvatarStyle\(workspace\.name\)/);
  assert.match(mobileWorkspacePageSource, /新建会话/);
  assert.match(mobileWorkspacePageSource, /<WorkspaceSessionList/);
  assert.match(mobileWorkspacePageSource, /已归档会话/);
  assert.doesNotMatch(mobileWorkspacePageSource, /aria-label="工作区模块"/);
  // 工作区设置推入页 = MobileWorkspaceSettings（手机原生分组卡片，替代内嵌桌面 WorkspaceManager
  // 双栏；用户反馈「工作区设置 UI 太丑」）：名称/启用 PATCH 带 expectedUpdatedAt（409 → 重拉）、
  // 能力只读 pills、Skill 入口、仓库 停用/恢复、交付自动化只读摘要、从列表移除两步确认。
  assert.match(mobileTabShellSource, /<MobileWorkspaceSettings/);
  assert.doesNotMatch(mobileTabShellSource, /<WorkspaceManager/);
  assert.match(mobileWorkspaceSettingsSource, /expectedUpdatedAt: workspace\.updatedAt/);
  assert.match(mobileWorkspaceSettingsSource, /res\.status === 409/);
  assert.match(mobileWorkspaceSettingsSource, /\/repositories\?refresh=1/);
  assert.match(mobileWorkspaceSettingsSource, /action: "restore"/);
  assert.match(mobileWorkspaceSettingsSource, /\/delivery\/roles/);
  assert.match(mobileWorkspaceSettingsSource, /method: "DELETE" \}\);/);
  assert.match(mobileWorkspaceSettingsSource, /从列表移除/);
  assert.doesNotMatch(mobileWorkspaceSettingsSource, /workspace\.skills/);
  // 三级聊天页 ⋯ 多一个「工作区」组（ChatToolbar.moreMenuExtras，手机壳注入同一组内容）。
  assert.match(chatToolbarSource, /moreMenuExtras\?: ToolbarMenuExtra\[\]/);
  assert.match(chatToolbarSource, /moreMenuExtras\.map\(\(extra\) =>/);
  assert.match(mobileTabShellSource, /moreMenuExtras=\{chatMenuExtras\}/);
  // Android 返回键弹栈：抽屉陷阱模式移植为推入页陷阱态。
  assert.match(mobileTabShellSource, /piMobilePushPage/);
  // work-items 深链：推入该工作区的工作项页并记 deeplink 来源；关页清 centerPage + URL 回写。
  assert.match(mobileTabShellSource, /centerPage\?\.kind === "work-items"/);
  assert.match(mobileTabShellSource, /deeplink: true/);
  assert.match(mobileTabShellSource, /const closeWorkItemsDeeplink = useCallback/);
  // Skill = 一级 tab，手机原生三页（用户反馈「一页放不下就开详情页，不要硬塞」）：
  // 根页列表 → 推入 skill-detail / skill-install；数据层 useMobileSkills 与桌面
  // SkillsConfig 同一套 API（GET/PATCH /api/skills、
  // /api/skills/{search,install,check,update}）。手机壳不再内嵌 SkillsConfig 分栏。
  assert.match(mobileTabShellSource, /<MobileSkillsList/);
  assert.match(mobileTabShellSource, /\| \{ kind: "skill-detail"; filePath: string \}/);
  assert.match(mobileTabShellSource, /\| \{ kind: "skill-install" \}/);
  assert.match(mobileTabShellSource, /useMobileSkills\(\{/);
  assert.doesNotMatch(mobileTabShellSource, /<SkillsConfig/);
  assert.match(mobileSkillsPagesSource, /export function MobileSkillsList/);
  assert.match(mobileSkillsPagesSource, /export function MobileSkillDetail/);
  assert.match(mobileSkillsPagesSource, /export function MobileSkillInstall/);
  // 2026-10 收敛：工作区 Skill 白名单随 WorkspaceSummary.skills 退役——启停只有
  // frontmatter 一档（PATCH /api/skills），project 安装档位按锚定工作区门控。
  assert.match(useMobileSkillsSource, /fetch\(`\/api\/skills\?cwd=\$\{encodeURIComponent\(cwd\)\}`\)/);
  assert.match(useMobileSkillsSource, /const isEnabled = useCallback\(\(skill: SkillInfo\) => !skill\.disableModelInvocation, \[\]\);/);
  assert.match(useMobileSkillsSource, /projectInstallAvailable/);
  assert.doesNotMatch(useMobileSkillsSource, /workspaceSkills/);
  assert.match(useMobileSkillsSource, /"\/api\/skills\/check"/);
  assert.match(useMobileSkillsSource, /"\/api\/skills\/update"/);
  assert.match(useMobileSkillsSource, /"\/api\/skills\/search"/);
  assert.match(useMobileSkillsSource, /"\/api\/skills\/install"/);
  // 设置 tab = SettingsPanel phoneTab → PhoneSettingsIndex（iOS 分组卡片 + 图标瓷片 +
  // 当前值 hint；只放 偏好/模型/Agents/插件）；平板壳缺省仍是全量平铺索引。
  assert.match(mobileTabShellSource, /<SettingsPanel\s+phoneTab/);
  assert.match(settingsPanelSource, /phoneTab\?: boolean;/);
  assert.match(settingsPanelSource, /function PhoneSettingsIndex/);
  assert.match(settingsPanelSource, /\{page === "index" && phoneTab && \(\s*<PhoneSettingsIndex/);
  assert.match(settingsPanelSource, /\{page === "index" && !phoneTab && \(/);
  assert.match(settingsPanelSource, /import \{ MobileCard, MobileNote, MobilePageTitle, MobileRow, MobileSection \} from "\.\/shell\/mobile-ui";/);
  assert.doesNotMatch(mobileShellSource, /<SettingsPanel\s+phoneTab/);
  // 手机通用列表原语（Skill 三页与设置索引共用一套视觉语言）。
  assert.match(mobileUiSource, /export function MobileCard/);
  assert.match(mobileUiSource, /export function MobileRow/);
  assert.match(mobileUiSource, /export function MobileSwitch/);
  assert.match(mobileUiSource, /role="switch"/);
  // 2026-10-26 导航统一：页头两形态（tab 根 = MobilePageTitle 大标题，推入页 =
  // MobileNavBar 44px，聊天页 ChatToolbar 唯一特例）+ ⋯ 菜单原语 MobileMenu。
  // 手机推入页一律 MobileNavBar，不再用桌面规格的 PanelHeader；设置子页由壳出
  // MobileNavBar（SettingsPanel headerless 只出正文，settingsSubpageHeader 是子页
  // 标题/meta 唯一出处）。手机工作项 = 手机原生页组 MobileWorkItemsPages
  // （自带 MobileNavBar 页头），WorkItemsPage 退回平板/桌面专用。
  assert.match(mobileUiSource, /export function MobileNavBar/);
  assert.match(mobileUiSource, /export function MobileMenu/);
  assert.match(mobileTabShellSource, /<MobilePageTitle\s+title="会话"/);
  assert.match(mobileTabShellSource, /<MobileNavBar/);
  assert.doesNotMatch(mobileTabShellSource, /<PanelHeader/);
  assert.match(mobileTabShellSource, /from "\.\/MobileWorkItemsPages"/);
  assert.match(mobileWorkItemsPagesSource, /<MobileNavBar/);
  assert.match(mobileWorkspacePageSource, /<MobileNavBar/);
  assert.match(mobileWorkspacePageSource, /<MobileMenu/);
  assert.match(mobileWorkspaceSettingsSource, /<MobileNavBar/);
  assert.match(mobileSkillsPagesSource, /<MobileNavBar/);
  assert.match(settingsPanelSource, /headerless\?: boolean;/);
  assert.match(settingsPanelSource, /export function settingsSubpageHeader/);
  // 手机壳里没有抽屉、没有会话 chips 行。
  assert.doesNotMatch(mobileTabShellSource, /mobile-nav-drawer/);
  assert.doesNotMatch(mobileTabShellSource, /<SessionTabBar/);
});

test("sidebar slim-down: switcher panel on both shells; switch = land on overview (2026-09-27)", () => {
  // 桌面（2026-10 终态）：工作区切换面板入口**已删**——先是 32px 工具行「工作区名
  // ▾」弹出（2026-09-27），再并入 tab 条 chip 旁的 ⌄（2026-10 单栏合并），最后
  // 用户追问「为什么要一个下拉」：侧栏「项目」分区已覆盖 头像→总览 / 拖拽排序 /
  // ＋新建导入，停用工作区重启用走 设置›工作区，桌面上面板全部重复 → 删。
  // DesktopShell 不再持有 switcherOpen，也不再渲染 WorkspaceSwitcherPanel；
  // 组件文件暂留（MobileShell 仍引用其 SwitcherModuleEntry 类型，手机壳改版
  // 落地后整体清理）。
  assert.doesNotMatch(desktopShellSource, /switcherOpen/);
  assert.doesNotMatch(desktopShellSource, /WorkspaceSwitcherPanel/);
  // 2026-10 rail 改版：工具行的「文件」捷径与切换面板模块入口移除——模块
  // 入口常驻右坞图标列（rail），切换器回归纯工作区管理。
  assert.doesNotMatch(desktopShellSource, /moduleEntries=/);
  assert.match(desktopShellSource, /className=\{`dock-rail-icon/);
  assert.match(desktopShellSource, /activeWorkspace=\{activeWorkspace\}/);
  assert.doesNotMatch(desktopShellSource, /onOpenWorkspace=\{handleOpenWorkspace\}\s*\n\s*onOpenArchive/);
  // 平板壳（≥768px，MobileShell）：常驻树头部 headerSlot 注入模块条；模块入口 =
  // 目的地页语义（active 高亮跟 mobilePage）。（手机壳 <768px 另见底部 tab 测试。）
  assert.match(mobileShellSource, /headerSlot: mobileSwitcherSlot/);
  // 2026-09-27 晚：工作区切换器撤下（分组清单已列全部项目，点会话即切上下文）
  // ——WorkspaceSwitcherPanel 只留桌面；模块入口保留为树头部紧凑模块条
  // （总览/文件/工作项/知识库/Loops，作用于当前工作区）。
  assert.doesNotMatch(mobileShellSource, /<WorkspaceSwitcherPanel/);
  assert.doesNotMatch(mobileShellSource, /handleNavSwitchWorkspace/);
  assert.match(mobileShellSource, /aria-label="工作区模块"/);
  assert.match(mobileShellSource, /setMobilePage\("overview"\)/);
  // 切工作区两端对齐 = 落总览：手机新增 mobilePage:"overview" 目的地
  // （WorkspaceOverview 全屏，‹返回 = 回聊天）。
  assert.match(mobileShellSource, /type MobilePage = "overview" \|/);
  assert.match(mobileShellSource, /case "overview":/);
  assert.match(mobileShellSource, /<WorkspaceOverview/);
  assert.match(mobileShellSource, /title="总览" meta=\{activeWorkspace\.name\}/);
});

test("right dock rail: persistent icon column + expandable panel (2026-10 rail 改版)", () => {
  // 反转 2026-09-27「模块 tab 按需打开」：rail 常驻（文件/Loops/工作项/知识库/
  // 终端），点未激活图标 = 切模块并展开；点已激活图标 = 收起到只剩 rail。
  // 门控：knowledge/work-items capability 没开则图标不渲染；Loops/终端常驻。
  assert.match(desktopShellSource, /railEntries/);
  assert.match(desktopShellSource, /id: TERMINALS_TAB_ID,/);
  assert.match(desktopShellSource, /capabilities\.includes\("work-items"\) \? \(\[\{/);
  assert.match(desktopShellSource, /capabilities\.includes\("knowledge"\) \? \(\[\{/);
  assert.match(desktopShellSource, /handleRailClick/);
  // 状态层：激活模块 + 展开态 per-workspace 持久化（pi-dock-rail）。
  assert.match(shellStateSource, /pi-dock-rail/);
  assert.match(shellStateSource, /dockRailFor/);
  assert.match(shellStateSource, /openDockModule = useCallback/);
  // 任何路径打开文件 → 自动切「文件」模块并展开（共识 Q3）。
  assert.match(shellStateSource, /openDockModule\(dockWsId, FILES_TAB_ID\)/);
  // activeFileTabId 回归纯文件语义；终端激活不再借道该通道（共识 Q4）。
  assert.match(desktopShellSource, /const \[activeTerminalId, setActiveTerminalId\] = useState/);
  assert.doesNotMatch(desktopShellSource, /activeTerminalTab = terminalTabs\.find\(\(tab\) => tab\.id === panelActiveFileTabId\)/);
  // 遮 chrome 的整页打开或无工作区上下文时整个右坞隐藏（共识 Q6）；总览整页
  // 不遮（它的卡片就是右坞模块入口，2026-10 总览整页化）。
  assert.match(desktopShellSource, /\{!chromeHidden && panelWorkspace && \(/);
  // CSS：收起态 = 36px 纯 icon rail；展开态默认 = 最小宽 336（36 rail + 300
  // 面板，2026-10 用户反馈「默认收起 + 打开默认最小」）。
  assert.match(globalsCssSource, /\.right-panel-container\.right-panel-closed \{\s*\n\s*width: 36px;/);
  assert.match(globalsCssSource, /width: var\(--pi-right-panel-width, 336px\)/);
  assert.match(globalsCssSource, /min-width: 336px;/);
  assert.match(globalsCssSource, /\.dock-rail \{\s*\n\s*width: 36px;/);
  // rail 纯 icon（2026-10 用户反馈）：无文字标签类。
  assert.doesNotMatch(globalsCssSource, /\.dock-rail-icon-label/);
  assert.doesNotMatch(desktopShellSource, /dock-rail-icon-label/);
  // 缺省 = 收起：dockRailFor 兜底 expanded:false；持久化键 v2（一次性丢弃
  // 旧 expanded:true 偏好，否则默认收起对存量用户不可见）。
  assert.match(shellStateSource, /\|\| \{ module: FILES_TAB_ID, expanded: false \}/);
  assert.match(shellStateSource, /pi-dock-rail-v2/);
});

test("config center pages: four standalone pages with scoped rails (2026-09 配置页拆分)", () => {
  // CenterPage 值域 = settings/models/agents/plugins + archive（无 section ——
  // 页内分区走 settingsPage，不进 CenterPage 身份）。
  assert.match(shellStateSource, /export type CenterPage =/);
  assert.match(shellStateSource, /\| \{ kind: "settings" \}/);
  assert.match(shellStateSource, /\| \{ kind: "models" \}/);
  assert.match(shellStateSource, /\| \{ kind: "agents" \}/);
  assert.match(shellStateSource, /\| \{ kind: "plugins" \}/);
  assert.doesNotMatch(shellStateSource, /section\?: SettingsPage/);
  // 每页独立 hero 页头（ZCode 市场页同款：图标章 + 大标题 + 描述行）+ 分区
  // pills（仅多分区页）：设置 = 工作区/偏好，插件&技能 = 插件/技能——不再是
  // 全量六项大杂烩。
  assert.match(configCenterPageSource, /PAGE_TITLES/);
  assert.match(configCenterPageSource, /PAGE_DESCRIPTIONS/);
  assert.match(configCenterPageSource, /id: "workspace", label: "工作区"/);
  assert.match(configCenterPageSource, /id: "preferences", label: "偏好"/);
  assert.match(configCenterPageSource, /id: "plugins", label: "插件"/);
  assert.match(configCenterPageSource, /id: "skills", label: "技能"/);
  // 单分区页直接宿主对应 Config 组件；插件&技能页的插件/技能分区用 market
  // 布局（ZCode 市场同款：搜索 + 已安装卡片网格 + 添加区 + 详情弹窗）。
  assert.match(configCenterPageSource, /<ModelsConfig embedded/);
  assert.match(configCenterPageSource, /<AgentsConfig/);
  assert.match(configCenterPageSource, /<PluginsConfig[\s\S]*?market/);
  assert.match(configCenterPageSource, /<SkillsConfig[\s\S]*?market/);
  assert.match(pluginsConfigSource, /market\?: boolean/);
  assert.match(skillsConfigSource, /market\?: boolean/);
  // 市场卡片网格 + 搜索 + 已安装 section（两个组件共用同一套状态与操作）。
  assert.match(pluginsConfigSource, /PluginMarketCard/);
  assert.match(skillsConfigSource, /SkillMarketCard/);
  assert.match(pluginsConfigSource, /已安装/);
  assert.match(skillsConfigSource, /已安装/);
});

test("settings panel is mobile-only (index + push subpages); desktop two-column mode retired", () => {
  // desktop 两栏模式（DESKTOP_NAV_SECTIONS）退役：桌面配置面走 ConfigCenterPage
  // 独立整页，SettingsPanel 只服务移动端设置目的地页（全行索引 + 内嵌子页）。
  assert.doesNotMatch(settingsPanelSource, /desktop\?: boolean;/);
  assert.doesNotMatch(settingsPanelSource, /DESKTOP_NAV_SECTIONS/);
  // 移动端保留全行索引 + 内嵌子页（‹ 设置 返回）。
  assert.match(settingsPanelSource, /label="工作区"/);
  assert.match(settingsPanelSource, /label="归档"/);
  assert.match(settingsPanelSource, /backLabel: "设置"/);
  assert.match(settingsPanelSource, /<ModelsConfig embedded/);
  assert.doesNotMatch(settingsPanelSource, /onOpenConfigView/);
});

test("config trio: inline page mode replaces the three-column portal split", () => {
  for (const source of [modelsConfigSource, skillsConfigSource, pluginsConfigSource]) {
    assert.match(source, /inline\?: boolean;/);
    assert.doesNotMatch(source, /portalTarget/);
    assert.doesNotMatch(source, /if \(splitMode\) \{/);
  }
});

test("workspace overview dashboard surfaces work items and repositories (unchanged)", () => {
  assert.match(workspaceOverviewSource, /活跃工作项/);
  assert.match(workspaceOverviewSource, /onSwitchSidebarView/);
  assert.match(workspaceOverviewSource, /＋ 添加仓库/);
  assert.match(workspaceOverviewSource, /onSwitchSidebarView\("workbench"\)/);
});

test("home landing uses a dedicated mobile layout (workspace sheet + grouped recents)", () => {
  assert.match(homeLandingSource, /useIsMobile\(\)/);
  assert.match(homeLandingSource, /WorkspaceSheet/);
  assert.match(homeLandingSource, /HomeSessionGroups/);
});

test("disabled workspaces stay recoverable from every shell (2026-09 修复)", () => {
  // 已停用工作区从首页/选择器/树全部隐藏，但必须「找得回」：设置›工作区是
  // 唯一重启用面，所以每个 shell 都要有直达路径。
  // 移动端（抽屉重构后）：HomeLanding ⚙ 设置入口落设置目的地页；零可用
  // 工作区时主区仍渲染设置面板（重启用唯一入口不能断）。
  assert.match(homeLandingSource, /onOpenSettings: \(\) => void/);
  assert.match(mobileShellSource, /onOpenSettings=\{\(\) => setMobilePage\("settings"\)\}/);
  assert.match(mobileShellSource, /mobilePage === "settings" \? \(/);
  // 移动端 ⊞ 面板：已停用行暗淡可见（不再被 isWorkspaceSelectable 过滤掉），
  // 点击深链设置›工作区预选；全部停用时首页不掉进「创建第一个工作区」引导。
  assert.match(homeLandingSource, /workspace\.disabled \? \([\s\S]*?onOpenWorkspaceSettings/);
  assert.match(homeLandingSource, /hasWorkspaces = workspaces\.length > 0/);
  assert.doesNotMatch(homeLandingSource, /filter\(isWorkspaceSelectable\)/);
  // 已停用工作区「找得回」：WorkspaceSwitcherPanel 的暗淡行 + ⚙ 仍在组件里，但
  // 桌面入口 2026-10 已删——桌面重启用路径 = 侧栏底部 设置›工作区（全量列表）；
  // HomeLanding 零工作区态的停用行 ⚙ 仍直达设置预选。
  assert.match(workspaceSwitcherPanelSource, /!workspace\.available \|\| workspace\.disabled/);
  assert.match(workspaceSwitcherPanelSource, /onOpenWorkspaceSettings\?: \(workspace: WorkspaceSummary\) => void/);
  assert.match(desktopShellSource, /onOpenWorkspaceSettings=\{handleOpenWorkspaceSettings\}/);
  // 深链预选机制：共享状态 + WorkspaceManager 消费（nonce 可重复触发）。
  assert.match(shellStateSource, /requestWorkspaceSettings = useCallback/);
  assert.match(workspaceManagerSource, /selectWorkspaceRequest\?: \{ id: string; nonce: number \} \| null/);
  assert.match(
    workspaceManagerSource,
    /selectWorkspaceRequest[\s\S]*setSelectedWorkspaceId\(selectWorkspaceRequest\.id\)/,
  );
});

test("workspace switcher: manual order with drag sorting (2026-09; 2026-09-27 移入面板)", () => {
  // 工作区分组不按活跃度自动重排：保持传入列表序（= 手动排序），
  // 移动端首页「最近」保留默认 activity 序。侧栏瘦身后列表住切换面板。
  assert.match(projectSidebarSource, /groupSessionsByWorkspace\(workspaces, allSessions, \{ orderBy: "workspaces" \}\)/);
  assert.match(homeLandingSource, /groupSessionsByWorkspace\(workspaces, sessions\)/);
  // 面板内拖拽：drop 到行上 = 插到它前面/后面，列表尾空区 = 移到末位；PATCH 走
  // 全量期望序（隐藏项垫底——updateWorkspaceOrder 会删未提及条目的 sortOrder）。
  assert.match(workspaceSwitcherPanelSource, /onReorderWorkspaces\?: \(ids: string\[\]\) => void/);
  assert.match(workspaceSwitcherPanelSource, /moveDraggedWorkspace/);
  assert.match(desktopShellSource, /onReorderWorkspaces=\{handleReorderWorkspaces\}/);
  assert.match(shellStateSource, /handleReorderWorkspaces = useCallback/);
  assert.match(
    shellStateSource,
    /handleReorderWorkspaces[\s\S]*?method: "PATCH"[\s\S]*?order: ids/,
  );
  // 拖动反馈：插入指示线（上下半判定 before/after + 列表尾），
  // 入场动画 workspace-drop-line；拖动行半透明带过渡。面板与设置›工作区 rail 同构。
  assert.match(workspaceSwitcherPanelSource, /dropPositionOf/);
  assert.match(workspaceSwitcherPanelSource, /className="workspace-drop-line"/);
  assert.match(workspaceManagerSource, /railDropHint/);
  assert.match(workspaceManagerSource, /className="workspace-drop-line"/);
  assert.match(globalsCssSource, /@keyframes workspace-drop-line-in/);
  // 带工作区上下文的「设置」= 详情优先（2026-09 反馈）：深链预选触发
  // detailFocus，rail（全部工作区列表）收起，「‹ 全部工作区」返回；不带
  // 上下文的底部设置入口仍落全局列表。
  assert.match(workspaceManagerSource, /const \[detailFocus, setDetailFocus\] = useState\(false\)/);
  assert.match(workspaceManagerSource, /setDetailFocus\(true\)/);
  assert.match(workspaceManagerSource, /‹ 全部工作区/);
  // 总览整页（2026-10：WorkspaceOverview 宿主从家 tab 分支搬入 renderCenterPage，
  // workspace 绑定页面自己的 workspaceId）→ 工作区设置带上下文预选。
  assert.match(desktopShellSource, /onOpenSettings=\{\(\) => \{[\s\S]*?requestWorkspaceSettings\(workspace\)/);
  // 移动端：HomeLanding 停用行 ⚙ 深链（抽屉重构后 HomeLanding 只宿零工作区
  // 态，这正是重启用引导的主战场）。
  assert.match(mobileShellSource, /onOpenWorkspaceSettings=\{\(workspace\) => \{[\s\S]*?requestWorkspaceSettings\(workspace\)/);
  // 手机端停用行恢复路径 = HomeLanding 内联 ⚙（切换面板已撤，桌面走面板暗淡行）。
});

test("workspace settings and work items render as center pages", () => {
  assert.match(desktopShellSource, /<WorkspaceManager[\s\S]*embedded/);
  assert.match(workspaceManagerSource, /workspace-manager-page/);
  assert.match(workspaceManagerSource, /进入 Workspace/);
  assert.match(
    workspaceManagerSource,
    /openRepositoryFormRequest[\s\S]*setRepositoryFormOpen\(true\)/,
  );
});

test("deleting the active workspace returns to the home context", () => {
  assert.match(
    shellStateSource,
    /handleWorkspaceDeleted[\s\S]*?activateTab\(null\);\s*\n\s*navigateUrl\("tab=home"\)/,
  );
  assert.match(workspaceManagerSource, /onWorkspaceDeleted\?\.\(workspace\)/);
});

test("home skills use an explicit global context instead of the user home directory", () => {
  // SkillsConfig 的宿主从 DesktopShell 独立整页迁到设置页分区（2026-09
  // 两栏化）。2026-10 收敛：启停只有全局 frontmatter 一档（工作区白名单已
  // 拆除），workspace 锚定只剩 project 安装档位门控一个用途。
  assert.match(settingsPanelSource, /<SkillsConfig[\s\S]*?projectInstallAvailable=\{Boolean\(workspace\)\}/);
  assert.doesNotMatch(skillsConfigSource, /globalOnly/);
  assert.doesNotMatch(skillsConfigSource, /scope=global/);
});

test("workspace directory slug is derived from the complete name at submit time", () => {
  assert.match(workspaceManagerSource, /slug: slugify\(workspaceName\)/);
  assert.doesNotMatch(workspaceManagerSource, /const \[workspaceSlug,/);
  assert.doesNotMatch(workspaceManagerSource, />目录标识</);
});

test("overview is a center page, not a tab (2026-10 总览整页化，knowledge/designs/overview-center-page-design.md)", async () => {
  const sessionTabsSource = await readFile(new URL("../lib/session-tabs.ts", import.meta.url), "utf8");
  // D1：tab kind 只剩 session / new-session；总览是 CenterPage kind "overview"
  //（身份绑定 workspaceId）。家 tab 的工厂/id/分派函数随之退役。
  assert.match(sessionTabsSource, /export type SessionTabKind = "session" \| "new-session";/);
  assert.doesNotMatch(sessionTabsSource, /createHomeTab|homeTabId|resolveNewSessionTarget/);
  assert.match(shellStateSource, /\| \{ kind: "overview"; workspaceId: string \}/);
  assert.doesNotMatch(shellStateSource, /ensureHomeTab|workspace-home"/);
  // D3/D4：落总览 = activateTab(null) + centerPage overview + MRU 推工作区；
  // activeWorkspace 在总览打开时由页面反向提供（activeTab 空、activeWorkspace
  // 非空的唯一合法组合）。
  assert.match(shellStateSource, /const landOnOverview = useCallback\(\(workspace: WorkspaceSummary\) => \{[\s\S]*?activateTab\(null\);[\s\S]*?setCenterPage\(\{ kind: "overview", workspaceId: workspace\.id \}\);/);
  assert.match(shellStateSource, /const activeWorkspace = overviewWorkspace \?\? activeTab\?\.workspace \?\? null;/);
  // D5：深链 workspace=<id>[&view=overview] 落总览整页，URL 语法不变。
  assert.match(shellStateSource, /landOnOverview\(workspace\);\n  \}, \[workspaces, sessionActivity\.sessions, landOnOverview/);
  // D7/D8：开工作区 / 回总览 / 关最后一个 tab 都落总览整页；morph 分支退役，
  // 新建会话永远 openNewSessionTab。
  assert.match(shellStateSource, /const handleOpenWorkspace = useCallback\(\(workspace: WorkspaceSummary, options\?: \{ replace\?: boolean \}\) => \{\n    landOnOverview\(workspace\);/);
  assert.match(shellStateSource, /const handleWorkspaceNewSession = useCallback\(\(\) => \{\n    if \(!activeWorkspace\) return;\n    openNewSessionTab\(activeWorkspace\);/);
  // D10：删工作区时若正看它的总览 → 关页。
  assert.match(shellStateSource, /current\?\.kind === "overview" && current\.workspaceId === workspace\.id \? null : current/);
  // D2/D13：桌面 WorkspaceOverview 宿于 renderCenterPage 的 overview 分支；总览
  // 不遮 chrome（tab 条 / 右坞门控都用 chromeHidden）——单栏合并后 tab 条最左的
  // 工作区 chip 在总览态按活动 tab 样式高亮（aria-current="page"）。
  assert.match(desktopShellSource, /if \(page\.kind === "overview"\) \{[\s\S]*?<WorkspaceOverview[\s\S]*?key=\{workspace\.id\}/);
  assert.doesNotMatch(desktopShellSource, /workspace-home/);
  assert.match(desktopShellSource, /aria-current=\{overviewOpen \? "page" : undefined\}/);
  assert.match(desktopShellSource, /borderTop: overviewOpen \? "2px solid var\(--accent\)" : "2px solid transparent"/);
  // D12：tab 条无家 tab 标签/徽章分支，workspaceActivity prop 删除。
  assert.doesNotMatch(sessionTabBarSource, /workspace-home|workspaceActivity/);
  // D11：移动端 presence→destination：centerPage overview ⇒ ensureWorkspaceContext
  // + mobilePage overview + 清 centerPage。
  assert.match(mobileShellSource, /const overviewDeeplinkWorkspaceId = centerPage\?\.kind === "overview" \? centerPage\.workspaceId : null;/);
  assert.match(mobileShellSource, /ensureWorkspaceContext\(workspace\);\n      setMobilePage\("overview"\);\n    \}\n    setCenterPage\(null\);/);
});
