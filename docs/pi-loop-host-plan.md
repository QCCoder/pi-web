# pi-loop Host 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成 `pi-loop` 生态包（纯逻辑层 + beat/run/stop/pause/resume/status/init CLI），落地多 loop 并发与补跑语义，并把 pi-web daemon spawner 重构为反向依赖该包。

**Architecture:** 三步咬合——①纯逻辑（发现/cron/锁/due/合同/收割）从 `lib/daemon/` 迁入仓内顶级目录 `pi-loop/`（相对路径导入，独立 package.json 备发布）；②CLI 以纯逻辑组装一次性 beat；③daemon spawner 删掉自己的 slot/busy 机制，改调同一套 fire 序列。多 loop 修复（per-loop 锁、anacron-lite 补跑、D13 ledger per-loop）是纯逻辑层的自然产物，两个宿主同时受益。

**Tech Stack:** TypeScript（仓内 `.ts` + `node --test` `.test.mjs` 直接 import，纯模块无需 jiti）、yaml、node:fs/node:child_process。无新第三方依赖。

**Spec:** `docs/pi-loop-host-design.md`（H1–H7；本计划按 spec 论证，执行者须同时读 spec）。

## Global Constraints

- 禁止 `next build`（dev 期间污染 `.next/`）。
- 测试：`npm test`（本计划会把它扩为 `node --test "lib/**/*.test.mjs" "pi-loop/**/*.test.mjs"`）；typecheck：`node_modules/.bin/tsc --noEmit`。
- 纯模块（pi-loop/）不得 import pi-web 的 lib/（可抽仓性）；`lib/daemon/*` 可 import `../../pi-loop/*`。
- `pi-loop/` 内注释与输出文案：中文，风格随仓内现状。
- `.lastrun` / `.round.lock` 是宿主文件：只有宿主（beat/daemon/fire 层）读写；agent 禁改禁删（写进合同与 kit/README）。
- ledger 位置（D13 修订后）：`loops/<name>/loop-ledger.json`；budget/constraints 仍在根。
- 所有新纯函数对畸形输入「返回 false/undefined、永不抛」（cron.ts 既有契约）。

---

### Task 1: pi-loop 包骨架 + protocol.ts 迁移（含 includePaused）

**Files:**
- Create: `pi-loop/package.json`
- Create: `pi-loop/protocol.ts`（内容 = `lib/daemon/loop-kit.ts` 全量迁移 + includePaused + paused 字段）
- Delete: `lib/daemon/loop-kit.ts`、`lib/daemon/loop-kit.test.mjs`（测试迁移为 `pi-loop/protocol.test.mjs`）
- Modify: `app/api/workspaces/[id]/loops/route.ts`（import 改 `../../../../pi-loop/protocol.ts`）
- Modify: `lib/daemon/loop-spawner.ts`（import 改 `../../pi-loop/protocol.ts`）
- Modify: `package.json`（test script 加 pi-loop glob）
- Test: `pi-loop/protocol.test.mjs`

**Interfaces:**
- Produces: `discoverKitLoops(workspacePath: string, opts?: { includePaused?: boolean }): LoopDeclaration[]`；`LoopDeclaration` 增加可选 `paused?: boolean`（仅 includePaused 路径置 true）；`parseLoopDeclaration` / `isWorkspaceHalted` / `LoopLevel` / `DEFAULT_MAX_MINUTES` / `localTimezone` 签名不变。

- [ ] **Step 1: 迁移测试文件**

`git mv lib/daemon/loop-kit.test.mjs pi-loop/protocol.test.mjs`，文件头 import 改为：

```mjs
import { discoverKitLoops, parseLoopDeclaration, isWorkspaceHalted } from "./protocol.ts";
```

并在文件末尾追加 includePaused 用例：

```mjs
test("discoverKitLoops includePaused 返回暂停 loop 并标记 paused", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-"));
  mkdirSync(join(root, "loops", "a"), { recursive: true });
  writeFileSync(join(root, "loops", "a", "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nbody");
  mkdirSync(join(root, "loops", "b"), { recursive: true });
  writeFileSync(join(root, "loops", "b", "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nbody");
  writeFileSync(join(root, "loops", "b", "PAUSED"), "");
  assert.equal(discoverKitLoops(root).length, 1);            // 默认：暂停即不存在（D11 门控语义）
  const all = discoverKitLoops(root, { includePaused: true });
  assert.equal(all.length, 2);
  assert.equal(all.find((d) => d.loopName === "b")?.paused, true);
  assert.equal(all.find((d) => d.loopName === "a")?.paused ?? false, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test pi-loop/protocol.test.mjs`
Expected: FAIL（`Cannot find module './protocol.ts'`）

- [ ] **Step 3: 建包骨架 + 迁移实现**

`pi-loop/package.json`：

```json
{
  "name": "pi-loop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "pi-loop kit host: pure protocol logic + beat CLI (design: docs/pi-loop-host-design.md)",
  "bin": { "pi-loop": "./cli.ts" },
  "dependencies": { "yaml": "^2.9.0" }
}
```

`pi-loop/protocol.ts` = `lib/daemon/loop-kit.ts` 原内容（文件头注释改为指向 host spec）+ 两处修改：

```ts
export interface LoopDeclaration {
  workspacePath: string;
  loopName: string;
  dir: string;
  pattern: string;
  cron: string;
  timezone: string;
  level: LoopLevel;
  maxMinutes: number;
  body: string;
  /** 仅 includePaused 发现路径置 true（PAUSED 标记存在）。 */
  paused?: boolean;
}
```

`discoverKitLoops` 改为：

```ts
export function discoverKitLoops(
  workspacePath: string,
  opts: { includePaused?: boolean } = {},
): LoopDeclaration[] {
  const loopsDir = join(workspacePath, "loops");
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(loopsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: LoopDeclaration[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(loopsDir, entry.name);
    const paused = existsSync(join(dir, "PAUSED"));
    if (paused && !opts.includePaused) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, "LOOP.md"), "utf8");
    } catch {
      continue;
    }
    const declaration = parseLoopDeclaration(raw, dir, workspacePath);
    if (declaration) {
      if (paused) declaration.paused = true;
      result.push(declaration);
    }
  }
  return result;
}
```

- [ ] **Step 4: 删旧文件、改两处 import、扩 test script**

```bash
git rm lib/daemon/loop-kit.ts
```

`app/api/workspaces/[id]/loops/route.ts` 的 import 改：
```ts
import { discoverKitLoops } from "../../../../pi-loop/protocol.ts";
```
`lib/daemon/loop-spawner.ts` 的 import 改：
```ts
import { discoverKitLoops, isWorkspaceHalted, type LoopDeclaration } from "../../pi-loop/protocol.ts";
```
`package.json` test script：
```json
"test": "node --test \"lib/**/*.test.mjs\" \"pi-loop/**/*.test.mjs\""
```

- [ ] **Step 5: 全量验证 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
Expected: 全绿（迁移的用例 + 新 includePaused 用例通过）

```bash
git add -A && git commit -m "feat(pi-loop): 包骨架 + protocol.ts 迁移（includePaused 变体）"
```

---

### Task 2: cron.ts 迁移 + buildMatcher/nextDue

**Files:**
- Create: `pi-loop/cron.ts`（= `lib/daemon/cron.ts` 重构：matchFields 抽出 + buildMatcher + nextDue）
- Delete: `lib/daemon/cron.ts`、`lib/daemon/cron.test.mjs`（测试迁移为 `pi-loop/cron.test.mjs`）
- Modify: `lib/daemon/loop-spawner.ts`（cron import 改 `../../pi-loop/cron.ts`）
- Test: `pi-loop/cron.test.mjs`

**Interfaces:**
- Produces: `cronMatches(expression: string, timezone: string, now: Date): boolean`（签名不变）；`buildMatcher(expression: string): ((now: Date) => boolean)`（无效表达式返回恒 false 函数，**注意：不含时区**，时区由调用方传给 nextDue/cronMatches）；`nextDue(expression: string, timezone: string, after: Date): Date | undefined`（after 之后第一个命中分钟；366 天硬帽找不到 → undefined）。

- [ ] **Step 1: 迁移测试 + 新增 nextDue 用例**

`git mv lib/daemon/cron.test.mjs pi-loop/cron.test.mjs`，import 改 `./cron.ts`，追加：

```mjs
import { nextDue } from "./cron.ts";

test("nextDue 跨日跨周（周五下午 → 周一 9 点）", () => {
  const fri = new Date("2024-01-12T10:00:00.000Z"); // 周五 18:00 上海
  const due = nextDue("0 9 * * 1", "Asia/Shanghai", fri);
  assert.equal(due?.toISOString(), "2024-01-15T01:00:00.000Z"); // 下周一 09:00 上海
});

test("nextDue 半小时 cron 的下一个槽", () => {
  const t = new Date("2024-01-15T07:05:00.000Z"); // 上海 15:05
  assert.equal(nextDue("*/30 9-22 * * 1-5", "Asia/Shanghai", t)?.toISOString(), "2024-01-15T07:30:00.000Z");
});

test("nextDue 畸形输入返回 undefined 且不抛", () => {
  assert.equal(nextDue("bad", "Asia/Shanghai", new Date()), undefined);
  assert.equal(nextDue("* * * * *", "Asia/Shanghao", new Date()), undefined);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test pi-loop/cron.test.mjs`，Expected: FAIL（nextDue 未导出）

- [ ] **Step 3: 实现**

`pi-loop/cron.ts`：整体迁入 `fieldMatches`（原样），新增：

```ts
function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric",
    month: "numeric", weekday: "short", hourCycle: "h23",
  });
}

function matchFields(fields: string[], fmt: Intl.DateTimeFormat, now: Date): boolean {
  const parts = fmt.formatToParts(now);
  // …原 cronMatches 的 parts 解析 + vixie 日语义，逐行照搬…
}

export function cronMatches(expression: string, timezone: string, now: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  try {
    return matchFields(fields, makeFormatter(timezone), now);
  } catch {
    return false; // 无效时区 — 永不抛契约
  }
}

/** after 之后第一个 cron 命中分钟（分钟对齐 + 下一分钟起搜）。366 天硬帽。 */
export function nextDue(expression: string, timezone: string, after: Date): Date | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = makeFormatter(timezone);
  } catch {
    return undefined;
  }
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const cap = start + 366 * 24 * 60 * 60_000;
  for (let t = start; t <= cap; t += 60_000) {
    if (matchFields(fields, fmt, new Date(t))) return new Date(t);
  }
  return undefined;
}
```

- [ ] **Step 4: 删旧文件、改 spawner import（`../../pi-loop/cron.ts`）、验证、提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): cron 迁移 + nextDue（补跑语义的判定基元）"
```

---

### Task 3: round-lock.ts（跨宿主互斥）

**Files:**
- Create: `pi-loop/round-lock.ts`
- Test: `pi-loop/round-lock.test.mjs`

**Interfaces:**
- Produces:
  - `interface RoundLockHolder { pid: number; host: string; kind: "beat" | "daemon"; sessionId?: string }`
  - `interface RoundLockRecord extends RoundLockHolder { startedAt: number }`
  - `acquireRoundLock(dir: string, holder: RoundLockHolder, opts?: { maxStaleMs?: number }): boolean`
  - `releaseRoundLock(dir: string): void`
  - `readRoundLock(dir: string): RoundLockRecord | undefined`
  - `updateRoundLock(dir: string, patch: Partial<RoundLockHolder>): void`
  - `isProcessAlive(pid: number): boolean`

- [ ] **Step 1: 失败测试**

```mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRoundLock, releaseRoundLock, readRoundLock, updateRoundLock, isProcessAlive } from "./round-lock.ts";

const dir = () => { const d = mkdtempSync(join(tmpdir(), "lock-")); return d; };
const holder = { pid: process.pid, host: "t", kind: "beat" };

test("acquire 成功 → 再 acquire 失败 → release 后可再 acquire", () => {
  const d = dir();
  assert.equal(acquireRoundLock(d, holder), true);
  assert.equal(acquireRoundLock(d, { ...holder, pid: 424242 }), false);
  assert.equal(readRoundLock(d)?.pid, process.pid);
  releaseRoundLock(d);
  assert.equal(acquireRoundLock(d, { ...holder, pid: 424242 }), true);
});

test("stale 锁（死 pid）被抢占", () => {
  const d = dir();
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: 999999, host: "x", kind: "beat", startedAt: Date.now() }));
  assert.equal(acquireRoundLock(d, holder), true);
  assert.equal(readRoundLock(d)?.pid, process.pid);
});

test("stale 锁（超窗）被抢占，未超窗不抢", () => {
  const d = dir();
  const old = Date.now() - 60_000;
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: process.pid, host: "x", kind: "daemon", startedAt: old }));
  assert.equal(acquireRoundLock(d, holder, { maxStaleMs: 1_000 }), true);       // 超窗
  writeFileSync(join(d, ".round.lock"), JSON.stringify({ pid: process.pid, host: "x", kind: "daemon", startedAt: old }));
  assert.equal(acquireRoundLock(d, holder, { maxStaleMs: 120_000 }), false);    // 未超窗且 pid 活
});

test("updateRoundLock 回填 sessionId", () => {
  const d = dir();
  acquireRoundLock(d, { ...holder, kind: "daemon" });
  updateRoundLock(d, { sessionId: "sess-1" });
  assert.equal(readRoundLock(d)?.sessionId, "sess-1");
});

test("isProcessAlive：自己活、999999 死", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test pi-loop/round-lock.test.mjs`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
/** .round.lock — 跨宿主轮互斥锁（host spec §5）。O_EXCL 原子创建；stale = 死 pid 或超窗。 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RoundLockHolder { pid: number; host: string; kind: "beat" | "daemon"; sessionId?: string }
export interface RoundLockRecord extends RoundLockHolder { startedAt: number }

const LOCK_FILE = ".round.lock";
const DEFAULT_MAX_STALE_MS = 60 * 60_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // EPERM = 活着但无权
  }
}

export function readRoundLock(dir: string): RoundLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as RoundLockRecord;
    return typeof parsed?.pid === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function acquireRoundLock(dir: string, holder: RoundLockHolder, opts: { maxStaleMs?: number } = {}): boolean {
  const path = join(dir, LOCK_FILE);
  const existing = readRoundLock(dir);
  if (existing) {
    const stale = !isProcessAlive(existing.pid)
      || Date.now() - existing.startedAt > (opts.maxStaleMs ?? DEFAULT_MAX_STALE_MS);
    if (!stale) return false;
    try { unlinkSync(path); } catch { /* 竞态：别人已抢 */ }
  }
  try {
    writeFileSync(path, JSON.stringify({ ...holder, startedAt: Date.now() }, null, 2), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function releaseRoundLock(dir: string): void {
  try { unlinkSync(join(dir, LOCK_FILE)); } catch { /* ENOENT = 已释放 */ }
}

export function updateRoundLock(dir: string, patch: Partial<RoundLockHolder>): void {
  const current = readRoundLock(dir);
  if (!current) return;
  try { writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ ...current, ...patch }, null, 2)); } catch { /* 尽力 */ }
}
```

- [ ] **Step 4: 验证 + 提交**

Run: `node --test pi-loop/round-lock.test.mjs && npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): .round.lock 跨宿主轮互斥（stale 抢占 + sessionId 回填）"
```

---

### Task 4: due.ts（.lastrun + shouldFire）

**Files:**
- Create: `pi-loop/due.ts`
- Test: `pi-loop/due.test.mjs`

**Interfaces:**
- Consumes: `nextDue`（Task 2）、`LoopDeclaration`（Task 1）
- Produces: `readLastrun(dir: string): Date | undefined`；`writeLastrun(dir: string, at: Date): void`（tmp+rename 原子写）；`shouldFire(declaration: LoopDeclaration, now: Date): boolean`

- [ ] **Step 1: 失败测试**

```mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastrun, writeLastrun, shouldFire } from "./due.ts";

const DECL = (dir: string) => ({ workspacePath: "/ws", loopName: "l", dir, pattern: "l",
  cron: "*/30 * * * *", timezone: "UTC", level: "L1", maxMinutes: 30, body: "" });

test("无 .lastrun → 立即该跑（nextDue 从 epoch 推导早已过）", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:07:00Z")), true);
});

test(".lastrun 在本槽内 → 不该跑；过了下一槽 → 该跑", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  writeLastrun(d, new Date("2024-01-15T10:00:00Z"));
  assert.equal(readFileSync(join(d, ".lastrun"), "utf8").trim(), "2024-01-15T10:00:00.000Z");
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:15:00Z")), false); // :00 槽已跑，:30 未到
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:30:00Z")), true);
});

test("错过三个槽的 .lastrun → 该跑（anacron-lite：补一轮而非三轮，由 fire 层保证只跑一次）", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  writeLastrun(d, new Date("2024-01-15T09:00:00Z"));
  assert.equal(shouldFire(DECL(d), new Date("2024-01-15T10:45:00Z")), true);
});

test("readLastrun 缺省 undefined", () => {
  const d = mkdtempSync(join(tmpdir(), "due-"));
  assert.equal(readLastrun(d), undefined);
});
```

- [ ] **Step 2: 确认失败** — Run: `node --test pi-loop/due.test.mjs`，Expected: FAIL

- [ ] **Step 3: 实现**

```ts
/** .lastrun — 宿主写的机器真相（host spec §6）；STATE.md 的 Last run 行仍是叙事。 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { nextDue } from "./cron.ts";
import type { LoopDeclaration } from "./protocol.ts";

const LASTRUN_FILE = ".lastrun";

export function readLastrun(dir: string): Date | undefined {
  try {
    const raw = readFileSync(join(dir, LASTRUN_FILE), "utf8").trim();
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

export function writeLastrun(dir: string, at: Date): void {
  const target = join(dir, LASTRUN_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, at.toISOString());
  renameSync(tmp, target); // tmp+rename 原子写（先例：session-index）
}

export function shouldFire(declaration: LoopDeclaration, now: Date): boolean {
  const last = readLastrun(declaration.dir)?.getTime() ?? 0;
  const due = nextDue(declaration.cron, declaration.timezone, new Date(last));
  return due !== undefined && now.getTime() >= due.getTime();
}
```

- [ ] **Step 4: 验证 + 提交**

Run: `node --test pi-loop/due.test.mjs && npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): .lastrun + shouldFire（anacron-lite 补跑判定）"
```

---

### Task 5: contract.ts（开场合同参数化 + ledger 路径 D13）

**Files:**
- Create: `pi-loop/contract.ts`（`buildRoundPrompt` 从 `lib/daemon/loop-spawner.ts` 迁出）
- Modify: `lib/daemon/loop-spawner.ts`（删除本地 `buildRoundPrompt`，import `../../pi-loop/contract.ts`）
- Test: `pi-loop/contract.test.mjs`（从 `loop-spawner.test.mjs` 的 prompt 用例迁出改写）

**Interfaces:**
- Consumes: `LoopDeclaration`
- Produces: `buildRoundPrompt(declaration: LoopDeclaration, opts?: { sessionId?: string; extraInstructions?: string }): string`
  - 变化 1：无 `sessionId` 时**不输出**会话 id 规则行（beat 形态）；规则序号动态编排。
  - 变化 2（D13）：ledger 路径从根 `loop-ledger.json` 改为 `${declaration.dir}/loop-ledger.json`（规则 1 与收尾规则两处）。
  - 变化 3：`extraInstructions` 存在时作为附加规则行（`pi-loop run --item` 的「本轮优先处理 <KEY>」）。

- [ ] **Step 1: 失败测试**

```mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildRoundPrompt } from "./contract.ts";

const DECL = { workspacePath: "/ws", loopName: "dev-loop", dir: "/ws/loops/dev-loop",
  pattern: "dev-loop", cron: "0 8 * * 1-5", timezone: "Asia/Shanghai",
  level: "L2", maxMinutes: 45, body: "# 合同指针\n1. 读宪法文件" };

test("daemon 形态：含 sessionId 与 per-loop ledger 路径", () => {
  const prompt = buildRoundPrompt(DECL, { sessionId: "sess-123" });
  assert.ok(prompt.includes("/skill:dev-loop"));
  assert.ok(prompt.includes("sess-123"));
  assert.ok(prompt.includes("/ws/loops/dev-loop/loop-ledger.json"));
  assert.ok(!prompt.includes("loop-ledger.json（宪法文件，你禁改），再读 /ws/loops/dev-loop/loop-ledger.json".replace("/ws/loops/dev-loop/loop-ledger.json（", "XX"))); // 仅路径断言，防双写
  assert.ok(prompt.includes("L2"));
});

test("beat 形态：无 sessionId 行、无裸 ledger 引用", () => {
  const prompt = buildRoundPrompt(DECL);
  assert.ok(!prompt.includes("sess-"));
  assert.ok(prompt.includes("/ws/loops/dev-loop/loop-ledger.json"));
  assert.ok(prompt.includes("PAUSED"));
});

test("extraInstructions 进入规则尾部", () => {
  const prompt = buildRoundPrompt(DECL, { extraInstructions: "本轮优先处理 REQ-0042（工作项绑定触发）" });
  assert.ok(prompt.includes("REQ-0042"));
});
```

- [ ] **Step 2: 确认失败** — Run: `node --test pi-loop/contract.test.mjs`，Expected: FAIL

- [ ] **Step 3: 实现**（规则数组 + 动态编号；文案沿用 spawner 现版，仅按 Interfaces 三处变化修改）

```ts
import type { LoopDeclaration } from "./protocol.ts";

export function buildRoundPrompt(
  declaration: LoopDeclaration,
  opts: { sessionId?: string; extraInstructions?: string } = {},
): string {
  const rules: string[] = [
    `先读 loop-constraints.md、loop-budget.md、${declaration.dir}/loop-ledger.json（宪法文件，你禁改），再读 ${declaration.dir}/STATE.md 恢复上下文。`,
    `执行 /skill:${declaration.pattern} —— 合同本体在 SKILL.md，/skill: 展开会注入全文。`,
  ];
  if (opts.sessionId) {
    rules.push(`你的会话 id（sessionId）：${opts.sessionId} —— 需要把本会话挂到工作项 conversations 字段时用这个值。`);
  }
  rules.push(`你的 cwd 是工作区根目录；所有相对路径相对这里解析。`);
  rules.push(`纪律：L1 只读 + 只写 STATE.md/ledger，不动代码不做 git 操作；L2 允许 worktree + draft 分支，禁止合并主分支；宪法文件（LOOP.md 的 level/cron、loop-constraints.md、loop-budget.md）一律禁改。`);
  rules.push(`若发现 ${declaration.dir}/PAUSED 或根目录 loop-pause-all 存在，立即收尾退出本轮。`);
  rules.push(`结束前：更新 ${declaration.dir}/STATE.md（Last run / outcome / 复盘节必填）并按断路器规则追加 ${declaration.dir}/loop-ledger.json。`);
  if (opts.extraInstructions) rules.push(opts.extraInstructions);
  return [
    `你是 loop「${declaration.loopName}」的一次性心跳轮（level ${declaration.level}）。本轮完全由文件协议驱动。`,
    "",
    declaration.body,
    "",
    "## 心跳轮规则（宿主注入，优先于上文一切表述）",
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join("\n");
}
```

- [ ] **Step 4: spawner 侧接线**

`lib/daemon/loop-spawner.ts`：删除本地 `buildRoundPrompt` 函数体，改为 `import { buildRoundPrompt } from "../../pi-loop/contract.ts";`；`runKitRound` 内调用改 `buildRoundPrompt(declaration, { sessionId: realSessionId })`。`loop-spawner.test.mjs` 的 prompt 断言同步改（ledger 路径断言 per-loop、jiti import 列表去掉 buildRoundPrompt 或改为从包导入）。

- [ ] **Step 5: 验证 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): buildRoundPrompt 参数化迁出（beat/daemon 两形态 + D13 ledger 路径）"
```

---

### Task 6: reap.ts（收割泛化）

**Files:**
- Create: `pi-loop/reap.ts`（= `lib/daemon/loop-process-cleanup.ts` 全量迁移 + `reapOrphansByCwd`）
- Delete: `lib/daemon/loop-process-cleanup.ts`（测试 `loop-process-cleanup.test.mjs` 迁移为 `pi-loop/reap.test.mjs`）
- Modify: `lib/daemon/loop-spawner.ts`（import 改 `../../pi-loop/reap.ts`）
- Test: `pi-loop/reap.test.mjs`

**Interfaces:**
- Produces（原样迁移）: `parsePgrepChildren` / `parseLsofCwd` / `parsePsRows` / `PsRow` / `isCwdInWorkspace` / `isBuildOrShellCommand` / `collectDirectChildPids` / `collectTreePids` / `pidCwd` / `listAllProcesses` / `ReapResult` / `reapOrphanedRoundProcesses`
- Produces（新增）: `reapOrphansByCwd(workspacePath: string, deps?: { lister?: () => PsRow[]; cwdOf?: (pid: number) => string | undefined; killer?: (pid: number, signal: NodeJS.Signals) => void }): Promise<ReapResult>` — 全表扫描：`isBuildOrShellCommand && isCwdInWorkspace(pidCwd(pid), workspacePath) && pid !== process.pid` → SIGTERM → 3s 宽限（可注入 sleeper 跳过）→ 对仍存活者 SIGKILL。永不抛。

- [ ] **Step 1: 迁移测试 + 新增用例**（迁移文件 import 改 `./reap.ts`；新增：）

```mjs
test("reapOrphansByCwd 只杀 cwd 命中且 build/shell 的进程，跳过自己", async () => {
  const killed: Array<[number, string]> = [];
  const rows = [
    { pid: 101, command: "npm run build", cwd: "/ws/repositories/x" },
    { pid: 102, command: "node server.js", cwd: "/elsewhere" },
    { pid: process.pid, command: "sh -c build", cwd: "/ws" },
  ];
  const result = await reapOrphansByCwd("/ws", {
    lister: () => rows,
    cwdOf: (pid) => rows.find((r) => r.pid === pid)?.cwd,
    killer: (pid, signal) => killed.push([pid, signal]),
  });
  assert.deepEqual(killed, [[101, "SIGTERM"], [101, "SIGKILL"]]); // 宽限期后仍"存活"（killer 是 mock，进程表不变）
  assert.equal(result.terminated, 1);
});
```

（`ReapResult` 字段以迁移后实际为准，断言按 `terminated` 计数适配。）

- [ ] **Step 2: 确认失败** — Run: `node --test pi-loop/reap.test.mjs`，Expected: FAIL

- [ ] **Step 3: 实现**（迁移 + 追加）

```ts
export async function reapOrphansByCwd(
  workspacePath: string,
  deps: { lister?: () => PsRow[]; cwdOf?: (pid: number) => string | undefined; killer?: (pid: number, signal: NodeJS.Signals) => void; sleeper?: (ms: number) => Promise<void> } = {},
): Promise<ReapResult> {
  const lister = deps.lister ?? listAllProcesses;
  const cwdOf = deps.cwdOf ?? pidCwd;
  const killer = deps.killer ?? ((pid, signal) => { try { process.kill(pid, signal); } catch { /* 已退出 */ } });
  const sleeper = deps.sleeper ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  const targets = lister().filter((row) =>
    row.pid !== process.pid
    && isBuildOrShellCommand(row.command)
    && isCwdInWorkspace(cwdOf(row.pid), workspacePath));
  const result: ReapResult = { terminated: 0, candidates: targets.map((t) => t.pid) };
  for (const row of targets) killer(row.pid, "SIGTERM");
  await sleeper(3_000);
  for (const row of targets) if (isProcessAliveStrict(killer, row.pid)) killer(row.pid, "SIGKILL");
  result.terminated = targets.length;
  return result;
}

function isProcessAliveStrict(killer: (pid: number, s: NodeJS.Signals) => void, pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
```

（若 `ReapResult` 实际形状不同，以迁移文件为准适配——计划允许执行者按真实类型微调字段名，但「TERM→宽限→KILL、永不抛」的行为契约不变。）

- [ ] **Step 4: 删旧、改 import（spawner）、验证、提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): 收割迁移 + reapOrphansByCwd（宿主无关的 cwd 收敛收割）"
```

---

### Task 7: fire.ts（统一 fire 序列）

**Files:**
- Create: `pi-loop/fire.ts`
- Test: `pi-loop/fire.test.mjs`

**Interfaces:**
- Consumes: Task 3/4 全部
- Produces:
  - `type FireResult = "fired" | "skipped" | "busy"`
  - `runDueRound(declaration: LoopDeclaration, holder: RoundLockHolder, runner: () => Promise<void>, deps?: { now?: () => Date }): Promise<FireResult>` — shouldFire → acquire（stale 窗 = `maxMinutes*60_000 + 15*60_000`）→ **锁内复查 shouldFire**（等锁期间他宿主可能已 fire）→ writeLastrun → runner → finally release
  - `runNow(declaration, holder, runner): Promise<Exclude<FireResult, "skipped">>` — 无 due 判定（手动），其余同上

- [ ] **Step 1: 失败测试**

```mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLastrun } from "./due.ts";
import { runDueRound, runNow } from "./fire.ts";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "fire-"));
  const dir = join(root, "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\nmax_minutes: 5\n---\nb");
  return { root, dir, decl: { workspacePath: root, loopName: "l", dir, pattern: "l", cron: "*/30 * * * *", timezone: "UTC", level: "L1", maxMinutes: 5, body: "b" } };
};
const holder = { pid: process.pid, host: "t", kind: "beat" };

test("未到期 → skipped，runner 不跑、.lastrun 不写", async () => {
  const { dir, decl } = setup();
  writeLastrun(dir, new Date("2024-01-15T10:00:00Z"));
  let ran = 0;
  const result = await runDueRound(decl, holder, async () => { ran++; }, { now: () => new Date("2024-01-15T10:15:00Z") });
  assert.equal(result, "skipped");
  assert.equal(ran, 0);
});

test("到期 → fired，runner 跑、.lastrun 前进、锁释放", async () => {
  const { dir, decl } = setup();
  writeLastrun(dir, new Date("2024-01-15T10:00:00Z"));
  const result = await runDueRound(decl, holder, async () => {}, { now: () => new Date("2024-01-15T10:31:00Z") });
  assert.equal(result, "fired");
  assert.equal(readLastrunIso(dir), "2024-01-15T10:31:00.000Z");
  assert.equal(exists(join(dir, ".round.lock")), false);
});

test("runner 抛错 → 错误向上传播，锁仍释放", async () => {
  const { dir, decl } = setup();
  await assert.rejects(runDueRound(decl, holder, async () => { throw new Error("boom"); }, { now: () => new Date("2024-01-15T10:31:00Z") }));
  assert.equal(exists(join(dir, ".round.lock")), false);
});

test("锁被他宿主持有 → busy", async () => {
  const { dir, decl } = setup();
  writeFileSync(join(dir, ".round.lock"), JSON.stringify({ pid: process.pid, host: "other", kind: "daemon", startedAt: Date.now() }));
  const result = await runDueRound(decl, holder, async () => {}, { now: () => new Date("2024-01-15T10:31:00Z") });
  assert.equal(result, "busy");
});

test("runNow 无视 due，同样写 .lastrun + 释放锁", async () => {
  const { dir, decl } = setup();
  writeLastrun(dir, new Date("2024-01-15T10:00:00Z"));
  const result = await runNow(decl, holder, async () => {});
  assert.equal(result, "fired");
  assert.equal(readLastrunIso(dir) > "2024-01-15T10:00", true); // 真实 now 前进
});
```

（顶部补 `import { existsSync as exists } from "node:fs"` 与 `readLastrunIso = (d) => readFileSync(join(d, ".lastrun"), "utf8").trim()` 的 helper。）

- [ ] **Step 2: 确认失败** — Run: `node --test pi-loop/fire.test.mjs`，Expected: FAIL

- [ ] **Step 3: 实现**

```ts
/** 统一 fire 序列（host spec §5 时序）：daemon tick 与 beat 共用，跨宿主 TOCTOU 安全。 */
import { acquireRoundLock, releaseRoundLock, type RoundLockHolder } from "./round-lock.ts";
import { shouldFire, writeLastrun } from "./due.ts";
import type { LoopDeclaration } from "./protocol.ts";

export type FireResult = "fired" | "skipped" | "busy";

export async function runDueRound(
  declaration: LoopDeclaration,
  holder: RoundLockHolder,
  runner: () => Promise<void>,
  deps: { now?: () => Date } = {},
): Promise<FireResult> {
  const now = deps.now ?? (() => new Date());
  if (!shouldFire(declaration, now())) return "skipped";
  if (!acquireRoundLock(declaration.dir, holder, { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 })) return "busy";
  try {
    if (!shouldFire(declaration, now())) return "skipped"; // 锁内复查
    writeLastrun(declaration.dir, now());
    await runner();
    return "fired";
  } finally {
    releaseRoundLock(declaration.dir);
  }
}

export async function runNow(
  declaration: LoopDeclaration,
  holder: RoundLockHolder,
  runner: () => Promise<void>,
): Promise<"fired" | "busy"> {
  if (!acquireRoundLock(declaration.dir, holder, { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 })) return "busy";
  try {
    writeLastrun(declaration.dir, new Date());
    await runner();
    return "fired";
  } finally {
    releaseRoundLock(declaration.dir);
  }
}
```

- [ ] **Step 4: 验证 + 提交**

Run: `node --test pi-loop/fire.test.mjs && npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): fire.ts 统一 fire 序列（due→lock→复查→lastrun→run→release）"
```

---

### Task 8: beat runner + cli（beat/run/stop/pause/resume）

**Files:**
- Create: `pi-loop/beat.ts`
- Create: `pi-loop/cli.ts`
- Test: `pi-loop/beat.test.mjs`

**Interfaces:**
- Consumes: Task 1–7 全部
- Produces:
  - `piBinary(): string`（env `PI_BIN` 覆盖，默认 `"pi"`）
  - `beatRoundRunner(declaration: LoopDeclaration, opts?: { extraInstructions?: string }): Promise<void>` — spawn `pi --name "<loop> · <slot>" -p --approve "<合同>"`（cwd=root，detached 独立进程组）；`max_minutes` 超时 → 组 SIGTERM → 3s → SIGKILL → reject；非零退出 reject
  - `beatRoot(root: string): Promise<{ fired: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }>` — halt 检查 → 逐 declaration `runDueRound`（runner 失败 → `reapOrphansByCwd(root)` + failed 记录）
  - `stopRound(root: string, name: string): Promise<{ ok: boolean; message: string }>` — 读锁：beat → 组 TERM→KILL + reap；daemon → `{ ok: false, message: "由 pi-web daemon 持有，请在 pi-web 界面停止" }`
  - cli 子命令：`beat [--root]`（exit 0/1）、`run <name> [--item KEY] [--root]`、`stop <name> [--root]`、`pause <name>` / `resume <name> [--root]`（写/删 `loops/<name>/PAUSED`）

- [ ] **Step 1: 失败测试**（fake pi，不依赖真 pi）

```mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beatRoot, beatRoundRunner, stopRound } from "./beat.ts";

function fakePi(dir: string, body: string): string {
  const bin = join(dir, "fake-pi.sh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}
function setup(root = mkdtempSync(join(tmpdir(), "beat-"))) {
  const dir = join(root, "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\nmax_minutes: 1\n---\nb");
  return { root, dir };
}

test("beatRoot 到期起轮：.lastrun 写入、锁释放、fake pi 收到合同", async () => {
  const { root, dir } = setup();
  // fake pi 的 argv: $1=--name $2=<名> $3=-p $4=--approve $5=<合同> — 把合同落盘供断言
  process.env.PI_BIN = fakePi(root, `echo "$5" > "${join(root, "prompt.txt")}"`);
  const result = await beatRoot(root);
  assert.deepEqual(result.fired, ["l"]);
  assert.ok(existsSync(join(dir, ".lastrun")));
  assert.ok(!existsSync(join(dir, ".round.lock")));
  const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
  assert.ok(prompt.includes("一次性心跳轮"));
  delete process.env.PI_BIN;
});

test("beatRoot 未到期 → skipped，不起进程", async () => {
  const { root, dir } = setup();
  writeFileSync(join(dir, ".lastrun"), new Date().toISOString()); // 刚跑过，*/30 未到
  process.env.PI_BIN = fakePi(root, `echo bad > ${join(root, "should-not-exist")}`);
  const result = await beatRoot(root);
  assert.deepEqual(result.skipped, ["l"]);
  assert.ok(!existsSync(join(root, "should-not-exist")));
  delete process.env.PI_BIN;
});

test("stopRound 杀掉 beat 持有的睡眠轮", async () => {
  const { root, dir } = setup();
  process.env.PI_BIN = fakePi(root, "sleep 60");
  const round = beatRoundRunner({ workspacePath: root, loopName: "l", dir, pattern: "l", cron: "* * * * *", timezone: "UTC", level: "L1", maxMinutes: 5, body: "b" });
  await new Promise((r) => setTimeout(r, 300)); // 等锁落盘
  const outcome = await stopRound(root, "l");
  assert.equal(outcome.ok, true);
  await assert.rejects(round); // 被杀 → exit 非 0 → runner reject，且不悬挂
});

test("stopRound 对 daemon 持有的锁给出指引", async () => {
  const { root, dir } = setup();
  writeFileSync(join(dir, ".round.lock"), JSON.stringify({ pid: process.pid, host: "h", kind: "daemon", sessionId: "s1", startedAt: Date.now() }));
  const outcome = await stopRound(root, "l");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /pi-web/);
});
```

（第 3 个用例中 `await round` 预期 reject——断言方式：`await assert.rejects(round)`，按实现落定。）

- [ ] **Step 2: 确认失败** — Run: `node --test pi-loop/beat.test.mjs`，Expected: FAIL

- [ ] **Step 3: 实现 beat.ts**

```ts
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { buildRoundPrompt } from "./contract.ts";
import { discoverKitLoops, isWorkspaceHalted, type LoopDeclaration } from "./protocol.ts";
import { runDueRound, runNow } from "./fire.ts";
import { readRoundLock } from "./round-lock.ts";
import { reapOrphansByCwd } from "./reap.ts";

export function piBinary(): string {
  return process.env.PI_BIN ?? "pi";
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* 组已消失 */ }
}

export function beatRoundRunner(declaration: LoopDeclaration, opts: { extraInstructions?: string } = {}): Promise<void> {
  const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
  const prompt = buildRoundPrompt(declaration, { extraInstructions: opts.extraInstructions });
  return new Promise<void>((resolve, reject) => {
    const child = spawn(piBinary(), ["--name", `${declaration.loopName} · ${slot}`, "-p", "--approve", prompt], {
      cwd: declaration.workspacePath, detached: true, stdio: "ignore",
    });
    if (!child.pid) { reject(new Error("spawn failed")); return; }
    const timer = setTimeout(() => {
      killGroup(child.pid!, "SIGTERM");
      setTimeout(() => killGroup(child.pid!, "SIGKILL"), 3_000).unref?.();
    }, declaration.maxMinutes * 60_000);
    timer.unref?.();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`round exited code=${code ?? "-"} signal=${signal ?? "-"}`));
    });
  });
}

export interface BeatReport { fired: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }

export async function beatRoot(root: string): Promise<BeatReport> {
  const report: BeatReport = { fired: [], skipped: [], failed: [] };
  if (isWorkspaceHalted(root)) return report;
  for (const declaration of discoverKitLoops(root)) {
    const holder = { pid: process.pid, host: hostname(), kind: "beat" as const };
    try {
      const result = await runDueRound(declaration, holder, () => beatRoundRunner(declaration));
      if (result === "fired") report.fired.push(declaration.loopName);
      else report.skipped.push(declaration.loopName + (result === "busy" ? "（本轮已在跑）" : ""));
    } catch (error) {
      try { await reapOrphansByCwd(root); } catch { /* 收割不得掩盖轮错误 */ }
      report.failed.push({ name: declaration.loopName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export async function stopRound(root: string, name: string): Promise<{ ok: boolean; message: string }> {
  const lock = readRoundLock(join(root, "loops", name));
  if (!lock) return { ok: false, message: `loop「${name}」没有在跑的轮` };
  if (lock.kind === "daemon") return { ok: false, message: "由 pi-web daemon 持有，请在 pi-web 界面停止" };
  killGroup(lock.pid, "SIGTERM");
  setTimeout(() => killGroup(lock.pid, "SIGKILL"), 3_000).unref?.();
  await reapOrphansByCwd(root).catch(() => undefined);
  return { ok: true, message: `已终止 loop「${name}」的轮（pid ${lock.pid}）` };
}
```

（`run <name> [--item]` 与 `pause/resume` 在 cli.ts 直排 `runNow` + `beatRoundRunner({extraInstructions})` 与 PAUSED 写删，见 Step 4。）

- [ ] **Step 4: 实现 cli.ts**（零依赖 argv 解析）

```ts
#!/usr/bin/env node
/** pi-loop CLI — kit loop 的心跳宿主（design: docs/pi-loop-host-design.md §4）。 */
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { discoverKitLoops } from "./protocol.ts";
import { runNow } from "./fire.ts";
import { beatRoot, beatRoundRunner, stopRound } from "./beat.ts";

const [command, ...args] = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = opt("--root") ?? process.cwd();
const usage = 2;
const die = (message: string, code = usage): never => { console.error(message); process.exit(code); };

async function main(): Promise<void> {
  if (command === "beat") {
    const report = await beatRoot(root);
    for (const name of report.fired) console.log(`[pi-loop] fired  ${name}`);
    for (const name of report.skipped) console.log(`[pi-loop] skip   ${name}`);
    for (const failure of report.failed) console.error(`[pi-loop] FAILED ${failure.name}: ${failure.error}`);
    process.exit(report.failed.length > 0 ? 1 : 0);
  }
  if (command === "run") {
    const name = args[0];
    if (!name) die("用法: pi-loop run <name> [--item KEY] [--root .]");
    const declaration = discoverKitLoops(root, { includePaused: true }).find((d) => d.loopName === name)
      ?? die(`未找到 loop「${name}」（${join(root, "loops", name, "LOOP.md")}）`, 1);
    const item = opt("--item");
    const result = await runNow(declaration, { pid: process.pid, host: hostname(), kind: "beat" },
      () => beatRoundRunner(declaration, item ? { extraInstructions: `本轮优先处理 ${item}（工作项绑定触发）` } : {}));
    console.log(result === "fired" ? `[pi-loop] 已起轮 ${name}` : `[pi-loop] ${name} 本轮已在跑`);
    process.exit(result === "fired" ? 0 : 1);
  }
  if (command === "stop") {
    const outcome = await stopRound(root, args[0] ?? die("用法: pi-loop stop <name>"));
    console.log(outcome.message);
    process.exit(outcome.ok ? 0 : 1);
  }
  if (command === "pause" || command === "resume") {
    const marker = join(root, "loops", args[0] ?? die(`用法: pi-loop ${command} <name>`), "PAUSED");
    if (command === "pause") writeFileSync(marker, "");
    else { try { unlinkSync(marker); } catch { /* 本就未暂停 */ } }
    console.log(`[pi-loop] ${command === "pause" ? "已暂停" : "已恢复"} ${args[0]}`);
    return;
  }
  if (command === "watch") {
    console.log(`[pi-loop] watch ${root}（30s tick，Ctrl-C 退出）`);
    const tick = () => void beatRoot(root).catch((e) => console.error("[pi-loop] tick failed:", e));
    tick();
    setInterval(tick, 30_000);
    return;
  }
  die("用法: pi-loop <beat|watch|run|stop|pause|resume> ...（status/init 随下一任务交付）");
}

void main();
```

- [ ] **Step 5: 验证 + 提交**

Run: `node --test pi-loop/beat.test.mjs && npm test && node_modules/.bin/tsc --noEmit`
（本任务交付的 cli 不含 status/init 分支——它们随 Task 9 落地，避免引用未交付模块。）

```bash
git add -A && git commit -m "feat(pi-loop): beat runner + CLI（beat/run/stop/pause/resume/watch）"
```

---

### Task 9: status + init + kit 模板重构（D13 布局）

**Files:**
- Modify: `kit/templates/basic/`（重构为 `root/` + `loop/` 两层：root = loop-constraints.md、loop-budget.md；loop = LOOP.md、STATE.md、loop-ledger.json）
- Create: `pi-loop/status.ts`、`pi-loop/init.ts`
- Modify: `pi-loop/cli.ts`（补 status/init 分支，代码已在 Task 8 Step 4 给出）
- Test: `pi-loop/status.test.mjs`、`pi-loop/init.test.mjs`

**Interfaces:**
- Produces:
  - `collectStatus(root: string): Array<{ name; pattern; level; cron; timezone; maxMinutes; paused: boolean; running: boolean; lastRun?: string; nextDue?: string }>`
  - `initLoop(root: string, opts: { name: string; cron: string; pattern?: string; level?: "L1"|"L2"|"L3"; maxMinutes?: number; timezone?: string }): void`

- [ ] **Step 1: 模板重构**

```bash
cd kit/templates/basic && mkdir -p root loop
git mv loop-constraints.md loop-budget.md root/
git mv LOOP.md STATE.md loop-ledger.json loop/
```

（模板内文不动——per-loop ledger 路径由合同文本负责，模板正文里「追加 loop-ledger.json」的相对表述在 loop/ 目录下天然正确。）

- [ ] **Step 2: status/init 失败测试**

```mjs
// pi-loop/status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStatus } from "./status.ts";

test("paused 可见并标记；running 由活锁判定；nextDue 由 .lastrun 推导", () => {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  const a = join(root, "loops", "a"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\n---\nb");
  writeFileSync(join(a, ".lastrun"), "2024-01-15T10:00:00.000Z");
  const b = join(root, "loops", "b"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "LOOP.md"), "---\ncron: \"*/5 * * * *\"\n---\nb");
  writeFileSync(join(b, "PAUSED"), "");
  writeFileSync(join(b, ".round.lock"), JSON.stringify({ pid: process.pid, host: "h", kind: "daemon", startedAt: Date.now() }));
  const entries = collectStatus(root);
  const ea = entries.find((e) => e.name === "a")!;
  const eb = entries.find((e) => e.name === "b")!;
  assert.equal(ea.paused, false);
  assert.equal(ea.running, false);
  assert.equal(ea.nextDue, "2024-01-15T10:30:00.000Z");
  assert.equal(eb.paused, true);
  assert.equal(eb.running, true); // 自己 pid 的活锁
});
```

```mjs
// pi-loop/init.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { initLoop } from "./init.ts";

test("init 脚手架：五件套落位（ledger 在 loop 目录）+ frontmatter 定制 + .lastrun=now", () => {
  const root = mkdtempSync(join(tmpdir(), "init-"));
  initLoop(root, { name: "triage", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai", maxMinutes: 20 });
  assert.ok(existsSync(join(root, "loops", "triage", "LOOP.md")));
  assert.ok(existsSync(join(root, "loops", "triage", "STATE.md")));
  assert.ok(existsSync(join(root, "loops", "triage", "loop-ledger.json")));
  assert.ok(existsSync(join(root, "loop-constraints.md")));
  assert.ok(existsSync(join(root, "loop-budget.md")));
  assert.ok(existsSync(join(root, "loops", "triage", ".lastrun")));
  const loop = readFileSync(join(root, "loops", "triage", "LOOP.md"), "utf8");
  const front = parse(loop.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]) as Record<string, unknown>;
  assert.equal(front.cron, "0 9 * * 1-5");
  assert.equal(front.max_minutes, 20);
  assert.equal(front.name, "triage");
});

test("init 幂等保护：已存在的 root 宪法文件不覆盖", () => {
  const root = mkdtempSync(join(tmpdir(), "init2-"));
  initLoop(root, { name: "x", cron: "* * * * *" });
  writeFileSync(join(root, "loop-budget.md"), "# 人工改过");
  initLoop(root, { name: "y", cron: "* * * * *" });
  assert.equal(readFileSync(join(root, "loop-budget.md"), "utf8"), "# 人工改过");
});
```

- [ ] **Step 3: 确认失败** — Run: `node --test pi-loop/status.test.mjs pi-loop/init.test.mjs`，Expected: FAIL

- [ ] **Step 4: 实现**

`pi-loop/status.ts`：

```ts
import { discoverKitLoops } from "./protocol.ts";
import { readLastrun } from "./due.ts";
import { nextDue } from "./cron.ts";
import { readRoundLock, isProcessAlive } from "./round-lock.ts";

export interface LoopStatusEntry {
  name: string; pattern: string; level: string; cron: string; timezone: string; maxMinutes: number;
  paused: boolean; running: boolean; lastRun?: string; nextDue?: string;
}

export function collectStatus(root: string): LoopStatusEntry[] {
  return discoverKitLoops(root, { includePaused: true }).map((declaration) => {
    const lock = readRoundLock(declaration.dir);
    const running = !!lock && isProcessAlive(lock.pid)
      && Date.now() - lock.startedAt <= declaration.maxMinutes * 60_000 + 15 * 60_000;
    const last = readLastrun(declaration.dir);
    const next = nextDue(declaration.cron, declaration.timezone, last ?? new Date(0));
    return {
      name: declaration.loopName, pattern: declaration.pattern, level: declaration.level,
      cron: declaration.cron, timezone: declaration.timezone, maxMinutes: declaration.maxMinutes,
      paused: declaration.paused ?? false, running,
      lastRun: last?.toISOString(), nextDue: next?.toISOString(),
    };
  });
}
```

`pi-loop/init.ts`：

```ts
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify, parse } from "yaml";
import { writeLastrun } from "./due.ts";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "kit", "templates", "basic");

export function initLoop(root: string, opts: {
  name: string; cron: string; pattern?: string; level?: "L1" | "L2" | "L3"; maxMinutes?: number; timezone?: string;
}): void {
  const dir = join(root, "loops", opts.name);
  mkdirSync(dir, { recursive: true });
  // root 宪法（存在即跳过 — 人工内容优先）
  for (const file of ["loop-constraints.md", "loop-budget.md"]) {
    if (!existsSync(join(root, file))) copyFileSync(join(TEMPLATES, "root", file), join(root, file));
  }
  // loop 五件套（存在即跳过 — 不得覆盖既有 loop）
  for (const file of ["STATE.md", "loop-ledger.json"]) {
    if (!existsSync(join(dir, file))) copyFileSync(join(TEMPLATES, "loop", file), join(dir, file));
  }
  // LOOP.md：模板 frontmatter + 定制
  const raw = readFileSync(join(TEMPLATES, "loop", "LOOP.md"), "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("模板 LOOP.md 损坏");
  const front = parse(match[1]) as Record<string, unknown>;
  front.name = opts.name;
  front.cron = opts.cron;
  if (opts.pattern) front.pattern = opts.pattern;
  if (opts.level) front.level = opts.level;
  if (opts.maxMinutes) front.max_minutes = opts.maxMinutes;
  if (opts.timezone) front.timezone = opts.timezone;
  writeFileSync(join(dir, "LOOP.md"), `---\n${stringify(front)}---\n${match[2]}`);
  writeLastrun(dir, new Date()); // 首轮等自然槽（host spec §6）
}
```

（TEMPLATES 相对解析对 `node pi-loop/cli.ts` 与测试进程都成立——仓库内相对 `pi-loop/` 上溯一级到仓根再进 `kit/`。发布抽仓时模板随包走，改这一处常量。）

- [ ] **Step 5: cli 补 status/init 分支**

`pi-loop/cli.ts` 顶部追加 import，`main()` 的 watch 分支前插入两分支：

```ts
import { initLoop } from "./init.ts";
import { collectStatus } from "./status.ts";

// main() 内，watch 分支之前：
  if (command === "status") {
    for (const entry of collectStatus(root)) {
      const state = entry.running ? "running" : entry.paused ? "paused" : `next ${entry.nextDue ?? "?"}`;
      console.log(`${entry.name}\t${entry.cron}\t${entry.level}\t${state}\tlast ${entry.lastRun ?? "-"}`);
    }
    return;
  }
  if (command === "init") {
    const name = opt("--name") ?? die("用法: pi-loop init --name <n> --cron <expr> [--pattern] [--level] [--max-minutes] [--timezone] [--root]");
    initLoop(root, {
      name,
      cron: opt("--cron") ?? die("--cron 必填"),
      pattern: opt("--pattern"),
      level: opt("--level") as "L1" | "L2" | "L3" | undefined,
      maxMinutes: opt("--max-minutes") ? Number(opt("--max-minutes")) : undefined,
      timezone: opt("--timezone"),
    });
    console.log(`[pi-loop] 已创建 loops/${name}（五件套 + .lastrun=now，首轮等自然槽）`);
    return;
  }
```

末尾 usage 字符串同步加上 `status|init`。

- [ ] **Step 6: 验证 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "feat(pi-loop): status/init + kit 模板 D13 布局（root/loop 两层）"
```

---

### Task 10: daemon spawner 重构（反向依赖包，删 slot/busy）

**Files:**
- Modify: `lib/daemon/loop-spawner.ts`（核心改造）
- Modify: `lib/daemon/jobs.ts` / `lib/daemon/host.ts`（如 import 路径受牵连则同步；预计无改动）
- Test: `lib/daemon/loop-spawner.test.mjs`（重写调度用例）

**Interfaces:**
- Consumes: `runDueRound` / `RoundLockHolder` / `updateRoundLock`（Task 3/7）、`buildRoundPrompt`（Task 5，已在 Task 5 接线）
- Produces: `LoopKitSpawner` 对外不变（DaemonJob `id = "loop-kit-heartbeats"`）；`SpawnerDeps.runRound` 签名扩为 `(declaration: LoopDeclaration, hooks?: { onSessionStart?: (sessionId: string) => void }) => Promise<string>`；`runKitRound` 增加可选 `onSessionStart` deps。

- [ ] **Step 1: 重写调度测试**（替换现有 slot-dedup/busy 用例）

```mjs
// 新增/替换的核心用例（沿用 jiti 装载模式）：
test("tick：due 的 loop 起轮并写 .lastrun 与 daemon 锁（含 sessionId 回填）；未 due 跳过", async () => {
  const root = mkdtempSync(join(tmpdir(), "spawner-"));
  const dir = join(root, "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\nmax_minutes: 5\n---\nb");
  const seen: string[] = [];
  const spawner = new LoopKitSpawner({
    discover: async () => [{ id: "ws", path: root, available: true }],
    discoverLoops: async (path: string) => discoverKitLoops(path),
    halted: async () => false,
    runRound: async (decl, hooks) => {
      hooks?.onSessionStart?.("sess-42");
      seen.push(decl.loopName);
      return "sess-42";
    },
    now: () => new Date("2024-01-15T10:31:00Z"),
  });
  await spawner.tick();
  assert.deepEqual(seen, ["l"]);                       // due（.lastrun 缺省 → 立即）
  assert.equal(readFileSync(join(dir, ".lastrun"), "utf8").trim(), "2024-01-15T10:31:00.000Z");
  assert.ok(!existsSync(join(dir, ".round.lock")));    // 轮结束即释放
  // 再 tick 同一时刻 → 未 due（.lastrun=10:31 已写到未来? no——now 是 10:31，lastrun=10:31，nextDue=11:00）
  await spawner.tick();
  assert.equal(seen.length, 1);
});

test("双宿主互斥：beat 锁在场 → tick 跳过该 loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "spawner-"));
  const dir = join(root, "loops", "l");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: \"*/30 * * * *\"\ntimezone: UTC\nmax_minutes: 5\n---\nb");
  writeFileSync(join(dir, ".round.lock"), JSON.stringify({ pid: process.pid, host: "beat-host", kind: "beat", startedAt: Date.now() }));
  let ran = 0;
  const spawner = new LoopKitSpawner({
    discover: async () => [{ id: "ws", path: root, available: true }],
    discoverLoops: async (path: string) => discoverKitLoops(path),
    halted: async () => false,
    runRound: async () => { ran++; return "sess-x"; },
    now: () => new Date("2024-01-15T10:31:00Z"),
  });
  await spawner.tick();
  assert.equal(ran, 0); // beat 活锁在场，daemon 让位
});
```

- [ ] **Step 2: 确认失败** — Run: `node --test lib/daemon/loop-spawner.test.mjs`，Expected: FAIL

- [ ] **Step 3: 实现**

`lib/daemon/loop-spawner.ts` 改造：

```ts
// 删除：emittedSlots / busyWorkspaces / evictStaleSlots / EMITTED_SLOT_TTL_MS
// 删除 tick 里的 slot 记录与 break（多 loop 各自 due）
import { runDueRound } from "../../pi-loop/fire.ts";
import { updateRoundLock } from "../../pi-loop/round-lock.ts";
import { hostname } from "node:os";

export class LoopKitSpawner implements DaemonJob {
  readonly id = "loop-kit-heartbeats";
  private timer?: ReturnType<typeof setInterval>;
  private readonly deps: Required<SpawnerDeps>;

  async tick(): Promise<void> {
    for (const workspace of await this.deps.discover()) {
      if (!workspace.available) continue;
      if (await Promise.resolve(this.deps.halted(workspace.path))) continue;
      for (const declaration of await this.deps.discoverLoops(workspace.path)) {
        const holder = { pid: process.pid, host: hostname(), kind: "daemon" as const };
        try {
          await runDueRound(declaration, holder, async () => {
            await this.deps.runRound(declaration, {
              onSessionStart: (sessionId) => updateRoundLock(declaration.dir, { sessionId }),
            });
          }, { now: this.deps.now });
        } catch (error) {
          console.error(`[loop-kit] round failed for ${workspace.id}/${declaration.loopName}:`, error);
        }
      }
    }
  }
  // start/stop 原样
}
```

`runKitRound` 增加 `deps.onSessionStart?: (sessionId: string) => void`，在 `startRpcSession` 解构出 `realSessionId` 后立即调用（锁内回填，供 stop 路由用——surface plan 消费）。`buildRoundPrompt` 调用已是 Task 5 形态。

- [ ] **Step 4: 全量回归 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "refactor(daemon): spawner 反向依赖 pi-loop 包 — 删 slot/busy，统一 due+锁 fire 序列"
```

---

### Task 11: workspace-c 迁移 + 协议文档收口

**Files:**
- Modify: `~/.pi/workspaces/workspace-c/`（git mv ledger + 提交）
- Modify: `kit/README.md`（宿主文件条款 + beat 用法 + 多 loop 语义 + D13 布局）
- Modify: `docs/pi-loop-kit-design.md`（§5/§9/D13 处加修订横幅指向 host spec）
- Modify: `AGENTS.md`（Loop 章节 + File Map 增补 pi-loop/）

- [ ] **Step 1: workspace-c ledger 迁移**

```bash
cd ~/.pi/workspaces/workspace-c && git mv loop-ledger.json loops/dev-loop/loop-ledger.json && git commit -m "refactor: D13 修订 — ledger per-loop（host spec §7）"
```

（STATE.md 的 `[BUDGET]` 自报快照不变；constraints.md 里「见 loop-ledger.json」的相对表述在语义上仍指向 per-loop 文件，若正文有根路径字样则一并修正。）

- [ ] **Step 2: kit/README.md 增补**（协议契约文档，执行者按下列要点扩写，保持既有文风）

- 文件布局节：`loops/<name>/` 增列 `.lastrun`、`.round.lock`（**宿主文件：agent 禁改禁删**；宿主 = daemon spawner / pi-loop beat）；ledger 位置改 `loops/<name>/loop-ledger.json`；
- 新增「宿主」一节：本地 = pi-web daemon（自动）或 `pi-loop beat`（任意 cron：crontab `* * * * * pi-loop beat --root <path>`）；双宿主并存安全（锁互斥）；`pi-loop run/stop/pause/resume/status/init` 命令表（照 host spec §4）；
- 补跑语义一句话：错过槽位恢复后至多补一轮（`.lastrun` 推导）；
- 多 loop：per-loop 并行由锁保证；budget/constraints 根共享。

- [ ] **Step 3: kit-design 文档修订横幅 + AGENTS.md 增补**

`docs/pi-loop-kit-design.md`：§5 表格「执行模型」处、§9 spawner 描述处、D13 决策行各加一行 `> 修订（2026-08-30，见 docs/pi-loop-host-design.md）：…`。
`AGENTS.md`：Loop 章节补 pi-loop 包与 beat/双宿主/补跑语义；File Map `lib/daemon/` 相邻处加 `pi-loop/` 目录条目（protocol/cron/round-lock/due/contract/reap/fire/beat/cli/status/init 一行一个）。

- [ ] **Step 4: 验证 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
```bash
git add -A && git commit -m "docs(kit): 协议收口 — 宿主文件条款/beat 用法/D13 修订横幅/AGENTS File Map"
```

---

### Task 12（可选，验收后按需）: watch 冒烟

watch 已随 Task 8 的 cli 分支交付（30s tick 循环调 `beatRoot`）。本任务仅在需要时补一个守护化示例到 kit/README（launchd/systemd unit 样例），不新增代码。默认跳过。

---

## 验收对照（spec §15）

| # | spec 验收 | 任务 |
|---|---|---|
| 1 | 双 loop 独立起轮互不干扰 | T7/T8（per-loop due+锁）+ T10 回归 |
| 2 | 停 90 分钟恢复恰补一轮 | T4（shouldFire）+ T7（fire 只跑一次）+ T8 冒烟 |
| 3 | 双宿主零双发 | T3（锁）+ T7（busy）+ T10（daemon 锁） |
| 4 | stop 清场 | T8（stopRound + reap） |
| 5 | daemon 回归全绿、workspace-c 行为不变 | T10 + T11 |
| 6 | kit/README 反映新语义 | T11 |

## 执行注意

- Task 8 与 Task 9 有一次顺序内调整：cli 的 status/init 分支随 Task 9 落地（Task 8 交付的 cli 不含这两个分支，避免占位 import）。
- spawner 测试的 jiti 装载模式保持（rpc-manager 参数属性限制）。
- 不要在本计划里动 surface spec 的内容（includePaused 已属 host：status 需要；工作项绑定/管理面路由一律不做）。
