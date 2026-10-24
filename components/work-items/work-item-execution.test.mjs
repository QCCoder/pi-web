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

test("WorkItemExecution renders claim worktrees alias-first（ULID 回退）+ branch, path 只进 title", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        claim: claim({
          role: "developer",
          worktrees: [
            {
              // fix round 1：alias 由 GET 路由读取时 manifest 联表富化——
              // 有 alias 显示 alias（ULID 不出现），无 alias 回退 repositoryId。
              repositoryId: "01JXWT000000000000000000",
              repoPath: "/ws/repositories/cargo-web",
              path: "/ws/repositories/cargo-web-worktrees/pi-delivery-REQ-0001-gen3",
              branch: "pi-delivery/REQ-0001/gen3",
              alias: "cargo-web",
            },
            {
              repositoryId: "01JXWT111111111111111111",
              repoPath: "/ws/repositories/legacy",
              path: "/ws/repositories/legacy-worktrees/pi-delivery-REQ-0001-gen3",
              branch: "pi-delivery/REQ-0001/gen3",
            },
          ],
        }),
      }),
    })),
  );
  assert.match(html, /cargo-web/, "alias shown when present");
  assert.doesNotMatch(html, /01JXWT000000000000000000/, "ULID hidden behind alias");
  assert.match(html, /01JXWT111111111111111111/, "repositoryId fallback when no alias");
  assert.match(html, /pi-delivery\/REQ-0001\/gen3/, "branch shown");
  // 长 path 不直接铺正文——作为 title 提示挂在条目上。
  assert.match(html, /title="[^"]*cargo-web-worktrees/, "worktree path surfaced via title tooltip");
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

// --------------------------- Phase-4 T5: verifier 徽标 + 检查证据 + checks 配置编辑器

const checkResult = (overrides = {}) => ({
  name: "unit",
  exitCode: 0,
  durationMs: 840,
  logRef: "delivery/artifacts/verification-logs/01JXECUTE0001/unit.log",
  outcome: "passed",
  ...overrides,
});

test("WorkItemExecution renders the verifier role badge on the claim (Phase-4 T5)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({ claim: claim({ role: "verifier" }) }),
    })),
  );
  assert.match(html, /verifier/, "verifier role label rendered");
  assert.match(html, /停止执行/, "claim card still complete");
});

test("WorkItemExecution renders claim checkResults rows（名称/outcome 徽章/exitCode/duration/日志名）", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        claim: claim({
          role: "verifier",
          checkContexts: [
            { name: "unit", repositoryId: "01JXWT000000000000000000", command: "npm run test", timeout_seconds: 300 },
            { name: "e2e", repositoryId: "01JXWT000000000000000000", command: "npm run e2e" },
          ],
          checkResults: [
            checkResult(),
            checkResult({ name: "e2e", exitCode: 1, durationMs: 15400, logRef: "delivery/artifacts/verification-logs/01JXECUTE0001/e2e.log", outcome: "failed" }),
            checkResult({ name: "lint", exitCode: null, durationMs: 200, logRef: "delivery/artifacts/verification-logs/01JXECUTE0001/lint.log", outcome: "unverified" }),
          ],
        }),
      }),
    })),
  );
  // 名称与 outcome 徽章。
  assert.match(html, /unit/, "check name rendered");
  assert.match(html, /e2e/, "check name rendered");
  assert.match(html, /通过/, "passed outcome badge");
  assert.match(html, /未通过/, "failed outcome badge");
  assert.match(html, /未验证/, "unverified outcome badge");
  // exitCode：数字直陈；null（unverified——进程未跑完）显式占位，不显示 "null"。
  assert.match(html, /退出码 0/, "exit code 0 shown");
  assert.match(html, /退出码 1/, "exit code 1 shown");
  assert.match(html, /退出码 —/, "null exit code gets an explicit placeholder");
  assert.doesNotMatch(html, /退出码 null/, "raw null never leaks");
  // duration：<1s 毫秒直陈，≥1s 秒一位小数。
  assert.match(html, /840ms/, "sub-second duration in ms");
  assert.match(html, /15\.4s/, "seconds duration with one decimal");
  assert.match(html, /200ms/, "sub-second duration in ms (unverified row)");
  // 日志文件名（basename）铺正文，完整 logRef 进 title。
  assert.match(html, /unit\.log/, "log file name shown");
  assert.match(html, /title="delivery\/artifacts\/verification-logs\/01JXECUTE0001\/unit\.log"/, "full logRef in title tooltip");
  // 命令来源（checkContexts 按名联表）也进 title（命令打头，附仓库/超时）。
  assert.match(html, /title="npm run test[^"]*"/, "frozen command from checkContexts surfaced via title");
});

test("WorkItemExecution renders attempt verificationOutcome 徽章 + rework 路径的失败证据", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        recentAttempts: [
          attempt({
            role: "verifier",
            outcome: "submitted",
            verificationOutcome: "verified",
          }),
          attempt({
            role: "verifier",
            outcome: "submitted",
            verificationOutcome: "rework",
            checkResults: [
              checkResult({ name: "unit", exitCode: 2, outcome: "failed" }),
              checkResult({ name: "e2e", exitCode: 0 }),
            ],
          }),
        ],
      }),
    })),
  );
  assert.match(html, /已验证/, "verified outcome badge");
  assert.match(html, /需返工/, "rework outcome badge");
  // rework 路径的检查证据（attempt.checkResults——claim 已清，证据只在审计里）：
  // 紧凑 chips（名称 + outcome），完整证据进 title。
  assert.match(html, /unit 未通过/, "failed check chip");
  assert.match(html, /e2e 通过/, "passed check chip");
  assert.match(html, /title="[^"]*退出码 2[^"]*"/, "evidence details in chip title");
});

test("WorkItemDetailView renders verification checks evidence 摘要（命令+退出码）", async () => {
  const managed = (deliveryOverrides = {}) => ({
    schemaVersion: 1,
    id: "01J0",
    key: "REQ-0009",
    revision: 3,
    type: "requirement",
    title: "示例需求",
    status: "in_progress",
    phase: "release_ready",
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
      verification: {
        at: "2026-10-24T03:00:00.000Z",
        actor: "agent",
        requirementDigest: "r".repeat(8),
        candidateDigest: "c".repeat(8),
        checks: [
          {
            name: "unit",
            outcome: "passed",
            evidence: {
              command: "npm run test",
              exitCode: 0,
              durationMs: 5200,
              logRef: "delivery/artifacts/verification-logs/01JXEC0000000009/unit.log",
            },
          },
          {
            name: "lint",
            outcome: "unverified",
            evidence: {
              command: "npm run lint",
              exitCode: null,
              durationMs: 300,
              logRef: "delivery/artifacts/verification-logs/01JXEC0000000009/lint.log",
            },
          },
        ],
        ...deliveryOverrides,
      },
    },
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const { WorkItemDetailView } = await jiti.import("./WorkItemDetailView.tsx");
  const html = renderToStaticMarkup(
    React.createElement(WorkItemDetailView, {
      workspaceId: "ws",
      item: managed(),
      repositories: [],
      onOpenConversation: noop,
    }),
  );
  assert.match(html, /验证记录/, "verification block header");
  assert.match(html, /npm run test/, "evidence command shown");
  assert.match(html, /npm run lint/, "evidence command shown");
  assert.match(html, /退出码 0/, "exit code shown");
  assert.match(html, /退出码 —/, "null exit code placeholder");
  assert.match(html, /5\.2s/, "duration shown");
  assert.match(html, /unit\.log/, "log file name shown");
  assert.match(html, /title="delivery\/artifacts\/verification-logs\/01JXEC0000000009\/unit\.log"/, "full logRef in title");
});

test("WorkspaceManager 配置区 checks 编辑器：四列（name/repositoryId/command/timeout_seconds）+ 增删行 + 空态引导", () => {
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  // 草稿行 state + 客户端镜像形状（timeout_seconds）。
  assert.match(source, /DeliveryCheckDraft/);
  assert.match(source, /deliveryChecks/);
  assert.match(source, /timeout_seconds/);
  // 仓库列是 select：候选首仓（缺省）+ 在册仓可选。
  assert.match(source, /候选首仓/);
  // 增行 / 行删除。
  assert.match(source, /添加验证命令/);
  assert.match(source, /aria-label=\{`删除验证命令/, "per-row delete affordance (aria-labeled)");
  // 空 checks 时的引导文案（不是死空白）。
  assert.match(source, /尚未配置验证命令/);
});

test("WorkspaceManager checks 编辑器 round-trip：GET 播种 + PUT 带 verification 键（无有效行则省键）", () => {
  const source = readFileSync(new URL("../WorkspaceManager.tsx", import.meta.url), "utf8");
  // 草稿 helper 读 config.verification.checks（缺省空清单）；GET 播种与保存
  // 回填都经同一 helper（两处调用）。
  assert.match(source, /config\.verification\?\.checks \?\? \[\]/);
  const seedCalls = source.match(/checksDraftFromConfig\(/g) ?? [];
  assert.ok(seedCalls.length >= 2, "load seed + post-save re-seed both go through the draft helper");
  // PUT 载荷：经 checksPayload 组装，空清单 → 键整体省略（= 无配置）。
  assert.match(source, /checksPayload\(deliveryChecks\)/);
  assert.match(source, /\.\.\.\(verification \? \{ verification \} : \{\}\)/);
  // 行校验：名称与命令必填 + timeout 整数 1–3600。
  assert.match(source, /名称与命令/);
  assert.match(source, /1–3600 的整数/);
});

// --------------------- Phase-5 T2: release-preparer 徽标 + releasePlan 摘要

test("WorkItemExecution renders the release-preparer role badge on the claim (Phase-5 T2)", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({ claim: claim({ role: "release-preparer" }) }),
    })),
  );
  assert.match(html, /release-preparer/, "release-preparer role label rendered");
  assert.match(html, /停止执行/, "claim card still complete");
});

test("WorkItemExecution renders submitted attempt releasePlan 摘要（notes 首行 + rollback 有无标记）", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        recentAttempts: [
          attempt({
            role: "release-preparer",
            outcome: "submitted",
            releasePlan: {
              notes: "本次发布新增登录页与鉴权中间件。\n影响面：会话链路。\n验证：build 通过。",
              rollback: "回滚：revert 发布分支并重发上一版本镜像。",
            },
          }),
          attempt({
            attemptId: "01JC",
            role: "release-preparer",
            sessionId: "sess-c",
            outcome: "submitted",
            releasePlan: { notes: "小版本修复。" },
          }),
        ],
      }),
    })),
  );
  // notes 首行铺正文（多行只取首行），完整 notes+rollback 进 title。
  assert.match(html, /发布材料/, "releasePlan summary label rendered");
  assert.match(
    html,
    /发布材料 本次发布新增登录页与鉴权中间件。 · 含回滚/,
    "row body carries ONLY the first line + rollback marker (later lines stay in the title)",
  );
  assert.match(html, /发布材料 小版本修复。 · 未附回滚/, "rollback-absent marker on the second attempt");
  assert.match(html, /含回滚/, "rollback-present marker");
  assert.match(html, /未附回滚/, "rollback-absent marker");
  assert.match(html, /title="[^"]*影响面：会话链路。[^"]*"/, "full notes surfaced via title tooltip");
  assert.match(html, /title="[^"]*revert 发布分支[^"]*"/, "full rollback surfaced via title tooltip");
});

test("WorkItemExecution attempt 行不带 releasePlan 时零渲染（非 release-preparer 提交不受影响）", () => {
  const html = renderToStaticMarkup(
    React.createElement(WorkItemExecution, props({
      execution: execution({
        recentAttempts: [attempt({ role: "designer", outcome: "submitted" })],
      }),
    })),
  );
  assert.doesNotMatch(html, /发布材料/, "no releasePlan summary without a releasePlan");
  assert.doesNotMatch(html, /含回滚|未附回滚/);
});
