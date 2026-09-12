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
  const first = await createWorkItem(workspace.id, {
    type: "bug",
    title: "Blank login",
    originalDescription: "The page is blank after login.",
    priority: "P1",
  });
  const second = await createWorkItem(workspace.id, {
    type: "bug",
    title: "Another bug",
    originalDescription: "Another description.",
  });
  const requirement = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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

test("list surfaces invalid externally edited Work Items", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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

test("work item loop binding round-trips through item.yaml", async (t) => {
  const { workspace } = await fixture(t);
  const detail = await createWorkItem(workspace.id, {
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
  const detail = await createWorkItem(workspace.id, {
    type: "bug", title: "无绑定", originalDescription: "desc",
  });
  assert.equal(detail.item.loop, undefined);
  const raw = await readFile(join(detail.path, "item.yaml"), "utf8");
  assert.doesNotMatch(raw, /^loop:/m);
});

test("updateWorkItem sets and clears the loop binding", async (t) => {
  const { workspace } = await fixture(t);
  const detail = await createWorkItem(workspace.id, {
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
  const detail = await createWorkItem(workspace.id, {
    type: "requirement", title: "t", originalDescription: "d", loop: "does-not-exist",
  });
  assert.equal(detail.item.loop, "does-not-exist"); // 不报错——软校验（S1）
});

test("addWorkItemAttachments writes files, links README, records event", async (t) => {
  const { workspace } = await fixture(t);
  const created = await createWorkItem(workspace.id, {
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
  const created = await createWorkItem(workspace.id, {
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
