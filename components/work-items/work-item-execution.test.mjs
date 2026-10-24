import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// Phase-2 Task 9 source/render assertions（brief Step 1）：
//  1. 执行区组件存在并被 DetailView 挂载（managed 项门控）；
//  2. 四态呈现：活动 claim（停止执行）/ paused 横幅（恢复自动领取）/
//     pendingInterruption 横幅（重新检查并恢复）/ 最近 attempts 列表；
//  3. 三个动作 POST 由 WorkItemsPage 打到正确路径（stop / recover{manual} /
//     delivery/resume{key}）且 409 pids 走内联提示；
//  4. WorkspaceManager 配置块：capability 门控 work-items+workflows、
//     GET/PUT /delivery、enabled 开关 + designer profile 文本框 + 预算只读。

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { WorkItemExecution } = await jiti.import("./WorkItemExecution.tsx");

const execution = (overrides = {}) => ({
  claim: null,
  recentAttempts: [],
  paused: null,
  pendingInterruption: false,
  ...overrides,
});

const claim = (overrides = {}) => ({
  attemptId: "01JXECUTE0001",
  generation: 3,
  role: "designer",
  sessionId: "sess-exec-1",
  claimedAt: "2026-10-24T01:00:00.000Z",
  lastSeenAt: "2026-10-24T01:05:00.000Z",
  requirementDigest: "deadbeef",
  ...overrides,
});

const attempt = (overrides = {}) => ({
  attemptId: "01JXEC0000000001",
  generation: 1,
  role: "designer",
  sessionId: "sess-1",
  workspacePath: "/ws",
  key: "REQ-0001",
  claimedAt: "2026-10-24T00:00:00.000Z",
  outcome: "submitted",
  requirementDigest: "deadbeef",
  ...overrides,
});

const noop = () => {};
const props = (overrides = {}) => ({
  execution: execution(),
  busy: false,
  onStop: noop,
  onRecover: noop,
  onResumeAutomation: noop,
  onOpenConversation: noop,
  ...overrides,
});

// ------------------------------------------------------------- render tests

test("WorkItemExecution renders the active claim with 停止执行 and a session link", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({ claim: claim() }),
    })),
  );
  assert.match(html, /停止执行/, "stop button rendered");
  assert.match(html, /sess-exec-1/, "claim sessionId visible");
  assert.match(html, /查看会话/, "session link entry point");
  assert.match(html, /designer/, "role shown");
});

test("WorkItemExecution renders the paused banner with 恢复自动领取", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        paused: { at: "2026-10-24T02:00:00.000Z", reason: "连续失败", count: 3 },
      }),
    })),
  );
  assert.match(html, /恢复自动领取/, "resume automation button");
  assert.match(html, /连续失败/, "paused reason surfaced");
});

test("WorkItemExecution renders the pendingInterruption banner with 重新检查并恢复", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({ pendingInterruption: true }),
    })),
  );
  assert.match(html, /重新检查并恢复/, "recover button");
  assert.match(html, /中断/, "interruption banner copy");
});

test("WorkItemExecution renders recent attempts (新→旧, outcome labels, 待处理 marks)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        recentAttempts: [
          attempt({ attemptId: "01JB", sessionId: "sess-b", outcome: "failed", reason: "budget exceeded" }),
          attempt({ attemptId: "01JA", sessionId: "sess-a", outcome: "interrupted", needsAttention: true }),
        ],
      }),
    })),
  );
  assert.match(html, /失败/, "failed outcome label");
  assert.match(html, /中断/, "interrupted outcome label");
  assert.match(html, /待处理/, "needsAttention mark");
  // 新→旧：JB（后）排在 JA（前）之前。
  assert.ok(html.indexOf("01JB") < html.indexOf("01JA") || (html.indexOf("sess-b") < html.indexOf("sess-a")));
});

test("WorkItemExecution shows an idle hint when nothing is running and history is empty", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props()),
  );
  assert.match(html, /暂无/);
  assert.doesNotMatch(html, /停止执行/);
});

test("WorkItemExecution disables every action button while busy (防双击)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      busy: true,
      execution: execution({
        claim: claim(),
        paused: { at: "2026-10-24T02:00:00.000Z", reason: "连续失败", count: 3 },
        pendingInterruption: true,
      }),
    })),
  );
  for (const label of ["停止执行", "重新检查并恢复", "恢复自动领取"]) {
    const button = html.match(new RegExp(`<button[^>]*disabled[^>]*>[^<]*${label}`));
    assert.ok(button, `${label} button disabled while busy`);
  }
});

test("WorkItemExecution renders the inline recover error (409 pids) with role=alert", () => {
  const source = readFileSync(new URL("./WorkItemExecution.tsx", import.meta.url), "utf8");
  // onRecover 的 {ok:false,error} 结果进内联提示（M2 conflict 提示同款 role=alert）。
  assert.match(source, /role="alert"/);
  assert.match(source, /ok === false|ok !== true|!result\.ok/);
});

// ------------------------------------------------- source: DetailView mount

test("WorkItemDetailView mounts WorkItemExecution (managed items only)", () => {
  const source = readFileSync(new URL("./WorkItemDetailView.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\/WorkItemExecution"/);
  assert.match(source, /<WorkItemExecution/);
  // 挂载必须门控 item.delivery（非 managed 不渲染执行区）。
  const mountSite = source.match(/\{[^{}]*<WorkItemExecution[\s\S]*?\/>/);
  assert.ok(mountSite, "conditional mount block found");
  assert.match(mountSite[0], /item\.delivery/);
});

test("WorkItemDetailView threads execution props through (execution/busy/三个动作回调)", () => {
  const source = readFileSync(new URL("./WorkItemDetailView.tsx", import.meta.url), "utf8");
  assert.match(source, /onStopExecution\??:/);
  assert.match(source, /onRecoverExecution\??:/);
  assert.match(source, /onResumeAutomation\??:/);
  assert.match(source, /execution=\{execution\}/);
  assert.match(source, /busy=\{executionBusy\}/);
});

// --------------------------------------------------- source: WorkItemsPage

test("WorkItemsPage fetches delivery-execution only for managed items and refreshes on revision", () => {
  const source = readFileSync(new URL("./WorkItemsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /delivery-execution/);
  // 门控：非 managed（无 item.delivery）不拉——effect 内出现 delivery 判定。
  assert.match(source, /selectedItem\.delivery|item\.delivery/);
});

test("WorkItemsPage posts the three execution actions to the right routes", () => {
  const source = readFileSync(new URL("./WorkItemsPage.tsx", import.meta.url), "utf8");
  // stop
  assert.match(source, /delivery-execution\/stop/);
  assert.match(source, /onStopExecution/);
  // recover：manual 确认 + 409 → 服务端 error（已含 pid 清单）原样内联，
  // 客户端不再重复拼接 pidsSuffix（fix round 1：双拼文案）。
  assert.match(source, /delivery-execution\/recover/);
  assert.match(source, /manual: true/);
  assert.match(source, /body\.error/);
  assert.doesNotMatch(source, /pids\.join/);
  // resume automation：key 走 body
  assert.match(source, /\/delivery\/resume/);
  assert.match(source, /onResumeAutomation/);
});

// -------------------------------------------- source: WorkspaceManager config

test("WorkspaceManager gates the 交付自动化 config block on work-items + workflows", () => {
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  assert.match(source, /交付自动化/);
  const gate = source.match(/includes\("work-items"\)[\s\S]{0,120}includes\("workflows"\)/);
  assert.ok(gate, "capability gate: work-items && workflows");
});

test("WorkspaceManager config block loads via GET /delivery and saves via PUT (开关/profile/预算只读)", () => {
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/workspaces\/\$\{encodeURIComponent\([^)]*\)\}\/delivery/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /enabled/);
  assert.match(source, /designer/);
  assert.match(source, /失败上限/);
  assert.match(source, /执行上限/);
});

test("GET /delivery {config:null} seeds the default mirror, not an error (fix round 1: 死 UI)", () => {
  // Task 1 契约：.pi/delivery.yaml 缺失 → 200 + {config:null} = 默认 disabled。
  // 表单必须按默认镜像播种（enabled:false / roles:{} / 预算 3/30），否则刚开齐
  // capabilities 的工作区永远无法从 UI 启用自动化（配置块变死 UI）。
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  const seed = source.match(/data\.config \?\? (DEFAULT_DELIVERY_RUNNER_CONFIG)/);
  assert.ok(seed, "config:null falls back to the default mirror constant");
  const mirror = source.match(/const DEFAULT_DELIVERY_RUNNER_CONFIG[^=]*=[\s\S]*?};/);
  assert.ok(mirror, "default mirror constant defined");
  assert.match(mirror[0], /enabled: false/);
  assert.match(mirror[0], /roles: \{\}/);
  assert.match(mirror[0], /maxAttemptsPerInput: 3/);
  assert.match(mirror[0], /maxExecutionMinutes: 30/);
  // 错误分支只来自非 2xx / 网络失败——config:null 不再设 deliveryError。
  assert.doesNotMatch(source, /data\.error \?\? "交付自动化配置加载失败"/);
});

test("GET /delivery error guard runs BEFORE the default-mirror fallback (fix round 2: 非 2xx 不静默播种)", () => {
  // 非 2xx（fallback 携带 {error:"HTTP <status>"}）必须命中 data.error 守卫
  // 并 return——先走 ?? DEFAULT 会把 404/400/500 静默吞成默认表单，随后的
  // 保存就会用默认值覆盖真实/损坏的 .pi/delivery.yaml。
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  const handler = source.match(
    /\.then\(\(data\) => \{[\s\S]*?data\.config \?\? DEFAULT_DELIVERY_RUNNER_CONFIG[\s\S]*?\}\)/,
  );
  assert.ok(handler, "GET .then handler with default fallback found");
  const guardIndex = handler[0].indexOf("if (data.error)");
  const fallbackIndex = handler[0].indexOf("data.config ?? DEFAULT_DELIVERY_RUNNER_CONFIG");
  assert.ok(guardIndex !== -1, "data.error guard present in handler");
  assert.ok(fallbackIndex !== -1, "default fallback present in handler");
  assert.ok(guardIndex < fallbackIndex, "guard ordered BEFORE the fallback");
  assert.match(handler[0], /setDeliveryError\(String\(data\.error\)\)/);
});

// ----------------------------------- Phase-3 T5: developer role + worktrees/candidates

test("WorkItemExecution renders the developer role badge on the claim (Phase-3 T5)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({ claim: claim({ role: "developer" }) }),
    })),
  );
  assert.match(html, /developer/, "developer role label rendered");
  assert.match(html, /停止执行/, "claim card still complete");
});

test("WorkItemExecution renders claim worktrees (repositoryId + branch, path 只进 title)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        claim: claim({
          role: "developer",
          worktrees: [
            {
              repositoryId: "repo-alpha",
              repoPath: "/ws/repositories/repo-alpha",
              path: "/ws/repositories/repo-alpha-worktrees/pi-delivery-REQ-0001-gen3",
              branch: "pi-delivery/REQ-0001/gen3",
            },
          ],
        }),
      }),
    })),
  );
  assert.match(html, /repo-alpha/, "repositoryId shown");
  assert.match(html, /pi-delivery\/REQ-0001\/gen3/, "branch shown");
  // 长 path 不直接铺正文——作为 title 提示挂在条目上。
  assert.match(html, /title="[^"]*repo-alpha-worktrees/, "worktree path surfaced via title tooltip");
});

test("WorkItemExecution renders submitted attempt candidates summary (repo@commit 前 8 位)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        recentAttempts: [
          attempt({
            role: "developer",
            outcome: "submitted",
            candidates: [{ repositoryId: "repo-alpha", commit: "abcd1234567890ef" }],
          }),
        ],
      }),
    })),
  );
  assert.match(html, /repo-alpha@abcd1234/, "repo@commit8 summary rendered");
  assert.doesNotMatch(html, /repo-alpha@abcd1234567890ef/, "full commit sha not dumped");
});

test("WorkspaceManager 配置区编辑 developer profile（与 designer 同形，round-trip 保真）", () => {
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  // developer 同形行：独立草稿 state + 表单行。
  assert.match(source, /deliveryDeveloperProfile/);
  assert.match(source, /Developer Profile/);
  // GET 播种与保存回填都读 roles.developer.profile。
  const seedMatches = source.match(/roles\.developer\?\.profile \?\? ""/g) ?? [];
  assert.ok(seedMatches.length >= 2, "load seed + post-save re-seed both read roles.developer.profile");
  // PUT round-trip：保留既有 developer model 覆写（designer 同款习语）。
  assert.match(source, /deliveryConfig\.roles\.developer/);
  assert.match(source, /existingDeveloper/);
});
