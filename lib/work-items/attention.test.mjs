// final-arch step-2 Task 5: attention 队列（attention.ts）。
// 纯投影 projectAttention —— 零 fs、字面量输入（对照 pool.test.mjs 风格）：
//   kind 判定与 since 锚点（question = 最早未答 askedAt；confirm = 最近
//   delivery.start-design 否则 updatedAt；release = 最近入 release_ready 事件
//   [delivery.record-verification 全 passed / delivery.submitted outcome=verified]
//   否则 updatedAt；blocked = delivery.block / delivery.automation_paused /
//   delivery.exec_interrupted 最新者否则 updatedAt）；ageDays = floor；
//   nudged/parked 由「晚于 since 的同 kind 事件」推导（旧事件不算）；
//   排序 P0→P3→key；archived/cancelled/released/非 managed 零条目；
//   一项多 kind（blocked + question）各一条、同 kind 永不多条。
// 读取端 collectAttention —— mkdtemp 真临时工作区：managed 项经 store 写入
//   （item.yaml 澄清 + appendEvent 事件 + writePaused 暂停标记）后端到端投影。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvent } from "./service.ts";
import { listPendingInterruptions, readPaused, writePaused } from "./delivery-runner/attempts.ts";

const { projectAttention, collectAttention } = await import("./attention.ts");

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

const projection = ({ items, paused = new Set(), interrupted = new Set(), now = new Date(NOW) }) =>
  projectAttention({ items, paused, interrupted, now });

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

test("blocked：三信号并存 → since 取最新事件、detail 随胜出信号；零事件回落 updatedAt", () => {
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

/** 最小 item.yaml（claim.test.mjs 同款手法）；withDelivery = managed 块 + 未答澄清。 */
const itemYaml = ({ key, title, phase = "intake", withDelivery = false }) =>
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
      ? [
          "delivery:",
          "  protocolVersion: 1",
          "  mode: manual",
          "  clarifications:",
          "    - id: cl-1",
          "      role: designer",
          '      question: "第一批目标用户是谁？"',
          '      askedAt: "2026-10-23T00:00:00.000Z"',
          "      attemptId: att-1",
        ]
      : []),
    "",
  ].join("\n");

/** 最小 managed 项目录（item.yaml + README + 空 events.jsonl）。 */
async function writeItem(root, { key, slug, title, phase, withDelivery = false, writeReadme = true }) {
  const dir = join(root, ".pi", "work-items", "requirements", `${key}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.yaml"), itemYaml({ key, title, phase, withDelivery }), "utf8");
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
