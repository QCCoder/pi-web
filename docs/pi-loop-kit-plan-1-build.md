# pi-loop kit 建设期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不触碰 v3 loop 引擎的前提下，落地 pi-loop kit 的协议规范、模板库与 daemon 心跳 spawner（env 旗子门控），为拆除期（`docs/pi-loop-kit-plan-2-teardown.md`）做准备。

**Architecture:** 纯协议文件（`kit/`）+ 纯解析层（`lib/daemon/loop-kit.ts`）+ 轮执行核心与 DaemonJob（`lib/daemon/loop-spawner.ts`）。spawner 复用现有 `cronMatches`（搬到 `lib/daemon/cron.ts`）、`startRpcSession`、`reapOrphanedRoundProcesses`、work-items service 与 `archiveSession`，不新建任何持久状态（无 RUNS.jsonl、无 orchestrator 索引）。

**Tech Stack:** TypeScript ESM（`.ts` 后缀导入）、`yaml` v2（已是依赖）、node:test（`*.test.mjs`）。

**Spec:** `docs/pi-loop-kit-design.md`（本计划从 spec 立论；执行者两个都要读）

## Global Constraints

- **绝不运行 `next build`**（污染 `.next/` 破坏 `npm run dev`）。
- Typecheck：`node_modules/.bin/tsc --noEmit`；测试：`npm test`（node:test over `lib/**/*.test.mjs`）。
- **本阶段是 additive**：v3 引擎（`lib/loop/` 除 `process-cleanup.ts` 被引用外、LoopHostScheduler、loop 路由）行为不得变化；spawner 一律由 `PI_LOOP_KIT=1` 门控注册。
- `lib/daemon/rpc-manager.ts` 是 daemon 进程专属，web 侧代码不得导入。
- 新代码一律 ESM + `.ts` 扩展名导入（跟随现有风格）。
- spawner 不写任何新状态文件：运行记录 = STATE.md（agent 写）+ workspace git log（D9 事后钩子只回填 work-items `conversations` 与归档轮会话）。

---

### Task 1: kit 协议规范 + 基础模板

**Files:**
- Create: `kit/README.md`
- Create: `kit/templates/basic/LOOP.md`
- Create: `kit/templates/basic/STATE.md`
- Create: `kit/templates/basic/loop-constraints.md`
- Create: `kit/templates/basic/loop-budget.md`
- Create: `kit/templates/basic/loop-ledger.json`
- Create: `kit/templates/github/loop.yml`

**Interfaces:**
- Produces: kit 模板库（phase 1 手动复制，无 CLI）。`LOOP.md` frontmatter 字段（`name/pattern/cron/timezone?/level/max_minutes`）是 Task 3 `parseLoopDeclaration` 的输入契约；正文是 Task 4 `buildRoundPrompt` 注入的开场合同。

- [ ] **Step 1: 写 `kit/README.md`（规范性协议文档）**

```markdown
# pi-loop kit — 文件即程序

一套跑在任何有 pi 的仓库/workspace 上的 loop 协议：协议文件 + agent 冷启动读文件 + cron 心跳。
设计全文见 pi-web 仓库 `docs/pi-loop-kit-design.md`。

## 声明（D5：文件即声明）

`loops/<name>/LOOP.md` 存在即 loop 存在，删除即消失。没有能力开关、manifest 字段、中央注册表。

## 文件布局

    loops/<loop-name>/LOOP.md          # 声明 + 合同指针（frontmatter 机器读，正文模型读）
    loops/<loop-name>/STATE.md         # 记忆脊柱：每轮读写，唯一运行状态
    loops/<loop-name>/PAUSED           # 暂停标记（存在即跳过起轮，D12）
    loop-constraints.md                # 绑定约束（宪法文件，agent 禁改）
    loop-budget.md                     # token/轮数预算（宪法文件，agent 禁改）
    loop-ledger.json                   # 断路器账本（agent 可追加，禁删改历史）
    .agents/skills/<pattern>/SKILL.md  # 模式合同（本轮做什么、产出什么、如何写 STATE）
    .pi/agents/*.md                    # 角色（maker/checker/brainstorm…）
    .pi/settings.json                  # 社区 pi 包依赖（仅 GitHub 场景声明 subagent 包）
    loop-pause-all                     # 全 workspace 停跳标记（根目录，存在即全停）

三份宪法文件与账本位于仓库/workspace **根**，被该根下所有 loop **共享**（D13）：`loop-budget.md`
是全 workspace 总帽；STATE.md 的 `[BUDGET]` 节只是本轮视角自报，不是权威计数。

## LOOP.md frontmatter

    ---
    name: dev-loop          # 可选，缺省取目录名
    pattern: dev-loop       # 可选，对应 .agents/skills/<pattern>/，缺省取 name
    cron: "0 8 * * 1-5"     # 必填，5 字段 Vixie cron；daemon spawner / Actions 镜像解析
    timezone: Asia/Shanghai # 可选，缺省取系统本地时区
    level: L1               # L1 report-only / L2 assisted / L3 unattended，缺省 L1
    max_minutes: 30         # 单轮进程超时，缺省 30
    ---

## 权限分级（L1/L2/L3）

- **L1 report-only**：只读 + 写 STATE.md/ledger，不动代码不 git。新 loop 强制起步级。
- **L2 assisted**：可改代码；硬规则：worktree 隔离 → maker/checker 分离 → 只开 draft 分支/PR，人类合并。
- **L3 unattended**：L2 连续 7 天 verifier 通过且零 escalated 误判后，人手动改 LOOP.md 晋级；
  即使 L3 也只允许自动合并白名单路径（docs/测试）。
- 晋级与"agent 禁自改宪法"写进每份 SKILL.md 硬条款。

## 断路器（loop-ledger.json）

`{ "attempts": [{ "at": "...", "item": "REQ-0042", "error": "...", "digest": "..." }], "consecutiveFailures": 0 }`
同一 error digest 连续 3 次、或单项尝试 >3 → 本轮停止该项并在 STATE.md 标 escalated。

## 预算（loop-budget.md）

超 80% 转 report-only；超 90% 只能在 STATE.md `[BUDGET]` 节**请求**提额，人改预算文件后才生效。

## 调参指引

选择/执行合并后，无事可做的 tick 也付开场判断成本：cron 粒度 ≥30min 起步，
`loop-budget.md` 设每日轮数帽。观察 STATE.md 复盘节再收紧。

## GitHub Actions 场景

复制 `templates/github/loop.yml`，schedule 与 LOOP.md 的 cron 保持一致；
轮进程用 `pi -p --approve "<开场合同>"`（headless，凭证走 repo secrets），
subagent 等通用能力经 `.pi/settings.json` 声明社区包（D10：仅此场景）。
```

- [ ] **Step 2: 写 basic 模板文件**

`kit/templates/basic/LOOP.md`：

```markdown
---
cron: "*/30 * * * *"
level: L1
max_minutes: 30
---

# 本轮合同指针

1. 读 loop-constraints.md 与 loop-budget.md（绑定，禁改）
2. 读 STATE.md 恢复上下文
3. 执行 /skill:{{pattern}}
4. 更新 STATE.md（Last run / 分区 / 复盘节必填）并按断路器规则追加 loop-ledger.json
5. L1 纪律：只读 + 只写 STATE.md/ledger，不动代码不做 git 操作
```

`kit/templates/basic/STATE.md`：

```markdown
# Loop State — {{name}}

Last run: （未运行） · outcome: —

## High Priority（等待人或循环正在处理）
- （无）

## Watch List
- （无）

## Recent Noise（本轮忽略）
- （无）

## [BUDGET]
- 今日已用 ~0 / 上限见 loop-budget.md（本节为自报快照，非权威计数）

## Post-run critique
- （首轮：无）
```

`kit/templates/basic/loop-constraints.md`：

```markdown
# Loop Constraints（宪法文件 — agent 禁改）

- 路径黑名单：.env*、secrets/**、auth/**、payments/**、migrations/** 一律只读不写。
- 先测试后修：修复必须先有失败用例（或明确说明为何不可测）。
- 单轮单修：一轮只处理一个 High Priority 项。
- 尝试上限：单项 ≤3 次，同一错误连续 3 次即 escalated（见 loop-ledger.json）。
- push/merge：本轮（L1）不执行任何 git 写操作；升级 level 需人手动改 LOOP.md。
- 宪法文件（本文件 / loop-budget.md / LOOP.md 的 level 字段）agent 一律禁改。
- 发现 loops/{{name}}/PAUSED 或根目录 loop-pause-all 存在 → 立即收尾退出本轮。
```

`kit/templates/basic/loop-budget.md`：

```markdown
# Loop Budget（宪法文件 — agent 禁改）

- 每日 token 上限：1,000,000
- 每日最大轮数：8
- 每轮最大 subagent 派生数：8
- 超过 80% → 本轮起转 report-only；超过 90% → 仅可在 STATE.md [BUDGET] 节请求提额。
```

`kit/templates/basic/loop-ledger.json`：

```json
{
  "attempts": [],
  "consecutiveFailures": 0
}
```

- [ ] **Step 3: 写 GitHub Actions workflow 模板**

`kit/templates/github/loop.yml`（占位符 `{{name}}`/`{{pattern}}` 手动替换）：

```yaml
name: loop-{{name}}
on:
  schedule:
    - cron: "*/30 * * * *"   # 与 loops/{{name}}/LOOP.md 的 cron 保持一致
  workflow_dispatch: {}
jobs:
  round:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @earendil-works/pi-coding-agent@latest
      - name: Run loop round
        env:
          ANTHROPIC_API_KEY: ${{ secrets.PI_PROVIDER_KEY }}
        run: |
          pi -p --approve "读 loop-constraints.md 与 loop-budget.md（绑定，禁改）；读 loops/{{name}}/STATE.md 恢复上下文；执行 /skill:{{pattern}}；结束前更新 loops/{{name}}/STATE.md 并按断路器规则追加 loop-ledger.json。L1 纪律：只读 + 只写 STATE.md/ledger。"
```

- [ ] **Step 4: 自查并提交**

检查：模板里 `{{name}}`/`{{pattern}}` 占位符语义一致；README 与 spec（`docs/pi-loop-kit-design.md` §4/§7）无矛盾。

```bash
git add kit/
git commit -m "feat(kit): pi-loop kit protocol spec + basic/github templates"
```

---

### Task 2: `cronMatches` 搬家到 `lib/daemon/cron.ts`

v3 拆除期会删除 `lib/loop/scheduler.ts`；spawner 现在起就从不将被删的模块导入。

**Files:**
- Create: `lib/daemon/cron.ts`
- Create: `lib/daemon/cron.test.mjs`
- Modify: `lib/loop/scheduler.ts`（删除 `fieldMatches`/`cronMatches` 本体，改为 import + re-export）
- Modify: `lib/loop/scheduler.test.mjs`（删除已搬走的 cron 用例）

**Interfaces:**
- Produces: `cronMatches(expression: string, timezone: string, now: Date): boolean`（`lib/daemon/cron.ts`）— Task 6 spawner 直接导入。`lib/loop/scheduler.ts` re-export 保持既有导入方不变。

- [ ] **Step 1: 写失败测试 `lib/daemon/cron.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { cronMatches } from "./cron.ts";

const shanghaiMonday15 = new Date("2024-01-15T07:05:00.000Z"); // 15:05 Asia/Shanghai, 周一

test("every minute", () => {
  assert.equal(cronMatches("* * * * *", "Asia/Shanghai", shanghaiMonday15), true);
});

test("hour and weekday match", () => {
  assert.equal(cronMatches("5 15 * * 1", "Asia/Shanghai", shanghaiMonday15), true);
});

test("weekday mismatch", () => {
  assert.equal(cronMatches("5 15 * * 2", "Asia/Shanghai", shanghaiMonday15), false);
});

test("range and step", () => {
  assert.equal(cronMatches("1-30/5 14-16 * * *", "Asia/Shanghai", shanghaiMonday15), true);
  assert.equal(cronMatches("1-30/7 14-16 * * *", "Asia/Shanghai", shanghaiMonday15), false);
});

test("restricted both day fields uses OR (Vixie)", () => {
  assert.equal(cronMatches("5 15 20 * 1", "Asia/Shanghai", shanghaiMonday15), true); // 周一命中（日 20 不命中）
});

test("malformed expression returns false, never throws", () => {
  assert.equal(cronMatches("not a cron", "Asia/Shanghai", shanghaiMonday15), false);
  assert.equal(cronMatches("* * * *", "Asia/Shanghai", shanghaiMonday15), false);
});

test("timezone shifts the match", () => {
  // 07:05 UTC = 15:05 上海 / 02:05 纽约（前一日的 2 点）
  assert.equal(cronMatches("5 15 * * *", "America/New_York", shanghaiMonday15), false);
  assert.equal(cronMatches("5 2 * * *", "America/New_York", shanghaiMonday15), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test lib/daemon/cron.test.mjs`
Expected: FAIL — `Cannot find module './cron.ts'`

- [ ] **Step 3: 建 `lib/daemon/cron.ts`（代码从 `lib/loop/scheduler.ts` 原样搬移）**

```ts
/** Vixie-cron matching (moved from lib/loop/scheduler.ts ahead of the v3
 *  teardown — kit spawner and the legacy scheduler share it until then). */

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    if (range === "*") return value % step === 0;
    const [startRaw, endRaw] = range.split("-");
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end
      && (value - start) % step === 0;
  });
}

export function cronMatches(expression: string, timezone: string, now: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric",
    month: "numeric", weekday: "short", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const values = [Number(get("minute")), Number(get("hour")), Number(get("day")), Number(get("month")), weekdays[get("weekday")]];
  if (![0, 1, 3].every((index) => fieldMatches(fields[index], values[index]))) return false;
  const dayOfMonth = fieldMatches(fields[2], values[2]);
  const dayOfWeek = fieldMatches(fields[4], values[4]);
  // Vixie cron semantics: when both day fields are restricted, either may match.
  if (fields[2] !== "*" && fields[4] !== "*") return dayOfMonth || dayOfWeek;
  return dayOfMonth && dayOfWeek;
}
```

同时改 `lib/loop/scheduler.ts`：删除其内联的 `fieldMatches` + `cronMatches` 定义，顶部加：

```ts
import { cronMatches } from "../daemon/cron.ts";
export { cronMatches };
```

并在 `lib/loop/scheduler.test.mjs` 删除搬走的用例（grep `cronMatches` 定位；保留 scheduler.tick 相关用例）。

- [ ] **Step 4: 运行测试与 typecheck**

Run: `node --test lib/daemon/cron.test.mjs lib/loop/scheduler.test.mjs && node_modules/.bin/tsc --noEmit`
Expected: 全部 PASS，typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/cron.ts lib/daemon/cron.test.mjs lib/loop/scheduler.ts lib/loop/scheduler.test.mjs
git commit -m "refactor: move cronMatches to lib/daemon/cron.ts (kit spawner prerequisite)"
```

---

### Task 3: LOOP.md 声明解析与发现（纯函数）

**Files:**
- Create: `lib/daemon/loop-kit.ts`
- Create: `lib/daemon/loop-kit.test.mjs`

**Interfaces:**
- Produces:
  - `type LoopLevel = "L1" | "L2" | "L3"`
  - `interface LoopDeclaration { workspacePath, loopName, dir, pattern, cron, timezone, level, maxMinutes, body }`
  - `parseLoopDeclaration(raw: string, dir: string, workspacePath: string): LoopDeclaration | undefined`
  - `discoverKitLoops(workspacePath: string): LoopDeclaration[]`（目录无 `loops/` → `[]`；`PAUSED` 跳过；坏 LOOP.md 跳过不抛）
  - `isWorkspaceHalted(workspacePath: string): boolean`（根目录 `loop-pause-all` 存在）
  - `localTimezone(): string`
- Task 4/5/6 与拆除期 Task 4（web 侧 kit-loops 列表路由）都消费这些签名。

- [ ] **Step 1: 写失败测试 `lib/daemon/loop-kit.test.mjs`**

用 `node:fs` 的 `mkdtempSync` 造临时 workspace（跟随 `lib/loop/authoring.test.mjs` 的既有做法）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLoopDeclaration, discoverKitLoops, isWorkspaceHalted, localTimezone } from "./loop-kit.ts";

const LOOP_MD = `---
name: smoke
cron: "0 8 * * 1-5"
level: L2
max_minutes: 45
---

# 本轮合同指针
1. 读宪法文件
`;

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "kit-ws-"));
}

test("parseLoopDeclaration full frontmatter", () => {
  const dir = "/ws/loops/smoke";
  const decl = parseLoopDeclaration(LOOP_MD, dir, "/ws");
  assert.equal(decl.loopName, "smoke");
  assert.equal(decl.pattern, "smoke"); // pattern 缺省取 name
  assert.equal(decl.cron, "0 8 * * 1-5");
  assert.equal(decl.level, "L2");
  assert.equal(decl.maxMinutes, 45);
  assert.equal(decl.workspacePath, "/ws");
  assert.equal(decl.dir, dir);
  assert.ok(decl.body.includes("本轮合同指针"));
});

test("defaults: level L1, max_minutes 30, timezone = local, explicit pattern wins", () => {
  const decl = parseLoopDeclaration("---\ncron: \"* * * * *\"\npattern: dev-loop\n---\nbody", "/ws/loops/x", "/ws");
  assert.equal(decl.level, "L1");
  assert.equal(decl.maxMinutes, 30);
  assert.equal(decl.pattern, "dev-loop");
  assert.equal(decl.timezone, localTimezone());
});

test("missing cron or bad yaml -> undefined", () => {
  assert.equal(parseLoopDeclaration("---\nname: x\n---\n", "/ws/loops/x", "/ws"), undefined);
  assert.equal(parseLoopDeclaration("no frontmatter at all", "/ws/loops/x", "/ws"), undefined);
  assert.equal(parseLoopDeclaration("---\n: :\n---\n", "/ws/loops/x", "/ws"), undefined);
});

test("invalid level falls back to L1", () => {
  const decl = parseLoopDeclaration("---\ncron: \"* * * * *\"\nlevel: L9\n---\n", "/ws/loops/x", "/ws");
  assert.equal(decl.level, "L1");
});

test("discoverKitLoops: finds, skips PAUSED, skips broken", () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws, "loops", "a"), { recursive: true });
    writeFileSync(join(ws, "loops", "a", "LOOP.md"), LOOP_MD);
    mkdirSync(join(ws, "loops", "paused"), { recursive: true });
    writeFileSync(join(ws, "loops", "paused", "LOOP.md"), LOOP_MD);
    writeFileSync(join(ws, "loops", "paused", "PAUSED"), "");
    mkdirSync(join(ws, "loops", "broken"), { recursive: true });
    writeFileSync(join(ws, "loops", "broken", "LOOP.md"), "garbage");
    const found = discoverKitLoops(ws);
    assert.deepEqual(found.map((d) => d.loopName), ["a"]);
    assert.equal(discoverKitLoops(join(ws, "no-such")), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("isWorkspaceHalted", () => {
  const ws = makeWorkspace();
  try {
    assert.equal(isWorkspaceHalted(ws), false);
    writeFileSync(join(ws, "loop-pause-all"), "");
    assert.equal(isWorkspaceHalted(ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test lib/daemon/loop-kit.test.mjs`
Expected: FAIL — `Cannot find module './loop-kit.ts'`

- [ ] **Step 3: 实现 `lib/daemon/loop-kit.ts`**

```ts
/** pi-loop kit 协议的纯解析层（design: docs/pi-loop-kit-design.md §4）。
 *  纯 fs + yaml，无 daemon 依赖 —— web 进程（kit-loops 列表路由）亦可导入。 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";

export type LoopLevel = "L1" | "L2" | "L3";

export interface LoopDeclaration {
  workspacePath: string;
  loopName: string;
  /** `<workspace>/loops/<loopName>` — LOOP.md/STATE.md 所在目录。 */
  dir: string;
  /** SKILL.md 合同的 skill 名（`.agents/skills/<pattern>/`）；缺省取 loopName。 */
  pattern: string;
  cron: string;
  timezone: string;
  level: LoopLevel;
  maxMinutes: number;
  /** frontmatter 之下的正文 — 开场合同（人类/模型可读）。 */
  body: string;
}

export const DEFAULT_MAX_MINUTES = 30;

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function parseLoopDeclaration(
  raw: string,
  dir: string,
  workspacePath: string,
): LoopDeclaration | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const cron = typeof record.cron === "string" ? record.cron.trim() : "";
  if (!cron) return undefined; // cron 必填（无 cron 即非 kit loop）
  const loopName = basename(dir);
  const pattern = typeof record.pattern === "string" && record.pattern.trim()
    ? record.pattern.trim() : loopName;
  const rawLevel = typeof record.level === "string" ? record.level.trim().toUpperCase() : "L1";
  const level: LoopLevel = rawLevel === "L2" || rawLevel === "L3" ? rawLevel : "L1";
  const maxMinutes = typeof record.max_minutes === "number" && record.max_minutes > 0
    ? record.max_minutes : DEFAULT_MAX_MINUTES;
  const timezone = typeof record.timezone === "string" && record.timezone.trim()
    ? record.timezone.trim() : localTimezone();
  return { workspacePath, loopName, dir, pattern, cron, timezone, level, maxMinutes, body: match[2].trim() };
}

export function discoverKitLoops(workspacePath: string): LoopDeclaration[] {
  const loopsDir = join(workspacePath, "loops");
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(loopsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: LoopDeclaration[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(loopsDir, entry.name);
    if (existsSync(join(dir, "PAUSED"))) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, "LOOP.md"), "utf8");
    } catch {
      continue;
    }
    const declaration = parseLoopDeclaration(raw, dir, workspacePath);
    if (declaration) result.push(declaration);
  }
  return result;
}

export function isWorkspaceHalted(workspacePath: string): boolean {
  return existsSync(join(workspacePath, "loop-pause-all"));
}
```

- [ ] **Step 4: 运行测试**

Run: `node --test lib/daemon/loop-kit.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/loop-kit.ts lib/daemon/loop-kit.test.mjs
git commit -m "feat(kit): LOOP.md declaration parsing + discovery (pure)"
```

---

### Task 4: 轮执行核心（buildRoundPrompt / waitForRoundSettle / runKitRound）

**Files:**
- Create: `lib/daemon/loop-spawner.ts`
- Create: `lib/daemon/loop-spawner.test.mjs`

**Interfaces:**
- Consumes: `startRpcSession(sessionId, sessionFile, cwd, toolNames?, options?) => Promise<{ session: AgentSessionWrapper; realSessionId: string }>`（`lib/daemon/rpc-manager.ts:1259`；一次性会话传 `("", "", workspacePath)`）；`AgentSessionWrapper.send / onEvent / onDestroy / destroy`；`creationTimeoutSignal(ms, message) => { signal, dispose }`（`lib/abort-race.ts:76`）；`reapOrphanedRoundProcesses(workspacePath, graceMs?)`（`lib/loop/process-cleanup.ts:178`）。
- Produces:
  - `buildRoundPrompt(declaration: LoopDeclaration, sessionId: string): string`
  - `waitForRoundSettle(session: AgentSessionWrapper, prompt: string, timeoutMs: number): Promise<void>`
  - `runKitRound(declaration: LoopDeclaration, deps?: RoundDeps): Promise<string>`（返回 realSessionId；Task 5 的 bookkeeping 在其尾部调用）
  - `interface RoundDeps { starter?: typeof startRpcSession; reaper?: typeof reapOrphanedRoundProcesses }`（测试注入）

- [ ] **Step 1: 写失败测试（假会话 + 注入 starter/reaper）**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildRoundPrompt, waitForRoundSettle, runKitRound } from "./loop-spawner.ts";

const DECL = {
  workspacePath: "/ws", loopName: "dev-loop", dir: "/ws/loops/dev-loop",
  pattern: "dev-loop", cron: "0 8 * * 1-5", timezone: "Asia/Shanghai",
  level: "L2", maxMinutes: 45, body: "# 合同指针\n1. 读宪法文件",
};

test("buildRoundPrompt embeds skill pointer, session id, level rules, protocol files", () => {
  const prompt = buildRoundPrompt(DECL, "sess-123");
  assert.ok(prompt.includes("/skill:dev-loop"));
  assert.ok(prompt.includes("sess-123"));
  assert.ok(prompt.includes("loop-constraints.md"));
  assert.ok(prompt.includes("loop-budget.md"));
  assert.ok(prompt.includes("loop-ledger.json"));
  assert.ok(prompt.includes("STATE.md"));
  assert.ok(prompt.includes("L2"));
  assert.ok(prompt.includes("loop-pause-all"));
});

/** Minimal AgentSessionWrapper fake — the trio the spawner uses. */
function makeFakeSession({ doneDelayMs = 0 } = {}) {
  const listeners = new Set();
  const destroyListeners = new Set();
  const calls = [];
  const session = {
    sentCommands: calls,
    send: async (command) => {
      calls.push(command);
      if (command.type === "prompt") {
        setTimeout(() => {
          for (const cb of listeners) cb({ type: "prompt_done" });
        }, doneDelayMs);
      }
      return null;
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onDestroy(cb) {
      destroyListeners.add(cb);
      return () => destroyListeners.delete(cb);
    },
    destroy() {
      calls.push({ type: "__destroy__" });
      for (const cb of destroyListeners) cb();
    },
  };
  return session;
}

test("runKitRound happy path: creates one-shot session, names it, settles", async () => {
  const fake = makeFakeSession();
  const started = [];
  const sid = await runKitRound(DECL, {
    starter: async (sessionId, file, cwd) => {
      started.push({ sessionId, file, cwd });
      return { session: fake, realSessionId: "real-1" };
    },
    reaper: async () => ({ workspacePath: "/ws", killedPids: [], targetRoots: [] }),
  });
  assert.equal(sid, "real-1");
  assert.deepEqual(started, [{ sessionId: "", file: "", cwd: "/ws" }]);
  const nameCmd = fake.sentCommands.find((c) => c.type === "set_session_name");
  assert.ok(nameCmd && nameCmd.name.startsWith("dev-loop · "));
  assert.ok(fake.sentCommands.some((c) => c.type === "prompt" && c.message.includes("/skill:dev-loop")));
});

test("timeout path: destroy + reap, and the error propagates", async () => {
  const fake = makeFakeSession({ doneDelayMs: 10_000 });
  const reaped = [];
  await assert.rejects(
    runKitRound({ ...DECL, maxMinutes: 0.005 }, { // 0.005min = 300ms
      starter: async () => ({ session: fake, realSessionId: "real-2" }),
      reaper: async (ws) => { reaped.push(ws); return { workspacePath: ws, killedPids: [], targetRoots: [] }; },
    }),
    /timed out/,
  );
  assert.ok(fake.sentCommands.some((c) => c.type === "__destroy__"));
  assert.deepEqual(reaped, ["/ws"]);
});

test("prompt_error rejects the round", async () => {
  const fake = makeFakeSession();
  const listeners = [];
  fake.send = async (command) => {
    if (command.type === "prompt") {
      setTimeout(() => {
        for (const cb of listeners) cb({ type: "prompt_error", errorMessage: "boom" });
      }, 0);
    }
    return null;
  };
  fake.onEvent = (cb) => { listeners.push(cb); return () => {}; };
  const reaped = [];
  await assert.rejects(
    runKitRound(DECL, {
      starter: async () => ({ session: fake, realSessionId: "real-3" }),
      reaper: async (ws) => { reaped.push(ws); return { workspacePath: ws, killedPids: [], targetRoots: [] }; },
    }),
    /boom/,
  );
  assert.deepEqual(reaped, ["/ws"]);
});
```

注意：happy-path 测试会走到 `settleRoundBookkeeping`（Task 5 实现）——本任务先让 `runKitRound` 尾部调用一个**空实现** `settleRoundBookkeeping`（`export async function settleRoundBookkeeping(): Promise<void> {}`），Task 5 填充真体并补测试。本任务的 happy-path 测试因此注入不了 workspace 文件也不会炸。

- [ ] **Step 2: 运行确认失败**

Run: `node --test lib/daemon/loop-spawner.test.mjs`
Expected: FAIL — module 不存在

- [ ] **Step 3: 实现 `lib/daemon/loop-spawner.ts`**

```ts
/** pi-loop kit 心跳 spawner（design: docs/pi-loop-kit-design.md §5/§9）。
 *  一轮 = 一次性 AgentSession：开场合同（含 /skill: 展开）→ settle → 事后钩子。
 *  无 RUNS.jsonl、无 orchestrator 索引 — 运行记录 = STATE.md + workspace git log。 */
import { creationTimeoutSignal } from "../abort-race.ts";
import { reapOrphanedRoundProcesses } from "../loop/process-cleanup.ts";
import { startRpcSession, type AgentSessionWrapper } from "./rpc-manager.ts";
import type { LoopDeclaration } from "./loop-kit.ts";

/** 开场合同：LOOP.md 正文 + spawner 注入的硬规则（含会话 id，供 agent 自行挂
 *  conversations；D9 的事后钩子会兜底回填）。 */
export function buildRoundPrompt(declaration: LoopDeclaration, sessionId: string): string {
  return [
    `你是 loop「${declaration.loopName}」的一次性心跳轮（level ${declaration.level}）。本轮完全由文件协议驱动。`,
    "",
    declaration.body,
    "",
    "## 心跳轮规则（spawner 注入，优先于上文一切表述）",
    `1. 先读 loop-constraints.md、loop-budget.md、loop-ledger.json（宪法文件，你禁改），再读 ${declaration.dir}/STATE.md 恢复上下文。`,
    `2. 执行 /skill:${declaration.pattern} —— 合同本体在 SKILL.md，/skill: 展开会注入全文。`,
    `3. 你的会话 id（sessionId）：${sessionId} —— 需要把本会话挂到工作项 conversations 字段时用这个值。`,
    "4. 你的 cwd 是工作区根目录；所有相对路径相对这里解析。",
    `5. 纪律：L1 只读 + 只写 STATE.md/ledger，不动代码不做 git 操作；L2 允许 worktree + draft 分支，禁止合并主分支；宪法文件（LOOP.md 的 level/cron、loop-constraints.md、loop-budget.md）一律禁改。`,
    `6. 若发现 ${declaration.dir}/PAUSED 或根目录 loop-pause-all 存在，立即收尾退出本轮。`,
    `7. 结束前：更新 ${declaration.dir}/STATE.md（Last run / outcome / 复盘节必填）并按断路器规则追加 loop-ledger.json。`,
  ].join("\n");
}

/** 跑一条 prompt 并等它 settle（prompt_done）。超时 / prompt_error / destroy 均 reject。
 *  模式取自 v3 capturePrompt（lib/loop/pi-execution.ts）。 */
export function waitForRoundSettle(
  session: AgentSessionWrapper,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("kit round timed out")), timeoutMs);
    timer.unref?.();
    // destroy 先于任何 prompt_done/error 事件触发 — 立即 reject 而非干等超时。
    const offDestroy = session.onDestroy(() => finish(new Error("session destroyed")));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offDestroy?.();
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = session.onEvent((event: { type: string; errorMessage?: string }) => {
      if (event.type === "prompt_error") {
        finish(new Error(event.errorMessage ?? "kit round prompt failed"));
      }
      if (event.type === "prompt_done") finish();
    });
    void session.send({ type: "prompt", message: prompt }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export interface RoundDeps {
  starter?: typeof startRpcSession;
  reaper?: typeof reapOrphanedRoundProcesses;
}

/** 起一轮：一次性会话（cwd=workspace 根 → rpc-manager 自动装 workspace 扩展 +
 *  extraAgentDirs 重推导，REQ-0027）→ 命名 → 开场合同 → settle → 事后钩子。 */
export async function runKitRound(declaration: LoopDeclaration, deps: RoundDeps = {}): Promise<string> {
  const starter = deps.starter ?? startRpcSession;
  const reaper = deps.reaper ?? reapOrphanedRoundProcesses;
  const creation = creationTimeoutSignal(5 * 60_000, "kit round session creation timed out");
  let session: AgentSessionWrapper;
  let realSessionId: string;
  try {
    ({ session, realSessionId } = await starter("", "", declaration.workspacePath, undefined, {
      signal: creation.signal,
    }));
  } finally {
    creation.dispose();
  }
  const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    await session.send({ type: "set_session_name", name: `${declaration.loopName} · ${slot}` });
  } catch {
    /* 命名是装饰性的 — 会话照常跑 */
  }
  try {
    await waitForRoundSettle(session, buildRoundPrompt(declaration, realSessionId), declaration.maxMinutes * 60_000);
  } catch (error) {
    // 超时/销毁/prompt 错误：中止在飞 prompt，并收割它遗留的 bash/npm 进程树
    //（cwd 收敛到本 workspace — v3 收割经验的唯一保留点）。
    try {
      session.destroy();
    } catch {
      /* 已销毁 */
    }
    await reaper(declaration.workspacePath);
    throw error;
  }
  await settleRoundBookkeeping(declaration.workspacePath, realSessionId);
  return realSessionId;
}

/** 事后钩子（D9）—— Task 5 填充真体。 */
export async function settleRoundBookkeeping(_workspacePath: string, _sessionId: string): Promise<void> {}
```

- [ ] **Step 4: 运行测试 + typecheck**

Run: `node --test lib/daemon/loop-spawner.test.mjs && node_modules/.bin/tsc --noEmit`
Expected: 全部 PASS（timeout 用例 ~300ms 内完成），typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/loop-spawner.ts lib/daemon/loop-spawner.test.mjs
git commit -m "feat(kit): one-shot round execution core (prompt/settle/timeout+reap)"
```

---

### Task 5: 事后钩子 — conversations 回填 + 条件归档（D9）

**Files:**
- Modify: `lib/daemon/loop-spawner.ts`（`settleRoundBookkeeping` 真体 + `inspectRoundImpact`）
- Modify: `lib/daemon/loop-spawner.test.mjs`

**Interfaces:**
- Consumes: `listWorkItems(workspacePath) => { items: WorkItemRecord[]; archivedItems; invalid }`（`lib/work-items/service.ts:355`）；`readWorkItem(workspacePath, key) => Promise<WorkItemDetail>`（`WorkItemDetail = { path, item, content, events }`，events 带 `conversationId?`）；`updateWorkItem(workspaceId, key, { conversations, expectedRevision })`（`:489`，注意第一参是 **workspaceId**）；`readWorkspaceManifest(workspacePath)`（`lib/workspaces/service.ts`，取 `manifest.id`）；`archiveSession(sessionId)`（`lib/session-archive.ts:108`）。
- Produces:
  - `inspectRoundImpact(workspacePath, sessionId): Promise<RoundWorkItemImpact>`（纯读，可测）
  - `interface RoundWorkItemImpact { itemsToLink: Array<{ key, revision, conversations }>; hasPendingGate: boolean }`
  - `settleRoundBookkeeping(workspacePath, sessionId, deps?): Promise<void>`（永不抛 — 逐项 try/catch）

- [ ] **Step 1: 写失败测试（追加到 `loop-spawner.test.mjs`；新 import 语句合并到文件顶部，用例追加到文件尾部）**

真 workspace 用 tmpdir 造（`requirements/REQ-0001-test/item.yaml` + `events.jsonl`）。（注意：Task 4 的 happy-path 用例在此任务后会连带调用真 `settleRoundBookkeeping` — 对不存在的 `/ws` 会静默降级（listWorkItems 返回空 → archiveSession 找不到会话 → 被 catch 只打日志），用例仍 PASS，容忍日志噪音即可。）

```js
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRoundImpact, settleRoundBookkeeping } from "./loop-spawner.ts";

function makeItemWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "kit-items-"));
  const itemDir = join(ws, "requirements", "REQ-0001-test");
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, "item.yaml"), [
    "schema_version: 1",
    "key: REQ-0001",
    "type: requirement",
    "title: test item",
    "status: open",
    "phase: intake",
    "priority: P2",
    "repositories: []",
    "conversations: []",
    "created_at: 2026-09-01T00:00:00.000Z",
    "updated_at: 2026-09-01T00:00:00.000Z",
    "revision: 3",
    "tags: []",
  ].join("\n"));
  return { ws, itemDir };
}

test("inspectRoundImpact: links items whose events cite the round session; detects pending gate", async () => {
  const { ws, itemDir } = makeItemWorkspace();
  try {
    writeFileSync(join(itemDir, "events.jsonl"), [
      JSON.stringify({ id: "e1", at: "...", type: "loop.started", actor: "agent", conversationId: "sess-9" }),
      JSON.stringify({ id: "e2", at: "...", type: "loop.gate", actor: "agent", conversationId: "sess-9" }),
      JSON.stringify({ id: "e3", at: "...", type: "loop.started", actor: "agent", conversationId: "other" }),
    ].join("\n"));
    const impact = await inspectRoundImpact(ws, "sess-9");
    assert.equal(impact.itemsToLink.length, 1);
    assert.equal(impact.itemsToLink[0].key, "REQ-0001");
    assert.equal(impact.itemsToLink[0].revision, 3);
    assert.equal(impact.hasPendingGate, true);

    writeFileSync(join(itemDir, "events.jsonl"),
      JSON.stringify({ id: "e1", at: "...", type: "loop.started", actor: "agent", conversationId: "sess-9" }) + "\n");
    const impact2 = await inspectRoundImpact(ws, "sess-9");
    assert.equal(impact2.hasPendingGate, false);

    const impact3 = await inspectRoundImpact(ws, "unrelated");
    assert.deepEqual(impact3.itemsToLink, []);
    assert.equal(impact3.hasPendingGate, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("settleRoundBookkeeping: backfills conversations, archives only without pending gate, never throws", async () => {
  const { ws, itemDir } = makeItemWorkspace();
  try {
    writeFileSync(join(itemDir, "events.jsonl"),
      JSON.stringify({ id: "e2", at: "...", type: "loop.gate", actor: "agent", conversationId: "sess-9" }) + "\n");
    const updates = [];
    const archives = [];
    const run = (pendingGate) => settleRoundBookkeeping(ws, "sess-9", {
      manifestReader: async () => ({ id: "ws-1" }),
      updater: async (workspaceId, key, input) => {
        updates.push({ workspaceId, key, input });
        return null;
      },
      archiver: async (sessionId) => { archives.push(sessionId); return { archivedPath: "/x" }; },
      // pendingGate 由事件文件决定，无需注入 — 两次场景由上方写入控制
    });
    await run(); // gate pending → 不归档
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].input.conversations, ["sess-9"]);
    assert.equal(archives.length, 0);

    writeFileSync(join(itemDir, "events.jsonl"),
      JSON.stringify({ id: "e1", at: "...", type: "loop.started", actor: "agent", conversationId: "sess-9" }) + "\n");
    // conversations 已含 sess-9（updater 是假的不会真写盘）→ inspect 仍报未含 → 再推一次也无害
    await settleRoundBookkeeping(ws, "sess-9", {
      manifestReader: async () => ({ id: "ws-1" }),
      updater: async () => null,
      archiver: async (sessionId) => { archives.push(sessionId); return { archivedPath: "/x" }; },
    });
    assert.equal(archives.length, 1); // 无 pending gate → 归档
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

（若 `item.yaml` 字段名与真实 schema 有出入，以 `lib/work-items/types.ts` 的 `WorkItemRecord` 序列化为准修正 fixture — 打开 `lib/work-items/service.ts:parseWorkItem` 对照必填字段。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test lib/daemon/loop-spawner.test.mjs`
Expected: FAIL — `inspectRoundImpact` 不存在

- [ ] **Step 3: 实现（替换空 `settleRoundBookkeeping`）**

```ts
import { listWorkItems, readWorkItem, updateWorkItem } from "../work-items/service.ts";
import { readWorkspaceManifest } from "../workspaces/service.ts";
import { archiveSession } from "../session-archive.ts";

export interface RoundWorkItemImpact {
  itemsToLink: Array<{ key: string; revision: number; conversations: string[] }>;
  hasPendingGate: boolean;
}

/** 扫活动工作项的 events.jsonl：哪些项在本轮会话上盖过事件、是否有待决 gate。 */
export async function inspectRoundImpact(workspacePath: string, sessionId: string): Promise<RoundWorkItemImpact> {
  const { items } = await listWorkItems(workspacePath);
  const itemsToLink: RoundWorkItemImpact["itemsToLink"] = [];
  let hasPendingGate = false;
  for (const item of items) {
    let detail: Awaited<ReturnType<typeof readWorkItem>>;
    try {
      detail = await readWorkItem(workspacePath, item.key);
    } catch {
      continue;
    }
    const mine = detail.events.filter((event) => event.conversationId === sessionId);
    if (mine.length === 0) continue;
    itemsToLink.push({ key: item.key, revision: detail.item.revision, conversations: detail.item.conversations });
    if (mine.some((event) => event.type.startsWith("loop.gate"))) hasPendingGate = true;
  }
  return { itemsToLink, hasPendingGate };
}

export interface BookkeepingDeps {
  manifestReader?: typeof readWorkspaceManifest;
  updater?: typeof updateWorkItem;
  archiver?: typeof archiveSession;
}

/** D9 事后钩子：回填 conversations（待决 gate 会话从工作项详情可「继续对话」），
 *  无待决 gate 则归档轮会话（防会话列表污染）。永不抛 — 清理不得破坏轮流程。 */
export async function settleRoundBookkeeping(
  workspacePath: string,
  sessionId: string,
  deps: BookkeepingDeps = {},
): Promise<void> {
  const manifestReader = deps.manifestReader ?? readWorkspaceManifest;
  const updater = deps.updater ?? updateWorkItem;
  const archiver = deps.archiver ?? archiveSession;
  let impact: RoundWorkItemImpact;
  try {
    impact = await inspectRoundImpact(workspacePath, sessionId);
  } catch (error) {
    console.error("[loop-kit] inspect round impact failed:", error);
    return;
  }
  if (impact.itemsToLink.length > 0) {
    try {
      const manifest = await manifestReader(workspacePath);
      for (const entry of impact.itemsToLink) {
        if (entry.conversations.includes(sessionId)) continue;
        try {
          await updater(manifest.id, entry.key, {
            conversations: [...entry.conversations, sessionId],
            expectedRevision: entry.revision,
          });
        } catch (error) {
          console.error(`[loop-kit] conversations backfill failed for ${entry.key}:`, error);
        }
      }
    } catch (error) {
      console.error("[loop-kit] manifest read failed, skipping backfill:", error);
    }
  }
  if (!impact.hasPendingGate) {
    await archiver(sessionId).catch((error: unknown) =>
      console.error("[loop-kit] round session archive failed:", error));
  }
}
```

（`runKitRound` 尾部的 `settleRoundBookkeeping(declaration.workspacePath, realSessionId)` 调用签名不变 — deps 参数可选。）

- [ ] **Step 4: 运行测试 + typecheck**

Run: `node --test lib/daemon/loop-spawner.test.mjs && node_modules/.bin/tsc --noEmit`
Expected: 全部 PASS（含 Task 4 的用例），typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/loop-spawner.ts lib/daemon/loop-spawner.test.mjs
git commit -m "feat(kit): post-round hook — conversations backfill + conditional archive (D9)"
```

---

### Task 6: LoopKitSpawner DaemonJob + host 注册（PI_LOOP_KIT 旗子）

**Files:**
- Modify: `lib/daemon/loop-spawner.ts`（追加 job 类）
- Modify: `lib/daemon/loop-spawner.test.mjs`（追加 tick 用例）
- Modify: `lib/daemon/host.ts`（env 门控注册）

**Interfaces:**
- Consumes: `DaemonJob { id; start(): void; stop(): void }`（`lib/daemon/jobs.ts`）；`discoverWorkspaces()`（`lib/workspaces/service.ts`，返回含 `{ id, name, path, available, ... }`）；`cronMatches`（Task 2）；Task 3/4/5 产物。
- Produces: `class LoopKitSpawner implements DaemonJob`（`id = "loop-kit-heartbeats"`；`tick(now?)` 可注入时钟测试）。host.ts 中 `PI_LOOP_KIT=1` 时注册。

- [ ] **Step 1: 写失败测试（追加）**

```js
import { LoopKitSpawner } from "./loop-spawner.ts";

function makeSpawnerWithLoops(loopFixtures, overrides = {}) {
  const rounds = [];
  const spawner = new LoopKitSpawner({
    discover: async () => [{ id: "ws-1", name: "w1", path: "/ws/a", available: true }],
    discoverLoops: async () => loopFixtures,
    runRound: async (declaration) => { rounds.push(declaration); },
    now: () => new Date("2026-09-12T00:08:00.000Z"),
    ...overrides,
  });
  return { spawner, rounds };
}

const EVERY_MIN = { workspacePath: "/ws/a", loopName: "l1", dir: "/ws/a/loops/l1", pattern: "l1", cron: "* * * * *", timezone: "UTC", level: "L1", maxMinutes: 30, body: "" };

test("cron match fires once per minute slot (dedup)", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN]);
  await spawner.tick();
  await spawner.tick(); // 同一分钟 → 去重
  assert.equal(rounds.length, 1);
});

test("busy workspace is skipped (phase 1 serial)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], {
    runRound: async () => { rounds.push(1); await gate; },
    now: (() => {
      let minute = 0;
      return () => { minute += 1; return new Date(Date.parse("2026-09-12T00:08:00.000Z") + minute * 60_000); };
    })(),
  });
  const first = spawner.tick(); // 占住 ws-1
  await spawner.tick();         // ws-1 busy → 跳过
  release();
  await first;
  assert.equal(rounds.length, 1);
});

test("halted workspace never fires", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], {
    halted: async () => true,
  });
  await spawner.tick();
  assert.equal(rounds.length, 0);
});

test("cron mismatch does not fire", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([{ ...EVERY_MIN, cron: "0 5 * * *" }]);
  await spawner.tick(); // now = 00:08 UTC
  assert.equal(rounds.length, 0);
});

test("round error is swallowed (job keeps ticking)", async () => {
  const { spawner, rounds } = makeSpawnerWithLoops([EVERY_MIN], {
    runRound: async () => { throw new Error("boom"); },
    now: (() => {
      let minute = 0;
      return () => { minute += 1; return new Date(Date.parse("2026-09-12T00:08:00.000Z") + minute * 60_000); };
    })(),
  });
  await spawner.tick();
  await spawner.tick();
  assert.equal(rounds.length, 0); // 两次都炸但 tick 不抛
});
```

（`SpawnerDeps` 需含 `discoverLoops`（缺省 `discoverKitLoops`）与 `halted`（缺省 `isWorkspaceHalted`）注入点 — 下一步实现。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test lib/daemon/loop-spawner.test.mjs`
Expected: FAIL — `LoopKitSpawner` 不存在

- [ ] **Step 3: 实现（追加到 `loop-spawner.ts`）**

```ts
import type { DaemonJob } from "./jobs.ts";
import { cronMatches } from "./cron.ts";
import { discoverKitLoops, isWorkspaceHalted, type LoopDeclaration } from "./loop-kit.ts";
import { discoverWorkspaces } from "../workspaces/service.ts";

const SPAWNER_TICK_MS = 30_000;

export interface SpawnerDeps {
  discover?: typeof discoverWorkspaces;
  discoverLoops?: typeof discoverKitLoops;
  halted?: typeof isWorkspaceHalted;
  runRound?: (declaration: LoopDeclaration) => Promise<string>;
  now?: () => Date;
}

/** 心跳 DaemonJob：每 30s 扫已注册 workspace 的 loops/*/LOOP.md，cron 到点且非
 *  paused → 起一轮。phase 1 每 workspace 串行（spec 开放问题 2）。 */
export class LoopKitSpawner implements DaemonJob {
  readonly id = "loop-kit-heartbeats";
  private timer?: ReturnType<typeof setInterval>;
  private readonly emittedSlots = new Set<string>();
  private readonly busyWorkspaces = new Set<string>();
  private readonly deps: Required<SpawnerDeps>;

  constructor(deps: SpawnerDeps = {}) {
    this.deps = {
      discover: deps.discover ?? discoverWorkspaces,
      discoverLoops: deps.discoverLoops ?? discoverKitLoops,
      halted: deps.halted ?? isWorkspaceHalted,
      runRound: deps.runRound ?? ((declaration) => runKitRound(declaration)),
      now: deps.now ?? (() => new Date()),
    };
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error) => console.error("[loop-kit] spawner tick failed:", error));
    tick();
    this.timer = setInterval(tick, SPAWNER_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    const minute = now.toISOString().slice(0, 16);
    for (const workspace of await this.deps.discover()) {
      if (!workspace.available) continue;
      if (this.busyWorkspaces.has(workspace.id)) continue;
      if (await Promise.resolve(this.deps.halted(workspace.path))) continue;
      for (const declaration of await this.deps.discoverLoops(workspace.path)) {
        if (!cronMatches(declaration.cron, declaration.timezone, now)) continue;
        const slot = `${workspace.id}:${declaration.loopName}:${minute}`;
        if (this.emittedSlots.has(slot)) continue;
        this.emittedSlots.add(slot);
        if (this.emittedSlots.size > 10_000) this.emittedSlots.clear();
        this.busyWorkspaces.add(workspace.id);
        try {
          await this.deps.runRound(declaration);
        } catch (error) {
          console.error(`[loop-kit] round failed for ${workspace.id}/${declaration.loopName}:`, error);
        } finally {
          this.busyWorkspaces.delete(workspace.id);
        }
        break; // phase 1：每 workspace 每 tick 至多一轮
      }
    }
  }
}
```

- [ ] **Step 4: host.ts 门控注册**

`lib/daemon/host.ts`，在 `jobs.register(new LoopHostScheduler(runtime, workspaces));` 之后加：

```ts
  // pi-loop kit spawner（design: docs/pi-loop-kit-design.md）。Phase 1 与 v3
  // 引擎并存，PI_LOOP_KIT=1 门控；拆除 PR 中同槽位转正（替换 loop-triggers）。
  if (process.env.PI_LOOP_KIT === "1") {
    jobs.register(new LoopKitSpawner()); // id: loop-kit-heartbeats
  }
```

并在文件头部 import：`import { LoopKitSpawner } from "./loop-spawner.ts";`

- [ ] **Step 5: 运行全量测试 + typecheck**

Run: `npm test && node_modules/.bin/tsc --noEmit`
Expected: 全部 PASS（v3 用例不受影响），typecheck 干净

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/loop-spawner.ts lib/daemon/loop-spawner.test.mjs lib/daemon/host.ts
git commit -m "feat(kit): LoopKitSpawner DaemonJob (PI_LOOP_KIT=1 gated) + host registration"
```

---

### Task 7: 旗子下冒烟验收（手动）

**Files:**
- 无代码改动（验证任务；发现问题回到对应任务修）

- [ ] **Step 1: 准备冒烟 workspace**

选一个已注册的低风险 workspace（或新建一个，能力只勾 sessions+explorer）。在其根：

```bash
cd <workspacePath>
mkdir -p loops/smoke .agents/skills/smoke
cp <pi-web>/kit/templates/basic/STATE.md loops/smoke/STATE.md
cp <pi-web>/kit/templates/basic/loop-constraints.md loop-constraints.md
cp <pi-web>/kit/templates/basic/loop-budget.md loop-budget.md
cp <pi-web>/kit/templates/basic/loop-ledger.json loop-ledger.json
cat > loops/smoke/LOOP.md <<'EOF'
---
cron: "* * * * *"
level: L1
max_minutes: 5
---

# 本轮合同指针
1. 读 loop-constraints.md 与 loop-budget.md（绑定，禁改）
2. 读 loops/smoke/STATE.md 恢复上下文
3. 现在没有任务：仅把 STATE.md 的 Last run 更新为当前时间、outcome 记 report-only，并在 Post-run critique 写一句本轮观察
EOF
cat > .agents/skills/smoke/SKILL.md <<'EOF'
---
name: smoke
---
# smoke 合同
无实际任务。确认 STATE.md 的 Last run/outcome/复盘节已更新即结束。
EOF
```

- [ ] **Step 2: 带旗子起 daemon 并观察**

```bash
cd <pi-web> && PI_LOOP_KIT=1 npm run daemon
```

预期（对照 spec §11.1）：≤90s 内日志出现一轮执行；`loops/smoke/STATE.md` 出现 Last run 记录；`~/.pi/agent/sessions/` 出现名为 `smoke · <时间>` 的会话；**干净退出后该会话从会话列表消失**（被 D9 钩子归档，可在 归档 视图找到）；下一分钟第二轮接续。

- [ ] **Step 3: 验证 kill switch 与 v3 无扰**

`touch <workspacePath>/loop-pause-all` → 下一分钟不再起轮；删除后恢复。确认不带旗子的 `npm run daemon`（无 `PI_LOOP_KIT`）不注册 spawner（无 `[loop-kit]` 日志）。

- [ ] **Step 4: 记录冒烟结果**

把观察（起轮延迟/STATE 更新/归档行为）追加到 `docs/pi-loop-kit-design.md` §11 验收标准第 1 条下方的引用注释（一行即可），提交：

```bash
git add docs/pi-loop-kit-design.md
git commit -m "docs(kit): smoke-test note for acceptance criterion 1"
```

---

## 完成判据（整个计划）

- `npm test` / `node_modules/.bin/tsc --noEmit` 全绿；
- `PI_LOOP_KIT=1` 下 spawner 冒烟通过（Task 7 清单）；
- 不带旗子时 daemon 行为与 main 完全一致（v3 未受扰）；
- 拆除期前置条件就绪：`docs/pi-loop-kit-plan-2-teardown.md` 可以启动。
