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
 * 2026-09 移动端树抽屉重构（docs/mobile-drawer-design.md）：底部 tab 栏、
 * 头部会话 chips 行、MobileSideRail、WorkspaceHomeMenu 全部退役——抽屉是
 * 唯一定期导航（ProjectSidebar：头部工作区切换块 + 当前工作区会话），聊天
 * 是主区默认，非聊天目的地是带 ‹返回（= 回聊天）的全屏页；≥768px 树常驻
 * 贴左。上下文规则「跟着屏幕走」由 ensureWorkspaceContext 实现。
 *
 * 2026-09-27 侧栏瘦身改版（grill 会话三）：侧边栏只剩「会话」——工作区树、
 * 模块行退役；工作区切换 + 模块入口（总览/文件/工作项/知识库/Loops）收进
 * 两端共用的 WorkspaceSwitcherPanel（桌面 = 32px 工作区工具行「工作区名 ▾」
 * 弹出；移动端 = 抽屉头部内联展开）。切工作区两端对齐 = 落该工作区总览
 * （桌面开家 tab；手机新增 mobilePage:"overview" 目的地）。
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
  // 行尾收起/展开 chevron（2026-09-27 晚）：收起整个项目列表（含归档行），
  // 持久化 pi-projects-collapsed，缺省展开。
  assert.match(projectSidebarSource, /pi-projects-collapsed/);
  assert.match(projectSidebarSource, /aria-expanded=\{!projectsCollapsed\}/);
  assert.match(projectSidebarSource, /\{!projectsCollapsed && \(</);
  assert.match(projectSidebarSource, /fontVariantNumeric: "tabular-nums"/);
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
  // 中央区整页打开时隐藏会话 tab 条，配置页占满中央区。
  assert.match(desktopShellSource, /\{!centerPage && \([\s\S]*?<SessionTabBar/);
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
  // 「首页」chip 桌面保留（showHomeTab，默认 true）；移动端整个 chips 行已删
  // （2026-09 树抽屉重构 Q4）——组件保留给桌面，MobileShell 不再渲染。
  assert.match(sessionTabBarSource, /showHomeTab\?: boolean;/);
  assert.match(sessionTabBarSource, /\{showHomeTab && \(/);
  assert.doesNotMatch(mobileShellSource, /<SessionTabBar/);
  assert.match(desktopShellSource, /<SessionTabBar/);
  // 空态自动落回：移动端给默认工作区开占位 composer 作上下文锚（replace 写
  // URL，防历史陷阱）；桌面落家 tab。关最后一个 tab 不落空态。
  assert.match(mobileShellSource, /defaultHomeNewSessionWorkspaceId/);
  assert.match(mobileShellSource, /openNewSessionTab\(target, \{ replace: true \}\)/);
  assert.match(desktopShellSource, /showHomeTab=\{false\}/);
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

test("mobile shell: drawer-only navigation (2026-09 树抽屉重构)", () => {
  // 底部 tab 栏 / MobileSideRail / WorkspaceHomeMenu / 键盘隐藏规则全部退役。
  assert.doesNotMatch(mobileShellSource, /mobile-bottom-tabbar/);
  assert.doesNotMatch(mobileShellSource, /MobileSideRail/);
  assert.doesNotMatch(mobileShellSource, /WorkspaceHomeMenu/);
  assert.doesNotMatch(globalsCssSource, /mobile-bottom-tabbar/);
  assert.doesNotMatch(globalsCssSource, /pi-mobile-tab/);
  // 抽屉 = scrim + 滑入面板，宿主 ProjectSidebar（头部工作区切换块 + 当前
  // 工作区会话，2026-09-27 瘦身）；☰ 在 ChatToolbar 上（桌面切侧栏、手机切
  // 抽屉，手机带后台状态圆点）。
  assert.match(mobileShellSource, /mobile-nav-drawer/);
  assert.match(mobileShellSource, /mobile-nav-scrim/);
  assert.match(mobileShellSource, /<ProjectSidebar/);
  assert.doesNotMatch(mobileShellSource, /showModuleRows/);
  assert.match(mobileShellSource, /headerSlot: mobileSwitcherSlot/);
  assert.match(globalsCssSource, /@keyframes pi-nav-drawer-in/);
  // ≥768px 同一棵树常驻贴左（推挤内容，不覆盖）。
  assert.match(mobileShellSource, /showPermanentTree/);
  assert.match(mobileShellSource, /useMediaQuery\("\(min-width: 768px\)"\)/);
  // 扁平目的地页（Q5）：‹返回永远 = 回聊天；无历史栈。
  assert.match(mobileShellSource, /type MobilePage =/);
  assert.match(mobileShellSource, /backLabel="聊天"/);
  // 上下文规则（Q7「跟着屏幕走」）：ensureWorkspaceContext 纯状态锚定，
  // 不 focusChat（否则会误关目的地页）。
  assert.match(shellStateSource, /ensureWorkspaceContext = useCallback/);
  assert.match(shellStateSource, /不 focusChat/);
  assert.match(mobileShellSource, /ensureWorkspaceContext\(workspace\)/);
  // ☰ 状态圆点（Q4）：后台运行 accent 点 / 完成未看次级点。
  assert.match(shellStateSource, /mobileNavOpen/);
  assert.match(mobileShellSource, /setMobileNavOpen/);
});

test("sidebar slim-down: switcher panel on both shells; switch = land on overview (2026-09-27)", () => {
  // 桌面：32px 工作区工具行 = 「工作区名 ▾」切换器（WorkspaceSwitcherPanel
  // 弹出，点外部关闭）+ 总览/文件 两个高频平铺捷径；工作项/知识库/Loops 收进
  // 面板（dock 开合语义）。侧栏只吃 activeWorkspace（当前工作区会话）。
  assert.match(desktopShellSource, /switcherOpen/);
  assert.match(desktopShellSource, /<WorkspaceSwitcherPanel/);
  assert.match(desktopShellSource, /toggleDockModule\(FILES_TAB_ID\)/);
  assert.match(desktopShellSource, /activeWorkspace=\{activeWorkspace\}/);
  assert.doesNotMatch(desktopShellSource, /onOpenWorkspace=\{handleOpenWorkspace\}\s*\n\s*onOpenArchive/);
  // 移动端：抽屉/常驻树头部 headerSlot 注入切换块；面板模块入口 = 目的地页
  // 语义（active 高亮跟 mobilePage）；工作区列表点击 = handleNavSwitchWorkspace。
  assert.match(mobileShellSource, /headerSlot: mobileSwitcherSlot/);
  // 2026-09-27 晚：手机端工作区切换器撤下（分组清单已列全部项目，点会话即切
  // 上下文）——WorkspaceSwitcherPanel 只留桌面；模块入口保留为抽屉头部紧凑
  // 模块条（总览/文件/工作项/知识库/Loops，作用于当前工作区）。
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
  // 桌面项目树（2026-09-27 瘦身后 = WorkspaceSwitcherPanel）：已停用工作区
  // 暗淡行收进面板底部，⚙ 直达设置›工作区。
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
  assert.match(desktopShellSource, /onOpenSettings=\{\(\) => \{[\s\S]*?requestWorkspaceSettings\(activeTab\.workspace\)/);
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
  // 两栏化），globalOnly 语义不变：无活动工作区 = 全局作用域。
  assert.match(settingsPanelSource, /<SkillsConfig[\s\S]*?globalOnly=\{!workspace\}/);
  assert.match(skillsConfigSource, /scope=global/);
  assert.match(skillsConfigSource, /globalOnly\?: boolean/);
});

test("workspace directory slug is derived from the complete name at submit time", () => {
  assert.match(workspaceManagerSource, /slug: slugify\(workspaceName\)/);
  assert.doesNotMatch(workspaceManagerSource, /const \[workspaceSlug,/);
  assert.doesNotMatch(workspaceManagerSource, />目录标识</);
});
