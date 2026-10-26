import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// final-arch step-2 Task 6 render/source assertions（brief Step 1）：
//  1. 渲染：clarifications 新→旧、已答只读 Q/A、未答 options 单选（recommended
//     预选）/ 自由文本（recommended 预填）、无条目不渲染；
//  2. 提交契约（source）：POST delivery/answer-clarification，payload
//     { clarificationId, answer } + expectedRevision + requestId、409 内联
//     「已被他人回答或版本已变，请刷新」、400 服务端文案、posting 禁用；
//  3. DetailView 挂载（动作条旁，onChanged 接线）。

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { ClarificationPanel } = await jiti.import("./ClarificationPanel.tsx");

const answered = {
  id: "01JANSWERED0000000000000000",
  role: "designer",
  question: "旧问题：导出格式要不要带样式？",
  askedAt: "2026-10-20T01:00:00.000Z",
  attemptId: "01JATT0001",
  answer: "带样式",
  answeredAt: "2026-10-20T02:00:00.000Z",
};

const unansweredOptions = {
  id: "01JOPTIONS00000000000000000",
  role: "developer",
  question: "新问题：候选方案选哪个？",
  options: ["方案A", "方案B", "方案C"],
  recommended: "方案B",
  askedAt: "2026-10-24T01:00:00.000Z",
  attemptId: "01JATT0002",
};

const unansweredFree = {
  id: "01JFREETEXT00000000000000000",
  role: "verifier",
  question: "自由问题：超时阈值设多少？",
  recommended: "900 秒",
  askedAt: "2026-10-24T03:00:00.000Z",
  attemptId: "01JATT0003",
};

const item = (clarifications, overrides = {}) => ({
  schemaVersion: 1,
  id: "01J0",
  key: "REQ-0001",
  revision: 7,
  type: "requirement",
  title: "示例需求",
  status: "in_progress",
  phase: "design",
  priority: "P2",
  repositories: [],
  tags: [],
  conversations: [],
  relatedItems: [],
  designs: [],
  plans: [],
  delivery: {
    protocolVersion: 1,
    mode: "manual",
    ...(clarifications !== undefined ? { clarifications } : {}),
  },
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const noop = () => {};
const props = (clarifications, overrides = {}) => ({
  workspaceId: "ws",
  item: item(clarifications),
  onChanged: noop,
  ...overrides,
});

// ------------------------------------------------------------- render tests

test("ClarificationPanel renders nothing without delivery or clarifications", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ClarificationPanel, props(undefined))), "");
  assert.equal(renderToStaticMarkup(React.createElement(ClarificationPanel, props([]))), "");
});

test("ClarificationPanel lists clarifications newest-first", () => {
  const html = renderToStaticMarkup(
    React.createElement(ClarificationPanel, props([answered, unansweredOptions, unansweredFree])),
  );
  assert.ok(
    html.indexOf("自由问题：超时阈值设多少？") < html.indexOf("新问题：候选方案选哪个？"),
    "newest (10-24T03) before middle (10-24T01)",
  );
  assert.ok(
    html.indexOf("新问题：候选方案选哪个？") < html.indexOf("旧问题：导出格式要不要带样式？"),
    "middle before oldest (10-20T01)",
  );
});

test("ClarificationPanel renders answered entries read-only (Q/A + role + answered time)", () => {
  const html = renderToStaticMarkup(
    React.createElement(ClarificationPanel, props([answered])),
  );
  assert.match(html, /旧问题：导出格式要不要带样式？/, "question shown");
  assert.match(html, /带样式/, "answer shown");
  assert.match(html, /designer/, "role badge");
  assert.match(html, /已答/, "answered marker");
  assert.doesNotMatch(html, /回答/, "no submit affordance on answered entries");
  assert.doesNotMatch(html, /<textarea/, "no input on answered entries");
});

test("ClarificationPanel renders options as radios with the recommended preselected", () => {
  const html = renderToStaticMarkup(
    React.createElement(ClarificationPanel, props([unansweredOptions])),
  );
  assert.match(html, /方案A/);
  assert.match(html, /方案B/);
  assert.match(html, /推荐/, "recommended marked");
  // 方案B 的 radio 带 checked；方案A 的不带。
  const radioB = html.match(/<input[^>]*value="方案B"[^>]*>/);
  assert.ok(radioB, "radio for 方案B rendered");
  assert.match(radioB[0], /checked/, "recommended preselected");
  const radioA = html.match(/<input[^>]*value="方案A"[^>]*>/);
  assert.ok(radioA, "radio for 方案A rendered");
  assert.doesNotMatch(radioA[0], /checked/, "non-recommended unchecked");
});

test("ClarificationPanel prefills the free textarea with the recommended text", () => {
  const html = renderToStaticMarkup(
    React.createElement(ClarificationPanel, props([unansweredFree])),
  );
  const textarea = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(textarea, "textarea rendered when no options");
  assert.equal(textarea[1], "900 秒", "recommended prefilled");
});

test("ClarificationPanel offers a 回答 submit per unanswered entry", () => {
  const html = renderToStaticMarkup(
    React.createElement(ClarificationPanel, props([answered, unansweredOptions, unansweredFree])),
  );
  const buttons = html.match(/>回答</g) ?? [];
  assert.equal(buttons.length, 2, "one 回答 button per unanswered entry");
});

// ------------------------------------------------------- source: submit path

test("ClarificationPanel posts answer-clarification with the bound payload shape", () => {
  const source = readFileSync(new URL("./ClarificationPanel.tsx", import.meta.url), "utf8");
  // 走共享 runDeliveryAction（端点 + {expectedRevision, requestId, payload} 形状
  // 的唯一封装处，见 work-item-api.ts）。
  assert.match(source, /runDeliveryAction\(/);
  assert.match(source, /"answer-clarification"/);
  assert.match(source, /item\.revision/);
  assert.match(source, /\{ clarificationId: clarification\.id, answer \}/);
});

test("ClarificationPanel handles 409 with the refresh hint and 400 with the server message", () => {
  const source = readFileSync(new URL("./ClarificationPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /status === 409/);
  assert.match(source, /已被他人回答或版本已变，请刷新/);
  assert.match(source, /instanceof Error \? submitError\.message : String\(submitError\)/);
  // posting 期间禁用提交（防双击）：anyPosting = postingId 在场 → 全部控件 disabled。
  assert.match(source, /const disabled = anyPosting/);
  assert.match(source, /disabled=\{disabled \|\| !draft\.trim\(\)\}/);
});

test("ClarificationPanel calls onChanged after success and after a 409", () => {
  const source = readFileSync(new URL("./ClarificationPanel.tsx", import.meta.url), "utf8");
  const calls = source.match(/onChanged\?\.\(\)/g) ?? [];
  assert.ok(calls.length >= 2, "success + conflict both refresh the host");
});

// --------------------------------------------------- source: detail mount

test("WorkItemDetailView mounts ClarificationPanel beside the action bar", () => {
  const source = readFileSync(new URL("./WorkItemDetailView.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\/ClarificationPanel"/);
  assert.match(source, /<ClarificationPanel/);
  assert.match(source, /onChanged=\{onChanged\}/);
});
