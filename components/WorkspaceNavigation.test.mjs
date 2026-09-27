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
 * 2026-09 移动端树抽屉重构（docs/mobile-drawer-design.md）：底部 tab 栏、
 * 头部会话 chips 行、MobileSideRail、WorkspaceHomeMenu 全部退役——抽屉是
 * 唯一定期导航（ProjectSidebar 移动变体：模块行 + 节点常显 ＋/🗑），聊天
 * 是主区默认，非聊天目的地是带 ‹返回（= 回聊天）的全屏页；≥768px 树常驻
 * 贴左。上下文规则「跟着屏幕走」由 ensureWorkspaceContext 实现。
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

test("project sidebar: ZCode-style nav rows on top, project tree body, archive per group, three bottom entries", () => {
  // 顶部三行导航（ZCode 风格安静行）：新建任务 ⌘N / 搜索 ⌘K / 插件&技能。
  // 新建任务 = 上下文快速路径：工作区内开新占位 tab（**composer 控制行带
  // 工作区选择器**，改选 = 原地重定向 tab）；首页回首页 composer（同款选择器）；
  // 折叠由 ChatToolbar 的 ☰ 开关承担（不在侧栏内）。⌘/Ctrl+N·K 全局快捷键。
  // 搜索 = 弹框（SearchPalette 命令面板，2026-09 用户反馈「搜索我也想可以做个
  // 弹框」），内联搜索输入框与 SessionSearch 包裹机制退役。
  assert.match(projectSidebarSource, /新建任务/);
  assert.match(projectSidebarSource, /label="搜索"/);
  assert.match(projectSidebarSource, /插件&技能/);
  assert.match(projectSidebarSource, /function NavRow/);
  assert.match(projectSidebarSource, /"k"/);
  assert.match(projectSidebarSource, /<SearchPalette/);
  assert.match(projectSidebarSource, /onSelectSession=\{onSelectSearchHit\}/);
  assert.doesNotMatch(projectSidebarSource, /<SessionSearch/);
  assert.doesNotMatch(projectSidebarSource, /session-search-input/);
  assert.doesNotMatch(projectSidebarSource, /onCollapse/);
  assert.match(desktopShellSource, /<WorkspaceSelector/);
  assert.match(desktopShellSource, /createNewSessionTab\(target, tab\.id\)/);
  // 移动端抽屉变体（2026-09 树抽屉重构 §3）：展开的工作区节点下渲染模块行
  // （文件/工作项/知识库/Loops，capability 门控），节点快捷动作从 hover
  // 🏠/🗑 换为常显 ＋（工作区内新建）/🗑（归档）——触屏无 hover。桌面不传
  // showModuleRows，零改动。
  assert.match(projectSidebarSource, /showModuleRows\?: boolean/);
  assert.match(projectSidebarSource, /onOpenModule\?:/);
  assert.match(projectSidebarSource, /onNewSessionInWorkspace\?:/);
  assert.match(projectSidebarSource, /function ModuleRow/);
  assert.match(projectSidebarSource, /mobileActions\?:/);
  // 树主体：分区标题「项目」（ZCode 同名心智）+ ＋（新建工作区/导入目录）+
  // groupSessionsByWorkspace。
  assert.match(projectSidebarSource, />项目</);
  assert.match(projectSidebarSource, /新建工作区…/);
  assert.match(projectSidebarSource, /导入目录…/);
  assert.match(projectSidebarSource, /groupSessionsByWorkspace/);
  // 会话行直挂节点下（SessionRow 共享，rounded）+ 默认 5 条截断 + 显示更多。
  // 节点整行 = 展开/折叠；hover 右侧出 工作区首页/归档 快捷按钮
  // （WorkspaceNodeRow；不再单独挂组尾归档行）。
  assert.match(projectSidebarSource, /SessionRow/);
  assert.match(projectSidebarSource, /WorkspaceNodeRow/);
  assert.match(projectSidebarSource, /onOpenWorkspace/);
  assert.match(projectSidebarSource, /onOpenArchive/);
  assert.match(projectSidebarSource, /SESSION_PREVIEW_COUNT = 5/);
  assert.match(projectSidebarSource, /显示更多/);
  // 组尾暗淡「归档」。
  assert.match(projectSidebarSource, /onOpenArchive/);
  // 底部三入口（2026-09 ZCode 风格导航改版）：设置→工作区分区/模型/Agents ——
  // 插件/Skills 上移为顶部「插件&技能」导航行（设置页预选插件分区）；全部
  // 路由到设置页预选分区，顺序固定。
  const bottomBlock = projectSidebarSource.slice(
    projectSidebarSource.indexOf("BOTTOM_ENTRIES"),
    projectSidebarSource.indexOf("function loadCollapsed"),
  );
  const sections = [...bottomBlock.matchAll(/section: "(workspace|models|skills|plugins|agents)",/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["workspace", "models", "agents"]);
  assert.match(projectSidebarSource, /onOpenCenterPage\(\{ kind: "settings", section: entry.section \}\)/);
  // 折叠持久化 + 骨架门控（未加载不渲染假空态）。
  assert.match(projectSidebarSource, /pi-tree-collapsed/);
  assert.match(projectSidebarSource, /workspacesLoaded \|\| !sessionsLoaded/);
});

test("desktop shell: single tree sidebar, no icon rail; center pages precede overview/chat", () => {
  // 图标栏退役：不再渲染 ActivityBar；中栏机制（renderMiddleColumn）由
  // ProjectSidebar 常驻取代。
  assert.doesNotMatch(desktopShellSource, /ActivityBar/);
  assert.match(desktopShellSource, /<ProjectSidebar/);
  assert.doesNotMatch(desktopShellSource, /renderMiddleColumn/);
  // 中央区整页分支优先于 总览/聊天：点任何会话 tab 即回。
  assert.match(desktopShellSource, /centerPage \? renderCenterPage\(\)/);
  // 配置面收敛（2026-09 设置页两栏化）：模型/Skills/插件/Agents 不再是独立
  // 整页——DesktopShell 不再直接渲染四个 Config 组件，它们住进设置页分区
  // （SettingsPanel desktop 模式）。
  assert.doesNotMatch(desktopShellSource, /configPortalNode/);
  assert.doesNotMatch(desktopShellSource, /<ModelsConfig/);
  assert.doesNotMatch(desktopShellSource, /<SkillsConfig/);
  assert.doesNotMatch(desktopShellSource, /<PluginsConfig/);
  assert.doesNotMatch(desktopShellSource, /<AgentsConfig/);
  // 桌面 SessionTabBar 不传 onPickWorkspace（⊞ 退役）；设置经 SettingsPanel
  // desktop 模式（左索引列 + 右分区内容，无板内推跳）。
  assert.doesNotMatch(desktopShellSource, /onPickWorkspace/);
  assert.match(desktopShellSource, /<SettingsPanel[\s\S]*?desktop/);
  assert.match(desktopShellSource, /split=\{\{ inline: true \}\}/);
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
  // 抽屉 = scrim + 滑入面板，宿主 ProjectSidebar 移动变体（模块行）；☰ 在
  // ChatToolbar 上（桌面切侧栏、手机切抽屉，手机带后台状态圆点）。
  assert.match(mobileShellSource, /mobile-nav-drawer/);
  assert.match(mobileShellSource, /mobile-nav-scrim/);
  assert.match(mobileShellSource, /<ProjectSidebar/);
  assert.match(mobileShellSource, /showModuleRows: true/);
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

test("settings panel: desktop two-column (left nav + right section), mobile keeps index + push subpages", () => {
  // desktop 模式（2026-09 两栏化）：左索引列常驻（工作区/模型/Skills/插件/
  // Agents/偏好），无索引页无板内推跳；模型等分区内容住进设置页。
  assert.match(settingsPanelSource, /desktop\?: boolean;/);
  assert.match(settingsPanelSource, /DESKTOP_NAV_SECTIONS/);
  assert.match(settingsPanelSource, /id: "workspace", label: "工作区"/);
  assert.match(settingsPanelSource, /id: "agents", label: "Agents"/);
  assert.match(settingsPanelSource, /<ModelsConfig embedded/);
  // 移动端保留全行索引 + 内嵌子页（‹ 设置 返回）。
  assert.match(settingsPanelSource, /label="工作区"/);
  assert.match(settingsPanelSource, /label="归档"/);
  assert.match(settingsPanelSource, /backLabel: "设置"/);
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
  // 桌面项目树：树底暗淡行包含已停用工作区，hover ⚙ 直达设置›工作区。
  assert.match(projectSidebarSource, /!workspace\.available \|\| workspace\.disabled/);
  assert.match(projectSidebarSource, /onOpenWorkspaceSettings/);
  assert.match(desktopShellSource, /onOpenWorkspaceSettings=\{handleOpenWorkspaceSettings\}/);
  // 深链预选机制：共享状态 + WorkspaceManager 消费（nonce 可重复触发）。
  assert.match(shellStateSource, /requestWorkspaceSettings = useCallback/);
  assert.match(workspaceManagerSource, /selectWorkspaceRequest\?: \{ id: string; nonce: number \} \| null/);
  assert.match(
    workspaceManagerSource,
    /selectWorkspaceRequest[\s\S]*setSelectedWorkspaceId\(selectWorkspaceRequest\.id\)/,
  );
});

test("project tree: manual workspace order with in-tree drag sorting (2026-09)", () => {
  // 树的工作区分组不按活跃度自动重排：保持传入列表序（= 手动排序），
  // 移动端首页「最近」保留默认 activity 序。
  assert.match(projectSidebarSource, /groupSessionsByWorkspace\(workspaces, allSessions, \{ orderBy: "workspaces" \}\)/);
  assert.match(homeLandingSource, /groupSessionsByWorkspace\(workspaces, sessions\)/);
  // 树内拖拽：drop 到节点上 = 插到它前面，列表尾空区 = 移到末位；PATCH 走
  // 全量期望序（隐藏项垫底——updateWorkspaceOrder 会删未提及条目的 sortOrder）。
  assert.match(projectSidebarSource, /onReorderWorkspaces\?: \(ids: string\[\]\) => void/);
  assert.match(projectSidebarSource, /moveDraggedWorkspace/);
  assert.match(projectSidebarSource, /draggable=\{reorderable \? true : undefined\}/);
  assert.match(desktopShellSource, /onReorderWorkspaces=\{handleReorderWorkspaces\}/);
  assert.match(shellStateSource, /handleReorderWorkspaces = useCallback/);
  assert.match(
    shellStateSource,
    /handleReorderWorkspaces[\s\S]*?method: "PATCH"[\s\S]*?order: ids/,
  );
  // 拖动反馈（2026-09）：插入指示线（上下半判定 before/after + 列表尾），
  // 入场动画 workspace-drop-line；拖动行半透明带过渡。树与设置›工作区 rail 同构。
  assert.match(projectSidebarSource, /dropPositionOf/);
  assert.match(projectSidebarSource, /className="workspace-drop-line"/);
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
  // 抽屉树底暗淡行 ⚙（同桌面同构，ProjectSidebar 复用即得）。
  assert.match(mobileShellSource, /onOpenWorkspaceSettings: handleNavWorkspaceSettings/);
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
