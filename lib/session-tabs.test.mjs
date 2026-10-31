import test from "node:test";
import assert from "node:assert/strict";

function ws(id, name, path, available = true) {
  return { id, name, path, available, capabilities: [], repositoryCount: 0 };
}
function sess(id, cwd, modified = "2026-01-01T00:00:00Z") {
  return { path: `/${id}.jsonl`, id, cwd, created: modified, modified, messageCount: 1, firstMessage: "" };
}

const wa = ws("wa", "A", "/w/a");
const wb = ws("wb", "B", "/w/b");

test("id builders + factories: prefixes, defaults, F1 right-panel state", async () => {
  const { sessionTabId, newSessionTabId, createSessionTab, createNewSessionTab } =
    await import("./session-tabs.ts");
  const s = sess("sid-1", "/w/a");
  assert.equal(sessionTabId("sid-1"), "s:sid-1");
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
  assert.equal(placeholder.rightPanelOpen, false);
});

test("tab kinds: only session / new-session（2026-10 家 tab 除名——总览是 CenterPage）", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("./session-tabs.ts", import.meta.url), "utf8"));
  assert.match(src, /export type SessionTabKind = "session" \| "new-session";/);
  assert.doesNotMatch(src, /workspace-home"\s*[,;|]/);
  assert.doesNotMatch(src, /export function (createHomeTab|homeTabId|resolveNewSessionTarget)\b/);
});

test("resolveOpenSessionTarget (C1): null→from-home（含总览整页打开态）, session/placeholder→morph", async () => {
  const { resolveOpenSessionTarget, createSessionTab, createNewSessionTab } =
    await import("./session-tabs.ts");
  assert.equal(resolveOpenSessionTarget(null), "from-home");
  assert.equal(resolveOpenSessionTarget(createSessionTab(wa, sess("s1", "/w/a"))), "morph");
  assert.equal(resolveOpenSessionTarget(createNewSessionTab(wa, "new:x")), "morph");
});

test("nextActiveTabId (X1): left first, then right, none left→null, unknown→null", async () => {
  const { nextActiveTabId, createSessionTab, createNewSessionTab } =
    await import("./session-tabs.ts");
  const tabs = [
    createSessionTab(wa, sess("s1", "/w/a")),
    createSessionTab(wa, sess("s2", "/w/a")),
    createSessionTab(wb, sess("s3", "/w/b")),
    createNewSessionTab(wb, "new:x"),
    createNewSessionTab(wb, "new:y"),
  ];
  assert.equal(nextActiveTabId(tabs, "s:s3"), "s:s2");   // 左邻
  assert.equal(nextActiveTabId(tabs, "s:s1"), "s:s2");   // 无左邻 → 右邻
  assert.equal(nextActiveTabId([tabs[0]], "s:s1"), null); // 最后一个 → 首页
  assert.equal(nextActiveTabId(tabs, "s:missing"), null); // 不在列表
});

test("contextCloseTargetIds: others/left/right 不含锚，未知锚 → 空", async () => {
  const { contextCloseTargetIds, createSessionTab, createNewSessionTab } =
    await import("./session-tabs.ts");
  const tabs = [
    createSessionTab(wa, sess("s1", "/w/a")),
    createSessionTab(wa, sess("s2", "/w/a")),
    createNewSessionTab(wb, "new:x"),
    createNewSessionTab(wb, "new:y"),
    createSessionTab(wb, sess("s5", "/w/b")),
  ];
  assert.deepEqual(contextCloseTargetIds(tabs, "new:x", "others"), ["s:s1", "s:s2", "new:y", "s:s5"]);
  assert.deepEqual(contextCloseTargetIds(tabs, "new:x", "left"), ["s:s1", "s:s2"]);
  assert.deepEqual(contextCloseTargetIds(tabs, "new:x", "right"), ["new:y", "s:s5"]);
  assert.deepEqual(contextCloseTargetIds(tabs, "s:s1", "left"), []);        // 最左无左侧
  assert.deepEqual(contextCloseTargetIds(tabs, "s:s5", "right"), []);       // 最右无右侧
  assert.deepEqual(contextCloseTargetIds(tabs, "s:missing", "others"), []); // 未知锚
});

test("nextActiveAfterBatchClose: 活动 tab 幸存则保留，被关则先左后右找存活，全灭→null", async () => {
  const { nextActiveAfterBatchClose, createSessionTab, createNewSessionTab } =
    await import("./session-tabs.ts");
  const tabs = [
    createSessionTab(wa, sess("s1", "/w/a")),
    createSessionTab(wa, sess("s2", "/w/a")),
    createNewSessionTab(wb, "new:x"),
    createNewSessionTab(wb, "new:y"),
    createSessionTab(wb, sess("s5", "/w/b")),
  ];
  const ids = (list) => new Set(list);
  // 活动 tab 不在被关集合 → 原样保留
  assert.equal(nextActiveAfterBatchClose(tabs, ids(["s:s1"]), "new:x"), "new:x");
  assert.equal(nextActiveAfterBatchClose(tabs, ids(["s:s1"]), null), null);
  // 活动 tab 被关：左邻存活 → 左；左全灭 → 最近右存活
  assert.equal(nextActiveAfterBatchClose(tabs, ids(["s:s2"]), "s:s2"), "s:s1");
  assert.equal(nextActiveAfterBatchClose(tabs, ids(["s:s1", "s:s2"]), "s:s2"), "new:x");
  // 「关闭其他」：幸存锚自然胜出（无论活动在哪个位置）
  assert.equal(nextActiveAfterBatchClose(tabs, ids(["s:s1", "s:s2", "new:y", "s:s5"]), "s:s2"), "new:x");
  // 全灭 → 首页
  assert.equal(nextActiveAfterBatchClose(tabs, ids(tabs.map((t) => t.id)), "s:s5"), null);
});

test("tabQuery: URL 语法与旧工作区 tab 时代一致（总览 view=overview 不再是 tab 投影）", async () => {
  const { tabQuery, createSessionTab, createNewSessionTab } = await import("./session-tabs.ts");
  const sessionTab = createSessionTab(wa, sess("sid 1", "/w/a"));
  assert.equal(tabQuery(sessionTab), `workspace=wa&view=chat&session=${encodeURIComponent("sid 1")}`);
  assert.equal(tabQuery(createNewSessionTab(wb, "new:x")), "workspace=wb&view=chat");
});

test("serialize/restore roundtrip: ids, order, active preserved", async () => {
  const { serializeTabs, parseStoredTabs, restoreTabs, createSessionTab, createNewSessionTab } =
    await import("./session-tabs.ts");
  const tabs = [
    createSessionTab(wa, sess("s1", "/w/a")),
    createNewSessionTab(wb, "new:keep-me"),
    createSessionTab(wb, sess("s3", "/w/b")),
  ];
  const stored = serializeTabs(tabs, "new:keep-me");
  assert.deepEqual(stored, {
    v: 1,
    tabs: [
      { kind: "session", sessionId: "s1" },
      { kind: "new-session", workspaceId: "wb", id: "new:keep-me" },
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
  assert.deepEqual(restored.tabs.map((t) => t.id), ["s:s1", "new:keep-me", "s:s3"]);
  assert.equal(restored.activeTabId, "new:keep-me");
  assert.equal(restored.skipped, 0);
  // 会话身份与工作区上下文恢复正确（cwd 派生归属）
  assert.equal(restored.tabs[0].session.id, "s1");
  assert.equal(restored.tabs[2].workspace.id, "wb");
});

test("restoreTabs: dead session skipped, unavailable workspace skipped, dup deduped, active falls back", async () => {
  const { restoreTabs } = await import("./session-tabs.ts");
  const gone = ws("gone", "G", "/w/gone", false);
  const stored = {
    v: 1,
    tabs: [
      { kind: "session", sessionId: "dead" },                    // 会话不在列表 → 跳过
      { kind: "session", sessionId: "s1" },
      { kind: "new-session", workspaceId: "gone", id: "new:g" }, // 工作区不可用 → 跳过
      { kind: "new-session", workspaceId: "wa", id: "new:x" },
      { kind: "new-session", workspaceId: "wa", id: "new:x" },   // 重复 id → 去重
    ],
    activeTabId: "s:dead",
  };
  const restored = restoreTabs(stored, [wa, wb, gone], [sess("s1", "/w/a")]);
  assert.deepEqual(restored.tabs.map((t) => t.id), ["s:s1", "new:x"]);
  assert.equal(restored.skipped, 3);
  assert.equal(restored.activeTabId, null); // active 指向失效条目 → 首页
  // 空/损坏存储
  assert.deepEqual(restoreTabs(null, [wa], []), { tabs: [], activeTabId: null, skipped: 0 });
});

test("legacy workspace-home entries（2026-10 前存储）: stripped at parse, active ws:* falls back — no v2 migration", async () => {
  const { parseStoredTabs, restoreTabs } = await import("./session-tabs.ts");
  const parsed = parseStoredTabs(JSON.stringify({
    v: 1,
    tabs: [
      { kind: "workspace-home", workspaceId: "wa" }, // 形态完好的旧家 tab → 仍剔除
      { kind: "session", sessionId: "s1" },
    ],
    activeTabId: "ws:wa",
  }));
  assert.deepEqual(parsed.tabs, [{ kind: "session", sessionId: "s1" }]);
  const restored = restoreTabs(parsed, [wa], [sess("s1", "/w/a")]);
  assert.deepEqual(restored.tabs.map((t) => t.id), ["s:s1"]);
  // 旧 active 指向家 tab → null（桌面空态 effect 随后落总览整页）
  assert.equal(restored.activeTabId, null);
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
        { kind: "session" },                        // 缺 sessionId → 剔除
        { kind: "new-session", workspaceId: "wa" },
        { kind: "new-session", workspaceId: 5 },    // 非字符串 → 剔除
        { kind: "workspace-home", workspaceId: "wa" }, // 退役 kind → 剔除
        { kind: "bogus" },                          // 未知 kind → 剔除
        "junk",
      ],
      activeTabId: 42,                              // 非字符串 → null
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

test("findReusableNewSessionTab: reuses only same-workspace EMPTY-draft placeholders", async () => {
  const { createNewSessionTab, findReusableNewSessionTab } = await import("./session-tabs.ts");
  const emptyA = createNewSessionTab(wa, "new:a-empty");
  const emptyB = createNewSessionTab(wb, "new:b-empty");
  const dirtyA = createNewSessionTab(wa, "new:a-dirty");
  const sessionTab = { ...createNewSessionTab(wa, "new:x"), kind: "session" };
  const emptyPredicate = (id) => !id.includes("dirty");
  const tabs = [sessionTab, dirtyA, emptyA, emptyB];

  // 同工作区空草稿占位 → 命中 tab 条序最前面的一个
  assert.equal(findReusableNewSessionTab(tabs, "wa", emptyPredicate)?.id, "new:a-empty");
  // 草稿非空的占位不算「未发起」→ 不命中
  const onlyDirty = findReusableNewSessionTab([dirtyA], "wa", emptyPredicate);
  assert.equal(onlyDirty, null);
  // 工作区不匹配 → 不命中
  assert.equal(findReusableNewSessionTab([emptyB], "wa", emptyPredicate), null);
  // 会话 tab 不参与
  assert.equal(findReusableNewSessionTab([sessionTab], "wa", emptyPredicate), null);
  // 空列表 → null
  assert.equal(findReusableNewSessionTab([], "wa", emptyPredicate), null);
});
