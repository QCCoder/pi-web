import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 本用例钉住 WorkItemsPage 顶部 AttentionBar 挂载（顶部条 + onSelectItem +
// refreshToken 接线）。挂载本体位于用户未提交的 WIP（WorkItemsPage.tsx），
// 本文件与之同批落地：在此之前保持 untracked，只在挂载已存在的工作树里运行；
// 自 attention-bar.test.mjs 迁出，保证 HEAD 的干净检出一律可过 node --test。

test("WorkItemsPage mounts AttentionBar at the top with select + refresh wiring", () => {
  const source = readFileSync(new URL("./WorkItemsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\/AttentionBar"/);
  assert.match(source, /<AttentionBar/);
  assert.match(source, /onSelectItem=\{handleSelect\}/);
  // refreshToken = 共享快照的 fetchedAt（5s 轮询换引用 → 待办条同步重取）。
  assert.match(source, /refreshToken=\{snapshot\?\.fetchedAt\}/);
});
