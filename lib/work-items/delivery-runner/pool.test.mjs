// Phase-2 Task 2: designer TaskPool 投影。
// 纯投影 projectDesignerPool —— 零 fs、字面量输入：覆盖全部 9 个
// DesignerPoolReason 分支、多原因累积顺序、排序（P0→P3→key，未知优先级垫底）、
// ready/broken 标记。读取端 listDesignerPool —— mkdtemp 真临时工作区：
// ready/blocked 分桶、requirementDigest = contentDigest(README)、缺配置 =
// automation-disabled、fs 容错（events.jsonl 缺失仍投影）。运行时信号
// （claim/中断/暂停/失败上限）经 Task 3 的 attempts.ts 静态 import 直读，
// 生命周期集成测试在文件尾部（T2 时代的「模块缺席 = 全空信号」动态 seam
// 测试已按 T3 ruling 删除——静态 import 下缺失路径不可达成）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentDigest } from "../delivery-types.ts";

// ---------------------------------------------------------------- pure side

const item = (over = {}) => ({
  key: "REQ-0001",
  title: "Alpha",
  priority: "P1",
  status: "open",
  phase: "intake",
  archivedAt: null,
  requirementDigest: "digest-a",
  delivery: { protocolVersion: 1, mode: "manual" },
  ...over,
});

const ctx = (over = {}) => ({
  enabled: true,
  activeClaims: new Set(),
  pendingInterruptions: new Set(),
  paused: new Set(),
  failedCountByDigest: new Map(),
  maxAttemptsPerInput: 3,
  ...over,
});

test("ready item projects with empty reasons and passes the digest through", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  const entries = projectDesignerPool([item()], ctx());
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    key: "REQ-0001",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: true,
    reasons: [],
  });
});

test("each DesignerPoolReason branch blocks exactly its own reason", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  const cases = [
    ["not-managed", [item({ delivery: undefined })], ctx()],
    ["automation-disabled", [item()], ctx({ enabled: false })],
    ["wrong-phase", [item({ phase: "design" })], ctx()],
    ["active-claim", [item()], ctx({ activeClaims: new Set(["REQ-0001"]) })],
    ["pending-interruption", [item()], ctx({ pendingInterruptions: new Set(["REQ-0001"]) })],
    ["automation-paused", [item()], ctx({ paused: new Set(["REQ-0001"]) })],
    [
      "failure-limit",
      [item()],
      ctx({ failedCountByDigest: new Map([["digest-a", 3]]) }),
    ],
    ["terminal-status", [item({ status: "cancelled" })], ctx()],
    ["terminal-status", [item({ status: "done" })], ctx()],
    ["archived", [item({ archivedAt: "2026-10-24T00:00:00Z" })], ctx()],
  ];
  const exercised = new Set();
  for (const [reason, items, context] of cases) {
    const [entry] = projectDesignerPool(items, context);
    assert.equal(entry.ready, false, `${reason} must block`);
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  // 9 reasons all exercised (terminal-status twice: cancelled + done).
  assert.equal(exercised.size, 9);
});

test("failure limit is exclusive: max-1 failures still ready", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  const entries = projectDesignerPool(
    [item({ key: "REQ-0002" })],
    ctx({ failedCountByDigest: new Map([["digest-a", 2]]) }),
  );
  assert.equal(entries[0].ready, true);
  assert.deepEqual(entries[0].reasons, []);
});

test("failure limit counts by the item's own digest, not others'", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  const entries = projectDesignerPool(
    [item({ key: "REQ-0002", requirementDigest: "digest-b" })],
    ctx({ failedCountByDigest: new Map([["digest-a", 9]]) }),
  );
  assert.equal(entries[0].ready, true);
});

test("multiple violations accumulate in the canonical reason order", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  const [entry] = projectDesignerPool(
    [item({ phase: "design", status: "done", archivedAt: "2026-10-24T00:00:00Z" })],
    ctx({ enabled: false, activeClaims: new Set(["REQ-0001"]) }),
  );
  assert.deepEqual(entry.reasons, [
    "automation-disabled",
    "wrong-phase",
    "active-claim",
    "terminal-status",
    "archived",
  ]);
});

test("sorts P0 before P2, same priority by key ascending; unknown priority last", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  const entries = projectDesignerPool(
    [
      item({ key: "REQ-0100", priority: "P2" }),
      item({ key: "REQ-0010", priority: "P0" }),
      item({ key: "REQ-0003", priority: "P0" }),
      item({ key: "REQ-0004", priority: "P1" }),
      item({ key: "REQ-0005", priority: "PX" }),
      item({ key: "REQ-0006", priority: "P3" }),
    ],
    ctx(),
  );
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["REQ-0003", "REQ-0010", "REQ-0004", "REQ-0100", "REQ-0006", "REQ-0005"],
  );
});

test("empty input projects to an empty pool", async () => {
  const { projectDesignerPool } = await import("./pool.ts");
  assert.deepEqual(projectDesignerPool([], ctx()), []);
});

// ------------------------------------------------------------ read side

const managedDeliveryYaml = ["delivery:", "  protocolVersion: 1", "  mode: manual"];

/** Minimal valid item.yaml for listWorkItems/readWorkItem. */
const itemYaml = ({ key, title, priority, status = "open", phase = "intake", managed = true, archivedAt = null }) =>
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
    `archived_at: ${archivedAt === null ? "null" : JSON.stringify(archivedAt)}`,
    `created_at: "2026-10-24T00:00:00Z"`,
    `updated_at: "2026-10-24T00:00:00Z"`,
    ...(managed ? managedDeliveryYaml : []),
    "",
  ].join("\n");

async function writeItem(root, { key, slug, readme = `# ${key}\n`, events = "", skipEvents = false, ...rest }) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, ...rest }), "utf8");
  await writeFile(join(dir, "README.md"), readme, "utf8");
  if (!skipEvents) await writeFile(join(dir, "events.jsonl"), events, "utf8");
}

async function writeEnabledConfig(root, maxAttemptsPerInput = 3) {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "delivery.yaml"),
    [
      "schemaVersion: 1",
      "enabled: true",
      `budget: { maxAttemptsPerInput: ${maxAttemptsPerInput}, maxExecutionMinutes: 30 }`,
      "",
    ].join("\n"),
    "utf8",
  );
}

test("listDesignerPool buckets ready/blocked and digests README content", async (t) => {
  const { listDesignerPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1", readme: "Alpha body\n" });
  await writeItem(ws, { key: "REQ-0002", slug: "plain", title: "Plain", priority: "P0", managed: false });

  const pool = await listDesignerPool(ws);
  assert.deepEqual(
    pool.ready.map((entry) => entry.key),
    ["REQ-0001"],
  );
  assert.deepEqual(
    pool.blocked.map((entry) => entry.key),
    ["REQ-0002"],
  );
  assert.equal(pool.ready[0].requirementDigest, contentDigest("Alpha body\n"));
  assert.deepEqual(pool.blocked[0].reasons, ["not-managed"]);
  // 未 managed 项不读详情：digest 为空串（纯投影只比较，不计算）。
  assert.equal(pool.blocked[0].requirementDigest, "");
});

test("listDesignerPool treats a missing config as automation-disabled", async (t) => {
  const { listDesignerPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-cfg-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1" });

  const pool = await listDesignerPool(ws);
  assert.equal(pool.ready.length, 0);
  assert.deepEqual(pool.blocked.map((entry) => entry.reasons), [["automation-disabled"]]);
});

test("listDesignerPool survives a broken detail read (missing events.jsonl) — still projected", async (t) => {
  const { listDesignerPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-grace-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1", skipEvents: true });

  const pool = await listDesignerPool(ws);
  // 详情读失败 → 空内容摘要，fs 容错：不抛、不吞项。
  assert.deepEqual(
    pool.ready.map((entry) => entry.key),
    ["REQ-0001"],
  );
  assert.equal(pool.ready[0].requirementDigest, contentDigest(""));
});

test("listDesignerPool consumes real runtime signals from attempts.ts across the claim lifecycle", async (t) => {
  const { listDesignerPool } = await import("./pool.ts");
  const attempts = await import("./attempts.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-rt-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws, 2);
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1", readme: "Alpha body\n" });
  const itemPath = join(ws, ".pi", "work-items", "requirements", "REQ-0001-alpha");
  const digest = contentDigest("Alpha body\n");
  const reasons = async () => (await listDesignerPool(ws)).blocked[0]?.reasons;

  // 无信号 → ready。
  let pool = await listDesignerPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0001"]);

  // 活动领取 → active-claim。
  attempts.writeClaim(itemPath, {
    attemptId: "01JD0CLAIM00000001",
    generation: 1,
    role: "designer",
    sessionId: "sess-1",
    claimedAt: "2026-10-24T00:00:00Z",
    lastSeenAt: "2026-10-24T00:00:20Z",
    requirementDigest: digest,
    ownerTokenHash: "a".repeat(64),
  });
  assert.deepEqual(await reasons(), ["active-claim"]);
  attempts.clearClaim(itemPath);

  // automation-paused 标记 → automation-paused。
  attempts.writePaused(itemPath, { at: "2026-10-24T00:00:00Z", reason: "consecutive failures", count: 2 });
  assert.deepEqual(await reasons(), ["automation-paused"]);
  attempts.clearPaused(itemPath);

  // 未确认中断 → pending-interruption；resolve 后回 ready。
  await attempts.writeAttempt({
    attemptId: "01JD0INTERRUPT0001",
    generation: 1,
    role: "designer",
    sessionId: "sess-1",
    workspacePath: ws,
    key: "REQ-0001",
    claimedAt: "2026-10-24T00:00:00Z",
    outcome: "interrupted",
    endedAt: "2026-10-24T00:07:00Z",
    requirementDigest: digest,
    needsAttention: true,
  });
  assert.deepEqual(await reasons(), ["pending-interruption"]);
  await attempts.resolveInterruptions(itemPath, {
    needsAttention: false,
    diagnostic: { checkedAt: "2026-10-24T00:09:00Z", actor: "user" },
  });
  pool = await listDesignerPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0001"]);

  // 同 digest 失败 attempt 达上限（max=2）→ failure-limit（中断审计已 resolve 不再挡）。
  for (const [index, attemptId] of ["01JD0FAIL000000001", "01JD0FAIL000000002"].entries()) {
    await attempts.writeAttempt({
      attemptId,
      generation: index + 2,
      role: "designer",
      sessionId: `sess-${index + 2}`,
      workspacePath: ws,
      key: "REQ-0001",
      claimedAt: "2026-10-24T00:10:00Z",
      outcome: "failed",
      endedAt: "2026-10-24T00:15:00Z",
      requirementDigest: digest,
    });
  }
  assert.deepEqual(await reasons(), ["failure-limit"]);
});
