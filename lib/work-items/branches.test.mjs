import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkItem, readWorkItem, updateWorkItem, WorkItemValidationError } from "./service.ts";
import { addWorkspaceRepository, createWorkspace } from "../workspaces/service.ts";

// 分支登记（WorkItemBranchRef）：持久化字段 + released 冻结 + 仓库范围收窄剪枝。
// 合并状态是实时派生（branch-status.ts + /git 端点），这里只测落盘面。

const createItemDetail = async (workspaceId, input) =>
  (await createWorkItem(workspaceId, input)).detail;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-work-item-branches-"));
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
  return { workspace };
}

test("branch registry round-trips through item.yaml (snake_case on disk)", async (t) => {
  const { workspace } = await fixture(t);
  const repository = await addWorkspaceRepository(workspace.id, {
    alias: "web", kind: "code", mode: "init",
  });
  const created = await createItemDetail(workspace.id, {
    type: "requirement",
    title: "Branch registry",
    originalDescription: "desc",
    repositories: [repository.id],
    branches: [{ repositoryId: repository.id, branch: "feature/20261026/branch-registry" }],
  });
  assert.deepEqual(created.item.branches, [
    { repositoryId: repository.id, branch: "feature/20261026/branch-registry" },
  ]);
  const raw = await readFile(join(created.path, "item.yaml"), "utf8");
  assert.match(raw, /^branches:$/m);
  assert.match(raw, /repository_id:/);
  const reread = await readWorkItem(workspace.path, created.item.key);
  assert.deepEqual(reread.item.branches, created.item.branches);

  // 未登记分支的项：字段缺省、yaml 无键（旧数据照常解析）
  const plain = await createItemDetail(workspace.id, {
    type: "bug", title: "No branches", originalDescription: "desc",
  });
  assert.equal(plain.item.branches, undefined);
  assert.doesNotMatch(await readFile(join(plain.path, "item.yaml"), "utf8"), /^branches:/m);
});

test("branches validate against the item's repository scope", async (t) => {
  const { workspace } = await fixture(t);
  const repository = await addWorkspaceRepository(workspace.id, {
    alias: "web", kind: "code", mode: "init",
  });
  const created = await createItemDetail(workspace.id, {
    type: "requirement", title: "Scope", originalDescription: "desc",
    repositories: [repository.id],
  });
  // 创建：repositoryId 不在项的 repositories 里
  await assert.rejects(
    createWorkItem(workspace.id, {
      type: "bug", title: "Bad scope", originalDescription: "desc",
      repositories: [repository.id],
      branches: [{ repositoryId: "other-repo", branch: "x" }],
    }),
    WorkItemValidationError,
  );
  // 更新：越界 + 同仓库重复条目
  await assert.rejects(
    updateWorkItem(workspace.id, created.item.key, {
      expectedRevision: created.item.revision,
      branches: [{ repositoryId: "other-repo", branch: "x" }],
    }),
    WorkItemValidationError,
  );
  await assert.rejects(
    updateWorkItem(workspace.id, created.item.key, {
      expectedRevision: created.item.revision,
      branches: [
        { repositoryId: repository.id, branch: "a" },
        { repositoryId: repository.id, branch: "b" },
      ],
    }),
    /Duplicate/,
  );
});

test("updateWorkItem sets, replaces and clears branches with revision bumps and audit", async (t) => {
  const { workspace } = await fixture(t);
  const repository = await addWorkspaceRepository(workspace.id, {
    alias: "web", kind: "code", mode: "init",
  });
  const created = await createItemDetail(workspace.id, {
    type: "requirement", title: "Lifecycle", originalDescription: "desc",
    repositories: [repository.id],
  });

  const set = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: created.item.revision,
    branches: [{ repositoryId: repository.id, branch: "feature/a" }],
  });
  assert.equal(set.item.revision, created.item.revision + 1);
  const setEvent = set.events.at(-1);
  assert.equal(setEvent.type, "work_item.updated");
  // 事件经 JSONL 落盘：undefined 的 from 键被 JSON 丢弃
  assert.deepEqual(setEvent.data.changes.branches, {
    to: [{ repositoryId: repository.id, branch: "feature/a" }],
  });

  const replace = await updateWorkItem(workspace.id, set.item.key, {
    expectedRevision: set.item.revision,
    branches: [{ repositoryId: repository.id, branch: "feature/b" }],
  });
  assert.equal(replace.item.revision, set.item.revision + 1);
  assert.deepEqual(replace.item.branches, [{ repositoryId: repository.id, branch: "feature/b" }]);
  assert.deepEqual(replace.events.at(-1).data.changes.branches, {
    from: [{ repositoryId: repository.id, branch: "feature/a" }],
    to: [{ repositoryId: repository.id, branch: "feature/b" }],
  });

  // 空数组清除：字段摘除、yaml 无键
  const cleared = await updateWorkItem(workspace.id, replace.item.key, {
    expectedRevision: replace.item.revision,
    branches: [],
  });
  assert.equal(cleared.item.branches, undefined);
  assert.equal(cleared.item.revision, replace.item.revision + 1);
  assert.doesNotMatch(await readFile(join(cleared.path, "item.yaml"), "utf8"), /^branches:/m);

  // 对本就为空的登记再传空数组：无变化短路，revision 不动
  const noop = await updateWorkItem(workspace.id, cleared.item.key, {
    expectedRevision: cleared.item.revision,
    branches: [],
  });
  assert.equal(noop.item.revision, cleared.item.revision);
});

test("released baseline freezes the branch registry", async (t) => {
  const { workspace } = await fixture(t);
  const repository = await addWorkspaceRepository(workspace.id, {
    alias: "web", kind: "code", mode: "init",
  });
  const created = await createItemDetail(workspace.id, {
    type: "requirement", title: "Freeze", originalDescription: "desc",
    repositories: [repository.id],
  });
  const released = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: created.item.revision,
    phase: "released",
  });
  await assert.rejects(
    updateWorkItem(workspace.id, created.item.key, {
      expectedRevision: released.item.revision,
      branches: [{ repositoryId: repository.id, branch: "feature/late" }],
    }),
    /frozen/,
  );
  assert.equal((await readWorkItem(workspace.path, created.item.key)).item.branches, undefined);
});

test("narrowing repositories prunes out-of-scope branch entries", async (t) => {
  const { workspace } = await fixture(t);
  const web = await addWorkspaceRepository(workspace.id, { alias: "web", kind: "code", mode: "init" });
  const api = await addWorkspaceRepository(workspace.id, { alias: "api", kind: "code", mode: "init" });
  const created = await createItemDetail(workspace.id, {
    type: "requirement", title: "Narrow", originalDescription: "desc",
    repositories: [web.id, api.id],
    branches: [
      { repositoryId: web.id, branch: "feature/web" },
      { repositoryId: api.id, branch: "feature/api" },
    ],
  });
  const narrowed = await updateWorkItem(workspace.id, created.item.key, {
    expectedRevision: created.item.revision,
    repositories: [web.id],
  });
  assert.deepEqual(narrowed.item.repositories, [web.id]);
  assert.deepEqual(narrowed.item.branches, [{ repositoryId: web.id, branch: "feature/web" }]);
});
