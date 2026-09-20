import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveComposerDraftKey, shouldDropRestoreAfterUnmount } = await jiti.import("@/lib/composer-draft-key.ts");
const { clearDraft, getDraft, restoreDraftSubmission } = await jiti.import("@/lib/draft-store.ts");

const hookSource = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");

test("composer draft key resolution puts the shell override first", () => {
  // 桌面/移动端新会话 tab（activeTab.id）与 home（new:__home__）都走 override：
  // 它才是 ChatInput 实际挂载的键，恢复/清理必须与它一致。
  assert.equal(
    resolveComposerDraftKey({ draftKeyOverride: "new:tab-7", sessionId: "session-1", newSessionCwd: "/repo" }),
    "new:tab-7",
  );
  assert.equal(
    resolveComposerDraftKey({ draftKeyOverride: "new:__home__", newSessionCwd: "/repo" }),
    "new:__home__",
  );
});

test("without an override the session id wins, then the provisional new key", () => {
  assert.equal(
    resolveComposerDraftKey({ sessionId: "session-1", newSessionCwd: "/repo" }),
    "session-1",
  );
  assert.equal(resolveComposerDraftKey({ newSessionCwd: "/repo" }), "new:/repo");
  assert.equal(resolveComposerDraftKey({}), undefined);
});

test("a rejected submission restored under the real composer key survives abandoning a different key", () => {
  // 回归（T10c Critical）：恢复曾写进幽灵键 new:<cwd>，废弃清理删的也是它——
  // 用户没见过的输入被永久删除。对齐后恢复与清理共用同一个（override 优先的）键。
  const composerKey = "new:tab-7";
  const legacyGhostKey = "new:/repo";

  restoreDraftSubmission(composerKey, "rejected submission");

  clearDraft(legacyGhostKey);
  assert.equal(getDraft(composerKey)?.value, "rejected submission");

  clearDraft(composerKey);
});

test("the effective composer key is threaded from ChatWindow into the hook", () => {
  // ChatWindow 用 resolveComposerDraftKey（override 优先）解析一次，同时喂给
  // useAgentSession 与 ChatInput 的 draftKey。
  assert.match(chatWindowSource, /const composerDraftKey = resolveComposerDraftKey\(\{\s*draftKeyOverride,/);
  assert.match(chatWindowSource, /composerDraftKey,\s*\}\);/);
  assert.match(chatWindowSource, /draftKey=\{composerDraftKey\}/);

  // hook 侧：恢复目标守卫、promote 换 key、废弃清理全部使用该键。
  assert.match(hookSource, /composerDraftKey\?: string;/);
  assert.match(hookSource, /const provisionalDraftKey = composerDraftKey \?\? null;/);
  assert.match(hookSource, /const abandonedDraftKey = isNew \? composerDraftKey \?\? null : null;/);
  assert.doesNotMatch(hookSource, /newSessionCwd \? `new:\$\{newSessionCwd\}` : (null|undefined)/);
});

test("a rejected submission for an existing session persists its draft across unmount", () => {
  // 回归（T10c 修复轮 2）：卸载守卫曾用完整生效键比较——现有会话切走（hook 卸载）
  // 后迟到的确定性拒绝被静默丢弃，用户文本无提示丢失。上游语义：守卫只针对临时
  // 新会话键；session-id 键的草稿卸载后照常持久化。
  const decision = {
    hookMounted: false,
    newSessionPromoted: false,
    transientNewSessionDraftKey: null, // 现有会话：无临时键
    targetDraftKey: "session-1",
  };
  assert.equal(shouldDropRestoreAfterUnmount(decision), false);

  // drop 决策为 false → 走 store 持久化路径：写入 session 键并可读回。
  restoreDraftSubmission("session-1", "rejected submission");
  assert.equal(getDraft("session-1")?.value, "rejected submission");

  clearDraft("session-1");
});

test("a late restore for an abandoned new session is still dropped", () => {
  assert.equal(shouldDropRestoreAfterUnmount({
    hookMounted: false,
    newSessionPromoted: false,
    transientNewSessionDraftKey: "new:tab-7",
    targetDraftKey: "new:tab-7",
  }), true);

  // promote 之后临时键不再是「废弃中」的键，恢复照常进行。
  assert.equal(shouldDropRestoreAfterUnmount({
    hookMounted: false,
    newSessionPromoted: true,
    transientNewSessionDraftKey: "new:tab-7",
    targetDraftKey: "new:tab-7",
  }), false);
});

test("reconcileAgentState ignores stale runs and session switches", () => {
  const reconcileSource = hookSource.slice(
    hookSource.indexOf("const reconcileAgentState = useCallback"),
    hookSource.indexOf("const ensureSseConnected = useCallback"),
  );
  assert.match(reconcileSource, /\.agentRunning \|\| sessionIdRef\.current !== sid\) return;/);
  assert.match(reconcileSource, /if \(sessionIdRef\.current !== sid \|\| promptRunIdRef\.current !== runId\) return;/);
});
