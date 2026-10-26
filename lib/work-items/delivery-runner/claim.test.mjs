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
//
// Phase-5 Task 1（release-preparer 领取事务，spec 2026-10-25-phase-five §2）：
//  19. happy claim（phase 不变 release_ready/candidateDigest 快照落盘/零环境
//      预建——无 worktrees/checkContexts/checkResults）/幂等重放/并发互斥/
//      verification-missing、stale-verification（候选被换）、wrong-phase 与
//      角色分派拒绝
//  20. submit：releasePlan 写入（notes 必填/rollback 可选——空白省略键）、
//      phase 保持 release_ready、status open、conversationId 自链接、
//      attempt.releasePlan 拷贝；release_notes 空 → 400；候选被换 → 409；
//      领取后 verification 被清 → 409；人 record-release 推进阶段 → 409
//  21. fail blocked：phase 不动（release_ready→release_ready）、claim 清、
//      attempt failed（role release-preparer）、blocked 仍可再领
//  22. recordInterruption 对 release-preparer 零阶段变化（status 归还、
//      phase from=to）、恢复后可再领（generation 递增）
//
// final-arch step-2 T2（ask-a-human 提问事务，§23）：
//  23. askHumanQuestion 四角色同形——phase 不动、status open、claim 清、澄清
//      全字段落盘、attempt asked、delivery.asked 事件、会话自链接、revision+1；
//      凭据不符/重放 409、role 与 claim.role 不符 409、cancel 后 409、question
//      空/options 坏形 400 零状态；预算不受影响（asked 不计不断、无 failure-
//      window、无暂停）；池 awaiting-answer 停车 + 人答复恢复（生命周期）
// final-arch step-3 T2（reviewer 三事务 + 共享返工过渡，§24）：
//  24. claimReviewerTask（先审后跑）：谓词全分支（review 关闭/无候选/已过审同
//      digest → 不可领；digest 漂移 → 可再领）/ checkout 预建 / candidateDigest
//      + checkContexts 冻结；submitReviewerResult pass（review 块、phase 不变、
//      status open、claim 清、delivery.reviewed 事件、自链接、attempt 携
//      review、零失败预算）；rework code → 与 verifier 失败路径完全同态
//      （assertReworkState 双侧共用）；rework spec → design；rework 缺 source /
//      notes 空 / pass 带 source / outcome 词表外 → 400；候选漂移与阶段守卫
//      409；fail 标准（phase 不动 + 预算计数）；finalizeChecks 源断言。
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

/** delivery 块的 review 行（final-arch step-3 T2；真实形状走 parseReview——
 *  rework 必带 source、pass 不带）。 */
const reviewYaml = (candidateDigest, { outcome = "pass", source, notes = "通过" } = {}) => [
  "  review:",
  `    outcome: ${outcome}`,
  ...(source ? [`    source: ${source}`] : []),
  `    notes: ${JSON.stringify(notes)}`,
  `    candidateDigest: "${candidateDigest}"`,
  '    at: "2026-10-24T00:06:00Z"',
  '    attemptId: "01JCREVIEW0000000000000A"',
];

/** reviewer 领取的标准工作区（verifier 同底 + stages.review 开关 + 可选 review
 *  块）：真 git 仓 + enabled 配置（含 verification.checks——reviewer claim 冻结
 *  同一份快照供 delivery_run_check 取配置）+ 一个 managed verification 项。
 *  review 参数：null（无 review——欠审）| { outcome, source?, notes?, digest? }。 */
async function makeReviewerWorkspace(t, {
  repoIds = ["repo-a"],
  checks = [{ name: "build", command: "echo build-ok" }],
  candidates,
  reviewEnabled = true,
  review = null,
  phase = "verification",
  status = "open",
} = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-rev-"));
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
    stages: { review: { enabled: reviewEnabled } },
  });
  const readme = "Review body\n";
  const designContent = "# 设计：Rev item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const key = "REQ-0001";
  const itemCandidates = candidates ?? repos.map((repo) => ({ repositoryId: repo.id, commit: repo.sha }));
  const { candidatesDigest } = await import("../delivery-types.ts");
  const itemPath = await writeItem(ws, {
    key,
    slug: "rev",
    title: "Rev item",
    readme,
    phase,
    status,
    repositories: repos.map((repo) => repo.id),
    deliveryExtra: [
      ...designConfirmedYaml(contentDigest(readme), contentDigest(designContent)),
      ...candidatesYaml(itemCandidates),
      ...(review
        ? reviewYaml(review.digest ?? candidatesDigest(itemCandidates), review)
        : []),
    ],
    design: designContent,
  });
  return { ws, itemPath, key, readme, designContent, repos, candidates: itemCandidates };
}

/** 返工终态断言（final-arch step-3 T2 binding）：reviewer rework(code) 与
 *  verifier 失败路径必须落进**完全相同**的项状态——共用这一个 helper。 */
function assertReworkState(detail, label) {
  assert.equal(detail.item.phase, "ready_for_implementation", `${label}: phase`);
  assert.equal(detail.item.status, "open", `${label}: status`);
  assert.equal(detail.item.delivery.designConfirmed, undefined, `${label}: designConfirmed cleared`);
  assert.equal(detail.item.delivery.candidates, undefined, `${label}: candidates cleared`);
  assert.equal(detail.item.delivery.verification, undefined, `${label}: verification cleared`);
  assert.equal(detail.item.delivery.releasePlan, undefined, `${label}: releasePlan cleared`);
}

/** delivery 块的 verification 行（Phase-5 release-preparer 谓词输入；
 *  candidateDigest 由调用方按候选集计算传入——真实形状走 parseVerification）。 */
const verificationYaml = (candidateDigest) => [
  "  verification:",
  '    at: "2026-10-24T00:05:00Z"',
  "    actor: agent",
  '    requirementDigest: "deadbeef"',
  `    candidateDigest: "${candidateDigest}"`,
  "    checks:",
  "      - name: build",
  "        outcome: passed",
];

/** release-preparer 领取的标准工作区：enabled 配置（无需 verification.checks——
 *  release-preparer 谓词不消费）+ 一个 managed release_ready 项（designConfirmed
 *  + candidates + verification 通过记录，candidateDigest 与候选集摘要一致）。
 *  纯文档角色：无 git 仓、无 checkout——谓词不看仓登记表，claim 不做任何环境
 *  预建。verification 参数："match"（默认，摘要按当前候选集算）| false（块
 *  整个不写）| 候选数组（按该集算摘要——造候选被换的 stale 态）。 */
async function makeReleasePreparerWorkspace(t, {
  candidates,
  verification = "match",
  phase = "release_ready",
  status = "open",
} = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-claim-rel-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeManifest(ws);
  const { writeDeliveryRunnerConfig } = await import("./config.ts");
  await writeDeliveryRunnerConfig(ws, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  const readme = "Release body\n";
  const designContent = "# 设计：Rel item\n\n## 方案\n方案 A\n\n## 验收条件\n- [ ] 冒烟通过\n";
  const key = "REQ-0001";
  const itemCandidates = candidates ?? [{ repositoryId: "repo-a", commit: "abc123" }];
  const { candidatesDigest } = await import("../delivery-types.ts");
  const digestCandidates = verification === "match" || verification === false
    ? itemCandidates
    : verification;
  const itemPath = await writeItem(ws, {
    key,
    slug: "rel",
    title: "Rel item",
    readme,
    phase,
    status,
    repositories: ["repo-a"],
    deliveryExtra: [
      ...designConfirmedYaml(contentDigest(readme), contentDigest(designContent)),
      ...candidatesYaml(itemCandidates),
      ...(verification !== false ? verificationYaml(candidatesDigest(digestCandidates)) : []),
    ],
    design: designContent,
  });
  return { ws, itemPath, key, readme, designContent, candidates: itemCandidates };
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
    conversationId: "ver-sess-1",
  });

  // 状态：phase release_ready、status open、revision+1；item.yaml 往返解析成功
  //（agent actor + evidence 块进入合法 schema）。
  assert.equal(detail.item.phase, "release_ready");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  // 会话自链接（fix round 1）：带 conversationId 的提交把会话挂入 conversations
  //（服务层不变式——详情「关联会话」由此可达，与 designer/developer 同款）。
  assert.ok(
    detail.item.conversations.includes("ver-sess-1"),
    "verifier session auto-linked into conversations",
  );
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

  // 事件：delivery.submitted（actor=agent，data.outcome=verified，data.checks 摘要；
  // conversationId 随事件携带——fix round 1）。
  const events = await readEvents(ws, key);
  const submitted = events.find((event) => event.type === "delivery.submitted");
  assert.ok(submitted);
  assert.equal(submitted.actor, "agent");
  assert.equal(submitted.conversationId, "ver-sess-1");
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
    conversationId: "ver-sess-1",
  });

  // M2 rework 四清 + 回 ready_for_implementation + status open。
  assertReworkState(detail, "verifier-failed");
  // 会话自链接（fix round 1）：rework 路径同样把会话挂入 conversations。
  assert.ok(
    detail.item.conversations.includes("ver-sess-1"),
    "verifier session auto-linked into conversations (rework path)",
  );
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

// ======================================= 19. release-preparer claim (Phase-5 T1)

test("claimReleasePreparerTask happy path: zero env prep, candidateDigest snapshot, phase unchanged", async (t) => {
  const { claimReleasePreparerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { candidatesDigest } = await import("../delivery-types.ts");
  const { ws, itemPath, key, readme, candidates } = await makeReleasePreparerWorkspace(t);

  const { grant, replayed } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  assert.equal(replayed, false);
  assert.match(grant.attemptId, /^[0-9A-Z]{26}$/, "attemptId is a ULID");
  assert.equal(grant.generation, 1);
  assert.ok(grant.ownerToken.length > 0, "fresh grant carries the plaintext ownerToken");

  // item 状态：phase 不变（release_ready 就是准备材料的阶段）、status in_progress、revision+1。
  assert.equal(grant.item.item.phase, "release_ready");
  assert.equal(grant.item.item.status, "in_progress");
  assert.equal(grant.item.item.revision, 2);

  // claim.json：role release-preparer、candidateDigest=candidatesDigest(当前候选)
  //（同 verifier 先例）；纯文档角色零环境预建——无 worktrees/checkContexts/checkResults。
  const claim = attempts.readClaim(itemPath);
  assert.equal(claim.attemptId, grant.attemptId);
  assert.equal(claim.role, "release-preparer");
  assert.equal(claim.sessionId, "rel-sess-1");
  assert.equal(claim.requirementDigest, contentDigest(readme));
  assert.equal(claim.ownerTokenHash, attempts.hashOwnerToken(grant.ownerToken));
  assert.equal(claim.candidateDigest, candidatesDigest(candidates), "candidate snapshot at claim time");
  assert.equal(claim.worktrees, undefined, "pure-document role prepares no worktrees");
  assert.equal(claim.checkContexts, undefined, "no check contexts to freeze");
  assert.equal(claim.checkResults, undefined, "no evidence accumulator");

  // 事件：delivery.claimed（actor=agent）phase from/to 同为 release_ready + candidateDigest。
  const events = await readEvents(ws, key);
  const claimed = events.find((event) => event.type === "delivery.claimed");
  assert.ok(claimed, "delivery.claimed event appended");
  assert.equal(claimed.actor, "agent");
  assert.deepEqual(claimed.data.phase, { from: "release_ready", to: "release_ready" });
  assert.equal(claimed.data.generation, 1);
  assert.equal(claimed.data.candidateDigest, claim.candidateDigest);
});

test("release-preparer claim replay: same requestId returns the existing grant, empty ownerToken, no state writes", async (t) => {
  const { claimReleasePreparerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);

  const first = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  const replay = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.grant.attemptId, first.grant.attemptId);
  assert.equal(replay.grant.generation, first.grant.generation);
  assert.equal(replay.grant.ownerToken, "", "replay cannot resurrect the plaintext token");
  assert.equal(replay.grant.item.item.revision, 2, "revision untouched by replay");
  assert.equal(replay.grant.item.item.phase, "release_ready");

  const events = await readEvents(ws, key);
  assert.equal(events.filter((event) => event.type === "delivery.claimed").length, 1);
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "replay writes no attempt record");
});

test("two concurrent release-preparer claims on one key: exactly one grant, the other is a Conflict", async (t) => {
  const { claimReleasePreparerTask } = await import("./claim.ts");
  const { ws, key } = await makeReleasePreparerWorkspace(t);

  const results = await Promise.allSettled([
    claimReleasePreparerTask({ workspacePath: ws, key, sessionId: "rel-a", requestId: "rel-req-a" }),
    claimReleasePreparerTask({ workspacePath: ws, key, sessionId: "rel-b", requestId: "rel-req-b" }),
  ]);
  const grants = results.filter((result) => result.status === "fulfilled");
  const conflicts = results.filter((result) => result.status === "rejected");
  assert.equal(grants.length, 1, "exactly one claim wins");
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].reason instanceof WorkItemConflictError);
  assert.match(conflicts[0].reason.message, /active claim/i);
});

test("release-preparer claim re-verifies the two new predicates (and the role split) in the transaction", async (t) => {
  const { claimReleasePreparerTask } = await import("./claim.ts");
  const rejectsValidation = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemValidationError,
        `expected WorkItemValidationError, got ${error?.name}: ${error.message}`);
      assert.match(error.message, pattern);
      return true;
    });

  // verification-missing：release_ready 但无验证通过记录。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t, { verification: false });
    await rejectsValidation(
      claimReleasePreparerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /verification-missing/,
    );
  }
  // stale-verification：候选被换（verification.candidateDigest 还是旧候选集的摘要）。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t, {
      candidates: [{ repositoryId: "repo-a", commit: "newsha999" }],
      verification: [{ repositoryId: "repo-a", commit: "abc123" }],
    });
    await rejectsValidation(
      claimReleasePreparerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /stale-verification/,
    );
  }
  // wrong-phase：非 release_ready 阶段（design 阶段按 designer 谓词投影）。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t, { phase: "design" });
    await rejectsValidation(
      claimReleasePreparerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /wrong-phase/,
    );
  }
  // 角色分派：intake 项投影为 designer-ready——release-preparer 领取被拒。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t, { phase: "intake" });
    await rejectsValidation(
      claimReleasePreparerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /designer role, not release-preparer/,
    );
  }
});

// ====================================== 20. release-preparer submit (Phase-5 T1)

test("submitReleasePreparerResult writes releasePlan, phase stays release_ready, self-links the conversation", async (t) => {
  const { claimReleasePreparerTask, submitReleasePreparerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);

  const { grant } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  const detail = await submitReleasePreparerResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    releaseNotes: "v1.2.0：新增导出、修复 3 处缺陷。验证结论见 delivery.verification。",
    rollbackNotes: "  回滚：git revert 候选集，重跑 build 检查。  ",
    conversationId: "rel-sess-1",
  });

  // releasePlan 写入（M2 prepare-release 形状）：notes 必填、rollback 可选且 trim。
  assert.deepEqual(detail.item.delivery.releasePlan, {
    notes: "v1.2.0：新增导出、修复 3 处缺陷。验证结论见 delivery.verification。",
    rollback: "回滚：git revert 候选集，重跑 build 检查。",
  });
  // 状态：phase 保持 release_ready 等人 record-release、status open、revision+1；
  // conversationId 自链接（designer 先例——详情「关联会话」由此可达）。
  assert.equal(detail.item.phase, "release_ready");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  assert.ok(detail.item.conversations.includes("rel-sess-1"));
  // 人工门不动：release 块仍缺席（record-release 是人的手）。
  assert.equal(detail.item.delivery.release, undefined);
  // item.yaml 往返解析成功（releasePlan 进入合法 schema）。
  const { readWorkItem } = await import("../service.ts");
  assert.deepEqual((await readWorkItem(ws, key)).item.delivery.releasePlan, {
    notes: "v1.2.0：新增导出、修复 3 处缺陷。验证结论见 delivery.verification。",
    rollback: "回滚：git revert 候选集，重跑 build 检查。",
  });

  // claim 清 + attempt submitted（role release-preparer + releasePlan 拷贝入审计）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].role, "release-preparer");
  assert.deepEqual(records[0].releasePlan, {
    notes: "v1.2.0：新增导出、修复 3 处缺陷。验证结论见 delivery.verification。",
    rollback: "回滚：git revert 候选集，重跑 build 检查。",
  });

  // 事件：delivery.submitted（actor=agent，data.outcome=release-plan，notes 摘要
  // + conversationId 随事件携带——designer/verifier 同款）。
  const events = await readEvents(ws, key);
  const submitted = events.find((event) => event.type === "delivery.submitted");
  assert.ok(submitted);
  assert.equal(submitted.actor, "agent");
  assert.equal(submitted.conversationId, "rel-sess-1");
  assert.equal(submitted.data.attemptId, grant.attemptId);
  assert.equal(submitted.data.generation, grant.generation);
  assert.equal(submitted.data.outcome, "release-plan");
  assert.equal(submitted.data.notes, "v1.2.0：新增导出、修复 3 处缺陷。验证结论见 delivery.verification。");
});

test("rollbackNotes omitted or whitespace leaves releasePlan = {notes} only (M2 shape)", async (t) => {
  const { claimReleasePreparerTask, submitReleasePreparerResult } = await import("./claim.ts");
  // 不传 rollbackNotes → releasePlan 只有 notes。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t);
    const { grant } = await claimReleasePreparerTask({
      workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
    });
    const detail = await submitReleasePreparerResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      releaseNotes: "仅说明。",
    });
    assert.deepEqual(detail.item.delivery.releasePlan, { notes: "仅说明。" });
  }
  // 空白 rollbackNotes → 键省略（不写空串）。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t);
    const { grant } = await claimReleasePreparerTask({
      workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
    });
    const detail = await submitReleasePreparerResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      releaseNotes: "仅说明。", rollbackNotes: "   ",
    });
    assert.deepEqual(detail.item.delivery.releasePlan, { notes: "仅说明。" });
  }
});

test("release-preparer submit with empty releaseNotes is a Validation (zero state)", async (t) => {
  const { claimReleasePreparerTask, submitReleasePreparerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);

  const { grant } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  for (const releaseNotes of ["", "   "]) {
    await assert.rejects(
      submitReleasePreparerResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
        releaseNotes,
      }),
      (error) => error instanceof WorkItemValidationError && /release_notes is required/.test(error.message),
    );
  }
  // 零状态：claim 仍在、无 attempt、阶段未动。
  assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  assert.deepEqual(await attempts.listAttempts(itemPath), []);
  const { readWorkItem } = await import("../service.ts");
  assert.equal((await readWorkItem(ws, key)).item.status, "in_progress");
});

test("release-preparer submit is a Conflict when candidates changed since the claim", async (t) => {
  const { claimReleasePreparerTask, submitReleasePreparerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);

  const { grant } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  // 领取后候选被换（人 rework 清候选重提交 / 手改 item.yaml）→ digest 漂移 → 409。
  await rewriteItem(ws, key, (item) => {
    item.delivery.candidates = [{ repositoryId: "repo-a", commit: "1".repeat(40) }];
  });
  await assert.rejects(
    submitReleasePreparerResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      releaseNotes: "迟到材料",
    }),
    (error) => error instanceof WorkItemConflictError && /candidates changed since the claim/.test(error.message),
  );
  // 零状态：claim 仍在（供 fail/中断释放）、阶段未动、无 attempt。
  assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  const { readWorkItem } = await import("../service.ts");
  assert.equal((await readWorkItem(ws, key)).item.phase, "release_ready");
  assert.deepEqual(await attempts.listAttempts(itemPath), []);
});

test("release-preparer submit is a Conflict when verification was cleared or the human advanced the phase", async (t) => {
  const { claimReleasePreparerTask, submitReleasePreparerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const rejectsConflict = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemConflictError,
        `expected WorkItemConflictError, got ${error?.name}: ${error.message}`);
      assert.match(error.message, pattern);
      return true;
    });
  const submitWith = (wsPath, keyVal, grant) => submitReleasePreparerResult({
    workspacePath: wsPath, key: keyVal,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    releaseNotes: "迟到材料",
  });

  // ① 领取后 verification 被清（rework 四清式，候选恰好没动）→ 材料失去验证
  //    依据 → 409。
  {
    const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);
    const { grant } = await claimReleasePreparerTask({
      workspacePath: ws, key, sessionId: "s", requestId: "r",
    });
    await rewriteItem(ws, key, (item) => {
      delete item.delivery.verification;
    });
    await rejectsConflict(submitWith(ws, key, grant), /input changed since claim/);
    assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
  }
  // ② 人在领取窗口内 record-release（phase→released，基线冻结）→ 迟到提交不得
  //    覆写冻结基线 → 409。
  {
    const { ws, key } = await makeReleasePreparerWorkspace(t);
    const { grant } = await claimReleasePreparerTask({
      workspacePath: ws, key, sessionId: "s", requestId: "r",
    });
    await rewriteItem(ws, key, (item) => {
      item.phase = "released";
    });
    await rejectsConflict(submitWith(ws, key, grant), /stale|phase/);
    const { readWorkItem } = await import("../service.ts");
    assert.equal((await readWorkItem(ws, key)).item.phase, "released",
      "human-advanced phase not clobbered by the stale submit");
  }
});

test("release-preparer credentials cannot release a designer claim (role gate)", async (t) => {
  const { claimDesignerTask, submitReleasePreparerResult } = await import("./claim.ts");
  // intake 项 designer 可领；release-preparer 凭据不得释放 designer 的 claim。
  const { ws, key } = await makeReleasePreparerWorkspace(t, { phase: "intake" });
  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "d-1", requestId: "d-r",
  });
  await assert.rejects(
    submitReleasePreparerResult({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      releaseNotes: "越权材料",
    }),
    (error) => error instanceof WorkItemConflictError && /designer role/.test(error.message),
  );
});

// ======================================== 21. release-preparer fail (Phase-5 T1)

test("failReleasePreparerTask blocked: phase untouched (release_ready→release_ready), claim cleared, role-audited attempt", async (t) => {
  const { claimReleasePreparerTask, failReleasePreparerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);

  const { grant } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  const detail = await failReleasePreparerTask({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation,
    ownerToken: grant.ownerToken, reason: "需求文档不可读", blocked: true,
  });

  // phase 不动（claim 本就不改阶段，失败也无阶段可归还）、status blocked。
  assert.equal(detail.item.phase, "release_ready", "release-preparer never moves the phase");
  assert.equal(detail.item.status, "blocked");
  assert.equal(detail.item.revision, 3);
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].role, "release-preparer");
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].reason, "需求文档不可读");
  assert.equal(records[0].worktrees, undefined, "pure-document role audits no worktrees");

  const events = await readEvents(ws, key);
  const failed = events.find((event) => event.type === "delivery.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.actor, "agent");
  assert.equal(failed.data.role, "release-preparer", "failure event carries the role");
  assert.equal(failed.data.blocked, true);

  // blocked 仍在白名单内可再领（generation 递增）。
  const second = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-2", requestId: "rel-req-2",
  });
  assert.equal(second.grant.generation, 2);
});

// ================================ 22. release-preparer interruption give-back (Phase-5 T1)

test("recordInterruption on a release-preparer claim: status returned, phase untouched, recovered item claimable again", async (t) => {
  const { claimReleasePreparerTask, recordInterruption } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);

  const { grant } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-1", requestId: "rel-req-1",
  });
  let detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "in_progress");
  assert.equal(detail.item.phase, "release_ready");

  await recordInterruption(ws, key, "rel-sess-1", "execution timeout");

  // status 归还（in_progress→open）、phase 零变化（release_ready→release_ready——
  // release-preparer claim 本就不改阶段，from=to 照 verifier 的 null 分支）。
  detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "open", "claim-borrowed in_progress reset to open");
  assert.equal(detail.item.phase, "release_ready", "phase untouched — no phase to give back");
  assert.equal(detail.item.revision, grant.item.item.revision + 1, "exactly one revision bump");
  const interrupted = detail.events.find((event) => event.type === "delivery.exec_interrupted");
  assert.ok(interrupted);
  assert.deepEqual(interrupted.data.status, { from: "in_progress", to: "open" });
  assert.equal(interrupted.data.phase, undefined, "no phase give-back for the release-preparer role");
  // 中断 attempt 按领取角色入审计。
  const [record] = await attempts.listAttempts(itemPath);
  assert.equal(record.role, "release-preparer");
  assert.equal(record.outcome, "interrupted");
  assert.equal(record.needsAttention, true);

  // 幂等：claim 已清 → 再记 no-op。
  await recordInterruption(ws, key, "rel-sess-1", "again");
  assert.equal((await readWorkItem(ws, key)).item.revision, grant.item.item.revision + 1);
  assert.equal((await attempts.listPendingInterruptions(itemPath)).length, 1);

  // 人 recover → 池子重新投影 release-preparer ready，真领取事务可再领
  //（generation 递增）。
  await attempts.resolveInterruptions(itemPath, {
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T12:00:00Z", actor: "user" },
  });
  const { listDeliveryPool } = await import("./pool.ts");
  const pool = await listDeliveryPool(ws);
  const entry = [...pool.ready, ...pool.blocked].find((candidate) => candidate.key === key);
  assert.ok(entry.ready, `recovered release-preparer item claimable — reasons: ${entry.reasons.join(", ")}`);
  assert.equal(entry.role, "release-preparer");

  const second = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-sess-2", requestId: "rel-req-2",
  });
  assert.equal(second.replayed, false);
  assert.equal(second.grant.generation, grant.generation + 1, "next generation from the attempt audit");
});

// ====================================== 23. ask-a-human (final-arch step-2 T2)
//
// askHumanQuestion 四角色同一函数：问人并交还执行权——与 fail 同一释放骨架
// （requireActiveClaim 三凭据 + cancel 守卫 → 清 claim → attempt 审计 → 状态
// 落盘 → 事件 → commit），但 phase 一概不动（问的是输入澄清，不是失败——无
// 阶段可归还）、status 归还 open、不写失败预算（asked 不计不断）、澄清
// DeliveryClarification（id=ULID）追加进 delivery.clarifications 是持久产物。
// 池谓词据此把未答项停在 awaiting-answer（见 pool.test.mjs + 生命周期测试）。

test("askHumanQuestion designer happy path: phase untouched, status open, claim cleared, clarification persisted, asked attempt, delivery.asked event", async (t) => {
  const { claimDesignerTask, askHumanQuestion } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key, readme } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  const question = "  该需求的第一批目标用户是谁？  ";
  const { detail, clarificationId } = await askHumanQuestion({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    role: "designer",
    question,
    options: ["个人开发者", "企业用户"],
    recommended: "个人开发者",
    conversationId: "conv-ask-1",
  });

  // 澄清落盘：全字段 + trim；answer/answeredAt 缺席（未答态）。
  assert.match(clarificationId, /^[0-9A-HJKMNP-TV-Z]{26}$/, "clarification id is a ULID");
  const clarifications = detail.item.delivery.clarifications;
  assert.equal(clarifications.length, 1);
  const clarification = clarifications[0];
  assert.equal(clarification.id, clarificationId);
  assert.equal(clarification.role, "designer");
  assert.equal(clarification.question, question.trim(), "question persisted trimmed");
  assert.deepEqual(clarification.options, ["个人开发者", "企业用户"]);
  assert.equal(clarification.recommended, "个人开发者");
  assert.ok(clarification.askedAt, "askedAt recorded");
  assert.equal(clarification.attemptId, grant.attemptId);
  assert.equal(clarification.answer, undefined);
  assert.equal(clarification.answeredAt, undefined);

  // 问人不是失败：phase 不动（design 不回 intake）、status 归还 open、
  // revision+1、会话自链接。
  assert.equal(detail.item.phase, "design", "ask never moves the phase");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  assert.ok(detail.item.conversations.includes("conv-ask-1"), "conversationId self-linked");

  // claim 清 + attempt asked 入审计（reason 如实记全文提问，不算失败）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "asked");
  assert.equal(records[0].role, "designer");
  assert.equal(records[0].reason, question.trim());
  assert.equal(records[0].requirementDigest, contentDigest(readme));

  // 事件：delivery.asked（actor=agent，携会话与摘要）。
  const events = await readEvents(ws, key);
  const asked = events.find((event) => event.type === "delivery.asked");
  assert.ok(asked);
  assert.equal(asked.actor, "agent");
  assert.equal(asked.conversationId, "conv-ask-1");
  assert.equal(asked.data.attemptId, grant.attemptId);
  assert.equal(asked.data.generation, grant.generation);
  assert.equal(asked.data.clarificationId, clarificationId);
  assert.equal(asked.data.question, question.trim());
  assert.equal(asked.data.revision, 3);
  assert.equal(
    events.some((event) => event.type === "delivery.attempt_failed"),
    false,
    "ask is not a failure — no attempt_failed event",
  );
});

test("askHumanQuestion is the same transaction for the other three roles (phase untouched, asked attempt, clarification role-stamped)", async (t) => {
  const claim = await import("./claim.ts");
  const attempts = await import("./attempts.ts");

  // developer：implementation 不回 ready_for_implementation。
  {
    const { ws, itemPath, key } = await makeDeveloperWorkspace(t);
    const { grant } = await claim.claimDeveloperTask({
      workspacePath: ws, key, sessionId: "dev-1", requestId: "dev-req-1",
    });
    const { detail, clarificationId } = await claim.askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "developer", question: "并发上限取多少？",
    });
    assert.equal(detail.item.phase, "implementation", "ask never moves the phase");
    assert.equal(detail.item.status, "open");
    assert.equal(detail.item.revision, 3);
    assert.equal(attempts.readClaim(itemPath), null);
    const [record] = await attempts.listAttempts(itemPath);
    assert.equal(record.outcome, "asked");
    assert.equal(record.role, "developer");
    assert.equal(detail.item.delivery.clarifications[0].role, "developer");
    assert.equal(detail.item.delivery.clarifications[0].id, clarificationId);
  }

  // verifier：verification 不动（无阶段可归还的推广——四角色同形）。
  {
    const { ws, itemPath, key } = await makeVerifierWorkspace(t);
    const { grant } = await claim.claimVerifierTask({
      workspacePath: ws, key, sessionId: "ver-1", requestId: "ver-req-1",
    });
    const { detail } = await claim.askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "verifier", question: "构建产物放哪个目录？",
    });
    assert.equal(detail.item.phase, "verification", "ask never moves the phase");
    assert.equal(detail.item.status, "open");
    assert.equal(attempts.readClaim(itemPath), null);
    const [record] = await attempts.listAttempts(itemPath);
    assert.equal(record.outcome, "asked");
    assert.equal(record.role, "verifier");
    assert.equal(detail.item.delivery.clarifications[0].role, "verifier");
  }

  // release-preparer：release_ready 不动；空白 recommended 视同未给（键省略）。
  {
    const { ws, itemPath, key } = await makeReleasePreparerWorkspace(t);
    const { grant } = await claim.claimReleasePreparerTask({
      workspacePath: ws, key, sessionId: "rel-1", requestId: "rel-req-1",
    });
    const { detail } = await claim.askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "release-preparer", question: "版本号沿用 semver 还是日期？", recommended: "   ",
    });
    assert.equal(detail.item.phase, "release_ready", "ask never moves the phase");
    assert.equal(detail.item.status, "open");
    assert.equal(attempts.readClaim(itemPath), null);
    const [record] = await attempts.listAttempts(itemPath);
    assert.equal(record.outcome, "asked");
    assert.equal(record.role, "release-preparer");
    const clarification = detail.item.delivery.clarifications[0];
    assert.equal(clarification.role, "release-preparer");
    assert.equal(clarification.recommended, undefined, "whitespace-only recommended omitted");
  }
});

test("askHumanQuestion: stale credentials are a Conflict, and a replay after the claim is cleared is a Conflict too", async (t) => {
  const { claimDesignerTask, askHumanQuestion } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });

  // 错误 ownerToken / generation → Conflict（claim 仍在场，零状态）。
  await assert.rejects(
    askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: "forged",
      role: "designer", question: "q?",
    }),
    (error) => error instanceof WorkItemConflictError && /ownerToken/.test(error.message),
  );
  await assert.rejects(
    askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation + 5, ownerToken: grant.ownerToken,
      role: "designer", question: "q?",
    }),
    (error) => error instanceof WorkItemConflictError && /stale/.test(error.message),
  );
  assert.equal((await attempts.listAttempts(itemPath)).length, 0, "no attempt from rejected asks");

  // 正常 ask（清 claim）后同凭据重放 → Conflict：ask 不是幂等动作，凭据随
  // claim 清除一次性失效（requireActiveClaim 的 no-active-claim 分支）。
  await askHumanQuestion({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    role: "designer", question: "q?",
  });
  await assert.rejects(
    askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "designer", question: "q? (replay)",
    }),
    (error) => error instanceof WorkItemConflictError && /no active claim/.test(error.message),
  );

  // 重放零状态：澄清仍只有一条、revision 不动、无第二份审计、无第二个事件。
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.delivery.clarifications.length, 1);
  assert.equal(detail.item.revision, 3);
  assert.equal((await attempts.listAttempts(itemPath)).length, 1);
  assert.equal((await readEvents(ws, key)).filter((event) => event.type === "delivery.asked").length, 1);
});

test("askHumanQuestion role gate: credentials cannot ask under another role's claim; a non-role value is a Validation", async (t) => {
  const { claimDesignerTask, askHumanQuestion } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });

  // role 与 claim.role 不符 → 409（凭据不得跨角色提问/释放）。
  await assert.rejects(
    askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "developer", question: "越权提问",
    }),
    (error) => error instanceof WorkItemConflictError && /designer role/.test(error.message),
  );
  // 非法 role 词表外 → 400（在碰 claim 之前就拒绝）。
  await assert.rejects(
    askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "boss", question: "非法角色",
    }),
    (error) => error instanceof WorkItemValidationError && /role must be one of/.test(error.message),
  );

  // 零状态：claim 仍在、无澄清、无审计、无新事件、revision 不动。
  assert.ok(attempts.readClaim(itemPath), "claim survives the rejected asks");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.delivery?.clarifications, undefined);
  assert.equal(detail.item.revision, 2);
  assert.equal((await attempts.listAttempts(itemPath)).length, 0);
  assert.equal(detail.events.length, 1, "only the original delivery.claimed event remains");
});

test("askHumanQuestion after a human cancel is a Conflict; the claim survives for recordInterruption", async (t) => {
  const { claimDesignerTask, askHumanQuestion } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  await rewriteItem(ws, key, (item) => {
    item.status = "cancelled"; // M2 cancel：只写 status，phase/digest 不动
  });

  await assert.rejects(
    askHumanQuestion({
      workspacePath: ws, key,
      attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
      role: "designer", question: "迟到的提问",
    }),
    (error) => error instanceof WorkItemConflictError && /cancelled while the claim was active/.test(error.message),
  );

  // 409 零状态：claim 仍在（恢复路径可清）、终态不被复活、无澄清无审计。
  assert.ok(attempts.readClaim(itemPath), "claim survives the rejected ask");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.status, "cancelled", "cancelled terminal status not resurrected");
  assert.equal(detail.item.phase, "design", "phase untouched");
  assert.equal(detail.item.revision, 2, "no revision bump from the rejected ask");
  assert.equal(detail.item.delivery?.clarifications, undefined);
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "no attempt audit from the rejected ask");
});

test("askHumanQuestion validation: blank question / blank option / empty options array are 400 with zero state; trimming and omission semantics on success", async (t) => {
  const { claimDesignerTask, askHumanQuestion } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { readWorkItem } = await import("../service.ts");
  const { ws, itemPath, key } = await makeWorkspace(t);

  const { grant } = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  const ask = (over = {}) => askHumanQuestion({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    role: "designer", question: "q?",
    ...over,
  });

  await assert.rejects(
    ask({ question: "   " }),
    (error) => error instanceof WorkItemValidationError && /question is required/.test(error.message),
  );
  await assert.rejects(
    ask({ options: ["a", "   "] }),
    (error) => error instanceof WorkItemValidationError && /options\[1\]/.test(error.message),
  );
  await assert.rejects(
    ask({ options: [] }),
    (error) => error instanceof WorkItemValidationError && /options/.test(error.message),
  );

  // 三次拒绝全程零状态。
  assert.ok(attempts.readClaim(itemPath), "claim survives the rejected asks");
  assert.equal((await readWorkItem(ws, key)).item.revision, 2);
  assert.equal((await attempts.listAttempts(itemPath)).length, 0);

  // 成功路径：question trim、空白 recommended 省键、options 原样。
  const { detail } = await ask({ question: "  支持哪些浏览器？ ", recommended: "   " });
  const clarification = detail.item.delivery.clarifications[0];
  assert.equal(clarification.question, "支持哪些浏览器？");
  assert.equal(clarification.recommended, undefined);
  assert.equal(clarification.options, undefined);
});

test("askHumanQuestion leaves the failure budget untouched: asked attempt neither counts nor breaks the streak, no failure-window, no pause", async (t) => {
  const { claimDesignerTask, failDesignerTask, askHumanQuestion } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key, readme } = await makeWorkspace(t);
  const digest = contentDigest(readme);

  // 第一轮：真 fail 一次（计数 1，phase 回 intake 可再领）。
  const first = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-1", requestId: "req-1",
  });
  await failDesignerTask({
    workspacePath: ws, key,
    attemptId: first.grant.attemptId, generation: first.grant.generation,
    ownerToken: first.grant.ownerToken, reason: "boom 1",
  });
  assert.equal(await attempts.countRecentFailures(itemPath, digest), 1);

  // 第二轮：ask。预算必须原地不动——不计数、不清零、不写窗口、不触暂停。
  const second = await claimDesignerTask({
    workspacePath: ws, key, sessionId: "sess-2", requestId: "req-2",
  });
  await askHumanQuestion({
    workspacePath: ws, key,
    attemptId: second.grant.attemptId, generation: second.grant.generation,
    ownerToken: second.grant.ownerToken, role: "designer", question: "依赖哪个服务？",
  });
  assert.equal(existsSync(attempts.failureWindowFilePath(itemPath)), false,
    "ask never writes the failure window");
  assert.equal(attempts.readPaused(itemPath), null, "ask never pauses automation");
  assert.equal(await attempts.countRecentFailures(itemPath, digest), 1,
    "asked attempt is skipped by the budget counter");

  // streak 连续性：asked 既不算失败也不断连胜——紧随其后的 fail 计数 2。
  await attempts.writeAttempt({
    attemptId: "01JC0ASKAFTER0000000000001", generation: 3, role: "designer",
    sessionId: "sess-3", workspacePath: ws, key,
    claimedAt: new Date().toISOString(), outcome: "failed",
    requirementDigest: digest,
  });
  assert.equal(await attempts.countRecentFailures(itemPath, digest), 2,
    "ask does not break the failure streak (neither counts nor stops)");
  const events = await readEvents(ws, key);
  assert.equal(
    events.some((event) => event.type === "delivery.automation_paused"),
    false,
    "no automation_paused event from the ask path",
  );
});

test("ask parks the item out of the ready pool via awaiting-answer; a human answer restores it (lifecycle)", async (t) => {
  const { claimReleasePreparerTask, askHumanQuestion } = await import("./claim.ts");
  const { listDeliveryPool } = await import("./pool.ts");
  const { ws, key } = await makeReleasePreparerWorkspace(t);

  const { grant } = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-1", requestId: "rel-req-1",
  });
  await askHumanQuestion({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    role: "release-preparer", question: "发布说明用中文还是英文？",
  });

  // 未答 → 不在 ready，唯一原因 awaiting-answer。
  const parked = await listDeliveryPool(ws);
  assert.deepEqual(parked.ready.map((entry) => entry.key), [], "no ready items while the question is open");
  const blockedEntry = parked.blocked.find((entry) => entry.key === key);
  assert.ok(blockedEntry);
  assert.deepEqual(blockedEntry.reasons, ["awaiting-answer"]);

  // 人答复（手工补 answer/answeredAt——Task 4 的 answer-clarification 语义）。
  await rewriteItem(ws, key, (item) => {
    item.delivery.clarifications[0].answer = "中文";
    item.delivery.clarifications[0].answeredAt = "2026-10-26T02:00:00Z";
  });

  const restored = await listDeliveryPool(ws);
  assert.deepEqual(restored.ready.map((entry) => entry.key), [key],
    "answered clarification restores readiness");
  const next = await claimReleasePreparerTask({
    workspacePath: ws, key, sessionId: "rel-2", requestId: "rel-req-2",
  });
  assert.equal(next.grant.generation, 2, "asked attempt still advances the generation");
});

// ==================== 24. reviewer claim transactions (final-arch step-3 T2)

test("claimReviewerTask happy path: read-only candidate checkouts, candidateDigest + checkContexts frozen, phase unchanged", async (t) => {
  const { claimReviewerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { candidatesDigest } = await import("../delivery-types.ts");
  const { ws, itemPath, key, readme, repos, candidates } = await makeReviewerWorkspace(t, {
    checks: [
      { name: "build", command: "echo build-ok" }, // repositoryId 缺省 → 解析为候选首仓
      { name: "lint", repositoryId: "repo-a", command: "echo lint-ok", timeout_seconds: 120 },
    ],
  });

  const { grant, replayed } = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  assert.equal(replayed, false);
  assert.match(grant.attemptId, /^[0-9A-Z]{26}$/, "attemptId is a ULID");
  assert.equal(grant.generation, 1);
  assert.ok(grant.ownerToken.length > 0, "fresh grant carries the plaintext ownerToken");

  // item 状态：phase 不变（verification）、status in_progress、revision+1。
  assert.equal(grant.item.item.phase, "verification");
  assert.equal(grant.item.item.status, "in_progress");
  assert.equal(grant.item.item.revision, 2);

  // claim.json：role reviewer、candidateDigest 快照、checkContexts 冻结（缺省
  // repositoryId 已解析——delivery_run_check 的配置查找以此为准）、checkResults
  // 空仓、只读候选 checkout 集。
  const claim = attempts.readClaim(itemPath);
  assert.equal(claim.attemptId, grant.attemptId);
  assert.equal(claim.role, "reviewer");
  assert.equal(claim.sessionId, "rev-sess-1");
  assert.equal(claim.requirementDigest, contentDigest(readme));
  assert.equal(claim.ownerTokenHash, attempts.hashOwnerToken(grant.ownerToken));
  assert.equal(claim.candidateDigest, candidatesDigest(candidates), "candidate snapshot at claim time");
  assert.deepEqual(claim.checkContexts, [
    { name: "build", repositoryId: repos[0].id, command: "echo build-ok" },
    { name: "lint", repositoryId: repos[0].id, command: "echo lint-ok", timeout_seconds: 120 },
  ], "checks config frozen from config.verification.checks for the reviewer");
  assert.deepEqual(claim.checkResults, [], "evidence accumulator starts empty");
  assert.equal(claim.worktrees.length, 1);
  const [checkout] = claim.worktrees;
  assert.equal(checkout.repositoryId, repos[0].id);
  assert.equal(checkout.branch, "pi-verify/REQ-0001/gen1");
  assert.ok(existsSync(checkout.path), "read-only candidate checkout actually exists on disk");
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

test("claimReviewerTask replay and concurrency: same contract as the sibling roles", async (t) => {
  const { claimReviewerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReviewerWorkspace(t);

  const first = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  const replay = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.grant.attemptId, first.grant.attemptId);
  assert.equal(replay.grant.ownerToken, "", "replay cannot resurrect the plaintext token");
  assert.equal(replay.grant.item.item.revision, 2, "revision untouched by replay");
  assert.deepEqual(await attempts.listAttempts(itemPath), [], "replay writes no attempt record");

  // 互斥：并发第二 claim → Conflict（fresh 工作区——上面 replay 轮的 claim 是
  // 手工清除的，项 status 仍 in_progress，不能直接再领）。
  {
    const fresh = await makeReviewerWorkspace(t);
    const results = await Promise.allSettled([
      claimReviewerTask({ workspacePath: fresh.ws, key: fresh.key, sessionId: "rev-a", requestId: "rev-req-a" }),
      claimReviewerTask({ workspacePath: fresh.ws, key: fresh.key, sessionId: "rev-b", requestId: "rev-req-b" }),
    ]);
    const grants = results.filter((result) => result.status === "fulfilled");
    const conflicts = results.filter((result) => result.status === "rejected");
    assert.equal(grants.length, 1, "exactly one claim wins");
    assert.equal(conflicts.length, 1);
    assert.ok(conflicts[0].reason instanceof WorkItemConflictError);
    assert.match(conflicts[0].reason.message, /active claim/i);
  }
});

test("claimReviewerTask re-verifies the reviewer predicates in the transaction", async (t) => {
  const { claimReviewerTask } = await import("./claim.ts");
  const rejectsValidation = (promise, pattern) =>
    assert.rejects(promise, (error) => {
      assert.ok(error instanceof WorkItemValidationError,
        `expected WorkItemValidationError, got ${error?.name}: ${error.message}`);
      assert.match(error.message, pattern);
      return true;
    });

  // review 关闭 → 项投影回 verifier，reviewer 不可领。
  {
    const { ws, key } = await makeReviewerWorkspace(t, { reviewEnabled: false });
    await rejectsValidation(
      claimReviewerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /verifier role, not reviewer/,
    );
  }
  // 无候选 → no-repo-scope（候选即 reviewer 的审阅对象）。
  {
    const { ws, key } = await makeReviewerWorkspace(t, { candidates: [] });
    await rejectsValidation(
      claimReviewerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /no-repo-scope/,
    );
  }
  // 已有同 digest 的 pass review → 过审，项投影回 verifier，reviewer 不可领。
  {
    const { ws, key } = await makeReviewerWorkspace(t, { review: { outcome: "pass" } });
    await rejectsValidation(
      claimReviewerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
      /verifier role, not reviewer/,
    );
  }
  // digest 变化（旧 review 绑旧候选集）→ 可再领（再审新候选）。
  {
    const { ws, key } = await makeReviewerWorkspace(t, {
      review: { outcome: "pass", digest: "b".repeat(64) },
    });
    const { grant } = await claimReviewerTask({
      workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
    });
    assert.equal(grant.generation, 1, "claimable again after the candidates changed under an old review");
  }
});

test("verify checkout failure aborts the reviewer claim with zero state writes", async (t) => {
  const { claimReviewerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReviewerWorkspace(t, {
    candidates: [{ repositoryId: "repo-a", commit: "0".repeat(40) }],
  });

  await assert.rejects(
    claimReviewerTask({ workspacePath: ws, key, sessionId: "s", requestId: "r" }),
    (error) => error instanceof WorkItemValidationError && /verify checkout failed/.test(error.message),
  );
  assert.equal(attempts.readClaim(itemPath), null);
  const { readWorkItem } = await import("../service.ts");
  const detail = await readWorkItem(ws, key);
  assert.equal(detail.item.phase, "verification");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 1);
  assert.deepEqual(detail.events, []);
});

test("submitReviewerResult pass: review written, phase unchanged, claim cleared, reviewed event, self-link, no failure budget", async (t) => {
  const { claimReviewerTask, submitReviewerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { candidatesDigest } = await import("../delivery-types.ts");
  const { ws, itemPath, key, readme, candidates } = await makeReviewerWorkspace(t);

  const { grant } = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  const detail = await submitReviewerResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    outcome: "pass",
    notes: "实现与方案一致",
    conversationId: "rev-sess-1",
  });

  // pass：phase 不变（verification）、status open、revision+1、会话自链接。
  assert.equal(detail.item.phase, "verification");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.revision, 3);
  assert.ok(
    detail.item.conversations.includes("rev-sess-1"),
    "reviewer session auto-linked into conversations",
  );
  const review = detail.item.delivery.review;
  assert.ok(review, "review block recorded");
  assert.equal(review.outcome, "pass");
  assert.equal(review.source, undefined, "pass carries no source");
  assert.equal(review.notes, "实现与方案一致");
  assert.equal(review.candidateDigest, candidatesDigest(candidates));
  assert.equal(review.attemptId, grant.attemptId);

  // claim 清 + attempt submitted（role reviewer + review payload 入审计）。
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "submitted");
  assert.equal(records[0].role, "reviewer");
  assert.equal(records[0].review.outcome, "pass");
  assert.equal(records[0].checkResults.length, 0);

  // 事件：delivery.reviewed（actor=agent，data 带判定与摘要；无 source 键）。
  const events = await readEvents(ws, key);
  const reviewed = events.find((event) => event.type === "delivery.reviewed");
  assert.ok(reviewed, "delivery.reviewed event appended");
  assert.equal(reviewed.actor, "agent");
  assert.equal(reviewed.conversationId, "rev-sess-1");
  assert.equal(reviewed.data.outcome, "pass");
  assert.equal(reviewed.data.source, undefined);
  assert.equal(reviewed.data.candidateDigest, candidatesDigest(candidates));
  assert.equal(reviewed.data.attemptId, grant.attemptId);
  assert.equal(reviewed.data.generation, 1);
  assert.equal(reviewed.data.revision, 3);

  // 无失败预算：pass/rework 都是判定不是失败——零计数、零窗口、零暂停。
  assert.equal(existsSync(attempts.failureWindowFilePath(itemPath)), false, "no failure window");
  assert.equal(await attempts.countRecentFailures(itemPath, contentDigest(readme)), 0);
  assert.equal(events.some((event) => event.type === "delivery.automation_paused"), false);

  // 池子交接：过审项投影回 verifier（interim——Task 3 换 system 步）。
  const { listDeliveryPool } = await import("./pool.ts");
  const pool = await listDeliveryPool(ws);
  const entry = pool.ready.find((candidate) => candidate.key === key);
  assert.ok(entry, "review-passed item stays claimable");
  assert.equal(entry.role, "verifier");
});

test("submitReviewerResult rework (code) lands in exactly the verifier-failed item state", async (t) => {
  const {
    claimVerifierTask, submitVerifierResult, recordCheckResult,
    claimReviewerTask, submitReviewerResult,
  } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReviewerWorkspace(t);
  const { ws: verWs, key: verKey } = await makeVerifierWorkspace(t, {
    checks: [{ name: "build", command: "npm run build" }],
  });
  // 深比对要求两条路径的项输入一致（title 对齐——README 差异不进 item 记录）。
  await rewriteItem(ws, key, (item) => { item.title = "Same"; });
  await rewriteItem(verWs, verKey, (item) => { item.title = "Same"; });

  // verifier 失败路径（基线）：真跑 checks → 一条 failed → submit。
  const { grant: verGrant } = await claimVerifierTask({
    workspacePath: verWs, key: verKey, sessionId: "ver-sess-1", requestId: "ver-req-1",
  });
  await recordCheckResult(verWs, verKey, "ver-sess-1", evidenceFor("build", "failed", { exitCode: 2 }));
  const verDetail = await submitVerifierResult({
    workspacePath: verWs, key: verKey,
    attemptId: verGrant.attemptId, generation: verGrant.generation, ownerToken: verGrant.ownerToken,
  });

  // reviewer rework(code) 路径。
  const { grant } = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  const detail = await submitReviewerResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    outcome: "rework",
    source: "code",
    notes: "登录接口未按方案实现",
  });

  // 同一 helper 断言两条路径（binding）。
  assertReworkState(verDetail, "verifier-failed");
  assertReworkState(detail, "reviewer-rework");

  // 逐字段深比对（review 块刻意保留——人要看为什么打回；updatedAt 各自时钟）。
  const strip = (item) => {
    const delivery = { ...item.delivery };
    delete delivery.review;
    return { ...item, updatedAt: null, delivery };
  };
  assert.deepEqual(strip(detail.item), strip(verDetail.item),
    "reviewer code-rework and verifier-failed produce the identical item record modulo review/updatedAt");

  // review 记录仍在场（人可见为什么打回）。
  assert.equal(detail.item.delivery.review.outcome, "rework");
  assert.equal(detail.item.delivery.review.source, "code");
  assert.equal(attempts.readClaim(itemPath), null);
});

test("submitReviewerResult rework (spec) rewinds to design and keeps the review verdict", async (t) => {
  const { claimReviewerTask, submitReviewerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReviewerWorkspace(t);

  const { grant } = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  const detail = await submitReviewerResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    outcome: "rework",
    source: "spec",
    notes: "方案不成立——存储层选型错误",
  });

  assert.equal(detail.item.phase, "design", "spec rework rewinds to design");
  assert.equal(detail.item.status, "open");
  assert.equal(detail.item.delivery.designConfirmed, undefined);
  assert.equal(detail.item.delivery.candidates, undefined);
  assert.equal(detail.item.delivery.review.outcome, "rework");
  assert.equal(detail.item.delivery.review.source, "spec");
  assert.equal(detail.item.delivery.review.notes, "方案不成立——存储层选型错误");

  const events = await readEvents(ws, key);
  const reviewed = events.find((event) => event.type === "delivery.reviewed");
  assert.equal(reviewed.data.outcome, "rework");
  assert.equal(reviewed.data.source, "spec");
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records[0].review.source, "spec");
});

test("submitReviewerResult validation: missing source / blank notes / pass with source / bad outcome are 400 with zero state", async (t) => {
  const { claimReviewerTask, submitReviewerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key } = await makeReviewerWorkspace(t);
  const { readWorkItem } = await import("../service.ts");

  const { grant } = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  const submit = (over = {}) => submitReviewerResult({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    outcome: "rework", source: "code", notes: "缺陷描述",
    ...over,
  });

  await assert.rejects(
    submit({ source: undefined }),
    (error) => error instanceof WorkItemValidationError && /source/.test(error.message),
  );
  await assert.rejects(
    submit({ source: "vibes" }),
    (error) => error instanceof WorkItemValidationError && /source/.test(error.message),
  );
  await assert.rejects(
    submit({ notes: "   " }),
    (error) => error instanceof WorkItemValidationError && /notes/.test(error.message),
  );
  await assert.rejects(
    submit({ outcome: "pass" }),
    (error) => error instanceof WorkItemValidationError && /source/.test(error.message),
  );
  await assert.rejects(
    submit({ outcome: "maybe" }),
    (error) => error instanceof WorkItemValidationError && /outcome/.test(error.message),
  );

  // 全程零状态：claim 仍在、revision 不动、无事件、无 attempt。
  assert.ok(attempts.readClaim(itemPath), "claim survives the rejected submits");
  assert.equal((await readWorkItem(ws, key)).item.revision, 2);
  assert.deepEqual(await attempts.listAttempts(itemPath), []);
  assert.deepEqual((await readWorkItem(ws, key)).events.filter((event) => event.type === "delivery.reviewed"), []);
});

test("submitReviewerResult is a Conflict when candidates drifted or a human advanced the phase", async (t) => {
  const { claimReviewerTask, submitReviewerResult } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");

  // 候选漂移（人在领取窗口内换/清候选）→ 409，claim 保留供 fail/中断释放。
  {
    const { ws, itemPath, key, repos } = await makeReviewerWorkspace(t);
    const { grant } = await claimReviewerTask({
      workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
    });
    await rewriteItem(ws, key, (item) => {
      item.delivery.candidates = [{ repositoryId: repos[0].id, commit: "1".repeat(40) }];
    });
    await assert.rejects(
      submitReviewerResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
        outcome: "pass", notes: "ok",
      }),
      (error) => error instanceof WorkItemConflictError && /candidates changed since the claim/.test(error.message),
    );
    assert.ok(attempts.readClaim(itemPath), "claim survives a rejected submit");
    const { readWorkItem } = await import("../service.ts");
    assert.equal((await readWorkItem(ws, key)).item.phase, "verification");
  }
  // 阶段守卫（人 record-verification 推进）→ 409。
  {
    const { ws, key } = await makeReviewerWorkspace(t);
    const { grant } = await claimReviewerTask({
      workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
    });
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
      submitReviewerResult({
        workspacePath: ws, key,
        attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
        outcome: "pass", notes: "ok",
      }),
      (error) => error instanceof WorkItemConflictError && /stale|phase/.test(error.message),
    );
  }
});

test("failReviewerTask: standard release — phase untouched, claim cleared, role-audited attempt, budget counts", async (t) => {
  const { claimReviewerTask, failReviewerTask } = await import("./claim.ts");
  const attempts = await import("./attempts.ts");
  const { ws, itemPath, key, readme } = await makeReviewerWorkspace(t);

  const { grant } = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-1", requestId: "rev-req-1",
  });
  const detail = await failReviewerTask({
    workspacePath: ws, key,
    attemptId: grant.attemptId, generation: grant.generation, ownerToken: grant.ownerToken,
    reason: "候选仓库 checkout 损坏",
    blocked: true,
  });

  assert.equal(detail.item.phase, "verification", "reviewer never moves the phase");
  assert.equal(detail.item.status, "blocked");
  assert.equal(detail.item.revision, 3);
  assert.equal(attempts.readClaim(itemPath), null);
  const records = await attempts.listAttempts(itemPath);
  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].role, "reviewer");
  assert.equal(records[0].worktrees.length, 1, "checkout audit preserved from the claim");
  assert.equal(await attempts.countRecentFailures(itemPath, contentDigest(readme)), 1,
    "reviewer failures consume the shared budget");

  const events = await readEvents(ws, key);
  const failed = events.find((event) => event.type === "delivery.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.data.role, "reviewer");
  assert.equal(failed.data.blocked, true);

  // blocked（可解）仍可再领：同一谓词 ready，generation 递增。
  const next = await claimReviewerTask({
    workspacePath: ws, key, sessionId: "rev-sess-2", requestId: "rev-req-2",
  });
  assert.equal(next.grant.generation, 2);
});

test("submitVerifierResult settles through finalizeChecks (source assertion)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./claim.ts", import.meta.url), "utf8");
  const submitBody = source.slice(
    source.indexOf("export async function submitVerifierResult"),
    source.indexOf("export async function failVerifierTask"),
  );
  assert.ok(
    submitBody.includes("finalizeChecks("),
    "submitVerifierResult must delegate its settlement to finalizeChecks",
  );
  assert.ok(
    source.includes('actor: "agent" | "system"'),
    "finalizeChecks carries the actor parameter for the Task-3 system step",
  );
});
