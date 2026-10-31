import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 手机端工作项分组投影（knowledge/designs/mobile-work-items-design.md）：
//  1. 活动范围按动静分五组，attention 命中优先且一项只落一组，空组不输出；
//  2. 已结束组（done + cancelled）缺省折叠，其余组展开；
//  3. 组内保持传入排序（P0→P3 → updatedAt 倒序由调用方 sortWorkItems 负责）；
//  4. primaryAttentionByKey 按展示定序（question > confirm > release > blocked）
//     取主条目并计 extra；
//  5. phaseTrackIndex 七阶段自映射，老流程设计前子阶段投影进 design 列。

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  groupActiveWorkItems,
  primaryAttentionByKey,
  phaseTrackIndex,
  PHASE_TRACK_LENGTH,
} = await jiti.import("./mobile-groups.ts");

const item = (key, overrides = {}) => ({
  schemaVersion: 1,
  id: key,
  key,
  revision: 1,
  type: key.startsWith("BUG") ? "bug" : "requirement",
  title: `标题 ${key}`,
  status: "open",
  phase: "intake",
  priority: "P2",
  repositories: [],
  tags: [],
  conversations: [],
  relatedItems: [],
  designs: [],
  plans: [],
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  ...overrides,
});

const entry = (key, kind, overrides = {}) => ({
  key,
  title: `标题 ${key}`,
  kind,
  since: "2026-10-20T00:00:00.000Z",
  ageDays: 2,
  nudged: false,
  parked: false,
  detail: kind === "question" ? "要不要支持导出？" : "设计待确认",
  ...overrides,
});

test("groupActiveWorkItems: five motion groups in fixed order, empties dropped", () => {
  const items = [
    item("REQ-0001", { status: "in_progress" }),
    item("REQ-0002", { status: "open" }),
    item("BUG-0003", { status: "blocked" }),
    item("REQ-0004", { status: "done" }),
    item("REQ-0005", { status: "cancelled" }),
  ];
  const groups = groupActiveWorkItems(items, new Set());
  assert.deepEqual(groups.map((group) => group.id), ["in_progress", "open", "blocked", "finished"]);
  assert.deepEqual(groups.map((group) => group.label), ["进行中", "待处理", "已阻塞", "已结束"]);
  assert.deepEqual(groups.find((group) => group.id === "finished").items.map((it) => it.key), ["REQ-0004", "REQ-0005"]);
});

test("groupActiveWorkItems: attention wins and an item lands in exactly one group", () => {
  const items = [
    item("REQ-0001", { status: "in_progress" }),
    item("BUG-0002", { status: "blocked" }),
    item("REQ-0003", { status: "open" }),
  ];
  const groups = groupActiveWorkItems(items, new Set(["REQ-0001", "BUG-0002"]));
  assert.deepEqual(groups.map((group) => group.id), ["attention", "open"]);
  assert.deepEqual(groups[0].items.map((it) => it.key), ["REQ-0001", "BUG-0002"]);
  const everyKey = groups.flatMap((group) => group.items.map((it) => it.key));
  assert.equal(new Set(everyKey).size, everyKey.length);
});

test("groupActiveWorkItems: only the finished group is collapsed by default", () => {
  const items = [item("REQ-0001", { status: "open" }), item("REQ-0002", { status: "done" })];
  const groups = groupActiveWorkItems(items, new Set());
  assert.deepEqual(groups.map((group) => [group.id, group.collapsedByDefault]), [["open", false], ["finished", true]]);
});

test("groupActiveWorkItems: keeps caller order inside each group", () => {
  const items = [
    item("REQ-0009", { status: "open", priority: "P0" }),
    item("REQ-0001", { status: "open", priority: "P2" }),
    item("REQ-0005", { status: "open", priority: "P3" }),
  ];
  const [open] = groupActiveWorkItems(items, new Set());
  assert.deepEqual(open.items.map((it) => it.key), ["REQ-0009", "REQ-0001", "REQ-0005"]);
});

test("groupActiveWorkItems: empty input yields no groups", () => {
  assert.deepEqual(groupActiveWorkItems([], new Set()), []);
});

test("primaryAttentionByKey: display order question > confirm > release > blocked, extra counted", () => {
  // API 同项多 kind 按字典序输出（blocked 在 question 前）——投影须按展示定序重排。
  const entries = [
    entry("REQ-0001", "blocked", { detail: "等待环境" }),
    entry("REQ-0001", "question"),
    entry("REQ-0002", "release", { detail: "待登记发布" }),
    entry("REQ-0003", "confirm"),
    entry("REQ-0003", "blocked", { detail: "自动化已暂停待恢复" }),
  ];
  const primary = primaryAttentionByKey(entries);
  assert.equal(primary.get("REQ-0001").entry.kind, "question");
  assert.equal(primary.get("REQ-0001").extra, 1);
  assert.equal(primary.get("REQ-0002").entry.kind, "release");
  assert.equal(primary.get("REQ-0002").extra, 0);
  assert.equal(primary.get("REQ-0003").entry.kind, "confirm");
  assert.equal(primary.get("REQ-0003").extra, 1);
  assert.equal(primary.size, 3);
});

test("phaseTrackIndex: seven standard phases map to 0..6; legacy pre-design sub-phases project into design", () => {
  assert.equal(PHASE_TRACK_LENGTH, 7);
  const standard = ["intake", "design", "ready_for_implementation", "implementation", "verification", "release_ready", "released"];
  assert.deepEqual(standard.map(phaseTrackIndex), [0, 1, 2, 3, 4, 5, 6]);
  for (const legacy of ["analysis", "requirement_approval", "plan_approval"]) {
    assert.equal(phaseTrackIndex(legacy), 1, legacy);
  }
  assert.equal(phaseTrackIndex("complete"), 6);
});
