# Loop 并行车道（轮×品）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 loop 允许至多 `max_parallel` 条车道并行跑轮——每轮跟一个品，互不干扰；主车道独占 STATE.md 写权，副车道记录走 events/LEARN/git。

**Architecture:** 主锁 `.round.lock` 保持单把且格式不变（STATE 写权 = 持主锁）；副车道每轮一把锁文件 `loops/<name>/.lanes/<laneId>.lock`（记录形状与主锁同构，复用 `isRoundLockStale`）。fire 序列（daemon tick 与 beat 共用）车道感知：主锁空闲占主，主锁忙且未到 `max_parallel` 开副车道（槽位驱动——一个 due 槽位至多开一条新车道，`.lastrun` 消费不变）。web 手动起轮同样主先副后；副车道开场合同注入「禁写 STATE.md」规则行（合同级约束，非技术封锁）。停止按车道（主锁或指定 sessionId 的车道锁）。

**Tech Stack:** TypeScript (Next.js web + node daemon)、packages/pi-loop 纯逻辑包（node:test）、cxin workspace 合同文件（Markdown）。

**Spec:** 本 plan 的共识来自 2026-09-09 grilling 会话（Q1–Q7 定案），决策记录见本文末尾「共识清单」。协议契约文件：`kit/README.md`。

## Global Constraints

- **缺省行为不变**：`max_parallel` 缺省 = 1，所有存量 loop 行为与今天逐字节一致（`packages/pi-loop/*.test.mjs` 与 `lib/loops/rounds.test.mjs` 既有断言除接口更新外不改语义）。
- **主锁格式不变**：`.round.lock` 的 JSON 形状与 stale 公式不动（跨版本/beat 兼容）；多车道根上的外部 beat 必须 ≥ 本版本（kit/README.md 记录）。
- **无 daemon 新路由**：全部经现有 `/v1/sessions` 面（共识 Q7 延续）。
- **纯逻辑进 packages/pi-loop**（无 daemon/web 依赖）；web 接线在 `lib/loops/` + `app/api/`。
- **副车道合同约束**：不写 STATE.md 是**合同级**约束（开场合同规则行 + cxin LOOP.md 并行节），不做技术封锁。
- **车道容量是 advisory**：跨宿主并发开道有微小 TOCTOU 超容窗口（O_EXCL 前计数），接受并文档化（共识 Q5 同源）。
- **web 手动副车道锁是 fire-and-forget**：无人 await 轮结束，靠「锁龄 > `PHANTOM_LOCK_GRACE_MS` 2min 且 sessionId 不在 daemon running set」的活性判定回收（与 step-1 主锁幽灵接管同判据）。
- 测试跑法：`node --test packages/pi-loop/<file>.test.mjs`；全量 `npm test`；类型 `node_modules/.bin/tsc --noEmit`。**禁止 `next build`**。

## 共识清单（spec 摘要）

| 决策 | 定案 |
|---|---|
| Q1 形态 | 并行单位=轮，每轮一个品，手动+自动都支持 |
| Q2 节奏 | 槽位驱动：每个 due 槽位、车道未满即开新车道；`max_parallel` frontmatter，缺省 1，cxin=3 |
| Q3 STATE | 主锁独写；副车道零 STATE 写入，记录走 events/LEARN/git；下主轮开场对账 |
| Q4 停止/状态 | 按车道停；`runningRounds[]`；运行按钮标容量 `运行 n/c`；幽灵活性按每把锁独立判 |
| Q5 咨询态 | ledger/budget 跨车道共享，接受 RMW 竞争（晚一拍/超支≤1轮），文档化 |
| Q6 选品 | 副车道候选剔除「与在途项 repositories 有交集」的项；全剔回落同仓须播报 |
| Q7 分步 | step-1（幽灵锁+disabled 视觉）已完成；本 plan = step-2 |

---

### Task 1: `packages/pi-loop/lanes.ts` — 副车道锁

**Files:**
- Create: `packages/pi-loop/lanes.ts`
- Test: `packages/pi-loop/lanes.test.mjs`

**Interfaces:**
- Consumes: `round-lock.ts` 的 `readRoundLock` / `isRoundLockStale` / `RoundLockHolder` / `RoundLockRecord`（既有，不改）。
- Produces（后续任务依赖的确切签名）:
  - `LANES_DIRNAME = ".lanes"`
  - `interface LaneLock extends RoundLockRecord { laneId: string }`
  - `listLaneLocks(dir: string, maxStaleMs: number): LaneLock[]`（顺手清理 stale/坏文件）
  - `countRunningLanes(dir: string, maxStaleMs: number): number`（主锁活 + 活副锁数）
  - `acquireLaneLock(dir: string, holder: RoundLockHolder, opts: { maxStaleMs: number; maxParallel: number }): string | undefined`
  - `updateLaneLock(dir: string, laneId: string, patch: Partial<RoundLockHolder>): void`
  - `releaseLaneLock(dir: string, laneId: string): void`
  - `findLaneLockBySession(dir: string, sessionId: string, maxStaleMs: number): LaneLock | undefined`

- [ ] **Step 1: Write the failing test**

```js
// packages/pi-loop/lanes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLaneLock, countRunningLanes, findLaneLockBySession,
  listLaneLocks, releaseLaneLock, updateLaneLock, LANES_DIRNAME,
} from "./lanes.ts";
import { acquireRoundLock, releaseRoundLock } from "./round-lock.ts";

const STALE = 60 * 60_000;
const HOLDER = { pid: process.pid, host: "h", kind: "daemon" };

function loopDir() { return mkdtempSync(join(tmpdir(), "lanes-")); }

test("空目录：无车道，计数 0", () => {
  const dir = loopDir();
  assert.equal(listLaneLocks(dir, STALE).length, 0);
  assert.equal(countRunningLanes(dir, STALE), 0);
});

test("acquireLaneLock：开道 → 计数含主锁 → 容量满返回 undefined", () => {
  const dir = loopDir();
  acquireRoundLock(dir, HOLDER);                       // 主锁
  const lane1 = acquireLaneLock(dir, HOLDER, { maxStaleMs: STALE, maxParallel: 2 });
  assert.ok(lane1);
  assert.equal(countRunningLanes(dir, STALE), 2);      // 主 + lane1
  assert.equal(acquireLaneLock(dir, HOLDER, { maxStaleMs: STALE, maxParallel: 2 }), undefined);
  releaseLaneLock(dir, lane1);
  releaseRoundLock(dir);
});

test("updateLaneLock 回填 sessionId；findLaneLockBySession 命中", () => {
  const dir = loopDir();
  const laneId = acquireLaneLock(dir, HOLDER, { maxStaleMs: STALE, maxParallel: 3 });
  updateLaneLock(dir, laneId, { sessionId: "s-1" });
  const found = findLaneLockBySession(dir, "s-1", STALE);
  assert.equal(found?.laneId, laneId);
  assert.equal(found?.sessionId, "s-1");
  releaseLaneLock(dir, laneId);
  assert.equal(findLaneLockBySession(dir, "s-1", STALE), undefined);
});

test("stale 车道锁被 listLaneLocks 顺手清理（窗口治理）", () => {
  const dir = loopDir();
  const laneId = acquireLaneLock(dir, HOLDER, { maxStaleMs: STALE, maxParallel: 2 });
  const path = join(dir, LANES_DIRNAME, `${laneId}.lock`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...raw, startedAt: Date.now() - STALE - 1 }));
  assert.equal(listLaneLocks(dir, STALE).length, 0);   // 已被清
  assert.equal(countRunningLanes(dir, STALE), 0);
});

test("死 pid 无 sessionId 的车道锁（beat 副道形态）→ pid 治理判 stale", () => {
  const dir = loopDir();
  const laneId = acquireLaneLock(dir, { pid: 999999, host: "h", kind: "beat" }, { maxStaleMs: STALE, maxParallel: 2 });
  assert.equal(listLaneLocks(dir, STALE).length, 0);   // isRoundLockStale 同公式
  releaseLaneLock(dir, laneId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/pi-loop/lanes.test.mjs`
Expected: FAIL（`Cannot find module './lanes.ts'`）

- [ ] **Step 3: Write lanes.ts**

```ts
/** .lanes/<laneId>.lock — 并行副车道锁（共识 Q2/Q3）。主锁 .round.lock 保持单把
 *  （STATE.md 写权 = 持主锁）；副车道每轮一把锁文件，记录形状与主锁同构（复用
 *  isRoundLockStale，sessionId 锁窗口治理 / 无 sessionId 锁 pid 治理）。宿主写；
 *  agent 禁改禁删（与 .lastrun/.round.lock 同级）。车道容量是 advisory：跨宿主
 *  并发开道在计数与 O_EXCL 之间有微小超容窗口，接受（共识 Q5 同源）。 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isRoundLockStale, readRoundLock, type RoundLockHolder, type RoundLockRecord } from "./round-lock.ts";

export const LANES_DIRNAME = ".lanes";

export interface LaneLock extends RoundLockRecord { laneId: string }

function lanePath(dir: string, laneId: string): string {
  return join(dir, LANES_DIRNAME, `${laneId}.lock`);
}

/** 读全部活车道锁，顺手清理 stale/损坏文件（对齐 acquireRoundLock 的治理口径）。 */
export function listLaneLocks(dir: string, maxStaleMs: number): LaneLock[] {
  let entries: string[];
  try {
    entries = readdirSync(join(dir, LANES_DIRNAME));
  } catch {
    return [];
  }
  const alive: LaneLock[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const laneId = entry.slice(0, -".lock".length);
    let record: RoundLockRecord | undefined;
    try {
      record = JSON.parse(readFileSync(join(dir, LANES_DIRNAME, entry), "utf8")) as RoundLockRecord;
    } catch { record = undefined; }
    if (!record || typeof record.pid !== "number" || isRoundLockStale(record, maxStaleMs)) {
      try { unlinkSync(join(dir, LANES_DIRNAME, entry)); } catch { /* 已被并发清理 */ }
      continue;
    }
    alive.push({ ...record, laneId });
  }
  return alive;
}

/** 活跃车道数 = 主锁活 + 活副锁数（容量判定唯一口径）。 */
export function countRunningLanes(dir: string, maxStaleMs: number): number {
  const primary = readRoundLock(dir);
  const primaryAlive = !!primary && !isRoundLockStale(primary, maxStaleMs);
  return (primaryAlive ? 1 : 0) + listLaneLocks(dir, maxStaleMs).length;
}

/** 开一条副车道：容量未满时 O_EXCL 创建 <uuid>.lock，返回 laneId；满/失败 → undefined。 */
export function acquireLaneLock(
  dir: string,
  holder: RoundLockHolder,
  opts: { maxStaleMs: number; maxParallel: number },
): string | undefined {
  if (countRunningLanes(dir, opts.maxStaleMs) >= opts.maxParallel) return undefined;
  const laneId = randomUUID().slice(0, 8);
  try {
    mkdirSync(join(dir, LANES_DIRNAME), { recursive: true });
    writeFileSync(lanePath(dir, laneId), JSON.stringify({ ...holder, startedAt: Date.now() }, null, 2), { flag: "wx" });
    return laneId;
  } catch {
    return undefined;
  }
}

/** 回填 sessionId（建会话后；与主锁 updateRoundLock 同构）。 */
export function updateLaneLock(dir: string, laneId: string, patch: Partial<RoundLockHolder>): void {
  try {
    const current = JSON.parse(readFileSync(lanePath(dir, laneId), "utf8")) as RoundLockRecord;
    writeFileSync(lanePath(dir, laneId), JSON.stringify({ ...current, ...patch }, null, 2));
  } catch { /* 尽力 */ }
}

export function releaseLaneLock(dir: string, laneId: string): void {
  try { unlinkSync(lanePath(dir, laneId)); } catch { /* ENOENT = 已释放 */ }
}

/** 按 sessionId 找活车道锁（按车道停止用）。 */
export function findLaneLockBySession(dir: string, sessionId: string, maxStaleMs: number): LaneLock | undefined {
  return listLaneLocks(dir, maxStaleMs).find((lane) => lane.sessionId === sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/pi-loop/lanes.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/pi-loop/lanes.ts packages/pi-loop/lanes.test.mjs
git commit -m "feat(pi-loop): lane locks (.lanes/<id>.lock) for parallel rounds"
```

---

### Task 2: `max_parallel` 解析与 frontmatter 编辑

**Files:**
- Modify: `packages/pi-loop/protocol.ts`（`LoopDeclaration` + `parseLoopDeclaration`）
- Modify: `packages/pi-loop/frontmatter.ts`（`LoopFrontmatterPatch` + `applyLoopFrontmatterPatch`）
- Test: `packages/pi-loop/protocol.test.mjs`、`packages/pi-loop/frontmatter.test.mjs`

**Interfaces:**
- Produces: `LoopDeclaration.maxParallel: number`（缺省 1）；frontmatter 字段名 `max_parallel`（整数，1–8）。

- [ ] **Step 1: Write the failing tests（两个文件各追加）**

```js
// protocol.test.mjs 追加
test("parseLoopDeclaration: max_parallel 解析（缺省 1 / 非法回缺省）", () => {
  const base = "---\ncron: */30 9-22 * * 1-5\nmax_parallel: 3\n---\nbody";
  const d = parseLoopDeclaration(base, "/ws/loops/x", "/ws");
  assert.equal(d.maxParallel, 3);
  const none = parseLoopDeclaration("---\ncron: */30 * * * *\n---\nb", "/ws/loops/x", "/ws");
  assert.equal(none.maxParallel, 1);
  const bad = parseLoopDeclaration("---\ncron: */30 * * * *\nmax_parallel: 0\n---\nb", "/ws/loops/x", "/ws");
  assert.equal(bad.maxParallel, 1);
});

// frontmatter.test.mjs 追加
test("applyLoopFrontmatterPatch: max_parallel 编辑与校验", () => {
  const raw = "---\ncron: */30 * * * *\nmax_parallel: 1\n---\nbody";
  const out = applyLoopFrontmatterPatch(raw, { max_parallel: 3 });
  assert.match(out, /max_parallel: 3/);
  assert.ok(out.endsWith("body")); // 正文 byte 保留
  assert.throws(() => applyLoopFrontmatterPatch(raw, { max_parallel: 0 }), /正整数/);
  assert.throws(() => applyLoopFrontmatterPatch(raw, { max_parallel: 9 }), /1-8/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/pi-loop/protocol.test.mjs packages/pi-loop/frontmatter.test.mjs`
Expected: FAIL（`maxParallel` undefined / 不校验）

- [ ] **Step 3: Implement**

`protocol.ts`：

```ts
export interface LoopDeclaration {
  // …既有字段不动…
  /** 并行车道上限（frontmatter max_parallel，整数 1–8）；缺省 1 = 单轮串行。 */
  maxParallel: number;
}
export const DEFAULT_MAX_PARALLEL = 1;
export const MAX_PARALLEL_LIMIT = 8;
// parseLoopDeclaration 内、maxMinutes 解析之后追加：
const parallelRaw = typeof record.max_parallel === "number" ? record.max_parallel : DEFAULT_MAX_PARALLEL;
const maxParallel = Number.isInteger(parallelRaw) && parallelRaw >= 1 && parallelRaw <= MAX_PARALLEL_LIMIT
  ? parallelRaw : DEFAULT_MAX_PARALLEL;
// return 对象追加 maxParallel。
```

`frontmatter.ts`：`LoopFrontmatterPatch` 加 `max_parallel?: number`；`applyLoopFrontmatterPatch` 追加分支：

```ts
if (patch.max_parallel !== undefined) {
  if (!Number.isInteger(patch.max_parallel) || patch.max_parallel < 1 || patch.max_parallel > 8) {
    throw new LoopFrontmatterError(`max_parallel 必须是 1-8 的正整数：${String(patch.max_parallel)}`);
  }
  record.max_parallel = patch.max_parallel;
}
```

（导入 `MAX_PARALLEL_LIMIT` 复用上限常量亦可，二选一，保持一处定义。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/pi-loop/protocol.test.mjs packages/pi-loop/frontmatter.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/pi-loop/protocol.ts packages/pi-loop/frontmatter.ts packages/pi-loop/protocol.test.mjs packages/pi-loop/frontmatter.test.mjs
git commit -m "feat(pi-loop): max_parallel frontmatter (default 1) with parse+patch validation"
```

---

### Task 3: `contract.ts` — 副车道规则行

**Files:**
- Modify: `packages/pi-loop/contract.ts`
- Test: `packages/pi-loop/contract.test.mjs`

**Interfaces:**
- Produces: `buildRoundPrompt(declaration, opts)` 的 `opts` 增加 `secondaryLane?: boolean`。副车道时：注入「禁写 STATE.md」规则、替换「结束前更新 STATE.md」为里程碑/LEARN 收尾、宿主文件条款扩到 `.lanes/`。

- [ ] **Step 1: Write the failing test**

```js
// contract.test.mjs 追加（沿用文件内既有 DECL fixture）
test("buildRoundPrompt: secondaryLane 注入禁写 STATE 与 .lanes 宿主条款", () => {
  const primary = buildRoundPrompt(DECL, { sessionId: "s-1" });
  const secondary = buildRoundPrompt(DECL, { sessionId: "s-2", secondaryLane: true });
  assert.ok(!primary.includes("并行副车道"));
  assert.ok(secondary.includes("并行副车道"));
  assert.ok(secondary.includes("禁止写 STATE.md"));
  assert.ok(secondary.includes(".lanes/"));
  assert.ok(!secondary.match(/结束前：更新 .*STATE\.md/)); // 主轮条款不出现
  assert.ok(secondary.includes("结束前：不写 STATE.md"));
  assert.ok(primary.includes("结束前：更新")); // 主轮不变
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/pi-loop/contract.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement（contract.ts）**

`buildRoundPrompt` 的 opts 类型加 `secondaryLane?: boolean`；rules 组装改为：

```ts
if (opts.secondaryLane) {
  rules.push(`本轮为并行副车道（未持主锁）：可读 ${declaration.dir}/STATE.md 恢复上下文，但禁止写/改 STATE.md——你的记录走工作项 events/里程碑 + LEARN/ + workspace git commit；「结束前」条款以本形态为准。`);
}
// …sessionId / cwd / 纪律 / manual-or-paused 规则行不动…
rules.push(
  opts.secondaryLane
    ? `\`.lastrun\`、\`.round.lock\` 与 \`${declaration.dir}/.lanes/\` 内文件是宿主文件，一律禁改禁删（与 PAUSED 同级）。`
    : `\`.lastrun\` 与 \`.round.lock\` 是宿主文件，一律禁改禁删（与 PAUSED 同级）。`,
);
rules.push(
  opts.secondaryLane
    ? `结束前：不写 STATE.md；确保工作项里程碑（loop.* 戳）与 LEARN/（如适用）已落盘。`
    : `结束前：更新 ${declaration.dir}/STATE.md（Last run / outcome / 复盘节必填）。`,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/pi-loop/contract.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/pi-loop/contract.ts packages/pi-loop/contract.test.mjs
git commit -m "feat(pi-loop): secondary-lane contract rules (no STATE writes, .lanes host files)"
```

---

### Task 4: `fire.ts` — 车道感知 fire 序列

**Files:**
- Modify: `packages/pi-loop/fire.ts`
- Modify: `packages/pi-loop/beat.ts`（runner 透传 lane → 副道合同）
- Test: `packages/pi-loop/fire.test.mjs`（既有 runner 签名 `() => Promise<void>` 全部更新）

**Interfaces:**
- Consumes: Task 1 `acquireLaneLock/releaseLaneLock`、Task 2 `declaration.maxParallel`。
- Produces:
  - `interface RoundLane { kind: "primary" | "secondary"; laneId?: string }`
  - `runDueRound(declaration, holder, runner: (lane: RoundLane) => Promise<void>, deps?): Promise<"fired" | "fired-lane" | "skipped" | "busy">`
  - `runNow(declaration, holder, runner: (lane: RoundLane) => Promise<void>): Promise<"fired" | "fired-lane" | "busy">`

- [ ] **Step 1: Update failing tests first（改造既有 + 新增）**

既有用例的 runner 参数补 `(lane) =>`；新增：

```js
// fire.test.mjs 追加（沿用文件内既有 fixture 风格：手写 LOOP.md + .lastrun）
test("runDueRound: 主锁忙 + 未到 max_parallel → 开副车道（lastrun 消费 + 车道锁生命周期）", async () => {
  const dir = makeLoopDir({ maxParallel: 2 });           // 测试 helper 按 fixture 风格实现
  acquireRoundLock(dir, HOLDER);                          // 模拟主轮在跑
  await writeLastrunFile(dir, -60 * 60_000);              // helper：写 1h 前的 .lastrun → due
  const lanes = [];
  const result = await runDueRound(DECL_AT(dir), HOLDER, async (lane) => { lanes.push(lane); });
  assert.equal(result, "fired-lane");
  assert.equal(lanes[0].kind, "secondary");
  assert.ok(lanes[0].laneId);
  assert.equal(listLaneLocks(dir, STALE).length, 0);      // finally 已释放
  assert.ok(readLastrun(dir) > past);                     // .lastrun 被副车道消费
});

test("runDueRound: 到 max_parallel → busy（不超容）", async () => {
  const dir = makeLoopDir({ maxParallel: 1 });            // 缺省即 1
  acquireRoundLock(dir, HOLDER);
  await writeLastrunFile(dir, -60 * 60_000);
  assert.equal(await runDueRound(DECL_AT(dir), HOLDER, async () => {}), "busy");
});

test("runDueRound: 副道锁内复查 shouldFire——主锁持有者已消费本槽 → skipped", async () => {
  const dir = makeLoopDir({ maxParallel: 2 });
  acquireRoundLock(dir, HOLDER);
  await writeLastrunFile(dir, 0);                         // 刚消费 → 不 due
  // 但外部预检已过（模拟竞态）：直接验证副道 acquire 后复查路径
  const result = await runDueRound(DECL_AT(dir), HOLDER, async () => { throw new Error("不应执行"); });
  assert.equal(result, "skipped");
});
```

（`makeLoopDir`/`writeLastrunFile`/`DECL_AT` 按该文件既有 fixture 模式落地——`maxParallel` 经 LOOP.md frontmatter `max_parallel: N` 声明。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/pi-loop/fire.test.mjs`
Expected: FAIL（无 "fired-lane"）

- [ ] **Step 3: Implement fire.ts**

```ts
export type FireResult = "fired" | "fired-lane" | "skipped" | "busy";

export interface RoundLane { kind: "primary" | "secondary"; laneId?: string }

export async function runDueRound(
  declaration: LoopDeclaration,
  holder: RoundLockHolder,
  runner: (lane: RoundLane) => Promise<void>,
  deps: { now?: () => Date } = {},
): Promise<FireResult> {
  const now = deps.now ?? (() => new Date());
  if (!shouldFire(declaration, now())) return "skipped";
  const lockOpts = { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 };
  if (acquireRoundLock(declaration.dir, holder, lockOpts)) {
    try {
      if (!shouldFire(declaration, now())) return "skipped"; // 锁内复查
      writeLastrun(declaration.dir, now());
      await runner({ kind: "primary" });
      return "fired";
    } finally {
      releaseRoundLock(declaration.dir);
    }
  }
  if (declaration.maxParallel > 1) {
    const laneId = acquireLaneLock(declaration.dir, holder, { ...lockOpts, maxParallel: declaration.maxParallel });
    if (laneId) {
      try {
        if (!shouldFire(declaration, now())) return "skipped"; // 主锁持有者刚消费了本槽
        writeLastrun(declaration.dir, now());
        await runner({ kind: "secondary", laneId });
        return "fired-lane";
      } finally {
        releaseLaneLock(declaration.dir, laneId);
      }
    }
  }
  return "busy";
}
```

`runNow` 同构：primary-first → lane fallback → `"busy"`，无 shouldFire 判定。

- [ ] **Step 4: beat.ts runner 透传 lane**

`beatRoundRunner(declaration)` → `beatRoundRunner(declaration, lane: RoundLane)`：内部 `buildRoundPrompt(declaration, { secondaryLane: lane.kind === "secondary" })`（beat 形态本就无 sessionId，保持）；调用点 `runDueRound(declaration, holder, (lane) => beatRoundRunner(declaration, lane))`。

- [ ] **Step 5: Run tests**

Run: `node --test packages/pi-loop/fire.test.mjs packages/pi-loop/beat.test.mjs`
Expected: PASS（beat 既有断言更新 runner mock 签名）

- [ ] **Step 6: Commit**

```bash
git add packages/pi-loop/fire.ts packages/pi-loop/beat.ts packages/pi-loop/fire.test.mjs packages/pi-loop/beat.test.mjs
git commit -m "feat(pi-loop): lane-aware fire sequence (primary-first, slot-driven secondary under max_parallel)"
```

---

### Task 5: `status.ts` — `runningRounds` / `maxParallel`

**Files:**
- Modify: `packages/pi-loop/status.ts`
- Test: `packages/pi-loop/status.test.mjs`

**Interfaces:**
- Produces:
  - `interface RunningRoundEntry { kind: "primary" | "secondary"; sessionId?: string; startedAt: string; laneId?: string }`
  - `LoopStatusEntry` 增加 `maxParallel: number; runningLanes: number; runningRounds: RunningRoundEntry[]`（`running` 保留 = 有任何活锁，向后兼容）

- [ ] **Step 1: Write the failing test**

```js
// status.test.mjs 追加
test("collectStatus: 主锁 + 副道锁 → runningRounds/runningLanes/maxParallel", () => {
  const root = makeRoot();                               // 既有 helper 风格：建 loops/x/LOOP.md
  writeLoopMd(root, "x", "max_parallel: 3");
  acquireRoundLock(loopDir(root, "x"), { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-p" });
  const laneId = acquireLaneLock(loopDir(root, "x"), { pid: process.pid, host: "h", kind: "daemon" }, { maxStaleMs: STALE, maxParallel: 3 });
  updateLaneLock(loopDir(root, "x"), laneId, { sessionId: "s-l" });
  const [entry] = collectStatus(root);
  assert.equal(entry.maxParallel, 3);
  assert.equal(entry.runningLanes, 2);
  assert.ok(entry.running);
  assert.deepEqual(
    entry.runningRounds.map((r) => r.kind),
    ["primary", "secondary"],
  );
  assert.equal(entry.runningRounds[1].sessionId, "s-l");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/pi-loop/status.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
const lockOptsFor = (d: LoopDeclaration) => d.maxMinutes * 60_000 + 15 * 60_000;
// collectStatus map 内：
const runningRounds: RunningRoundEntry[] = [];
if (lock && !isRoundLockStale(lock, lockOptsFor(declaration))) {
  runningRounds.push({ kind: "primary", sessionId: lock.sessionId, startedAt: new Date(lock.startedAt).toISOString() });
}
for (const lane of listLaneLocks(declaration.dir, lockOptsFor(declaration))) {
  runningRounds.push({ kind: "secondary", sessionId: lane.sessionId, startedAt: new Date(lane.startedAt).toISOString(), laneId: lane.laneId });
}
return { /* …既有字段… */, maxParallel: declaration.maxParallel, running: runningRounds.length > 0, runningLanes: runningRounds.length, runningRounds };
```

- [ ] **Step 4: Run test to verify it passes** — `node --test packages/pi-loop/status.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add packages/pi-loop/status.ts packages/pi-loop/status.test.mjs
git commit -m "feat(pi-loop): collectStatus reports runningRounds/maxParallel/runningLanes"
```

---

### Task 6: `lib/loops/rounds.ts` — 手动起轮车道分支 + 按车道停止

**Files:**
- Modify: `lib/loops/rounds.ts`
- Test: `lib/loops/rounds.test.mjs`

**Interfaces:**
- Consumes: Task 1 lanes API、Task 3 `buildRoundPrompt … secondaryLane`。
- Produces:
  - `launchManualRound(declaration, opts, deps)` 返回值增加 `lane?: "primary" | "secondary"`
  - `stopRound(declaration, deps, opts?: { sessionId?: string })`——传 sessionId 时按车道停（主锁或该 session 的车道锁）；不传 = 今天的 primary 行为
  - `prunePhantomLaneLocks`（内部）：web 侧幽灵副道锁回收

- [ ] **Step 1: Write the failing tests**

```js
// rounds.test.mjs 追加（沿用 makeLoopDir/makeDeps/ageLock；DECL 需经 LOOP.md frontmatter 声明 max_parallel，
// makeLoopDir 现写死的 LOOP.md 加一行 max_parallel: 3，或新 helper makeLoopDirParallel()）
test("launchManualRound: 主锁忙 + 容量未满 → 副车道起轮（合同含禁写 STATE、锁回填）", async () => {
  makeLoopDirParallel();                                  // max_parallel: 3
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "primary-run" });
  const { calls, deps } = makeDeps();
  const result = await launchManualRound({ ...DECL }, {}, deps);
  assert.equal(result.lane, "secondary");
  assert.equal(result.sessionId, "sess-1");
  const prompt = calls.commands[1].command;
  assert.ok(prompt.message.includes("并行副车道"));
  assert.ok(prompt.message.includes("禁止写 STATE.md"));
  const lanes = listLaneLocks(DECL.dir, 60 * 60_000);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].sessionId, "sess-1");             // fire-and-forget：锁保持持有
  assert.ok(readLock(DECL.dir));                          // 主锁不受扰
});

test("launchManualRound: 容量满 → RoundBusyError", async () => {
  makeLoopDirParallel();                                  // max_parallel: 1 的 makeLoopDir() 同理可测
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "p" });
  const laneId = acquireLaneLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon" }, { maxStaleMs: STALE, maxParallel: 2 });
  updateLaneLock(DECL.dir, laneId, { sessionId: "l1" });  // 2/2 满
  const { deps } = makeDeps();
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), RoundBusyError);
});

test("launchManualRound: 幽灵副道锁被活性回收后可开新道", async () => {
  makeLoopDirParallel();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "p" });
  const laneId = acquireLaneLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon" }, { maxStaleMs: STALE, maxParallel: 2 });
  updateLaneLock(DECL.dir, laneId, { sessionId: "dead-lane" });
  // 把副道锁龄改老（> PHANTOM_LOCK_GRACE_MS）
  const p = join(DECL.dir, ".lanes", `${laneId}.lock`);
  const aged = JSON.parse(readFileSync(p, "utf8"));
  writeFileSync(p, JSON.stringify({ ...aged, startedAt: Date.now() - 3 * 60_000 }));
  const { deps } = makeDeps();
  deps.runningSessionIds = async () => ["p-live"];        // dead-lane 不在 running set
  // 主锁 ghost 判定同时生效需 primary-run 也不在 set——改 deps 返回 []，主锁接管走 step-1 路径则 lane=primary。
  // 本用例聚焦副道：让主锁 session 在 set 里（p-live=primary-run），只回收副道。
  const result = await launchManualRound({ ...DECL }, {}, deps);
  assert.equal(result.lane, "secondary");
});

test("stopRound: 按 sessionId 停副道——destroy 该会话 + 只释放该车道锁", async () => {
  makeLoopDirParallel();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-p" });
  const laneId = acquireLaneLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon" }, { maxStaleMs: STALE, maxParallel: 3 });
  updateLaneLock(DECL.dir, laneId, { sessionId: "s-l" });
  const destroyed = [];
  const outcome = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async () => {},
    runningSessionIds: async () => ["s-p", "s-l"],       // 都活着
  }, { sessionId: "s-l" });
  assert.equal(outcome, "stopped");
  assert.deepEqual(destroyed, ["s-l"]);
  assert.equal(listLaneLocks(DECL.dir, STALE).length, 0); // 只有副道锁被释放
  assert.equal(readLock(DECL.dir).sessionId, "s-p");      // 主锁不动
});

test("stopRound: 按 sessionId 停主轮（sessionId 命中主锁）→ 走主流程", async () => {
  makeLoopDirParallel();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-p" });
  const destroyed = [];
  const outcome = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async () => {},
  }, { sessionId: "s-p" });
  assert.equal(outcome, "stopped");
  assert.deepEqual(destroyed, ["s-p"]);
  assert.equal(readLock(DECL.dir), undefined);
});

test("stopRound: sessionId 无锁命中 → not-running", async () => {
  makeLoopDirParallel();
  const outcome = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} }, { sessionId: "nobody" });
  assert.equal(outcome, "not-running");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/loops/rounds.test.mjs`
Expected: FAIL（新用例；既有 18 个必须仍 PASS——缺省 `max_parallel: 1` 下主锁忙直接 RoundBusyError，路径不变）

- [ ] **Step 3: Implement（rounds.ts）**

要点（既有幽灵接管/两步建会话骨架不动）：

```ts
import { acquireLaneLock, findLaneLockBySession, listLaneLocks, releaseLaneLock, updateLaneLock, type LaneLock } from "../../packages/pi-loop/lanes.ts";

const staleWindowMs = (d: LoopDeclaration) => d.maxMinutes * 60_000 + 15 * 60_000;

/** web 侧幽灵副道锁回收（fire-and-forget 副道无人 await）：与主锁 isPhantomRoundLock 同判据。 */
async function prunePhantomLaneLocks(declaration: LoopDeclaration, deps: LaunchRoundDeps): Promise<void> {
  if (!deps.runningSessionIds) return;
  let ids: string[];
  try { ids = await deps.runningSessionIds(); } catch { return; }
  for (const lane of listLaneLocks(declaration.dir, staleWindowMs(declaration))) {
    if (!lane.sessionId) continue;
    if (Date.now() - lane.startedAt <= PHANTOM_LOCK_GRACE_MS) continue;
    if (!ids.includes(lane.sessionId)) releaseLaneLock(declaration.dir, lane.laneId);
  }
}
```

`launchManualRound`：主锁 acquire（含 step-1 幽灵接管）失败后：

```ts
  let laneId: string | undefined;
  if (declaration.maxParallel > 1) {
    await prunePhantomLaneLocks(declaration, deps);
    laneId = acquireLaneLock(declaration.dir, holder, { maxStaleMs: staleWindowMs(declaration), maxParallel: declaration.maxParallel });
  }
  if (!laneId) throw new RoundBusyError(declaration.loopName);
  const secondary = !!laneId;
```

成功路径：sessionId 回填 `laneId ? updateLaneLock(dir, laneId, { sessionId }) : updateRoundLock(dir, { sessionId })`；命名 `${declaration.loopName} · 手动${secondary ? "并行" : ""} ${slot}`；prompt 传 `secondaryLane: secondary`；返回 `{ sessionId, cwd, sessionFile, lane: secondary ? "secondary" : "primary" }`。catch 路径：`if (laneId) releaseLaneLock(dir, laneId); else releaseRoundLock(dir);`（沿用既有 destroy-半建会话逻辑）。

`stopRound(declaration, deps, opts: { sessionId?: string } = {})`：

```ts
  // 按车道停：sessionId 命中主锁 → 主流程；命中副道锁 → 幽灵判定 + destroy + 只释放该锁；无命中 → not-running
  if (opts.sessionId) {
    const primary = readRoundLock(declaration.dir);
    if (primary?.sessionId !== opts.sessionId) {
      const lane = findLaneLockBySession(declaration.dir, opts.sessionId, staleWindowMs(declaration));
      if (!lane) return "not-running";
      if (await isPhantomRoundLock(lane, deps)) {
        releaseLaneLock(declaration.dir, lane.laneId);
        return "stopped";
      }
      await deps.destroySession(opts.sessionId);
      try { await deps.reap(declaration.workspacePath); } catch { /* 同主流程口径 */ }
      releaseLaneLock(declaration.dir, lane.laneId);
      return "stopped";
    }
    // 命中主锁 → 落到下方主流程（沿用既有代码，含幽灵判定）
  }
```

- [ ] **Step 4: Run tests to verify they pass** — `node --test lib/loops/rounds.test.mjs`（24 tests）

- [ ] **Step 5: Commit**

```bash
git add lib/loops/rounds.ts lib/loops/rounds.test.mjs
git commit -m "feat(loops): manual rounds open secondary lanes under max_parallel; per-lane stop"
```

---

### Task 7: `lib/daemon/loop-spawner.ts` — runner 车道化

**Files:**
- Modify: `lib/daemon/loop-spawner.ts`
- Test: `lib/daemon/loop-spawner.test.mjs`（先读既有用例风格再追加）

**Interfaces:**
- Consumes: Task 4 `RoundLane`、Task 1 `updateLaneLock`。
- Produces: `runKitRound(declaration, deps)` 的 `RoundDeps` 增加 `lane?: RoundLane`——sessionId 回填目标（主锁 or 车道锁）、会话名后缀（副道 `·并行`）、合同 `secondaryLane`。

- [ ] **Step 1: Write the failing test**

按既有 `loop-spawner.test.mjs` 的 mock 风格追加：

```js
test("tick: 主锁忙 + due + max_parallel>1 → 副道起轮（合同含禁写 STATE、车道锁回填后释放）", async () => {
  // fixture: workspace + loops/x/LOOP.md (max_parallel: 2) + .lastrun=1h前 + 主锁已占
  // runRound mock 断言 deps.lane.kind === "secondary"；断言执行后 .lanes/ 目录空（finally 释放）
});
test("tick: 容量满（主+1副道都活）→ 不再开道", async () => {
  // 断言 runRound 未被调用（busy 路径）
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test lib/daemon/loop-spawner.test.mjs`

- [ ] **Step 3: Implement**

```ts
// tick 内：
await runDueRound(
  declaration,
  holder,
  async (lane) => {
    await this.deps.runRound(declaration, {
      lane,
      onSessionStart: (sessionId) => {
        if (lane.kind === "primary") updateRoundLock(declaration.dir, { sessionId });
        else if (lane.laneId) updateLaneLock(declaration.dir, lane.laneId, { sessionId });
      },
    });
  },
  { now: this.deps.now },
);
// runKitRound：deps.lane?.kind === "secondary" →
//   命名 `${declaration.loopName} · ${slot} ·并行`
//   buildRoundPrompt(declaration, { sessionId: realSessionId, secondaryLane: true })
// D9 事后钩子对副道照常（bookkeeper 包在 runner 外层，无需分支）。
```

- [ ] **Step 4: Run tests** — `node --test lib/daemon/loop-spawner.test.mjs`（含既有用例，runner mock 签名更新）

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/loop-spawner.ts lib/daemon/loop-spawner.test.mjs
git commit -m "feat(daemon): spawner ticks fire secondary lanes (slot-driven) with lane-aware backfill/naming/contract"
```

---

### Task 8: web 路由 — status 活性富化 / stop(sessionId) / PATCH max_parallel

**Files:**
- Create: `lib/loops/status-live.ts` + `lib/loops/status-live.test.mjs`（活性富化纯逻辑，可测）
- Modify: `app/api/workspaces/[id]/loops/route.ts`（GET 富化）
- Modify: `app/api/workspaces/[id]/loops/[name]/route.ts`（PATCH EDITABLE 加 `max_parallel`）
- Modify: `app/api/workspaces/[id]/loops/[name]/stop/route.ts`（body `sessionId?`）

**Interfaces:**
- Produces: `annotateLoopStatusLive(entries: LoopStatusEntry[], runningIds: string[] | undefined, graceMs = 120_000): LoopStatusEntry[]`——runningIds 为 undefined（daemon 不可达）时原样返回；否则过滤幽灵 runningRounds（sessionId 存在、age > grace、不在 ids）并重算 `running`/`runningLanes`。

- [ ] **Step 1: Write the failing test（status-live.test.mjs）**

```js
test("幽灵轮被过滤：sessionId 不在 running set 且锁龄过宽限", () => {
  const entry = { name: "x", /* …必要字段… */ running: true, runningLanes: 2, maxParallel: 3,
    runningRounds: [
      { kind: "primary", sessionId: "live-1", startedAt: new Date().toISOString() },
      { kind: "secondary", sessionId: "ghost", startedAt: new Date(Date.now() - 3 * 60_000).toISOString() },
    ] };
  const [out] = annotateLoopStatusLive([entry], ["live-1"]);
  assert.equal(out.runningLanes, 1);
  assert.equal(out.runningRounds.length, 1);
});
test("宽限期内不判幽灵；daemon 不可达（undefined）原样返回", () => { /* 两个断言 */ });
```

- [ ] **Step 2 → 4: 实现 + 通过**（route 接线：`const ids = await client.runningSessionIds().then(r => r.ids).catch(() => undefined)` → `annotateLoopStatusLive`；PATCH 路由 `EDITABLE` 加 `"max_parallel"` + 整数 1–8 校验，错误文案更新「仅 cron/timezone/level/max_minutes/max_parallel」；stop 路由解析 body `{ sessionId?: string }` 传 `stopRound` 第三参）

- [ ] **Step 5: Commit**

```bash
git add lib/loops/status-live.ts lib/loops/status-live.test.mjs "app/api/workspaces/[id]/loops/route.ts" "app/api/workspaces/[id]/loops/[name]/route.ts" "app/api/workspaces/[id]/loops/[name]/stop/route.ts"
git commit -m "feat(loops): liveness-annotated status, per-lane stop route, PATCH max_parallel"
```

---

### Task 9: UI — LoopRow / LoopsPanel / LoopsConfig / shells

**Files:**
- Modify: `components/LoopRow.tsx`（`LoopStatus` 镜像 + 容量标注 + 按车道停）
- Modify: `components/LoopsPanel.tsx`（loopAction 带 sessionId、onOpenSession 透传）
- Modify: `components/WorkspaceOverview.tsx`（LoopRow 新 props 兼容——不传 onOpenSession 即纯展示）
- Modify: `components/LoopsConfig.tsx`（frontmatter 表单加 max_parallel）
- Modify: `components/shell/DesktopShell.tsx` / `MobileShell.tsx`（`onOpenSession={handleOpenSessionViewer}`）

**Interfaces:**
- `LoopStatus` 镜像加 `maxParallel: number; runningLanes: number; runningRounds: Array<{ kind: "primary" | "secondary"; sessionId?: string; startedAt: string; laneId?: string }>`
- `LoopRowProps` 加 `onAction: (name, action, sessionId?) => void`（第三参可选，向后兼容）与 `onOpenSession?: (sessionId: string) => void`
- `LoopsPanelProps.onOpenSession?: (sessionId: string) => void`

**要点：**
- 状态徽标：`runningLanes > 1 ? `● ${runningLanes} 轮在跑` : running ? "● 运行中" : …`（沿用既有 paused/nextDue 分支）。
- 运行按钮：`disabled={busy || runningLanes >= maxParallel}`；`maxParallel > 1` 时文案 `运行 ${runningLanes}/${maxParallel}`，disabled 视觉沿用 step-1 的 `disabledButtonStyle`。
- 车道子行：`runningRounds.length > 0` 时在行内容下方渲染（flex 列）：每条 `『主|并行』 HH:mm` + 会话 id 前 8 位（有 `onOpenSession` 且有 sessionId 时可点跳转）+ 独立「停止」按钮 → `onAction(loop.name, "stop", sessionId)`。
- `LoopsPanel.loopAction`：action === "stop" 且 sessionId 存在时 body 带 `{ sessionId }`。
- `LoopsConfig` frontmatter 表单：`maxParallel` number input（1–8），PATCH body `max_parallel: Number(fm.maxParallel)`；GET docs 包（`…/docs` 路由的 frontmatter bundle）透传 `max_parallel`（检查 `lib/loops/manage.ts` 的 frontmatter 读取，若为显式字段挑选则补 `max_parallel`）。
- 创建向导（LoopsConfig `CreateLoopForm`）：`max_parallel` 可选字段，缺省 1，`initLoop` 的 frontmatter 模板写入（`packages/pi-loop/init.ts` 的 LOOP.md 模板加注释行 `# max_parallel: 1  # 并行车道上限（缺省 1）`，不写死值）。

- [ ] **Step 1: 实现 UI 变更（组件无测试，按上述要点逐一落地）**
- [ ] **Step 2: `node_modules/.bin/tsc --noEmit` 通过；`npm run lint` 无新增 error**
- [ ] **Step 3: 手动验证清单（dev server）**：cxin Loops 面板显示 `运行 0/3`；起一轮后 `1/3`；运行中再点运行 → 副道会话开 tab；副道行「停止」只停该轮；`pi-active-panel` 持久化不受影响。
- [ ] **Step 4: Commit**

```bash
git add components/LoopRow.tsx components/LoopsPanel.tsx components/WorkspaceOverview.tsx components/LoopsConfig.tsx components/shell/DesktopShell.tsx components/shell/MobileShell.tsx packages/pi-loop/init.ts
git commit -m "feat(ui): lane-capacity run button, per-lane stop/open, max_parallel in loop config"
```

---

### Task 10: cxin 合同落地（workspace-c 文件，非本 repo）

**Files:**
- Modify: `~/.pi/workspaces/workspace-c/loops/dev-loop/LOOP.md`（本机实际路径 `<repo>/.pi/workspaces/workspace-c/loops/dev-loop/LOOP.md`）

- [ ] **Step 1: frontmatter 加 `max_parallel: 3`**（人手编辑语义；正文不动）
- [ ] **Step 2: 文末追加「并行车道」节**

```markdown
## 九、并行车道（max_parallel > 1 时生效）

本 loop 允许至多 `max_parallel` 条车道并行，每轮跟**一个**品，互不干扰：

- **写权分工**：主车道（持 `.round.lock`：心跳轮、空闲时手动轮）独占 STATE.md 写权；**副车道一律不写 STATE.md**——记录走工作项 events/里程碑 + LEARN/ + workspace git commit。下一个主轮开场对账：STATE 持有项已终态 → 回落 §三选品；选品自动跳过在途项（§三.4）。
- **选品互斥（§三追加）**：副车道候选 = 防双开过滤 + **剔除与任何在途项（loop.started 无终态戳）repositories 有交集的项**；候选全被剔除时可回落同仓，但必须在选品播报中说明。
- **共享咨询态**：loop-ledger.json 断路计数与 budget 余额跨车道共享，并行下可能少数/超支 ≤1 轮——已知偏差，接受，不以锁串行化。
```

- [ ] **Step 3: 验证**：`curl -s localhost:30141/api/workspaces/01KYRBBY917PW4X0VHMY5GC8TE/loops | python3 -m json.tool` 显示 `maxParallel: 3`。
- [ ] **Step 4: 无 git commit**（workspace 文件由 cxin 自己的 workspace repo 管理；提醒用户 `workspace git` 提交）。

---

### Task 11: 协议文档 + AGENTS.md

**Files:**
- Modify: `kit/README.md`（宿主/协议契约）
- Modify: `AGENTS.md`（Loop 章 + file map）

**kit/README.md 追加要点：**
- `max_parallel`（缺省 1）：并行车道上限；槽位驱动——每个 due 槽位主锁忙且未满即开一条副道；`.lastrun` 语义不变（每槽至多开一条新车道）。
- `.lanes/<id>.lock`：宿主文件，agent 禁改禁删；记录形状同 `.round.lock`，同一 stale 公式。
- STATE.md 写权 = 持主锁；副道合同禁写 STATE（记录走 events/LEARN/git）。
- 版本注记：多车道根（max_parallel > 1）上的外部 `pi-loop beat` 必须同版本（旧版 beat 只看主锁，会把容量算少）。
- 容量 advisory：跨宿主并发开道有微小超容窗口。

**AGENTS.md：** Loop 章补「并行车道」小节（同上四条浓缩）+ file map 的 `lanes.ts`/`status-live.ts`/fire.ts 状态更新 + LoopRow/LoopsConfig 条目更新。

- [ ] **Step 1: 文档落地** → **Step 2: Commit**

```bash
git add kit/README.md AGENTS.md
git commit -m "docs(kit): parallel lane protocol (max_parallel, .lanes locks, STATE ownership)"
```

---

## Self-Review 结论

- **Spec 覆盖**：Q1（每轮一品，合同不变）✓；Q2（Task 2/4 槽位驱动 + Task 10 cxin=3）✓；Q3（Task 3 合同行 + Task 10 写权节）✓；Q4（Task 5/6/8/9 runningRounds/按车道停/容量标注/每锁活性）✓；Q5（Task 10 已知偏差节 + kit README）✓；Q6（Task 10 选品互斥节）✓；Q7（本 plan 即 step-2）✓。
- **类型一致性**：`RoundLane`（fire.ts）↔ spawner `RoundDeps.lane` ↔ contract `secondaryLane` ↔ status `RunningRoundEntry.kind`（"primary"|"secondary" 字面量贯穿）✓。
- **缺省不变**：`max_parallel` 缺省 1 → fire/run/stop 全走既有路径，既有测试除 runner 签名外不改语义 ✓。
