import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(
  new URL("./AppShell.tsx", import.meta.url),
  "utf8",
);
const workspaceSidebarSource = await readFile(
  new URL("./WorkspaceSidebar.tsx", import.meta.url),
  "utf8",
);
const workspaceManagerSource = await readFile(
  new URL("./WorkspaceManager.tsx", import.meta.url),
  "utf8",
);
const skillsConfigSource = await readFile(
  new URL("./SkillsConfig.tsx", import.meta.url),
  "utf8",
);

test("workspace selection uses template capabilities to choose its landing view", () => {
  assert.match(
    appShellSource,
    /const hasOverview = workspace\.capabilities\.includes\("overview"\)[\s\S]*setWorkspaceView\(hasOverview \? "overview" : "chat"\)/,
  );
  assert.match(appShellSource, /workspace=\$\{encodeURIComponent\(workspace\.id\)\}/);
  assert.doesNotMatch(appShellSource, /directoryMode|requestedCwd/);
});

test("workspace sidebar renders navigation from template capabilities", () => {
  for (const label of ["会话", "工作项", "仓库", "Explorer"]) {
    assert.match(workspaceSidebarSource, new RegExp(`label="${label}"`));
  }
  assert.match(workspaceSidebarSource, /＋ 新建会话/);
  assert.match(workspaceSidebarSource, /模型：全局 · Skills \/ 插件：/);
  assert.match(
    workspaceSidebarSource,
    /label="仓库"[\s\S]*action=\{onAddRepository\}[\s\S]*actionLabel="添加仓库"/,
  );
  assert.match(workspaceSidebarSource, /hasCapability\("work-items"\)/);
  assert.match(workspaceSidebarSource, /hasCapability\("repositories"\)/);
  assert.match(workspaceSidebarSource, /导入目录…/);
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
    /activeWorkspace\?\.id === workspace\.id[\s\S]*handleReturnHome\(\)/,
  );
  assert.match(workspaceManagerSource, /onWorkspaceDeleted\?\.\(workspace\)/);
});

test("mobile workspace navigation follows template capabilities", () => {
  assert.match(appShellSource, /mobileNavigationItems/);
  assert.match(appShellSource, /capabilities\.includes\("work-items"\)/);
  for (const label of ["工作项", "会话", "Explorer"]) {
    assert.match(appShellSource, new RegExp(`label: "${label}"`));
  }
  assert.doesNotMatch(appShellSource, /label: "更多"/);
});

test("home skills use an explicit global context instead of the user home directory", () => {
  assert.match(appShellSource, /<SkillsConfig[\s\S]*globalOnly=\{!activeWorkspace\}/);
  assert.match(skillsConfigSource, /scope=global/);
  assert.match(skillsConfigSource, /globalOnly\?: boolean/);
});

test("workspace directory slug is derived from the complete name at submit time", () => {
  assert.match(workspaceManagerSource, /slug: slugify\(workspaceName\)/);
  assert.doesNotMatch(workspaceManagerSource, /const \[workspaceSlug,/);
  assert.doesNotMatch(workspaceManagerSource, />目录标识</);
});
