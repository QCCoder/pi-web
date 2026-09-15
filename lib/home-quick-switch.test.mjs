import test from "node:test";
import assert from "node:assert/strict";

function ws(id, name, path, available = true, disabled = false) {
  return { id, name, path, available, disabled, capabilities: [], repositoryCount: 0, skills: [] };
}
function sess(id, cwd, modified, extra = {}) {
  return { path: `/${id}.jsonl`, id, cwd, created: modified, modified, messageCount: 1, firstMessage: "", ...extra };
}

test("disabled workspaces are invisible on home surfaces (selection predicate)", async () => {
  const { workspaceForSession, groupSessionsByWorkspace, defaultHomeNewSessionWorkspaceId } = await import("./home-quick-switch.ts");
  const { isWorkspaceSelectable } = await import("./workspaces/types.ts");
  const a = ws("a", "A", "/w/a");
  const paused = ws("p", "P", "/w/p", true, true); // 用户停用（目录仍健康）
  const off = ws("o", "O", "/w/off", false);
  assert.equal(isWorkspaceSelectable(a), true);
  assert.equal(isWorkspaceSelectable(paused), false);
  assert.equal(isWorkspaceSelectable(off), false);
  // 停用 = 不拥有会话（首页分组不再出现）
  assert.equal(workspaceForSession(sess("p1", "/w/p/x"), [a, paused]), undefined);
  const groups = groupSessionsByWorkspace([a, paused], [sess("p1", "/w/p", "2026-01-02T00:00:00Z")]);
  assert.deepEqual(groups.map((g) => g.workspace.id), ["a"]);
  // 默认新建会话工作区也跳过停用项
  assert.equal(defaultHomeNewSessionWorkspaceId([paused, a], [], []), "a");
});

test("workspaceForSession: longest prefix wins, unavailable ignored, non-workspace undefined", async () => {
  const { workspaceForSession } = await import("./home-quick-switch.ts");
  const a = ws("a", "A", "/w/a");
  const nested = ws("n", "N", "/w/a/sub");
  const off = ws("o", "O", "/w/off", false);
  const list = [a, nested, off];
  assert.equal(workspaceForSession(sess("1", "/w/a/sub/x"), list)?.id, "n");
  assert.equal(workspaceForSession(sess("2", "/w/a"), list)?.id, "a");
  assert.equal(workspaceForSession(sess("3", "/elsewhere"), list), undefined);
});

test("groupSessionsByWorkspace: sorts groups by activity, sessions newest-first, empty sinks, filters", async () => {
  const { groupSessionsByWorkspace } = await import("./home-quick-switch.ts");
  const a = ws("a", "A", "/w/a");
  const b = ws("b", "B", "/w/b");
  const off = ws("o", "O", "/w/off", false);
  const sessions = [
    sess("a1", "/w/a", "2026-01-02T00:00:00Z"),
    sess("a2", "/w/a", "2026-01-03T00:00:00Z"),
    sess("b1", "/w/b", "2026-01-04T00:00:00Z"),
    sess("s1", "/w/a", "2026-01-05T00:00:00Z", { subagentChild: true }),
    sess("x1", "/elsewhere", "2026-01-06T00:00:00Z"),
  ];
  const groups = groupSessionsByWorkspace([a, b, off], sessions);
  assert.deepEqual(groups.map((g) => g.workspace.id), ["b", "a"]); // b 最新活跃在前；off 不可用不出现
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ["a2", "a1"]); // 组内降序、subagentChild 剔除
  assert.equal(groups[1].latestModified, "2026-01-03T00:00:00Z");
  const empty = groupSessionsByWorkspace([b, a], []);
  assert.deepEqual(empty.map((g) => g.workspace.id), ["a", "b"]); // 空组沉底按 name
  assert.equal(empty[0].latestModified, "");
});

test("defaultHomeNewSessionWorkspaceId: latest session owner → mru → first", async () => {
  const { defaultHomeNewSessionWorkspaceId } = await import("./home-quick-switch.ts");
  const a = ws("a", "A", "/w/a");
  const b = ws("b", "B", "/w/b");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [sess("b1", "/w/b", "2026-01-02T00:00:00Z")], ["a"]), "b");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [], ["b", "a"]), "b");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [], ["gone", "a"]), "a");
  assert.equal(defaultHomeNewSessionWorkspaceId([a, b], [], []), "a");
  assert.equal(defaultHomeNewSessionWorkspaceId([], [], []), null);
});
