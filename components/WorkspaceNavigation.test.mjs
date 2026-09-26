import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 2026-09 树形侧栏改版（grill 共识）导航结构断言：
 * 左侧 = 单一项目树侧栏（新建任务 / 项目→会话 / 组尾归档 / 底部设置·模型·
 * 插件·Skills 四入口），图标栏 + 中栏面板双轨退役；配置面全部走中央区整页
 * （CenterPage），configPortalNode 三列 portal 机制退役；桌面 SessionTabBar
 * 的 ⊞ 工作区选择器退役（移动端保留）。移动端整体不动。
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

test("project sidebar: 新建任务 on top, tree body, 归档 footer per group, four bottom entries", () => {
  // 新建任务 = 上下文快速路径：工作区内开新占位 tab（**composer 控制行带
  // 工作区选择器**，改选 = 原地重定向 tab）；首页回首页 composer（同款选择器）；
  // 折叠由 ChatToolbar 的 ☰ 开关承担（不在侧栏内）。
  assert.match(projectSidebarSource, /新建任务/);
  assert.doesNotMatch(projectSidebarSource, /onCollapse/);
  assert.doesNotMatch(projectSidebarSource, /onNewSessionInWorkspace/);
  assert.match(desktopShellSource, /<WorkspaceSelector/);
  assert.match(desktopShellSource, /createNewSessionTab\(target, tab\.id\)/);
  // 树主体：分区标题「工作区」+ ＋（新建工作区/导入目录）+ groupSessionsByWorkspace。
  assert.match(projectSidebarSource, /工作区/);
  assert.doesNotMatch(projectSidebarSource, />项目</);
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
  // 底部五入口（2026-09 设置页两栏化后）：设置→工作区分区/模型/插件/Skills/
  // Agents —— 全部路由到设置页预选分区，顺序固定。
  const bottomBlock = projectSidebarSource.slice(
    projectSidebarSource.indexOf("BOTTOM_ENTRIES"),
    projectSidebarSource.indexOf("function loadCollapsed"),
  );
  const sections = [...bottomBlock.matchAll(/section: "(workspace|models|skills|plugins|agents)",/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["workspace", "models", "skills", "plugins", "agents"]);
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

test("session tab bar: ⊞ workspace picker optional (desktop drops it, mobile keeps it)", () => {
  assert.match(sessionTabBarSource, /onPickWorkspace\?: \(workspace: WorkspaceSummary\) => void/);
  assert.match(sessionTabBarSource, /\{onPickWorkspace && \(/);
  assert.match(mobileShellSource, /onPickWorkspace=\{handleOpenWorkspace\}/);
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
  // 移动端首页：⚙ 设置入口（底部 tab 栏只在工作区内渲染，首页没有它就断了）
  // + tab 切 settings 时主区渲染设置面板（× 回首页）。
  assert.match(homeLandingSource, /onOpenSettings: \(\) => void/);
  assert.match(mobileShellSource, /onOpenSettings=\{\(\) => setTab\("settings"\)\}/);
  assert.match(mobileShellSource, /tab === "settings" \? \(/);
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
