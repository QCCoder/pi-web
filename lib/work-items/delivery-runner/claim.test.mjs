// Phase-2 Task 4: ClaimService 领取事务（claim.ts）。
// mkdtemp 真工作区（manifest + .pi/delivery.yaml + 手写 item.yaml/README/events）
// 直接驱动服务函数（服务收 workspacePath——T4 裁定的测试缝）：
//   1. happy claim（phase→design、design.md 播种、claim 落盘、事件、status in_progress）
//   2. 同 requestId 重放（replayed=true、revision 不动、无第二 attempt、ownerToken 空串）
//   3. 并发两 claim（Promise.all）只成一、另一个 Conflict
//   4. 前置复验逐条（wrong-phase/not-managed/disabled/paused/failure-limit/
//      pending-interruption/capability → Validation 带 reason；活动 claim → Conflict）
//   5. submit（design.md + 验收条件节、claim 清、attempt submitted、status open；
//      digest 变化 → Conflict）
//   6. fail blocked（status blocked、phase 回 intake）+ 三次失败 → paused + 事件；
//      resumeAutomation 恢复
//   7. heartbeat 续约（sessionId 匹配才续）
//   8. recordInterruption（needsAttention attempt + claim 清 + 事件；幂等/不匹配 no-op）
// 附带裁定 #2：claim 首写 runtime/ 时工作区 .gitignore 幂等接线。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentDigest } from "../delivery-types.ts";
import { WorkItemConflictError, WorkItemValidationError } from "../errors.ts";

const RUNTIME_GITIGNORE_ENTRY = ".pi/work-items/**/delivery/runtime/";

// ---------------------------------------------------------------- fixture

async function writeManifest(root, capabilities = ["sessions", "explorer", "work-items", "workflows"]) {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "workspace.yaml"),
    [
      "schema_version: 1",
      "id: 01TESTWORKSPACE00000000000",
      "slug: test-ws",
      'name: "Test WS"',
      "skills: []",
      "repositories: []",
      `capabilities: [${capabilities.join(", ")}]`,
      "work_items:",
      "  next_requirement_number: 2",
      "  next_bug_number: 1",
      'created_at: "2026-10-24T00:00:00Z"',
      'updated_at: "2026-10-24T00:00:00Z"',
      "",
    ].join("\n"),
    "utf8",
  );
}

const managedDeliveryYaml = ["delivery:", "  protocolVersion: 1", "  mode: manual"];

const itemYaml = ({ key, title, priority = "P1", status = "open", phase = "intake", managed = true }) =>
  [
    "schema_version: 1",
    `id: ${key}-id`,
    `key: ${key}`,
    "type: requirement",
    "revision: 1",
    `title: ${JSON.stringify(title)}`,
    `status: ${status}`,
    `phase: ${phase}`,
    `priority: ${priority}`,
    "repositories: []",
    "tags: []",
    "conversations: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    "archived_at: null",
    `created_at: "2026-10-24T00:00:00Z"`,
    `updated_at: "2026-10-24T00:00:00Z"`,
    ...(managed ? managedDeliveryYaml : []),
    "",
  ].join("\n");

async function writeItem(root, { key, slug, title, readme = "Alpha body\n", ...rest }) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, title, ...rest }), "utf8");
  await writeFile(join(dir, "README.md"), readme, "utf8");
  await writeFile(join(dir, "events.jsonl"), "", "utf8");
  return dir;
}

/** 标准测试工作区：manifest（work-items+workflows）+ enabled 配置 + 一个 managed intake 项。 */
async function makeWorkspace(t, { capabilities, enabled = true } = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeManifest(ws, capabilities);
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  const itemPath = await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha" });
  return { ws, itemPath, key: "REQ-0001", readme: "Alpha body\n" };
}

async function readEvents(ws, key) {
  const { readWorkItem } = await import("../service.ts");
  return (await readWorkItem(ws, key)).events;
}

// ---------------------------------------------------------------- 1. happy claim

test("claimDesignerTask happy path: phase intake→design, design.md seeded, claim written, event appended", async (t) => {
  const { claimDesignerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { hashOwnerToken } = attempts;
  const { ws, itemPath, key, readme } = await makeWorkspace(t);

  const { grant, replayed } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  assert.equal(replayed, false);
  assert.match(grant.attemptId, /^[0-9A-Z]{26}$/, "attemptId is a ULID");
  assert.equal(grant.generation, 1);
  assert.ok(grant.ownerToken.length > 0, "fresh grant carries the plaintext ownerToken");
  assert.equal(grant.key, key);

  // item 状态：phase design / status in_progress / revision+1。
  assert.equal(grant.item.item.phase, "design");
  assert.equal(grant.item.item.status, "in_progress");
  assert.equal(grant.item.item.revision, 2);

  // design.md 播种（M2 start-design 同一模板串）。
  const seeded = await readFile(join(itemPath, "delivery", "artifacts", "design.md"), "utf8");
  assert.ok(seeded.startsWith("# 设计：Alpha\n"), "seeded with the M2 start-design template");

  // claim.json：ownerToken 只落 hash，lastRequest 记 requestId，digest 绑定 README。
  const claim = attempts.readClaim(itemPath);
  assert.equal(claim.attemptId, grant.attemptId);
  assert.equal(claim.generation, 1);
  assert.equal(claim.ownerTokenHash, hashOwnerToken(grant.ownerToken));
  assert.equal(claim.sessionId, "sess-1");
  assert.equal(claim.requirementDigest, contentDigest(readme));
  assert.equal(claim.lastRequest.requestId, "req-1");

  // 事件：delivery.claimed，actor=agent，phase from/to + attemptId + generation。
  const events = await readEvents(ws, key);
  const claimed = events.find((event) => event.type === "delivery.claimed");
  assert.ok(claimed, "delivery.claimed event appended");
  assert.equal(claimed.actor, "agent");
  assert.deepEqual(claimed.data.phase, { from: "intake", to: "design" });
  assert.equal(claimed.data.attemptId, grant.attemptId);
  assert.equal(claimed.data.generation, 1);
});

// ------------------------------------------- carried ruling #2: gitignore 接线

test("first claim wires the runtime/ gitignore (idempotent; attempts stay tracked)", async (t) => {
  const { claimDesignerTask } = await import("./claim.ts");
  const { ws, key } = await makeWorkspace(t);
  await assert.rejects(readFile(join(ws, ".gitignore")), /ENOENT/, "fixture starts without .gitignore");

  await claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1" });
  const gitignore = await readFile(join(ws, ".gitignore"), "utf8");
  const occurrences = gitignore.split("\n").filter((line) => line.trim() === RUNTIME_GITIGNORE_ENTRY);
  assert.equal(occurrences.length, 1, "gitignore created with the runtime/ entry exactly once");

  // 第二个 item 的 claim 不重复追加；已含则不动。
  await writeItem(ws, { key: "REQ-0002", slug: "beta", title: "Beta" });
  await claimDesignerTask({ workspacePath: ws, key: "REQ-0002", sessionId: "sess-2", requestId: "req-2" });
  const after = await readFile(join(ws, ".gitignore"), "utf8");
  assert.equal(
    after.split("\n").filter((line) => line.trim() === RUNTIME_GITIGNORE_ENTRY).length,
    1,
    "entry is not duplicated by a later claim",
  );
  assert.ok(!after.includes("attempts"), "the attempts/ audit directory is NOT gitignored");
});

// ---------------------------------------------------------------- 2. replay

test("same requestId replays the existing claim: no revision bump, no second event, no attempt, empty ownerToken", async (t) => {
  const { claimDesignerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const first = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  const replay = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.grant.attemptId, first.grant.attemptId);
  assert.equal(replay.grant.generation, first.grant.generation);
  assert.equal(replay.grant.ownerToken, "", "replay cannot resurrect the plaintext token");
  assert.equal(replay.grant.item.item.revision, 2, "revision untouched by replay");

  const events = await readEvents(ws, key);
  assert.equal(events.filter((event) => event.type === "delivery.claimed").length, 1);
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "replay writes no attempt record");
});

// ---------------------------------------------------------------- 3. concurrency

test("two concurrent claims on one key: exactly one grant, the other is a Conflict", async (t) => {
  const { claimDesignerTask } = await import("./claim.ts");
  const { ws, key } = await makeWorkspace(t);

  const results = await Promise.allSettled([
    claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-a", requestId: "req-a" }),
    claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-b", requestId: "req-b" }),
  ]);
  const grants = results.filter((result) => result.status === "fulfilled");
  const conflicts = results.filter((result) => result.status === "rejected");
  assert.equal(grants.length, 1, "exactly one claim wins");
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].reason instanceof WorkItemConflictError);
  assert.match(conflicts[0].reason.message, /active claim/i);
});

// ------------------------------------------------- 4. precondition rejections

test("claim re-verifies every pool precondition in the transaction (reason strings)", async (t) => {
  const { claimDesignerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");

  const rejectsWith = async (promise, ErrorClass, pattern) => {
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof ErrorClass, `expected ${ErrorClass.name}, got ${error?.name}: ${error?.message}`);
      assert.match(error.message, pattern);
      return true;
    });
  };
  const claim = (ws, key, requestId = "req-x") =>
    claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-x", requestId });

  // wrong-phase：design 阶段不可领（claim 已流转或人工流转后）。
  {
    const { ws } = await makeWorkspace(t);
    await writeItem(ws, { key: "REQ-0009", slug: "designed", title: "D", phase: "design" });
    await rejectsWith(claim(ws, "REQ-0009"), WorkItemValidationError, /wrong-phase/);
  }
  // not-managed：无 delivery 块。
  {
    const { ws } = await makeWorkspace(t);
    await writeItem(ws, { key: "REQ-0009", slug: "plain", title: "P", managed: false });
    await rejectsWith(claim(ws, "REQ-0009"), WorkItemValidationError, /not-managed/);
  }
  // automation-disabled：配置 enabled=false。
  {
    const { ws, key } = await makeWorkspace(t, { enabled: false });
    await rejectsWith(claim(ws, key), WorkItemValidationError, /automation-disabled/);
  }
  // automation-paused：连续失败暂停标记在场。
  {
    const { ws, itemPath, key } = await makeWorkspace(t);
    attempts.writePaused(itemPath, { at: "2026-10-24T00:00:00Z", reason: "consecutive failures", count: 3 });
    await rejectsWith(claim(ws, key), WorkItemValidationError, /automation-paused/);
  }
  // failure-limit：同 requirementDigest 的 failed attempts 已达上限（3）。
  {
    const { ws, itemPath, key, readme } = await makeWorkspace(t);
    const digest = contentDigest(readme);
    for (const [index, attemptId] of ["01JFAIL0000000000000000", "01JFAIL0000000000000001", "01JFAIL0000000000000002"].entries()) {
      await attempts.writeAttempt({
        attemptId, generation: index + 1, role: "designer", sessionId: `sess-${index}`,
        workspacePath: ws, key, claimedAt: "2026-10-24T00:00:00Z",
        endedAt: "2026-10-24T00:05:00Z", outcome: "failed", reason: "x",
        requirementDigest: digest,
      });
    }
    assert.ok(attempts.readClaim(itemPath) === null);
    await rejectsWith(claim(ws, key), WorkItemValidationError, /failure-limit/);
  }
  // pending-interruption：未确认中断挡住新领取。
  {
    const { ws, key, readme } = await makeWorkspace(t);
    await attempts.writeAttempt({
      attemptId: "01JINT00000000000000000", generation: 1, role: "designer", sessionId: "sess-old",
      workspacePath: ws, key, claimedAt: "2026-10-24T00:00:00Z",
      outcome: "interrupted", endedAt: "2026-10-24T00:05:00Z",
      requirementDigest: contentDigest(readme), needsAttention: true,
    });
    await rejectsWith(claim(ws, key), WorkItemValidationError, /pending-interruption/);
  }
  // capability 复验：manifest 缺 workflows。
  {
    const { ws, key } = await makeWorkspace(t, { capabilities: ["sessions", "explorer", "work-items"] });
    await rejectsWith(claim(ws, key), WorkItemValidationError, /capabilities/);
  }
  // 他人活动 claim → Conflict。
  {
    const { ws, key } = await makeWorkspace(t);
    await claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1" });
    await rejectsWith(claim(ws, key, "req-other"), WorkItemConflictError, /active claim/);
  }
});

// ---------------------------------------------------------------- 5. submit

test("submitDesignerResult writes design.md + acceptance criteria, clears claim, records submitted attempt, status open", async (t) => {
  const { claimDesignerTask, submitDesignerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  const detail = await submitDesignerResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    designContent: "方案：用 B 树索引。",
    acceptanceCriteria: ["查询 P95 < 50ms", "回填任务可重跑"],
    requestId: "req-submit-1",
    conversationId: "conv-1",
  });

  // design.md = 正文 + 合成的验收条件节。
  const design = await readFile(join(itemPath, "delivery", "artifacts", "design.md"), "utf8");
  assert.equal(
    design,
    "方案：用 B 树索引。\n\n## 验收条件\n- [ ] 查询 P95 < 50ms\n- [ ] 回填任务可重跑\n",
  );
  // 状态：phase 保持 design 等人确认、status open、revision+1；conversationId 自链接。
  assert.equal(detail.item.phase, "design");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  assert.ok(detail.item.conversations.includes("conv-1"));

  // claim 清 + attempt submitted 落审计。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].attemptId, grant.attemptId);

  // 事件：work_item.design_updated（对齐 M2 的时间线类型——UI 按它检索）+
  // delivery.submitted（actor=agent）。
  const events = await readEvents(ws, key);
  const submitted = events.find((event) => event.type === "delivery.submitted");
  const designUpdated = events.find((event) => event.type === "work_item.design_updated");
  assert.ok(submitted && designUpdated);
  assert.equal(events.filter((event) => event.type === "delivery.design_updated").length, 0,
    "no delivery.design_updated variant event");
  assert.equal(submitted.actor, "agent");
  assert.equal(submitted.data.attemptId, grant.attemptId);
  assert.equal(submitted.data.criteriaCount, 2);
  assert.equal(designUpdated.actor, "agent");
});

test("submit with a stale credential or changed requirement digest is a Conflict", async (t) => {
  const { claimDesignerTask, submitDesignerResult } = await import("./claim.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });

  // 错误 ownerToken → Conflict。
  await assert.rejects(
    submitDesignerResult({
      workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation,
      ownerToken: "forged", designContent: "d", acceptanceCriteria: ["c"], requestId: "req-s",
    }),
    (error) => error instanceof WorkItemConflictError,
  );
  // 错误 generation → Conflict。
  await assert.rejects(
    submitDesignerResult({
      workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation + 5,
      ownerToken: grant.ownerToken, designContent: "d", acceptanceCriteria: ["c"], requestId: "req-s",
    }),
    (error) => error instanceof WorkItemConflictError,
  );

  // requirementDigest 变化（README 被人改了）→ Conflict 要求重领。
  await writeFile(join(itemPath, "README.md"), "Changed requirement\n", "utf8");
  await assert.rejects(
    submitDesignerResult({
      workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation,
      ownerToken: grant.ownerToken, designContent: "d", acceptanceCriteria: ["c"], requestId: "req-s",
    }),
    (error) => error instanceof WorkItemConflictError && /requirement|digest|re-claim|重新/i.test(error.message),
  );
});

// ---------------------------------------------------------------- 6. fail + budget

test("failDesignerTask blocked sets status blocked and rewinds phase for another attempt", async (t) => {
  const { claimDesignerTask, failDesignerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  const detail = await failDesignerTask({
    workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation,
    ownerToken: grant.ownerToken, reason: "依赖服务不可用", blocked: true,
  });

  assert.equal(detail.item.status, "blocked");
  assert.equal(detail.item.phase, "intake", "failed claim relinquishes the design phase");
  assert.equal(detail.item.revision, 3);
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].reason, "依赖服务不可用");

  const events = await readEvents(ws, key);
  const failed = events.find((event) => event.type === "delivery.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.actor, "agent");
  assert.equal(failed.data.reason, "依赖服务不可用");
  assert.equal(failed.data.blocked, true);
});

test("three consecutive failures pause automation; resume resets the streak window; budget scope is per item", async (t) => {
  const { claimDesignerTask, failDesignerTask, resumeAutomation } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { listDesignerPool } = await import("./pool.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const failOnce = async (index) => {
    const { grant } = await claimDesignerTask({
      workspacePath: ws, key, sessionId: `sess-${index}`, requestId: `req-${index}`,
    });
    await failDesignerTask({
      workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation,
      ownerToken: grant.ownerToken, reason: `boom ${index}`,
    });
    return grant.generation;
  };
  const generations = [await failOnce(0), await failOnce(1), await failOnce(2)];
  assert.deepEqual(generations, [1, 2, 3], "failed items are claimable again with a fresh generation");

  // 第三次失败触发暂停文件（reason 如实说窗口）+ 事件。
  const paused = attempts.readPaused(itemPath);
  assert.ok(paused, "automation-paused.json written at the budget cap");
  assert.equal(paused.count, 3);
  assert.match(paused.reason, /3 since last resume/);
  const events = await readEvents(ws, key);
  const pauseEvent = events.find((event) => event.type === "delivery.automation_paused");
  assert.ok(pauseEvent);
  assert.equal(pauseEvent.data.count, 3);

  // 暂停后池子挡住 + claim 拒绝（automation-paused）。
  assert.deepEqual((await listDesignerPool(ws)).ready, []);
  await assert.rejects(
    claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-9", requestId: "req-9" }),
    (error) => error instanceof WorkItemValidationError && /automation-paused/.test(error.message),
  );

  // resumeAutomation（actor=user）：清暂停 + 写失败窗口（since=now）+ 事件；
  // 未暂停再 resume → Validation（路由层映射 400——plan T8）。
  // 2ms 间隔保证窗口起点与第三条失败的时间戳严格分离（同毫秒会 >= 命中）。
  await new Promise((resolve) => setTimeout(resolve, 2));
  const resumeStartedAt = new Date().toISOString();
  const resumed = await resumeAutomation(ws, key);
  const resumeEndedAt = new Date().toISOString();
  assert.equal(attempts.readPaused(itemPath), null);
  const window = attempts.readFailureWindow(itemPath);
  assert.ok(window, "failure window recorded at resume time");
  assert.ok(window.since >= resumeStartedAt && window.since <= resumeEndedAt,
    "window.since is the resume timestamp");
  const poolAfterResume = await listDesignerPool(ws);
  assert.deepEqual(poolAfterResume.ready.map((entry) => entry.key), [key],
    "streak window reset at resume — item claimable again (fix-round ruling #1)");
  assert.equal(poolAfterResume.blocked.length, 0);
  await assert.rejects(
    resumeAutomation(ws, key),
    (error) => error instanceof WorkItemValidationError && /not paused/.test(error.message),
    "resume when not paused is a Validation error",
  );
  const resumedEvent = (await readEvents(ws, key)).find((event) => event.type === "delivery.resumed");
  assert.ok(resumedEvent);
  assert.equal(resumedEvent.actor, "user");
  assert.equal(resumed.item.key, key);

  // resume 后连胜重置：第 4 次失败只计 1（不暂停），凑满 3 次才再暂停。
  const gen4 = await failOnce(3);
  assert.equal(gen4, 4);
  assert.equal(attempts.readPaused(itemPath), null, "4th failure after resume counts as 1 — not paused");
  await failOnce(4);
  await failOnce(5);
  const repaused = attempts.readPaused(itemPath);
  assert.ok(repaused, "paused again only after 3 MORE failures since the resume");
  assert.equal(repaused.count, 3);
  assert.match(repaused.reason, /3 since last resume/);

  // fix-round 裁定 #2：预算作用域 = 单项。另一个 README 完全相同（digest 相同）
  // 的项不受本项失败/暂停影响——仍可领。
  await writeItem(ws, { key: "REQ-0002", slug: "beta", title: "Beta" });
  const pool = await listDesignerPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0002"]);
  const other = await claimDesignerTask({
    workspacePath: ws, key: "REQ-0002", sessionId: "sess-b1", requestId: "req-b1",
  });
  assert.equal(other.grant.generation, 1);
});

// ---------------------------------------------------------------- 7. heartbeat

test("heartbeatActiveClaim renews only the owning session", async (t) => {
  const { heartbeatActiveClaim } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-hb-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const itemPath = join(ws, ".pi", "work-items", "requirements", "REQ-0001-alpha");
  await mkdir(itemPath, { recursive: true });

  const state = {
    attemptId: "01JHB0000000000000000000", generation: 2, role: "designer", sessionId: "sess-1",
    claimedAt: "2026-10-24T00:00:00Z", lastSeenAt: "2026-10-24T00:00:00Z",
    requirementDigest: "d", ownerTokenHash: "a".repeat(64),
    lastRequest: { requestId: "req-1", at: "2026-10-24T00:00:00Z" },
  };
  attempts.writeClaim(itemPath, state);

  assert.equal(await heartbeatActiveClaim(ws, itemPath, "sess-other"), false);
  assert.equal(attempts.readClaim(itemPath).lastSeenAt, "2026-10-24T00:00:00Z", "foreign session renews nothing");

  assert.equal(await heartbeatActiveClaim(ws, itemPath, "sess-1"), true);
  const renewed = attempts.readClaim(itemPath);
  assert.ok(renewed.lastSeenAt > "2026-10-24T00:00:00Z", "lastSeenAt advanced");
  assert.equal(renewed.attemptId, state.attemptId, "attemptId written back as-is");
  assert.equal(renewed.generation, state.generation, "generation written back as-is");
});

// -------------------------------------------------------- 8. recordInterruption

test("recordInterruption records a needsAttention attempt, clears the claim; idempotent; foreign session no-op", async (t) => {
  const { claimDesignerTask, recordInterruption } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });

  // 他人 sessionId → no-op（claim 原样）。
  await recordInterruption(ws, key, "sess-other", "误报");
  assert.ok(attempts.readClaim(itemPath));

  await recordInterruption(ws, key, "sess-1", "host shutdown");
  assert.equal(attempts.readClaim(itemPath), null, "claim cleared by the interruption");
  const pending = await attempts.listPendingInterruptions(itemPath);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attemptId, grant.attemptId);
  assert.equal(pending[0].outcome, "interrupted");
  assert.equal(pending[0].needsAttention, true);

  const events = await readEvents(ws, key);
  const interrupted = events.find((event) => event.type === "delivery.exec_interrupted");
  assert.ok(interrupted);
  assert.equal(interrupted.data.reason, "host shutdown");

  // 幂等：claim 已清 → 再记 no-op（不追加第二份审计）。
  await recordInterruption(ws, key, "sess-1", "again");
  assert.equal((await attempts.listPendingInterruptions(itemPath)).length, 1);
});

test("runtime dir layout after claim: only claim.json (+ gitignore wiring), attempts only after endings", async (t) => {
  const { claimDesignerTask } = await import("./claim.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);
  await claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1" });

  const runtimeNames = await readdir(join(itemPath, "delivery", "runtime"));
  assert.deepEqual(runtimeNames, ["claim.json"]);
  await assert.rejects(readdir(join(itemPath, "delivery", "attempts")), /ENOENT/, "no audit dir until an attempt ends");
});
