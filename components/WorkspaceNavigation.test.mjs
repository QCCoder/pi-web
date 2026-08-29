import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(
  new URL("./AppShell.tsx", import.meta.url),
  "utf8",
);
const activityBarSource = await readFile(
  new URL("./ActivityBar.tsx", import.meta.url),
  "utf8",
);
const workspaceSidebarSource = await readFile(
  new URL("./WorkspaceSidebar.tsx", import.meta.url),
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
const settingsPanelSource = await readFile(
  new URL("./SettingsPanel.tsx", import.meta.url),
  "utf8",
);

test("workspace selection always lands on the unconditional overview dashboard", () => {
  // The overview capability is retired — no capability check picks the view.
  assert.doesNotMatch(appShellSource, /capabilities\.includes\("overview"\)/);
  assert.match(appShellSource, /view: "overview",/);
  assert.match(appShellSource, /workspace=\$\{encodeURIComponent\(workspace\.id\)\}/);
  assert.doesNotMatch(appShellSource, /directoryMode|requestedCwd/);
});

test("activity bar order is 工作台 → 知识库 → 工作项 (standalone 仓库/Loop views removed)", () => {
  // The MODULE group only — the config/archive/settings defs live outside
  // ACTIVITY_VIEW_ORDER (slice up to the first config-view def).
  const orderBlock = activityBarSource.slice(
    activityBarSource.indexOf("ACTIVITY_VIEW_ORDER"),
    activityBarSource.indexOf("RAIL_GLOBAL_VIEWS"),
  );
  const views = [...orderBlock.matchAll(/view: "([a-z-]+)",/g)].map((m) => m[1]);
  assert.deepEqual(views, ["workbench", "knowledge", "work-items"]);
  // workbench is always-on (capability: null) and labeled 工作台.
  assert.match(activityBarSource, /view: "workbench",\s*capability: null,\s*label: "工作台"/);
});

test("desktop rail gains 模型/Skills/插件 config icons; their content renders in the RIGHT column", () => {
  // Rail global order (vertical): models → skills → plugins → archive → settings.
  assert.match(
    activityBarSource,
    /RAIL_GLOBAL_VIEWS: SidebarView\[\] = \[\s*"models",\s*"skills",\s*"plugins",\s*"archive",\s*"settings",\s*\]/,
  );
  // The vertical rail's global group: config trio + workspace-gated archive + settings.
  assert.match(
    activityBarSource,
    /MODELS_VIEW,\s*SKILLS_VIEW,\s*PLUGINS_VIEW,\s*\.\.\.\(hasWorkspace \? \[ARCHIVE_VIEW\] : \[\]\),\s*SETTINGS_VIEW/,
  );
  // The mobile bottom bar keeps 5 tabs — settings is its ONLY global icon
  // (configs stay in the settings index subpages on mobile).
  assert.match(activityBarSource, /: \[SETTINGS_VIEW\];/);
  // Persistence/validation surface is UNCHANGED: config views are right-column
  // content, never restorable as a middle-column sidebarView.
  assert.match(activityBarSource, /GLOBAL_ACTIVITY_VIEWS: SidebarView\[\] = \["archive", "settings"\]/);
  assert.doesNotMatch(activityBarSource, /concat\(RAIL_GLOBAL_VIEWS\)/);
  assert.match(activityBarSource, /export function isConfigView\(view: SidebarView\): view is ConfigView/);
  // AppShell: configView state (session-only), rail highlight precedence, and
  // the desktop-only right-column branch that precedes overview/chat (the
  // settings › 工作区 split view rides the same branch — see its own test).
  assert.match(appShellSource, /const \[configView, setConfigView\] = useState<ConfigView \| null>\(null\)/);
  assert.match(appShellSource, /activeView=\{configView \?\? sidebarView\}/);
  assert.match(
    appShellSource,
    /\{!isMobile && \(configView \|\| \(sidebarView === "settings" && settingsPage !== "index"\)\) \? \(/,
  );
  assert.match(appShellSource, /isConfigView\(view\)/);
  // Reset on workspace switch — config views are session-only.
  assert.match(appShellSource, /setConfigView\(null\);\s*\n\s*if \(!activeWorkspace\)/);
});

test("workspace sidebar renders the merged workbench view with collapsible sections", () => {
  // The workbench view stacks 会话 above 文件 (work-items/knowledge are their
  // own rail views now, not workbench sections).
  for (const label of ["会话", "文件"]) {
    assert.match(workspaceSidebarSource, new RegExp(`label="${label}"`));
  }
  assert.match(workspaceSidebarSource, /＋ 新建会话/);
  // The standalone 仓库 view is gone — only its capability fetch gate remains.
  assert.doesNotMatch(workspaceSidebarSource, /case "repositories":/);
  assert.match(workspaceSidebarSource, /hasCapability\("repositories"\)/);
  assert.match(workspaceSidebarSource, /导入目录…/);
  // Workbench section collapse state persists per workspace, parsed defensively.
  assert.match(workspaceSidebarSource, /pi-workbench-sections:/);
  // The sidebar view is CONTROLLED from AppShell (lifted state).
  assert.match(workspaceSidebarSource, /activeView: SidebarView;/);
});

test("workspace overview dashboard surfaces work items and repositories", () => {
  assert.match(workspaceOverviewSource, /活跃工作项/);
  assert.match(workspaceOverviewSource, /onSwitchSidebarView/);
  // The loop-kit teardown removed the Loop section and its trigger/manage actions.
  assert.doesNotMatch(workspaceOverviewSource, /Loop 动态|onTriggerLoop|onOpenLoops/);
  // The 3-card stat strip is gone (replaced by richer sections).
  assert.doesNotMatch(workspaceOverviewSource, /StatCard/);
  // The removed 仓库 sidebar view's add/manage entry lives here now: repo rows
  // open the workbench file tree, the header carries the add-repository form.
  assert.match(workspaceOverviewSource, /＋ 添加仓库/);
  assert.match(workspaceOverviewSource, /onSwitchSidebarView\("workbench"\)/);
});

test("home landing uses a dedicated mobile two-zone layout", () => {
  assert.match(homeLandingSource, /useIsMobile\(\)/);
  assert.match(homeLandingSource, /WorkspaceChip/);
});

test("workspace settings and work items render as center pages", () => {
  assert.match(appShellSource, /<WorkspaceManager[\s\S]*embedded/);
  assert.match(workspaceManagerSource, /workspace-manager-page/);
  assert.match(workspaceManagerSource, /进入 Workspace/);
  assert.match(
    workspaceManagerSource,
    /openRepositoryFormRequest[\s\S]*setRepositoryFormOpen\(true\)/,
  );
});

test("deleting the active workspace returns to the home context", () => {
  assert.match(
    appShellSource,
    /handleWorkspaceDeleted[\s\S]*handleCloseWorkspaceTab\(workspace\.id\)/,
  );
  assert.match(appShellSource, /activateTab\(null\);\s*navigateUrl\("tab=home"\)/);
  assert.match(workspaceManagerSource, /onWorkspaceDeleted\?\.\(workspace\)/);
});

test("mobile navigation is the horizontal Activity Bar variant (no bespoke items)", () => {
  assert.doesNotMatch(appShellSource, /mobileNavigationItems/);
  // Both ActivityBar variants render in AppShell: the desktop vertical rail
  // and the mobile horizontal bottom bar.
  assert.match(appShellSource, /variant="vertical"/);
  assert.match(appShellSource, /variant="horizontal"/);
  assert.match(activityBarSource, /variant: "vertical" \| "horizontal"/);
});

test("desktop config views split into middle-column list + right-column detail (portal)", () => {
  // Each config component gains a `split` mode: the list pane renders inline
  // (middle column) and the detail/footer portal into the right column.
  for (const source of [modelsConfigSource, skillsConfigSource, pluginsConfigSource]) {
    assert.match(source, /split\?: \{ portalTarget: HTMLElement \| null \}/);
    assert.match(source, /createPortal\(/);
    assert.match(source, /if \(splitMode\) \{/);
  }
  // AppShell owns the portal target: the right column renders the target div
  // (callback ref → state) and the middle column passes it to the split panel.
  assert.match(appShellSource, /const \[configPortalNode, setConfigPortalNode\]/);
  assert.match(appShellSource, /ref=\{setConfigPortalNode\}/);
  assert.match(appShellSource, /split=\{\{ portalTarget: configPortalNode \}\}/);
  // Opening a config view also opens the middle column (its list lives there).
  assert.match(appShellSource, /handleOpenConfig[\s\S]*?setSidebarOpen\(true\)/);
  // Any panel switch hands the middle column back from the config list.
  assert.match(appShellSource, /setConfigView\(null\);\s*\n\s*setSidebarView\(view\)/);
});

test("desktop settings › 工作区 splits into middle-column list + right-column detail (portal)", () => {
  // WorkspaceManager gains the config components' `split` mode: the workspace
  // LIST (rail) stays in the middle column while the selected workspace's
  // settings DETAIL portals into the right column's config area. One instance
  // keeps all state (selection, drafts, save flow) — only the layout splits.
  assert.match(workspaceManagerSource, /split\?: \{ portalTarget: HTMLElement \| null \}/);
  assert.match(workspaceManagerSource, /import \{ createPortal \} from "react-dom";/);
  assert.match(workspaceManagerSource, /createPortal\(contentPane, portalTarget\)/);
  // AppShell wires it: the settings workspaceSlot keeps `panel` only on mobile
  // (the desktop split needs the rail visible) and passes split on desktop
  // only — mobile renders the single-column panel subpage unchanged.
  assert.match(appShellSource, /panel=\{isMobile\}/);
  assert.match(appShellSource, /split=\{isMobile \? undefined : \{ portalTarget: configPortalNode \}\}/);
  assert.match(appShellSource, /onSelectedWorkspaceChange=\{handleWorkspaceSettingsSelection\}/);
  // The right column hosts the portal container for the workspace-settings
  // case too (configView takes precedence when both apply) — its × returns to
  // the settings index.
  assert.match(
    appShellSource,
    /\{!isMobile && \(configView \|\| \(sidebarView === "settings" && settingsPage !== "index"\)\) \? \(/,
  );
  assert.match(appShellSource, /title="工作区设置"/);
  assert.match(appShellSource, /onClose=\{\(\) => setSettingsPage\("index"\)\}/);
});

test("home skills use an explicit global context instead of the user home directory", () => {
  assert.match(appShellSource, /<SkillsConfig[\s\S]*globalOnly=\{!activeWorkspace\}/);
  assert.match(skillsConfigSource, /scope=global/);
  assert.match(skillsConfigSource, /globalOnly\?: boolean/);
});

test("settings index hides 模型/Skills/插件 rows on desktop (rail icons are the entry); mobile keeps subpages", () => {
  assert.match(
    settingsPanelSource,
    /onOpenConfigView\?: \(view: "models" \| "skills" \| "plugins"\) => void/,
  );
  // Desktop (onOpenConfigView provided): the three rows are REMOVED from the
  // settings index — rail icons are the entry; mobile keeps them as subpages.
  assert.match(settingsPanelSource, /\{!onOpenConfigView && \(/);
  for (const page of ["models", "skills", "plugins"]) {
    assert.match(settingsPanelSource, new RegExp(`onPageChange\\("${page}"\\)`));
  }
  // AppShell passes the handler on desktop only — mobile keeps subpages.
  assert.match(appShellSource, /onOpenConfigView=\{isMobile \? undefined : handleOpenConfig\}/);
});

test("workspace directory slug is derived from the complete name at submit time", () => {
  assert.match(workspaceManagerSource, /slug: slugify\(workspaceName\)/);
  assert.doesNotMatch(workspaceManagerSource, /const \[workspaceSlug,/);
  assert.doesNotMatch(workspaceManagerSource, />目录标识</);
});
