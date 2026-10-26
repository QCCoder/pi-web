// final-arch step-3 Task 3: 引擎 system 检查步（checks-step.ts）。
// mkdtemp 真工作区 + 真 git 仓（候选 commit）直接驱动 checksDue / runChecksStep /
// checksCandidatesFor（dispatcher 的默认数据源）：
//   1. checksDue 全分支（每个 reason 独占命中 + 累积顺序 + review 门 + checks-done）
//   2. runChecksStep 全 passed：verification 记录（actor system、命令取自冻结
//      快照）+ release_ready + delivery.checks_passed + attempt（role system、
//      submitted、verificationOutcome verified）+ claim 清 + 零失败预算
//   3. 一条 failed：rework 四清回 ready_for_implementation + delivery.checks_failed
//      （携带失败条目）+ attempt verificationOutcome rework
//   4. unverified（注入 spawn-error 形状证据）：blocked + verification 不写 +
//      delivery.checks_unverified + attempt verificationOutcome unverified
//   5. 执行期间 system claim 在场（role system / status in_progress）——池子
//      active-claim 门的活数据；完成后 claim 清
//   6. 候选 digest 中途漂移 → skipped + claim 清 + 状态归还 open + 无结算事件
//   7. 人推进阶段后的迟到结算 → skipped 不覆写
//   8. 错误注入 → claim 清 + needsAttention 中断 + 状态归还 + exec_interrupted；
//      恢复后 generation 递增再跑
//   9. 不 due（欠审 / 无 checks / 非 managed）→ skipped 零写入
//  10. checksCandidatesFor：due 候选装配 + 运行时信号 + P0→P3→key 排序
// dispatcher 接入语义在 dispatcher.test.mjs（全假 deps）。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { candidatesDigest, contentDigest } from "../delivery-types.ts";

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

async function writeManifest(root, repositories = []) {
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
      "capabilities: [sessions, explorer, work-items, workflows]",
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

/** 真 git 仓（claim.test.mjs 同手法）：init + user config + 一个文件一次 commit。 */
async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "--initial-branch=main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "hello.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."], { env: { ...process.env, LC_ALL: "C" } });
  await git(dir, ["commit", "-q", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const managedDeliveryYaml = ["delivery:", "  protocolVersion: 1", "  mode: manual"];

const designConfirmedYaml = (requirementDigest, designDigest) => [
  "  designConfirmed:",
  '    at: "2026-10-24T00:00:00Z"',
  "    actor: user",
  `    requirementDigest: "${requirementDigest}"`,
  `    designDigest: "${designDigest}"`,
];

const candidatesYaml = (candidates) => [
  "  candidates:",
  ...candidates.map((candidate) => [
    `  - repositoryId: "${candidate.repositoryId}"`,
    `    commit: "${candidate.commit}"`,
  ].join("\n")),
];

const itemYaml = ({
  key,
  title,
  priority = "P1",
  status = "open",
  phase = "verification",
  managed = true,
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
    "repositories: [repo-a]",
    "tags: []",
    "conversations: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    "archived_at: null",
    'created_at: "2026-10-24T00:00:00Z"',
    'updated_at: "2026-10-24T00:00:00Z"',
    ...(managed ? [...managedDeliveryYaml, ...deliveryExtra] : []),
    "",
  ].join("\n");

async function writeItem(root, { key, slug, title, readme = "Check body\n", ...rest }) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, title, ...rest }), "utf8");
  await writeFile(join(dir, "README.md"), readme, "utf8");
  await writeFile(join(dir, "events.jsonl"), "", "utf8");
  return dir;
}

/** system 检查步的标准工作区：真 git 仓（候选 commit）登记进 manifest + enabled
 *  配置（含 verification.checks——null = 不写该键）+ 一个 managed verification
 *  项（designConfirmed + candidates 带真 commit）。reviewEnabled = true 时项欠审
 *  （无 review 判定）。 */
async function makeChecksWorkspace(t, {
  repoIds = ["repo-a"],
  checks = [{ name: "smoke", command: "true" }],
  candidates,
  reviewEnabled = false,
  phase = "verification",
  status = "open",
  priority = "P1",
} = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-checks-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repos = [];
  for (const id of repoIds) {
    const sha = await initGitRepo(join(ws, id));
    repos.push({ id, sha });
  }
  await writeManifest(ws, repos.map((repo) => ({ id: repo.id, path: repo.id })));
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
    ...(checks !== null ? { verification: { checks } } : {}),
    stages: { review: { enabled: reviewEnabled } },
  });
  const readme = "Check body\n";
  const designContent = "# 设计：Check item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const key = "REQ-0001";
  const itemCandidates = candidates ?? repos.map((repo) => ({ repositoryId: repo.id, commit: repo.sha }));
  const itemPath = await writeItem(ws, {
    key,
    slug: "check",
    title: "Check item",
    readme,
    phase,
    status,
    priority,
    deliveryExtra: [
      ...designConfirmedYaml(contentDigest(readme), contentDigest(designContent)),
      ...candidatesYaml(itemCandidates),
    ],
  });
  return { ws, itemPath, key, readme, repos, candidates: itemCandidates };
}

async function readEvents(ws, key) {
  const { readWorkItem } = await import("../service.ts");
  return (await readWorkItem(ws, key)).events;
}

/** 返工终态断言（Task 2 同款 helper——reviewer rework 与 system 检查失败必须
 *  落进完全相同的项状态：共享 reworkTransition 是唯一清单）。 */
function assertReworkState(detail, label) {
  assert.equal(detail.item.phase, "ready_for_implementation", `${label}: phase`);
  assert.equal(detail.item.status, "open", `${label}: status`);
  assert.equal(detail.item.delivery.designConfirmed, undefined, `${label}: designConfirmed cleared`);
  assert.equal(detail.item.delivery.candidates, undefined, `${label}: candidates cleared`);
  assert.equal(detail.item.delivery.verification, undefined, `${label}: verification cleared`);
  assert.equal(detail.item.delivery.releasePlan, undefined, `${label}: releasePlan cleared`);
}

/** 人工 unblock 的等价 store write（真 applyDeliveryAction("unblock") 需要
 *  workspaceId 注册表，临时工作区驱动不了——落点逐字段同构 delivery.ts 的
 *  unblock case：非 released 相位 → status in_progress + revision+1 +
 *  delivery.unblocked 事件）。 */
async function humanUnblock(ws, key) {
  const { readWorkItem, serializeWorkItem, writeAtomic, appendEvent, eventFor } =
    await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  const next = structuredClone(detail.item);
  next.status = "in_progress";
  next.revision += 1;
  next.updatedAt = new Date().toISOString();
  await writeAtomic(join(detail.path, "item.yaml"), serializeWorkItem(next));
  await appendEvent(
    detail.path,
    eventFor("delivery.unblock", "user", undefined, { phase: next.phase, revision: next.revision }),
  );
  return readWorkItem(ws, key);
}

/** 注入 runCheck 的通过证据（形状 = runConfiguredCheck 产物；真命令路径由
 *  all-passed 用例真跑覆盖）。 */
const passedEvidenceFor = (check) => ({
  name: check.name,
  exitCode: 0,
  durationMs: 1,
  logRef: `delivery/artifacts/verification-logs/x/${check.name}.log`,
  outcome: "passed",
});

// ==================================================== 1. checksDue (pure)

/** checksDue 侧最小 due 输入：verification 阶段 + 已确认设计 + 单候选 + 过审
 *  等价态（review 关闭）+ 单条检查 + repo-a active。 */
const dueItem = (over = {}) => ({
  key: "REQ-0001",
  title: "Check item",
  priority: "P1",
  status: "open",
  phase: "verification",
  archivedAt: null,
  repositories: ["repo-a"],
  requirementDigest: "digest-a",
  delivery: {
    protocolVersion: 1,
    mode: "manual",
    designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
    candidates: [{ repositoryId: "repo-a", commit: "abc123" }],
  },
  ...over,
});

const dueCtx = (over = {}) => ({
  enabled: true,
  activeClaims: new Set(),
  pendingInterruptions: new Set(),
  paused: new Set(),
  registeredRepos: new Map([["repo-a", "active"]]),
  checks: [{ name: "smoke", command: "true" }],
  reviewEnabled: false,
  ...over,
});

test("checksDue: the canonical due input is due with empty reasons", async () => {
  const { checksDue } = await import("./checks-step.ts");
  assert.deepEqual(checksDue(dueItem(), dueCtx()), { due: true, reasons: [] });
});

test("checksDue: each reason branch blocks exactly its own reason", async () => {
  const { checksDue } = await import("./checks-step.ts");
  const cases = [
    // 非 managed。
    ["not-managed", dueItem({ delivery: null }), dueCtx()],
    // 自动化总开关关闭。
    ["automation-disabled", dueItem(), dueCtx({ enabled: false })],
    // 非 verification 阶段。
    ["wrong-phase", dueItem({ phase: "release_ready" }), dueCtx()],
    // 空候选（候选即检查步的仓范围）。
    [
      "no-repo-scope",
      dueItem({ delivery: { protocolVersion: 1, mode: "manual" } }),
      dueCtx(),
    ],
    // checks 未配置（verification 键缺失）。
    ["checks-empty", dueItem(), dueCtx({ checks: undefined })],
    // checks 空数组（等同未配置）。
    ["checks-empty", dueItem(), dueCtx({ checks: [] })],
    // check 显式指向候选集外的仓。
    [
      "repo-not-registered",
      dueItem(),
      dueCtx({ checks: [{ name: "smoke", command: "true", repositoryId: "repo-9" }] }),
    ],
    // 缺省解析到候选首仓，但未登记。
    ["repo-not-registered", dueItem(), dueCtx({ registeredRepos: new Map() })],
    // 已登记但 removed。
    [
      "repo-not-registered",
      dueItem(),
      dueCtx({ registeredRepos: new Map([["repo-a", "removed"]]) }),
    ],
    // 活动领取。
    ["active-claim", dueItem(), dueCtx({ activeClaims: new Set(["REQ-0001"]) })],
    // 未确认中断。
    ["pending-interruption", dueItem(), dueCtx({ pendingInterruptions: new Set(["REQ-0001"]) })],
    // automation-paused。
    ["automation-paused", dueItem(), dueCtx({ paused: new Set(["REQ-0001"]) })],
    // 状态门（fix round 1，spec §5.3）：blocked = checks_unverified 的落点——
    // 硬停等人工 unblock（不自动重试、不 hammer 机器）。
    ["blocked-awaiting-unblock", dueItem({ status: "blocked" }), dueCtx()],
    // 其余非 open 状态沿用 terminal-status。
    ["terminal-status", dueItem({ status: "cancelled" }), dueCtx()],
    ["terminal-status", dueItem({ status: "done" }), dueCtx()],
    // 归档。
    ["archived", dueItem({ archivedAt: "2026-10-24T00:00:00Z" }), dueCtx()],
  ];
  for (const [reason, item, context] of cases) {
    const verdict = checksDue(item, context);
    assert.equal(verdict.due, false, `${reason} must block`);
    // not-managed 与 no-repo-scope 累积（delivery 块缺失 → 候选自然为空，多因
    // 并报不短路——池投影同习语）。
    const expected = reason === "not-managed" ? ["not-managed", "no-repo-scope"] : [reason];
    assert.deepEqual(verdict.reasons, expected, `${reason} reasons`);
  }
  // in_progress 是人工 unblock 的落点（delivery.ts unblock → 非 released 相位落
  // in_progress）——无 claim 即无并发面，解锁后立即可跑。
  assert.deepEqual(
    checksDue(dueItem({ status: "in_progress" }), dueCtx()),
    { due: true, reasons: [] },
    "post-unblock in_progress is due again (spec §5.3: unblock 即再次 due)",
  );
});

test("checksDue: review gate — disabled never pending; enabled needs a current-digest pass", async () => {
  const { checksDue } = await import("./checks-step.ts");
  const candidates = [{ repositoryId: "repo-a", commit: "abc123" }];
  const base = {
    protocolVersion: 1,
    mode: "manual",
    designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
    candidates,
  };
  const review = (over = {}) => ({
    outcome: "pass",
    notes: "通过",
    candidateDigest: candidatesDigest(candidates),
    at: "2026-10-24T00:06:00Z",
    attemptId: "01JCREVIEW0000000000000A",
    ...over,
  });
  // review 开启 + 无判定 → awaiting-review（先审后跑）。
  assert.deepEqual(
    checksDue(dueItem(), dueCtx({ reviewEnabled: true })).reasons,
    ["awaiting-review"],
  );
  // 开启 + pass 且 digest 与当前候选集一致 → due（过审交给系统步）。
  assert.deepEqual(
    checksDue(dueItem({ delivery: { ...base, review: review() } }), dueCtx({ reviewEnabled: true })),
    { due: true, reasons: [] },
  );
  // 开启 + pass 但候选被换（digest 不符）→ 回 reviewer 再审。
  assert.deepEqual(
    checksDue(
      dueItem({
        delivery: {
          ...base,
          review: review({ candidateDigest: candidatesDigest([{ repositoryId: "repo-a", commit: "new999" }]) }),
        },
      }),
      dueCtx({ reviewEnabled: true }),
    ).reasons,
    ["awaiting-review"],
  );
  // 开启 + rework 判定 → 欠审（rework 不是 pass）。
  assert.deepEqual(
    checksDue(
      dueItem({
        delivery: {
          ...base,
          review: review({ outcome: "rework", source: "code", notes: "实现缺陷" }),
        },
      }),
      dueCtx({ reviewEnabled: true }),
    ).reasons,
    ["awaiting-review"],
  );
});

test("checksDue: checks-done — a verification record bound to the current candidates blocks a rerun", async () => {
  const { checksDue } = await import("./checks-step.ts");
  const candidates = [{ repositoryId: "repo-a", commit: "abc123" }];
  const base = {
    protocolVersion: 1,
    mode: "manual",
    designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
    candidates,
  };
  // 同 digest 验证记录在场 → checks-done（该候选集已验证过）。
  assert.deepEqual(
    checksDue(
      dueItem({ delivery: { ...base, verification: { candidateDigest: candidatesDigest(candidates) } } }),
      dueCtx(),
    ).reasons,
    ["checks-done"],
  );
  // 候选被换（旧验证绑旧摘要）→ 记录失准 → 重新 due（developer 重提交的回归）。
  assert.deepEqual(
    checksDue(
      dueItem({
        delivery: {
          ...base,
          candidates: [{ repositoryId: "repo-a", commit: "new999" }],
          verification: { candidateDigest: candidatesDigest(candidates) },
        },
      }),
      dueCtx(),
    ),
    { due: true, reasons: [] },
  );
});

test("checksDue: violations accumulate in the canonical order without short-circuit", async () => {
  const { checksDue } = await import("./checks-step.ts");
  const verdict = checksDue(
    dueItem({ delivery: null, status: "cancelled", archivedAt: "2026-10-24T00:00:00Z" }),
    dueCtx({
      enabled: false,
      activeClaims: new Set(["REQ-0001"]),
      paused: new Set(["REQ-0001"]),
    }),
  );
  assert.deepEqual(verdict.reasons, [
    "not-managed",
    "automation-disabled",
    "no-repo-scope",
    "active-claim",
    "automation-paused",
    "terminal-status",
    "archived",
  ]);
});

// ============================================ 2-8. runChecksStep (real workspace)

test("runChecksStep all passed: verification (actor system) + release_ready + checks_passed + system attempt + claim cleared + no failure budget", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  // 两条检查：缺省仓解析 + 显式 repositoryId；命令真通过（/bin/true / exit 0）。
  const { ws, itemPath, key, readme, candidates } = await makeChecksWorkspace(t, {
    checks: [
      { name: "smoke", command: "true" },
      { name: "lint", repositoryId: "repo-a", command: "exit 0", timeout_seconds: 120 },
    ],
  });

  const outcome = await runChecksStep(ws, key);
  assert.equal(outcome, "verified");

  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  // 状态：phase release_ready、status open、revision+2（start + settle）。
  assert.equal(detail.item.phase, "release_ready");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  // 无会话自链接（system 无会话——conversations 保持空）。
  assert.deepEqual(detail.item.conversations, []);
  const verification = detail.item.delivery.verification;
  assert.ok(verification, "verification block recorded");
  assert.equal(verification.actor, "system", "system step lands the block as actor system");
  assert.equal(verification.requirementDigest, contentDigest(readme));
  assert.equal(verification.candidateDigest, candidatesDigest(candidates));
  assert.deepEqual(
    verification.checks.map((check) => check.name),
    ["smoke", "lint"],
    "evidence assembled in checkContexts order",
  );
  assert.equal(verification.checks[0].outcome, "passed");
  assert.equal(verification.checks[0].evidence.command, "true", "command from the frozen snapshot");
  assert.equal(verification.checks[0].evidence.exitCode, 0);
  assert.equal(verification.checks[1].evidence.command, "exit 0");
  assert.match(
    verification.checks[0].evidence.logRef,
    /^delivery\/artifacts\/verification-logs\/[0-9A-Z]{26}\/smoke\.log$/,
  );
  assert.ok(existsSync(join(itemPath, verification.checks[0].evidence.logRef)), "log written on disk");

  // claim 清 + attempt（role system、outcome submitted、verificationOutcome
  // verified、checkResults 全量入审计）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].role, "system");
  assert.match(records[0].sessionId, /^system:[0-9A-Z]{26}$/);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].verificationOutcome, "verified");
  assert.equal(records[0].checkResults.length, 2);

  // 事件：delivery.checks_started（actor system，data 带 attempt/generation/
  // candidateDigest）+ delivery.checks_passed（actor system）。
  const events = await readEvents(ws, key);
  const started = events.find((event) => event.type === "delivery.checks_started");
  assert.ok(started, "delivery.checks_started appended");
  assert.equal(started.actor, "system");
  assert.equal(started.data.attemptId, records[0].attemptId);
  assert.equal(started.data.generation, 1);
  assert.equal(started.data.candidateDigest, candidatesDigest(candidates));
  const passed = events.find((event) => event.type === "delivery.checks_passed");
  assert.ok(passed, "delivery.checks_passed appended");
  assert.equal(passed.actor, "system");
  assert.equal(passed.data.outcome, "verified");
  assert.deepEqual(passed.data.checks.map((check) => check.name), ["smoke", "lint"]);
  assert.ok(!events.some((event) => event.type === "delivery.submitted"),
    "system path does not emit the agent-path submitted event");

  // 零失败预算：outcome submitted 不计不断——无 failure-window、无暂停、零计数。
  assert.equal(existsSync(attempts.failureWindowFilePath(itemPath)), false, "no failure window");
  assert.equal(await attempts.countRecentFailures(itemPath, contentDigest(readme)), 0);
  assert.equal(attempts.readPaused(itemPath), null);
  assert.ok(!events.some((event) => event.type === "delivery.automation_paused"));

  // checks-done 门：同一候选集不再重跑（skipped 零写入）。
  const before = detail.item.revision;
  assert.equal(await runChecksStep(ws, key), "skipped");
  assert.equal((await readWorkItem(ws, key)).item.revision, before, "skipped run writes nothing");
});

test("runChecksStep with a failing check: rework four-clear back to ready_for_implementation + checks_failed", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  const { ws, itemPath, key } = await makeChecksWorkspace(t, {
    checks: [
      { name: "smoke", command: "true" },
      { name: "test", command: "exit 3" },
    ],
  });

  const outcome = await runChecksStep(ws, key);
  assert.equal(outcome, "rework");

  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  // M2 rework 四清 + 回 ready_for_implementation + status open（reviewer 打回
  // 与 verifier 失败的同一落点——assertReworkState 共用）。
  assertReworkState(detail, "checks-failed");
  assert.equal(detail.item.revision, 3);

  // attempt：submitted（完成了一轮检查步）+ verificationOutcome rework + 全量
  // 证据入审计。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records[0].role, "system");
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].verificationOutcome, "rework");
  assert.equal(records[0].checkResults.length, 2, "passed entries preserved in the audit too");

  // 事件：delivery.checks_failed（actor system，data 只带失败条目 + logRef）。
  const events = await readEvents(ws, key);
  const failed = events.find((event) => event.type === "delivery.checks_failed");
  assert.ok(failed, "delivery.checks_failed appended");
  assert.equal(failed.actor, "system");
  assert.equal(failed.data.reason, "verification-failed");
  assert.equal(failed.data.checks.length, 1);
  assert.equal(failed.data.checks[0].name, "test");
  assert.equal(failed.data.checks[0].exitCode, 3);
  assert.ok(failed.data.checks[0].logRef.includes("test.log"));

  // 无失败预算（判定不是失败）。
  assert.equal(existsSync(attempts.failureWindowFilePath(itemPath)), false);
  assert.equal(events.some((event) => event.type === "delivery.automation_paused"), false);
});

test("runChecksStep with an unverified check: blocked, verification NOT written, checks_unverified (environment, not failure)", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  const { ws, itemPath, key, readme } = await makeChecksWorkspace(t, {
    checks: [{ name: "smoke", command: "true" }],
  });
  // spawn-error 形状（checks.ts：ETIMEDOUT/ENOENT/ENOBUFS → exitCode null +
  // unverified）——deps 注入该分支（真 shell 里「命令不存在」是 127=failed，
  // 不是 unverified）。
  const outcome = await runChecksStep(ws, key, {
    runCheck: (check) => ({
      name: check.name,
      exitCode: null,
      durationMs: 5,
      logRef: `delivery/artifacts/verification-logs/x/${check.name}.log`,
      outcome: "unverified",
    }),
  });
  assert.equal(outcome, "unverified");

  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  // 环境问题：阶段不动、verification 不写、下游不清——只有 status blocked。
  assert.equal(detail.item.phase, "verification", "phase untouched");
  assert.equal(detail.item.status, "blocked");
  assert.equal(detail.item.delivery.verification, undefined, "verification NOT written");
  assert.equal(detail.item.delivery.candidates.length, 1, "downstream NOT cleared");
  assert.equal(detail.item.delivery.designConfirmed.at, "2026-10-24T00:00:00Z");
  assert.equal(detail.item.revision, 3);

  // attempt：submitted + verificationOutcome unverified（不是 failed——不计预算）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records[0].role, "system");
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].verificationOutcome, "unverified");

  // 事件：delivery.checks_unverified（data 带未验证检查名）。
  const events = await readEvents(ws, key);
  const unverified = events.find((event) => event.type === "delivery.checks_unverified");
  assert.ok(unverified, "delivery.checks_unverified appended");
  assert.equal(unverified.actor, "system");
  assert.deepEqual(unverified.data.checks, [{ name: "smoke" }]);

  // 零失败预算。
  assert.equal(existsSync(attempts.failureWindowFilePath(itemPath)), false);
  assert.equal(await attempts.countRecentFailures(itemPath, contentDigest(readme)), 0);

  // blocked 是硬停（fix round 1，spec §5.3）：再跑 → skipped，不产生第二轮
  // checks_started、不重复 attempt、claim 不再出现。
  assert.equal(await runChecksStep(ws, key), "skipped");
  const eventsAfterRetry = await readEvents(ws, key);
  assert.equal(
    eventsAfterRetry.filter((event) => event.type === "delivery.checks_started").length,
    1,
    "no automatic retry while blocked",
  );
  assert.equal(attempts.readClaim(itemPath), null);
  assert.equal((await attempts.listAttempts(itemPath)).length, 1);
  assert.equal(detail.item.revision, (await readWorkItem(ws, key)).item.revision,
    "skipped retry writes nothing");

  // 人修环境后 unblock（真 unblock 落点 in_progress——等价 store write 同构）
  // → 立即再次 due，下一轮真跑通过。
  await humanUnblock(ws, key);
  assert.equal(await runChecksStep(ws, key), "verified");
  const done = await readWorkItem(ws, key);
  assert.equal(done.item.phase, "release_ready");
  assert.equal(done.item.delivery.verification.actor, "system");
});

test("runChecksStep: system claim occupies the slot during execution (pool active-claim data), cleared after", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  const { ws, itemPath, key } = await makeChecksWorkspace(t);
  const during = {};
  const outcome = await runChecksStep(ws, key, {
    runCheck: (check) => {
      // 执行中快照（同步缝）：system claim 在场（池子 active-claim 门的活数据）
      // + item 已 in_progress + 冻结快照落盘。
      const claim = attempts.readClaim(itemPath);
      during.claim = claim && {
        role: claim.role,
        sessionId: claim.sessionId,
        generation: claim.generation,
        candidateDigest: claim.candidateDigest,
        checkContexts: claim.checkContexts,
        checkResults: claim.checkResults,
      };
      during.status = /status: (\w+)/.exec(readFileSync(join(itemPath, "item.yaml"), "utf8"))?.[1];
      return passedEvidenceFor(check);
    },
  });
  assert.equal(outcome, "verified");
  assert.ok(during.claim, "system claim present while checks run");
  assert.equal(during.claim.role, "system");
  assert.match(during.claim.sessionId, /^system:/);
  assert.equal(during.claim.generation, 1);
  assert.equal(during.claim.candidateDigest.length, 64);
  assert.deepEqual(during.claim.checkContexts, [
    { name: "smoke", repositoryId: "repo-a", command: "true" },
  ], "check contexts frozen from the config with the default repository resolved");
  assert.deepEqual(during.claim.checkResults, [], "evidence accumulator starts empty");
  assert.equal(during.status, "in_progress");
  // 完成后：claim 清（单槽位让出）。
  assert.equal(attempts.readClaim(itemPath), null);
});

test("runChecksStep: candidate digest drift mid-run → skipped, claim released, status given back, no settlement", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  const { ws, itemPath, key, candidates } = await makeChecksWorkspace(t, {
    checks: [
      { name: "smoke", command: "true" },
      { name: "lint", command: "true" },
    ],
  });
  const outcome = await runChecksStep(ws, key, {
    runCheck: (check) => {
      if (check.name === "lint") {
        // 第一条跑完后人换候选（同步改 item.yaml——runCheck 是同步缝）。
        const yaml = readFileSync(join(itemPath, "item.yaml"), "utf8");
        writeFileSync(join(itemPath, "item.yaml"), yaml.replace(candidates[0].commit, "f".repeat(40)), "utf8");
      }
      return passedEvidenceFor(check);
    },
  });
  assert.equal(outcome, "skipped");

  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  // 释放 + 状态归还（借走的 in_progress → open），无结算事件、无 attempt。
  assert.equal(attempts.readClaim(itemPath), null);
  assert.equal(detail.item.phase, "verification");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3, "start + give-back, no settlement revision");
  assert.equal(detail.item.delivery.candidates[0].commit, "f".repeat(40), "drifted candidates kept");
  const events = await readEvents(ws, key);
  assert.ok(events.some((event) => event.type === "delivery.checks_started"));
  assert.ok(
    !events.some((event) =>
      ["delivery.checks_passed", "delivery.checks_failed", "delivery.checks_unverified"].includes(event.type)),
    "no settlement event after drift",
  );
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "no attempt from a skipped run");
});

test("runChecksStep: late settlement after a human advanced the phase is skipped (no clobber)", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  const { ws, itemPath, key } = await makeChecksWorkspace(t);
  const outcome = await runChecksStep(ws, key, {
    runCheck: (check) => {
      // 人在检查执行窗口内手工 record-verification 推进阶段 + 落自己的验证记录
      // （同步改 item.yaml——「人的手」模拟）。
      const humanBlock = [
        "  verification:",
        '    at: "2026-10-24T01:00:00Z"',
        "    actor: user",
        `    requirementDigest: "${"d".repeat(64)}"`,
        `    candidateDigest: "${"c".repeat(64)}"`,
        "    checks:",
        "      - name: build",
        "        outcome: passed",
      ].join("\n");
      const yaml = readFileSync(join(itemPath, "item.yaml"), "utf8");
      writeFileSync(
        join(itemPath, "item.yaml"),
        yaml.replace("phase: verification", "phase: release_ready").replace("  candidates:", `${humanBlock}\n  candidates:`),
        "utf8",
      );
      return passedEvidenceFor(check);
    },
  });
  assert.equal(outcome, "skipped");
  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "release_ready", "human-advanced phase not clobbered");
  assert.equal(detail.item.delivery.verification.actor, "user", "human verification record kept");
  assert.equal(attempts.readClaim(itemPath), null);
  assert.equal(detail.item.status, "open");
});

test("runChecksStep: a thrown error releases the claim and records a needsAttention interruption; recovery re-runs with generation+1", async (t) => {
  const attempts = await import("./attempts.ts");
  const { runChecksStep } = await import("./checks-step.ts");
  const { ws, itemPath, key, readme } = await makeChecksWorkspace(t);
  await assert.rejects(
    runChecksStep(ws, key, {
      runCheck: () => {
        throw new Error("boom");
      },
    }),
    /boom/,
  );
  // claim 清 + needsAttention 中断（人「重新检查并恢复」）+ 状态归还。
  assert.equal(attempts.readClaim(itemPath), null);
  const pending = await attempts.listPendingInterruptions(itemPath);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].role, "system");
  assert.equal(pending[0].outcome, "interrupted");
  assert.equal(pending[0].reason, "checks step failed");
  assert.equal(pending[0].needsAttention, true);
  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "verification", "claim moved no phase — nothing to give back");
  assert.equal(detail.item.status, "open", "in_progress returned to open");
  const events = await readEvents(ws, key);
  const interrupted = events.find((event) => event.type === "delivery.exec_interrupted");
  assert.ok(interrupted, "exec_interrupted appended");
  assert.equal(interrupted.data.reason, "checks step failed");
  // 恢复后可再跑（generation 递增——attempt 审计是持久账本）。
  await attempts.resolveInterruptions(itemPath, {
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T12:00:00Z", actor: "user" },
  });
  assert.equal(await runChecksStep(ws, key), "verified");
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 2);
  assert.equal(records[1].generation, 2, "next generation from the attempt audit");
  assert.equal(
    await attempts.countRecentFailures(itemPath, contentDigest(readme)),
    0,
    "interrupted attempt neither counts nor breaks the streak",
  );
});

test("runChecksStep: not due (review pending / checks missing / not managed) → skipped with zero writes", async (t) => {
  const { runChecksStep } = await import("./checks-step.ts");
  // 欠审（review 开启无判定）→ skipped。
  {
    const { ws, key } = await makeChecksWorkspace(t, { reviewEnabled: true });
    assert.equal(await runChecksStep(ws, key), "skipped");
  }
  // 无 checks 配置 → skipped 且零写入（连 gitignore 接线都不触达）。
  {
    const { ws, key } = await makeChecksWorkspace(t, { checks: null });
    assert.equal(await runChecksStep(ws, key), "skipped");
    const { readWorkItem } = await import("../service.ts");
    const detail = await readWorkItem(ws, key);
    assert.equal(detail.item.revision, 1, "zero writes");
    assert.deepEqual(detail.events, [], "no events");
    assert.equal(existsSync(join(ws, ".gitignore")), false, "gitignore wiring not reached");
  }
  // 非 managed → skipped。
  {
    const ws = await mkdtemp(join(tmpdir(), "pi-checks-unmanaged-"));
    t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    await writeManifest(ws);
    const { writeDeliveryRunnerConfig } = await import("./config.ts");
    await writeDeliveryRunnerConfig(ws, {
      schemaVersion: 1, enabled: true, roles: {},
      budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
    });
    await writeItem(ws, { key: "REQ-0001", slug: "plain", title: "Plain", managed: false });
    assert.equal(await runChecksStep(ws, "REQ-0001"), "skipped");
  }
});

// ========================================== 10. checksCandidatesFor (dispatcher source)

test("checksCandidatesFor: assembles verification items with runtime signals, sorted P0→P3→key", async (t) => {
  const attempts = await import("./attempts.ts");
  const { checksCandidatesFor, checksDue } = await import("./checks-step.ts");
  // P2 主项 + P0 干扰项：排序按优先级（未知优先级不在本面）。
  const { ws, itemPath, key } = await makeChecksWorkspace(t, { priority: "P2" });
  await writeItem(ws, {
    key: "REQ-0002",
    slug: "ghost",
    title: "Ghost",
    priority: "P0",
    phase: "verification",
    deliveryExtra: designConfirmedYaml("d".repeat(64), "e".repeat(64)),
  });

  const candidates = await checksCandidatesFor(ws);
  assert.deepEqual(candidates.map((candidate) => candidate.key), ["REQ-0002", "REQ-0001"],
    "P0 before P2 (priority rank, then key)");

  const main = candidates.find((candidate) => candidate.key === key);
  assert.equal(main.priority, "P2");
  assert.equal(main.item.phase, "verification");
  assert.equal(main.item.delivery.candidates.length, 1);
  // 主项 due；信号全空。
  assert.deepEqual(checksDue(main.item, main.ctx), { due: true, reasons: [] });

  // 活动 claim → active-claim 进 ctx。
  attempts.writeClaim(itemPath, {
    attemptId: "01JD0SYSCHECK0000000001",
    generation: 1,
    role: "system",
    sessionId: "system:01JD0SYSCHECK0000000001",
    claimedAt: "2026-10-24T00:00:00Z",
    lastSeenAt: "2026-10-24T00:00:20Z",
    requirementDigest: contentDigest("Check body\n"),
    ownerTokenHash: "",
  });
  const duringMain = (await checksCandidatesFor(ws)).find((candidate) => candidate.key === key);
  assert.deepEqual(checksDue(duringMain.item, duringMain.ctx).reasons, ["active-claim"]);
  attempts.clearClaim(itemPath);

  // 未确认中断 → pending-interruption；paused → automation-paused。
  await attempts.writeAttempt({
    attemptId: "01JD0SYSPARK0000000001",
    generation: 2,
    role: "system",
    sessionId: "system:01JD0SYSPARK0000000001",
    workspacePath: ws,
    key,
    claimedAt: "2026-10-24T00:01:00Z",
    outcome: "interrupted",
    requirementDigest: contentDigest("Check body\n"),
    needsAttention: true,
  });
  attempts.writePaused(itemPath, { at: "2026-10-24T00:02:00Z", reason: "attention-parked", count: 0 });
  const parkedMain = (await checksCandidatesFor(ws)).find((candidate) => candidate.key === key);
  assert.deepEqual(checksDue(parkedMain.item, parkedMain.ctx).reasons, [
    "pending-interruption",
    "automation-paused",
  ]);

  // 非 verification 阶段项不进候选。
  const ws2 = await mkdtemp(join(tmpdir(), "pi-checks-scan-"));
  t.after(() => rm(ws2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeManifest(ws2);
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws2, {
    schemaVersion: 1, enabled: true, roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  await writeItem(ws2, { key: "REQ-0003", slug: "intake", title: "Intake", phase: "intake" });
  assert.deepEqual(await checksCandidatesFor(ws2), []);
});
