// Phase-3 Task 1: 双角色 TaskPool 投影（designer P2 迁移 + developer 谓词）。
// 纯投影 projectDeliveryPool —— 零 fs、字面量输入：designer 回归（全部 9 个
// 既有 reason 分支 + role 字段，行为与 P2 逐字节一致）、developer 全谓词分支
// （三新 reason：design-unconfirmed / no-repo-scope / repo-not-registered +
// 共用分支在 developer 侧同样生效）、多原因累积顺序、角色由阶段决定
// （ready_for_implementation → developer，其余 → designer 照旧 wrong-phase）、
// 合并排序（跨角色 P0→P3→key，角色不作 tiebreaker）。读取端 listDeliveryPool
// —— mkdtemp 真临时工作区：ready/blocked 分桶、requirementDigest =
// contentDigest(README)、缺配置 = automation-disabled、fs 容错（events.jsonl
// 缺失仍投影）、registeredRepos 从 workspace manifest 装配（active/removed/
// 未登记三分支；manifest 缺失 → 空登记表容错）。运行时信号（claim/中断/暂停/
// 失败上限）经 attempts.ts 静态 import 直读，生命周期集成测试在文件尾部。
// T4 carried ruling：终态谓词是【白名单】status ∈ {open, blocked}——claim 事务
// 写 status=in_progress 后即使 claim.json 写入前崩溃，项也不再投影 ready。
//
// Phase-4 T1 增补：verifier 谓词（spec 2026-10-24-phase-four §3，已随
// final-arch step-3 T3 退役——其分支测试迁往 checks-step.test.mjs 的 checksDue）。
//
// Phase-5 T1 增补：release-preparer 谓词（spec 2026-10-25-phase-five §2）——
// release_ready 阶段角色判定 + 专属分支（verification-missing / stale-verification
// [候选被换或被清——candidateDigest 与当前候选集摘要不匹配]）+ 共用分支 +
// 既有三角色谓词零变化回归 + 四角色合并排序（角色仍非 tiebreaker）+ 读取端
// verification 块透传装配。
// Phase-5 T2 增补（T1 review carried ruling #1 循环闸，spec 级缺口修复）：
// release-preparer 谓词增 release-plan-exists——delivery.releasePlan 在场
//（前轮已准备过材料）即不再自动重派；人重新起草走人工 prepare-release 路由。
// final-arch step-2 T2 增补：ask-a-human 澄清门——共用检查 sharedReasons 增
// awaiting-answer（任一 delivery.clarifications 条目 answer 缺席 → 停领等人
// 答复，ask 事务的持久产物是停车依据）；四角色谓词均生效、答复恢复、无澄清
// 零变化回归 + 读取端 clarifications 透传（真 yaml → 谓词 → 答复恢复）。
// final-arch step-3 T2 增补（先审后跑）：reviewer 谓词（verification 阶段 ∧
// ctx.reviewEnabled ∧ 候选非空 ∧ 无 review 或 review.candidateDigest 与当前
// 候选集不符——新 reason：review-disabled / review-done）+ 角色投影分流。
// final-arch step-3 T3 增补（system 检查步）：verifier 谓词退役——过审（或
// review 关闭）的 verification 项不再投影 verifier（LLM 可领任务），交给引擎
// system 检查步（checks-step.checksDue 的 due 输入，全分支测试在
// checks-step.test.mjs）：投影按 P2 语义落 designer wrong-phase 桶（不在 ready
// 队列——它们本就不是 LLM 会话的活了）。检查步的 reason 词表（checks-empty /
// checks-done / awaiting-review）与 due 门随之迁往 checks-step；reviewPending
// 共用判定保留导出。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidatesDigest, contentDigest } from "../delivery-types.ts";

// ---------------------------------------------------------------- pure side

const item = (over = {}) => ({
  key: "REQ-0001",
  title: "Alpha",
  priority: "P1",
  status: "open",
  phase: "intake",
  archivedAt: null,
  repositories: [],
  requirementDigest: "digest-a",
  delivery: { protocolVersion: 1, mode: "manual" },
  ...over,
});

const ctx = (over = {}) => ({
  enabled: true,
  activeClaims: new Set(),
  pendingInterruptions: new Set(),
  paused: new Set(),
  failureCountByKey: new Map(),
  maxAttemptsPerInput: 3,
  registeredRepos: new Map(),
  ...over,
});

/** developer 侧最小可领输入：rfi 阶段 + 已确认设计 + 单仓且已登记 active。 */
const devItem = (over = {}) => ({
  ...item({
    phase: "ready_for_implementation",
    delivery: {
      protocolVersion: 1,
      mode: "manual",
      designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
    },
    repositories: ["repo-1"],
  }),
  ...over,
});

/** developer 侧默认 ctx：repo-1 已登记 active。 */
const devCtx = (over = {}) =>
  ctx({ registeredRepos: new Map([["repo-1", "active"]]), ...over });

// ------------------------------------------------------- designer regression

test("ready designer item projects with empty reasons, role designer (P2 parity + role field)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const entries = projectDeliveryPool([item()], ctx());
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    key: "REQ-0001",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: true,
    reasons: [],
    role: "designer",
  });
});

test("each designer reason branch blocks exactly its own reason (P2 regression)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
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
      ctx({ failureCountByKey: new Map([["REQ-0001", 3]]) }),
    ],
    ["terminal-status", [item({ status: "cancelled" })], ctx()],
    ["terminal-status", [item({ status: "done" })], ctx()],
    ["archived", [item({ archivedAt: "2026-10-24T00:00:00Z" })], ctx()],
  ];
  const exercised = new Set();
  for (const [reason, items, context] of cases) {
    const [entry] = projectDeliveryPool(items, context);
    assert.equal(entry.ready, false, `${reason} must block`);
    assert.equal(entry.role, "designer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  // 9 designer reasons all exercised (terminal-status twice: cancelled + done).
  assert.equal(exercised.size, 9);
});

test("designer predicate ignores repository scope and registration (P2 parity)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // 空范围 / 未登记仓 / removed 仓都不影响 designer——仓库谓词只属于 developer。
  const [emptyScope] = projectDeliveryPool([item()], ctx());
  assert.equal(emptyScope.ready, true);
  const [ghostRepo] = projectDeliveryPool(
    [item({ repositories: ["ghost"] })],
    ctx(),
  );
  assert.equal(ghostRepo.ready, true);
  assert.equal(ghostRepo.role, "designer");
});

test("designer failure limit stays per item and max-1 failures still ready (P2 regression)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [maxMinusOne] = projectDeliveryPool(
    [item({ key: "REQ-0002" })],
    ctx({ failureCountByKey: new Map([["REQ-0002", 2]]) }),
  );
  assert.equal(maxMinusOne.ready, true);
  assert.deepEqual(maxMinusOne.reasons, []);
  const [otherItem] = projectDeliveryPool(
    [item({ key: "REQ-0002", requirementDigest: "digest-b" })],
    ctx({ failureCountByKey: new Map([["REQ-0001", 9]]) }),
  );
  assert.equal(otherItem.ready, true);
});

test("designer multiple violations accumulate in the canonical reason order (P2 regression)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool(
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

test("designer status allowlist {open, blocked}: in_progress NOT claimable; blocked stays claimable", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [inProgress] = projectDeliveryPool([item({ status: "in_progress" })], ctx());
  assert.equal(inProgress.ready, false);
  assert.deepEqual(inProgress.reasons, ["terminal-status"]);
  const [blocked] = projectDeliveryPool([item({ status: "blocked" })], ctx());
  assert.equal(blocked.ready, true, "blocked(可解) is claimable per spec §5.1");
});

// ------------------------------------------------------------ developer side

test("developer-ready item projects with role developer and empty reasons", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool([devItem()], devCtx());
  assert.deepEqual(entry, {
    key: "REQ-0001",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: true,
    reasons: [],
    role: "developer",
  });
});

test("each developer-only reason blocks exactly its own reason", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    // 设计未确认（delivery 块在、designConfirmed 缺席）。
    [
      "design-unconfirmed",
      [devItem({ delivery: { protocolVersion: 1, mode: "manual" } })],
      devCtx(),
    ],
    // 空仓库范围。
    ["no-repo-scope", [devItem({ repositories: [] })], devCtx()],
    // 仓未登记（registeredRepos 无该 id）。
    ["repo-not-registered", [devItem()], ctx()],
    // 仓已登记但 removed（非 active）。
    [
      "repo-not-registered",
      [devItem()],
      ctx({ registeredRepos: new Map([["repo-1", "removed"]]) }),
    ],
  ];
  const exercised = new Set();
  for (const [reason, items, context] of cases) {
    const [entry] = projectDeliveryPool(items, context);
    assert.equal(entry.ready, false, `${reason} must block`);
    assert.equal(entry.role, "developer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  // 3 new developer reasons all exercised (repo-not-registered twice: missing + removed).
  assert.equal(exercised.size, 3);
});

test("mixed repo scope: one non-active repo blocks the whole item (developer)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const bothActive = projectDeliveryPool(
    [devItem({ repositories: ["repo-1", "repo-2"] })],
    ctx({ registeredRepos: new Map([["repo-1", "active"], ["repo-2", "active"]]) }),
  );
  assert.equal(bothActive[0].ready, true);
  const oneRemoved = projectDeliveryPool(
    [devItem({ repositories: ["repo-1", "repo-2"] })],
    ctx({ registeredRepos: new Map([["repo-1", "active"], ["repo-2", "removed"]]) }),
  );
  assert.equal(oneRemoved[0].ready, false);
  assert.deepEqual(oneRemoved[0].reasons, ["repo-not-registered"]);
});

test("shared blocking branches apply on the developer side too", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    ["automation-disabled", devItem(), devCtx({ enabled: false })],
    ["active-claim", devItem(), devCtx({ activeClaims: new Set(["REQ-0001"]) })],
    ["pending-interruption", devItem(), devCtx({ pendingInterruptions: new Set(["REQ-0001"]) })],
    ["automation-paused", devItem(), devCtx({ paused: new Set(["REQ-0001"]) })],
    ["failure-limit", devItem(), devCtx({ failureCountByKey: new Map([["REQ-0001", 3]]) })],
    ["terminal-status", devItem({ status: "cancelled" }), devCtx()],
    ["terminal-status", devItem({ status: "done" }), devCtx()],
    // claim 崩溃窗口（status=in_progress 先于 claim.json）在 developer 侧同样堵死。
    ["terminal-status", devItem({ status: "in_progress" }), devCtx()],
    ["archived", devItem({ archivedAt: "2026-10-24T00:00:00Z" }), devCtx()],
  ];
  const exercised = new Set();
  for (const [reason, poolItem, context] of cases) {
    const [entry] = projectDeliveryPool([poolItem], context);
    assert.equal(entry.ready, false, `${reason} must block on the developer side`);
    assert.equal(entry.role, "developer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  // 7 unique shared reasons (terminal-status thrice: cancelled/done/in_progress).
  assert.equal(exercised.size, 7);

  // not-managed 在 developer 侧与 design-unconfirmed 累积（无 delivery 块 →
  // designConfirmed 真值判断自然为假，两因并报不短路）。
  const [notManaged] = projectDeliveryPool([devItem({ delivery: undefined })], devCtx());
  assert.equal(notManaged.ready, false);
  assert.equal(notManaged.reasons[0], "not-managed");
  assert.ok(notManaged.reasons.includes("design-unconfirmed"));
});

test("developer violations accumulate in the canonical reason order", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool(
    [devItem({ delivery: undefined, repositories: [] })],
    devCtx({ enabled: false, activeClaims: new Set(["REQ-0001"]) }),
  );
  assert.deepEqual(entry.reasons, [
    "not-managed",
    "automation-disabled",
    "design-unconfirmed",
    "no-repo-scope",
    "active-claim",
  ]);
});

test("role is decided by phase: ready_for_implementation → developer, others → designer (wrong-phase as before)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const mixed = projectDeliveryPool(
    [
      devItem({ key: "REQ-0003" }),
      item({ key: "REQ-0002", phase: "implementation" }),
      item({ key: "REQ-0004", phase: "intake" }),
    ],
    ctx(),
  );
  const byKey = new Map(mixed.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("REQ-0003").role, "developer");
  assert.equal(byKey.get("REQ-0002").role, "designer");
  assert.ok(byKey.get("REQ-0002").reasons.includes("wrong-phase"),
    "implementation-phase item keeps the P2 designer wrong-phase projection");
  assert.equal(byKey.get("REQ-0004").role, "designer");
  assert.equal(byKey.get("REQ-0004").ready, true);
});

// ------------------------------------------------------------- verifier side

/** verification 侧最小输入（T3 起 no longer a claimable role——verifier 谓词
 *  退役）：verification 阶段 + 已确认设计 + 单候选（repo-1）。review 关闭（或缺
 *  省）时按 P2 语义投影 designer wrong-phase 桶（system 检查步的 due 输入）；
 *  review 开启时欠审 → reviewer。 */
const verItem = (over = {}) => ({
  ...item({
    phase: "verification",
    delivery: {
      protocolVersion: 1,
      mode: "manual",
      designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
      candidates: [{ repositoryId: "repo-1", commit: "abc123" }],
    },
  }),
  ...over,
});

/** verification 侧默认 ctx（repo-1 active；checks 字段随 T3 谓词退役不再是
 *  投影输入——留在 fixture 里无害，checks-step 的 ctx 自行装配）。 */
const verCtx = (over = {}) =>
  devCtx({ checks: [{ name: "unit", command: "npm test" }], ...over });

test("verification item (review off, review-passed) leaves the LLM queue: designer wrong-phase, blocked (system checks step owns it)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // T3：verifier 谓词退役——过审（或 review 关闭）的 verification 项不再是可领
  // 任务，按 P2 语义落 designer wrong-phase 桶；由 dispatcher 的 system 检查步
  // 接手（due 判定在 checks-step）。
  const [entry] = projectDeliveryPool([verItem()], verCtx());
  assert.deepEqual(entry, {
    key: "REQ-0001",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: false,
    reasons: ["wrong-phase"],
    role: "designer",
  });
});

test("role is decided by phase: verification → designer-blocked (system checks step owns it), release_ready → release-preparer", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const mixed = projectDeliveryPool(
    [
      verItem({ key: "REQ-0005" }),
      devItem({ key: "REQ-0003" }),
      // released 等 release-preparer 之外的阶段照旧 designer wrong-phase（P2 语义
      // ——Phase-5 起 release_ready 归 release-preparer，wrong-phase 钉子挪到 released）。
      item({ key: "REQ-0002", phase: "released" }),
      item({ key: "REQ-0004", phase: "intake" }),
      relItem({ key: "REQ-0007" }),
    ],
    // repo-1 active（developer 侧）；release-preparer 不消费登记表。
    verCtx(),
  );
  const byKey = new Map(mixed.map((entry) => [entry.key, entry]));
  // T3：verification 项（review 关闭）落 designer wrong-phase 桶等 system 检查步。
  assert.equal(byKey.get("REQ-0005").role, "designer");
  assert.equal(byKey.get("REQ-0005").ready, false);
  assert.deepEqual(byKey.get("REQ-0005").reasons, ["wrong-phase"]);
  assert.equal(byKey.get("REQ-0003").role, "developer");
  assert.equal(byKey.get("REQ-0003").ready, true);
  assert.equal(byKey.get("REQ-0002").role, "designer");
  assert.ok(byKey.get("REQ-0002").reasons.includes("wrong-phase"),
    "non-role phases keep the P2 designer wrong-phase projection");
  assert.equal(byKey.get("REQ-0004").role, "designer");
  assert.equal(byKey.get("REQ-0004").ready, true);
  assert.equal(byKey.get("REQ-0007").role, "release-preparer");
  assert.equal(byKey.get("REQ-0007").ready, true);
});

test("ctx.checks never leaks into designer/developer predicates (zero change)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // designer：不消费 checks——配置了指向不存在仓的检查也照旧 ready。
  const [designerReady] = projectDeliveryPool([item()], verCtx());
  assert.equal(designerReady.ready, true);
  assert.equal(designerReady.role, "designer");
  // developer：谓词只看 item.repositories 与 registeredRepos——checks 不参与。
  const [developerReady] = projectDeliveryPool(
    [devItem()],
    verCtx({ checks: [{ name: "unit", command: "npm test", repositoryId: "ghost" }] }),
  );
  assert.equal(developerReady.ready, true);
  assert.equal(developerReady.role, "developer");
});

// ------------------------------------------------------------- reviewer side

/** verItem 候选集的摘要（review 记录绑定用——同 digest 纪律）。 */
const VER_CANDIDATES = [{ repositoryId: "repo-1", commit: "abc123" }];

/** reviewer 侧默认 ctx：verCtx 同底（repo-1 active + checks）+ review 开启。 */
const reviewerCtx = (over = {}) => verCtx({ reviewEnabled: true, ...over });

/** 带 review 记录的 verification 项（digest 缺省 = 当前候选集摘要——已过审）。 */
const reviewedItem = (review, over = {}) =>
  verItem({
    delivery: {
      ...verItem().delivery,
      review: {
        outcome: "pass",
        notes: "通过",
        candidateDigest: candidatesDigest(VER_CANDIDATES),
        at: "2026-10-24T00:06:00Z",
        attemptId: "01JCREVIEW0000000000000A",
        ...review,
      },
    },
    ...over,
  });

test("review-enabled pending item projects as reviewer and is ready (先审后跑)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool([verItem()], reviewerCtx());
  assert.deepEqual(entry, {
    key: "REQ-0001",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: true,
    reasons: [],
    role: "reviewer",
  });
});

test("a current-digest pass review hands the item to the system checks step (no longer an LLM task)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool([reviewedItem({})], reviewerCtx());
  // T3：过审项交引擎 system 检查步（checksDue 的 due 输入）——投影按 P2 落
  // designer wrong-phase 桶，不在 ready 队列。
  assert.equal(entry.role, "designer", "review passed for the current candidates → system checks step");
  assert.equal(entry.ready, false);
  assert.deepEqual(entry.reasons, ["wrong-phase"]);
});

test("a stale-digest pass review sends the item back to the reviewer (new candidates need a fresh review)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // 开发重提交了新候选（旧 review 的 candidateDigest 还是旧候选集的摘要）——
  // reviewPending 共用判定的语义经角色投影可观察：回到 reviewer 再审。
  const [entry] = projectDeliveryPool(
    [reviewedItem({ candidateDigest: candidatesDigest([{ repositoryId: "repo-1", commit: "new999" }]) })],
    reviewerCtx(),
  );
  assert.equal(entry.role, "reviewer");
  assert.equal(entry.ready, true);
  assert.deepEqual(entry.reasons, []);
});

test("each reviewer-only reason blocks exactly its own reason", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    // 无候选（候选即 reviewer 的审阅对象——同 verifier 的仓范围语义）。
    [
      "no-repo-scope",
      [
        verItem({
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
          },
        }),
      ],
      reviewerCtx(),
    ],
    // review-done（digest current）：degenerate 态——rework 判定与当前候选绑定
    //（正常流转中 rework 会打回并清候选，不会停在 verification）。判定已对当前
    // 候选集做出 → 不再重派。
    [
      "review-done",
      [
        reviewedItem({ outcome: "rework", source: "code", notes: "实现缺陷" }),
      ],
      reviewerCtx(),
    ],
  ];
  const exercised = new Set();
  for (const [reason, items, context] of cases) {
    const [entry] = projectDeliveryPool(items, context);
    assert.equal(entry.ready, false, `${reason} must block`);
    assert.equal(entry.role, "reviewer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  assert.equal(exercised.size, 2);
});

test("shared blocking branches apply on the reviewer side too", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    ["automation-disabled", verItem(), reviewerCtx({ enabled: false })],
    ["active-claim", verItem(), reviewerCtx({ activeClaims: new Set(["REQ-0001"]) })],
    ["automation-paused", verItem(), reviewerCtx({ paused: new Set(["REQ-0001"]) })],
    ["failure-limit", verItem(), reviewerCtx({ failureCountByKey: new Map([["REQ-0001", 3]]) })],
    ["terminal-status", verItem({ status: "in_progress" }), reviewerCtx()],
    ["archived", verItem({ archivedAt: "2026-10-24T00:00:00Z" }), reviewerCtx()],
    // 澄清门（final-arch step-2）reviewer 侧同样生效。
    [
      "awaiting-answer",
      verItem({
        delivery: {
          ...verItem().delivery,
          clarifications: [
            {
              id: "01JC8CLARIF0000000000000A",
              role: "reviewer",
              question: "跑哪个环境？",
              askedAt: "2026-10-26T01:00:00Z",
              attemptId: "01JC8ATTEMPT0000000000000A",
            },
          ],
        },
      }),
      reviewerCtx(),
    ],
  ];
  for (const [reason, poolItem, context] of cases) {
    const [entry] = projectDeliveryPool([poolItem], context);
    assert.equal(entry.ready, false, `${reason} must block on the reviewer side`);
    assert.equal(entry.role, "reviewer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
  }
});

test("review-disabled is defensive vocabulary: projection routes review-off items to the system checks step", async () => {
  // review-disabled 分支经投影不可达（角色投影把 review 关闭的项交给 system
  // 检查步）；词表由源断言钉死（见文末），此处钉死关闭行为。
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool([verItem()], verCtx());
  assert.equal(entry.role, "designer");
  assert.equal(entry.ready, false);
  assert.deepEqual(entry.reasons, ["wrong-phase"]);
});

test("reviewPending: the shared gate behind the reviewer split and the system checks step", async () => {
  const { reviewPending } = await import("./pool.ts");
  // review 关闭（或缺席键）→ 恒 false（旧流程零变化）。
  assert.equal(reviewPending(verItem(), verCtx()), false, "review disabled → never pending");
  // 开启 + 无 review → 欠审。
  assert.equal(reviewPending(verItem(), reviewerCtx()), true);
  // 开启 + pass 且 digest 与当前候选集一致 → 不欠。
  assert.equal(reviewPending(reviewedItem({}), reviewerCtx()), false);
  // 开启 + pass 但候选被换（digest 不符）→ 欠审（重审新候选）。
  assert.equal(
    reviewPending(
      reviewedItem({ candidateDigest: candidatesDigest([{ repositoryId: "repo-1", commit: "new999" }]) }),
      reviewerCtx(),
    ),
    true,
  );
  // 开启 + rework 判定 → 欠审（rework 不是 pass）。
  assert.equal(reviewPending(reviewedItem({ outcome: "rework", source: "code" }), reviewerCtx()), true);
});

test("role is decided by phase: verification splits reviewer/system-step by reviewPending; other phases unchanged", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const mixed = projectDeliveryPool(
    [
      verItem({ key: "REQ-0005" }),
      reviewedItem({}, { key: "REQ-0006" }),
      devItem({ key: "REQ-0003" }),
      item({ key: "REQ-0004", phase: "intake" }),
    ],
    reviewerCtx(),
  );
  const byKey = new Map(mixed.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("REQ-0005").role, "reviewer", "pending review → reviewer");
  assert.equal(byKey.get("REQ-0006").role, "designer",
    "passed review → system checks step (designer wrong-phase, out of the LLM queue)");
  assert.equal(byKey.get("REQ-0006").ready, false);
  assert.equal(byKey.get("REQ-0003").role, "developer");
  assert.equal(byKey.get("REQ-0004").role, "designer");
});

// -------------------------------------------------- release-preparer side

const REL_CANDIDATES = [{ repositoryId: "repo-1", commit: "abc123" }];

/** release-preparer 侧最小可领输入：release_ready 阶段 + 已确认设计 + 候选 +
 *  验证通过记录（verification.candidateDigest 与当前候选集摘要一致——候选未被换）。 */
const relItem = (over = {}) => ({
  ...item({
    phase: "release_ready",
    delivery: {
      protocolVersion: 1,
      mode: "manual",
      designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
      candidates: REL_CANDIDATES,
      verification: {
        at: "2026-10-24T00:05:00Z",
        actor: "agent",
        requirementDigest: "digest-a",
        candidateDigest: candidatesDigest(REL_CANDIDATES),
        checks: [{ name: "build", outcome: "passed" }],
      },
    },
  }),
  ...over,
});

test("release-preparer-ready item projects with role release-preparer and empty reasons", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool([relItem()], ctx());
  assert.deepEqual(entry, {
    key: "REQ-0001",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: true,
    reasons: [],
    role: "release-preparer",
  });
});

test("each release-preparer-only reason blocks exactly its own reason", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    // verification 缺失（release_ready 但无验证通过记录——人手挪阶段/块被清）。
    [
      "verification-missing",
      [
        relItem({
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
            candidates: REL_CANDIDATES,
          },
        }),
      ],
      ctx(),
    ],
    // 候选被换（verification.candidateDigest 还是旧候选集的摘要）。
    [
      "stale-verification",
      [
        relItem({
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
            candidates: [{ repositoryId: "repo-1", commit: "changed999" }],
            verification: {
              at: "2026-10-24T00:05:00Z",
              actor: "agent",
              requirementDigest: "digest-a",
              candidateDigest: candidatesDigest(REL_CANDIDATES),
              checks: [{ name: "build", outcome: "passed" }],
            },
          },
        }),
      ],
      ctx(),
    ],
    // 候选被清（rework 四清式——candidates 缺席 → 摘要与 verification 记录不匹配）。
    [
      "stale-verification",
      [
        relItem({
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
            verification: {
              at: "2026-10-24T00:05:00Z",
              actor: "agent",
              requirementDigest: "digest-a",
              candidateDigest: candidatesDigest(REL_CANDIDATES),
              checks: [{ name: "build", outcome: "passed" }],
            },
          },
        }),
      ],
      ctx(),
    ],
    // 已有发布材料（T2 循环闸，carried ruling #1）：前轮 release-preparer（或人工
    // prepare-release）已写 releasePlan——已准备过的项不再自动重派，人重新起草
    // 走人工 prepare-release 路由。
    [
      "release-plan-exists",
      [
        relItem({
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            designConfirmed: { at: "2026-10-24T00:00:00Z", actor: "user" },
            candidates: REL_CANDIDATES,
            verification: {
              at: "2026-10-24T00:05:00Z",
              actor: "agent",
              requirementDigest: "digest-a",
              candidateDigest: candidatesDigest(REL_CANDIDATES),
              checks: [{ name: "build", outcome: "passed" }],
            },
            releasePlan: { notes: "首发说明：新增登录页。" },
          },
        }),
      ],
      ctx(),
    ],
  ];
  const exercised = new Set();
  for (const [reason, items, context] of cases) {
    const [entry] = projectDeliveryPool(items, context);
    assert.equal(entry.ready, false, `${reason} must block`);
    assert.equal(entry.role, "release-preparer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  // 3 release-preparer reasons all exercised (stale-verification twice:
  // candidates swapped + candidates cleared; release-plan-exists = T2 循环闸).
  assert.equal(exercised.size, 3);
});

test("shared blocking branches apply on the release-preparer side too", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    ["automation-disabled", relItem(), ctx({ enabled: false })],
    ["active-claim", relItem(), ctx({ activeClaims: new Set(["REQ-0001"]) })],
    ["pending-interruption", relItem(), ctx({ pendingInterruptions: new Set(["REQ-0001"]) })],
    ["automation-paused", relItem(), ctx({ paused: new Set(["REQ-0001"]) })],
    ["failure-limit", relItem(), ctx({ failureCountByKey: new Map([["REQ-0001", 3]]) })],
    ["terminal-status", relItem({ status: "cancelled" }), ctx()],
    ["terminal-status", relItem({ status: "done" }), ctx()],
    // claim 崩溃窗口（status=in_progress）在 release-preparer 侧同样堵死。
    ["terminal-status", relItem({ status: "in_progress" }), ctx()],
    ["archived", relItem({ archivedAt: "2026-10-24T00:00:00Z" }), ctx()],
  ];
  const exercised = new Set();
  for (const [reason, poolItem, context] of cases) {
    const [entry] = projectDeliveryPool([poolItem], context);
    assert.equal(entry.ready, false, `${reason} must block on the release-preparer side`);
    assert.equal(entry.role, "release-preparer");
    assert.deepEqual(entry.reasons, [reason], `${reason} must be the sole reason`);
    exercised.add(reason);
  }
  // 7 unique shared reasons (terminal-status thrice: cancelled/done/in_progress).
  assert.equal(exercised.size, 7);

  // not-managed 在 release-preparer 侧与 verification-missing 累积（无 delivery
  // 块 → verification 自然缺失，多因并报不短路）。
  const [notManaged] = projectDeliveryPool([relItem({ delivery: undefined })], ctx());
  assert.equal(notManaged.ready, false);
  assert.equal(notManaged.reasons[0], "not-managed");
  assert.ok(notManaged.reasons.includes("verification-missing"));
});

test("release-preparer predicate ignores repo scope and checks (pure-document role)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // 候选仓不在登记表 / checks 未配置都不影响 release-preparer——谓词只看
  // verification 记录与候选摘要一致性。
  const [entry] = projectDeliveryPool([relItem()], ctx({ registeredRepos: new Map() }));
  assert.equal(entry.ready, true);
  assert.equal(entry.role, "release-preparer");
});

test("existing role predicates stay byte-identical; verification falls through to designer (Phase-5/T3 regression pin)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // designer/developer 谓词零变化；verification 项（T3 起）落 designer
  // wrong-phase——release-preparer 入场与 verifier 退役都不改旧角色投影。
  const entries = projectDeliveryPool(
    [item({ key: "REQ-0004" }), devItem({ key: "REQ-0003" }), verItem({ key: "REQ-0002" })],
    verCtx(),
  );
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  assert.deepEqual(byKey.get("REQ-0004"), {
    key: "REQ-0004",
    title: "Alpha",
    priority: "P1",
    requirementDigest: "digest-a",
    ready: true,
    reasons: [],
    role: "designer",
  });
  assert.equal(byKey.get("REQ-0003").role, "developer");
  assert.deepEqual(byKey.get("REQ-0003").reasons, []);
  assert.equal(byKey.get("REQ-0002").role, "designer");
  assert.deepEqual(byKey.get("REQ-0002").reasons, ["wrong-phase"]);
});

// -------------------------------------------------- ask-a-human pool gate

/** 未答澄清（final-arch step-2：ask 事务的持久产物；answer/answeredAt 缺席 =
 *  未答态——parseDelivery 的同在同缺约束，纯投影只读 answer 在场与否）。 */
const unansweredClarification = (over = {}) => ({
  id: "01JC8CLARIF0000000000000A",
  role: "designer",
  question: "跑哪个环境？",
  askedAt: "2026-10-26T01:00:00Z",
  attemptId: "01JC8ATTEMPT0000000000000A",
  ...over,
});

/** 给某角色的 delivery 块追加 clarifications（结构子集透传）。 */
const withClarifications = (item0, clarifications) => ({
  ...item0,
  delivery: { ...item0.delivery, clarifications },
});

test("an unanswered clarification parks every role out of the ready queue via awaiting-answer", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const cases = [
    ["designer", withClarifications(item(), [unansweredClarification()]), ctx()],
    ["developer", withClarifications(devItem(), [unansweredClarification({ role: "developer" })]), devCtx()],
    ["reviewer", withClarifications(verItem(), [unansweredClarification({ role: "reviewer" })]), reviewerCtx()],
    ["release-preparer", withClarifications(relItem(), [unansweredClarification({ role: "release-preparer" })]), ctx()],
  ];
  for (const [role, poolItem, context] of cases) {
    const [entry] = projectDeliveryPool([poolItem], context);
    assert.equal(entry.ready, false, `${role}: an open question must park the item`);
    assert.equal(entry.role, role);
    assert.deepEqual(entry.reasons, ["awaiting-answer"],
      `${role}: awaiting-answer is the sole reason for an otherwise-ready item`);
  }
});

test("answering every clarification restores readiness; one open answer keeps the item parked", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  // 全部已答 → 恢复可领（reasons 空）。
  const [answered] = projectDeliveryPool(
    [withClarifications(item(), [
      unansweredClarification({ answer: "Node 22", answeredAt: "2026-10-26T02:00:00Z" }),
    ])],
    ctx(),
  );
  assert.equal(answered.ready, true);
  assert.deepEqual(answered.reasons, []);

  // 一答一未答 → 仍停车（任一未答即停，不短路）。
  const [half] = projectDeliveryPool(
    [withClarifications(item(), [
      unansweredClarification({ id: "01JC8CLARIF0000000000000A", answer: "Node 22", answeredAt: "2026-10-26T02:00:00Z" }),
      unansweredClarification({ id: "01JC8CLARIF0000000000000B", question: "还有：端口呢？" }),
    ])],
    ctx(),
  );
  assert.equal(half.ready, false);
  assert.deepEqual(half.reasons, ["awaiting-answer"]);
});

test("no clarifications (absent or empty array) changes nothing (regression)", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [absent] = projectDeliveryPool([item()], ctx());
  assert.equal(absent.ready, true);
  assert.deepEqual(absent.reasons, []);
  const [empty] = projectDeliveryPool([withClarifications(item(), [])], ctx());
  assert.equal(empty.ready, true);
  assert.deepEqual(empty.reasons, []);
});

test("awaiting-answer accumulates after the role reasons and runtime signals in canonical order", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const [entry] = projectDeliveryPool(
    [withClarifications(item({ phase: "design" }), [unansweredClarification()])],
    ctx({ activeClaims: new Set(["REQ-0001"]) }),
  );
  assert.deepEqual(entry.reasons, ["wrong-phase", "active-claim", "awaiting-answer"]);
});

// final-arch step-2 Task 3：PoolEntry 原样透传条目澄清（结构子集——dispatcher
// 据此把已答部分随任务包进开场 prompt）；无澄清 → 键省略（既有投影钉子零变化）。
test("PoolEntry passes the item's clarifications through; absent clarifications omit the key", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const clarifications = [
    { question: "已答的？", answer: "答案", askedAt: "2026-10-26T00:00:00Z" },
    { question: "未答的？", askedAt: "2026-10-26T00:01:00Z" },
  ];
  const [entry] = projectDeliveryPool([withClarifications(item(), clarifications)], ctx());
  assert.deepEqual(entry.clarifications, clarifications);
  const [bare] = projectDeliveryPool([item()], ctx());
  assert.equal(bare.clarifications, undefined);
});

// ------------------------------------------------------------- merged pool

test("empty input projects to an empty pool", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  assert.deepEqual(projectDeliveryPool([], ctx()), []);
});

test("merged pool sorts across roles by priority then key; developer P0 before designer P1", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const entries = projectDeliveryPool(
    [
      item({ key: "REQ-0005", priority: "P1" }),                       // designer P1
      devItem({ key: "REQ-0010", priority: "P0" }),                    // developer P0
      devItem({ key: "REQ-0003", priority: "P0" }),                    // developer P0
      item({ key: "REQ-0100", priority: "P0" }),                       // designer P0
      item({ key: "REQ-0006", priority: "PX" }),                       // unknown priority
    ],
    devCtx(),
  );
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["REQ-0003", "REQ-0010", "REQ-0100", "REQ-0005", "REQ-0006"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.role),
    ["developer", "developer", "designer", "designer", "designer"],
    "same priority interleaves roles by key — role is not a tiebreaker",
  );
  // developer P0 压过 designer P1（优先级主导，角色不参与排序）。
  assert.equal(entries[0].key, "REQ-0003");
  assert.equal(entries[3].key, "REQ-0005");
});

test("merged pool sorts across three roles by priority then key; role is never a tiebreaker", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const entries = projectDeliveryPool(
    [
      item({ key: "REQ-0005", priority: "P1" }),                       // designer P1
      verItem({ key: "REQ-0002", priority: "P0" }),                    // reviewer P0（欠审）
      devItem({ key: "REQ-0010", priority: "P0" }),                    // developer P0
      devItem({ key: "REQ-0003", priority: "P0" }),                    // developer P0
      item({ key: "REQ-0100", priority: "P0" }),                       // designer P0
      item({ key: "REQ-0006", priority: "PX" }),                       // unknown priority
    ],
    reviewerCtx(),
  );
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["REQ-0002", "REQ-0003", "REQ-0010", "REQ-0100", "REQ-0005", "REQ-0006"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.role),
    ["reviewer", "developer", "developer", "designer", "designer", "designer"],
    "same priority interleaves all three roles by key — role is not a tiebreaker",
  );
});

test("merged pool sorts across four roles by priority then key; role is never a tiebreaker", async () => {
  const { projectDeliveryPool } = await import("./pool.ts");
  const entries = projectDeliveryPool(
    [
      item({ key: "REQ-0005", priority: "P1" }),                       // designer P1
      relItem({ key: "REQ-0004", priority: "P0" }),                    // release-preparer P0
      verItem({ key: "REQ-0002", priority: "P0" }),                    // reviewer P0（欠审）
      devItem({ key: "REQ-0010", priority: "P0" }),                    // developer P0
      item({ key: "REQ-0100", priority: "P0" }),                       // designer P0
      item({ key: "REQ-0006", priority: "PX" }),                       // unknown priority
    ],
    ctx({ reviewEnabled: true }),
  );
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["REQ-0002", "REQ-0004", "REQ-0010", "REQ-0100", "REQ-0005", "REQ-0006"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.role),
    ["reviewer", "release-preparer", "developer", "designer", "designer", "designer"],
    "same priority interleaves all four roles by key — role is not a tiebreaker",
  );
});

// ------------------------------------------------------------ read side

const managedDeliveryYaml = ["delivery:", "  protocolVersion: 1", "  mode: manual"];
const confirmedDeliveryYaml = [
  "delivery:",
  "  protocolVersion: 1",
  "  mode: manual",
  "  designConfirmed:",
  '    at: "2026-10-24T00:00:00Z"',
  "    actor: user",
  '    requirementDigest: "deadbeef"',
  '    designDigest: "cafef00d"',
];

/** Minimal valid item.yaml for listWorkItems/readWorkItem. verification 参数 =
 *  {candidateDigest} 时追加验证通过记录块（Phase-5 release-preparer 谓词输入）；
 *  clarifications 参数 = 澄清数组（final-arch step-2：未答条目 → awaiting-answer）。 */
const itemYaml = ({
  key,
  title,
  priority,
  status = "open",
  phase = "intake",
  managed = true,
  designConfirmed = false,
  archivedAt = null,
  repositories = [],
  candidates = null,
  verification = null,
  review = null,
  clarifications = null,
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
    `repositories: [${repositories.map((id) => JSON.stringify(id)).join(", ")}]`,
    "tags: []",
    "conversations: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    `archived_at: ${archivedAt === null ? "null" : JSON.stringify(archivedAt)}`,
    `created_at: "2026-10-24T00:00:00Z"`,
    `updated_at: "2026-10-24T00:00:00Z"`,
    ...(managed ? (designConfirmed ? confirmedDeliveryYaml : managedDeliveryYaml) : []),
    ...(managed && candidates
      ? candidates.length
        ? [
            "  candidates:",
            ...candidates.flatMap((candidate) => [
              `    - repositoryId: ${candidate.repositoryId}`,
              `      commit: ${JSON.stringify(candidate.commit)}`,
            ]),
          ]
        : ["  candidates: []"]
      : []),
    ...(managed && verification
      ? [
          "  verification:",
          '    at: "2026-10-24T00:05:00Z"',
          "    actor: agent",
          '    requirementDigest: "deadbeef"',
          `    candidateDigest: "${verification.candidateDigest}"`,
          "    checks:",
          "      - name: build",
          "        outcome: passed",
        ]
      : []),
    ...(managed && review
      ? [
          "  review:",
          `    outcome: ${review.outcome ?? "pass"}`,
          ...(review.source ? [`    source: ${review.source}`] : []),
          `    notes: ${JSON.stringify(review.notes ?? "通过")}`,
          `    candidateDigest: "${review.candidateDigest}"`,
          '    at: "2026-10-24T00:06:00Z"',
          '    attemptId: "01JCREVIEW0000000000000A"',
        ]
      : []),
    ...(managed && clarifications
      ? [
          "  clarifications:",
          ...clarifications.flatMap((clarification) => [
            `    - id: ${JSON.stringify(clarification.id)}`,
            `      role: ${clarification.role}`,
            `      question: ${JSON.stringify(clarification.question)}`,
            `      askedAt: ${JSON.stringify(clarification.askedAt)}`,
            `      attemptId: ${JSON.stringify(clarification.attemptId)}`,
            ...(clarification.answer !== undefined
              ? [`      answer: ${JSON.stringify(clarification.answer)}`]
              : []),
            ...(clarification.answeredAt !== undefined
              ? [`      answeredAt: ${JSON.stringify(clarification.answeredAt)}`]
              : []),
          ]),
        ]
      : []),
    "",
  ].join("\n");

async function writeItem(root, {
  key, slug, readme = `# ${key}\n`, events = "", skipEvents = false, ...rest
}) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, ...rest }), "utf8");
  await writeFile(join(dir, "README.md"), readme, "utf8");
  if (!skipEvents) await writeFile(join(dir, "events.jsonl"), events, "utf8");
}

async function writeEnabledConfig(root, maxAttemptsPerInput = 3, checks = null, review = false) {
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "delivery.yaml"),
    [
      "schemaVersion: 1",
      "enabled: true",
      `budget: { maxAttemptsPerInput: ${maxAttemptsPerInput}, maxExecutionMinutes: 30 }`,
      ...(checks
        ? [
            "verification:",
            "  checks:",
            ...checks.flatMap((check) => [
              `    - name: ${check.name}`,
              ...(check.repositoryId ? [`      repositoryId: ${check.repositoryId}`] : []),
              `      command: ${JSON.stringify(check.command)}`,
              ...(check.timeout_seconds ? [`      timeout_seconds: ${check.timeout_seconds}`] : []),
            ]),
          ]
        : []),
      ...(review ? ["stages:", "  review:", "    enabled: true"] : []),
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Minimal valid workspace manifest（对照 claim.test.mjs 的 writeManifest）；
 * repositories 条目驱动读取端 registeredRepos 装配。 */
async function writeManifest(root, repositories = []) {
  const repositoryYaml = repositories.map((repo) => [
    `  - id: ${repo.id}`,
    `    alias: ${repo.alias}`,
    `    name: ${JSON.stringify(repo.name)}`,
    "    kind: code",
    `    path: repos/${repo.alias}`,
    `    status: ${repo.status}`,
  ].join("\n"));
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(
    join(root, ".pi", "workspace.yaml"),
    [
      "schema_version: 1",
      "id: 01TESTWORKSPACE00000000000",
      "slug: test-ws",
      'name: "Test WS"',
      "skills: []",
      `repositories:${repositoryYaml.length ? `\n${repositoryYaml.join("\n")}` : " []"}`,
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

const REPO_ACTIVE = "01TESTREPOACTIVE00000A";
const REPO_REMOVED = "01TESTREPOREMOVED0000B";

test("listDeliveryPool buckets ready/blocked and digests README content", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1", readme: "Alpha body\n" });
  await writeItem(ws, { key: "REQ-0002", slug: "plain", title: "Plain", priority: "P0", managed: false });

  const pool = await listDeliveryPool(ws);
  assert.deepEqual(
    pool.ready.map((entry) => entry.key),
    ["REQ-0001"],
  );
  assert.deepEqual(
    pool.blocked.map((entry) => entry.key),
    ["REQ-0002"],
  );
  assert.equal(pool.ready[0].requirementDigest, contentDigest("Alpha body\n"));
  assert.equal(pool.ready[0].role, "designer");
  assert.deepEqual(pool.blocked[0].reasons, ["not-managed"]);
  // 未 managed 项不读详情：digest 为空串（纯投影只比较，不计算）。
  assert.equal(pool.blocked[0].requirementDigest, "");
});

test("listDeliveryPool treats a missing config as automation-disabled", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-cfg-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1" });

  const pool = await listDeliveryPool(ws);
  assert.equal(pool.ready.length, 0);
  assert.deepEqual(pool.blocked.map((entry) => entry.reasons), [["automation-disabled"]]);
});

test("listDeliveryPool survives a broken detail read (missing events.jsonl) — still projected", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-grace-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1", skipEvents: true });

  const pool = await listDeliveryPool(ws);
  // 详情读失败 → 空内容摘要，fs 容错：不抛、不吞项。
  assert.deepEqual(
    pool.ready.map((entry) => entry.key),
    ["REQ-0001"],
  );
  assert.equal(pool.ready[0].requirementDigest, contentDigest(""));
});

test("listDeliveryPool assembles registeredRepos from the workspace manifest (developer projection)", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-dev-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeManifest(ws, [
    { id: REPO_ACTIVE, alias: "repo-a", name: "Repo A", status: "active" },
    { id: REPO_REMOVED, alias: "repo-b", name: "Repo B", status: "removed" },
  ]);
  await writeEnabledConfig(ws);
  // developer 可领：rfi + 已确认设计 + 范围仓 active。
  await writeItem(ws, {
    key: "REQ-0001", slug: "dev", title: "Dev", priority: "P1",
    phase: "ready_for_implementation", designConfirmed: true,
    repositories: [REPO_ACTIVE],
  });
  // developer 不可领：范围仓已登记但 removed。
  await writeItem(ws, {
    key: "REQ-0002", slug: "removed", title: "Removed", priority: "P1",
    phase: "ready_for_implementation", designConfirmed: true,
    repositories: [REPO_REMOVED],
  });
  // developer 不可领：范围仓未登记。
  await writeItem(ws, {
    key: "REQ-0003", slug: "ghost", title: "Ghost", priority: "P1",
    phase: "ready_for_implementation", designConfirmed: true,
    repositories: ["01TESTREPOGHOST00000C"],
  });
  // developer 不可领：设计未确认。
  await writeItem(ws, {
    key: "REQ-0004", slug: "unconfirmed", title: "Unconfirmed", priority: "P1",
    phase: "ready_for_implementation",
  });
  // designer 可领：intake 与 manifest 仓登记无关。
  await writeItem(ws, { key: "REQ-0005", slug: "des", title: "Des", priority: "P2" });

  const pool = await listDeliveryPool(ws);
  assert.deepEqual(
    pool.ready.map((entry) => entry.key),
    ["REQ-0001", "REQ-0005"],
    "merged ready queue: same priority by key, roles interleaved",
  );
  assert.deepEqual(
    pool.ready.map((entry) => entry.role),
    ["developer", "designer"],
  );
  const blockedByKey = new Map(pool.blocked.map((entry) => [entry.key, entry]));
  assert.deepEqual(blockedByKey.get("REQ-0002").reasons, ["repo-not-registered"]);
  assert.deepEqual(blockedByKey.get("REQ-0003").reasons, ["repo-not-registered"]);
  assert.deepEqual(blockedByKey.get("REQ-0004").reasons, [
    "design-unconfirmed",
    "no-repo-scope",
  ], "unconfirmed rfi item with an empty scope accumulates both reasons");
});

test("listDeliveryPool tolerates a missing manifest: designer unaffected, developer surfaces repo-not-registered", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-nomanifest-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  await writeItem(ws, { key: "REQ-0001", slug: "des", title: "Des", priority: "P1" });
  await writeItem(ws, {
    key: "REQ-0002", slug: "dev", title: "Dev", priority: "P1",
    phase: "ready_for_implementation", designConfirmed: true,
    repositories: [REPO_ACTIVE],
  });

  const pool = await listDeliveryPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0001"]);
  assert.equal(pool.ready[0].role, "designer");
  assert.deepEqual(pool.blocked[0].reasons, ["repo-not-registered"]);
});

test("listDeliveryPool: verification items leave the ready queue — the system checks step owns them (read-side)", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-ver-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeManifest(ws, [
    { id: REPO_ACTIVE, alias: "repo-a", name: "Repo A", status: "active" },
  ]);
  // 配置两条检查：unit 无 repositoryId（缺省=候选首仓）、lint 显式 REPO_ACTIVE。
  await writeEnabledConfig(ws, 3, [
    { name: "unit", command: "npm test" },
    { name: "lint", repositoryId: REPO_ACTIVE, command: "npm run lint", timeout_seconds: 120 },
  ]);
  // verification + 已确认设计 + 候选仓 active：T3 起不再是 verifier ready——
  // dispatcher 的 system 检查步按 checks-step.checksDue 接手。
  await writeItem(ws, {
    key: "REQ-0001", slug: "ver", title: "Ver", priority: "P1",
    phase: "verification", designConfirmed: true,
    candidates: [{ repositoryId: REPO_ACTIVE, commit: "abc123" }],
  });
  // 候选指向 ghost 仓：同样不在 ready 队列（checks-step 的 repo-not-registered
  // due 门拦住开跑，投影词统一 wrong-phase）。
  await writeItem(ws, {
    key: "REQ-0002", slug: "ghost", title: "Ghost", priority: "P1",
    phase: "verification", designConfirmed: true,
    candidates: [{ repositoryId: "01TESTREPOGHOST00000C", commit: "def456" }],
  });
  // 无候选：同上（checks-step 的 no-repo-scope 门）。
  await writeItem(ws, {
    key: "REQ-0003", slug: "nocand", title: "NoCand", priority: "P1",
    phase: "verification", designConfirmed: true, candidates: [],
  });

  const pool = await listDeliveryPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), [],
    "verification items are not LLM-claimable anymore");
  const blockedByKey = new Map(pool.blocked.map((entry) => [entry.key, entry]));
  for (const key of ["REQ-0001", "REQ-0002", "REQ-0003"]) {
    assert.equal(blockedByKey.get(key).role, "designer");
    assert.deepEqual(blockedByKey.get(key).reasons, ["wrong-phase"]);
  }
});

test("listDeliveryPool: a verification item without configured checks stays out of the ready queue (配置引导在 checks-step 的 checks-empty)", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-nochecks-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeManifest(ws, [
    { id: REPO_ACTIVE, alias: "repo-a", name: "Repo A", status: "active" },
  ]);
  // writeEnabledConfig 无 checks 参数 → 配置无 verification 键。
  await writeEnabledConfig(ws);
  await writeItem(ws, {
    key: "REQ-0001", slug: "ver", title: "Ver", priority: "P1",
    phase: "verification", designConfirmed: true,
    candidates: [{ repositoryId: REPO_ACTIVE, commit: "abc123" }],
  });

  const pool = await listDeliveryPool(ws);
  assert.equal(pool.ready.length, 0);
  assert.equal(pool.blocked[0].role, "designer");
  assert.deepEqual(pool.blocked[0].reasons, ["wrong-phase"],
    "投影不再报 no-checks-configured——该词表与 due 门迁往 checks-step（checks-empty）");
});

test("listDeliveryPool passes the verification block into the release-preparer projection", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-rel-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  const verified = [{ repositoryId: "01TESTREPOACTIVE00000A", commit: "abc123" }];
  // release-preparer 可领：release_ready + verification.candidateDigest 与候选集一致。
  await writeItem(ws, {
    key: "REQ-0001", slug: "rel", title: "Rel", priority: "P1",
    phase: "release_ready", designConfirmed: true,
    candidates: verified,
    verification: { candidateDigest: candidatesDigest(verified) },
  });
  // release-preparer 不可领：候选被换（verification 记录还是旧候选集的摘要）。
  await writeItem(ws, {
    key: "REQ-0002", slug: "stale", title: "Stale", priority: "P1",
    phase: "release_ready", designConfirmed: true,
    candidates: [{ repositoryId: "01TESTREPOACTIVE00000A", commit: "changed999" }],
    verification: { candidateDigest: candidatesDigest(verified) },
  });
  // release-preparer 不可领：verification 块缺失（release_ready 但未验证）。
  await writeItem(ws, {
    key: "REQ-0003", slug: "unverified", title: "Unverified", priority: "P1",
    phase: "release_ready", designConfirmed: true,
    candidates: verified,
  });

  const pool = await listDeliveryPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0001"]);
  assert.equal(pool.ready[0].role, "release-preparer");
  const blockedByKey = new Map(pool.blocked.map((entry) => [entry.key, entry]));
  assert.deepEqual(blockedByKey.get("REQ-0002").reasons, ["stale-verification"]);
  assert.deepEqual(blockedByKey.get("REQ-0003").reasons, ["verification-missing"]);
});

test("listDeliveryPool assembles stages.review into the reviewer/system-step split (read-side)", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-rev-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeManifest(ws, [
    { id: REPO_ACTIVE, alias: "repo-a", name: "Repo A", status: "active" },
  ]);
  await writeEnabledConfig(ws, 3, [{ name: "unit", command: "npm test" }], true);
  const cand = [{ repositoryId: REPO_ACTIVE, commit: "abc123" }];
  const currentDigest = candidatesDigest(cand);
  // 欠审 → ready role reviewer。
  await writeItem(ws, {
    key: "REQ-0001", slug: "pending", title: "Pending", priority: "P1",
    phase: "verification", designConfirmed: true, candidates: cand,
  });
  // 已过审（digest current）→ ready role verifier。
  await writeItem(ws, {
    key: "REQ-0002", slug: "passed", title: "Passed", priority: "P1",
    phase: "verification", designConfirmed: true, candidates: cand,
    review: { candidateDigest: currentDigest },
  });
  // 旧 review 绑旧候选（候选被换）→ 回 reviewer 再审。
  await writeItem(ws, {
    key: "REQ-0003", slug: "stale", title: "Stale", priority: "P1",
    phase: "verification", designConfirmed: true,
    candidates: [{ repositoryId: REPO_ACTIVE, commit: "new999" }],
    review: { candidateDigest: currentDigest },
  });

  const pool = await listDeliveryPool(ws);
  // 欠审（新候选/无判定）→ ready reviewer；过审 → 交 system 检查步（不在 ready）。
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0001", "REQ-0003"]);
  const byKey = new Map(pool.ready.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("REQ-0001").role, "reviewer");
  assert.equal(byKey.get("REQ-0003").role, "reviewer",
    "stale review digest → back to the reviewer for the new candidates");
  const passed = pool.blocked.find((entry) => entry.key === "REQ-0002");
  assert.equal(passed.role, "designer", "passed review → system checks step (designer wrong-phase)");
  assert.deepEqual(passed.reasons, ["wrong-phase"]);
});

test("listDeliveryPool without stages.review hands verification items to the system checks step (read-side)", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-norev-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeManifest(ws, [
    { id: REPO_ACTIVE, alias: "repo-a", name: "Repo A", status: "active" },
  ]);
  await writeEnabledConfig(ws, 3, [{ name: "unit", command: "npm test" }]);
  await writeItem(ws, {
    key: "REQ-0001", slug: "ver", title: "Ver", priority: "P1",
    phase: "verification", designConfirmed: true,
    candidates: [{ repositoryId: REPO_ACTIVE, commit: "abc123" }],
  });

  const pool = await listDeliveryPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), [],
    "review off → verification is the system step's job, not an LLM task");
  assert.equal(pool.blocked[0].role, "designer");
  assert.deepEqual(pool.blocked[0].reasons, ["wrong-phase"]);
});

// 词表钉死（binding）：step-3 T2 的谓词词（review-disabled / review-done）留在
// pool.ts；T3 起检查步词表（checks-empty / checks-done / awaiting-review）迁往
// checks-step.ts——源断言直达（roles.test.mjs 同习语）。
test("pool and checks-step reason vocabularies carry their step-3 words", async () => {
  const { readFile } = await import("node:fs/promises");
  const poolSource = await readFile(new URL("./pool.ts", import.meta.url), "utf8");
  for (const word of ["review-disabled", "review-done"]) {
    assert.ok(poolSource.includes(`"${word}"`), `pool vocabulary must include ${word}`);
  }
  const checksSource = await readFile(new URL("./checks-step.ts", import.meta.url), "utf8");
  for (const word of ["checks-empty", "checks-done", "awaiting-review"]) {
    assert.ok(checksSource.includes(`"${word}"`), `checks-step vocabulary must include ${word}`);
  }
  // verifier 谓词已退役：pool.ts 不再有 no-checks-configured / awaiting-review。
  assert.ok(!poolSource.includes('"no-checks-configured"'), "verifier word retired from the pool");
  assert.ok(!poolSource.includes('"awaiting-review"'), "awaiting-review moved to checks-step");
});

test("listDeliveryPool parks an item with an unanswered clarification and recovers after a human answer (read-side)", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-ask-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws);
  const unanswered = {
    id: "01JC8CLARIF0000000000000A",
    role: "designer",
    question: "跑哪个环境？",
    askedAt: "2026-10-26T01:00:00Z",
    attemptId: "01JC8ATTEMPT0000000000000A",
  };
  await writeItem(ws, {
    key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1",
    clarifications: [unanswered],
  });

  // 未答 → 不在 ready，唯一原因 awaiting-answer。
  const parked = await listDeliveryPool(ws);
  assert.deepEqual(parked.ready.map((entry) => entry.key), []);
  assert.deepEqual(parked.blocked[0].reasons, ["awaiting-answer"]);
  assert.equal(parked.blocked[0].role, "designer");

  // 人答复（手工补 answer/answeredAt——Task 4 的 answer-clarification 语义）
  // → 恢复 ready（读取端透传 clarifications，谓词按 answer 在场与否判定）。
  await writeItem(ws, {
    key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1",
    clarifications: [{ ...unanswered, answer: "Node 22", answeredAt: "2026-10-26T02:00:00Z" }],
  });
  const restored = await listDeliveryPool(ws);
  assert.deepEqual(restored.ready.map((entry) => entry.key), ["REQ-0001"]);
});

test("listDeliveryPool consumes real runtime signals from attempts.ts across the claim lifecycle", async (t) => {
  const { listDeliveryPool } = await import("./pool.ts");
  const attempts = await import("./attempts.ts");
  const ws = await mkdtemp(join(tmpdir(), "pi-pool-rt-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await writeEnabledConfig(ws, 2);
  await writeItem(ws, { key: "REQ-0001", slug: "alpha", title: "Alpha", priority: "P1", readme: "Alpha body\n" });
  const itemPath = join(ws, ".pi", "work-items", "requirements", "REQ-0001-alpha");
  const digest = contentDigest("Alpha body\n");
  const reasons = async () => (await listDeliveryPool(ws)).blocked[0]?.reasons;

  // 无信号 → ready。
  let pool = await listDeliveryPool(ws);
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
  pool = await listDeliveryPool(ws);
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

  // Fix-round 裁定 #1/#2：读取端经 countRecentFailures 按项消费失败窗口——
  // resume 写入的窗口让窗口之前的旧失败不再计数。
  attempts.writeFailureWindow(itemPath, "2026-10-25T00:00:00Z");
  pool = await listDeliveryPool(ws);
  assert.deepEqual(pool.ready.map((entry) => entry.key), ["REQ-0001"]);
});
