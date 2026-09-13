import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanWorkspaceRepositories } from "./scan.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-ws-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", "-q"], { cwd: dir });
}

test("scan：git 仓 / OKF 知识库 / 递归子目录，剪枝点目录与 node_modules/.worktrees", (t) => {
  const root = fixture(t);
  // code 仓（.git 目录形态）
  gitInit(join(root, "cargoware-haichuang"));
  // OKF 知识库（index.md + log.md，即使也是 git 仓也判 knowledge）
  mkdirSync(join(root, "cxin-knowledge"), { recursive: true });
  writeFileSync(join(root, "cxin-knowledge", "index.md"), "# i");
  writeFileSync(join(root, "cxin-knowledge", "log.md"), "# l");
  // 无 git 无 OKF 的普通目录 → 递归下钻，里面的仓也算
  mkdirSync(join(root, "docs", "nested-repo"), { recursive: true });
  gitInit(join(root, "docs", "nested-repo"));
  // worktree（.git 是文件）不算独立仓
  mkdirSync(join(root, "wt"), { recursive: true });
  writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/x");
  // 剪枝目标
  gitInit(join(root, "node_modules", "some-pkg"));
  gitInit(join(root, ".worktrees", "subagent-x"));
  gitInit(join(root, ".pi", "loops"));
  // 空目录不产出
  mkdirSync(join(root, "outputs"), { recursive: true });

  const result = scanWorkspaceRepositories(root);
  assert.deepEqual(result, [
    { path: "cargoware-haichuang", alias: "cargoware-haichuang", kind: "code" },
    { path: "cxin-knowledge", alias: "cxin-knowledge", kind: "knowledge" },
    { path: "docs/nested-repo", alias: "nested-repo", kind: "code" },
  ]);
});

test("scan：深度上限 4 层，仓内不再下钻", (t) => {
  const root = fixture(t);
  // 5 层深 → 超出上限不产出
  const deep = join(root, "l1", "l2", "l3", "l4", "l5-repo");
  gitInit(deep);
  // 4 层内 → 产出
  const ok = join(root, "l1", "l2", "l3", "l4-repo");
  gitInit(ok);
  // 仓内嵌套仓不登记（发现即停）
  gitInit(join(root, "outer"));
  gitInit(join(root, "outer", "inner"));

  const result = scanWorkspaceRepositories(root);
  assert.deepEqual(result, [
    { path: "l1/l2/l3/l4-repo", alias: "l4-repo", kind: "code" },
    { path: "outer", alias: "outer", kind: "code" },
  ]);
});
