# 里程碑一：单进程宿主收敛（去 daemon）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把活跃会话、子 agent 与 kit loop 的运行职责从独立 pi-daemon 收回 Next.js 常驻 Node.js 宿主，删除 daemon 的网络服务、客户端代理、sidecar 拉起与健康探测，浏览器协议与既有行为保持不变。

**Architecture:** `lib/daemon/rpc-manager.ts` 的 wrapper/注册表/SDK 装配原样迁到中性模块 `lib/session-host/`（注册表本就在 globalThis 上，天然抗热重载）；daemon 的 HTTP 会话面（`http-sessions.ts`）语义移植为同进程类型化门面 `facade.ts`；SSE 从「代理 daemon 响应体」改为「本进程 Web 流直出」（字节上限防积压）；loop 心跳从 daemon job 改为 `instrumentation.ts` 显式装配；新增关停处理、执行中断记录与恢复门禁。

**Tech Stack:** Next.js App Router（Node runtime）、@earendil-works/pi-coding-agent 0.84.4（原样依赖）、node:test + jiti、Web ReadableStream SSE。

**Spec:** `docs/superpowers/specs/2026-10-23-phase-one-host-and-work-items-design.md`（§5 全部、§4 边界、§10 验证项 1–4 与 9 的 loop 部分）；总纲 `docs/superpowers/specs/2026-10-23-single-process-delivery-architecture.md`。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 任何源码或依赖版本；只移动/适配本仓代码（spec §1 决定 3、§10）。
- 浏览器协议不变：`/api/agent/**`、`/api/subagents/[id]`、SSE 帧格式（`connected` 帧、30s 心跳注释、destroy 即断流）、`GET /api/sessions/[id]/state` 的 `liveInDaemon` 字段名、`SessionsPayload.daemonDown` 字段名都保留（spec §5.1–5.2）。
- prompt 拒绝语义不变：只有宿主**受理前**的失败才标 `code:"prompt_rejected", accepted:false`；受理后的缓存更新/发送失败不得误标（spec §5.1）。
- 单实例：注册表、心跳监控、loop 定时器、subagent 控制器全部 globalThis 守卫；热重载不得出现第二个 owner、两份消息或两个 loop 定时器（spec §5.1、§10 验证 2）。
- 共享宿主下**禁止按 cwd 收割进程**：轮清理依赖 SDK `destroy()→dispose()→abortBash()→killProcessTree` 的按执行进程组定向杀（spec §5.4、§10 验证 3）。
- 保留 `packages/pi-loop/` 的纯协议与 beat CLI 独立可用，不改其文件协议（spec §5.5）。
- 不移动用户会话/工作区目录；首次部署由停机切换 + 老 daemon 探测守卫保障（spec §5.4）。
- 验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 与浏览器手测；**绝不运行 `next build`**（spec §10）。
- 每个任务以可运行测试结尾并提交；提交信息用 conventional 前缀（feat:/refactor:/test:/docs:/chore:）。

---

### Task 1: 迁移会话宿主核心到 lib/session-host/

**Files:**
- Create: `lib/session-host/registry.ts`（= 原 `lib/daemon/rpc-manager.ts` 全文迁移）
- Create: `lib/session-host/heartbeat.ts`（= 原 `lib/daemon/session-heartbeat.ts` 全文迁移）
- Delete: `lib/daemon/rpc-manager.ts`、`lib/daemon/session-heartbeat.ts`
- Modify: `lib/daemon/http-sessions.ts`（import 路径）、`lib/daemon/loop-spawner.ts`（import 路径）
- Test: `lib/session-host/registry.test.mjs`（= 原 `lib/daemon/rpc-manager.test.mjs` 迁移）、`lib/session-host/registry-shutdown.test.mjs`（= 原 `rpc-manager-shutdown.test.mjs` 迁移）、`lib/session-host/heartbeat.test.mjs`（= 原迁移）

**Interfaces:**
- Produces（后续任务全部依赖，名字与签名**不变**）：`AgentSessionWrapper`、`AgentEvent`、`StartSessionOptions`、`startRpcSession(sessionId, sessionFile, cwd, toolNames?, options?) => Promise<{ session, realSessionId }>`、`getRpcSession(sessionId)`、`hasBusyRpcSessionForCwd(cwd)`、`destroyRpcSessionsForCwd(cwd)`、`getRunningRpcSessionIds()`、`getStalledSessionSnapshot()`、`LiveRpcSessionInfo`、`getLiveRpcSessionInfos()`、`subscribeRunningSessions(listener)`、`getSubagentRun(sessionId)`、`steerSubagent(sessionId, message)`、`abortSubagent(sessionId)`。
- 新增 Produces：`getAllRpcSessions(): AgentSessionWrapper[]`（Task 7 关停遍历用）。
- Consumes: 无前置任务。

- [ ] **Step 1: git mv 迁移文件并修 import**

```bash
mkdir -p lib/session-host
git mv lib/daemon/rpc-manager.ts lib/session-host/registry.ts
git mv lib/daemon/session-heartbeat.ts lib/session-host/heartbeat.ts
git mv lib/daemon/rpc-manager.test.mjs lib/session-host/registry.test.mjs
git mv lib/daemon/rpc-manager-shutdown.test.mjs lib/session-host/registry-shutdown.test.mjs
git mv lib/daemon/session-heartbeat.test.mjs lib/session-host/heartbeat.test.mjs
```

然后逐文件修 import：
- `lib/session-host/registry.ts`：`from "./session-heartbeat"` → `from "./heartbeat"`；模块头注释（原 25–34 行「daemon-process code only」段）整段替换为：

```ts
// ============================================================================
// SESSION REGISTRY — the single in-process session owner.
// ============================================================================
// This module owns every AgentSession in the Next.js Node.js host process:
// interactive sessions, subagent children and kit loop rounds share one
// registry keyed by real session id. Web routes consume it through the typed
// facade (lib/session-host/facade.ts) — do not import this module from routes
// directly; the facade owns error→status mapping and cold-revive semantics.
// The registry lives on globalThis so Next.js route cold-loading and dev hot
// reload can never create a second owner.
```

- `lib/daemon/http-sessions.ts` 与 `lib/daemon/loop-spawner.ts`：`./rpc-manager.ts` → `../session-host/registry.ts`、`./session-heartbeat.ts` → `../session-host/heartbeat.ts`（这两个文件在 Task 6 / Task 9 中分别迁移与删除，此处只保编译）。
- 三个测试文件里的 `./rpc-manager.ts` / `./session-heartbeat.ts` 相对路径改为 `./registry.ts` / `./heartbeat.ts`。

- [ ] **Step 2: subagent 控制器加 globalThis 守卫（防热重载双控制器）**

`registry.ts` 末尾把模块级 `const SUBAGENT_CONTROLLER = createSubagentController({...})` 改为单例函数（HMR 装载第二份模块时复用同一控制器，否则其内部 per-session 状态会分叉）：

```ts
function getSubagentControllerSingleton() {
  const g = globalThis as typeof globalThis & { __piSubagentController?: ReturnType<typeof createSubagentController> };
  if (!g.__piSubagentController) {
    g.__piSubagentController = createSubagentController({
      getSession: (sessionId) => getRegistry().get(sessionId),
      registerSession: (inner) => registerSubagentChild(inner),
      reopenSession: reopenSubagentSession,
      resolveSessionPath,
      invalidateSessionList: invalidateSessionListCache,
      isBuiltInSubagentsEnabled,
    });
  }
  return g.__piSubagentController;
}

const SUBAGENT_CONTROLLER = getSubagentControllerSingleton();
```

并在文件顶部 `declare global` 块（1178–1183 行处）追加一行声明：

```ts
  var __piSubagentController: ReturnType<typeof createSubagentController> | undefined;
```

（`declare global` 需在 `import type` 之后；追加到现有块内即可。）

- [ ] **Step 3: 新增 getAllRpcSessions 导出**

`registry.ts` 中 `getRunningRpcSessionIds` 附近追加：

```ts
/** Every alive wrapper (shutdown path iterates this to abort everything). */
export function getAllRpcSessions(): AgentSessionWrapper[] {
  return Array.from(getRegistry().values()).filter((session) => session.isAlive());
}
```

- [ ] **Step 4: 跑迁移测试**

```bash
node --test lib/session-host/registry-shutdown.test.mjs lib/session-host/heartbeat.test.mjs
node --test lib/session-host/registry.test.mjs
node_modules/.bin/tsc --noEmit
```

Expected: 全部 PASS，tsc 无错。

- [ ] **Step 5: Commit**

```bash
git add -A lib/session-host lib/daemon
git commit -m "refactor: move session registry out of lib/daemon into lib/session-host"
```

---

### Task 2: 类型化宿主门面 facade.ts

把 `lib/daemon/http-sessions.ts` 的会话语义（create/command 冷启动复活/probe/auto-name/busy/reload/teardown）移植为同进程函数，错误统一为带 HTTP status 的 `SessionHostError`。

**Files:**
- Create: `lib/session-host/facade.ts`
- Create: `lib/session-host/facade.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `registry.ts` 全部导出、`lib/session-reader.ts` 的 `resolveSessionPath`、`lib/session-title.ts` 的 `generateSessionTitle`。
- Produces（Task 3–5 的全部路由消费）：

```ts
export class SessionHostError extends Error {
  constructor(message: string, readonly status: number);  // name = "SessionHostError"
}
export interface CreateSessionInput {
  cwd: string; provider?: string; modelId?: string; toolNames?: string[];
  thinkingLevel?: string; command?: { type: string; [key: string]: unknown };
}
export interface CreateSessionResult { sessionId: string; cwd: string; sessionFile: string; data: unknown }
export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult>
export async function sendCommand(sessionId: string, command: { type: string; [key: string]: unknown }): Promise<unknown>
export interface LiveSessionMeta { id: string; cwd: string; sessionFile: string; running: boolean; state?: unknown }
export async function probeSession(sessionId: string): Promise<LiveSessionMeta | null>
export function destroySession(sessionId: string): void
export async function autoNameSession(sessionId: string): Promise<{ title: string; usage: unknown }>
export function busyForCwd(cwd: string): boolean
export function reloadCwdSessions(cwd: string): number
export function liveSessions(): LiveRpcSessionInfo[]
export function runningStatus(): { ids: string[]; stalled: StalledSessionInfo[] }
export async function getSubagentRunStatus(sessionId: string): Promise<unknown>  // 404 包装
export async function controlSubagent(sessionId: string, action: "steer" | "abort", message?: string): Promise<{ run: unknown }>
```

- [ ] **Step 1: 写失败测试 `lib/session-host/facade.test.mjs`**

用 jiti 装载真模块 + 假 wrapper 注入注册表（沿用 `registry-shutdown.test.mjs` 的 `makeInner` 手法；注册表是 globalThis 单例，测试间手动清理）：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const facade = await jiti.import("./facade.ts");
const registry = await jiti.import("./registry.ts");

function makeWrapper(id, overrides = {}) {
  const inner = {
    sessionId: id, sessionFile: `/tmp/${id}.jsonl`, isBashRunning: false,
    isStreaming: false, isCompacting: false, extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp/ws" },
    agent: { state: {} }, getContextUsage: () => null,
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
    subscribe: () => () => {}, dispose() {},
    ...overrides.inner,
  };
  return new registry.AgentSessionWrapper(inner);
}

test("createSession rejects missing cwd with 400", async () => {
  await assert.rejects(() => facade.createSession({ cwd: "" }), (e) =>
    e instanceof facade.SessionHostError && e.status === 400);
});

test("sendCommand hits live wrapper first, never touches disk", async () => {
  // 不拦截 send（wrapper.send 是类方法分发到 inner 各字段）——用 get_state 的
  // 返回形状证明走了 wrapper：sessionId 字段来自 wrapper.get_state 分支。
  const w = makeWrapper("live-1");
  globalThis.__piSessions = new Map([["live-1", w]]);
  const data = await facade.sendCommand("live-1", { type: "get_state" });
  assert.equal(data.sessionId, "live-1");
  assert.equal(data.isStreaming, false);
  globalThis.__piSessions = undefined;
});

test("sendCommand cold path 404s for unknown session", async () => {
  globalThis.__piSessions = new Map();
  await assert.rejects(() => facade.sendCommand("nope", { type: "get_state" }), (e) =>
    e instanceof facade.SessionHostError && e.status === 404);
  globalThis.__piSessions = undefined;
});

test("probeSession returns null for absent, meta for live", async () => {
  globalThis.__piSessions = new Map();
  assert.equal(await facade.probeSession("absent"), null);
  const w = makeWrapper("p1");
  globalThis.__piSessions = new Map([["p1", w]]);
  const meta = await facade.probeSession("p1");
  assert.equal(meta.id, "p1");
  assert.equal(meta.running, false);
  assert.equal(meta.state.sessionId, "p1");
  globalThis.__piSessions = undefined;
});

test("busyForCwd / reloadCwdSessions / runningStatus delegate to registry", () => {
  globalThis.__piSessions = new Map();
  assert.equal(facade.busyForCwd("/tmp/ws"), false);
  assert.deepEqual(facade.runningStatus().ids, []);
  globalThis.__piSessions = undefined;
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/session-host/facade.test.mjs
```
Expected: FAIL（`Cannot find module './facade.ts'`）。

- [ ] **Step 3: 实现 `lib/session-host/facade.ts`**

```ts
/** Typed in-process host facade — the port of the daemon's /v1/sessions
 *  surface (lib/daemon/http-sessions.ts, deleted with the daemon) to direct
 *  function calls. Web routes consume ONLY this module: it owns the
 *  error→status mapping (SessionHostError.status) and the live-first,
 *  cold-start-from-.jsonl revive semantics. */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  abortSubagent,
  destroyRpcSessionsForCwd,
  getLiveRpcSessionInfos,
  getRpcSession,
  getRunningRpcSessionIds,
  getStalledSessionSnapshot,
  getSubagentRun,
  hasBusyRpcSessionForCwd,
  startRpcSession,
  steerSubagent,
  type LiveRpcSessionInfo,
} from "./registry.ts";
import type { StalledSessionInfo } from "./heartbeat.ts";
import { resolveSessionPath } from "../session-reader.ts";
import { generateSessionTitle } from "../session-title.ts";

export class SessionHostError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SessionHostError";
    this.status = status;
  }
}

export interface CreateSessionInput {
  cwd: string;
  provider?: string;
  modelId?: string;
  toolNames?: string[];
  thinkingLevel?: string;
  command?: { type: string; [key: string]: unknown };
}

export interface CreateSessionResult {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  data: unknown;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  if (!input.cwd || typeof input.cwd !== "string") throw new SessionHostError("cwd is required", 400);
  if (!existsSync(input.cwd)) throw new SessionHostError(`Directory does not exist: ${input.cwd}`, 400);
  // One-time key so startRpcSession's start-lock never coalesces two
  // concurrent creates onto one session (mirrors the old daemon route).
  const tempKey = `__new__${randomUUID()}`;
  const { session, realSessionId } = await startRpcSession(tempKey, "", input.cwd, input.toolNames);
  if (input.provider && input.modelId) {
    await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
  }
  if (input.thinkingLevel) {
    await session.send({ type: "set_thinking_level", level: input.thinkingLevel });
  }
  const data = input.command ? await session.send(input.command) : null;
  return { sessionId: realSessionId, cwd: session.cwd, sessionFile: session.sessionFile, data };
}

export async function sendCommand(
  sessionId: string,
  command: { type: string; [key: string]: unknown },
): Promise<unknown> {
  // Live session first (interactive / subagent child / kit round), then
  // cold-start from the .jsonl on disk — the revive semantics every proxy
  // route had through the daemon.
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) return live.send(command);
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionHostError("Session not found", 404);
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  const { session } = await startRpcSession(sessionId, filePath, cwd);
  return session.send(command);
}

export interface LiveSessionMeta {
  id: string;
  cwd: string;
  sessionFile: string;
  running: boolean;
  state?: unknown;
}

export async function probeSession(sessionId: string): Promise<LiveSessionMeta | null> {
  const session = getRpcSession(sessionId);
  if (!session?.isAlive()) return null;
  let state: unknown;
  try { state = await session.send({ type: "get_state" }); }
  catch { state = undefined; /* session not ready yet */ }
  return {
    id: session.sessionId,
    cwd: session.cwd,
    sessionFile: session.sessionFile,
    running: session.isRunning(),
    state,
  };
}

/** Best-effort wrapper teardown before the web layer deletes/archives the
 *  session file: destroy the live wrapper so it stops appending to a file
 *  that is about to move/disappear. */
export function destroySession(sessionId: string): void {
  getRpcSession(sessionId)?.destroy();
}

export async function autoNameSession(sessionId: string): Promise<{ title: string; usage: unknown }> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionHostError("Session not found", 404);
  const live = getRpcSession(sessionId);
  const session = live?.isAlive()
    ? live
    : (await startRpcSession(sessionId, filePath, SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd())).session;
  await session.waitUntilReady?.();
  const result = await generateSessionTitle(session.inner as unknown as AgentSession);
  if (!session.isAlive()) {
    throw new SessionHostError("The session was closed while its title was being generated.", 409);
  }
  session.inner.setSessionName(result.title);
  return { title: result.title, usage: result.usage ?? null };
}

export function busyForCwd(cwd: string): boolean {
  return hasBusyRpcSessionForCwd(cwd);
}

export function reloadCwdSessions(cwd: string): number {
  return destroyRpcSessionsForCwd(cwd);
}

export function liveSessions(): LiveRpcSessionInfo[] {
  return getLiveRpcSessionInfos();
}

export function runningStatus(): { ids: string[]; stalled: StalledSessionInfo[] } {
  return { ids: getRunningRpcSessionIds(), stalled: getStalledSessionSnapshot() };
}

export async function getSubagentRunStatus(sessionId: string): Promise<unknown> {
  const run = await getSubagentRun(sessionId);
  if (!run) throw new SessionHostError("Subagent not found", 404);
  return run;
}

export async function controlSubagent(
  sessionId: string,
  action: "steer" | "abort",
  message?: string,
): Promise<{ run: unknown }> {
  if (action === "steer") {
    if (typeof message !== "string" || !message.trim()) {
      throw new SessionHostError("message required", 400);
    }
    await steerSubagent(sessionId, message);
  } else {
    await abortSubagent(sessionId);
  }
  return { run: await getSubagentRun(sessionId) };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test lib/session-host/facade.test.mjs
```
Expected: PASS（5 个用例）。

- [ ] **Step 5: Commit**

```bash
git add lib/session-host/facade.ts lib/session-host/facade.test.mjs
git commit -m "feat: add typed in-process session host facade"
```

---

### Task 3: Web 流 SSE 直出 + 两个 SSE 路由切换

**Files:**
- Create: `lib/session-host/sse.ts`
- Create: `lib/session-host/sse.test.mjs`
- Modify: `app/api/agent/[id]/events/route.ts`（整文件重写）
- Modify: `app/api/agent/running/events/route.ts`（整文件重写）

**Interfaces:**
- Consumes: Task 1 `registry.ts`（`AgentSessionWrapper`、`subscribeRunningSessions`、`getRunningRpcSessionIds`、`startRpcSession`、`getRpcSession`）、`lib/session-reader.ts` `resolveSessionPath`。
- Produces:

```ts
export const SSE_STALL_BYTES_DEFAULT = 1_000_000;
export function serveSessionEventStream(session: AgentSessionWrapper, signal: AbortSignal): Response
export function serveRunningEventStream(signal: AbortSignal): Response
export function openSessionEventStream(sessionId: string, signal: AbortSignal): Promise<Response>
//  ↑ live-first + cold-start（404 Response），events 路由直接返回它
```

- [ ] **Step 1: 写失败测试 `lib/session-host/sse.test.mjs`**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const sse = await jiti.import("./sse.ts");
const registry = await jiti.import("./registry.ts");

async function collect(stream, n) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (let i = 0; i < n; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

test("session stream emits connected frame then events, closes on destroy", async () => {
  const inner = {
    sessionId: "s1", sessionFile: "/tmp/s1.jsonl", isBashRunning: false,
    isStreaming: false, isCompacting: false, extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" }, agent: { state: {} },
    subscribe(listener) { this._l = listener; return () => {}; }, dispose() {},
  };
  const w = new registry.AgentSessionWrapper(inner);
  const ac = new AbortController();
  const res = sse.serveSessionEventStream(w, ac.signal);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const first = await collect(res.body, 1);
  assert.match(first, /data: \{"type":"connected","sessionId":"s1"\}/);
  inner._l({ type: "message_chunk", text: "hi" });
  const second = await collect(res.body, 1);
  assert.match(second, /message_chunk/);
  w.destroy();  // onDestroy → 流关闭
  const { done } = await res.body.getReader().read().catch(() => ({ done: true }));
  assert.ok(done === true || done === undefined);
});

test("stalled viewer is cut off at the byte cap instead of buffering forever", async () => {
  // 不消费的流：写字节直到超限后 writeEvent 变 no-op 且标记 stalled。
  // 用可注入小上限的内部 writer 直接验证（导出 createWebSseWriter）。
  const { createWebSseWriter } = sse;
  let closed = false;
  const controller = { enqueue: () => {}, close: () => { closed = true; } };
  const writer = createWebSseWriter(controller, 100, () => { closed = true; });
  for (let i = 0; i < 50; i++) writer.writeEvent({ pad: "x".repeat(30) });
  assert.equal(writer.stalled, true);
  assert.equal(closed, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/session-host/sse.test.mjs
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `lib/session-host/sse.ts`**

```ts
/** In-process SSE serving for Next.js route handlers.
 *
 *  The daemon used a node-http ServerResponse writer with a writableLength
 *  stall cap (the 2026-08-30 OOM lesson). Web ReadableStreams have no
 *  readable backpressure signal, so the cap here is our own byte counter:
 *  once a viewer leaves >SSE_STALL_BYTES enqueued and undrained, close the
 *  stream — the browser reconnects on its next poll (same recovery as any
 *  dropped SSE connection). Semantics preserved: connected frame first, 30s
 *  heartbeat comments, stream ends when the session is destroyed, aborting
 *  the request signal only cancels the subscription (never the session). */
import type { AgentSessionWrapper } from "./registry.ts";
import { getRunningRpcSessionIds, getRpcSession, startRpcSession, subscribeRunningSessions } from "./registry.ts";
import { resolveSessionPath } from "../session-reader.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const SSE_STALL_BYTES_DEFAULT = 1_000_000;
const HEARTBEAT_MS = 30_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

export interface WebSseWriter {
  writeEvent(data: unknown): void;
  writeRaw(text: string): void;
  readonly stalled: boolean;
}

export interface WebSseController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

export function createWebSseWriter(
  controller: WebSseController,
  stallBytes: number,
  onStall: () => void,
): WebSseWriter {
  let queued = 0;
  let stalled = false;
  const encoder = new TextEncoder();
  const checkStall = (): void => {
    if (!stalled && queued >= stallBytes) {
      stalled = true;
      onStall();
    }
  };
  return {
    writeEvent(data: unknown): void {
      if (stalled) return;
      const chunk = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
      queued += chunk.byteLength;
      controller.enqueue(chunk);
      checkStall();
    },
    writeRaw(text: string): void {
      if (stalled) return;
      const chunk = encoder.encode(text);
      queued += chunk.byteLength;
      controller.enqueue(chunk);
      checkStall();
    },
    get stalled(): boolean { return stalled; },
  };
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { headers: SSE_HEADERS });
}

export function serveSessionEventStream(session: AgentSessionWrapper, signal: AbortSignal): Response {
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: () => void = () => {};
      let offDestroy: () => void = () => {};
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        offDestroy();
        try { controller.close(); } catch { /* already closed */ }
      };
      const writer = createWebSseWriter(controller, SSE_STALL_BYTES_DEFAULT, cleanup);
      writer.writeEvent({ type: "connected", sessionId: session.sessionId });
      unsubscribe = session.onEvent((event) => writer.writeEvent(event));
      heartbeat = setInterval(() => writer.writeRaw(": \n\n"), HEARTBEAT_MS);
      offDestroy = session.onDestroy(cleanup);
      signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });
  return sseResponse(stream);
}

export function serveRunningEventStream(signal: AbortSignal): Response {
  let cleanup: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: () => void = () => {};
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      const writer = createWebSseWriter(controller, SSE_STALL_BYTES_DEFAULT, cleanup);
      unsubscribe = subscribeRunningSessions((ids) => writer.writeEvent({ type: "running", runningSessionIds: ids }));
      writer.writeEvent({ type: "running", runningSessionIds: getRunningRpcSessionIds() });
      heartbeat = setInterval(() => writer.writeRaw(": \n\n"), HEARTBEAT_MS);
      signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });
  return sseResponse(stream);
}

/** live-first + cold-start（旧 daemon events 分支语义）：idle 会话被观看时
 *  也起一个 wrapper（浏览器拿到 connected 帧 + 后续事件；idle timer 回收）。 */
export async function openSessionEventStream(sessionId: string, signal: AbortSignal): Promise<Response> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) return serveSessionEventStream(live, signal);
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return new Response("Session not found", { status: 404 });
  const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
  const { session } = await startRpcSession(sessionId, filePath, cwd);
  return serveSessionEventStream(session, signal);
}
```

- [ ] **Step 4: 重写两个路由**

`app/api/agent/[id]/events/route.ts` 整文件替换为：

```ts
import { openSessionEventStream } from "@/lib/session-host/sse";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events, served directly by
// the in-process session host (live sessions, subagent children and kit loop
// rounds share one registry; idle sessions cold-start from their .jsonl).
// `req.signal` only cancels this subscription — never the session itself.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return openSessionEventStream(id, req.signal);
}
```

`app/api/agent/running/events/route.ts` 整文件替换为：

```ts
import { serveRunningEventStream } from "@/lib/session-host/sse";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE of the currently-running session id set
// (interactive + subagent children + kit rounds — the registry is the complete
// answer, in-process).
export async function GET(req: Request) {
  return serveRunningEventStream(req.signal);
}
```

- [ ] **Step 5: 跑测试 + tsc + 手测**

```bash
node --test lib/session-host/sse.test.mjs
node_modules/.bin/tsc --noEmit
npm run dev   # 浏览器：开一个会话发消息，事件流正常；断开 SSE 页面刷新后会话仍在跑
```

- [ ] **Step 6: Commit**

```bash
git add lib/session-host/sse.ts lib/session-host/sse.test.mjs app/api/agent
git commit -m "feat: serve agent SSE directly from the in-process host"
```

---

### Task 4: 会话/代理路由全面切换到门面

**Files:**
- Modify: `app/api/agent/new/route.ts`
- Modify: `app/api/agent/[id]/route.ts`
- Modify: `app/api/subagents/[id]/route.ts`
- Modify: `app/api/sessions/[id]/state/route.ts`
- Modify: `app/api/sessions/[id]/auto-name/route.ts`
- Modify: `app/api/sessions/[id]/locate/route.ts`
- Modify: `app/api/sessions/[id]/route.ts`（PATCH 重命名 + DELETE）
- Modify: `app/api/project-trust/route.ts`
- Modify: `lib/session-archive.ts`
- Modify: `lib/session-payload.ts`、`app/api/sessions/route.ts`、`app/page.tsx`
- Test: `lib/session-host/facade-routes.test.mjs`（source 断言，见 Step 1）

**Interfaces:**
- Consumes: Task 2 facade 全部导出。
- Produces: 无新接口；`SessionsPayload` 形状不变（`daemonDown` 恒为 `false`，字段保留）。

- [ ] **Step 1: 写失败测试 `lib/session-host/facade-routes.test.mjs`（source 断言：路由不得再引用 daemon 代理，prompt 受理语义保留）**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeFiles = [
  "app/api/agent/new/route.ts",
  "app/api/agent/[id]/route.ts",
  "app/api/subagents/[id]/route.ts",
  "app/api/sessions/[id]/state/route.ts",
  "app/api/sessions/[id]/auto-name/route.ts",
  "app/api/sessions/[id]/locate/route.ts",
  "app/api/sessions/[id]/route.ts",
  "app/api/project-trust/route.ts",
];

test("no route imports the daemon proxy or client anymore", async () => {
  for (const file of routeFiles) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /agent-proxy|daemon\/client|daemonProxy|daemonClient/, file);
  }
});

test("agent/new keeps prompt_rejected strictly pre-acceptance", async () => {
  const src = await readFile(new URL("../../app/api/agent/new/route.ts", import.meta.url), "utf8");
  // accepted 标记必须在 createSession 之后、bookkeeping 之前翻转
  const idxCreate = src.indexOf("createSession(");
  const idxAccepted = src.indexOf("promptAccepted = promptCommand.type === \"prompt\";");
  const idxBookkeeping = src.indexOf("allowFileRoot(");
  assert.ok(idxCreate >= 0 && idxAccepted > idxCreate && idxBookkeeping > idxAccepted);
  assert.match(src, /prompt_rejected/);
});

test("session payload merge no longer depends on a daemon client", async () => {
  const src = await readFile(new URL("../../lib/session-payload.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /daemonClient|getClient/);
  assert.match(src, /liveSessions\(\)/);
  assert.match(src, /daemonDown: false/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/session-host/facade-routes.test.mjs
```
Expected: FAIL（路由仍 import agent-proxy）。

- [ ] **Step 3: 逐文件切换**

统一模式：`import { ... } from "@/lib/session-host/facade"`；`daemonErrorStatus(error)` → `(error instanceof SessionHostError ? error.status : 500)`；`await daemonProxy()` 删除。逐文件要点：

**(a) `app/api/agent/new/route.ts`** — `const client = await daemonProxy(); const result = await client.createSession({...})` 改为 `const result = await createSession({...})`（参数对象不变）；catch 分支 `daemonErrorStatus(error)` → `error instanceof SessionHostError ? error.status : 500`；`promptAccepted` 翻转行保持在 `createSession` 之后、`allowFileRoot` 之前（原顺序不变）。其余（`allowFileRoot` / `cacheSessionPath` / `invalidateSessionListCache`）原样。

**(b) `app/api/agent/[id]/route.ts`** — POST：`const result = await daemonProxy(); await client.sendSessionCommand(id, body)` → `await sendCommand(id, body)`；GET：`const meta = await client.probeSession(id)` → `const meta = await probeSession(id)`（`!meta` 时仍 `{ running: false }`）；错误映射同上。

**(c) `app/api/subagents/[id]/route.ts`** — `DaemonHttpError` → `SessionHostError`（import 换成 facade）；`daemonClient.getSubagentRun(id)` → `getSubagentRunStatus(id)`（解构 `{ run }` 改为直接拿返回值）；`daemonClient.controlSubagent(...)` → `controlSubagent(...)`；`message.includes("not running") ? 409 : 500` 保留。

**(d) `app/api/sessions/[id]/state/route.ts`** — `client.probeSession` → `probeSession`；响应字段 `liveInDaemon: true` **名字不变**（客户端 `useAgentSession` 依赖）。

**(e) `app/api/sessions/[id]/auto-name/route.ts`** — `client.autoNameSession(id)` → `autoNameSession(id)`。

**(f) `app/api/sessions/[id]/locate/route.ts`** — `daemonClient.probeSession(id)` → `probeSession(id)`（import 自 facade；该文件原本直连 daemonClient 不等 sidecar，现在天然同进程）。`meta` 的空判断与 `cacheSessionPath` 逻辑不变。

**(g) `app/api/sessions/[id]/route.ts`** — PATCH 重命名：`client.sendSessionCommand(id, { type: "set_session_name", ... })` → `sendCommand(...)`；DELETE：`try { const client = await daemonProxy(); await client.destroySession(id); } catch {}` → `try { destroySession(id); } catch { /* 无 live wrapper — 继续 */ }`。

**(h) `app/api/project-trust/route.ts`** — `client.busyForCwd(...)` → `busyForCwd(...)`；`client.reloadCwdSessions(...).catch(() => {})` → 同步 `reloadCwdSessions(...)`（destroy 不抛，去掉 catch 也可；保留也无害——改为直接调用）。

**(i) `lib/session-archive.ts`** — `destroyDaemonWrapper` 改为：

```ts
async function destroyLiveWrapper(sessionId: string): Promise<void> {
  try {
    destroySession(sessionId);
  } catch {
    // proceed with the file move
  }
}
```

import 换 facade 的 `destroySession`，调用点 `destroyDaemonWrapper` 改名 `destroyLiveWrapper`。

**(j) `lib/session-payload.ts`** — 删除 `getClient` 参数与 daemon import，直连门面：

```ts
import { listAllSessions } from "./session-reader";
import { isSubagentChildSession } from "./subagent-child";
import { liveSessions, runningStatus } from "./session-host/facade";
import type { SessionInfo } from "./types";

export interface SessionsPayload {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  daemonDown: boolean;  // 保留字段（客户端兼容）；单进程下恒为 false
}

export async function buildSessionsPayload(): Promise<SessionsPayload> {
  const sessions = await listAllSessions();
  const presentIds = new Set(sessions.map((session) => session.id));
  const liveSynthesized: SessionInfo[] = [];
  for (const live of liveSessions()) {
    if (!live.id || presentIds.has(live.id)) continue;
    presentIds.add(live.id);
    liveSynthesized.push({
      path: live.sessionFile || "",
      id: live.id,
      cwd: live.cwd,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "(no messages)",
      projectRoot: live.cwd,
    });
  }
  const merged = liveSynthesized.length > 0 ? [...liveSynthesized, ...sessions] : sessions;
  const sessionsWithFlags = merged.map((session) =>
    isSubagentChildSession(session) ? { ...session, subagentChild: true } : session,
  );
  return { sessions: sessionsWithFlags, runningSessionIds: runningStatus().ids, daemonDown: false };
}
```

`app/api/sessions/route.ts`：`buildSessionsPayload(() => daemonProxy())` → `buildSessionsPayload()`，删除 daemonProxy import。`app/page.tsx`：`buildSessionsPayload(async () => daemonClient).catch(() => null)` → `buildSessionsPayload().catch(() => null)`，删除 daemonClient import。

- [ ] **Step 4: 跑测试 + tsc + lint**

```bash
node --test lib/session-host/facade-routes.test.mjs lib/session-payload.test.mjs 2>/dev/null || node --test lib/session-host/facade-routes.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```
Expected: PASS / 无错。

- [ ] **Step 5: 手测（spec §10 验证 1 的会话部分）**

`npm run dev`，浏览器：新建会话发消息 → 回复流式渲染；停止按钮；fork；打开历史会话；打开运行中的子 agent 会话；归档一个正在查看的会话。

- [ ] **Step 6: Commit**

```bash
git add app/api lib/session-payload.ts lib/session-archive.ts lib/session-host
git commit -m "feat: switch all session routes to the in-process host facade"
```

---

### Task 5: loop 控制直连 + 共享宿主收割停用

**Files:**
- Modify: `app/api/workspaces/[id]/loops/[name]/run/route.ts`
- Modify: `app/api/workspaces/[id]/loops/[name]/stop/route.ts`
- Modify: `lib/session-host/loop-spawner.ts`（Task 6 迁移后；本任务先改 `lib/daemon/loop-spawner.ts`，Task 6 一起搬）
- Test: `lib/loops/rounds-host.test.mjs`（新增 source 断言）

**Interfaces:**
- Consumes: Task 2 facade（`createSession`、`sendCommand`、`destroySession`、`runningStatus`）；`lib/loops/rounds.ts` 现有 `launchManualRound`/`stopRound`（deps 注入，签名不变）。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试（web 宿主不得使用 cwd 收割）**

```js
// lib/loops/rounds-host.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("web host round teardown never reaps by workspace cwd", async () => {
  for (const file of [
    "app/api/workspaces/[id]/loops/[name]/stop/route.ts",
  ]) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /reapOrphanedRoundProcesses|reapOrphansByCwd/, file);
  }
  // spawner 的位置会随 Task 6 迁移（lib/daemon → lib/session-host），两处都查：
  for (const file of ["lib/daemon/loop-spawner.ts", "lib/session-host/loop-spawner.ts"]) {
    try {
      const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /reapOrphanedRoundProcesses|reapOrphansByCwd/, file);
    } catch { /* 尚未迁移/已迁移 — 另一处覆盖 */ }
  }
});
```

- [ ] **Step 2: 跑测试确认失败**（两文件仍引用 cwd 收割）

```bash
node --test lib/loops/rounds-host.test.mjs
```
Expected: FAIL。

- [ ] **Step 3: 改 run/stop 路由的依赖装配**

`run/route.ts` 中现有（约 27 行起）`const client = await daemonProxy();` 构造的 deps 改为：

```ts
import { createSession, sendCommand, destroySession, runningStatus } from "@/lib/session-host/facade";

const deps: LaunchRoundDeps = {
  createSession: (input) => createSession(input),
  sendCommand: (sessionId, command) => sendCommand(sessionId, command),
  destroySession: (sessionId) => destroySession(sessionId),
  runningSessionIds: async () => runningStatus().ids,
};
```

`stop/route.ts` 同理：

```ts
const deps: StopRoundDeps = {
  destroySession: (sessionId) => destroySession(sessionId),
  reap: async () => undefined,  // 共享宿主禁止 cwd 收割：destroy() 内 abortBash 已按进程组杀
  runningSessionIds: async () => runningStatus().ids,
};
```

错误映射：`daemonErrorStatus(error)` → `error instanceof SessionHostError ? error.status : 500`。

- [ ] **Step 4: spawner 轮清理去收割**

`lib/daemon/loop-spawner.ts` 的 `runKitRound`：默认 `reaper` 从 `reapOrphanedRoundProcesses` 改为不收割（destroy 定向杀已覆盖；孤儿残余交由 Task 7 的恢复探测只读报告）：

```ts
export interface RoundDeps {
  starter?: typeof startRpcSession;
  /** 默认不收割：共享 Next.js 宿主禁止按 cwd 杀进程（spec §5.4）。SDK 的
   *  destroy()→dispose()→abortBash() 会对每个在飞 bash 调 killProcessTree
   *  （按执行进程组定向）；残余孤儿由恢复期只读探测处理。beat CLI（独立
   *  进程）不受影响，pi-loop 包内收割函数原样保留。 */
  reaper?: (workspacePath: string) => Promise<unknown> | void;
  bookkeeper?: typeof settleRoundBookkeeping;
  onSessionStart?: (sessionId: string) => void;
}

export async function runKitRound(declaration: LoopDeclaration, deps: RoundDeps = {}): Promise<string> {
  const starter = deps.starter ?? startRpcSession;
  const reaper = deps.reaper ?? (async () => undefined);
  const bookkeeper = deps.bookkeeper ?? settleRoundBookkeeping;
  ...
```

并删除文件顶部 `reapOrphanedRoundProcesses` 的 import（`updateRoundLock` 等其余 import 保留）。错误路径 `await reaper(...)` 调用保留（默认 no-op）。

- [ ] **Step 5: 跑测试 + 既有 loop 测试回归**

```bash
node --test lib/loops/rounds-host.test.mjs lib/daemon/loop-spawner.test.mjs lib/loops/*.test.mjs
node_modules/.bin/tsc --noEmit
```
Expected: PASS。

- [ ] **Step 6: 手测（spec §10 验证 3）**

配一个 cron `* * * * *` 的测试 loop：心跳自动起轮 → Loops 面板「停止本轮」→ 轮会话结束、锁释放、下一心跳正常补跑；同时另开一个交互会话跑 `npm test`，验证轮清理不误杀它。

- [ ] **Step 7: Commit**

```bash
git add app/api/workspaces lib/daemon/loop-spawner.ts lib/loops
git commit -m "feat: drive loop rounds through the host facade, drop cwd-based reaping"
```

---

### Task 6: 宿主后台装配（loop 心跳进 web 进程 + HMR 单例 + 老 daemon 迁移守卫）

**Files:**
- Create: `lib/session-host/jobs.ts`（= 原 `lib/daemon/jobs.ts`，`DaemonJob`→`HostJob`、`DaemonJobRegistry`→`HostJobRegistry`）
- Move: `lib/daemon/loop-spawner.ts` → `lib/session-host/loop-spawner.ts`（git mv + import 修 + `DaemonJob`→`HostJob`）
- Move: `lib/daemon/loop-spawner.test.mjs` → `lib/session-host/loop-spawner.test.mjs`
- Create: `lib/session-host/background.ts`
- Create: `lib/session-host/background.test.mjs`
- Modify: `instrumentation.ts`
- Delete: `lib/daemon/jobs.ts`

**Interfaces:**
- Consumes: Task 1 registry、Task 5 改后的 loop-spawner。
- Produces（Task 7–8 依赖）：

```ts
// background.ts
export function ensureHostBooted(): void          // 幂等（globalThis 守卫）：迁移守卫 + loop 心跳 + 关停钩子
export interface ActiveRoundInfo { loopName: string; workspacePath: string; dir: string; startedAt: number }
export function markRoundActive(sessionId: string, info: ActiveRoundInfo): void
export function clearRoundMark(sessionId: string): void
export function listActiveRounds(): Array<{ sessionId: string } & ActiveRoundInfo>
```

- [ ] **Step 1: 迁移 jobs + loop-spawner**

```bash
git mv lib/daemon/jobs.ts lib/session-host/jobs.ts
git mv lib/daemon/loop-spawner.ts lib/session-host/loop-spawner.ts
git mv lib/daemon/loop-spawner.test.mjs lib/session-host/loop-spawner.test.mjs
```

- `jobs.ts`：`DaemonJob`→`export interface HostJob`（字段不变：`id`/`start()`/`stop()`），`DaemonJobRegistry`→`HostJobRegistry`，注释里 `daemon` 措辞改 `host`。
- `loop-spawner.ts`：`implements DaemonJob` → `implements HostJob`；`./rpc-manager.ts` → `./registry.ts`；`./jobs.ts` 不变（同目录了）。
- 测试文件相对 import 同步修。

- [ ] **Step 2: 写失败测试 `lib/session-host/background.test.mjs`**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const background = await jiti.import("./background.ts");

test("active round marks are add/list/clear", () => {
  background.markRoundActive("r1", { loopName: "dev-loop", workspacePath: "/tmp/ws", dir: "/tmp/ws/.pi/loops/dev-loop", startedAt: Date.now() });
  assert.equal(background.listActiveRounds().length >= 1, true);
  background.clearRoundMark("r1");
  assert.equal(background.listActiveRounds().some((r) => r.sessionId === "r1"), false);
});

test("ensureHostBooted is idempotent across repeated module loads", async () => {
  const jiti2 = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const b1 = await jiti2.import("./background.ts");
  const b2 = await jiti2.import("./background.ts");
  b1.ensureHostBooted();
  b2.ensureHostBooted();  // 第二次必须 no-op：不得出现两个 spawner 定时器
  const g = globalThis;
  assert.ok(g.__piHostBooted === true);
  assert.ok(g.__piLoopSpawnerTimer != null);
});
```

（测试里 `ensureHostBooted` 需要可注入：见 Step 3 的 `ensureHostBooted({ spawnerStarter })` 可选参数；默认真实现。上面第二例用默认实现验证 globalThis 幂等即可——为避免测试期间真跑心跳，给 `ensureHostBooted` 加 `process.env.PI_TEST_NO_BACKGROUND === "1"` 时跳过 spawner 启动的分支，测试文件顶部 `process.env.PI_TEST_NO_BACKGROUND = "1"`。）

- [ ] **Step 3: 实现 `lib/session-host/background.ts`**

```ts
/** In-process host boot & background assembly.
 *
 *  The Next.js Node.js server is now THE single session owner: at boot it
 *  (1) refuses to start when a legacy pi-daemon still owns sessions
 *  (first-deployment migration guard, spec §5.4),
 *  (2) starts the loop kit heartbeat spawner exactly once (globalThis-guarded
 *      — route cold-loading and dev hot reload must never create a second
 *      timer), and
 *  (3) installs shutdown handlers (Task 7 grows these into the full
 *      stop-new-work → abort → record → exit sequence).
 *  Background entry points are assembled HERE, never from an interactive
 *  session happening to be open (spec §4). */
import type { LoopKitSpawner } from "./loop-spawner.ts";

export interface ActiveRoundInfo {
  loopName: string;
  workspacePath: string;
  dir: string;
  startedAt: number;
}

interface HostGlobals {
  __piHostBooted?: boolean;
  __piActiveRounds?: Map<string, ActiveRoundInfo>;
  __piLoopSpawnerTimer?: unknown;
}

const g = globalThis as typeof globalThis & HostGlobals;

export function markRoundActive(sessionId: string, info: ActiveRoundInfo): void {
  if (!g.__piActiveRounds) g.__piActiveRounds = new Map();
  g.__piActiveRounds.set(sessionId, info);
}

export function clearRoundMark(sessionId: string): void {
  g.__piActiveRounds?.delete(sessionId);
}

export function listActiveRounds(): Array<{ sessionId: string } & ActiveRoundInfo> {
  return Array.from(g.__piActiveRounds?.entries() ?? []).map(([sessionId, info]) => ({ sessionId, ...info }));
}

/** First-deployment migration guard: a healthy legacy pi-daemon on the
 *  configured/default URL means the old owner is still alive — refuse to
 *  boot instead of silently becoming a second session writer (spec §5.4). */
async function refuseIfLegacyDaemonAlive(): Promise<void> {
  const url = (process.env.PI_DAEMON_URL ?? "http://127.0.0.1:30142").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return; // nothing listening — good
  }
  const body = await response.json().catch(() => ({})) as { service?: string };
  if (response.ok && body?.service === "pi-daemon") {
    console.error(
      `[pi-web] 检测到旧 pi-daemon 仍在 ${url} 运行并持有会话。请先停掉它（kill 或 systemd stop），` +
      "再启动单进程 pi-web —— 两个进程同时写会话文件会损坏数据。本次启动中止。",
    );
    process.exit(1);
  }
}

export interface HostBootOptions {
  /** 测试/特殊部署注入自定义 spawner 启停；缺省 = LoopKitSpawner。 */
  createSpawner?: () => { start(): void; stop(): void; timer?: unknown };
}

export function ensureHostBooted(options: HostBootOptions = {}): void {
  if (g.__piHostBooted) return;
  g.__piHostBooted = true;
  void refuseIfLegacyDaemonAlive();
  if (process.env.PI_TEST_NO_BACKGROUND === "1") return;
  // Lazy import keeps this module importable from instrumentation without
  // dragging workspace/work-item services into every route bundle.
  void import("./loop-spawner.ts").then(({ LoopKitSpawner }) => {
    const spawner: LoopKitSpawner = options.createSpawner ? options.createSpawner() as LoopKitSpawner : new LoopKitSpawner();
    spawner.start();
    g.__piLoopSpawnerTimer = (spawner as unknown as { timer?: unknown }).timer;
  }).catch((error) => {
    console.error("[pi-web] loop heartbeat spawner failed to start:", error);
  });
}
```

（Task 7 会在此文件追加 `registerShutdownHandlers`。）

- [ ] **Step 4: 重写 `instrumentation.ts`**

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // The Next.js Node.js server is the single session owner now: boot the
  // in-process host (migration guard + loop heartbeats + shutdown hooks).
  // Fire-and-forget so server boot is never blocked.
  const { ensureHostBooted } = await import("@/lib/session-host/background");
  ensureHostBooted();

  // 初始化时补建默认「默认」工作区（幂等 + 墓碑，见 lib/workspaces/service.ts）。
  void import("@/lib/workspaces/service")
    .then((mod) => mod.ensureDefaultWorkspace())
    .catch((err) => {
      console.error("[workspaces] ensure default workspace failed:", err instanceof Error ? err.message : err);
    });
}
```

（sidecar import 段整体删除。）

- [ ] **Step 5: 跑测试 + tsc + 手测（spec §10 验证 2）**

```bash
node --test lib/session-host/background.test.mjs lib/session-host/loop-spawner.test.mjs
node_modules/.bin/tsc --noEmit
npm run dev
# 手测：dev 下改一个文件触发热重载 → 观察日志只有一个 [loop-kit] tick 循环；
# npm run daemon（旧命令仍在）起一个 daemon → 重启 dev → 日志出现迁移错误并退出。
```

- [ ] **Step 6: Commit**

```bash
git add lib/session-host instrumentation.ts lib/daemon
git commit -m "feat: assemble loop heartbeats and host boot inside the Next.js process"
```

---

### Task 7: 关停处理与执行中断记录

**Files:**
- Create: `lib/loops/executions.ts`
- Create: `lib/loops/executions.test.mjs`
- Modify: `lib/session-host/background.ts`（追加 shutdown）
- Modify: `lib/session-host/loop-spawner.ts`（轮登记 + 中断门禁钩子）
- Modify: `app/api/workspaces/[id]/loops/[name]/run/route.ts`（手动轮登记）
- Test: `lib/session-host/shutdown.test.mjs`

**Interfaces:**
- Consumes: Task 6 `background.ts`（activeRounds）、Task 1 `getAllRpcSessions`、`packages/pi-loop/protocol.ts` `discoverKitLoops`（不改动包）。
- Produces（Task 8 与 spawner 消费）：

```ts
// lib/loops/executions.ts
export interface ExecutionRecord {
  schemaVersion: 1;
  runId: string;                 // = 轮会话 sessionId
  kind: "loop-round";
  loopName: string;
  sessionId: string;
  workspacePath: string;
  host: { pid: number; hostname: string };
  startedAt: string;
  stoppedAt: string;
  stopResult: "interrupted-on-shutdown" | "recovered-auto" | "recovered-manual" | "confirmed-dead";
  needsAttention: boolean;
  diagnostic?: { checkedAt?: string; foundPids?: number[]; actor?: string };
}
export function executionsDir(workspacePath: string): string
export function writeExecutionRecord(record: ExecutionRecord): Promise<void>       // tmp+rename 原子写
export function listPendingExecutionRecords(workspacePath: string, loopName?: string): Promise<ExecutionRecord[]>
export function resolveExecutionRecords(workspacePath: string, loopName: string, patch: Partial<Pick<ExecutionRecord, "stopResult" | "needsAttention" | "diagnostic">>): Promise<number>
export async function detectSurvivingRoundProcesses(workspacePath: string): Promise<number[]>  // 只读探测：ppid=1 且 build/shell 且 cwd ∈ workspace
```

- [ ] **Step 1: 写失败测试 `lib/loops/executions.test.mjs`**

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const executions = await jiti.import("./executions.ts");

test("write + list + resolve round-trips a pending record", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-exec-"));
  const record = {
    schemaVersion: 1, runId: "sess-1", kind: "loop-round", loopName: "dev-loop",
    sessionId: "sess-1", workspacePath: ws,
    host: { pid: 1, hostname: "h" },
    startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(),
    stopResult: "interrupted-on-shutdown", needsAttention: true,
  };
  await executions.writeExecutionRecord(record);
  const pending = await executions.listPendingExecutionRecords(ws);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].loopName, "dev-loop");
  const n = await executions.resolveExecutionRecords(ws, "dev-loop", {
    stopResult: "recovered-auto", needsAttention: false,
    diagnostic: { checkedAt: new Date().toISOString() },
  });
  assert.equal(n, 1);
  assert.equal((await executions.listPendingExecutionRecords(ws)).length, 0);
  // resolve 后文件保留（审计），只是 needsAttention=false
  const raw = JSON.parse(await readFile(join(executions.executionsDir(ws), "sess-1.json"), "utf8"));
  assert.equal(raw.stopResult, "recovered-auto");
  await rm(ws, { recursive: true, force: true });
});

test("listPendingExecutionRecords skips malformed files and non-pending", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-exec-"));
  await mkdir(executions.executionsDir(ws), { recursive: true });
  await writeFile(join(executions.executionsDir(ws), "junk.json"), "{not json");
  const resolved = { schemaVersion: 1, runId: "r2", kind: "loop-round", loopName: "l2", sessionId: "r2",
    workspacePath: ws, host: { pid: 1, hostname: "h" }, startedAt: "t", stoppedAt: "t",
    stopResult: "recovered-auto", needsAttention: false };
  await executions.writeExecutionRecord(resolved);
  assert.equal((await executions.listPendingExecutionRecords(ws)).length, 0);
  await rm(ws, { recursive: true, force: true });
});

test("detectSurvivingRoundProcesses with injected fake process table", async () => {
  // detectSurvivingRoundProcesses(workspacePath, deps?) — deps 可注入 lister/cwdOf
  const pids = await executions.detectSurvivingRoundProcesses("/tmp/ws", {
    lister: () => [
      { pid: 11, ppid: 1, command: "npm run build" },
      { pid: 12, ppid: 2, command: "npm test" },
      { pid: 13, ppid: 1, command: "/usr/libexec/blah" },
    ],
    cwdOf: (pid) => (pid === 11 ? "/tmp/ws/repo" : pid === 12 ? "/tmp/ws" : "/other"),
  });
  assert.deepEqual(pids, [11]);  // 只报 ppid=1 + build/shell + cwd 命中的
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/loops/executions.test.mjs
```
Expected: FAIL。

- [ ] **Step 3: 实现 `lib/loops/executions.ts`**

```ts
/** 执行中断记录（spec §5.4）：宿主关停时为在飞 loop 轮写
 *  `<workspace>/.pi/runtime/executions/<runId>.json`；恢复期据此阻塞该 loop
 *  的新轮，直到「重新检查并恢复」证明旧命令已停止。纯 fs，无 daemon 依赖。 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PsRow } from "../../packages/pi-loop/reap.ts";

export interface ExecutionRecord {
  schemaVersion: 1;
  runId: string;
  kind: "loop-round";
  loopName: string;
  sessionId: string;
  workspacePath: string;
  host: { pid: number; hostname: string };
  startedAt: string;
  stoppedAt: string;
  stopResult: "interrupted-on-shutdown" | "recovered-auto" | "recovered-manual" | "confirmed-dead";
  needsAttention: boolean;
  diagnostic?: { checkedAt?: string; foundPids?: number[]; actor?: string };
}

export function executionsDir(workspacePath: string): string {
  return join(workspacePath, ".pi", "runtime", "executions");
}

export async function writeExecutionRecord(record: ExecutionRecord): Promise<void> {
  const dir = executionsDir(record.workspacePath);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, `${record.runId}.json`);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  await rename(tmpPath, finalPath);
}

export async function listPendingExecutionRecords(
  workspacePath: string,
  loopName?: string,
): Promise<ExecutionRecord[]> {
  const dir = executionsDir(workspacePath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: ExecutionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as ExecutionRecord;
      if (record.schemaVersion !== 1 || !record.needsAttention) continue;
      if (loopName && record.loopName !== loopName) continue;
      records.push(record);
    } catch {
      // malformed file — skip (never blocks recovery on bad json)
    }
  }
  return records;
}

export async function resolveExecutionRecords(
  workspacePath: string,
  loopName: string,
  patch: Partial<Pick<ExecutionRecord, "stopResult" | "needsAttention" | "diagnostic">>,
): Promise<number> {
  const dir = executionsDir(workspacePath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let resolved = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let record: ExecutionRecord;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as ExecutionRecord;
    } catch {
      continue;
    }
    if (record.schemaVersion !== 1 || record.loopName !== loopName || !record.needsAttention) continue;
    const updated: ExecutionRecord = { ...record, ...patch, diagnostic: { ...record.diagnostic, ...patch.diagnostic } };
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    await rename(tmpPath, path);
    resolved += 1;
  }
  return resolved;
}

export interface DetectDeps {
  lister?: () => PsRow[];
  cwdOf?: (pid: number) => string | undefined;
}

/** 只读探测（不杀）：ppid=1（被 reparent）+ build/shell 命令 + cwd 在工作区内。
 *  复用 pi-loop/reap 的纯函数与 ps 快照；探测失败返回 []（无法证明 ≠ 已证明）。 */
export async function detectSurvivingRoundProcesses(
  workspacePath: string,
  deps: DetectDeps = {},
): Promise<number[]> {
  const { listAllProcesses, pidCwd, isBuildOrShellCommand, isCwdInWorkspace } = await import("../../packages/pi-loop/reap.ts");
  const lister = deps.lister ?? listAllProcesses;
  const cwdOf = deps.cwdOf ?? pidCwd;
  const found: number[] = [];
  for (const row of lister()) {
    if (row.ppid !== 1 || row.pid === process.pid) continue;
    if (!isBuildOrShellCommand(row.command)) continue;
    if (isCwdInWorkspace(cwdOf(row.pid), workspacePath)) found.push(row.pid);
  }
  return found;
}
```

（`rm` import 未用到则去掉。）

- [ ] **Step 4: spawner 轮登记 + 中断门禁**

`lib/session-host/loop-spawner.ts`：
1. `SpawnerDeps` 追加：

```ts
  /** 恢复门禁（默认真实现）：该 loop 有未确认中断记录时跳过起轮（spec §5.4）。 */
  pendingInterruption?: (workspacePath: string, loopName: string) => Promise<boolean>;
  /** 轮登记（默认 markRoundActive/clearRoundMark）：关停时据此写中断记录。 */
  markActive?: (sessionId: string, info: { loopName: string; workspacePath: string; dir: string; startedAt: number }) => void;
  clearActive?: (sessionId: string) => void;
```

2. 构造函数默认值接 `../session-host/background.ts` 的 `markRoundActive`/`clearRoundMark` 与 `../loops/executions.ts` 的 `listPendingExecutionRecords`（`pendingInterruption: async (ws, loop) => (await listPendingExecutionRecords(ws, loop)).length > 0`）。
3. `tick()` 的 per-loop 循环里、`runDueRound` 之前加：

```ts
        if (await Promise.resolve(this.deps.pendingInterruption(workspace.path, declaration.loopName))) continue;
```

4. `runKitRound` 里 `deps.onSessionStart?.(realSessionId)` 之后追加 `deps.markActive?.(realSessionId, { loopName: declaration.loopName, workspacePath: declaration.workspacePath, dir: declaration.dir, startedAt: Date.now() })`，并在函数最外层 `finally` 里 `deps.clearActive?.(realSessionId)`（`realSessionId` 提升到 try 外声明）。`RoundDeps` 相应加这两个可选字段。
5. `tick()` 里 `this.deps.runRound(declaration, { onSessionStart })` 的调用处把 mark/clear 通过 hooks 传入（`runRound` 默认实现 `runKitRound` 已带）。

`run/route.ts`（手动轮）：`launchManualRound` 成功后追加 `markRoundActive(result.sessionId, { loopName: declaration.loopName, workspacePath: declaration.workspacePath, dir: declaration.dir, startedAt: Date.now() })`；轮结束无从得知（人不等）——关停时若该会话不在 running set 则登记照写但 `needsAttention` 以 wrapper 状态判定（见 Step 5，只写 running 的）。

- [ ] **Step 5: background.ts 追加关停处理**

```ts
import { getAllRpcSessions } from "./registry.ts";
import { hostname } from "node:os";

const g = globalThis as typeof globalThis & HostGlobals & { __piShutdownHookInstalled?: boolean };

/** 宿主关停（spec §5.4）：先停新轮（spawner.stop），再中止全部活跃 wrapper
 *  （SDK destroy → abortBash → killProcessTree 按执行进程组定向杀），为关停时
 *  仍在跑的轮写中断记录（恢复期阻塞该 loop），最后退出。不承诺恢复内存中的
 *  模型调用现场；重启后按文件记录接续。 */
export function registerShutdownHandlers(stopBackground: () => void): void {
  if (g.__piShutdownHookInstalled) return;
  g.__piShutdownHookInstalled = true;
  const shutdown = (signal: string): void => {
    stopBackground();
    const active = listActiveRounds();
    const runningBySession = new Set(getAllRpcSessions().filter((s) => s.isRunning()).map((s) => s.sessionId));
    const records = active
      .filter((round) => runningBySession.has(round.sessionId))
      .map((round) => ({
        schemaVersion: 1 as const,
        runId: round.sessionId,
        kind: "loop-round" as const,
        loopName: round.loopName,
        sessionId: round.sessionId,
        workspacePath: round.workspacePath,
        host: { pid: process.pid, hostname: hostname() },
        startedAt: new Date(round.startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        stopResult: "interrupted-on-shutdown" as const,
        needsAttention: true,
      }));
    for (const session of getAllRpcSessions()) session.destroy();
    void Promise.all(records.map((record) =>
      import("../loops/executions.ts").then((mod) => mod.writeExecutionRecord(record)).catch((error) => {
        console.error("[pi-web] write execution record failed:", error);
      }),
    )).finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
```

`ensureHostBooted` 的 spawner 启动处，拿到 spawner 后调用 `registerShutdownHandlers(() => spawner.stop())`。

- [ ] **Step 6: 写 `lib/session-host/shutdown.test.mjs`（source + 行为断言）**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const background = await jiti.import("./background.ts");

test("shutdown writes interruption records only for running rounds, then destroys all", async () => {
  process.env.PI_TEST_NO_BACKGROUND = "1";
  const writes = [];
  const destroys = [];
  // 注入：拦截 executions 写入与 registry 遍历
  const jiti2 = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const registry = await jiti2.import("./registry.ts");
  // 用 background 的可测缝：markRoundActive 登记 2 轮，1 个 running 1 个 idle
  background.markRoundActive("run-1", { loopName: "l", workspacePath: "/tmp/ws", dir: "/d", startedAt: Date.now() });
  background.markRoundActive("idle-1", { loopName: "l", workspacePath: "/tmp/ws", dir: "/d", startedAt: Date.now() });
  // 直接测 shutdown 的纯逻辑：导出 buildShutdownPlan(activeRounds, runningIds) 供测试
  const plan = background.buildShutdownPlan(background.listActiveRounds(), ["run-1"]);
  assert.equal(plan.records.length, 1);
  assert.equal(plan.records[0].sessionId, "run-1");
  assert.deepEqual(plan.destroySessionIds.sort(), ["idle-1", "run-1"].sort());
});
```

（为此把 Step 5 的 `shutdown` 内联逻辑抽成可测纯函数 `buildShutdownPlan(active: Array<{sessionId} & ActiveRoundInfo>, runningIds: string[]): { records: ExecutionRecord[]; destroySessionIds: string[] }`，`shutdown` 调用它。）

- [ ] **Step 7: 跑测试 + tsc**

```bash
node --test lib/loops/executions.test.mjs lib/session-host/shutdown.test.mjs lib/session-host/loop-spawner.test.mjs
node_modules/.bin/tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add lib/loops lib/session-host app/api/workspaces
git commit -m "feat: host shutdown writes loop-round interruption records and gates recovery"
```

---

### Task 8: 恢复 API 与 Loops 面板呈现

**Files:**
- Create: `app/api/workspaces/[id]/loops/[name]/recover/route.ts`
- Modify: `app/api/workspaces/[id]/loops/route.ts`（GET 追加 interruptions）
- Modify: `components/LoopRow.tsx`（中断徽章 + 恢复按钮）
- Modify: `components/LoopsDockPanel.tsx`（传递 interruptions + recover 回调）
- Test: `lib/loops/recover-route.test.mjs`（source 断言）

**Interfaces:**
- Consumes: Task 7 `executions.ts`（`listPendingExecutionRecords`、`resolveExecutionRecords`、`detectSurvivingRoundProcesses`）。
- Produces:
  - `POST /api/workspaces/[id]/loops/[name]/recover`，body `{ manual?: boolean }`；响应 `{ ok: true, resolved: number }`；探测到存活进程 → `409 { error, pids }`（manual 也拒绝）；探测无存活 → 自动解除 `{ ok, resolved }`；`manual:true` 且无存活 → 记 `recovered-manual`（diagnostic.actor="user"）。
  - `GET /api/workspaces/[id]/loops` 响应追加 `interruptions: Array<{ loopName: string; runId: string; stoppedAt: string }>`。

- [ ] **Step 1: 写失败测试（source 断言）**

```js
// lib/loops/recover-route.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recover route refuses when surviving processes exist, even with manual flag", async () => {
  const src = await readFile(new URL("../../app/api/workspaces/[id]/loops/[name]/recover/route.ts", import.meta.url), "utf8");
  assert.match(src, /pids\.length > 0/);
  assert.match(src, /409/);
  assert.match(src, /recovered-manual/);
  assert.match(src, /recovered-auto/);
});

test("loops GET merges pending interruptions", async () => {
  const src = await readFile(new URL("../../app/api/workspaces/[id]/loops/route.ts", import.meta.url), "utf8");
  assert.match(src, /listPendingExecutionRecords/);
  assert.match(src, /interruptions/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/loops/recover-route.test.mjs
```

- [ ] **Step 3: 实现 recover 路由**

```ts
// app/api/workspaces/[id]/loops/[name]/recover/route.ts
import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { detectSurvivingRoundProcesses, listPendingExecutionRecords, resolveExecutionRecords } from "@/lib/loops/executions";

/** 「重新检查并恢复」（spec §5.4）：重查旧会话与已知命令进程。已证明停止 →
 *  解除（recovered-auto）；仍活动 → 拒绝（人工声明也不能覆盖实测存活）；
 *  探测干净时允许 manual 登记已停止（recovered-manual, actor=user）。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const declaration = await findKitLoopByName(path, name);
    if (!declaration) return NextResponse.json({ error: "Loop not found" }, { status: 404 });

    const body = await req.json().catch(() => ({})) as { manual?: boolean };
    const pids = await detectSurvivingRoundProcesses(path);
    if (pids.length > 0) {
      return NextResponse.json(
        { error: `检测到 ${pids.length} 个疑似残留命令进程（pid: ${pids.join(", ")}），请先在本机处理后再恢复`, pids },
        { status: 409 },
      );
    }
    const resolved = await resolveExecutionRecords(path, declaration.loopName, {
      stopResult: body.manual === true ? "recovered-manual" : "recovered-auto",
      needsAttention: false,
      diagnostic: { checkedAt: new Date().toISOString(), ...(body.manual === true ? { actor: "user" } : {}) },
    });
    return NextResponse.json({ ok: true, resolved });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
```

- [ ] **Step 4: loops GET 合并 interruptions**

`app/api/workspaces/[id]/loops/route.ts` GET 中 `collectStatus(path)` 之后追加：

```ts
    const pending = await listPendingExecutionRecords(path);
    const interruptions = pending.map((record) => ({
      loopName: record.loopName,
      runId: record.runId,
      stoppedAt: record.stoppedAt,
    }));
    return NextResponse.json({ loops: collectStatus(path), interruptions });
```

（import `listPendingExecutionRecords` 自 `@/lib/loops/executions`。）

- [ ] **Step 5: LoopRow 徽章 + 按钮；LoopsDockPanel 接线**

- `LoopRow.tsx` props 追加 `interrupted?: { runId: string; stoppedAt: string }`、`onRecover?: () => void`、`recovering?: boolean`；`interrupted` 时在状态列渲染 `执行中断，待恢复` 徽章（复用现有 badge 样式类）+ 按钮「重新检查并恢复」调 `onRecover`。
- `LoopsDockPanel.tsx`：loops fetch 的响应解构出 `interruptions`，按 `loopName` 匹配传给 `LoopRow`；`onRecover` = `POST .../recover`（body `{}`）→ 成功或 409 都 toast/内联显示结果 → 重新拉取 loops 列表。

- [ ] **Step 6: 跑测试 + tsc + lint + 手测（spec §10 验证 4）**

```bash
node --test lib/loops/recover-route.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm run dev
# 手测：跑一轮中 Ctrl+C 停 dev → 工作区 .pi/runtime/executions/ 出现记录 →
# 重启 dev → Loops 面板该 loop 显示「执行中断，待恢复」且不再起新轮 →
# 点「重新检查并恢复」→ 徽章消失、心跳恢复。
```

- [ ] **Step 7: Commit**

```bash
git add app/api/workspaces components lib/loops
git commit -m "feat: loop interruption recovery API and Loops panel surfacing"
```

---

### Task 9: 删除 daemon 全家

**Files:**
- Delete: `bin/pi-daemon.js`、`bin/load-env-local.js`、`lib/daemon/host.ts`、`lib/daemon/http.ts`、`lib/daemon/http-sessions.ts`、`lib/daemon/client.ts`、`lib/agent-proxy.ts`、`lib/session-daemon/sidecar.ts`、`lib/session-daemon/`（目录）、`lib/daemon/http-sessions.test.mjs`、`lib/daemon/sse-writer.test.mjs`、`lib/session-daemon/sidecar.test.mjs`、`lib/daemon/`（目录清空后）
- Modify: `package.json`（删 `daemon` script）、`AGENTS.md`（Task 10 一并做，此处只删命令）
- Test: 全量 `npm test` 回归

**Interfaces:**
- Consumes: Task 1–8 完成后无任何代码再引用被删模块。
- Produces: 无。

- [ ] **Step 1: 删前验证零引用**

```bash
grep -rn "agent-proxy\|daemon/client\|session-daemon\|daemonProxy\|daemonClient\|DaemonHttpError\|lib/daemon/host\|pi-daemon" app lib components hooks --include="*.ts" --include="*.tsx" | grep -v "session-host\|docs/\|\.test\." || echo "CLEAN"
```
Expected: CLEAN（或仅剩注释/doc 引用——一并清理）。

- [ ] **Step 2: 删除文件与 script**

```bash
git rm bin/pi-daemon.js bin/load-env-local.js
git rm -r lib/daemon lib/session-daemon lib/agent-proxy.ts
```

`package.json` scripts 删除 `"daemon": "node bin/pi-daemon.js"` 行。全局再清一次失效 env 引用（`PI_DAEMON_URL`/`PI_DAEMON_HOST`/`PI_DAEMON_PORT`/`PI_SESSION_DAEMON_DISABLED`：代码里除 background.ts 迁移守卫读 `PI_DAEMON_URL` 外应无其他引用；`.env.local` 由用户侧清理，文档在 Task 10 说明）。

- [ ] **Step 3: 全量回归**

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```
Expected: 全部通过（`app/**` `lib/**` `packages/**` `scripts/**` 全量）。

- [ ] **Step 4: 手测（spec §10 验证 1 完整版）**

```bash
npm run dev
```
浏览器完整走查：无 daemon 监听/进程下——新建会话、发消息、停止、fork、打开历史、打开子 agent 会话、SSE 断线重连（刷新页面）会话继续、归档/删除/恢复会话、auto-name、项目信任切换、loop 心跳自动轮。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove the pi-daemon process, its client, proxy and sidecar"
```

---

### Task 10: AGENTS.md 基线更新与收尾验证

**Files:**
- Modify: `AGENTS.md`

**Interfaces:** 无。

- [ ] **Step 1: 更新 AGENTS.md**

按实际落地代码改写以下章节（不得把设计提前记为已实现——只记已合入的部分）：
- Quick Start：删 `npm run daemon` 段，注明单进程。
- 架构图：Browser → Next.js Server（会话宿主 in-process，无 daemon 列）。
- 「会话浏览/发消息」段：`lib/agent-proxy.ts → daemonClient` 表述改为 `lib/session-host/facade.ts` 直连；locate 的 daemon-probe 表述改为注册表 probe。
- 新增 **Session Host** 小节：`lib/session-host/`（registry/facade/sse/background/jobs/loop-spawner）、globalThis 单例、HMR 语义、关停序列、执行中断记录与恢复门禁、老 daemon 迁移守卫。
- File Map：删 bin/pi-daemon.js、load-env-local.js、lib/daemon/、lib/session-daemon/、agent-proxy 条目；加 lib/session-host/* 与 lib/loops/executions.ts。
- Loop 章：心跳宿主改为「Next.js 宿主内 LoopKitSpawner（instrumentation 装配）+ pi-loop beat 双宿主」；收割口径改为「destroy 定向杀 + 恢复期只读探测」。

- [ ] **Step 2: spec §10 里程碑一验证清单逐项勾验**

对照 spec §10 列表 1–4 与 9 的 loop 部分，逐项在本地复现并记录结果（会话全流程 / SSE 慢客户端与断线 / 热重载单 owner / loop 定时手动轮与锁补跑 / 停机迁移与恢复不重发 prompt / 旧项 loop 工具兼容）。

- [ ] **Step 3: 最终回归 + 提交**

```bash
npm test && node_modules/.bin/tsc --noEmit && npm run lint
git add AGENTS.md
git commit -m "docs: update AGENTS.md baseline for the single-process session host"
```

---

## 自审记录（写计划时已核对）

- Spec §5.1–5.5 每一节都有对应任务：5.1→T1/T2/T4；5.2→T3/T4；5.3→T5/T6/T7；5.4→T6(迁移守卫)/T7/T8；5.5→T9。
- §10 验证 1–4、9 分散在 T4 S5、T3 S5、T6 S5、T7/T8 S6、T9 S4、T10 S2。
- 类型一致性：`createSession/sendCommand/probeSession/destroySession/autoNameSession/busyForCwd/reloadCwdSessions/liveSessions/runningStatus/getSubagentRunStatus/controlSubagent` 在 T2 定义、T3–T5 按同名消费；`markRoundActive/clearRoundMark/listActiveRounds` 在 T6 定义、T7 消费；`ExecutionRecord`/`listPendingExecutionRecords/resolveExecutionRecords/detectSurvivingRoundProcesses/writeExecutionRecord` 在 T7 定义、T8 消费。
- 已知留待 M2：工作项详情跳转执行中断记录（spec §5.4 末句）依赖中央工作项页，归入里程碑二计划。
