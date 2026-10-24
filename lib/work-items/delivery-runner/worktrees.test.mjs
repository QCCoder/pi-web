// Phase-3 Task 2: worktrees.ts——预建与候选核验。
// 真仓用例（mkdtemp + git init + 一次 commit 拿真 sha）驱动默认实现：
//   1. prepareWorktrees happy：RoleWorktree 四字段、真 worktree 落盘、
//      分支 pi-delivery/<KEY>/gen<N>（worktree 实际检出该分支）
//   2. 幂等：同 generation 二次调用复用同 path（不抛 Directory already exists）
//   3. 多仓：结果顺序跟随 item.repositories（不是 manifest 登记序）
//   4. 未登记 / removed id → WorkItemValidationError "repository not registered"
//   5. addWorktree 失败 → 整体抛（带 repositoryId 与原因），已建的不回滚
//   6. verifyCandidateCommits：真 sha 过；假 sha → Validation 带
//      repositoryId+commit+repo；未知 id → Validation；非 git 目录 → Validation
//      带路径与原因；注入 run 的纯分支（不 spawn git）；空候选 no-op
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WorkItemValidationError } from "../errors.ts";

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
      "repositories:",
      ...(repositories.length > 0
        ? repositories.map(repoYaml)
        : []),
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

/** 真 git 仓：init + user config + 一个文件一次 commit；返回 HEAD sha。 */
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

/** 标准测试工作区：manifest（含登记仓）+ 若干真 git 仓。 */
async function makeWorkspace(t, { repoIds = ["repo-a"] } = {}) {
  const ws = await mkdtemp(join(tmpdir(), "pi-worktrees-"));
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repos = [];
  for (const id of repoIds) {
    const path = id;
    await initGitRepo(join(ws, path));
    repos.push({ id, path });
  }
  await writeManifest(ws, repos);
  return { ws, repos };
}

// --------------------------------------------------- prepareWorktrees: real

test("prepareWorktrees happy path: RoleWorktree fields, real worktree on disk, checked-out branch matches", async (t) => {
  const { prepareWorktrees } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t);

  const [worktree] = await prepareWorktrees(
    ws, { key: "REQ-0001", repositories: ["repo-a"] }, 1,
  );
  assert.equal(worktree.repositoryId, "repo-a");
  assert.equal(worktree.repoPath, join(ws, "repo-a"));
  assert.equal(worktree.branch, "pi-delivery/REQ-0001/gen1");
  assert.ok(existsSync(worktree.path), "worktree path exists on disk");
  // addWorktree 目录名 = 分支的 sanitize 形态（/ → -）。
  assert.equal(basename(worktree.path), "pi-delivery-REQ-0001-gen1");
  // worktree 真实检出该分支。
  assert.equal(await git(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"]), worktree.branch);
});

test("prepareWorktrees is idempotent: same generation re-preparation reuses the same path", async (t) => {
  const { prepareWorktrees } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t);

  const first = await prepareWorktrees(ws, { key: "REQ-0001", repositories: ["repo-a"] }, 2);
  const second = await prepareWorktrees(ws, { key: "REQ-0001", repositories: ["repo-a"] }, 2);
  assert.deepEqual(second, first, "second call returns the identical RoleWorktree (no throw, no new worktree)");
  assert.equal(second[0].branch, "pi-delivery/REQ-0001/gen2");
});

test("prepareWorktrees multi-repo: result order follows item.repositories, each repo gets its own worktree", async (t) => {
  const { prepareWorktrees } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t, { repoIds: ["repo-a", "repo-b"] });

  const results = await prepareWorktrees(
    ws, { key: "REQ-0002", repositories: ["repo-b", "repo-a"] }, 1,
  );
  assert.deepEqual(results.map((entry) => entry.repositoryId), ["repo-b", "repo-a"]);
  assert.notEqual(results[0].path, results[1].path);
  assert.ok(results[0].path.includes(`${join(ws, "repo-b")}-worktrees`), "repo-b worktree under its own -worktrees dir");
  assert.ok(results[1].path.includes(`${join(ws, "repo-a")}-worktrees`), "repo-a worktree under its own -worktrees dir");
  for (const entry of results) {
    assert.ok(existsSync(entry.path), `${entry.repositoryId} worktree exists`);
  }
});

// ------------------------------------------- prepareWorktrees: registration

test("prepareWorktrees rejects unknown repository id before creating anything", async (t) => {
  const { prepareWorktrees } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t);

  await assert.rejects(
    prepareWorktrees(ws, { key: "REQ-0001", repositories: ["nope"] }, 1),
    (error) => error instanceof WorkItemValidationError && /repository not registered: nope/.test(error.message),
  );
});

test("prepareWorktrees rejects removed repositories (second gate after the pool predicate)", async (t) => {
  const { prepareWorktrees } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t);
  await writeManifest(ws, [
    { id: "repo-a", path: "repo-a" },
    { id: "repo-gone", path: "repo-gone", status: "removed" },
  ]);

  await assert.rejects(
    prepareWorktrees(ws, { key: "REQ-0001", repositories: ["repo-gone"] }, 1),
    (error) => error instanceof WorkItemValidationError && /repository not registered: repo-gone/.test(error.message),
  );
});

// ---------------------------------------------- prepareWorktrees: failure

test("prepareWorktrees: addWorktree failure rejects the whole call, earlier worktrees are NOT rolled back", async (t) => {
  const { prepareWorktrees } = await import("./worktrees.ts");
  const { addWorktree: realAddWorktree } = await import("../../worktree.ts");
  const { ws } = await makeWorkspace(t, { repoIds: ["repo-a", "repo-b"] });

  const calls = [];
  const deps = {
    addWorktree: async (cwd, branch) => {
      calls.push(cwd);
      if (cwd === join(ws, "repo-b")) throw new Error("git worktree add failed: no space left");
      return realAddWorktree(cwd, branch);
    },
  };
  await assert.rejects(
    prepareWorktrees(ws, { key: "REQ-0001", repositories: ["repo-a", "repo-b"] }, 1, deps),
    (error) => error instanceof WorkItemValidationError
      && error.message.includes("repo-b")
      && error.message.includes("no space left"),
  );
  assert.deepEqual(calls, [join(ws, "repo-a"), join(ws, "repo-b")], "both repos attempted in order");
  // 不回滚：repo-a 的 worktree 仍在盘上（调用方 claim 事务在状态落盘前调用，
  // 失败即零状态；孤儿 worktree 无害——下代重领新分支）。
  const worktrees = await import("../../worktree.ts");
  const kept = await worktrees.listWorktrees(join(ws, "repo-a"));
  assert.ok(
    kept.some((entry) => entry.branch === "pi-delivery/REQ-0001/gen1"),
    "repo-a worktree survives the failure of repo-b (no rollback)",
  );
});

// ------------------------------------------- verifyCandidateCommits: real git

test("verifyCandidateCommits accepts a real commit sha and is a no-op for empty candidates", async (t) => {
  const { verifyCandidateCommits } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t);
  const sha = await git(join(ws, "repo-a"), ["rev-parse", "HEAD"]);

  verifyCandidateCommits(
    new Map([["repo-a", join(ws, "repo-a")]]),
    [{ repositoryId: "repo-a", commit: sha }],
  );
  verifyCandidateCommits(new Map(), []);
});

test("verifyCandidateCommits rejects a fake sha with repositoryId + commit + repo path in the message", async (t) => {
  const { verifyCandidateCommits } = await import("./worktrees.ts");
  const { ws } = await makeWorkspace(t);
  const fake = "0".repeat(40);

  assert.throws(
    () => verifyCandidateCommits(
      new Map([["repo-a", join(ws, "repo-a")]]),
      [{ repositoryId: "repo-a", commit: fake }],
    ),
    (error) => error instanceof WorkItemValidationError
      && error.message.includes("repo-a")
      && error.message.includes(fake)
      && error.message.includes(join(ws, "repo-a")),
  );
});

test("verifyCandidateCommits rejects a repositoryId missing from repoPaths", async () => {
  const { verifyCandidateCommits } = await import("./worktrees.ts");
  assert.throws(
    () => verifyCandidateCommits(
      new Map([["repo-a", "/somewhere/repo-a"]]),
      [{ repositoryId: "repo-unknown", commit: "abc123" }],
    ),
    (error) => error instanceof WorkItemValidationError
      && error.message.includes("repo-unknown")
      && error.message.includes("abc123"),
  );
});

test("verifyCandidateCommits on a non-git directory: Validation carrying the repo path and git's reason", async (t) => {
  const { verifyCandidateCommits } = await import("./worktrees.ts");
  const dir = await mkdtemp(join(tmpdir(), "pi-notgit-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  assert.throws(
    () => verifyCandidateCommits(
      new Map([["repo-a", dir]]),
      [{ repositoryId: "repo-a", commit: "abc123" }],
    ),
    (error) => error instanceof WorkItemValidationError
      && error.message.includes(dir)
      && /not a git repository/i.test(error.message),
  );
});

// ------------------------------------------- verifyCandidateCommits: injected

test("verifyCandidateCommits uses the injected run instead of git (pure branch)", async () => {
  const { verifyCandidateCommits } = await import("./worktrees.ts");
  const seen = [];
  const run = (args) => {
    seen.push(args);
    return { ok: true };
  };
  const repoPaths = new Map([["repo-a", "/repo/a"]]);

  verifyCandidateCommits(repoPaths, [{ repositoryId: "repo-a", commit: "abc123" }], { run });
  assert.deepEqual(seen, [{ repo: "/repo/a", commit: "abc123" }]);

  // run.ok=false → Validation，stderr 原文进消息。
  assert.throws(
    () => verifyCandidateCommits(
      repoPaths, [{ repositoryId: "repo-a", commit: "abc123" }],
      { run: () => ({ ok: false, stderr: "boom-reason" }) },
    ),
    (error) => error instanceof WorkItemValidationError && error.message.includes("boom-reason"),
  );
});
