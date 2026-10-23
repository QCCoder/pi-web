import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addWorkItemAttachments,
  createWorkItem,
  listWorkItems,
  readWorkItem,
  recordWorkItemMilestone,
  trashWorkItem,
  updateWorkItem,
  updateWorkItemContent,
  WorkItemConflictError,
  WorkItemNotFoundError,
  WorkItemValidationError,
} from "./service.ts";
import {
  addWorkspaceRepository,
  createWorkspace,
  readWorkspaceManifest,
} from "../workspaces/service.ts";

// M2 Task 4（导入去重）起 createWorkItem 返回 { detail, importOutcome }——
// 既有用例只关心 detail；导入去重行为（outcome 分支/并发/不覆盖）见下方
// "import dedup" 组用例。
const createItemDetail = async (workspaceId, input) =>
  (await createWorkItem(workspaceId, input)).detail;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-work-items-"));
  const previous = process.env.PI_WORKSPACES_DIR;
  const previousIndex = process.env.PI_WORKSPACE_INDEX_FILE;
  process.env.PI_WORKSPACES_DIR = root;
  process.env.PI_WORKSPACE_INDEX_FILE = join(root, ".pi", "workspace.yaml");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WORKSPACES_DIR;
    else process.env.PI_WORKSPACES_DIR = previous;
    if (previousIndex === undefined) delete process.env.PI_WORKSPACE_INDEX_FILE;
    else process.env.PI_WORKSPACE_INDEX_FILE = previousIndex;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createWorkspace({
    name: "Work",
    slug: "work",
    capabilities: ["work-items", "repositories"],
  }, root);
  return { root, workspace };
}

test("creates file-backed Work Items and reserves readable keys", async (t) => {
  const { workspace } = await fixture(t);
  const first = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Blank login",
    originalDescription: "The page is blank after login.",
    priority: "P1",
  });
  const second = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Another bug",
    originalDescription: "Another description.",
  });
  const requirement = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Add workspace selector",
    originalDescription: "I need to switch Workspaces.",
  });

  assert.equal(first.item.key, "BUG-0001");
  assert.equal(first.item.archivedAt, null);
  assert.match(first.path, /bugs[/\\]BUG-0001-Blank-login$/);
  assert.equal(second.item.key, "BUG-0002");
  assert.equal(requirement.item.key, "REQ-0001");
  assert.match(first.content, /## Original Description\s+The page is blank after login\./);
  assert.equal(first.events[0].type, "work_item.created");
  const manifest = await readWorkspaceManifest(workspace.path);
  assert.equal(manifest.workItems.nextBugNumber, 3);
  assert.equal(manifest.workItems.nextRequirementNumber, 2);
});

test("structured updates are revision-safe and append milestone events", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Blank login",
    originalDescription: "The page is blank.",
  });
  const updated = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: 1,
    status: "in_progress",
    phase: "analysis",
    priority: "P1",
    actor: "agent",
    conversationId: "conv-1",
  });

  assert.equal(updated.item.revision, 2);
  assert.equal(updated.item.status, "in_progress");
  assert.equal(updated.events.at(-1).type, "work_item.updated");
  assert.equal(updated.events.at(-1).conversationId, "conv-1");

  await assert.rejects(
    updateWorkItem(workspace.id, created.item.key, {
      expectedRevision: 1,
      status: "done",
    }),
    WorkItemConflictError,
  );
});

test("archives independently from status and can restore the item", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Keep original status",
    originalDescription: "Archive without completing.",
  });
  const archived = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: created.item.revision,
    archived: true,
  });
  assert.equal(archived.item.status, "open");
  assert.equal(typeof archived.item.archivedAt, "string");

  const restored = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: archived.item.revision,
    archived: false,
  });
  assert.equal(restored.item.status, "open");
  assert.equal(restored.item.archivedAt, null);
});

test("reads legacy key-only Work Item directories", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Descriptive folder",
    originalDescription: "Keep legacy folders readable.",
  });
  const legacyPath = join(workspace.path, ".pi", "work-items", "requirements", created.item.key);
  await rename(created.path, legacyPath);

  const reread = await readWorkItem(workspace.path, created.item.key);
  assert.equal(reread.path, legacyPath);
  assert.equal(reread.item.title, "Descriptive folder");
});

test("Work Items reference repositories by stable id", async (t) => {
  const { workspace } = await fixture(t);
  const repository = await addWorkspaceRepository(workspace.id, {
    alias: "web",
    kind: "code",
    mode: "init",
  });
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Repository ids",
    originalDescription: "Keep repository references stable.",
    repositories: [repository.id],
  });
  assert.deepEqual(created.item.repositories, [repository.id]);
  await assert.rejects(
    createWorkItem(workspace.id, {
      type: "bug",
      title: "Invalid repository",
      originalDescription: "Reject aliases.",
      repositories: ["web"],
    }),
    WorkItemValidationError,
  );
});

test("content edits preserve the Original Description", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Workspace selector",
    originalDescription: "Let me switch Workspaces.",
  });
  const editedContent = `${created.content}\n## Notes\n\nAdd a mobile selector.\n`;
  const edited = await updateWorkItemContent(workspace.id, created.item.key, {
    expectedRevision: 1,
    content: editedContent,
  });
  assert.equal(edited.item.revision, 2);
  assert.match(edited.content, /Add a mobile selector/);

  await assert.rejects(
    updateWorkItemContent(workspace.id, created.item.key, {
      expectedRevision: 2,
      content: edited.content.replace("Let me switch Workspaces.", "Changed original."),
    }),
    WorkItemValidationError,
  );
});

test("milestones do not change structured revision", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Blank login",
    originalDescription: "The page is blank.",
  });
  const result = await recordWorkItemMilestone(workspace.id, created.item.key, {
    type: "tests.passed",
    actor: "agent",
    data: { command: "npm test" },
  });
  assert.equal(result.item.revision, 1);
  assert.equal(result.events.at(-1).type, "tests.passed");
});

test("a milestone stamped with a conversationId links the session (no revision bump)", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Loop-picked item",
    originalDescription: "Picked by a kit loop round.",
  });
  const conversationId = "019f0a0b-1111-7000-8000-000000000001";
  // The loop-round path: only a milestone is recorded (no structured update),
  // yet the round session must become reachable from the work item detail.
  const linked = await recordWorkItemMilestone(workspace.id, created.item.key, {
    type: "loop.parked",
    actor: "agent",
    conversationId,
    data: { summary: "选品泊车" },
  });
  assert.equal(linked.item.revision, 1); // metadata-only merge
  assert.deepEqual(linked.item.conversations, [conversationId]);
  // round-trips through item.yaml on disk
  const reread = await readWorkItem(workspace.path, created.item.key);
  assert.deepEqual(reread.item.conversations, [conversationId]);
  // idempotent: re-linking the same session does not duplicate
  const again = await recordWorkItemMilestone(workspace.id, created.item.key, {
    type: "loop.gate",
    actor: "agent",
    conversationId,
    data: { summary: "待裁决" },
  });
  assert.deepEqual(again.item.conversations, [conversationId]);
  // updateWorkItem auto-merges conversationId too, and survives a concurrent
  // caller that does NOT pass conversations (no stale-list clobber)
  const otherId = "019f0a0b-2222-7000-8000-000000000002";
  const updated = await updateWorkItem(workspace.id, created.item.key, {
    status: "in_progress",
    conversationId: otherId,
    expectedRevision: again.item.revision,
  });
  assert.deepEqual(updated.item.conversations, [conversationId, otherId]);
});

test("list surfaces invalid externally edited Work Items", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Valid",
    originalDescription: "Valid item.",
  });
  const brokenPath = join(workspace.path, ".pi", "work-items", "bugs", "BUG-9999");
  await mkdir(brokenPath, { recursive: true });
  await writeFile(join(brokenPath, "item.yaml"), "broken: true\n");
  await writeFile(join(brokenPath, "README.md"), "# Broken\n");
  await writeFile(join(brokenPath, "events.jsonl"), "");
  await appendFile(join(created.path, "events.jsonl"), "");

  const result = await listWorkItems(workspace.path);
  assert.equal(result.items.length, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].key, "BUG-9999");
  assert.match(result.invalid[0].error, /Unsupported Work Item schema/);

  const reread = await readWorkItem(workspace.path, created.item.key);
  assert.equal((await readFile(join(created.path, "item.yaml"), "utf8")).includes("revision: 1"), true);
  assert.equal(reread.item.title, "Valid");
});

test("external source ref is stamped at creation and round-trips", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Imported bug",
    originalDescription: "From Chandao.",
    external: {
      source: "chandao",
      sourceId: "50",
      url: "https://chandao/bug-view-50.html",
      lastSyncedAt: "2025-01-01T00:00:00.000Z",
    },
    actor: "external",
  });
  assert.deepEqual(created.item.external, {
    source: "chandao",
    sourceId: "50",
    url: "https://chandao/bug-view-50.html",
    lastSyncedAt: "2025-01-01T00:00:00.000Z",
  });
  // round-trips through disk
  const reread = await readWorkItem(workspace.path, created.item.key);
  assert.deepEqual(reread.item.external, {
    source: "chandao",
    sourceId: "50",
    url: "https://chandao/bug-view-50.html",
    lastSyncedAt: "2025-01-01T00:00:00.000Z",
  });
  // listed items carry external (used by external-source script dedup)
  const list = await listWorkItems(workspace.path);
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.items[0].external, created.item.external);
  // the serialized yaml uses the snake_case external block
  const yaml = await readFile(join(created.path, "item.yaml"), "utf8");
  assert.match(yaml, /external:/);
  assert.match(yaml, /source_id: "?50"?/);
  assert.match(yaml, /last_synced_at:/);
});

test("import dedup: same source+sourceId returns the existing item unmodified", async (t) => {
  const { workspace } = await fixture(t);
  const input = {
    type: "bug",
    title: "Imported bug",
    originalDescription: "From Chandao.",
    external: {
      source: "chandao",
      sourceId: "50",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
    },
    actor: "external",
  };
  const first = await createWorkItem(workspace.id, input);
  assert.equal(first.importOutcome, "created");
  // 同源重复导入：返回既有项（outcome=existing），字段原样、revision 不动。
  const again = await createWorkItem(workspace.id, {
    ...input,
    title: "改了标题也不覆盖",
    priority: "P0",
  });
  assert.equal(again.importOutcome, "existing");
  assert.equal(again.detail.item.key, first.detail.item.key);
  assert.equal(again.detail.item.title, first.detail.item.title);
  assert.equal(again.detail.item.revision, first.detail.item.revision);
  assert.equal(again.detail.events.length, first.detail.events.length);
  // 未消耗 key 计数（去重命中不预留新号）
  const manifest = await readWorkspaceManifest(workspace.path);
  assert.equal(manifest.workItems.nextBugNumber, 2);
  // 归档不解除去重：archivedAt 置位后同源导入仍命中 existing。
  await updateWorkItem(workspace.id, first.detail.item.key, {
    expectedRevision: first.detail.item.revision,
    archived: true,
  });
  const archivedHit = await createWorkItem(workspace.id, input);
  assert.equal(archivedHit.importOutcome, "existing");
  assert.equal(archivedHit.detail.item.key, first.detail.item.key);
});

test("import dedup: trashed item.yaml is the dedup tombstone", async (t) => {
  const { workspace } = await fixture(t);
  const input = {
    type: "requirement",
    title: "To be trashed",
    originalDescription: "Dedup must survive the trash.",
    external: { source: "chandao", sourceId: "77", lastSyncedAt: "t" },
    actor: "external",
  };
  const created = await createWorkItem(workspace.id, input);
  await trashWorkItem(workspace.id, created.detail.item.key);
  const hit = await createWorkItem(workspace.id, input);
  assert.equal(hit.importOutcome, "existing_trashed");
  assert.equal(hit.detail.item.key, created.detail.item.key);
  // 详情从回收站目录读出（path 在 .pi/trash 下），字段原样。
  assert.match(hit.detail.path, /[.]pi[/\\]trash[/\\]work-items/);
  assert.equal(hit.detail.item.revision, created.detail.item.revision);
  // 活动清单里没有新副本——磁盘上只有一个（已入回收站的）项
  const list = await listWorkItems(workspace.path);
  assert.equal(list.items.length, 0);
});

test("import dedup: concurrent same-source imports create exactly one item", async (t) => {
  const { workspace } = await fixture(t);
  const input = {
    type: "bug",
    title: "Race",
    originalDescription: "Two in-flight creates, one item on disk.",
    external: { source: "chandao", sourceId: "race-1", lastSyncedAt: "t" },
    actor: "external",
  };
  const [a, b] = await Promise.all([
    createWorkItem(workspace.id, input),
    createWorkItem(workspace.id, input),
  ]);
  const outcomes = [a.importOutcome, b.importOutcome].sort();
  assert.deepEqual(outcomes, ["created", "existing"]);
  assert.equal(a.detail.item.key, b.detail.item.key);
  const list = await listWorkItems(workspace.path);
  assert.equal(list.items.length, 1);
});

test("work item loop binding round-trips through item.yaml", async (t) => {
  const { workspace } = await fixture(t);
  const detail = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "绑定 loop 的工作项",
    originalDescription: "desc",
    loop: "dev-loop",
  });
  assert.equal(detail.item.loop, "dev-loop");
  const raw = await readFile(join(detail.path, "item.yaml"), "utf8");
  assert.match(raw, /^loop: dev-loop$/m);
  const reread = await readWorkItem(workspace.path, detail.item.key);
  assert.equal(reread.item.loop, "dev-loop");
});

test("work item without loop omits the field from item.yaml", async (t) => {
  const { workspace } = await fixture(t);
  const detail = await createItemDetail(workspace.id, {
    type: "bug", title: "无绑定", originalDescription: "desc",
  });
  assert.equal(detail.item.loop, undefined);
  const raw = await readFile(join(detail.path, "item.yaml"), "utf8");
  assert.doesNotMatch(raw, /^loop:/m);
});

test("updateWorkItem sets and clears the loop binding", async (t) => {
  const { workspace } = await fixture(t);
  const detail = await createItemDetail(workspace.id, {
    type: "requirement", title: "t", originalDescription: "d",
  });
  const rev1 = detail.item.revision;
  const set = await updateWorkItem(workspace.id, detail.item.key, {
    expectedRevision: rev1, loop: "triage-loop",
  });
  assert.equal(set.item.loop, "triage-loop");
  assert.equal(set.item.revision, rev1 + 1);
  const cleared = await updateWorkItem(workspace.id, set.item.key, {
    expectedRevision: set.item.revision, loop: null,
  });
  assert.equal(cleared.item.loop, undefined);
  const raw = await readFile(join(cleared.path, "item.yaml"), "utf8");
  assert.doesNotMatch(raw, /^loop:/m);
});

test("binding to an unknown loop name is accepted (soft validation)", async (t) => {
  const { workspace } = await fixture(t);
  const detail = await createItemDetail(workspace.id, {
    type: "requirement", title: "t", originalDescription: "d", loop: "does-not-exist",
  });
  assert.equal(detail.item.loop, "does-not-exist"); // 不报错——软校验（S1）
});

test("addWorkItemAttachments writes files, links README, records event", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Blank login",
    originalDescription: "See the attachment.",
  });
  const detail = await addWorkItemAttachments(workspace.id, created.item.key, {
    files: [
      { name: "error.png", bytes: Buffer.from("png-bytes") },
      { name: "logs/repro.txt", bytes: Buffer.from("steps") },
      { name: "截图.png", bytes: Buffer.from("cjk") },
    ],
  });
  // 路径分隔符剥离；文件按安全名落盘
  assert.equal(await readFile(join(detail.path, "attachments", "error.png"), "utf8"), "png-bytes");
  assert.equal(await readFile(join(detail.path, "attachments", "repro.txt"), "utf8"), "steps");
  assert.equal(await readFile(join(detail.path, "attachments", "截图.png"), "utf8"), "cjk");
  // README 维护「## 附件」小节：图片用 ![]()，其余用链接，中文名 URL 编码
  assert.match(detail.content, /^## 附件$/m);
  assert.match(detail.content, /!\[error\.png\]\(attachments\/error\.png\)/);
  assert.match(detail.content, /\[repro\.txt\]\(attachments\/repro\.txt\)/);
  assert.match(detail.content, /!\[截图\.png\]\(attachments\/%E6%88%AA%E5%9B%BE\.png\)/);
  // 与 create 相同的修订推进（README 变更）
  assert.equal(detail.item.revision, created.item.revision + 1);
  const added = detail.events.find((event) => event.type === "work_item.attachment_added");
  assert.deepEqual(added?.data?.files, ["error.png", "repro.txt", "截图.png"]);

  // 第二次上传：磁盘重名自动 -1 后缀，README 小节内追加不重复
  const again = await addWorkItemAttachments(workspace.id, created.item.key, {
    files: [{ name: "error.png", bytes: Buffer.from("second") }],
  });
  assert.equal(await readFile(join(again.path, "attachments", "error-1.png"), "utf8"), "second");
  assert.equal(again.content.match(/!\[error\.png\]\(attachments\/error\.png\)/g)?.length, 1);
  assert.match(again.content, /!\[error-1\.png\]\(attachments\/error-1\.png\)/);
  assert.equal(again.content.match(/^## 附件$/gm)?.length, 1);
});

test("addWorkItemAttachments validates input and unknown keys", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "bug", title: "t", originalDescription: "d",
  });
  await assert.rejects(
    addWorkItemAttachments(workspace.id, created.item.key, { files: [] }),
    WorkItemValidationError,
  );
  await assert.rejects(
    addWorkItemAttachments(workspace.id, created.item.key, {
      files: [{ name: "no-bytes.png" }],
    }),
    WorkItemValidationError,
  );
  await assert.rejects(
    addWorkItemAttachments(workspace.id, "BUG-9999", {
      files: [{ name: "a.txt", bytes: Buffer.from("x") }],
    }),
    WorkItemNotFoundError,
  );
});

test("enableDelivery seeds a manual v1 block; default items stay delivery-free", async (t) => {
  const { workspace } = await fixture(t);
  const plain = await createItemDetail(workspace.id, {
    type: "bug",
    title: "Plain item",
    originalDescription: "Old items must parse exactly as before.",
  });
  assert.equal("delivery" in plain.item, false);
  assert.doesNotMatch(await readFile(join(plain.path, "item.yaml"), "utf8"), /delivery/);

  const withDelivery = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Delivery flow",
    originalDescription: "Standard delivery.",
    enableDelivery: true,
  });
  assert.equal(withDelivery.item.phase, "intake");
  assert.deepEqual(withDelivery.item.delivery, { protocolVersion: 1, mode: "manual" });
  assert.match(await readFile(join(withDelivery.path, "item.yaml"), "utf8"), /protocolVersion: 1/);
  const reread = await readWorkItem(workspace.path, withDelivery.item.key);
  assert.deepEqual(reread.item.delivery, { protocolVersion: 1, mode: "manual" });
});

test("item.yaml delivery blocks round-trip and new phases validate", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Full block",
    originalDescription: "Nested delivery records survive a read.",
    enableDelivery: true,
  });
  await writeFile(join(created.path, "item.yaml"), `schema_version: 1
id: ${created.item.id}
key: ${created.item.key}
revision: 1
type: requirement
title: Full block
status: open
phase: ready_for_implementation
priority: P2
repositories: []
tags: []
conversations: []
related_items: []
designs: []
plans: []
delivery:
  protocolVersion: 1
  mode: manual
  designConfirmed:
    at: "2026-10-23T00:00:00.000Z"
    actor: user
    requirementDigest: rd
    designDigest: dd
  candidates:
    - repositoryId: r2
      commit: c2
    - repositoryId: r1
      commit: c1
archived_at: null
created_at: "2026-10-23T00:00:00.000Z"
updated_at: "2026-10-23T00:00:00.000Z"
`, "utf8");

  const detail = await readWorkItem(workspace.path, created.item.key);
  assert.equal(detail.item.phase, "ready_for_implementation");
  assert.deepEqual(detail.item.delivery, {
    protocolVersion: 1,
    mode: "manual",
    designConfirmed: {
      at: "2026-10-23T00:00:00.000Z",
      actor: "user",
      requirementDigest: "rd",
      designDigest: "dd",
    },
    candidates: [
      { repositoryId: "r2", commit: "c2" },
      { repositoryId: "r1", commit: "c1" },
    ],
  });

  // M2 交付流程（Task 2）：managed 项的 phase/status 只能走流程动作——
  // generic PATCH 带 phase 即 400（spec §7.2）。展示性 PATCH 保持 delivery 块完整。
  await assert.rejects(
    updateWorkItem(workspace.id, created.item.key, { expectedRevision: 1, phase: "released" }),
    WorkItemValidationError,
  );
  const tagged = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: 1,
    tags: ["delivery"],
  });
  assert.equal(tagged.item.phase, "ready_for_implementation");
  assert.equal(tagged.item.delivery.candidates.length, 2);
  // 新 phase 值仍在 unmanaged 项上经 generic PATCH 验证（parseWorkItem 层校验不变）。
  const plain = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Plain phases",
    originalDescription: "No delivery block on this one.",
  });
  const released = await updateWorkItem(workspace.id, plain.item.key, {
    expectedRevision: 1,
    phase: "released",
  });
  assert.equal(released.item.phase, "released");
});

test("invalid delivery blocks fail validation with clear errors", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Corrupt delivery",
    originalDescription: "Bad protocol and non-user actors are rejected.",
    enableDelivery: true,
  });
  const base = `schema_version: 1
id: ${created.item.id}
key: ${created.item.key}
revision: 1
type: requirement
title: Corrupt delivery
status: open
phase: intake
priority: P2
repositories: []
tags: []
conversations: []
related_items: []
designs: []
plans: []
archived_at: null
created_at: "2026-10-23T00:00:00.000Z"
updated_at: "2026-10-23T00:00:00.000Z"
`;
  const writeDelivery = (block) =>
    writeFile(join(created.path, "item.yaml"), `${base}${block}\n`, "utf8");

  await writeDelivery("delivery:\n  protocolVersion: 2\n  mode: manual");
  await assert.rejects(readWorkItem(workspace.path, created.item.key), /Unknown delivery protocolVersion: 2/);

  await writeDelivery("delivery:\n  protocolVersion: 1\n  mode: auto");
  await assert.rejects(readWorkItem(workspace.path, created.item.key), /mode/);

  await writeDelivery("delivery:\n  protocolVersion: 1\n  mode: manual\n  designConfirmed:\n    at: t\n    actor: agent\n    requirementDigest: rd\n    designDigest: dd");
  await assert.rejects(
    readWorkItem(workspace.path, created.item.key),
    /delivery\.designConfirmed\.actor must be "user"/,
  );
});
