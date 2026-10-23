import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// T9 source/render assertions（brief Step 1）：
//  1. 动作条只渲染 legalDeliveryActions（经 legalActionBarActions 投影）；
//  2. released 项不渲染 cancel（T2 review carried ruling——保留 block）；
//  3. 创建表单 enableDelivery 勾选缺省不勾（spec §7.1）；
//  4. 回收站恢复入口存在（POST restore-from-trash + 「从回收站恢复」）；
//  5. 409 冲突 → 提示重取（刷新列表拿新 revision）。

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { legalDeliveryActions, legalActionBarActions } = await jiti.import("../../lib/work-items/legal-actions.ts");
const { WorkItemActionbar } = await jiti.import("./WorkItemActionbar.tsx");
const { WorkItemCreateForm } = await jiti.import("./WorkItemCreateForm.tsx");

/** Managed (delivery protocolVersion 1) item factory for pure + render tests. */
const managed = (overrides = {}) => ({
  schemaVersion: 1,
  id: "01J0",
  key: "REQ-0001",
  revision: 3,
  type: "requirement",
  title: "示例需求",
  status: "in_progress",
  phase: "intake",
  priority: "P2",
  repositories: [],
  tags: [],
  conversations: [],
  relatedItems: [],
  designs: [],
  plans: [],
  delivery: { protocolVersion: 1, mode: "manual" },
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

test("legalActionBarActions is the legalDeliveryActions projection (same output on ordinary phases)", () => {
  for (const phase of ["intake", "design", "ready_for_implementation", "implementation", "verification", "release_ready"]) {
    const item = managed({ phase });
    assert.deepEqual(legalActionBarActions(item), legalDeliveryActions(item), phase);
  }
});

test("legalActionBarActions: released keeps block/unblock but drops cancel (T2 carried ruling)", () => {
  // released + in_progress → legal = [block, cancel] → bar = [block]
  assert.deepEqual(legalActionBarActions(managed({ phase: "released", status: "in_progress" })), ["block"]);
  // released + blocked → legal = [unblock, cancel] → bar = [unblock]
  assert.deepEqual(legalActionBarActions(managed({ phase: "released", status: "blocked" })), ["unblock"]);
  // 非 released 一律保留 cancel（普通取消入口）
  assert.ok(legalActionBarActions(managed({ phase: "verification" })).includes("cancel"));
});

test("legalActionBarActions: unmanaged and cancelled items expose no actions", () => {
  assert.deepEqual(legalActionBarActions(managed({ delivery: undefined })), []);
  assert.deepEqual(legalActionBarActions(managed({ status: "cancelled" })), []);
});

test("WorkItemActionbar source derives its buttons from the legal-actions module", () => {
  const source = readFileSync(new URL("./WorkItemActionbar.tsx", import.meta.url), "utf8");
  assert.match(source, /from "@\/lib\/work-items\/legal-actions"/);
  assert.match(source, /legalActionBarActions\(item\)/);
});

test("WorkItemActionbar renders no cancel button on a released item (block stays)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemActionbar, {
      workspaceId: "ws",
      item: managed({ phase: "released", status: "in_progress" }),
    }),
  );
  assert.doesNotMatch(html, /data-action="cancel"/);
  assert.match(html, /data-action="block"/);
});

test("WorkItemActionbar renders the legal phase actions plus block/cancel on an intake item", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemActionbar, {
      workspaceId: "ws",
      item: managed({ phase: "intake" }),
    }),
  );
  assert.match(html, /data-action="start-design"/);
  assert.match(html, /data-action="block"/);
  assert.match(html, /data-action="cancel"/);
  // 未启用标准流程 → 一个动作按钮都没有
  const unmanagedHtml = renderToStaticMarkup(
    React.createElement(WorkItemActionbar, {
      workspaceId: "ws",
      item: managed({ delivery: undefined }),
    }),
  );
  assert.doesNotMatch(unmanagedHtml, /data-action=/);
});

test("WorkItemActionbar handles 409 with a refresh hint (revision conflict → 重取)", () => {
  const source = readFileSync(new URL("./WorkItemActionbar.tsx", import.meta.url), "utf8");
  assert.match(source, /status === 409/);
  assert.match(source, /onChanged/);
});

test("WorkItemCreateForm: enableDelivery checkbox defaults to unchecked (spec §7.1)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemCreateForm, {
      repositories: [],
      onCancel: () => {},
      onSubmit: () => {},
    }),
  );
  const checkbox = html.match(/<input[^>]*data-field="enableDelivery"[^>]*>/);
  assert.ok(checkbox, "enableDelivery checkbox rendered");
  assert.doesNotMatch(checkbox[0], /checked/);
  // 源级双保险：初始 state 为 false
  const source = readFileSync(new URL("./WorkItemCreateForm.tsx", import.meta.url), "utf8");
  assert.match(source, /useState\(false\).*enableDelivery|enableDelivery.*useState\(false\)/s);
});

test("restore-from-trash entry exists in the detail view (回收站恢复入口)", () => {
  const source = readFileSync(new URL("./WorkItemDetailView.tsx", import.meta.url), "utf8");
  assert.match(source, /restore-from-trash/);
  assert.match(source, /从回收站恢复/);
});

test("delivery submit posts {expectedRevision, requestId, payload} through the delivery route", () => {
  const source = readFileSync(new URL("./work-item-api.ts", import.meta.url), "utf8");
  assert.match(source, /delivery\/\$\{encodeURIComponent\(action\)\}/);
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /expectedRevision/);
});
