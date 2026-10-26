// final-arch step-2 Task 5: attention 队列（attention.ts）。
// 纯投影 projectAttention —— 零 fs、字面量输入（对照 pool.test.mjs 风格）：
//   kind 判定与 since 锚点（question = 最早未答 askedAt；confirm = 最近
//   delivery.start-design 否则 updatedAt；release = 最近入 release_ready 事件
//   [delivery.record-verification 全 passed / delivery.submitted outcome=verified /
//   delivery.checks_passed outcome=verified] 否则 updatedAt；blocked =
//   delivery.block / delivery.checks_unverified / delivery.integrate_failed /
//   delivery.automation_paused / delivery.exec_interrupted 最新者否则 updatedAt）；
//   ageDays = floor；
//   nudged/parked 由「晚于 since 的同 kind 事件」推导（旧事件不算）；
//   排序 P0→P3→key；archived/cancelled/released/非 managed 零条目；
//   一项多 kind（blocked + question）各一条、同 kind 永不多条。
//   acceptance（final-arch step-4 Task 3）= enabled ∧ release_ready ∧ 有候选 ∧
//   无当前摘要绑定的验收记录 → 条目（锚点与 release 同）；匹配后消失。
// 读取端 collectAttention —— mkdtemp 真临时工作区：managed 项经 store 写入
//   （item.yaml 澄清 + appendEvent 事件 + writePaused 暂停标记）后端到端投影；
//   stages.acceptance.enabled 从 .pi/delivery.yaml 读入投影（缺配置 = 关）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvent } from "./service.ts";
import { listPendingInterruptions, readPaused, writePaused } from "./delivery-runner/attempts.ts";
import { parseDeliveryRunnerConfig, writeDeliveryRunnerConfig } from "./delivery-runner/config.ts";

const { projectAttention, collectAttention } = await import("./attention.ts");
// candidatesDigest 在 client-safe 纯模块上（acceptance 记录的候选绑定判定）。
const { candidatesDigest } = await import("./delivery-types.ts");

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const DAY_MS = 86_400_000;
/** 距 NOW 往前 n 天的 ISO 时刻（d(0) = NOW 本身）。 */
const d = (days) => new Date(NOW - days * DAY_MS).toISOString();

// ---------------------------------------------------------------- fixtures

const item = (over = {}) => ({
  schemaVersion: 1,
  id: "REQ-0001-id",
  key: "REQ-0001",
  revision: 1,
  type: "requirement",
  title: "Alpha",
  status: "open",
  phase: "intake",
  priority: "P1",
  repositories: [],
  tags: [],
  conversations: [],
  relatedItems: [],
  designs: [],
  plans: [],
  archivedAt: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  delivery: { protocolVersion: 1, mode: "manual" },
  ...over,
});

const event = (type, at, data) => ({
  id: `ev-${type}-${at}`,
  at,
  type,
  actor: "agent",
  ...(data !== undefined ? { data } : {}),
});

const projection = ({
  items,
  paused = new Set(),
  interrupted = new Set(),
  now = new Date(NOW),
  acceptanceEnabled = false,
}) => projectAttention({ items, paused, interrupted, now, acceptanceEnabled });

// ---------------------------------------------------------------- pure side

test("question：未答澄清 → 条目（since = 最早未答 askedAt，detail = 问题原文，带 clarificationId）", () => {
  const entries = projection({
    items: [{
      item: item({
        delivery: {
          protocolVersion: 1,
          mode: "manual",
          clarifications: [
            { id: "cl-2", role: "designer", question: "第二个？", askedAt: d(2), attemptId: "att-2" },
            { id: "cl-1", role: "designer", question: "第一个？", askedAt: d(4), attemptId: "att-1" },
            { id: "cl-0", role: "designer", question: "已答的？", askedAt: d(9), attemptId: "att-0", answer: "已答", answeredAt: d(8) },
          ],
        },
      }),
      events: [],
    }],
  });
  assert.equal(entries.length, 1, "一项只出一条 question（已答不 resurrect）");
  assert.equal(entries[0].kind, "question");
  assert.equal(entries[0].since, d(4), "since = 最早未答 askedAt");
  assert.equal(entries[0].detail, "第一个？");
  assert.equal(entries[0].clarificationId, "cl-1");
});

test("question：全部已答 → 条目消失", () => {
  const entries = projection({
    items: [{
      item: item({
        delivery: {
          protocolVersion: 1,
          mode: "manual",
          clarifications: [
            { id: "cl-1", role: "designer", question: "Q", askedAt: d(4), attemptId: "att-1", answer: "A", answeredAt: d(3) },
          ],
        },
      }),
      events: [],
    }],
  });
  assert.equal(entries.length, 0);
});

test("confirm：design 阶段未确认 → since = 最近 delivery.start-design（多个取最新），detail 固定", () => {
  const entries = projection({
    items: [{
      item: item({ phase: "design", updatedAt: d(9) }),
      events: [
        event("delivery.start-design", d(5), { phase: "design" }),
        event("delivery.start-design", d(3), { phase: "design" }),
      ],
    }],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "confirm");
  assert.equal(entries[0].since, d(3), "start-design 两个取最新");
  assert.equal(entries[0].detail, "设计待确认");
  assert.equal(entries[0].clarificationId, undefined);
});

test("confirm：无 start-design 事件 → since 回落 updatedAt；已确认/非 design 阶段 → 无条目", () => {
  {
    const entries = projection({
      items: [{ item: item({ phase: "design", updatedAt: d(9) }), events: [] }],
    });
    assert.equal(entries[0].since, d(9), "锚点回落 updatedAt");
  }
  {
    const entries = projection({
      items: [{
        item: item({
          phase: "design",
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            designConfirmed: { at: d(2), actor: "user" },
          },
        }),
        events: [],
      }],
    });
    assert.equal(entries.length, 0, "designConfirmed 在场 → 不投影 confirm");
  }
  {
    const entries = projection({ items: [{ item: item({ phase: "intake" }), events: [] }] });
    assert.equal(entries.length, 0, "非 design 阶段 → 不投影 confirm");
  }
});

test("release：release_ready 无 release 记录 → since = 最近入阶段事件（record-verification 全 passed / submitted verified）", () => {
  const base = { phase: "release_ready", updatedAt: d(9) };
  {
    const entries = projection({
      items: [{
        item: item(base),
        events: [
          event("delivery.submitted", d(4), { outcome: "verified", attemptId: "att-v" }),
          event("delivery.record-verification", d(2), { phase: "release_ready", checks: [{ name: "lint", outcome: "passed" }] }),
        ],
      }],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "release");
    assert.equal(entries[0].since, d(2), "两个锚点事件取最新");
    assert.equal(entries[0].detail, "待登记发布");
  }
  {
    const entries = projection({
      items: [{
        item: item(base),
        events: [event("delivery.submitted", d(4), { attemptId: "att-d" })],
      }],
    });
    assert.equal(entries[0].since, d(9), "designer 的 submitted（无 verified outcome）不作锚点 → 回落 updatedAt");
  }
  {
    const entries = projection({
      items: [{
        item: item({ ...base, delivery: { protocolVersion: 1, mode: "manual", release: { at: d(1), actor: "user", version: "1.0.0", candidates: [] } } }),
        events: [event("delivery.record-verification", d(2), { phase: "release_ready", checks: [] })],
      }],
    });
    assert.equal(entries.length, 0, "release 记录在场 → 不投影 release");
  }
});

test("release：system 检查步 delivery.checks_passed（outcome verified）也是入阶段锚点；早于锚点的 nudge 不算", () => {
  {
    const entries = projection({
      items: [{
        item: item({ phase: "release_ready", updatedAt: d(9) }),
        events: [event("delivery.checks_passed", d(3), { outcome: "verified", attemptId: "att-s" })],
      }],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "release");
    assert.equal(entries[0].since, d(3), "since = checks_passed 的 at（非 updatedAt）");
    assert.equal(entries[0].nudged, false, "早于锚点的 release nudge 不算（严格晚于才算）");
  }
  {
    const entries = projection({
      items: [{
        item: item({ phase: "release_ready", updatedAt: d(9) }),
        events: [
          event("delivery.checks_passed", d(5), { outcome: "verified" }),
          event("delivery.nudged", d(1), { kind: "release" }),
        ],
      }],
    });
    assert.equal(entries[0].since, d(5));
    assert.equal(entries[0].nudged, true, "晚于锚点的 nudge 照常算（对照）");
  }
  {
    const entries = projection({
      items: [{
        item: item({ phase: "release_ready", updatedAt: d(9) }),
        events: [event("delivery.checks_passed", d(3), { attemptId: "att-s" })],
      }],
    });
    assert.equal(entries[0].since, d(9), "无 outcome 的 checks_passed 不作锚点（写点恒带 outcome——防御）");
  }
});

// acceptance（final-arch step-4 Task 3）：release_ready 待人工验收——enabled 才
// 投影；候选集在场且 acceptance 记录缺失/摘要失准 → 条目（锚点与 release 同一
// 入阶段逻辑），匹配后消失；无候选不投影；release 类条件不变（两 kind 可并存）。
const releaseReadyFixture = (deliveryOver = {}, events = []) => ({
  item: item({
    phase: "release_ready",
    updatedAt: d(9),
    delivery: {
      protocolVersion: 1,
      mode: "manual",
      candidates: [{ repositoryId: "r1", commit: "abc" }],
      ...deliveryOver,
    },
  }),
  events,
});

test("acceptance：enabled ∧ release_ready ∧ 无记录 → 条目（since 与 release 同锚点，detail 待人工验收）", () => {
  {
    const entries = projection({
      items: [releaseReadyFixture({}, [event("delivery.checks_passed", d(3), { outcome: "verified" })])],
      acceptanceEnabled: true,
    });
    const kinds = entries.map((entry) => entry.kind);
    assert.ok(kinds.includes("acceptance"), "acceptance 条目在场");
    assert.ok(kinds.includes("release"), "release 类条件不变——两 kind 并存");
    const acceptance = entries.find((entry) => entry.kind === "acceptance");
    assert.equal(acceptance.since, d(3), "锚点复用 release 的入阶段事件逻辑");
    assert.equal(acceptance.detail, "待人工验收");
  }
  {
    const entries = projection({
      items: [releaseReadyFixture()],
      acceptanceEnabled: true,
    });
    const acceptance = entries.find((entry) => entry.kind === "acceptance");
    assert.equal(acceptance.since, d(9), "零锚点事件 → 回落 updatedAt（与 release 同）");
  }
});

test("acceptance：记录摘要与当前候选匹配 → 消失；候选换过（摘要失准）→ 重现", () => {
  const candidates = [{ repositoryId: "r1", commit: "abc" }];
  {
    const entries = projection({
      items: [releaseReadyFixture({
        acceptance: { notes: "验", candidateDigest: candidatesDigest(candidates), at: d(1) },
      })],
      acceptanceEnabled: true,
    });
    assert.equal(
      entries.filter((entry) => entry.kind === "acceptance").length, 0,
      "匹配的验收记录 → acceptance 消失（release 条目仍在）",
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "release");
  }
  {
    const entries = projection({
      items: [releaseReadyFixture({
        acceptance: { notes: "验", candidateDigest: "f".repeat(64), at: d(1) },
      })],
      acceptanceEnabled: true,
    });
    assert.equal(
      entries.filter((entry) => entry.kind === "acceptance").length, 1,
      "摘要失准 → acceptance 重现",
    );
  }
});

test("acceptance：enabled=false / 缺省 → 永不投影；无候选 → 不投影", () => {
  for (const acceptanceEnabled of [false, undefined]) {
    const entries = projection({
      items: [releaseReadyFixture()],
      ...(acceptanceEnabled === undefined ? {} : { acceptanceEnabled }),
    });
    assert.equal(
      entries.filter((entry) => entry.kind === "acceptance").length, 0,
      `acceptanceEnabled=${String(acceptanceEnabled)} → 零 acceptance 条目`,
    );
  }
  const noCandidates = releaseReadyFixture();
  delete noCandidates.item.delivery.candidates;
  const entries = projection({ items: [noCandidates], acceptanceEnabled: true });
  assert.equal(entries.filter((entry) => entry.kind === "acceptance").length, 0);
});

test("blocked：status blocked → since = delivery.block 最新者，detail = block 原因", () => {
  const entries = projection({
    items: [{
      item: item({ status: "blocked", updatedAt: d(9) }),
      events: [
        event("delivery.block", d(6), { phase: "design", reason: "上游接口未定" }),
        event("delivery.block", d(7), { phase: "design", reason: "更早的原因" }),
      ],
    }],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "blocked");
  assert.equal(entries[0].since, d(6), "block 两个取最新");
  assert.equal(entries[0].detail, "上游接口未定");
});

test("blocked：system 检查步 delivery.checks_unverified → since = 事件 at，detail = 未过检查名（缺名回落固定文案）", () => {
  {
    const entries = projection({
      items: [{
        item: item({ status: "blocked", updatedAt: d(9) }),
        events: [
          event("delivery.checks_unverified", d(2), { checks: [{ name: "lint" }, { name: "typecheck" }] }),
        ],
      }],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "blocked");
    assert.equal(entries[0].since, d(2), "since = checks_unverified 的 at（非 updatedAt）");
    assert.equal(entries[0].detail, "lint、typecheck");
  }
  {
    const entries = projection({
      items: [{
        item: item({ status: "blocked", updatedAt: d(9) }),
        events: [event("delivery.checks_unverified", d(2), {})],
      }],
    });
    assert.equal(entries[0].since, d(2));
    assert.equal(entries[0].detail, "环境未就绪待修复", "事件缺检查名 → 固定文案");
  }
});

test("blocked：paused 集 → since = delivery.automation_paused，detail = 暂停提示", () => {
  const entries = projection({
    items: [{
      item: item({ updatedAt: d(9) }),
      events: [event("delivery.automation_paused", d(5), { count: 3, maxAttemptsPerInput: 3 })],
    }],
    paused: new Set(["REQ-0001"]),
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "blocked");
  assert.equal(entries[0].since, d(5));
  assert.equal(entries[0].detail, "自动化已暂停待恢复");
});

test("blocked：interrupted 集 → since = delivery.exec_interrupted，detail = 执行中断待恢复", () => {
  const entries = projection({
    items: [{
      item: item({ updatedAt: d(9) }),
      events: [event("delivery.exec_interrupted", d(5), { reason: "execution timeout", attemptId: "att-1" })],
    }],
    interrupted: new Set(["REQ-0001"]),
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "blocked");
  assert.equal(entries[0].since, d(5));
  assert.equal(entries[0].detail, "执行中断待恢复");
});

// final-arch step-4（spec §5.3 第四步）：integrate 集成段失败与 checks_unverified
// 同走 blocked 类——detail 取事件（首败仓），参与同一「最新者胜出」候选列表。
test("blocked：integrate 段失败 delivery.integrate_failed → since = 事件 at，detail = 集成失败（首败仓）；缺仓回落固定文案", () => {
  {
    const entries = projection({
      items: [{
        item: item({ status: "blocked", updatedAt: d(9) }),
        events: [event("delivery.integrate_failed", d(1), { repositoryId: "pi-web", exitCode: 1 })],
      }],
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "blocked");
    assert.equal(entries[0].since, d(1), "since = integrate_failed 的 at（非 updatedAt）");
    assert.equal(entries[0].detail, "集成失败（pi-web）");
  }
  {
    const entries = projection({
      items: [{
        item: item({ status: "blocked", updatedAt: d(9) }),
        events: [event("delivery.integrate_failed", d(1), {})],
      }],
    });
    assert.equal(entries[0].since, d(1));
    assert.equal(entries[0].detail, "集成失败", "事件缺 repositoryId → 固定文案");
  }
});

test("blocked：integrate_failed 与更早的 delivery.block 并存 → integrate_failed 最新者胜出（latest-wins 不破）", () => {
  const entries = projection({
    items: [{
      item: item({ status: "blocked", updatedAt: d(9) }),
      events: [
        event("delivery.block", d(5), { phase: "design", reason: "上游接口未定" }),
        event("delivery.integrate_failed", d(2), { repositoryId: "pi-web" }),
      ],
    }],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "blocked");
  assert.equal(entries[0].since, d(2), "更新的 integrate_failed 胜出");
  assert.equal(entries[0].detail, "集成失败（pi-web）", "detail 跟随胜出信号");
});

test("blocked：四信号并存 → since 取最新事件、detail 随胜出信号；零事件回落 updatedAt", () => {
  {
    const entries = projection({
      items: [{
        item: item({ status: "blocked", updatedAt: d(9) }),
        events: [
          event("delivery.block", d(5), { phase: "design", reason: "上游接口未定" }),
          event("delivery.automation_paused", d(6), { count: 3 }),
        ],
      }],
      paused: new Set(["REQ-0001"]),
      interrupted: new Set(["REQ-0001"]),
    });
    assert.equal(entries[0].since, d(5), "最新事件胜出");
    assert.equal(entries[0].detail, "上游接口未定", "detail 跟随胜出信号");
  }
  {
    const entries = projection({
      items: [{ item: item({ updatedAt: d(9) }), events: [] }],
      paused: new Set(["REQ-0001"]),
    });
    assert.equal(entries[0].since, d(9), "无事件 → updatedAt");
    assert.equal(entries[0].detail, "自动化已暂停待恢复");
  }
});

test("ageDays = floor((now - since)/86400000)：整 N 天 → N，差 1ms → N-1", () => {
  {
    const entries = projection({
      items: [{ item: item({ phase: "design", updatedAt: d(3) }), events: [] }],
    });
    assert.equal(entries[0].ageDays, 3, "恰好 3 天 → floor 3");
  }
  {
    const entries = projection({
      items: [{ item: item({ phase: "design", updatedAt: new Date(NOW - 3 * DAY_MS + 1).toISOString() }), events: [] }],
    });
    assert.equal(entries[0].ageDays, 2, "差 1ms 不足 3 天 → floor 2");
  }
});

test("nudged/parked：晚于 since 的同 kind 事件才算（kind 不符 / 恰等于 since / 早于 since 都不算）", () => {
  /** question 条目基准：澄清 askedAt = d(4) 即 since。 */
  const question = (events) =>
    projection({
      items: [{
        item: item({
          delivery: {
            protocolVersion: 1,
            mode: "manual",
            clarifications: [{ id: "cl-1", role: "designer", question: "Q?", askedAt: d(4), attemptId: "att-1" }],
          },
        }),
        events,
      }],
    })[0];
  assert.equal(question([event("delivery.nudged", d(1), { kind: "question" })]).nudged, true);
  assert.equal(question([event("delivery.nudged", d(1), { kind: "confirm" })]).nudged, false, "kind 不符不算");
  assert.equal(question([event("delivery.nudged", d(4), { kind: "question" })]).nudged, false, "恰等于 since → 严格 > 才算");
  assert.equal(question([event("delivery.nudged", d(6), { kind: "question" })]).nudged, false, "早于 since 的旧 nudge 不算");
  assert.equal(question([event("delivery.parked", d(1), { kind: "question" })]).parked, true);
  const both = question([
    event("delivery.nudged", d(1), { kind: "question" }),
    event("delivery.parked", d(1), { kind: "question" }),
  ]);
  assert.equal(both.nudged, true);
  assert.equal(both.parked, true);
});

test("排序：P0→P3→key，未知优先级垫底", () => {
  const entries = projection({
    items: [
      { item: item({ key: "REQ-0003", priority: "P3", phase: "design", updatedAt: d(1) }), events: [] },
      { item: item({ key: "REQ-0002", priority: "P1", phase: "design", updatedAt: d(1) }), events: [] },
      { item: item({ key: "REQ-0001", priority: "P0", phase: "design", updatedAt: d(1) }), events: [] },
      { item: item({ key: "REQ-0004", priority: "P2", phase: "design", updatedAt: d(1) }), events: [] },
      { item: item({ key: "REQ-0005", priority: "P9", phase: "design", updatedAt: d(1) }), events: [] },
      { item: item({ key: "REQ-0000", priority: "P0", phase: "design", updatedAt: d(1) }), events: [] },
    ],
  });
  assert.deepEqual(entries.map((entry) => entry.key), [
    "REQ-0000", "REQ-0001", "REQ-0002", "REQ-0004", "REQ-0003", "REQ-0005",
  ]);
});

test("archived / cancelled / released 阶段 / 非 managed → 零条目", () => {
  const entries = projection({
    items: [
      { item: item({ archivedAt: d(1), phase: "design" }), events: [] },
      { item: item({ status: "cancelled", phase: "design" }), events: [] },
      { item: item({ phase: "released" }), events: [event("delivery.record-release", d(1), { phase: "released", version: "1.0.0" })] },
      { item: item({ delivery: undefined }), events: [] },
    ],
    paused: new Set(["REQ-0001"]),
    interrupted: new Set(["REQ-0001"]),
  });
  assert.equal(entries.length, 0);
});

test("一项多 kind（blocked + question）→ 两条；同 kind 永不多条（两个未答仍一条 question）", () => {
  const entries = projection({
    items: [{
      item: item({
        status: "blocked",
        updatedAt: d(9),
        delivery: {
          protocolVersion: 1,
          mode: "manual",
          clarifications: [
            { id: "cl-1", role: "designer", question: "Q1", askedAt: d(4), attemptId: "att-1" },
            { id: "cl-2", role: "designer", question: "Q2", askedAt: d(3), attemptId: "att-2" },
          ],
        },
      }),
      events: [event("delivery.block", d(6), { phase: "design", reason: "上游接口未定" })],
    }],
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.kind).sort(),
    ["blocked", "question"],
    "每 kind 至多一条",
  );
  const question = entries.find((entry) => entry.kind === "question");
  assert.equal(question.since, d(4), "question 仍取最早未答");
});

// ---------------------------------------------------- read side (real temp workspace)

/** 最小 item.yaml（claim.test.mjs 同款手法）；withDelivery = managed 块 + 未答澄清。
 *  deliveryYaml = 自带 delivery 子块行（acceptance 端到端：release_ready + 候选）。 */
const itemYaml = ({ key, title, phase = "intake", withDelivery = false, deliveryYaml = null }) =>
  [
    "schema_version: 1",
    `id: ${key}-id`,
    `key: ${key}`,
    "type: requirement",
    "revision: 1",
    `title: ${JSON.stringify(title)}`,
    "status: open",
    `phase: ${phase}`,
    "priority: P1",
    "repositories: []",
    "tags: []",
    "conversations: []",
    "related_items: []",
    "designs: []",
    "plans: []",
    "archived_at: null",
    'created_at: "2026-10-20T00:00:00.000Z"',
    'updated_at: "2026-10-20T00:00:00.000Z"',
    ...(withDelivery
      ? (deliveryYaml ?? [
          "delivery:",
          "  protocolVersion: 1",
          "  mode: manual",
          "  clarifications:",
          "    - id: cl-1",
          "      role: designer",
          '      question: "第一批目标用户是谁？"',
          '      askedAt: "2026-10-23T00:00:00.000Z"',
          "      attemptId: att-1",
        ])
      : []),
    "",
  ].join("\n");

/** 最小 managed 项目录（item.yaml + README + 空 events.jsonl）。 */
async function writeItem(root, { key, slug, title, phase, withDelivery = false, writeReadme = true, deliveryYaml = null }) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, title, phase, withDelivery, deliveryYaml }), "utf8");
  if (writeReadme) await writeFile(join(dir, "README.md"), "body\n", "utf8");
  await writeFile(join(dir, "events.jsonl"), "", "utf8");
  return dir;
}

test("collectAttention：临时工作区端到端——未答澄清 + automation-paused → question 与 blocked 两条", async (t) => {
  const ws = await mkdtemp(join(tmpdir(), "pi-attention-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const itemPath = await writeItem(ws, {
    key: "REQ-0001",
    slug: "alpha",
    title: "Alpha",
    withDelivery: true,
  });

  // 事件 + 暂停标记走既有写点（appendEvent 只进 events.jsonl；writePaused 是
  // 失败预算暂停的同一文件——泊车复用它）。
  await appendEvent(itemPath, event("delivery.automation_paused", d(5), { count: 3, maxAttemptsPerInput: 3 }));
  writePaused(itemPath, { at: d(5), reason: "consecutive failures (3 since last resume)", count: 3 });
  assert.ok(readPaused(itemPath));
  assert.equal((await listPendingInterruptions(itemPath)).length, 0);

  const entries = await collectAttention(ws, new Date(NOW));
  assert.equal(entries.length, 2);
  const byKind = Object.fromEntries(entries.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.question.since, "2026-10-23T00:00:00.000Z", "question since = 澄清 askedAt");
  assert.equal(byKind.question.clarificationId, "cl-1");
  assert.equal(byKind.question.detail, "第一批目标用户是谁？");
  assert.equal(byKind.blocked.since, d(5), "blocked since = automation_paused 事件");
  assert.equal(byKind.blocked.detail, "自动化已暂停待恢复");
});

test("collectAttention：非 managed 项跳过；managed 但详情读失败（README 缺失）→ 跳过不抛", async (t) => {
  const ws = await mkdtemp(join(tmpdir(), "pi-attention-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // 非 managed：无 delivery 块 → 不进投影输入。
  await writeItem(ws, { key: "REQ-0002", slug: "plain", title: "Plain" });
  // managed 但 README 缺失 → listWorkItems（只读 item.yaml）仍在场，而
  // readWorkItem 抛——attention 的 nudge/park 幂等全靠事件推导，读不出事件
  // 的项跳过（与池子「缺项不静默消失」不同：这里缺事件会破坏幂等）。
  await writeItem(ws, { key: "REQ-0003", slug: "noreadme", title: "NoReadme", withDelivery: true, writeReadme: false });

  const entries = await collectAttention(ws, new Date(NOW));
  assert.deepEqual(entries, []);
});

// ------------------------------------------ digest 渲染（final-arch step-5 Task 2）
//
// renderAttentionDigest —— 纯函数第二只：AttentionEntry[] → 业务语言 markdown
//（patrol 模板 kit/templates/patrol/SKILL.md 的轮内拉取口 ?format=digest）。
//   空队列 → 「今日无待处理」；分组定序 question→confirm→acceptance→release→blocked，
//   各配业务话标题；行 = `- <KEY> <标题> — <detail>（已 N 天[，已催办][，已泊车]）`；
//   输出零内部术语（attempt/claim/digest/designer/… 永不出现——grep 守卫钉死）。

const { renderAttentionDigest } = await import("./attention.ts");

/** 字面量条目工厂（纯函数零 fs，字面量输入——对照上面的 projection 手法）。 */
const digestEntry = (over = {}) => ({
  key: "REQ-0001",
  title: "Alpha",
  kind: "question",
  since: d(4),
  ageDays: 4,
  nudged: false,
  parked: false,
  detail: "第一个？",
  ...over,
});

// 本地时区构造日期（digest 的日期 = date 的本地 Y-M-D——避免测试机时区漂移）。
const DIGEST_DATE = new Date(2026, 9, 26, 20, 0, 0);

test("renderAttentionDigest：空队列 → 标题 + 今日无待处理", () => {
  assert.equal(renderAttentionDigest([], DIGEST_DATE), "# 待处理清单 · 2026-10-26\n\n今日无待处理。");
});

test("renderAttentionDigest：分组定序 question/confirm/acceptance/release/blocked + 业务话标题，空 kind 不出节", () => {
  const markdown = renderAttentionDigest(
    [
      digestEntry({ key: "REQ-0003", kind: "blocked", title: "Gamma", detail: "上游接口未定", ageDays: 6 }),
      digestEntry({ key: "REQ-0001", kind: "release", title: "Alpha", detail: "待登记发布", ageDays: 2 }),
      digestEntry({ key: "REQ-0002", kind: "question", title: "Beta", detail: "第一个？", ageDays: 4 }),
      digestEntry({ key: "REQ-0004", kind: "acceptance", title: "Delta", detail: "待人工验收", ageDays: 1 }),
      digestEntry({ key: "REQ-0005", kind: "confirm", title: "Epsilon", detail: "设计待确认", ageDays: 3 }),
    ],
    DIGEST_DATE,
  );
  // 标题行与条目行按出现顺序 == 分组定序（question → confirm → acceptance → release → blocked）。
  const lines = markdown.split("\n").filter((line) => line.startsWith("#") || line.startsWith("- "));
  assert.deepEqual(lines, [
    "# 待处理清单 · 2026-10-26",
    "## 待您解答",
    "- REQ-0002 Beta — 第一个？（已 4 天）",
    "## 待确认设计",
    "- REQ-0005 Epsilon — 设计待确认（已 3 天）",
    "## 待人工验收",
    "- REQ-0004 Delta — 待人工验收（已 1 天）",
    "## 可登记发布",
    "- REQ-0001 Alpha — 待登记发布（已 2 天）",
    "## 受阻待处理",
    "- REQ-0003 Gamma — 上游接口未定（已 6 天）",
  ]);
});

test("renderAttentionDigest：行格式标记——已催办 / 已泊车 / 两者（0 天也带「已 N 天）", () => {
  const line = (over) =>
    renderAttentionDigest([digestEntry(over)], DIGEST_DATE)
      .split("\n")
      .find((row) => row.startsWith("- "));
  assert.equal(line({ nudged: true }), "- REQ-0001 Alpha — 第一个？（已 4 天，已催办）");
  assert.equal(line({ parked: true }), "- REQ-0001 Alpha — 第一个？（已 4 天，已泊车）");
  assert.equal(
    line({ nudged: true, parked: true, ageDays: 0 }),
    "- REQ-0001 Alpha — 第一个？（已 0 天，已催办，已泊车）",
  );
});

test("renderAttentionDigest：零内部术语（attempt/claim/digest/角色名/verification/candidate 永不出现）", () => {
  const markdown = renderAttentionDigest(
    [
      digestEntry(),
      digestEntry({ key: "REQ-0002", kind: "confirm", detail: "设计待确认" }),
      digestEntry({ key: "REQ-0003", kind: "acceptance", detail: "待人工验收" }),
      digestEntry({ key: "REQ-0004", kind: "release", detail: "待登记发布" }),
      digestEntry({ key: "REQ-0005", kind: "blocked", detail: "自动化已暂停待恢复" }),
      digestEntry({ key: "REQ-0006", kind: "blocked", detail: "执行中断待恢复" }),
      digestEntry({ key: "REQ-0007", kind: "blocked", detail: "集成失败（pi-web）" }),
      digestEntry({ key: "REQ-0008", kind: "blocked", detail: "lint、typecheck" }),
    ],
    DIGEST_DATE,
  );
  assert.doesNotMatch(
    markdown,
    /attempt|claim|digest|designer|developer|reviewer|release-preparer|verification|candidate/,
  );
});

// final-arch step-4 Task 3：acceptanceEnabled 的读取端装配——collectAttention 读
// workspace config（.pi/delivery.yaml 的 stages.acceptance.enabled）传入纯投影；
// 缺配置 = 关（上面两个既有 e2e 的工作区就没有 delivery.yaml，同钉此路径）。
test("collectAttention：stages.acceptance.enabled 开 → release_ready 项投影 acceptance；关 → 消失", async (t) => {
  const ws = await mkdtemp(join(tmpdir(), "pi-attention-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const itemPath = await writeItem(ws, {
    key: "REQ-0009",
    slug: "accept",
    title: "Accept",
    phase: "release_ready",
    withDelivery: true,
    deliveryYaml: [
      "delivery:",
      "  protocolVersion: 1",
      "  mode: manual",
      "  candidates:",
      "    - repositoryId: r1",
      "      commit: abc123",
    ],
  });
  await appendEvent(itemPath, event("delivery.checks_passed", d(3), { outcome: "verified" }));

  // 开关未写（缺配置）→ 不投影 acceptance。
  const before = await collectAttention(ws, new Date(NOW));
  assert.deepEqual(
    before.filter((entry) => entry.kind === "acceptance"),
    [],
    "缺配置 = 关",
  );

  // 开启 → acceptance 条目（since = checks_passed 锚点）。
  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({ schemaVersion: 2, stages: { acceptance: { enabled: true } } }),
  );
  const enabled = await collectAttention(ws, new Date(NOW));
  const acceptance = enabled.find((entry) => entry.kind === "acceptance");
  assert.ok(acceptance, "enabled → acceptance 条目在场");
  assert.equal(acceptance.key, "REQ-0009");
  assert.equal(acceptance.since, d(3));
  assert.equal(acceptance.detail, "待人工验收");

  // 显式关闭 → 消失。
  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({ schemaVersion: 2, stages: { acceptance: { enabled: false } } }),
  );
  const disabled = await collectAttention(ws, new Date(NOW));
  assert.deepEqual(
    disabled.filter((entry) => entry.kind === "acceptance"),
    [],
    "enabled=false → 不投影",
  );
});
