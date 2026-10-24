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
//
// Phase-3 Task 3（developer 领取事务，§9-§11）：
//   9. happy claim / 幂等重放 / 并发互斥 / 三新谓词拒绝 / prepareWorktrees
//      失败=零状态（真 git 仓登记进假 manifest，T2 手法）
//  10. submit：真 sha 过（candidates 入 item.yaml、verification 清、phase 流转、
//      attempt submitted 携 worktrees）；假 sha 400；范围外 repo 400；设计编辑 /
//      清 designConfirmed / 人推进阶段（record-verification 后）→ 409 冲突
//  11. fail 回退与不回退守卫；失败计数跨角色（designer 2 + developer 1 = 暂停）
//
// Phase-4 Task 3（verifier 领取事务，§14-§18）：
//  14. happy claim（detached checkout 落盘/candidateDigest 快照/checkContexts
//      冻结（repositoryId 缺省解析为候选首仓）/checkResults 空仓/phase 不变）/
//      幂等重放 / 并发互斥 / no-checks-configured 与 wrong-phase 拒绝 /
//      checkout 失败零状态（伪 sha → git checkout 拒绝）
//  15. submit：全 passed → release_ready + delivery.verification（actor=agent +
//      evidence 从 claim.checkContexts 冻结命令组装）；有 failed → M2 rework 四清
//      + 回 ready_for_implementation + delivery.rework_suggested；缺检查名 → 400；
//      unverified → 400 零变化（最终口径：submit 是终局动作，环境问题重跑或
//      fail(blocked)，不静默 blocked）；候选被换 → 409；领取后配置变更不追溯
//      （完整性比对按 claim.checkContexts 快照）
//  16. recordCheckResult：归属校验 / 同名覆盖 / 新名追加（heartbeat 习语）
//  17. fail blocked：phase 不动（verification→verification）、claim 清、
//      attempt failed（role verifier）
//  18. recordInterruption 对 verifier 零阶段变化（status 归还、phase 守卫跳过）、
//      恢复后可再领（generation 递增）
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { contentDigest } from "../delivery-types.ts";
import { WorkItemConflictError, WorkItemValidationError } from "../errors.ts";

const RUNTIME_GITIGNORE_ENTRY = ".pi/work-items/**/delivery/runtime/";
const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

// ---------------------------------------------------------------- fixture

function repoYaml({ id, path, status = "active" }) {
  return [
    `  - id: ${id}`,
    `    alias: ${id}`,
    `    name: ${id.toUpperCase()}`,
    "    kind: code",
    `    path: ${path}`,
    `    status: ${status}`,
  ].join("\n");
}

async function writeManifest(
  root,
  capabilities = ["sessions", "explorer", "work-items", "workflows"],
  repositories = [],
) {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "workspace.yaml"),
    [
      "schema_version: 1",
      "id: 01TESTWORKSPACE00000000000",
      "slug: test-ws",
      'name: "Test WS"',
      "skills: []",
      ...(repositories.length > 0
        ? ["repositories:", ...repositories.map(repoYaml)]
        : ["repositories: []"]),
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

/** delivery 块的 designConfirmed 行（camelCase 原样序列化——M2 T1 裁定）。 */
const designConfirmedYaml = (requirementDigest, designDigest) => [
  "  designConfirmed:",
  '    at: "2026-10-24T00:00:00Z"',
  "    actor: user",
  `    requirementDigest: "${requirementDigest}"`,
  `    designDigest: "${designDigest}"`,
];

const itemYaml = ({
  key,
  title,
  priority = "P1",
  status = "open",
  phase = "intake",
  managed = true,
  repositories = [],
  deliveryExtra = [],
}) =>
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
    `repositories: [${repositories.join(", ")}]`,
    "tags: []",
    "conversations: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    "archived_at: null",
    `created_at: "2026-10-24T00:00:00Z"`,
    `updated_at: "2026-10-24T00:00:00Z"`,
    ...(managed ? [...managedDeliveryYaml, ...deliveryExtra] : []),
    "",
  ].join("\n");

async function writeItem(root, { key, slug, title, readme = "Alpha body\n", design, ...rest }) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, title, ...rest }), "utf8");
  await writeFile(join(dir, "README.md"), readme, "utf8");
  await writeFile(join(dir, "events.jsonl"), "", "utf8");
  if (design !== undefined) {
    await mkdir(join(dir, "delivery", "artifacts"), { recursive: true });
    await writeFile(join(dir, "delivery", "artifacts", "design.md"), design, "utf8");
  }
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

/** 真 git 仓（T2 手法）：init + user config + 一个文件一次 commit；返回 HEAD sha。 */
async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "--initial-branch=main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "hello.txt"), "hello\n", "utf8");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** 锁外手改 item.yaml（模拟「人的手」在领取窗口内动作）：读 → mutate → 写回，
 *  revision 原样保留。 */
async function rewriteItem(ws, key, mutate) {
  const { readWorkItem, serializeWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  const next = structuredClone(detail.item);
  mutate(next);
  await writeFile(join(detail.path, "item.yaml"), serializeWorkItem(next), "utf8");
  return next;
}

/** developer 领取的标准工作区：真 git 仓登记进 manifest + enabled 配置 +
 * 一个 managed ready_for_implementation 项（designConfirmed 双 digest 绑定 +
 * 仓库范围 + design.md 落盘）。 */
async function makeDeveloperWorkspace(t, {
  repoIds = ["repo-a"],
  itemRepositories,
  designConfirmed = true,
  phase = "ready_for_implementation",
} = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-dev-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repos = [];
  for (const id of repoIds) {
    const sha = await initGitRepo(join(ws, id));
    repos.push({ id, sha });
  }
  await writeManifest(ws, undefined, repos.map((repo) => ({ id: repo.id, path: repo.id })));
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  const readme = "Dev body\n";
  const designContent = "# 设计：Dev item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const key = "REQ-0001";
  const itemPath = await writeItem(ws, {
    key,
    slug: "dev",
    title: "Dev item",
    readme,
    phase,
    repositories: itemRepositories ?? repos.map((repo) => repo.id),
    deliveryExtra: designConfirmed
      ? designConfirmedYaml(contentDigest(readme), contentDigest(designContent))
      : [],
    design: designConfirmed ? designContent : undefined,
  });
  return { ws, itemPath, key, readme, designContent, repos };
}

/** delivery 块的 candidates 行（camelCase 原样序列化——与 designConfirmed 同
 * 裁定；值加引号——全零/全一伪造 sha 会被 YAML 解析成数字）。 */
const candidatesYaml = (candidates) => [
  "  candidates:",
  ...candidates.map((candidate) => [
    `  - repositoryId: "${candidate.repositoryId}"`,
    `    commit: "${candidate.commit}"`,
  ].join("\n")),
];

/** verifier 领取的标准工作区：真 git 仓登记进 manifest + enabled 配置（含
 * verification.checks——null = 不写该键）+ 一个 managed verification 项
 * （designConfirmed 双 digest 绑定 + candidates 带真 commit + design.md 落盘）。 */
async function makeVerifierWorkspace(t, {
  repoIds = ["repo-a"],
  checks = [{ name: "build", command: "echo build-ok" }],
  candidates,
  phase = "verification",
  status = "open",
} = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-ver-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repos = [];
  for (const id of repoIds) {
    const sha = await initGitRepo(join(ws, id));
    repos.push({ id, sha });
  }
  await writeManifest(ws, undefined, repos.map((repo) => ({ id: repo.id, path: repo.id })));
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
    ...(checks !== null ? { verification: { checks } } : {}),
  });
  const readme = "Verify body\n";
  const designContent = "# 设计：Ver item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const key = "REQ-0001";
  const itemCandidates = candidates ?? repos.map((repo) => ({ repositoryId: repo.id, commit: repo.sha }));
  const itemPath = await writeItem(ws, {
    key,
    slug: "ver",
    title: "Ver item",
    readme,
    phase,
    status,
    repositories: repos.map((repo) => repo.id),
    deliveryExtra: [
      ...designConfirmedYaml(contentDigest(readme), contentDigest(designContent)),
      ...candidatesYaml(itemCandidates),
    ],
    design: designContent,
  });
  return { ws, itemPath, key, readme, designContent, repos, candidates: itemCandidates };
}

/** recordCheckResult 直写证据的最小合法 CheckEvidence（服务端 runConfiguredCheck
 * 产物的形状；测试不经执行器直接累积——执行器自有 checks.test.mjs 覆盖）。 */
const evidenceFor = (name, outcome, overrides = {}) => ({
  name,
  outcome,
  exitCode: outcome === "unverified" ? null : outcome === "passed" ? 0 : 1,
  durationMs: 12,
  logRef: `delivery/artifacts/verification-logs/01J/${name}.log`,
  ...overrides,
});

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
  const { listDeliveryPool } = await import("./pool.ts");
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
  assert.deepEqual((await listDeliveryPool(ws)).ready, []);
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
  const poolAfterResume = await listDeliveryPool(ws);
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
  const pool = await listDeliveryPool(ws);
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

// ==================================================== 9. developer claim (T3)

test("claimDeveloperTask happy path: worktree prepared & recorded, phase flow, designDigest snapshot, event", async (t) => {
  const { claimDeveloperTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key, readme, designContent, repos } = await makeDeveloperWorkspace(t);

  const { grant, replayed } = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
  });
  assert.equal(replayed, false);
  assert.match(grant.attemptId, /^[0-9A-Z]{26}$/, "attemptId is a ULID");
  assert.equal(grant.generation, 1);
  assert.ok(grant.ownerToken.length > 0, "fresh grant carries the plaintext ownerToken");

  // item 状态：phase ready_for_implementation→implementation / in_progress / revision+1。
  assert.equal(grant.item.item.phase, "implementation");
  assert.equal(grant.item.item.status, "in_progress");
  assert.equal(grant.item.item.revision, 2);

  // claim.json：role developer、designDigest 锁内自算快照（T1 carried ruling）、
  // worktrees 入 claim、requirementDigest 绑定 README。
  const claim = attempts.readClaim(itemPath);
  assert.equal(claim.attemptId, grant.attemptId);
  assert.equal(claim.role, "developer");
  assert.equal(claim.requirementDigest, contentDigest(readme));
  assert.equal(claim.designDigest, contentDigest(designContent), "designDigest snapshotted from the design.md bytes in-lock");
  assert.equal(claim.ownerTokenHash, attempts.hashOwnerToken(grant.ownerToken));
  assert.equal(claim.worktrees.length, 1);
  const [worktree] = claim.worktrees;
  assert.equal(worktree.repositoryId, repos[0].id);
  assert.equal(worktree.branch, "pi-delivery/REQ-0001/gen1");
  assert.ok(existsSync(worktree.path), "worktree actually exists on disk");

  // 事件：delivery.claimed（actor=agent）带 phase 流转 + worktrees。
  const events = await readEvents(ws, key);
  const claimed = events.find((event) => event.type === "delivery.claimed");
  assert.ok(claimed, "delivery.claimed event appended");
  assert.equal(claimed.actor, "agent");
  assert.deepEqual(claimed.data.phase, { from: "ready_for_implementation", to: "implementation" });
  assert.equal(claimed.data.generation, 1);
  assert.equal(claimed.data.worktrees.length, 1);
  assert.equal(claimed.data.worktrees[0].path, worktree.path);
});

test("developer claim replay: same requestId returns the existing grant, empty ownerToken, no state writes", async (t) => {
  const { claimDeveloperTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeDeveloperWorkspace(t);

  const first = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
  });
  const replay = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.grant.attemptId, first.grant.attemptId);
  assert.equal(replay.grant.generation, first.grant.generation);
  assert.equal(replay.grant.ownerToken, "", "replay cannot resurrect the plaintext token");
  assert.equal(replay.grant.item.item.revision, 2, "revision untouched by replay");
  assert.equal(replay.grant.item.item.phase, "implementation");

  const events = await readEvents(ws, key);
  assert.equal(events.filter((event) => event.type === "delivery.claimed").length, 1);
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "replay writes no attempt record");
});

test("two concurrent developer claims on one key: exactly one grant, the other is a Conflict", async (t) => {
  const { claimDeveloperTask } = await import("./claim.ts");
  const { ws, key } = await makeDeveloperWorkspace(t);

  const results = await Promise.allSettled([
    claimDeveloperTask({ workspacePath: ws, key, sessionId: "dev-a", requestId: "dev-req-a" }),
    claimDeveloperTask({ workspacePath: ws, key, sessionId: "dev-b", requestId: "dev-req-b" }),
  ]);
  const grants = results.filter((result) => result.status === "fulfilled");
  const conflicts = results.filter((result) => result.status === "rejected");
  assert.equal(grants.length, 1, "exactly one claim wins");
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].reason instanceof WorkItemConflictError);
  assert.match(conflicts[0].reason.message, /active claim/i);
});

test("developer claim re-verifies the three new predicates (and the role split) in the transaction", async (t) => {
  const { claimDeveloperTask } = await import("./claim.ts");
  const rejectsValidation = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemValidationError,
        `expected WorkItemValidationError, got ${error?.name}: ${error?.message}`);
      assert.match(error.message, pattern);
      return true;
    });

  // design-unconfirmed：ready_for_implementation 但无 designConfirmed。
  {
    const { ws, key } = await makeDeveloperWorkspace(t, { designConfirmed: false });
    await rejectsValidation(
      claimDeveloperTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /design-unconfirmed/,
    );
  }
  // no-repo-scope：仓库范围为空。
  {
    const { ws, key } = await makeDeveloperWorkspace(t, { itemRepositories: [] });
    await rejectsValidation(
      claimDeveloperTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /no-repo-scope/,
    );
  }
  // repo-not-registered：范围里的 repositoryId 不在 manifest 登记表。
  {
    const { ws, key } = await makeDeveloperWorkspace(t, { itemRepositories: ["repo-x"] });
    await rejectsValidation(
      claimDeveloperTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /repo-not-registered/,
    );
  }
  // 角色分派：intake 项投影为 designer-ready——developer 领取被拒。
  {
    const { ws, key } = await makeDeveloperWorkspace(t, { phase: "intake", designConfirmed: false });
    await rejectsValidation(
      claimDeveloperTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /designer role, not developer/,
    );
  }
});

test("prepareWorktrees failure aborts the developer claim with zero state writes", async (t) => {
  const { claimDeveloperTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-dev-zero-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // 登记仓指向非 git 目录：池子谓词过（登记在册且 active），worktree 预建在
  // 真实 git 层失败（getRepoRoot rev-parse 抛）。
  await mkdir(join(ws, "broken"), { recursive: true });
  await writeFile(join(ws, "broken", "plain.txt"), "not a repo\n", "utf8");
  await writeManifest(ws, undefined, [{ id: "repo-broken", path: "broken" }]);
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1, enabled: true, roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  const readme = "Zero body\n";
  const design = "# 设计：Zero\n";
  const key = "REQ-0001";
  const itemPath = await writeItem(ws, {
    key, slug: "zero", title: "Zero", readme, repositories: ["repo-broken"], phase: "ready_for_implementation",
    deliveryExtra: designConfirmedYaml(contentDigest(readme), contentDigest(design)), design,
  });

  await assert.rejects(
    claimDeveloperTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
    (error) => error instanceof WorkItemValidationError && /worktree preparation failed/.test(error.message),
  );
  // 零状态：无 claim、无事件、item.yaml 原样、runtime/ gitignore 未接线。
  assert.equal(attempts.readClaim(itemPath), null);
  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "ready_for_implementation");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 1);
  assert.deepEqual(detail.events, []);
  await assert.rejects(readFile(join(ws, ".gitignore")), /ENOENT/, "gitignore wiring not reached");
});

// ==================================================== 10. developer submit (T3)

test("submitDeveloperResult verifies candidates, records them, clears verification, phase→verification", async (t) => {
  const { claimDeveloperTask, submitDeveloperResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key, repos } = await makeDeveloperWorkspace(t);

  const { grant } = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
  });
  const submit = (candidates, extra = {}) => submitDeveloperResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    candidates, ...extra,
  });

  // 真 sha 过：candidates 入 item.yaml、verification 清、phase→verification、
  // status→open、revision+1、conversationId 自链接。
  const detail = await submit(
    [{ repositoryId: repos[0].id, commit: repos[0].sha }],
    { notes: "首轮实现", conversationId: "conv-dev" },
  );
  assert.equal(detail.item.phase, "verification");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  assert.deepEqual(
    detail.item.delivery.candidates,
    [{ repositoryId: repos[0].id, commit: repos[0].sha }],
  );
  assert.equal(detail.item.delivery.verification, undefined, "any prior verification pass is cleared");
  assert.ok(detail.item.conversations.includes("conv-dev"));

  // claim 清 + attempt submitted 落审计（candidates + worktrees 从 claim 拷贝）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].role, "developer");
  assert.deepEqual(records[0].candidates, [{ repositoryId: repos[0].id, commit: repos[0].sha }]);
  assert.equal(records[0].worktrees.length, 1);

  // 事件：delivery.submitted（actor=agent）带 attemptId/generation/candidates/notes。
  const events = await readEvents(ws, key);
  const submitted = events.find((event) => event.type === "delivery.submitted");
  assert.ok(submitted);
  assert.equal(submitted.actor, "agent");
  assert.equal(submitted.data.attemptId, grant.attemptId);
  assert.equal(submitted.data.generation, grant.generation);
  assert.deepEqual(submitted.data.candidates, [{ repositoryId: repos[0].id, commit: repos[0].sha }]);
  assert.equal(submitted.data.notes, "首轮实现");
});

test("submit rejects fake commits and out-of-scope repositories (400, zero state)", async (t) => {
  const { claimDeveloperTask, submitDeveloperResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  // repo-b 已登记但不在项范围（不在预建 worktree 集）→ 范围外候选。
  const { ws, itemPath, key, repos } = await makeDeveloperWorkspace(t, {
    repoIds: ["repo-a", "repo-b"],
    itemRepositories: ["repo-a"],
  });

  const { grant } = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
  });
  const submit = (candidates) => submitDeveloperResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    candidates,
  });

  // 假 sha：不是该仓的 commit → Validation。
  await assert.rejects(
    submit([{ repositoryId: "repo-a", commit: "0".repeat(40) }]),
    (error) => error instanceof WorkItemValidationError
      && /not a commit in repository repo-a/.test(error.message),
  );
  // 范围外 repo：repo-b 有真 commit 但不在预建集 → Validation。
  await assert.rejects(
    submit([{ repositoryId: "repo-b", commit: repos[1].sha }]),
    (error) => error instanceof WorkItemValidationError
      && /unknown repository repo-b/.test(error.message),
  );
  // 校验失败零状态：claim 仍在、阶段未动。
  assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  const { readWorkItem } = await import("../service.ts");
  assert.equal((await readWorkItem(ws, key)).item.phase, "implementation");
});

test("submit is a Conflict after a human edits the design, clears designConfirmed, or advances the phase", async (t) => {
  const { claimDeveloperTask, submitDeveloperResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const rejectsConflict = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemConflictError,
        `expected WorkItemConflictError, got ${error?.name}: ${error?.message}`);
      assert.match(error.message, pattern);
      return true;
    });

  const submitWith = async (wsPath, keyVal, grant, candidates = []) => submitDeveloperResult({
    workspacePath: wsPath, key: keyVal,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    candidates,
  });

  // ① 领取后 design.md 被人编辑 → designDigest 漂移 → 409。
  {
    const { ws, itemPath, key, repos } = await makeDeveloperWorkspace(t);
    const { grant } = await claimDeveloperTask({
      workspacePath: ws, key, sessionId: "s", requestId: "r",
    });
    await writeFile(join(itemPath, "delivery", "artifacts", "design.md"), "# 设计：被人改过\n", "utf8");
    await rejectsConflict(
      submitWith(ws, key, grant, [{ repositoryId: repos[0].id, commit: repos[0].sha }]),
      /input changed since claim/,
    );
    assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  }
  // ② 领取后人清掉 designConfirmed（阶段原地不动）→ 409。
  {
    const { ws, itemPath, key, repos } = await makeDeveloperWorkspace(t);
    const { grant } = await claimDeveloperTask({
      workspacePath: ws, key, sessionId: "s", requestId: "r",
    });
    await rewriteItem(ws, key, (item) => {
      delete item.delivery.designConfirmed;
    });
    await rejectsConflict(
      submitWith(ws, key, grant, [{ repositoryId: repos[0].id, commit: repos[0].sha }]),
      /input changed since claim/,
    );
    assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  }
  // ③ 领取后人推进了阶段（record-verification 之后项已到 release_ready）→
  //    迟到的提交不得覆写新状态 → 409。
  {
    const { ws, key, repos } = await makeDeveloperWorkspace(t);
    const { grant } = await claimDeveloperTask({
      workspacePath: ws, key, sessionId: "s", requestId: "r",
    });
    await rewriteItem(ws, key, (item) => {
      item.phase = "release_ready";
    });
    await rejectsConflict(
      submitWith(ws, key, grant, [{ repositoryId: repos[0].id, commit: repos[0].sha }]),
      /stale|phase/,
    );
    const { readWorkItem } = await import("../service.ts");
    assert.equal((await readWorkItem(ws, key)).item.phase, "release_ready",
      "human-advanced phase not clobbered by the stale submit");
  }
});

// ====================================================== 11. developer fail (T3)

test("failDeveloperTask rewinds implementation only when the phase is still implementation", async (t) => {
  const { claimDeveloperTask, failDeveloperTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeDeveloperWorkspace(t);

  // 正常失败：phase 回 ready_for_implementation、blocked 标志、claim 清、
  // attempt failed（role developer + worktrees 从 claim 拷贝）。
  const first = await claimDeveloperTask({ workspacePath: ws, key, sessionId: "s1", requestId: "r1" });
  const detail = await failDeveloperTask({
    workspacePath: ws, key,
    attemptId: first.grant.attemptId, generation: first.grant.generation,
    ownerToken: first.grant.ownerToken, reason: "构建失败", blocked: true,
  });
  assert.equal(detail.item.phase, "ready_for_implementation", "failed claim relinquishes the implementation phase");
  assert.equal(detail.item.status, "blocked");
  assert.equal(detail.item.revision, 3);
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].role, "developer");
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].reason, "构建失败");
  assert.equal(records[0].worktrees.length, 1, "failed attempt carries the claim's worktrees");
  const failedEvent = (await readEvents(ws, key)).find((event) => event.type === "delivery.attempt_failed");
  assert.ok(failedEvent);
  assert.equal(failedEvent.actor, "agent");
  assert.equal(failedEvent.data.role, "developer", "failure event carries the role");

  // 守卫：人 rework 把阶段挪到 design（领取窗口内）→ 失败不回滚阶段。
  const second = await claimDeveloperTask({ workspacePath: ws, key, sessionId: "s2", requestId: "r2" });
  assert.equal(second.grant.generation, 2, "generation continues after a failed attempt");
  await rewriteItem(ws, key, (item) => {
    item.phase = "design";
  });
  const detail2 = await failDeveloperTask({
    workspacePath: ws, key,
    attemptId: second.grant.attemptId, generation: second.grant.generation,
    ownerToken: second.grant.ownerToken, reason: "迟到失败",
  });
  assert.equal(detail2.item.phase, "design", "no rewind when the human moved the phase");
  assert.equal(detail2.item.status, "open");
  assert.equal(attempts.readClaim(itemPath), null);
});

test("failure budget is cross-role: two designer failures + one developer failure pause automation", async (t) => {
  const {
    claimDesignerTask, failDesignerTask, claimDeveloperTask, failDeveloperTask,
  } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-xrole-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await initGitRepo(join(ws, "repo-a"));
  await writeManifest(ws, undefined, [{ id: "repo-a", path: "repo-a" }]);
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1, enabled: true, roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  const readme = "Cross-role body\n";
  const key = "REQ-0001";
  const itemPath = await writeItem(ws, {
    key, slug: "xrole", title: "XR", readme, repositories: ["repo-a"],
  });

  // 两轮 designer 失败（intake→design→失败回 intake）——同一 README digest。
  for (const index of [0, 1]) {
    const { grant } = await claimDesignerTask({
      workspacePath: ws, key, sessionId: `d${index}`, requestId: `dr-${index}`,
    });
    await failDesignerTask({
      workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation,
      ownerToken: grant.ownerToken, reason: `design boom ${index}`,
    });
  }
  assert.equal(attempts.readPaused(itemPath), null, "2 failures below the cap of 3");

  // 人推进到 ready_for_implementation：design.md 落盘 + designConfirmed 双绑定。
  const designContent = "# 设计：XR\n\n## 方案\n方案 A\n";
  await mkdir(join(itemPath, "delivery", "artifacts"), { recursive: true });
  await writeFile(join(itemPath, "delivery", "artifacts", "design.md"), designContent, "utf8");
  await rewriteItem(ws, key, (item) => {
    item.phase = "ready_for_implementation";
    item.delivery = {
      ...item.delivery,
      designConfirmed: {
        at: "2026-10-24T00:00:00Z",
        actor: "user",
        requirementDigest: contentDigest(readme),
        designDigest: contentDigest(designContent),
      },
    };
  });

  // 第三次失败来自 developer——预算按 digest 跨角色计数 → 达上限暂停。
  const { grant } = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-1", requestId: "devr-1",
  });
  assert.equal(grant.generation, 3, "generation continues across roles");
  await failDeveloperTask({
    workspacePath: ws, key, attemptId: grant.attemptId, generation: grant.generation,
    ownerToken: grant.ownerToken, reason: "impl boom",
  });
  const paused = attempts.readPaused(itemPath);
  assert.ok(paused, "cross-role streak reached the cap — automation paused");
  assert.equal(paused.count, 3);
  assert.match(paused.reason, /3 since last resume/);
  const events = await readEvents(ws, key);
  assert.ok(events.find((event) => event.type === "delivery.automation_paused"));
  await assert.rejects(
    claimDeveloperTask({ workspacePath: ws, key, sessionId: "dev-2", requestId: "devr-2" }),
    (error) => error instanceof WorkItemValidationError && /automation-paused/.test(error.message),
  );
});

// ============================== 12. cancelled-item guard (Phase-3 final review)
//
// 活动领取期间人 cancel（M2 cancel 只写 status=cancelled，phase/digest/
// designConfirmed 不动）→ 迟到的 submit/fail 不得复活终态项：共享
// requireActiveClaim 的守卫统一覆盖四个 submit/fail（designer+developer）；
// 409 零状态——claim 原样保留，恢复路径 recordInterruption 仍可清掉残留
// claim（它不经过 requireActiveClaim，不受守卫影响）。

test("late submit/fail on a human-cancelled item is a Conflict; the claim survives for recordInterruption", async (t) => {
  const {
    claimDesignerTask, submitDesignerResult, failDesignerTask,
    claimDeveloperTask, submitDeveloperResult, recordInterruption,
  } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const rejectsConflict = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemConflictError,
        `expected WorkItemConflictError, got ${error?.name}: ${error.message}`);
      assert.match(error.message, pattern);
      return true;
    });

  // designer 路径：领取窗口内人 cancel → 迟到 submit 与 fail 都 409。
  {
    const { ws, itemPath, key } = await makeWorkspace(t);
    const { grant } = await claimDesignerTask({
      workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
    });
    await rewriteItem(ws, key, (item) => {
      item.status = "cancelled"; // M2 cancel：只写 status，phase/digest/designConfirmed 不动
    });

    await rejectsConflict(
      submitDesignerResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
        designContent: "迟到设计", acceptanceCriteria: ["迟到的验收"], requestId: "req-late",
      }),
      /cancelled while the claim was active/,
    );
    await rejectsConflict(
      failDesignerTask({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
        reason: "迟到失败",
      }),
      /cancelled while the claim was active/,
    );

    // 409 零状态：claim 仍在（恢复路径可清）、cancelled 终态不被复活、
    // 无新 attempt 审计、无新事件、revision 不动。
    assert.ok(attempts.readClaim(itemPath), "claim survives the rejected submit/fail");
    const detail = await readWorkItem(ws, key);
    assert.equal(detail.item.status, "cancelled", "cancelled terminal status not resurrected");
    assert.equal(detail.item.phase, "design", "phase untouched");
    assert.equal(detail.item.revision, 2, "no revision bump from rejected calls");
    assert.deepEqual(await attempts.listAttempts(itemPath), [], "no attempt audit from rejected calls");
    assert.equal(detail.events.length, 1, "only the original delivery.claimed event remains");

    // 恢复路径不受守卫影响：recordInterruption 仍能清掉已取消项的残留 claim。
    await recordInterruption(ws, key, "sess-1", "host shutdown");
    assert.equal(attempts.readClaim(itemPath), null, "interruption clears the stale claim");
  }

  // developer 路径（finding 的触发面——30 分钟执行窗口）：同样 409 零状态。
  {
    const { ws, itemPath, key, repos } = await makeDeveloperWorkspace(t);
    const { grant } = await claimDeveloperTask({
      workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
    });
    await rewriteItem(ws, key, (item) => {
      item.status = "cancelled";
    });
    await rejectsConflict(
      submitDeveloperResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
        candidates: [{ repositoryId: repos[0].id, commit: repos[0].sha }],
      }),
      /cancelled while the claim was active/,
    );
    assert.ok(attempts.readClaim(itemPath), "developer claim survives the rejected submit");
    const detail = await readWorkItem(ws, key);
    assert.equal(detail.item.status, "cancelled", "cancelled terminal status not resurrected");
    assert.equal(detail.item.phase, "implementation", "late submit does not advance the phase");
  }
});

// ====================== 13. interruption give-back (Phase-3 final fix, runtime-proven)
//
// recordInterruption 只清 claim 不归还领取借走的状态：item 停留 in_progress
//（池白名单 {open, blocked} 排除——terminal-status）且 claim 推进的阶段不回退
//（design→intake / implementation→rfi 缺失——wrong-phase），人 recover 解除
// 中断门禁后 dispatcher 仍永不重派。修复与 fail 的终态写对称：status=in_progress
// 复位 open + claim 推进的阶段退回可领阶段（人的中途状态不回滚），中断恢复后
// 项回到可领队列（池投影 + 真领取事务双向断言）。

test("recordInterruption returns the designer claim state; the recovered item is claimable again", async (t) => {
  const { claimDesignerTask, recordInterruption } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  let detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "in_progress");
  assert.equal(detail.item.phase, "design");

  await recordInterruption(ws, key, "sess-1", "execution timeout");

  detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "open", "claim-borrowed in_progress reset to open");
  assert.equal(detail.item.phase, "intake", "claim-advanced phase returned to intake");
  assert.equal(detail.item.revision, grant.item.item.revision + 1, "exactly one revision bump");
  const interrupted = detail.events.find((event) => event.type === "delivery.exec_interrupted");
  assert.ok(interrupted);
  assert.deepEqual(interrupted.data.status, { from: "in_progress", to: "open" });
  assert.deepEqual(interrupted.data.phase, { from: "design", to: "intake" });

  // 幂等：claim 已清 → 再记 no-op（revision 不再动、无第二份审计）。
  await recordInterruption(ws, key, "sess-1", "again");
  assert.equal((await readWorkItem(ws, key)).item.revision, grant.item.item.revision + 1);
  assert.equal((await attempts.listPendingInterruptions(itemPath)).length, 1);

  // 人 recover（清 needsAttention）→ 池子重新投影 ready，真领取事务可再领
  //（generation 2 从 attempt 审计推导）。
  await attempts.resolveInterruptions(itemPath, {
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T12:00:00Z", actor: "user" },
  });
  const { listDeliveryPool } = await import("./pool.ts");
  const pool = await listDeliveryPool(ws);
  const entry = [...pool.ready, ...pool.blocked].find((candidate) => candidate.key === key);
  assert.ok(entry.ready, `item back in the claimable pool — reasons: ${entry.reasons.join(", ")}`);
  assert.equal(entry.role, "designer");

  const second = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-2", requestId: "req-2",
  });
  assert.equal(second.replayed, false);
  assert.equal(second.grant.generation, grant.generation + 1, "next generation from the attempt audit");
});

test("recordInterruption returns the developer claim state: implementation→ready_for_implementation, in_progress→open", async (t) => {
  const { claimDeveloperTask, recordInterruption } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeDeveloperWorkspace(t);

  const { grant } = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-1", requestId: "dev-req-1",
  });
  await recordInterruption(ws, key, "dev-sess-1", "execution timeout");

  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.phase, "ready_for_implementation");
  assert.equal(detail.item.revision, grant.item.item.revision + 1, "exactly one revision bump");

  await attempts.resolveInterruptions(itemPath, {
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T12:00:00Z", actor: "user" },
  });
  const { listDeliveryPool } = await import("./pool.ts");
  const pool = await listDeliveryPool(ws);
  const entry = [...pool.ready, ...pool.blocked].find((candidate) => candidate.key === key);
  assert.ok(entry.ready, `recovered developer item claimable — reasons: ${entry.reasons.join(", ")}`);
  assert.equal(entry.role, "developer");

  const second = await claimDeveloperTask({
    workspacePath: ws, key, sessionId: "dev-sess-2", requestId: "dev-req-2",
  });
  assert.equal(second.grant.generation, grant.generation + 1);
});

test("recordInterruption preserves non-in_progress statuses; terminal cancelled item is not churned", async (t) => {
  const { claimDesignerTask, recordInterruption } = await import("./claim.ts");
  const { readWorkItem } = await import("../service.ts");

  // blocked：人的 blocked 标志保留（白名单内仍可领），claim 阶段照常归还。
  {
    const { ws, key } = await makeWorkspace(t);
    await claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1" });
    await rewriteItem(ws, key, (item) => {
      item.status = "blocked"; // 人在领取窗口内 block（block 不动 phase）
    });
    await recordInterruption(ws, key, "sess-1", "host shutdown");
    const detail = await readWorkItem(ws, key);
    assert.equal(detail.item.status, "blocked", "human blocked flag preserved");
    assert.equal(detail.item.phase, "intake", "claim phase still returned (blocked stays claimable)");
  }

  // cancelled：终态人已接管——status/phase/revision 全不动，只清 claim + 审计。
  {
    const { ws, key } = await makeWorkspace(t);
    await claimDesignerTask({ workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1" });
    await rewriteItem(ws, key, (item) => {
      item.status = "cancelled"; // M2 cancel：只写 status
    });
    await recordInterruption(ws, key, "sess-1", "host shutdown");
    const detail = await readWorkItem(ws, key);
    assert.equal(detail.item.status, "cancelled", "terminal status untouched");
    assert.equal(detail.item.phase, "design", "terminal item's phase not churned");
    assert.equal(detail.item.revision, 2, "no revision bump on the terminal item");
  }
});

// ============================================ 14. verifier claim (Phase-4 T3)

test("claimVerifierTask happy path: detached checkout prepared, candidateDigest + checkContexts frozen, phase unchanged", async (t) => {
  const { claimVerifierTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { candidatesDigest } = await import("../delivery-types.ts");
  // 选项里不能引用待解构的 repos（TDZ）——默认仓 id 是字面量 repo-a。
  const { ws, itemPath, key, readme, repos, candidates } = await makeVerifierWorkspace(t, {
    checks: [
      { name: "build", command: "echo build-ok" }, // repositoryId 缺省 → 解析为候选首仓
      { name: "lint", repositoryId: "repo-a", command: "echo lint-ok", timeout_seconds: 120 },
    ],
  });

  const { grant, replayed } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  assert.equal(replayed, false);
  assert.match(grant.attemptId, /^[0-9A-Z]{26}$/, "attemptId is a ULID");
  assert.equal(grant.generation, 1);
  assert.ok(grant.ownerToken.length > 0, "fresh grant carries the plaintext ownerToken");

  // item 状态：phase 不变（verification 是验证活动的阶段）、status in_progress、revision+1。
  assert.equal(grant.item.item.phase, "verification");
  assert.equal(grant.item.item.status, "in_progress");
  assert.equal(grant.item.item.revision, 2);

  // claim.json：role verifier、candidateDigest=candidatesDigest(当前候选)、
  // checkContexts 冻结（缺省 repositoryId 已解析）、checkResults 空仓、worktrees。
  const claim = attempts.readClaim(itemPath);
  assert.equal(claim.attemptId, grant.attemptId);
  assert.equal(claim.role, "verifier");
  assert.equal(claim.sessionId, "ver-sess-1");
  assert.equal(claim.requirementDigest, contentDigest(readme));
  assert.equal(claim.ownerTokenHash, attempts.hashOwnerToken(grant.ownerToken));
  assert.equal(claim.candidateDigest, candidatesDigest(candidates), "candidate snapshot at claim time");
  assert.deepEqual(claim.checkContexts, [
    { name: "build", repositoryId: repos[0].id, command: "echo build-ok" },
    { name: "lint", repositoryId: repos[0].id, command: "echo lint-ok", timeout_seconds: 120 },
  ], "checks config frozen with the default repositoryId resolved to the first candidate repo");
  assert.deepEqual(claim.checkResults, [], "evidence accumulator starts empty");
  assert.equal(claim.worktrees.length, 1);
  const [checkout] = claim.worktrees;
  assert.equal(checkout.repositoryId, repos[0].id);
  assert.equal(checkout.branch, "pi-verify/REQ-0001/gen1");
  assert.ok(existsSync(checkout.path), "verify checkout actually exists on disk");
  // detached checkout 检出到候选 commit。
  assert.equal(
    await git(checkout.path, ["rev-parse", "HEAD"]),
    candidates[0].commit,
    "checkout is detached at the candidate commit",
  );

  // 事件：delivery.claimed（actor=agent）phase from/to 同为 verification。
  const events = await readEvents(ws, key);
  const claimed = events.find((event) => event.type === "delivery.claimed");
  assert.ok(claimed, "delivery.claimed event appended");
  assert.equal(claimed.actor, "agent");
  assert.deepEqual(claimed.data.phase, { from: "verification", to: "verification" });
  assert.equal(claimed.data.generation, 1);
  assert.equal(claimed.data.worktrees.length, 1);
  assert.equal(claimed.data.candidateDigest, claim.candidateDigest);
});

test("verifier claim replay: same requestId returns the existing grant, empty ownerToken, no state writes", async (t) => {
  const { claimVerifierTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t);

  const first = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  const replay = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.grant.attemptId, first.grant.attemptId);
  assert.equal(replay.grant.generation, first.grant.generation);
  assert.equal(replay.grant.ownerToken, "", "replay cannot resurrect the plaintext token");
  assert.equal(replay.grant.item.item.revision, 2, "revision untouched by replay");
  assert.equal(replay.grant.item.item.phase, "verification");

  const events = await readEvents(ws, key);
  assert.equal(events.filter((event) => event.type === "delivery.claimed").length, 1);
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "replay writes no attempt record");
});

test("two concurrent verifier claims on one key: exactly one grant, the other is a Conflict", async (t) => {
  const { claimVerifierTask } = await import("./claim.ts");
  const { ws, key } = await makeVerifierWorkspace(t);

  const results = await Promise.allSettled([
    claimVerifierTask({ workspacePath: ws, key, sessionId: "ver-a", requestId: "ver-req-a" }),
    claimVerifierTask({ workspacePath: ws, key, sessionId: "ver-b", requestId: "ver-req-b" }),
  ]);
  const grants = results.filter((result) => result.status === "fulfilled");
  const conflicts = results.filter((result) => result.status === "rejected");
  assert.equal(grants.length, 1, "exactly one claim wins");
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].reason instanceof WorkItemConflictError);
  assert.match(conflicts[0].reason.message, /active claim/i);
});

test("verifier claim re-verifies the verifier predicates in the transaction", async (t) => {
  const { claimVerifierTask } = await import("./claim.ts");
  const rejectsValidation = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemValidationError,
        `expected WorkItemValidationError, got ${error?.name}: ${error.message}`);
      assert.match(error.message, pattern);
      return true;
    });

  // no-checks-configured：配置无 verification.checks。
  {
    const { ws, key } = await makeVerifierWorkspace(t, { checks: null });
    await rejectsValidation(
      claimVerifierTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /no-checks-configured/,
    );
  }
  // wrong-phase：非 verification 阶段（intake 项按 designer 谓词投影）。
  {
    const { ws, key } = await makeVerifierWorkspace(t, { phase: "design" });
    await rejectsValidation(
      claimVerifierTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /wrong-phase/,
    );
  }
  // no-repo-scope：空候选（候选即 verifier 的仓范围）。
  {
    const { ws, key } = await makeVerifierWorkspace(t, { candidates: [] });
    await rejectsValidation(
      claimVerifierTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /no-repo-scope/,
    );
  }
  // design-unconfirmed：verification 阶段但无 designConfirmed。
  {
    const ws = await mkdtemp(join(tmpdir(), "pi-claim-ver-du-"));
    t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const sha = await initGitRepo(join(ws, "repo-a"));
    await writeManifest(ws, undefined, [{ id: "repo-a", path: "repo-a" }]);
    const { writeDeliveryRunnerConfig } = await import("./config.ts");
    await writeDeliveryRunnerConfig(ws, {
      schemaVersion: 1, enabled: true, roles: {},
      budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
      verification: { checks: [{ name: "build", command: "true" }] },
    });
    await writeItem(ws, {
      key: "REQ-0001", slug: "du", title: "DU", readme: "du\n",
      repositories: ["repo-a"], phase: "verification",
      deliveryExtra: candidatesYaml([{ repositoryId: "repo-a", commit: sha }]),
    });
    await rejectsValidation(
      claimVerifierTask({ workspacePath: ws, key: "REQ-0001", sessionId: "s", requestId: "r" }),
      /design-unconfirmed/,
    );
  }
});

test("verify checkout failure aborts the verifier claim with zero state writes", async (t) => {
  const { claimVerifierTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  // 伪 sha：池子谓词不看 commit 真伪（结构合法即可），checkout --detach 在真实
  // git 层失败（rev-parse 不出该 commit）。
  const { ws, itemPath, key } = await makeVerifierWorkspace(t, {
    candidates: [{ repositoryId: "repo-a", commit: "0".repeat(40) }],
  });

  await assert.rejects(
    claimVerifierTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
    (error) => error instanceof WorkItemValidationError && /verify checkout failed/.test(error.message),
  );
  // 零状态：无 claim、无事件、item.yaml 原样、runtime/ gitignore 未接线。
  assert.equal(attempts.readClaim(itemPath), null);
  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "verification");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 1);
  assert.deepEqual(detail.events, []);
  await assert.rejects(readFile(join(ws, ".gitignore")), /ENOENT/, "gitignore wiring not reached");
});

// ============================================ 15. verifier submit (Phase-4 T3)

test("submitVerifierResult all passed: release_ready + verification block with agent evidence", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { candidatesDigest } = await import("../delivery-types.ts");
  const { ws, itemPath, key, readme, candidates } = await makeVerifierWorkspace(t, {
    checks: [
      { name: "build", command: "npm run build" },
      { name: "lint", repositoryId: "repo-a", command: "npm run lint", timeout_seconds: 60 },
    ],
  });

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  // 服务端累积两条 passed 证据（recordCheckResult 是唯一注入口——LLM 不能凭空补）。
  assert.equal(
    await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed", { durationMs: 40 })),
    true,
  );
  assert.equal(
    await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("lint", "passed")),
    true,
  );

  const detail = await submitVerifierResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    notes: "全部通过",
  });

  // 状态：phase release_ready、status open、revision+1；item.yaml 往返解析成功
  //（agent actor + evidence 块进入合法 schema）。
  assert.equal(detail.item.phase, "release_ready");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  const verification = detail.item.delivery.verification;
  assert.ok(verification, "verification block recorded");
  assert.equal(verification.actor, "agent");
  assert.equal(verification.requirementDigest, contentDigest(readme));
  assert.equal(verification.candidateDigest, candidatesDigest(candidates));
  assert.deepEqual(
    verification.checks.map((check) => check.name),
    ["build", "lint"],
    "evidence assembled in checkContexts order",
  );
  assert.equal(verification.checks[0].outcome, "passed");
  assert.deepEqual(verification.checks[0].evidence, {
    command: "npm run build", // command 来自 claim.checkContexts 冻结快照
    exitCode: 0,
    durationMs: 40,
    logRef: `delivery/artifacts/verification-logs/01J/build.log`,
  });
  assert.equal(verification.checks[1].evidence.command, "npm run lint");

  // claim 清 + attempt submitted（role verifier + verificationOutcome verified +
  // checkResults 从 claim 拷贝入审计）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].role, "verifier");
  assert.equal(records[0].verificationOutcome, "verified");
  assert.equal(records[0].checkResults.length, 2);

  // 事件：delivery.submitted（actor=agent，data.outcome=verified，data.checks 摘要）。
  const events = await readEvents(ws, key);
  const submitted = events.find((event) => event.type === "delivery.submitted");
  assert.ok(submitted);
  assert.equal(submitted.actor, "agent");
  assert.equal(submitted.data.outcome, "verified");
  assert.equal(submitted.data.checks.length, 2);
  assert.equal(submitted.data.checks[0].name, "build");
  assert.equal(submitted.data.notes, "全部通过");
});

test("submitVerifierResult with a failed check: M2 rework four-clear, back to ready_for_implementation, rework_suggested event", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t, {
    checks: [
      { name: "build", command: "npm run build" },
      { name: "test", command: "npm test" },
    ],
  });

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed"));
  await recordCheckResult(
    ws, key, "ver-sess-1",
    evidenceFor("test", "failed", { exitCode: 2, logRef: "delivery/artifacts/verification-logs/01J/test.log" }),
  );

  const detail = await submitVerifierResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
  });

  // M2 rework 四清 + 回 ready_for_implementation + status open。
  assert.equal(detail.item.phase, "ready_for_implementation");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.delivery.designConfirmed, undefined, "downstream evidence cleared: designConfirmed");
  assert.equal(detail.item.delivery.candidates, undefined, "downstream evidence cleared: candidates");
  assert.equal(detail.item.delivery.verification, undefined, "downstream evidence cleared: verification");
  assert.equal(detail.item.delivery.releasePlan, undefined, "downstream evidence cleared: releasePlan");

  // attempt：verifier 完成了验证任务（submitted）+ 判定标记 rework + 全量证据入审计。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].verificationOutcome, "rework");
  assert.equal(records[0].checkResults.length, 2, "full evidence preserved in the audit (claim is gone)");

  // 事件：delivery.rework_suggested（actor=agent，reason=verification-failed，
  // data.checks=失败条目摘要+logRef）。
  const events = await readEvents(ws, key);
  const rework = events.find((event) => event.type === "delivery.rework_suggested");
  assert.ok(rework, "delivery.rework_suggested event appended");
  assert.equal(rework.actor, "agent");
  assert.equal(rework.data.reason, "verification-failed");
  assert.deepEqual(rework.data.checks, [
    { name: "test", exitCode: 2, logRef: "delivery/artifacts/verification-logs/01J/test.log" },
  ], "only the failed entries are routed to the developer");
});

test("submitVerifierResult completeness gate: missing check name → 400; unknown evidence name → 400; both zero state", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t, {
    checks: [
      { name: "build", command: "npm run build" },
      { name: "test", command: "npm test" },
    ],
  });

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  // 只跑了 build——test 缺 → Validation。
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed"));
  await assert.rejects(
    submitVerifierResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    }),
    (error) => error instanceof WorkItemValidationError && /check test not run/.test(error.message),
  );
  // 零状态：claim 仍在（含已累积证据）、阶段未动、无 attempt、无 submitted 事件。
  assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  assert.equal(attempts.readClaim(itemPath).checkResults.length, 1);
  const { readWorkItem } = await import("../service.ts");
  let detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "verification");
  assert.deepEqual(await attempts.listAttempts(itemPath), []);
  assert.ok(!detail.events.find((event) => event.type === "delivery.submitted"));

  // 配置名跑齐 + 一条未知名的证据（不在 claim.checkContexts 里）→ 同样拒绝
  //（完整性门先查缺名——补齐 test 才能暴露未知名的分支）。
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("test", "passed"));
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("rogue", "passed"));
  await assert.rejects(
    submitVerifierResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    }),
    (error) => error instanceof WorkItemValidationError && /rogue/.test(error.message),
  );
  detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "verification");
});

test("submitVerifierResult with an unverified check: 400 with zero state changes (re-run or fail(blocked), never a silent blocked)", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t);
  const { readWorkItem } = await import("../service.ts");

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "unverified"));

  await assert.rejects(
    submitVerifierResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    }),
    (error) => error instanceof WorkItemValidationError
      && /build unverified/.test(error.message)
      && /delivery_run_check/.test(error.message),
  );

  // 零变化：claim 仍在、item.yaml 不动（status 仍 in_progress、无阶段推进）、无 attempt。
  const claim = attempts.readClaim(itemPath);
  assert.ok(claim, "claim survives — the verifier may re-run the check or fail(blocked)");
  assert.equal(claim.checkResults.length, 1);
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "in_progress");
  assert.equal(detail.item.phase, "verification");
  assert.deepEqual(await attempts.listAttempts(itemPath), []);

  // 重跑到 passed 后 submit 可正常通过（retry-in-place 语义）。
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed"));
  const done = await submitVerifierResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
  });
  assert.equal(done.item.phase, "release_ready");
});

test("submitVerifierResult is a Conflict when candidates changed since the claim (human rework/re-submit)", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key, repos } = await makeVerifierWorkspace(t);

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed"));

  // 领取后候选被换（人 rework 清候选重提交 / 手改 item.yaml）→ digest 漂移 → 409。
  await rewriteItem(ws, key, (item) => {
    item.delivery.candidates = [{ repositoryId: repos[0].id, commit: "1".repeat(40) }];
  });
  await assert.rejects(
    submitVerifierResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    }),
    (error) => error instanceof WorkItemConflictError && /candidates changed since the claim/.test(error.message),
  );
  // 零状态：claim 仍在（供 fail/中断释放）、阶段未动。
  assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  const { readWorkItem } = await import("../service.ts");
  assert.equal((await readWorkItem(ws, key)).item.phase, "verification");

  // 候选被人清空（rework 四清）→ digest 同样漂移 → 409。
  await rewriteItem(ws, key, (item) => {
    delete item.delivery.candidates;
  });
  await assert.rejects(
    submitVerifierResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    }),
    (error) => error instanceof WorkItemConflictError,
  );
});

test("submitVerifierResult validates against the frozen checkContexts — config changes after claim do not retro-apply", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  const { ws, key } = await makeVerifierWorkspace(t, {
    checks: [
      { name: "build", command: "npm run build" },
      { name: "lint", command: "npm run lint" },
    ],
  });

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });

  // 领取后人改配置：去掉 lint、加上 test、改 build 命令——本轮不追溯。
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1, enabled: true, roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
    verification: {
      checks: [
        { name: "build", command: "CHANGED COMMAND" },
        { name: "test", command: "npm test" },
      ],
    },
  });

  // 按冻结快照跑齐 build+lint → submit 过（新 test 不要求，命令用冻结值）。
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed"));
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("lint", "passed"));
  const detail = await submitVerifierResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
  });
  assert.equal(detail.item.phase, "release_ready");
  assert.equal(detail.item.delivery.verification.checks.length, 2,
    "completeness judged against the two frozen checks, not the rewritten config");
  assert.equal(detail.item.delivery.verification.checks[0].evidence.command, "npm run build",
    "command from the frozen snapshot, not the post-claim config edit");
  assert.ok(!detail.item.delivery.verification.checks.find((check) => check.name === "test"),
    "check added to the config after claim is not retro-required");
});

test("late verifier submit after a human advanced the phase is a Conflict", async (t) => {
  const { claimVerifierTask, submitVerifierResult, recordCheckResult } = await import("./claim.ts");
  const { ws, key } = await makeVerifierWorkspace(t);

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed"));
  // 人在领取窗口内手工 record-verification 推到 release_ready → 迟到提交不得覆写。
  await rewriteItem(ws, key, (item) => {
    item.phase = "release_ready";
    item.delivery.verification = {
      at: "2026-10-24T00:00:00Z",
      actor: "user",
      requirementDigest: "d".repeat(64),
      candidateDigest: "c".repeat(64),
      checks: [{ name: "build", outcome: "passed" }],
    };
  });
  await assert.rejects(
    submitVerifierResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    }),
    (error) => error instanceof WorkItemConflictError && /stale|phase/.test(error.message),
  );
  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "release_ready", "human-advanced phase not clobbered");
  assert.equal(detail.item.delivery.verification.actor, "user", "human verification record not clobbered");
});

// ============================================ 16. recordCheckResult (Phase-4 T3)

test("recordCheckResult: ownership gate, same-name overwrite, new-name append (heartbeat idiom)", async (t) => {
  const { claimVerifierTask, recordCheckResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t);

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });

  // 他人会话 → false，claim 原样。
  assert.equal(
    await recordCheckResult(ws, key, "sess-other", evidenceFor("build", "passed")),
    false,
  );
  assert.deepEqual(attempts.readClaim(itemPath).checkResults, []);

  // 新名追加。
  assert.equal(await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "failed", { exitCode: 1 })), true);
  let claim = attempts.readClaim(itemPath);
  assert.equal(claim.checkResults.length, 1);
  assert.equal(claim.checkResults[0].outcome, "failed");
  assert.equal(claim.attemptId, grant.attemptId, "attemptId written back as-is");

  // 同名覆盖（幂等重试语义）+ attemptId/generation 原样。
  assert.equal(await recordCheckResult(ws, key, "ver-sess-1", evidenceFor("build", "passed", { durationMs: 99 })), true);
  claim = attempts.readClaim(itemPath);
  assert.equal(claim.checkResults.length, 1, "same-name overwrite, not append");
  assert.equal(claim.checkResults[0].outcome, "passed");
  assert.equal(claim.checkResults[0].durationMs, 99);
  assert.equal(claim.generation, 1);
});

// ============================================ 17. verifier fail (Phase-4 T3)

test("failVerifierTask blocked: phase untouched (verification→verification), claim cleared, role-audited attempt", async (t) => {
  const { claimVerifierTask, failVerifierTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t);

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  const detail = await failVerifierTask({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation,
    ownerToken: grant.ownerToken, reason: "验证环境缺 Node 工具链", blocked: true,
  });

  // phase 不动（claim 不改阶段，失败也无阶段可归还）、status blocked。
  assert.equal(detail.item.phase, "verification", "verifier never moves the phase");
  assert.equal(detail.item.status, "blocked");
  assert.equal(detail.item.revision, 3);
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].role, "verifier");
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].reason, "验证环境缺 Node 工具链");
  assert.equal(records[0].worktrees.length, 1, "failed attempt carries the claim's checkouts");

  const events = await readEvents(ws, key);
  const failed = events.find((event) => event.type === "delivery.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.actor, "agent");
  assert.equal(failed.data.role, "verifier", "failure event carries the role");
  assert.equal(failed.data.reason, "验证环境缺 Node 工具链");
  assert.equal(failed.data.blocked, true);

  // blocked 仍在白名单内可再领（generation 递增）。
  const second = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-2", requestId: "ver-req-2",
  });
  assert.equal(second.grant.generation, 2);
});

// ================================ 18. verifier interruption give-back (Phase-4 T3)

test("recordInterruption on a verifier claim: status returned, phase untouched, recovered item claimable again", async (t) => {
  const { claimVerifierTask, recordInterruption } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeVerifierWorkspace(t);

  const { grant } = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  let detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "in_progress");
  assert.equal(detail.item.phase, "verification");

  await recordInterruption(ws, key, "ver-sess-1", "execution timeout");

  // status 归还（in_progress→open）、phase 零变化（verification→verification——
  // verifier claim 本就不改阶段）。
  detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "open", "claim-borrowed in_progress reset to open");
  assert.equal(detail.item.phase, "verification", "phase untouched — verifier has no phase to give back");
  assert.equal(detail.item.revision, grant.item.item.revision + 1, "exactly one revision bump");
  const interrupted = detail.events.find((event) => event.type === "delivery.exec_interrupted");
  assert.ok(interrupted);
  assert.deepEqual(interrupted.data.status, { from: "in_progress", to: "open" });
  assert.equal(interrupted.data.phase, undefined, "no phase give-back for the verifier role");

  // 幂等：claim 已清 → 再记 no-op。
  await recordInterruption(ws, key, "ver-sess-1", "again");
  assert.equal((await readWorkItem(ws, key)).item.revision, grant.item.item.revision + 1);
  assert.equal((await attempts.listPendingInterruptions(itemPath)).length, 1);

  // 人 recover → 池子重新投影 verifier-ready，真领取事务可再领（generation 递增）。
  await attempts.resolveInterruptions(itemPath, {
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T12:00:00Z", actor: "user" },
  });
  const { listDeliveryPool } = await import("./pool.ts");
  const pool = await listDeliveryPool(ws);
  const entry = [...pool.ready, ...pool.blocked].find((candidate) => candidate.key === key);
  assert.ok(entry.ready, `recovered verifier item claimable — reasons: ${entry.reasons.join(", ")}`);
  assert.equal(entry.role, "verifier");

  const second = await claimVerifierTask({
    workspacePath: ws, key, sessionId: "ver-sess-2", requestId: "ver-req-2",
  });
  assert.equal(second.replayed, false);
  assert.equal(second.grant.generation, grant.generation + 1, "next generation from the attempt audit");
});

test("verifier credentials cannot release a designer/developer claim and vice versa (role gate)", async (t) => {
  const { submitVerifierResult } = await import("./claim.ts");
  const { claimDesignerTask, claimDeveloperTask } = await import("./claim.ts");
  // designer 的 claim 不能被 verifier 凭据释放。
  {
    const { ws, key } = await makeVerifierWorkspace(t, { phase: "intake", checks: null });
    const { grant } = await claimDesignerTask({
      workspacePath: ws, key, sessionId: "d-1", requestId: "d-r",
    });
    await assert.rejects(
      submitVerifierResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      }),
      (error) => error instanceof WorkItemConflictError && /designer role/.test(error.message),
    );
  }
  // developer 的 claim 不能被 verifier 凭据释放。
  {
    const { ws, key } = await makeVerifierWorkspace(t, { phase: "ready_for_implementation", checks: null });
    const { grant } = await claimDeveloperTask({
      workspacePath: ws, key, sessionId: "dev-1", requestId: "dev-r",
    });
    await assert.rejects(
      submitVerifierResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      }),
      (error) => error instanceof WorkItemConflictError && /developer role/.test(error.message),
    );
  }
});
