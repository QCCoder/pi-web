import test from "node:test";
import assert from "node:assert/strict";

function ws(id, name, path, available = true) {
  return { id, name, path, available, capabilities: [], repositoryCount: 0, skills: [] };
}
function sess(id, cwd, modified = "2026-01-01T00:00:00Z") {
  return { path: `/${id}.jsonl`, id, cwd, created: modified, modified, messageCount: 1, firstMessage: "" };
}

const wa = ws("wa", "A", "/w/a");
const wb = ws("wb", "B", "/w/b");

test("id builders + factories: prefixes, defaults, F1 right-panel state", async () => {
  const { sessionTabId, homeTabId, newSessionTabId, createSessionTab, createNewSessionTab, createHomeTab } =
    await import("./session-tabs.ts");
  const s = sess("sid-1", "/w/a");
  assert.equal(sessionTabId("sid-1"), "s:sid-1");
  assert.equal(homeTabId("wa"), "ws:wa");
  assert.equal(newSessionTabId("uuid-9"), "new:uuid-9");
  const sessionTab = createSessionTab(wa, s);
  assert.equal(sessionTab.id, "s:sid-1");
  assert.equal(sessionTab.kind, "session");
  assert.equal(sessionTab.workspace.id, "wa");
  assert.deepEqual(sessionTab.fileTabs, []);
  assert.equal(sessionTab.activeFileTabId, null);
  assert.equal(sessionTab.rightPanelOpen, false);
  const placeholder = createNewSessionTab(wb, "new:x");
  assert.equal(placeholder.kind, "new-session");
  assert.equal(placeholder.session, null);
  const home = createHomeTab(wa);
  assert.equal(home.id, "ws:wa");
  assert.equal(home.kind, "workspace-home");
});

test("resolveOpenSessionTarget (C1): null→from-home, home tab→new-tab, session/placeholder→morph", async () => {
  const { resolveOpenSessionTarget, createSessionTab, createNewSessionTab, createHomeTab } =
    await import("./session-tabs.ts");
  assert.equal(resolveOpenSessionTarget(null), "from-home");
  assert.equal(resolveOpenSessionTarget(createHomeTab(wa)), "new-tab");
  assert.equal(resolveOpenSessionTarget(createSessionTab(wa, sess("s1", "/w/a"))), "morph");
  assert.equal(resolveOpenSessionTarget(createNewSessionTab(wa, "new:x")), "morph");
});

test("nextActiveTabId (X1): left first, then right, none left→null, unknown→null", async () => {
  const { nextActiveTabId, createSessionTab, createNewSessionTab, createHomeTab } =
    await import("./session-tabs.ts");
  const tabs = [
    createSessionTab(wa, sess("s1", "/w/a")),
    createSessionTab(wa, sess("s2", "/w/a")),
    createSessionTab(wb, sess("s3", "/w/b")),
    createNewSessionTab(wb, "new:x"),
    createHomeTab(wb),
  ];
  assert.equal(nextActiveTabId(tabs, "s:s3"), "s:s2");   // 左邻
  assert.equal(nextActiveTabId(tabs, "s:s1"), "s:s2");   // 无左邻 → 右邻
  assert.equal(nextActiveTabId([tabs[0]], "s:s1"), null); // 最后一个 → 首页
  assert.equal(nextActiveTabId(tabs, "s:missing"), null); // 不在列表
});

test("tabQuery: URL 语法与旧工作区 tab 时代一致", async () => {
  const { tabQuery, createSessionTab, createNewSessionTab, createHomeTab } = await import("./session-tabs.ts");
  const sessionTab = createSessionTab(wa, sess("sid 1", "/w/a"));
  assert.equal(tabQuery(sessionTab), `workspace=wa&view=chat&session=${encodeURIComponent("sid 1")}`);
  assert.equal(tabQuery(createNewSessionTab(wb, "new:x")), "workspace=wb&view=chat");
  assert.equal(tabQuery(createHomeTab(wa)), "workspace=wa&view=overview");
});

test("serialize/restore roundtrip: ids, order, active preserved", async () => {
  const { serializeTabs, parseStoredTabs, restoreTabs, createSessionTab, createNewSessionTab, createHomeTab } =
    await import("./session-tabs.ts");
  const tabs = [
    createSessionTab(wa, sess("s1", "/w/a")),
    createNewSessionTab(wb, "new:keep-me"),
    createHomeTab(wa),
    createSessionTab(wb, sess("s3", "/w/b")),
  ];
  const stored = serializeTabs(tabs, "new:keep-me");
  assert.deepEqual(stored, {
    v: 1,
    tabs: [
      { kind: "session", sessionId: "s1" },
      { kind: "new-session", workspaceId: "wb", id: "new:keep-me" },
      { kind: "workspace-home", workspaceId: "wa" },
      { kind: "session", sessionId: "s3" },
    ],
    activeTabId: "new:keep-me",
  });
  // 序列化 → 字符串 → 解析 → 恢复 全链路
  const restored = restoreTabs(
    parseStoredTabs(JSON.stringify(stored)),
    [wa, wb],
    [sess("s1", "/w/a"), sess("s3", "/w/b")],
  );
  assert.deepEqual(restored.tabs.map((t) => t.id), ["s:s1", "new:keep-me", "ws:wa", "s:s3"]);
  assert.equal(restored.activeTabId, "new:keep-me");
  assert.equal(restored.skipped, 0);
  // 会话身份与工作区上下文恢复正确（cwd 派生归属）
  assert.equal(restored.tabs[0].session.id, "s1");
  assert.equal(restored.tabs[3].workspace.id, "wb");
});

test("restoreTabs: dead session skipped, unavailable workspace skipped, dup deduped, active falls back", async () => {
  const { restoreTabs } = await import("./session-tabs.ts");
  const gone = ws("gone", "G", "/w/gone", false);
  const stored = {
    v: 1,
    tabs: [
      { kind: "session", sessionId: "dead" },          // 会话不在列表 → 跳过
      { kind: "session", sessionId: "s1" },
      { kind: "workspace-home", workspaceId: "gone" }, // 工作区不可用 → 跳过
      { kind: "workspace-home", workspaceId: "wa" },
      { kind: "workspace-home", workspaceId: "wa" },   // 重复 id → 去重
      { kind: "new-session", workspaceId: "wa", id: "new:x" },
    ],
    activeTabId: "s:dead",
  };
  const restored = restoreTabs(stored, [wa, wb, gone], [sess("s1", "/w/a")]);
  assert.deepEqual(restored.tabs.map((t) => t.id), ["s:s1", "ws:wa", "new:x"]);
  assert.equal(restored.skipped, 3);
  assert.equal(restored.activeTabId, null); // active 指向失效条目 → 首页
  // 空/损坏存储
  assert.deepEqual(restoreTabs(null, [wa], []), { tabs: [], activeTabId: null, skipped: 0 });
});

test("parseStoredTabs: rejects malformed, strips bad entries, keeps valid kinds only", async () => {
  const { parseStoredTabs } = await import("./session-tabs.ts");
  assert.equal(parseStoredTabs(null), null);
  assert.equal(parseStoredTabs("not json"), null);
  assert.equal(parseStoredTabs('{"v":2,"tabs":[]}'), null);
  const parsed = parseStoredTabs(
    JSON.stringify({
      v: 1,
      tabs: [
        { kind: "session", sessionId: "s1" },
        { kind: "session" },                    // 缺 sessionId → 剔除
        { kind: "new-session", workspaceId: "wa" },
        { kind: "workspace-home", workspaceId: 5 }, // 非字符串 → 剔除
        { kind: "bogus" },                      // 未知 kind → 剔除
        "junk",
      ],
      activeTabId: 42,                          // 非字符串 → null
    }),
  );
  assert.deepEqual(parsed.tabs, [
    { kind: "session", sessionId: "s1" },
    { kind: "new-session", workspaceId: "wa" },
  ]);
  assert.equal(parsed.activeTabId, null);
});

test("restore placeholder without valid stored id gets deterministic fallback id", async () => {
  const { restoreTabs } = await import("./session-tabs.ts");
  const restored = restoreTabs(
    { v: 1, tabs: [{ kind: "new-session", workspaceId: "wa", id: "weird" }], activeTabId: null },
    [wa],
    [],
  );
  assert.equal(restored.tabs[0].id, "new:restored-0");
});
