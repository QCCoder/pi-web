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

test("workspace selection opens an overview instead of implicitly creating a chat", () => {
  assert.match(
    appShellSource,
    /directoryMode && selectedSession === null && activeCwd/,
  );
  assert.match(
    appShellSource,
    /setWorkspaceView\("overview"\)[\s\S]*setNewSessionCwd\(null\)/,
  );
  assert.match(appShellSource, /workspace=\$\{encodeURIComponent\(workspace\.id\)\}/);
});

test("workspace sidebar exposes persistent collaboration navigation", () => {
  for (const label of ["会话", "工作项", "仓库", "Explorer"]) {
    assert.match(workspaceSidebarSource, new RegExp(`label="${label}"`));
  }
  assert.match(workspaceSidebarSource, /＋ 新建会话/);
  assert.match(workspaceSidebarSource, /模型：全局 · Skills \/ 插件：/);
  assert.match(
    workspaceSidebarSource,
    /label="仓库"[\s\S]*action=\{onAddRepository\}[\s\S]*actionLabel="添加仓库"/,
  );
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

test("mobile workspace navigation has only the three primary destinations", () => {
  assert.match(appShellSource, /gridTemplateColumns: "repeat\(3, 1fr\)"/);
  for (const label of ["工作项", "会话", "Explorer"]) {
    assert.match(appShellSource, new RegExp(`label: "${label}"`));
  }
  assert.doesNotMatch(appShellSource, /label: "更多"/);
});

test("home skills use an explicit global context instead of the user home directory", () => {
  assert.match(appShellSource, /<SkillsConfig[\s\S]*globalOnly=\{!activeWorkspace && !directoryMode\}/);
  assert.match(skillsConfigSource, /scope=global/);
  assert.match(skillsConfigSource, /globalOnly\?: boolean/);
});
