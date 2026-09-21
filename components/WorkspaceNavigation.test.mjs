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
  // 底部四入口：设置/模型/插件/Skills —— 顺序固定。
  const bottomBlock = projectSidebarSource.slice(
    projectSidebarSource.indexOf("BOTTOM_ENTRIES"),
    projectSidebarSource.indexOf("function loadCollapsed"),
  );
  const kinds = [...bottomBlock.matchAll(/kind: "(settings|models|skills|plugins)",/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ["settings", "models", "skills", "plugins"]);
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
  // 配置面全部走中央区整页（inline 模式，无 portal）。
  assert.doesNotMatch(desktopShellSource, /configPortalNode/);
  assert.match(desktopShellSource, /<ModelsConfig inline/);
  assert.match(desktopShellSource, /<SkillsConfig[\s\S]*?inline/);
  assert.match(desktopShellSource, /<PluginsConfig[\s\S]*?inline/);
  // 桌面 SessionTabBar 不传 onPickWorkspace（⊞ 退役）；设置经 SettingsPanel
  // desktop 模式（子页面板内推进航）。
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

test("settings panel: desktop center-page mode keeps 工作区/偏好 rows only", () => {
  // desktop 模式：模型/Skills/插件（侧栏底部四入口）与归档（项目树组尾）
  // 不在设置索引重复；移动端保留全行索引 + 内嵌子页。
  assert.match(settingsPanelSource, /desktop\?: boolean;/);
  assert.match(settingsPanelSource, /\{!desktop && \(/);
  assert.match(settingsPanelSource, /\{!desktop && onOpenArchive && \(/);
  // 子页面板内推进航（‹ 设置 返回）。
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
  assert.match(desktopShellSource, /<SkillsConfig[\s\S]*?globalOnly=\{!activeWorkspace\}/);
  assert.match(skillsConfigSource, /scope=global/);
  assert.match(skillsConfigSource, /globalOnly\?: boolean/);
});

test("workspace directory slug is derived from the complete name at submit time", () => {
  assert.match(workspaceManagerSource, /slug: slugify\(workspaceName\)/);
  assert.doesNotMatch(workspaceManagerSource, /const \[workspaceSlug,/);
  assert.doesNotMatch(workspaceManagerSource, />目录标识</);
});
