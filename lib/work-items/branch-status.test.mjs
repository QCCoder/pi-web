import assert from "node:assert/strict";
import test from "node:test";
import { deliveryBranchesForKey, parseLocalBranches, resolveMergeTargets } from "./branch-status.ts";

// 纯函数单测（git 执行面不在此覆盖）：分支列表解析、合并目标选择、
// 交付流分支识别与 gen 排序。

test("parseLocalBranches trims lines and drops empties", () => {
  assert.deepEqual(
    parseLocalBranches("main\ndevelop\n  feature/x  \n\n"),
    ["main", "develop", "feature/x"],
  );
  assert.deepEqual(parseLocalBranches(""), []);
});

test("resolveMergeTargets prefers develop/master and only falls back to main when both are missing", () => {
  assert.deepEqual(resolveMergeTargets(["develop", "master", "main"]), ["develop", "master"]);
  assert.deepEqual(resolveMergeTargets(["develop"]), ["develop"]);
  assert.deepEqual(resolveMergeTargets(["master"]), ["master"]);
  assert.deepEqual(resolveMergeTargets(["main"]), ["main"]);
  assert.deepEqual(resolveMergeTargets(["feature/x", "hotfix/y"]), []);
});

test("deliveryBranchesForKey filters by key and sorts by gen ascending", () => {
  const branches = [
    "pi-delivery/REQ-0001/gen10",
    "pi-delivery/REQ-0001/gen2",
    "pi-delivery/REQ-0002/gen1",
    "pi-verify/REQ-0001/gen1",
    "main",
  ];
  assert.deepEqual(deliveryBranchesForKey(branches, "REQ-0001"), [
    "pi-delivery/REQ-0001/gen2",
    "pi-delivery/REQ-0001/gen10",
  ]);
  assert.deepEqual(deliveryBranchesForKey(branches, "REQ-0002"), ["pi-delivery/REQ-0002/gen1"]);
  assert.deepEqual(deliveryBranchesForKey(branches, "REQ-9999"), []);
});

test("deliveryBranchesForKey puts unparseable generations last, stably", () => {
  assert.deepEqual(
    deliveryBranchesForKey(["pi-delivery/REQ-0003/weird", "pi-delivery/REQ-0003/gen1"], "REQ-0003"),
    ["pi-delivery/REQ-0003/gen1", "pi-delivery/REQ-0003/weird"],
  );
});
