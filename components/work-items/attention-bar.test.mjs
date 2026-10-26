import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// final-arch step-2 Task 6 render/source assertions（brief Step 1）：
//  1. AttentionBarView 视图层：四类分组计数 chips（固定序 待答问题/待确认设计/
//     待登记发布/阻塞）、空队列不渲染、展开行 KEY · 标题 · 已 N 天 · 已催办/已泊车
//     徽标、行点击 → onSelectItem、取数失败降级一行 muted 提示；
//  2. 数据面：GET …/attention 端点、refreshToken 变化重取（复用页面 5s 节拍）、
//     组件不自建 setInterval；
//  3. WorkItemsPage 挂载：顶部条 + onSelectItem + refreshToken 接线。

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { AttentionBarView } = await jiti.import("./AttentionBar.tsx");

const entry = (overrides = {}) => ({
  key: "REQ-0001",
  title: "示例需求",
  kind: "question",
  since: "2026-10-20T00:00:00.000Z",
  ageDays: 3,
  nudged: false,
  parked: false,
  detail: "要不要支持导出 CSV？",
  clarificationId: "01JXCLARIFY0000000000000000",
  ...overrides,
});

// ------------------------------------------------------------- render tests

test("AttentionBarView renders nothing on an empty queue (no error)", () => {
  const html = renderToStaticMarkup(
    React.createElement(AttentionBarView, { entries: [], onSelectItem: () => {} }),
  );
  assert.equal(html, "", "empty queue → null");
});

test("AttentionBarView counts chips per kind in the fixed order", () => {
  const html = renderToStaticMarkup(
    React.createElement(AttentionBarView, {
      entries: [
        entry(),
        entry({ key: "REQ-0002", kind: "confirm", detail: "设计待确认" }),
        entry({ key: "REQ-0003", kind: "confirm", title: "第二项" }),
        entry({ key: "BUG-0001", kind: "release", title: "待发布" }),
        entry({ key: "BUG-0002", kind: "blocked", title: "卡住" }),
      ],
      onSelectItem: () => {},
    }),
  );
  assert.match(html, /待答问题 1/);
  assert.match(html, /待确认设计 2/);
  assert.match(html, /待登记发布 1/);
  assert.match(html, /阻塞 1/);
  // 固定序（= 任务书列举序）：问题 → 确认 → 发布 → 阻塞。
  const order = ["待答问题", "待确认设计", "待登记发布", "阻塞"].map((label) => html.indexOf(label));
  assert.deepEqual([...order].sort((a, b) => a - b), [...order], "chip order fixed");
});

test("AttentionBarView collapsed by default; expanded rows carry KEY · 标题 · 已 N 天 · 徽标", () => {
  const collapsed = renderToStaticMarkup(
    React.createElement(AttentionBarView, {
      entries: [entry({ nudged: true, parked: true, ageDays: 4 })],
      onSelectItem: () => {},
    }),
  );
  assert.doesNotMatch(collapsed, /REQ-0001/, "rows hidden while collapsed");

  const expanded = renderToStaticMarkup(
    React.createElement(AttentionBarView, {
      entries: [entry({ nudged: true, parked: true, ageDays: 4 })],
      initialExpanded: true,
      onSelectItem: () => {},
    }),
  );
  assert.match(expanded, /REQ-0001/, "KEY rendered");
  assert.match(expanded, /示例需求/, "title rendered");
  assert.match(expanded, /已 4 天/, "age rendered");
  assert.match(expanded, /已催办/, "nudged badge");
  assert.match(expanded, /已泊车/, "parked badge");
});

test("AttentionBarView rows wire onSelectItem with the entry key and carry detail as title", () => {
  const html = renderToStaticMarkup(
    React.createElement(AttentionBarView, {
      entries: [entry()],
      initialExpanded: true,
      onSelectItem: () => {},
    }),
  );
  assert.match(html, /title="要不要支持导出 CSV？"/, "question detail surfaced as tooltip");
  const source = readFileSync(new URL("./AttentionBar.tsx", import.meta.url), "utf8");
  assert.match(source, /onSelectItem\(entry\.key\)/, "row click → onSelectItem(entry.key)");
});

test("AttentionBarView renders a muted one-line error without throwing", () => {
  const html = renderToStaticMarkup(
    React.createElement(AttentionBarView, {
      entries: [],
      error: "HTTP 500",
      onSelectItem: () => {},
    }),
  );
  assert.match(html, /HTTP 500/, "error surfaced");
  assert.match(html, /待处理队列加载失败/, "muted prefix");
});

// ------------------------------------------------------- source: data plane

test("AttentionBar fetches GET …/attention and refetches on refreshToken (no second timer)", () => {
  const source = readFileSync(new URL("./AttentionBar.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/attention/);
  // 复用宿主节拍：refreshToken 进依赖数组，组件内没有自建轮询器。
  assert.match(source, /\[workspaceId, refreshToken\]/);
  assert.doesNotMatch(source, /setInterval|setTimeout/, "no self-managed polling timer");
  // 数据面类型与 api-types 镜像零漂移（type-only 引用）。
  assert.match(source, /import type \{ AttentionEntry, AttentionKind \} from "@\/lib\/api-types"/);
});

// --------------------------------------------------- source: page mount

test("WorkItemsPage mounts AttentionBar at the top with select + refresh wiring", () => {
  const source = readFileSync(new URL("./WorkItemsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\/AttentionBar"/);
  assert.match(source, /<AttentionBar/);
  assert.match(source, /onSelectItem=\{handleSelect\}/);
  // refreshToken = 共享快照的 fetchedAt（5s 轮询换引用 → 待办条同步重取）。
  assert.match(source, /refreshToken=\{snapshot\?\.fetchedAt\}/);
});
