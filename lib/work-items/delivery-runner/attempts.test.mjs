// Phase-2 Task 3: claim 运行态与 attempt 审计（attempts.ts）。
// claim round-trip/clear（嵌套目录自动创建、clear 幂等）、attempt 追加（key→
// 工作项目录解析 + ULID 文件名）与坏文件跳过、pending/resolve 保留审计只清
// needsAttention（diagnostic 合并、幂等）、paused round-trip、hashOwnerToken
// 确定性（对照 node:crypto sha256）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** 真临时工作区 + 一个工作项目录（KEY-slug 命名，slug ≠ key——检验
 *  writeAttempt 的 key→目录解析与 service.ts 的 findWorkItemDirectory 同构）。 */
async function makeItem(slug = "alpha") {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-attempts-"));
  const itemPath = join(workspacePath, ".pi", "work-items", "requirements", `REQ-0001-${slug}`);
  await mkdir(itemPath, { recursive: true });
  return { workspacePath, itemPath };
}

const claim = (over = {}) => ({
  attemptId: "01JD0ATTEMPT0001",
  generation: 2,
  role: "designer",
  sessionId: "sess-1",
  claimedAt: "2026-10-24T00:00:00Z",
  lastSeenAt: "2026-10-24T00:00:20Z",
  requirementDigest: "digest-a",
  ownerTokenHash: "a".repeat(64),
  ...over,
});

const attempt = (over = {}) => ({
  attemptId: "01JD0ATTEMPT0001",
  generation: 2,
  role: "designer",
  sessionId: "sess-1",
  workspacePath: "/ws",
  key: "REQ-0001",
  claimedAt: "2026-10-24T00:00:00Z",
  requirementDigest: "digest-a",
  ...over,
});

// ------------------------------------------------------------------- claim

test("claimFilePath nests under <item>/delivery/runtime/claim.json", async () => {
  const { claimFilePath } = await import("./attempts.ts");
  assert.equal(
    claimFilePath("/ws/.pi/work-items/requirements/REQ-0001-alpha"),
    "/ws/.pi/work-items/requirements/REQ-0001-alpha/delivery/runtime/claim.json",
  );
});

test("claim round-trip writes nested dirs and reads back verbatim; clear is idempotent", async (t) => {
  const { readClaim, writeClaim, clearClaim } = await import("./attempts.ts");
  const { itemPath } = await makeItem();
  t.after(() => rm(itemPath, { recursive: true, force: true }));

  assert.equal(readClaim(itemPath), null, "missing claim reads as null");

  const state = claim({ lastRequest: { requestId: "req-1", at: "2026-10-24T00:01:00Z" } });
  writeClaim(itemPath, state);
  assert.deepEqual(readClaim(itemPath), state, "round-trip preserves every field");

  clearClaim(itemPath);
  assert.equal(readClaim(itemPath), null);
  clearClaim(itemPath); // clear on already-clear item: no throw
});

test("readClaim treats malformed runtime JSON as absent (runtime/ is advisory, phase guards re-claim)", async (t) => {
  const { readClaim } = await import("./attempts.ts");
  const { itemPath } = await makeItem();
  t.after(() => rm(itemPath, { recursive: true, force: true }));

  await mkdir(join(itemPath, "delivery", "runtime"), { recursive: true });
  await writeFile(join(itemPath, "delivery", "runtime", "claim.json"), "{not json", "utf8");
  assert.equal(readClaim(itemPath), null);
});

// ---------------------------------------------------------------- attempts

test("attemptsDir nests under <item>/delivery/attempts", async () => {
  const { attemptsDir } = await import("./attempts.ts");
  assert.equal(
    attemptsDir("/ws/.pi/work-items/requirements/REQ-0001-alpha"),
    "/ws/.pi/work-items/requirements/REQ-0001-alpha/delivery/attempts",
  );
});

test("writeAttempt resolves the item directory from workspacePath+key and appends a per-attemptId file", async (t) => {
  const { writeAttempt, listAttempts } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  await writeAttempt(attempt({ workspacePath, outcome: "submitted", endedAt: "2026-10-24T00:05:00Z" }));
  await writeAttempt(
    attempt({ attemptId: "01JD0ATTEMPT0002", workspacePath, outcome: "failed", reason: "budget" }),
  );

  const files = (await readdir(join(itemPath, "delivery", "attempts"))).sort();
  assert.deepEqual(files, ["01JD0ATTEMPT0001.json", "01JD0ATTEMPT0002.json"]);
  // ULID 升序 = 时间序：审计列表稳定。
  const listed = await listAttempts(itemPath);
  assert.deepEqual(listed.map((record) => record.attemptId), ["01JD0ATTEMPT0001", "01JD0ATTEMPT0002"]);
  assert.equal(listed[0].outcome, "submitted");
  assert.equal(listed[1].outcome, "failed");
  assert.equal(listed[1].reason, "budget");
});

test("writeAttempt falls back to the bare-key directory when no KEY-slug dir matches", async (t) => {
  const { writeAttempt, listAttempts } = await import("./attempts.ts");
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-attempts-bk-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const itemPath = join(workspacePath, ".pi", "work-items", "bugs", "BUG-0002");
  await mkdir(itemPath, { recursive: true });

  await writeAttempt(attempt({ attemptId: "01JD0BUG000000001", key: "BUG-0002", workspacePath }));
  const listed = await listAttempts(itemPath);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key, "BUG-0002");
});

test("listAttempts skips malformed json and stray non-json files without throwing", async (t) => {
  const { writeAttempt, listAttempts } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  await writeAttempt(attempt({ workspacePath }));
  const dir = join(itemPath, "delivery", "attempts");
  await writeFile(join(dir, "zz-corrupt.json"), "{not json", "utf8");
  await writeFile(join(dir, "01JD0ATTEMPT0000.json"), "[1,2,3]", "utf8"); // 解析成功但非记录形状
  await writeFile(join(dir, "leftover.tmp-123"), "garbage", "utf8");

  const listed = await listAttempts(itemPath);
  assert.deepEqual(listed.map((record) => record.attemptId), ["01JD0ATTEMPT0001"]);
});

test("listAttempts on a missing directory yields an empty audit", async (t) => {
  const { listAttempts } = await import("./attempts.ts");
  const { itemPath } = await makeItem();
  t.after(() => rm(itemPath, { recursive: true, force: true }));
  assert.deepEqual(await listAttempts(itemPath), []);
});

// ---------------------------------------------------- pending / resolve

test("listPendingInterruptions returns only needsAttention records", async (t) => {
  const { writeAttempt, listPendingInterruptions } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  await writeAttempt(attempt({ workspacePath, outcome: "submitted", endedAt: "2026-10-24T00:05:00Z" }));
  await writeAttempt(attempt({ workspacePath, outcome: "failed", reason: "budget" }));
  await writeAttempt(
    attempt({
      attemptId: "01JD0ATTEMPT0003",
      workspacePath,
      outcome: "interrupted",
      endedAt: "2026-10-24T00:07:00Z",
      needsAttention: true,
    }),
  );

  const pending = await listPendingInterruptions(itemPath);
  assert.deepEqual(pending.map((record) => record.attemptId), ["01JD0ATTEMPT0003"]);
});

test("resolveInterruptions keeps the audit, clears needsAttention, merges diagnostic; idempotent", async (t) => {
  const { writeAttempt, listAttempts, listPendingInterruptions, resolveInterruptions } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  await writeAttempt(attempt({ workspacePath, outcome: "submitted", endedAt: "2026-10-24T00:05:00Z" }));
  await writeAttempt(
    attempt({
      attemptId: "01JD0ATTEMPT0003",
      workspacePath,
      outcome: "interrupted",
      endedAt: "2026-10-24T00:07:00Z",
      needsAttention: true,
      diagnostic: { checkedAt: "2026-10-24T00:08:00Z" },
    }),
  );

  const resolvedCount = await resolveInterruptions(itemPath, {
    outcome: "interrupted",
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T00:09:00Z", actor: "user" },
  });
  assert.equal(resolvedCount, 1, "only the needsAttention record is touched");

  // 审计保留：全部记录仍在，resolved 记录只清 needsAttention + 记诊断。
  const listed = await listAttempts(itemPath);
  assert.deepEqual(listed.map((record) => record.attemptId), ["01JD0ATTEMPT0001", "01JD0ATTEMPT0003"]);
  const resolved = listed[1];
  assert.equal(resolved.needsAttention, false);
  assert.equal(resolved.outcome, "interrupted");
  assert.deepEqual(resolved.diagnostic, { checkedAt: "2026-10-24T00:09:00Z", actor: "user" });
  assert.equal(resolved.claimedAt, "2026-10-24T00:00:00Z", "audit fields untouched");

  assert.deepEqual(await listPendingInterruptions(itemPath), []);
  assert.equal(
    await resolveInterruptions(itemPath, { needsAttention: false, diagnostic: { checkedAt: "2026-10-24T01:00:00Z" } }),
    0,
    "resolve on nothing pending: 0, no throw",
  );
});

test("resolveInterruptions on a missing directory returns 0", async (t) => {
  const { resolveInterruptions } = await import("./attempts.ts");
  const { itemPath } = await makeItem();
  t.after(() => rm(itemPath, { recursive: true, force: true }));
  assert.equal(
    await resolveInterruptions(itemPath, { needsAttention: false, diagnostic: { checkedAt: "2026-10-24T00:00:00Z" } }),
    0,
  );
});

// ------------------------------------------------------------------ paused

test("paused round-trip at the documented path; clear is idempotent", async (t) => {
  const { pausedFilePath, readPaused, writePaused, clearPaused } = await import("./attempts.ts");
  const { itemPath } = await makeItem();
  t.after(() => rm(itemPath, { recursive: true, force: true }));

  assert.equal(
    pausedFilePath(itemPath),
    join(itemPath, "delivery", "runtime", "automation-paused.json"),
  );
  assert.equal(readPaused(itemPath), null);

  const info = { at: "2026-10-24T00:00:00Z", reason: "consecutive failures", count: 3 };
  writePaused(itemPath, info);
  assert.deepEqual(readPaused(itemPath), info);

  clearPaused(itemPath);
  assert.equal(readPaused(itemPath), null);
  clearPaused(itemPath); // no throw
});

// ----------------------------------------------------------- owner token

test("hashOwnerToken is deterministic sha256 hex and input-sensitive", async () => {
  const { hashOwnerToken } = await import("./attempts.ts");
  const expected = createHash("sha256").update("owner-token-plaintext", "utf8").digest("hex");
  assert.equal(hashOwnerToken("owner-token-plaintext"), expected);
  assert.equal(hashOwnerToken("owner-token-plaintext"), hashOwnerToken("owner-token-plaintext"));
  assert.match(hashOwnerToken("other"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashOwnerToken("other"), expected);
});

// ---------------------------------- failure window + streak counting (T4 fix round)

test("failure-window round-trip at the documented path; missing reads null", async (t) => {
  const { failureWindowFilePath, readFailureWindow, writeFailureWindow } = await import("./attempts.ts");
  const { itemPath } = await makeItem();
  t.after(() => rm(itemPath, { recursive: true, force: true }));

  assert.equal(
    failureWindowFilePath(itemPath),
    join(itemPath, "delivery", "runtime", "failure-window.json"),
  );
  assert.equal(readFailureWindow(itemPath), null);
  writeFailureWindow(itemPath, "2026-10-24T01:00:00Z");
  assert.deepEqual(readFailureWindow(itemPath), { since: "2026-10-24T01:00:00Z" });
});

test("countRecentFailures: missing window counts everything; window filters by claimedAt; maxStopsAt caps the walk", async (t) => {
  const { countRecentFailures, writeAttempt } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  const fail = (attemptId, claimedAt) =>
    writeAttempt(attempt({
      attemptId, claimedAt, workspacePath,
      outcome: "failed", requirementDigest: "digest-a",
    }));
  await fail("01JF000000000000000000A", "2026-10-24T00:01:00Z");
  await fail("01JF000000000000000000B", "2026-10-24T00:02:00Z");

  // 无窗口 = epoch：全量计数。
  assert.equal(await countRecentFailures(itemPath, "digest-a"), 2);
  // 窗口起点之后只剩 00:02 一条。
  const { writeFailureWindow } = await import("./attempts.ts");
  writeFailureWindow(itemPath, "2026-10-24T00:01:30Z");
  assert.equal(await countRecentFailures(itemPath, "digest-a"), 1);
  // 其他 digest 不计。
  assert.equal(await countRecentFailures(itemPath, "digest-b"), 0);
  // maxStopsAt 只是提前收手的优化：结果不超过 max+1，且不漏判 >= max。
  assert.equal(await countRecentFailures(itemPath, "digest-b", 3), 0);
});

test("countRecentFailures: submitted breaks the streak; interrupted neither counts nor breaks", async (t) => {
  const { countRecentFailures, writeAttempt } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  const record = (attemptId, claimedAt, over = {}) =>
    writeAttempt(attempt({
      attemptId, claimedAt, workspacePath, requirementDigest: "digest-a", ...over,
    }));
  // 时间线（旧→新）：fail, submitted, fail, interrupted, fail → 连胜 = 2（最新两条 fail）。
  await record("01JA0000000000000000001", "2026-10-24T00:01:00Z", { outcome: "failed" });
  await record("01JA0000000000000000002", "2026-10-24T00:02:00Z", { outcome: "submitted" });
  await record("01JA0000000000000000003", "2026-10-24T00:03:00Z", { outcome: "failed" });
  await record("01JA0000000000000000004", "2026-10-24T00:04:00Z", { outcome: "interrupted" });
  await record("01JA0000000000000000005", "2026-10-24T00:05:00Z", { outcome: "failed" });
  assert.equal(await countRecentFailures(itemPath, "digest-a"), 2);

  // 再补一条 submitted 在最新处 → 连胜清零。
  await record("01JA0000000000000000006", "2026-10-24T00:06:00Z", { outcome: "submitted" });
  assert.equal(await countRecentFailures(itemPath, "digest-a"), 0);
});

test("countRecentFailures walks claimedAt order, not filename/attemptId order", async (t) => {
  const { countRecentFailures, writeAttempt } = await import("./attempts.ts");
  const { workspacePath, itemPath } = await makeItem();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));

  // 文件名（ULID）序晚、claimedAt 早的 fail；文件名序早、claimedAt 晚的
  // submitted 断点。按 claimedAt 走：最新是 submitted → 立即停 → 0；
  // 若误按 attemptId 序走会先数到 fail（=1）。
  await writeAttempt(attempt({
    attemptId: "01JZ0000000000000000009", claimedAt: "2026-10-24T00:01:00Z",
    workspacePath, outcome: "failed", requirementDigest: "digest-a",
  }));
  await writeAttempt(attempt({
    attemptId: "01JA0000000000000000001", claimedAt: "2026-10-24T00:02:00Z",
    workspacePath, outcome: "submitted", requirementDigest: "digest-a",
  }));
  assert.equal(await countRecentFailures(itemPath, "digest-a"), 0);
});
