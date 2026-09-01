# pi-web Loop 产品面（工作项绑定 + 管理面）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/pi-web-loop-surface-design.md`（S1–S6 已定稿）：工作项 loop 绑定、「立即跑一轮」按钮、WorkspaceOverview Loops 管理区块——全部是「人的手」，不新增引擎状态。

**Architecture:** web 进程以相对路径 import `pi-loop/` 纯逻辑包（先例 `app/api/workspaces/[id]/loops/route.ts`）；起轮/停轮复用现有 daemon 会话面（`POST /v1/sessions`、`POST /v1/sessions/:id/commands`、`DELETE /v1/sessions/:id`），**不新增任何 daemon 路由**（S3/S4）；管理操作（pause/resume/PATCH）是纯 web 进程 fs 操作。

**Tech Stack:** Next.js route handlers、pi-loop 纯逻辑包（fs+yaml+Intl）、node:test（`.test.mjs` 直 import `.ts`）。

**Spec:** `docs/pi-web-loop-surface-design.md`（本计划的论证依据，executor 需同时读它）；前置 host 层设计 `docs/pi-loop-host-design.md`（已实现合并）。

## Global Constraints

- **不 push**；**不动 workspace-c**（spec §7.5 的 workspace-c SKILL.md 过滤行由用户后续手动加，本计划只改仓内 `kit/README.md`）。
- **不动 `lib/i18n/messages/*`**——主仓 develop 有另一会话的未提交 WIP 覆盖这些文件；新 UI 沿用 `WorkspaceOverview.tsx` 的硬编码中文风格（该文件不走 i18n，是先例）。
- **pi-loop 包保持纯**：只准 `node:fs`/`node:path`/`node:os`/`yaml`/`Intl`，不得 import daemon/web 模块（web 进程与 daemon、beat 共用）。
- **不新增 daemon 路由**（S3/S4）：起轮 = `daemonProxy().createSession` + `sendSessionCommand`；停轮 = `daemonProxy().destroySession`。
- **web 进程导入 pi-loop 一律相对路径**（如 `lib/loops/x.ts` → `../../pi-loop/xxx.ts`；`app/api/workspaces/[id]/loops/[name]/run/route.ts` → 7 级上溯 `../../../../../../../pi-loop/xxx.ts`）。
- **测试约定**：纯模块 `.test.mjs` 直 import `.ts` 且被测模块的 import 也必须全相对（无 `@/` 别名）；只有 import rpc-manager 图的模块才用 jiti（本计划无此类新测试）。
- **锁语义**：一切 loop 键以**目录**为准（`declaration.dir`），name 仅展示（H7）；绑定存 **loop 名**（S1）。
- 主仓 develop 工作区有另一会话未提交 WIP；controller 全程在 worktree 干活，最终合并时若 `AGENTS.md` 阻塞则只 stash 该文件。
- 类型检查 `node_modules/.bin/tsc --noEmit`、lint `npm run lint`、测试 `npm test`；**绝不运行 `next build`**。

## 关键接线事实（已核对代码）

| 事实 | 位置 |
|---|---|
| pi-loop 纯逻辑可被 web 进程导入 | `app/api/workspaces/[id]/loops/route.ts:9` → `../../../../../pi-loop/protocol.ts` |
| `discoverKitLoops(path, { includePaused })` 参数已存在 | `pi-loop/protocol.ts` |
| 状态总览形状 = `collectStatus()` | `pi-loop/status.ts` → `{ name, pattern, level, cron, timezone, maxMinutes, paused, running, lastRun?, nextDue? }` |
| daemon 会话面 | `lib/daemon/client.ts`：`createSession({cwd, command?})`（command 可选 → 先建会话再发含 sessionId 的合同）、`sendSessionCommand(sid, {type:"prompt"/"set_session_name"})`、`destroySession(sid)`（DELETE = wrapper destroy，中止在飞 prompt） |
| 建会话后处理范式 | `app/api/agent/new/route.ts`：`allowFileRoot(result.cwd)` + `cacheSessionPath(result.sessionId, result.sessionFile)` + `invalidateSessionListCache()` |
| 轮命名/合同先例 | `lib/daemon/loop-spawner.ts:80-85`：`set_session_name` `<loop> · <slot>`（slot = `new Date().toISOString().slice(0,16).replace("T"," ")`）→ `{type:"prompt", message: buildRoundPrompt(declaration,{sessionId})}` |
| 锁/补跑原语 | `pi-loop/round-lock.ts`（acquire/read/update/release，O_EXCL，stale=死 pid 或超 `maxMinutes+15min`）、`pi-loop/due.ts`（readLastrun/writeLastrun/shouldFire） |
| `/loops` GET 消费方仅两处 | `components/shell/useAppShellState.ts:961`（handleRunContract）、`components/WorkspaceManager.tsx:413`（hasKitLoops 门控） |

**手动轮锁生命周期（本计划明确的 spec 细节）**：手动轮成功起跑后锁**保持持有**（无人 await 轮结束）——由 stale 窗口（`maxMinutes+15min`）兜底回收，代价至多丢一个后续心跳槽（anacron-lite 不放大语义自洽）；`stop` 路由杀完会**主动释放**（否则 running 徽章与下一槽被死锁拖住，且违背 spec 确认弹层「未完成工作由下轮补」的承诺——下轮要能立即补跑）。

**手动轮必须两步建会话**（spec §4 合同第 3 条要求 sessionId 行进合同、而 sessionId 只有建完会话才知道）：`createSession`（不带 command）→ `updateRoundLock({sessionId})` → `set_session_name` → `sendSessionCommand(prompt)`。

---

### Task 0: controller 工作区准备（不派发，controller 自做）

- [ ] **Step 1: 建 worktree + 分支**

```bash
cd /Users/qiancheng/Documents/Workspace/qyinf-workspace/pi-web
git worktree add ../pi-web-worktrees/loop-surface -b feature/loop-surface develop
cd ../pi-web-worktrees/loop-surface
ln -s /Users/qiancheng/Documents/Workspace/qyinf-workspace/pi-web/node_modules node_modules  # 测试/类型检查依赖；如失效改跑 npm ci
mkdir -p .superpowers/sdd/pi-web-loop-surface   # SDD ledger
node_modules/.bin/tsc --noEmit && npm test  # 基线必须全绿
```

- [ ] **Step 2: 确认主仓 WIP 未被触碰**（`cd ../pi-web && git status --short` 应与开工前一致）

---

### Task 1: 工作项 `loop` 字段（schema + service + LLM 工具透传）

**Files:**
- Modify: `lib/work-items/types.ts`（WorkItemRecord / CreateWorkItemInput / UpdateWorkItemInput）
- Modify: `lib/work-items/service.ts`（serialize/parse/create/update/changedFields）
- Modify: `lib/work-items/extension.ts`（两个工具的入参）
- Test: `lib/work-items/service.test.mjs`（追加）

**Interfaces:**
- Produces: `WorkItemRecord.loop?: string`（软校验——service 层**不**校验存在性）；`UpdateWorkItemInput.loop?: string | null`（null = 清除）；item.yaml 顶层可选标量 `loop: <name>`（与 `external` 同层先例）。Task 7/8/9 依赖该字段。

- [ ] **Step 1: 写失败测试**（追加到 `lib/work-items/service.test.mjs`，沿用文件内既有的 workspace fixture 写法——先看文件头部 helper 怎么建临时 workspace）

```js
test("work item loop binding round-trips through item.yaml", async () => {
  // 用文件内既有的临时 workspace 构造方式（见邻近用例）；下面以 makeWorkspace() 代称
  const workspace = await makeWorkspace();
  const detail = await createWorkItem(workspace.id, {
    type: "requirement",
    title: "绑定 loop 的工作项",
    originalDescription: "desc",
    loop: "dev-loop",
  });
  assert.equal(detail.item.loop, "dev-loop");
  const raw = await readFile(join(detail.path, "item.yaml"), "utf8");
  assert.match(raw, /^loop: dev-loop$/m);
  const reread = await readWorkItem(workspace.path, detail.item.key);
  assert.equal(reread.item.loop, "dev-loop");
});

test("work item without loop omits the field from item.yaml", async () => {
  const workspace = await makeWorkspace();
  const detail = await createWorkItem(workspace.id, {
    type: "bug", title: "无绑定", originalDescription: "desc",
  });
  assert.equal(detail.item.loop, undefined);
  const raw = await readFile(join(detail.path, "item.yaml"), "utf8");
  assert.doesNotMatch(raw, /^loop:/m);
});

test("updateWorkItem sets and clears the loop binding", async () => {
  const workspace = await makeWorkspace();
  const detail = await createWorkItem(workspace.id, {
    type: "requirement", title: "t", originalDescription: "d",
  });
  const rev1 = detail.item.revision;
  const set = await updateWorkItem(workspace.id, detail.item.key, {
    expectedRevision: rev1, loop: "triage-loop",
  });
  assert.equal(set.item.loop, "triage-loop");
  assert.equal(set.item.revision, rev1 + 1);
  const cleared = await updateWorkItem(workspace.id, set.item.key, {
    expectedRevision: set.item.revision, loop: null,
  });
  assert.equal(cleared.item.loop, undefined);
  const raw = await readFile(join(cleared.path), );  // 注意：用 cleared.item.path
  // 修正：readFile(join(cleared.path, "item.yaml"), "utf8")
  assert.doesNotMatch(raw, /^loop:/m);
});

test("binding to an unknown loop name is accepted (soft validation)", async () => {
  const workspace = await makeWorkspace();
  const detail = await createWorkItem(workspace.id, {
    type: "requirement", title: "t", originalDescription: "d", loop: "does-not-exist",
  });
  assert.equal(detail.item.loop, "does-not-exist"); // 不报错——软校验（S1）
});
```

（实现者按邻近用例的真实 fixture 名替换 `makeWorkspace()`；清除用例里两处笔误按注释修正后再跑。）

- [ ] **Step 2: 跑测试确认失败** — `node --test lib/work-items/service.test.mjs`（Expected: 4 个新用例 FAIL）
- [ ] **Step 3: 实现**

`lib/work-items/types.ts` — `WorkItemRecord` 在 `external?: WorkItemExternalRef;` **之前**加：

```ts
  /** Optional kit-loop binding by loop NAME (not pattern — names are stable,
   *  patterns can change; spec §3.1). Soft-validated: an unresolvable name is
   *  treated as unbound, never an error. */
  loop?: string;
```

`CreateWorkItemInput` 末尾加：

```ts
  /** Optional kit-loop binding by loop name (soft — existence not checked). */
  loop?: string;
```

`UpdateWorkItemInput` 末尾加：

```ts
  /** Kit-loop binding by name; null clears it. */
  loop?: string | null;
```

`lib/work-items/service.ts`：

1. `serializeWorkItem` — `plans: item.plans,` 之后插一行：

```ts
    ...(item.loop ? { loop: item.loop } : {}),
```

2. `parseWorkItem` — `relatedItems: …` 与 `designs/plans` 之后、`external` 条件之前插：

```ts
    ...(typeof record.loop === "string" && record.loop.trim() ? { loop: record.loop.trim() } : {}),
```

3. `createWorkItem` — `const tags = …` 之后加：

```ts
  const loop = typeof input.loop === "string" && input.loop.trim() ? input.loop.trim() : undefined;
```

item 字面量 `plans: [],` 之后加 `...(loop ? { loop } : {}),`。

4. `updateWorkItem` — `if (input.plans !== undefined) …` 之后加：

```ts
    if (input.loop !== undefined) {
      next.loop = input.loop === null
        ? undefined
        : (requireText(input.loop, "loop").trim() || undefined);
    }
```

5. `changedFields` 的字段数组加 `"loop",`（`"plans",` 之后）。

`lib/work-items/extension.ts`：`workspace_create_work_item` 的 `parameters` 加：

```ts
          loop: Type.Optional(Type.String({
            description: "绑定的 kit loop 名（loops/<name> 目录声明的 loop）；留空表示未绑定",
          })),
```

execute 透传（`...(params.tags ? …)` 之后）：`...(params.loop ? { loop: params.loop } : {}),`。

`workspace_update_work_item` 的 `parameters` 加：

```ts
          loop: Type.Optional(Type.Union([Type.String(), Type.Null()], {
            description: "绑定的 kit loop 名；null 清除绑定",
          })),
```

execute 透传（找到该工具 execute 里组装 update input 的位置）：`...(params.loop !== undefined ? { loop: params.loop } : {}),`。

- [ ] **Step 4: 跑测试确认通过** — `node --test lib/work-items/service.test.mjs` + `node_modules/.bin/tsc --noEmit`
- [ ] **Step 5: Commit** — `feat(work-items): item.yaml 可选 loop 字段（软校验绑定，S1）——schema/service/LLM 工具透传 + 单测`

---

### Task 2: pi-loop frontmatter round-trip（PATCH 的纯逻辑层）

**Files:**
- Create: `pi-loop/frontmatter.ts`
- Modify: `pi-loop/cron.ts`（加 `isValidCronExpression`）
- Test: `pi-loop/frontmatter.test.mjs`（新）
- Test: `pi-loop/cron.test.mjs`（追加 isValidCronExpression 用例）

**Interfaces:**
- Produces:
  - `pi-loop/cron.ts` → `isValidCronExpression(expression: string): boolean`
  - `pi-loop/frontmatter.ts` → `class LoopFrontmatterError extends Error`；`interface LoopFrontmatterPatch { cron?: string; timezone?: string; level?: "L1"|"L2"|"L3"; max_minutes?: number }`；`applyLoopFrontmatterPatch(raw: string, patch: LoopFrontmatterPatch): string`（返回新 LOOP.md 全文；frontmatter 重序列化、**正文 byte 保留**；非法值抛 `LoopFrontmatterError`）
- Task 4 的 PATCH 路由消费它们（错误 → 400）。

- [ ] **Step 1: 写失败测试**

`pi-loop/cron.test.mjs` 追加：

```js
test("isValidCronExpression accepts valid and rejects garbage", () => {
  assert.equal(isValidCronExpression("*/30 9-22 * * 1-5"), true);
  assert.equal(isValidCronExpression("0 8 * * 1-5"), true);
  assert.equal(isValidCronExpression("15 9,12,18 * * *"), true);
  assert.equal(isValidCronExpression("abc * * * *"), false);
  assert.equal(isValidCronExpression("*/30 9-22 * *"), false);   // 4 字段
  assert.equal(isValidCronExpression("60 * * * *"), false);      // 分钟越界
  assert.equal(isValidCronExpression("* 24 * * *"), false);      // 小时越界
  assert.equal(isValidCronExpression("* * 0 * *"), false);       // dom 越界（1-31）
  assert.equal(isValidCronExpression("* * * 0 *"), false);       // 月越界（1-12）
  assert.equal(isValidCronExpression("* * * * 8"), false);       // dow 越界（0-7）
  assert.equal(isValidCronExpression("*/0 * * * *"), false);     // step 0
});
```

（import 行按该文件既有写法加 `isValidCronExpression`。）

`pi-loop/frontmatter.test.mjs`（新）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { applyLoopFrontmatterPatch, LoopFrontmatterError } from "./frontmatter.ts";
import { parseLoopDeclaration } from "./protocol.ts";

const RAW = [
  "---",
  "name: dev-loop",
  "pattern: dev-loop",
  "level: L2",
  "cron: \"*/30 9-22 * * 1-5\"",
  "timezone: Asia/Shanghai",
  "max_minutes: 45",
  "---",
  "",
  "# 合同正文",
  "",
  "正文第一行保留原样（含尾部空格）   ",
  "第二行。",
].join("\n");

test("applyLoopFrontmatterPatch rewrites frontmatter and preserves body bytes", () => {
  const next = applyLoopFrontmatterPatch(RAW, { cron: "0 8-18 * * 1-5", max_minutes: 60 });
  const declaration = parseLoopDeclaration(next, "/ws/loops/dev-loop", "/ws");
  assert.equal(declaration.cron, "0 8-18 * * 1-5");
  assert.equal(declaration.maxMinutes, 60);
  assert.equal(declaration.level, "L2");            // 未动的字段保留
  assert.equal(declaration.timezone, "Asia/Shanghai");
  assert.equal(declaration.loopName, "dev-loop");
  // 正文 byte 保留：applyLoopDeclaration 的 body 是 trim 过的——这里直接断言尾部
  assert.ok(next.includes("正文第一行保留原样（含尾部空格）   \n第二行。"));
  // name/pattern 未丢失（round-trip 保真）
  assert.match(next, /name: dev-loop/);
});

test("applyLoopFrontmatterPatch updates timezone and level", () => {
  const next = applyLoopFrontmatterPatch(RAW, { timezone: "UTC", level: "L1" });
  const declaration = parseLoopDeclaration(next, "/ws/loops/dev-loop", "/ws");
  assert.equal(declaration.timezone, "UTC");
  assert.equal(declaration.level, "L1");
});

test("applyLoopFrontmatterPatch rejects invalid values", () => {
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { cron: "garbage" }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { timezone: "Asia/Shanghao" }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { level: "L9" }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { max_minutes: 0 }), LoopFrontmatterError);
  assert.throws(() => applyLoopFrontmatterPatch(RAW, { max_minutes: 1.5 }), LoopFrontmatterError);
});

test("applyLoopFrontmatterPatch throws on input without frontmatter", () => {
  assert.throws(() => applyLoopFrontmatterPatch("no frontmatter here", { cron: "* * * * *" }), LoopFrontmatterError);
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test pi-loop/frontmatter.test.mjs pi-loop/cron.test.mjs`
- [ ] **Step 3: 实现**

`pi-loop/cron.ts` 末尾追加：

```ts
/** 结构校验：5 字段、每段 `*|n|m-n`（可带 /step）、数值在字段范围内。
 *  供 frontmatter 编辑（web PATCH）与 init CLI 干跑校验——避免对垃圾表达式
 *  跑 366 天的 nextDue 扫描。纯语法，不判「永不命中」（如 0 0 31 2 *）。 */
const CRON_FIELD_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    if (!field) return false;
    const [min, max] = CRON_FIELD_RANGES[index];
    return field.split(",").every((part) => {
      if (!part) return false;
      const [range, stepRaw] = part.split("/");
      const step = stepRaw === undefined ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) return false;
      if (range === "*") return true;
      const [startRaw, endRaw] = range.split("-");
      const start = Number(startRaw);
      const end = endRaw === undefined ? start : Number(endRaw);
      return Number.isInteger(start) && Number.isInteger(end)
        && start >= min && start <= max && end >= min && end <= max && start <= end;
    });
  });
}
```

`pi-loop/frontmatter.ts`（新）：

```ts
/** LOOP.md frontmatter round-trip（web spec §5.2 PATCH 的纯逻辑层，S5「人的手」）。
 *  只接受 cron/timezone/level/max_minutes 四字段；yaml 重序列化 frontmatter
 *  （frontmatter 内注释会丢失——kit frontmatter 为机器书写风格，可接受），
 *  正文 byte 保留。 */
import { parse, stringify } from "yaml";
import { isValidCronExpression } from "./cron.ts";

export interface LoopFrontmatterPatch {
  cron?: string;
  timezone?: string;
  level?: "L1" | "L2" | "L3";
  max_minutes?: number;
}

export class LoopFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopFrontmatterError";
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function applyLoopFrontmatterPatch(raw: string, patch: LoopFrontmatterPatch): string {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new LoopFrontmatterError("LOOP.md 缺少 frontmatter（--- 分隔块）");
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch (error) {
    throw new LoopFrontmatterError(`frontmatter 不是合法 yaml：${String(error)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LoopFrontmatterError("frontmatter 必须是对象");
  }
  const record = { ...(data as Record<string, unknown>) };
  if (patch.cron !== undefined) {
    const cron = patch.cron.trim();
    if (!isValidCronExpression(cron)) throw new LoopFrontmatterError(`非法 cron 表达式：${patch.cron}`);
    record.cron = cron;
  }
  if (patch.timezone !== undefined) {
    const timezone = patch.timezone.trim();
    if (!isValidTimezone(timezone)) throw new LoopFrontmatterError(`非法 timezone：${patch.timezone}`);
    record.timezone = timezone;
  }
  if (patch.level !== undefined) {
    if (patch.level !== "L1" && patch.level !== "L2" && patch.level !== "L3") {
      throw new LoopFrontmatterError(`level 只能是 L1/L2/L3：${String(patch.level)}`);
    }
    record.level = patch.level;
  }
  if (patch.max_minutes !== undefined) {
    if (!Number.isInteger(patch.max_minutes) || patch.max_minutes <= 0) {
      throw new LoopFrontmatterError(`max_minutes 必须是正整数：${String(patch.max_minutes)}`);
    }
    record.max_minutes = patch.max_minutes;
  }
  return `---\n${stringify(record, { lineWidth: 0 }).trimEnd()}\n---\n${match[2]}`;
}
```

（`stringify(…).trimEnd()` 防末尾多余空行；`match[2]` 原样拼接 = 正文 byte 保留。）

- [ ] **Step 4: 跑测试确认通过** — `node --test pi-loop/frontmatter.test.mjs pi-loop/cron.test.mjs`
- [ ] **Step 5: Commit** — `feat(pi-loop): frontmatter round-trip + isValidCronExpression（web PATCH 的纯逻辑层，S5）`

---

### Task 3: `GET /api/workspaces/[id]/loops` 扩展（includePaused + 状态计算）

**Files:**
- Modify: `app/api/workspaces/[id]/loops/route.ts`
- Modify: `components/WorkspaceManager.tsx:404-425`（loops fetch effect）
- Modify: `components/shell/useAppShellState.ts:951-985`（handleRunContract 的 pattern 解析）

**Interfaces:**
- Consumes: `pi-loop/status.ts` 的 `collectStatus(root)`。
- Produces: GET 响应 `{ loops: Array<{ name, pattern, level, cron, timezone, maxMinutes, paused, running, lastRun?, nextDue? }> }`（**含 paused**）。
- **兼容约束**：两个既有消费方从此必须过滤 `paused`（S5：暂停即不存在，D11 门控语义不变）——本任务一并改。

- [ ] **Step 1: 改 route**

`app/api/workspaces/[id]/loops/route.ts`：import 行 `discoverKitLoops` 换成：

```ts
import { collectStatus } from "../../../../../pi-loop/status.ts";
```

GET 主体换为：

```ts
    const { id } = await params;
    const { path } = await getWorkspace(id);
    // 管理面数据（web spec §5.1）：includePaused 发现 + 每 loop 的运行状态
    // （.round.lock 活性 + .lastrun + nextDue，与 pi-loop status CLI 同一口径）。
    // 消费方自行过滤 paused（D11 门控语义：暂停即不存在）。
    return NextResponse.json({ loops: collectStatus(path) });
```

- [ ] **Step 2: 改两个消费方**

`components/WorkspaceManager.tsx`（~404）：state `const [hasKitLoops, setHasKitLoops] = useState(false);` 改为存列表：

```ts
  const [kitLoops, setKitLoops] = useState<Array<{ name: string; pattern: string; level: string; cron: string; paused?: boolean; running?: boolean }>>([]);
```

effect 内三处 `setHasKitLoops(...)` 改：失败/离线分支 `setKitLoops([])`；成功分支 `setKitLoops(data.loops ?? [])`（fetch 的 json 类型断言同步改为该数组形状）。effect 顶部的重置分支同样 `setKitLoops([])`。**存全量（含 paused）**——T7 的绑定下拉要显示 paused loop（绑到 paused = 软未生效，S1/S5 自洽），过滤在用到处做。

在 state 声明之后（任何使用之前）加派生量：

```ts
  const hasKitLoops = kitLoops.some((loop) => !loop.paused);
```

（既有 `hasKitLoops` 用法——按钮门控——语义不变：active loop 存在。Task 7 会改用 `kitLoops` 渲染下拉。）

`components/shell/useAppShellState.ts`（~961）：

```ts
        const data = (await response.json()) as { loops?: Array<{ pattern: string; paused?: boolean }> };
        pattern = data.loops?.find((loop) => !loop.paused)?.pattern;
```

（替换 `pattern = data.loops?.[0]?.pattern;`。Task 8 再扩成绑定分支。）

- [ ] **Step 3: 验证** — `node_modules/.bin/tsc --noEmit && npm test`（collectStatus 本身已有 pi-loop/status.test.mjs 覆盖；本任务无新纯逻辑）
- [ ] **Step 4: Commit** — `feat(loops): GET /loops 升级为 collectStatus 全量状态（含 paused），消费方过滤 paused 保持 D11 门控语义`

---

### Task 4: pause / resume / PATCH 管理路由

**Files:**
- Create: `lib/loops/lookup.ts`
- Create: `app/api/workspaces/[id]/loops/[name]/route.ts`（PATCH）
- Create: `app/api/workspaces/[id]/loops/[name]/pause/route.ts`（POST）
- Create: `app/api/workspaces/[id]/loops/[name]/resume/route.ts`（POST）

**Interfaces:**
- Consumes: Task 2 的 `applyLoopFrontmatterPatch`/`LoopFrontmatterError`；`getWorkspace`（`@/lib/workspaces/service`）；pi-loop `discoverKitLoops`。
- Produces: 三条路由（Task 10 的 Overview UI 消费）：
  - `POST …/loops/[name]/pause` → `{ loop: <status entry> }`（写 `PAUSED` 标记，幂等）
  - `POST …/loops/[name]/resume` → `{ loop: <status entry> }`（删 `PAUSED`，幂等）
  - `PATCH …/loops/[name]` body `{ cron?, timezone?, level?, max_minutes? }` → `{ loop: <status entry> }`；未知字段 → 400；非法值 → 400；未知 loop 名 → 404

- [ ] **Step 1: `lib/loops/lookup.ts`**

```ts
/** 管理/操作路由共用的 loop 名解析（web spec §4/§5.2）。
 *  按 loopName（name 字段，缺省=目录名）匹配，回落目录名——绑定存的是名（S1），
 *  一切文件操作仍以 declaration.dir（目录）为准（H7）。 */
import { basename } from "node:path";
import { discoverKitLoops, type LoopDeclaration } from "../../pi-loop/protocol.ts";

export function findKitLoopByName(workspacePath: string, name: string): LoopDeclaration | undefined {
  return discoverKitLoops(workspacePath, { includePaused: true })
    .find((declaration) => declaration.loopName === name || basename(declaration.dir) === name);
}
```

- [ ] **Step 2: `app/api/workspaces/[id]/loops/[name]/route.ts`**

```ts
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { applyLoopFrontmatterPatch, LoopFrontmatterError } from "../../../../../../pi-loop/frontmatter.ts";
import { collectStatus } from "../../../../../../pi-loop/status.ts";

const EDITABLE = new Set(["cron", "timezone", "level", "max_minutes"]);

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof WorkspaceNotFoundError ? 404
    : error instanceof LoopFrontmatterError ? 400
    : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** Frontmatter round-trip 编辑（S5「人的手」）：只接受 cron/timezone/level/
 *  max_minutes 四字段；frontmatter 重序列化、正文 byte 保留（纯逻辑在
 *  pi-loop/frontmatter.ts）。cron 编辑后下一心跳自然生效（宿主每 tick 重读
 *  文件）；.lastrun 保留，next-due 按新 cron 重算。 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => !EDITABLE.has(key));
    if (unknownKeys.length > 0) {
      return NextResponse.json(
        { error: `不可编辑的字段（仅 cron/timezone/level/max_minutes）：${unknownKeys.join(", ")}` },
        { status: 400 },
      );
    }
    if (body.cron !== undefined && typeof body.cron !== "string") {
      return NextResponse.json({ error: "cron must be a string" }, { status: 400 });
    }
    if (body.timezone !== undefined && typeof body.timezone !== "string") {
      return NextResponse.json({ error: "timezone must be a string" }, { status: 400 });
    }
    if (body.level !== undefined && !(["L1", "L2", "L3"] as const).includes(body.level as "L1")) {
      return NextResponse.json({ error: "level 只能是 L1/L2/L3" }, { status: 400 });
    }
    if (body.max_minutes !== undefined
      && (typeof body.max_minutes !== "number" || !Number.isInteger(body.max_minutes))) {
      return NextResponse.json({ error: "max_minutes must be an integer" }, { status: 400 });
    }
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: "至少提供一个字段（cron/timezone/level/max_minutes）" }, { status: 400 });
    }
    const patch = {
      ...(typeof body.cron === "string" ? { cron: body.cron } : {}),
      ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
      ...(typeof body.level === "string" ? { level: body.level as "L1" | "L2" | "L3" } : {}),
      ...(typeof body.max_minutes === "number" ? { max_minutes: body.max_minutes } : {}),
    };
    const loopMdPath = join(declaration.dir, "LOOP.md");
    const raw = readFileSync(loopMdPath, "utf8");
    const next = applyLoopFrontmatterPatch(raw, patch);
    // tmp+rename 原子写（先例：writeLastrun / session-index）
    const tmp = `${loopMdPath}.tmp-${process.pid}`;
    await writeFile(tmp, next, "utf8");
    await rename(tmp, loopMdPath);
    return NextResponse.json({
      loop: collectStatus(workspacePath).find((entry) => entry.name === declaration.loopName),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 3: pause / resume 路由**

`pause/route.ts`：

```ts
import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { collectStatus } from "../../../../../../../pi-loop/status.ts";

/** 写 loops/<name>/PAUSED 标记（web 进程 fs，loops route 先例）。幂等——
 *  已暂停再暂停成功。在跑的轮靠开场合同规则 6（发现 PAUSED 立即收尾）合作收尾。 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    await writeFile(join(declaration.dir, "PAUSED"), "", "utf8");
    return NextResponse.json({
      loop: collectStatus(workspacePath).find((entry) => entry.name === declaration.loopName),
    });
  } catch (error) {
    const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
```

`resume/route.ts`：同构，`writeFile` 换 `rm`（`import { rm } from "node:fs/promises";`，`await rm(join(declaration.dir, "PAUSED"), { force: true })`），上溯层级相同（`resume` 与 `pause` 同深：`../../../../../../../pi-loop/status.ts` 7 级——pause 在 `[name]/pause/route.ts`，与 run 同深）。注释改为「删 PAUSED 标记，幂等——未暂停时 resume 也成功」。

- [ ] **Step 4: 验证** — `node_modules/.bin/tsc --noEmit && npm test`（纯逻辑已由 Task 2 测试覆盖；路由是薄壳）
- [ ] **Step 5: 手动冒烟（有 dev 环境时可选）** — 对任一有 loop 的 workspace `curl -X PATCH .../loops/dev-loop -d '{"max_minutes":46}'` 确认 200 + 正文未动
- [ ] **Step 6: Commit** — `feat(loops): pause/resume/PATCH 管理路由（纯 web fs + frontmatter round-trip，S5）`

---

### Task 5: stop 路由（终止本轮）

**Files:**
- Create: `lib/loops/rounds.ts`（先落 `stopRound`；Task 6 追加 `launchManualRound`）
- Create: `app/api/workspaces/[id]/loops/[name]/stop/route.ts`
- Test: `lib/loops/rounds.test.mjs`（新）

**Interfaces:**
- Consumes: `pi-loop/round-lock.ts`（readRoundLock/releaseRoundLock/isProcessAlive）、`pi-loop/reap.ts`（reapOrphanedRoundProcesses）。
- Produces（Task 6 同文件追加 run 部分）:
  - `stopRound(declaration: LoopDeclaration, deps: { destroySession: (sid: string) => Promise<unknown>; reap: (workspacePath: string) => Promise<void> | void }): Promise<"stopped" | "not-running" | "beat-held">`
  - 路由：`stopped` → 200 `{ ok: true }`；`not-running` → 409「本轮未在运行」；`beat-held` → 409「该轮由 pi-loop beat 持有，请在宿主机执行 `pi-loop stop <name>`」（S4）；daemon destroy 传输失败 → 502。

- [ ] **Step 1: 写失败测试** `lib/loops/rounds.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopRound } from "./rounds.ts";
import { acquireRoundLock } from "../../pi-loop/round-lock.ts";

const DECL = {
  workspacePath: "/ws", loopName: "dev-loop", dir: "", pattern: "dev-loop",
  cron: "*/30 9-22 * * 1-5", timezone: "Asia/Shanghai", level: "L2", maxMinutes: 45, body: "b",
};

function makeLoopDir() {
  const dir = mkdtempSync(join(tmpdir(), "rounds-"));
  DECL.dir = dir; // 测试内直接改对象（简单起见；或每次构造新 DECL）
  writeFileSync(join(dir, "LOOP.md"), "---\ncron: */30 9-22 * * 1-5\n---\nbody");
  return dir;
}

test("stopRound: no lock → not-running", async () => {
  makeLoopDir();
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
});

test("stopRound: daemon lock → destroy + reap + release", async () => {
  makeLoopDir();
  const destroyed = [];
  const reaped = [];
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "s-1" });
  const result = await stopRound({ ...DECL }, {
    destroySession: async (sid) => { destroyed.push(sid); },
    reap: async (path) => { reaped.push(path); },
  });
  assert.equal(result, "stopped");
  assert.deepEqual(destroyed, ["s-1"]);
  assert.deepEqual(reaped, [DECL.workspacePath]);
  const { readRoundLock } = await import("../../pi-loop/round-lock.ts");
  assert.equal(readRoundLock(DECL.dir), undefined); // 锁已释放——下轮可补
});

test("stopRound: beat lock → beat-held，不动进程不释放", async () => {
  makeLoopDir();
  const destroyed = [];
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "beat" });
  const result = await stopRound({ ...DECL }, { destroySession: async (sid) => { destroyed.push(sid); }, reap: async () => {} });
  assert.equal(result, "beat-held");
  assert.equal(destroyed.length, 0);
});

test("stopRound: daemon lock without sessionId → not-running（启动窗口）", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon" });
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
});

test("stopRound: stale lock（死 pid）→ 顺手清理 + not-running", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: 999999, host: "h", kind: "daemon", sessionId: "s-x" });
  const result = await stopRound({ ...DECL }, { destroySession: async () => {}, reap: async () => {} });
  assert.equal(result, "not-running");
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test lib/loops/rounds.test.mjs`
- [ ] **Step 3: 实现 `lib/loops/rounds.ts`**

```ts
/** web 侧轮控制（spec §4/§5.2，S3/S4）：全部走现有 daemon 会话面 + pi-loop
 *  纯逻辑，无 daemon 新路由。依赖全部可注入（.test.mjs 直 import 测试）。 */
import { hostname } from "node:os";
import type { LoopDeclaration } from "../../pi-loop/protocol.ts";
import { isProcessAlive, readRoundLock, releaseRoundLock } from "../../pi-loop/round-lock.ts";

export interface StopRoundDeps {
  /** daemonProxy().destroySession —— DELETE /v1/sessions/:id（wrapper destroy，
   *  中止在飞 prompt）。 */
  destroySession: (sessionId: string) => Promise<unknown>;
  /** pi-loop/reap.ts 的孤儿收割（cwd 收敛到 workspace）。 */
  reap: (workspacePath: string) => Promise<void> | void;
}

export type StopOutcome = "stopped" | "not-running" | "beat-held";

export async function stopRound(
  declaration: LoopDeclaration,
  deps: StopRoundDeps,
): Promise<StopOutcome> {
  const lock = readRoundLock(declaration.dir);
  if (!lock) return "not-running";
  const alive = isProcessAlive(lock.pid)
    && Date.now() - lock.startedAt <= declaration.maxMinutes * 60_000 + 15 * 60_000;
  if (!alive) {
    releaseRoundLock(declaration.dir); // stale 锁顺手清理（与 stale-takeover 同效果）
    return "not-running";
  }
  if (lock.kind === "beat") return "beat-held";
  if (!lock.sessionId) return "not-running"; // 锁先于会话建立的启动窗口——等它 settle
  await deps.destroySession(lock.sessionId);
  try {
    await deps.reap(declaration.workspacePath);
  } catch {
    /* 收割失败不掩盖停止（spawner 既有口径） */
  }
  releaseRoundLock(declaration.dir);
  return "stopped";
}
```

- [ ] **Step 4: 跑测试确认通过** — `node --test lib/loops/rounds.test.mjs`
- [ ] **Step 5: `app/api/workspaces/[id]/loops/[name]/stop/route.ts`**

```ts
import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { stopRound } from "@/lib/loops/rounds";
import { reapOrphanedRoundProcesses } from "../../../../../../../pi-loop/reap.ts";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";

/** 终止本轮（S4）：daemon 持有 → DELETE /v1/sessions/:id（现有面）+ 包内 reap
 *  + 释放锁（下轮可立即补跑——确认弹层「未完成工作由下轮补」的承诺）；
 *  beat 持有 → 409 提示走 pi-loop stop（web 不代杀本机 beat 进程）。 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    const client = await daemonProxy();
    const outcome = await stopRound(declaration, {
      destroySession: (sessionId) => client.destroySession(sessionId),
      reap: (path) => reapOrphanedRoundProcesses(path),
    });
    if (outcome === "not-running") {
      return NextResponse.json({ error: "本轮未在运行" }, { status: 409 });
    }
    if (outcome === "beat-held") {
      return NextResponse.json(
        { error: `该轮由 pi-loop beat 持有，请在宿主机执行 \`pi-loop stop ${declaration.loopName}\`` },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: daemonErrorStatus(error) },
    );
  }
}
```

- [ ] **Step 6: 验证 + Commit** — `node_modules/.bin/tsc --noEmit && npm test`；commit `feat(loops): stop 路由——daemon 持有轮经现有 teardown 面终止 + reap + 释放锁，beat 持有 409（S4）`

---

### Task 6: run 路由（「立即跑一轮」，S3）

**Files:**
- Modify: `lib/loops/rounds.ts`（追加 `launchManualRound` + `RoundBusyError`）
- Create: `app/api/workspaces/[id]/loops/[name]/run/route.ts`
- Test: `lib/loops/rounds.test.mjs`（追加）

**Interfaces:**
- Consumes: `pi-loop/contract.ts` `buildRoundPrompt(declaration, { sessionId?, extraInstructions? })`、`round-lock.ts`、`due.ts` `writeLastrun`。
- Produces:
  - `class RoundBusyError extends Error`（路由 → 409）
  - `launchManualRound(declaration, opts: { itemKey?: string }, deps: LaunchRoundDeps): Promise<{ sessionId: string; cwd?: string; sessionFile?: string }>`
  - `interface LaunchRoundDeps { createSession: (input: { cwd: string }) => Promise<{ sessionId: string; cwd?: string; sessionFile?: string }>; sendCommand: (sessionId: string, command: { type: string; [key: string]: unknown }) => Promise<unknown>; destroySession: (sessionId: string) => Promise<unknown> }`
  - 路由 `POST …/loops/[name]/run` body `{ itemKey?: string }` → 200 `{ sessionId }`；占用 → 409；daemon 失败 → 502。
- Task 9 的 B 按钮消费该路由。

- [ ] **Step 1: 写失败测试**（追加到 `lib/loops/rounds.test.mjs`）

```js
import { launchManualRound, RoundBusyError } from "./rounds.ts";
import { readLastrun } from "../../pi-loop/due.ts";

function makeDeps() {
  const calls = { created: [], commands: [], destroyed: [] };
  return {
    calls,
    deps: {
      createSession: async (input) => {
        calls.created.push(input);
        return { sessionId: "sess-1", cwd: input.cwd, sessionFile: "/x/sess-1.jsonl" };
      },
      sendCommand: async (sid, command) => {
        calls.commands.push({ sid, command });
      },
      destroySession: async (sid) => { calls.destroyed.push(sid); },
    },
  };
}

test("launchManualRound: 全序列——锁(daemon+sessionId) / .lastrun / 命名 / 含 sessionId 与优先行的合同", async () => {
  makeLoopDir();
  const { calls, deps } = makeDeps();
  const result = await launchManualRound({ ...DECL }, { itemKey: "REQ-0007" }, deps);
  assert.equal(result.sessionId, "sess-1");
  assert.deepEqual(calls.created, [{ cwd: DECL.workspacePath }]);
  const lock = readLock(DECL.dir);
  assert.equal(lock.kind, "daemon");
  assert.equal(lock.sessionId, "sess-1");
  assert.ok(readLastrun(DECL.dir)); // 手动轮也写 .lastrun（host §4 run 语义）
  const name = calls.commands[0].command;
  assert.equal(name.type, "set_session_name");
  assert.match(name.name, /^dev-loop · 手动 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const prompt = calls.commands[1].command;
  assert.equal(prompt.type, "prompt");
  assert.ok(prompt.message.includes("sess-1"));            // 合同 sessionId 行（D9 conversations 回填）
  assert.ok(prompt.message.includes("REQ-0007"));          // --item 优先行
  assert.ok(prompt.message.includes("/skill:dev-loop"));
  assert.equal(calls.destroyed.length, 0);
  // 锁保持持有（成功路径不释放——轮在跑）
  assert.ok(readLock(DECL.dir));
});

test("launchManualRound: 锁互斥 → RoundBusyError", async () => {
  makeLoopDir();
  acquireRoundLock(DECL.dir, { pid: process.pid, host: "h", kind: "daemon", sessionId: "other" });
  const { deps } = makeDeps();
  await assert.rejects(
    () => launchManualRound({ ...DECL }, {}, deps),
    RoundBusyError,
  );
});

test("launchManualRound: createSession 失败 → 释放锁 + destroy 尽力 + 抛原错误", async () => {
  makeLoopDir();
  const calls = { destroyed: [] };
  const deps = {
    createSession: async () => { throw new Error("daemon down"); },
    sendCommand: async () => {},
    destroySession: async (sid) => { calls.destroyed.push(sid); },
  };
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), /daemon down/);
  assert.equal(readLock(DECL.dir), undefined); // 锁已释放
  assert.deepEqual(calls.destroyed, []);       // 未建会话，无需 destroy
});

test("launchManualRound: prompt 发送失败 → destroy 半建会话 + 释放锁", async () => {
  makeLoopDir();
  const calls = { destroyed: [] };
  const deps = {
    createSession: async () => ({ sessionId: "sess-2" }),
    sendCommand: async () => { throw new Error("send failed"); },
    destroySession: async (sid) => { calls.destroyed.push(sid); },
  };
  await assert.rejects(() => launchManualRound({ ...DECL }, {}, deps), /send failed/);
  assert.deepEqual(calls.destroyed, ["sess-2"]);
  assert.equal(readLock(DECL.dir), undefined);
});
```

（文件顶部 import 块统一整理为：`import { launchManualRound, RoundBusyError, stopRound } from "./rounds.ts";`、`import { acquireRoundLock, readRoundLock as readLock } from "../../pi-loop/round-lock.ts";`、`import { readLastrun } from "../../pi-loop/due.ts";`——与 Task 5 已有 import 合并，勿重复声明。）

- [ ] **Step 2: 跑测试确认失败** — `node --test lib/loops/rounds.test.mjs`
- [ ] **Step 3: 实现**（追加到 `lib/loops/rounds.ts`）

```ts
import { acquireRoundLock, updateRoundLock, releaseRoundLock, type RoundLockHolder } from "../../pi-loop/round-lock.ts";
import { writeLastrun } from "../../pi-loop/due.ts";
import { buildRoundPrompt } from "../../pi-loop/contract.ts";

export class RoundBusyError extends Error {
  constructor(loopName: string) {
    super(`loop ${loopName} 的本轮已在运行`);
    this.name = "RoundBusyError";
  }
}

export interface LaunchRoundDeps {
  /** daemonProxy().createSession —— POST /v1/sessions（不带 command：sessionId
   *  要进开场合同第 3 条，而它建完会话才知道 → 两步走）。 */
  createSession: (input: { cwd: string }) => Promise<{ sessionId: string; cwd?: string; sessionFile?: string }>;
  /** daemonProxy().sendSessionCommand —— POST /v1/sessions/:id/commands。 */
  sendCommand: (sessionId: string, command: { type: string; [key: string]: unknown }) => Promise<unknown>;
  destroySession: (sessionId: string) => Promise<unknown>;
}

/** 手动起一轮（spec §4，S3）：acquire 锁（kind daemon，pid=web 进程）→ 写
 *  .lastrun（避免下一心跳立即重跑，host §4）→ 建会话 → 回填锁内 sessionId →
 *  命名 → 发合同（daemon 形态，含 sessionId 行）。成功后锁**保持持有**——无人
 *  await 轮结束，靠 stale 窗口（maxMinutes+15min）兜底回收，至多丢一个后续
 *  心跳槽（anacron-lite 不放大）；stop 路由会主动释放。失败路径释放锁 +
 *  best-effort destroy 半建会话。无 D9 钩子（人在场，不自动归档）。 */
export async function launchManualRound(
  declaration: LoopDeclaration,
  opts: { itemKey?: string } = {},
  deps: LaunchRoundDeps,
): Promise<{ sessionId: string; cwd?: string; sessionFile?: string }> {
  const holder: RoundLockHolder = { pid: process.pid, host: hostname(), kind: "daemon" };
  if (!acquireRoundLock(declaration.dir, holder, { maxStaleMs: declaration.maxMinutes * 60_000 + 15 * 60_000 })) {
    throw new RoundBusyError(declaration.loopName);
  }
  let sessionId: string | undefined;
  try {
    writeLastrun(declaration.dir, new Date());
    const created = await deps.createSession({ cwd: declaration.workspacePath });
    sessionId = created.sessionId;
    updateRoundLock(declaration.dir, { sessionId });
    const slot = new Date().toISOString().slice(0, 16).replace("T", " ");
    try {
      await deps.sendCommand(sessionId, { type: "set_session_name", name: `${declaration.loopName} · 手动 ${slot}` });
    } catch {
      /* 命名是装饰性的——会话照常跑（spawner 既有口径） */
    }
    await deps.sendCommand(sessionId, {
      type: "prompt",
      message: buildRoundPrompt(declaration, {
        sessionId,
        ...(opts.itemKey ? { extraInstructions: `本轮优先处理工作项 ${opts.itemKey}（人手动指定）。` } : {}),
      }),
    });
    return { sessionId, cwd: created.cwd, sessionFile: created.sessionFile };
  } catch (error) {
    if (sessionId) {
      try { await deps.destroySession(sessionId); } catch { /* 尽力 */ }
    }
    releaseRoundLock(declaration.dir);
    throw error;
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — `node --test lib/loops/rounds.test.mjs`
- [ ] **Step 5: `app/api/workspaces/[id]/loops/[name]/run/route.ts`**

```ts
import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { findKitLoopByName } from "@/lib/loops/lookup";
import { launchManualRound, RoundBusyError } from "@/lib/loops/rounds";
import { daemonErrorStatus, daemonProxy } from "@/lib/agent-proxy";
import { allowFileRoot } from "@/lib/file-access";
import { cacheSessionPath, invalidateSessionListCache } from "@/lib/session-reader";

/** 「立即跑一轮」（spec §4，S3）：web 进程 import pi-loop 纯逻辑组装开场合同，
 *  经现有 daemon 会话面起轮（不新增 daemon 路由）。itemKey 存在则合同追加
 *  「本轮优先处理 <KEY>」。返回 sessionId，UI 打开会话 tab 实时观看。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path: workspacePath } = await getWorkspace(id);
    const declaration = findKitLoopByName(workspacePath, name);
    if (!declaration) {
      return NextResponse.json({ error: `Unknown loop: ${name}` }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { itemKey?: string };
    if (body.itemKey !== undefined && typeof body.itemKey !== "string") {
      return NextResponse.json({ error: "itemKey must be a string" }, { status: 400 });
    }
    const client = await daemonProxy();
    const result = await launchManualRound(
      declaration,
      body.itemKey ? { itemKey: body.itemKey } : {},
      {
        createSession: (input) => client.createSession(input),
        sendCommand: (sessionId, command) => client.sendSessionCommand(sessionId, command),
        destroySession: (sessionId) => client.destroySession(sessionId),
      },
    );
    // /api/agent/new 同款后处理：files 路由 allow-list 同步 + id→path 缓存播种
    // （.jsonl 懒建，不播种则紧随其后的 locate 404）+ 会话列表缓存失效。
    if (result.cwd) allowFileRoot(result.cwd);
    if (result.sessionFile) cacheSessionPath(result.sessionId, result.sessionFile);
    invalidateSessionListCache();
    return NextResponse.json({ sessionId: result.sessionId });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof RoundBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: daemonErrorStatus(error) },
    );
  }
}
```

- [ ] **Step 6: 验证 + Commit** — `node_modules/.bin/tsc --noEmit && npm test`；commit `feat(loops): run 路由——手动起一轮（现有 daemon 会话面 + pi-loop 合同/锁，S3）`

---

### Task 7: 工作项详情「Loop」行

**Files:**
- Modify: `components/WorkspaceManager.tsx`（kitLoops 列表已在 Task 3 就位；本任务加详情行 + patchWorkItem 类型）

**Interfaces:**
- Consumes: Task 1 的 `loop` 字段；Task 3 的 `kitLoops` state；现有 `patchWorkItem`（revision-safe PATCH 面）。
- Produces: 详情区「Loop」下拉（未绑定默认）+ 绑定未命中「未生效」角标（spec §3.3）。

- [ ] **Step 1: `patchWorkItem` 签型扩展**（~696）：

```ts
  const patchWorkItem = useCallback(async (
    patch: Partial<Pick<WorkItemRecord, "status" | "phase" | "priority" | "title" | "repositories" | "loop">>
      & { archived?: boolean; loop?: string | null },
  ) => {
```

（函数体不变——body 展开 `...patch` 已透传 `loop: null`。）

- [ ] **Step 2: 详情行**——在「来源」条件块（`{selectedWorkItem.item.external && …}`）**之后**、同一 compact 字段网格内加：

```tsx
                    <div className="workspace-field workspace-field-compact">
                      <span>Loop</span>
                      <div style={{ padding: "9px 0", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                        <select
                          value={selectedWorkItem.item.loop ?? ""}
                          disabled={saving || kitLoops.length === 0}
                          onChange={(event) => void patchWorkItem({ loop: event.target.value || null })}
                          title={kitLoops.length === 0 ? "本工作区没有 kit loop" : "绑定后该工作项只被绑定的 loop 拾取（未绑定项对所有 loop 可见）"}
                        >
                          <option value="">未绑定</option>
                          {kitLoops.map((loop) => (
                            <option key={loop.name} value={loop.name}>
                              {loop.name}{loop.paused ? "（已暂停）" : ""}
                            </option>
                          ))}
                        </select>
                        {selectedWorkItem.item.loop && !kitLoops.some((l) => l.name === selectedWorkItem.item.loop) && (
                          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>未生效（loop 不存在）</span>
                        )}
                      </div>
                    </div>
```

（`selectedWorkItem.item.loop` 在 JSX 中可能为 undefined——TS 下用非空断言或先提 `const boundLoopName = selectedWorkItem.item.loop;` 局部变量再判断，实现者按文件既有写法处理。）

- [ ] **Step 3: 验证 + Commit** — `node_modules/.bin/tsc --noEmit && npm test`；commit `feat(work-items): 详情「Loop」绑定行（软校验 + 未生效角标，spec §3.3）`

---

### Task 8: 预填绑定改造（handleRunContract 三分支）

**Files:**
- Create: `lib/loops/contract-prefill.ts`
- Test: `lib/loops/contract-prefill.test.mjs`（新）
- Modify: `components/shell/useAppShellState.ts`（handleRunContract）

**Interfaces:**
- Produces: `resolveContractPattern(loop: string | undefined, loops: Array<{ name?: string; pattern: string; paused?: boolean }>): string | undefined`——绑定命中（且非 paused）→ 该 loop 的 pattern；未命中/未绑定/绑到 paused → 回落第一个非 paused loop；无 active loops → undefined（裸 prompt 降级）。Task 9 复用同一函数解析 B 按钮的默认 loop。

- [ ] **Step 1: 写失败测试** `lib/loops/contract-prefill.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveContractPattern } from "./contract-prefill.ts";

const LOOPS = [
  { name: "dev-loop", pattern: "dev-loop" },
  { name: "triage-loop", pattern: "triage" },
];

test("binding hit → that loop's pattern", () => {
  assert.equal(resolveContractPattern("triage-loop", LOOPS), "triage");
  assert.equal(resolveContractPattern("dev-loop", LOOPS), "dev-loop");
});

test("unbound / unknown binding → falls back to first active loop", () => {
  assert.equal(resolveContractPattern(undefined, LOOPS), "dev-loop");
  assert.equal(resolveContractPattern("gone-loop", LOOPS), "dev-loop");
});

test("binding to a paused loop is a miss → fallback skips paused loops", () => {
  const loops = [
    { name: "dev-loop", pattern: "dev-loop", paused: true },
    { name: "triage-loop", pattern: "triage" },
  ];
  assert.equal(resolveContractPattern("dev-loop", loops), "triage");
  assert.equal(resolveContractPattern(undefined, loops), "triage");
});

test("no active loops → undefined (bare prompt degradation)", () => {
  assert.equal(resolveContractPattern("dev-loop", []), undefined);
  assert.equal(resolveContractPattern(undefined, [{ name: "x", pattern: "x", paused: true }]), undefined);
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test lib/loops/contract-prefill.test.mjs`
- [ ] **Step 3: 实现 `lib/loops/contract-prefill.ts`**

```ts
/** 「开始对话/收养续跑」预填的 pattern 解析（spec §3.3 三分支，纯函数）。
 *  绑定存 loop 名（S1）；paused = 不存在（S5）——绑到 paused 的按未命中处理。 */
export interface PrefillLoopSummary {
  name?: string;
  pattern: string;
  paused?: boolean;
}

export function resolveContractPattern(
  loop: string | undefined,
  loops: PrefillLoopSummary[],
): string | undefined {
  const active = loops.filter((entry) => !entry.paused);
  if (loop) {
    const hit = active.find((entry) => entry.name === loop);
    if (hit) return hit.pattern;
  }
  return active[0]?.pattern;
}
```

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 接进 handleRunContract**（`components/shell/useAppShellState.ts` ~951）：

import（文件顶部，相对路径约定）：

```ts
import { resolveContractPattern } from "@/lib/loops/contract-prefill";
```

（useAppShellState 已用 `@/` 别名——遵循文件既有风格。）

fetch 成功分支改为：

```ts
      if (response.ok) {
        const data = (await response.json()) as { loops?: Array<{ name?: string; pattern: string; paused?: boolean }> };
        pattern = resolveContractPattern(item.loop, data.loops ?? []);
      }
```

（`item.loop` 来自入参 `WorkItemRecord`——Task 1 已有该字段。）

- [ ] **Step 6: 验证 + Commit** — `node_modules/.bin/tsc --noEmit && npm test`；commit `feat(work-items): run-contract 预填按绑定 loop 解析 pattern（未绑定回落第一个，paused 跳过）`

---

### Task 9: 「立即跑一轮」按钮（B）

**Files:**
- Modify: `components/shell/useAppShellState.ts`（新增 `handleRunLoopRound` + 导出）
- Modify: `components/shell/DesktopShell.tsx`、`components/shell/MobileShell.tsx`（解构 + 传 prop，各 2 个 WorkspaceManager 挂载点）
- Modify: `components/WorkspaceManager.tsx`（Props + 按钮渲染）

**Interfaces:**
- Consumes: Task 6 run 路由；Task 8 `resolveContractPattern`；`handleOpenWorkItemConversation` 的开-tab 骨架（locate → ensureTab → updateTab chat → activateTab → setSessionKey → focusChat → navigateUrl）。
- Produces: `handleRunLoopRound(workspace: WorkspaceSummary, item: WorkItemRecord, loopName: string): Promise<void>`；WorkspaceManager prop `onRunLoopRound?: (workspace, item, loopName) => void`。

- [ ] **Step 1: useAppShellState 加 handler**（放 handleOpenWorkItemConversation 之后，依赖数组照抄其骨架）：

```ts
  /** 「立即跑一轮」（spec §4 B 按钮）：POST run 路由（daemon 现有会话面起轮），
   *  成功后把新轮会话开成 workspace 的 chat tab（SSE 实时观看；locate 直接命中
   *  ——run 路由已播种 cacheSessionPath）。409（本轮已在跑）等错误用 alert 直陈。 */
  const handleRunLoopRound = useCallback(async (
    workspace: WorkspaceSummary,
    item: WorkItemRecord,
    loopName: string,
  ): Promise<void> => {
    let sessionId: string | undefined;
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(loopName)}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemKey: item.key }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { sessionId?: string; error?: string };
      if (!response.ok || !body.sessionId) {
        window.alert(body.error || `起轮失败（HTTP ${response.status}）`);
        return;
      }
      sessionId = body.sessionId;
    } catch (error) {
      window.alert(`起轮失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setConfigView(null);
    setWorkItemDetail(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/locate`);
      if (response.ok) {
        const data = await response.json() as { session?: SessionInfo };
        if (data.session) {
          ensureTab(workspace);
          updateTab(workspace.id, { view: "chat", session: data.session, newSessionCwd: null });
          activateTab(workspace.id);
          setSessionKey((key) => key + 1);
          setSystemPrompt(null);
          focusChat();
          navigateUrl(`workspace=${encodeURIComponent(workspace.id)}&view=chat&session=${encodeURIComponent(sessionId)}`);
          return;
        }
      }
    } catch { /* fall through */ }
    window.alert("轮已启动，但打开会话视图失败——请从会话列表进入。");
  }, [ensureTab, updateTab, activateTab, navigateUrl, focusChat]);
```

（`SessionInfo`/`WorkspaceSummary`/`WorkItemRecord` 类型文件已在该文件 import。）加入 hook 返回对象（`handleOpenWorkItemConversation,` 旁）。

- [ ] **Step 2: shells 传 prop**——DesktopShell / MobileShell 各自：解构处（DesktopShell.tsx:98 一带 / MobileShell.tsx:133 一带）加 `handleRunLoopRound,`；两个 WorkspaceManager 挂载点（Desktop 188/248、Mobile 277/315）加 `onRunLoopRound={handleRunLoopRound}`。

- [ ] **Step 3: WorkspaceManager 按钮区**——Props 接口加：

```ts
  onRunLoopRound?: (workspace: WorkspaceSummary, item: WorkItemRecord, loopName: string) => void;
```

组件内解构处加 `onRunLoopRound`。按钮放在「开始对话/收养续跑」同一 gate 块内（~1200 起，`onRunContract && hasKitLoops && …` 条件下的按钮行——B 按钮独立于 conversations 是否为空，仅要求同样的 phase/status gate）。在组件顶部附近加：

```ts
  const [runLoopPick, setRunLoopPick] = useState("");
```

按钮渲染逻辑（放在 header 按钮区，`开始对话`/`收养续跑` 之后）：

```tsx
                    {onRunLoopRound && hasKitLoops && selectedWorkItem.item.phase !== "complete" && selectedWorkItem.item.status !== "done" && selectedWorkItem.item.status !== "cancelled" && (() => {
                      const activeKitLoops = kitLoops.filter((l) => !l.paused); // kitLoops 存全量（Task 3）
                      const boundLoopName = selectedWorkItem.item.loop;
                      const defaultLoop = activeKitLoops.find((l) => l.name === boundLoopName)
                        ?? (activeKitLoops.length === 1 ? activeKitLoops[0] : undefined);
                      if (defaultLoop) {
                        return (
                          <button
                            className="workspace-action"
                            disabled={saving}
                            onClick={() => void onRunLoopRound(selectedWorkspace, selectedWorkItem.item, defaultLoop.name)}
                            title={`立即起一轮 ${defaultLoop.name}（daemon 会话，实时观看；本轮优先处理 ${selectedWorkItem.item.key}）`}
                          >
                            立即跑一轮
                          </button>
                        );
                      }
                      if (activeKitLoops.length === 0) return null;
                      // 未绑定且多 loop：选择菜单（spec §4 入口 gate）
                      const pick = runLoopPick && activeKitLoops.some((l) => l.name === runLoopPick)
                        ? runLoopPick : activeKitLoops[0]?.name ?? "";
                      return (
                        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <select
                            value={pick}
                            disabled={saving}
                            onChange={(event) => setRunLoopPick(event.target.value)}
                            style={{ fontSize: 12 }}
                            title="选择用哪个 loop 起轮"
                          >
                            {activeKitLoops.map((l) => (
                              <option key={l.name} value={l.name}>{l.name}</option>
                            ))}
                          </select>
                          <button
                            className="workspace-action"
                            disabled={saving}
                            onClick={() => void onRunLoopRound(selectedWorkspace, selectedWorkItem.item, pick)}
                            title={`立即起一轮 ${pick}（daemon 会话，实时观看；本轮优先处理 ${selectedWorkItem.item.key}）`}
                          >
                            立即跑一轮
                          </button>
                        </span>
                      );
                    })()}
```

（`selectedWorkspace` 是该组件既有变量；若 header 区 `marginLeft: "auto"` 与既有按钮冲突，实现者按相邻按钮的布局微调，不新造样式类。）

- [ ] **Step 4: 验证 + Commit** — `node_modules/.bin/tsc --noEmit && npm test && npm run lint`；commit `feat(work-items): 「立即跑一轮」按钮——run 路由起轮 + 打开轮会话 tab（S3/B）`

---

### Task 10: WorkspaceOverview Loops 管理区块

**Files:**
- Create: `lib/loops/cron-summary.ts`
- Test: `lib/loops/cron-summary.test.mjs`（新）
- Modify: `components/WorkspaceOverview.tsx`

**Interfaces:**
- Consumes: Task 3 GET /loops（全量状态）、Task 4 pause/resume/PATCH、Task 5 stop。
- Produces: `summarizeCron(cron: string): string | null`（人话摘要；无法概括 → null，UI 回落原始 cron）；Overview 的 Loops 区块（有 loop 才渲染）。

- [ ] **Step 1: 写失败测试** `lib/loops/cron-summary.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCron } from "./cron-summary.ts";

test("subset humanization", () => {
  assert.equal(summarizeCron("*/30 9-22 * * 1-5"), "工作日 9–22 点每 30 分钟");
  assert.equal(summarizeCron("0 8 * * 1-5"), "工作日 8:00");
  assert.equal(summarizeCron("*/5 * * * *"), "每 5 分钟");
  assert.equal(summarizeCron("15 9 * * *"), "每天 9:15");
  assert.equal(summarizeCron("*/30 9,12,18 * * *"), "9/12/18 点每 30 分钟");
  assert.equal(summarizeCron("0 9-22 * * 0,6"), "周末 9–22 点每 60 分钟");
});

test("unsupported shapes → null (UI falls back to raw cron)", () => {
  assert.equal(summarizeCron("0 0 1 * *"), null);   // dom 受限
  assert.equal(summarizeCron("0 0 * 3 *"), null);   // month 受限
  assert.equal(summarizeCron("5,35 * * * *"), null); // 分钟列表
  assert.equal(summarizeCron("garbage"), null);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `lib/loops/cron-summary.ts`**

```ts
/** cron 人话摘要（Overview Loops 区块，纯函数）。只概括常见形态：
 *  分钟 `*` / `*/n` / 固定值；小时 `*` / 固定 / 范围 / 列表；dow `*` / `1-5` /
 *  `0,6`。dom/month 受限或其它形态 → null（UI 回落显示原始 cron，不撒谎）。 */
const WEEKDAY_TEXT: Record<string, string> = { "1-5": "工作日", "0,6": "周末" };

function dowText(dow: string): string | undefined {
  if (dow === "*") return "";
  if (WEEKDAY_TEXT[dow] !== undefined) return WEEKDAY_TEXT[dow];
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const parts = dow.split(",").map((p) => names[Number(p)]).filter(Boolean);
  return parts.length > 0 ? parts.join("/") : undefined;
}

function hourText(hour: string): string | undefined {
  if (hour === "*") return "";
  const single = hour.match(/^(\d+)$/);
  if (single) return `${single[1]} 点`;
  const range = hour.match(/^(\d+)-(\d+)$/);
  if (range) return `${range[1]}–${range[2]} 点`;
  const list = hour.split(",").map((p) => Number(p));
  if (list.length > 1 && list.every((n) => Number.isInteger(n) && n >= 0 && n <= 23)) {
    return `${list.join("/")} 点`;
  }
  return undefined;
}

export function summarizeCron(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*") return null;
  const dowPart = dowText(dow);
  if (dowPart === undefined) return null;
  const hourPart = hourText(hour);
  if (hourPart === undefined) return null;

  const step = minute.match(/^\*\/(\d+)$/);
  if (step) {
    const prefix = `${dowPart}${hourPart}`.trim();
    return prefix ? `${prefix}每 ${step[1]} 分钟` : `每 ${step[1]} 分钟`;
  }
  const at = minute.match(/^(\d+)$/);
  if (at) {
    const mm = at[1].padStart(2, "0");
    const exactHour = hour.match(/^(\d+)$/);
    if (exactHour) return `${dowPart || "每天"}${exactHour[1].padStart(2, "0")}:${mm}`;
    const prefix = `${dowPart}${hourPart}`.trim();
    return prefix ? `${prefix}每小时的 ${Number(at[1])} 分` : `每小时的 ${Number(at[1])} 分`;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: WorkspaceOverview 区块**——组件顶部 state：

```tsx
  interface LoopRow {
    name: string; pattern: string; level: string; cron: string; timezone: string;
    maxMinutes: number; paused: boolean; running: boolean;
    lastRun?: string; nextDue?: string;
  }
```

（interface 放文件级，Props 旁。）组件内：

```tsx
  const [loops, setLoops] = useState<LoopRow[]>([]);
  const [loopsBusy, setLoopsBusy] = useState(false);
  const [editingLoop, setEditingLoop] = useState<LoopRow | null>(null);
  const [loopForm, setLoopForm] = useState({ cron: "", timezone: "", level: "L1", maxMinutes: 30 });
  const [loopError, setLoopError] = useState<string | null>(null);

  const refreshLoops = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`);
      if (!response.ok) return;
      const data = (await response.json()) as { loops?: LoopRow[] };
      setLoops(data.loops ?? []);
    } catch { /* offline — keep last */ }
  }, [workspace.id]);

  useEffect(() => { void refreshLoops(); }, [refreshLoops]);

  const loopAction = useCallback(async (name: string, action: "pause" | "resume" | "stop") => {
    if (action === "stop" && !window.confirm("终止本轮进程？未完成的工作由下轮补跑。")) return;
    setLoopsBusy(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(name)}/${action}`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        window.alert(body.error || `操作失败（HTTP ${response.status}）`);
      }
      await refreshLoops();
    } finally {
      setLoopsBusy(false);
    }
  }, [refreshLoops, workspace.id]);

  const saveLoopEdit = useCallback(async () => {
    if (!editingLoop) return;
    setLoopsBusy(true);
    setLoopError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(editingLoop.name)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cron: loopForm.cron, timezone: loopForm.timezone,
            level: loopForm.level, max_minutes: Number(loopForm.maxMinutes),
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setLoopError(body.error || `保存失败（HTTP ${response.status}）`);
        return;
      }
      setEditingLoop(null);
      await refreshLoops();
    } finally {
      setLoopsBusy(false);
    }
  }, [editingLoop, loopForm, refreshLoops, workspace.id]);
```

辅助（文件级函数，`formatRelativeTime` 旁）：

```tsx
function formatLoopClock(iso: string): string {
  const date = new Date(iso);
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
```

区块 JSX：插在「仓库 / 知识库」section（~322-397）之后、「最近会话」(~401) 之前：

```tsx
        {loops.length > 0 && (
          <section style={sectionStyle}>
            <h2 style={{ ...sectionHeaderStyle, margin: "0 0 10px" }}>Loops</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {loops.map((loop) => (
                <div
                  key={loop.name}
                  style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8 }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{loop.name}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {summarizeCron(loop.cron) ?? loop.cron}
                  </span>
                  <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--bg-hover)" }}>{loop.level}</span>
                  <span style={{ fontSize: 12, color: loop.running ? "#15803d" : loop.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
                    {loop.running ? "● 运行中" : loop.paused ? "已暂停" : loop.nextDue ? `下次 ${formatLoopClock(loop.nextDue)}` : "空闲"}
                  </span>
                  <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                    <button disabled={loopsBusy} onClick={() => void loopAction(loop.name, loop.paused ? "resume" : "pause")} style={sectionHeaderLinkStyle}>
                      {loop.paused ? "恢复" : "暂停"}
                    </button>
                    <button
                      disabled={loopsBusy}
                      onClick={() => {
                        setEditingLoop(loop);
                        setLoopForm({ cron: loop.cron, timezone: loop.timezone, level: loop.level, maxMinutes: loop.maxMinutes });
                        setLoopError(null);
                      }}
                      style={sectionHeaderLinkStyle}
                    >
                      编辑
                    </button>
                    {loop.running && (
                      <button disabled={loopsBusy} onClick={() => void loopAction(loop.name, "stop")} style={sectionHeaderLinkStyle}>
                        停止
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {editingLoop && (
              <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--border)", borderRadius: 8, display: "grid", gap: 8, maxWidth: 420 }}>
                <strong style={{ fontSize: 13 }}>编辑 {editingLoop.name}</strong>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  cron
                  <input value={loopForm.cron} onChange={(e) => setLoopForm({ ...loopForm, cron: e.target.value })} style={{ fontFamily: "var(--font-mono)" }} />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  timezone
                  <input value={loopForm.timezone} onChange={(e) => setLoopForm({ ...loopForm, timezone: e.target.value })} />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  level
                  <select value={loopForm.level} onChange={(e) => setLoopForm({ ...loopForm, level: e.target.value })}>
                    <option value="L1">L1</option>
                    <option value="L2">L2</option>
                    <option value="L3">L3</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  max_minutes
                  <input type="number" min={1} value={loopForm.maxMinutes} onChange={(e) => setLoopForm({ ...loopForm, maxMinutes: Number(e.target.value) })} />
                </label>
                {loopError && <div style={{ color: "#b91c1c", fontSize: 12 }}>{loopError}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={loopsBusy} onClick={() => void saveLoopEdit()}>保存</button>
                  <button disabled={loopsBusy} onClick={() => setEditingLoop(null)}>取消</button>
                </div>
              </div>
            )}
          </section>
        )}
```

import 行：`import { summarizeCron } from "@/lib/loops/cron-summary";`、`useCallback`（该文件已 import useEffect/useMemo/useState，补 useCallback）。

- [ ] **Step 6: 验证 + Commit** — `node_modules/.bin/tsc --noEmit && npm test && npm run lint`；commit `feat(overview): Loops 管理区块——状态总览/暂停恢复/frontmatter 编辑/停止本轮（spec §5）`

---

### Task 11: 协议文档 + AGENTS.md

**Files:**
- Modify: `kit/README.md`（新增「工作项绑定」一节）
- Modify: `AGENTS.md`（File Map + Loop 章节 + Work Items 章节）

**Interfaces:** 无代码——文档同步（spec §3.2 协议层落文）。

- [ ] **Step 1: kit/README.md**——「断路器」节之前（「权限分级」之后）插入：

```markdown
## 工作项绑定（item.yaml 的 loop 字段）

工作项（pi-web 工作项域）可声明 `loop: <loop名>` 绑定（详情下拉 / `workspace_update_work_item` 工具透传）：

- **绑定 = 路由收窄**：loop 轮拾取候选 = 「绑给我的项 + 未绑定项」——绑定只收窄、不放大；未绑定项维持现状（轮的开场三重判断自主决定）。
- **软校验**：字段存 loop **名**（非 pattern——名字稳定，pattern 可改）。不校验存在性：loop 可能后建/暂删，未命中的绑定按未绑定处理。
- **STATE.md = 执行状态**：工作集、进度、gate 全在 loop 侧 STATE.md；绑定只影响「谁能捡」，不影响「怎么跑」。
- SKILL.md 的选择段应声明该过滤语义（候选 = 绑定项 ∪ 未绑定项）。
```

- [ ] **Step 2: AGENTS.md** 同步（保持该文件「当前基线」性质，更新对应小节）：
  - File Map `app/api/`：`workspaces/[id]/loops/route.ts` 行改为「GET kit loops 全量状态（collectStatus，含 paused）」并追加 `[name]/route.ts (PATCH frontmatter) | [name]/run|pause|resume|stop/route.ts` 四行；
  - File Map `lib/`：加 `lib/loops/`（lookup/rounds/contract-prefill/cron-summary——web 侧轮控制 + 预填解析，import pi-loop 纯逻辑）；
  - 「Work Items」小节：`item.yaml` 字段列表提及 `loop?`；工具入参提及透传；
  - 「Loop」小节：补一段「工作项绑定 + 管理面」（绑定=路由收窄；B 按钮= run 路由现有 daemon 会话面、无 D9；停止= DELETE+reap+释放锁；frontmatter PATCH= 人的手；手动轮锁靠 stale 窗口回收，至多丢一槽）；
  - WorkspaceOverview 描述提及 Loops 区块。
- [ ] **Step 3: Commit** — `docs(kit): 工作项绑定协议语义 + AGENTS.md 基线同步（spec §3.2/§7.5；workspace-c SKILL 行按用户指令不在本计划内）`

---

### Task 12: 终验 + 合并 develop（controller 自做，不派发）

- [ ] **Step 1: 全量验证（worktree 内）** — `node_modules/.bin/tsc --noEmit && npm run lint && npm test` 全绿
- [ ] **Step 2: spec 验收自查**——对照 spec §8 六条逐条给出证据（代码位置/测试名），写入 SDD ledger 收尾记录
- [ ] **Step 3: 合并**（主仓工作区）：

```bash
cd /Users/qiancheng/Documents/Workspace/qyinf-workspace/pi-web
git status --short                       # 记录另一会话 WIP 现状
git stash push -m "loop-surface-merge: AGENTS.md WIP" -- AGENTS.md   # 仅当 AGENTS.md 有未提交改动（预期有）
git merge --no-ff feature/loop-surface -m "Merge branch 'feature/loop-surface' into develop — pi-web loop 产品面：工作项绑定 + 立即跑一轮 + Loops 管理区块（spec: docs/pi-web-loop-surface-design.md S1-S6；plan: docs/pi-web-loop-surface-plan.md）"
git stash pop                            # 恢复另一会话的 AGENTS.md WIP；冲突则停下报告，不强行解决
```

- [ ] **Step 4: 清理** — `git worktree remove ../pi-web-worktrees/loop-surface && git branch -d feature/loop-surface`（合并成功后）；**不 push**
- [ ] **Step 5: 确认另一会话 WIP 完好**（`git status --short` 与 Step 3 记录一致，除已合并内容）

---

## 验收对照（spec §8 → 任务）

| spec 验收 | 任务 |
|---|---|
| 1. 绑定 dev-loop 的项预填 `/skill:dev-loop 执行 REQ-xxxx`；未绑定回落 | T1 + T8 |
| 2. SKILL 过滤：候选 = 绑定项 + 未绑定项 | T11（kit/README；workspace-c 手动） |
| 3. 暂停可见/可恢复/补一轮 | T3 + T4 + pi-loop 既有语义 |
| 4. cron 编辑下一心跳生效 | T2 + T4 |
| 5. 停止：daemon 轮终止（badge 清/SSE 断/收割）；beat 409 | T5 |
| 6. B 按钮：会话出现/命名/锁互斥/优先行 | T6 + T9 |

## 测试面对照（spec §6 → 任务）

| spec 测试 | 任务 |
|---|---|
| service：loop round-trip / 透传 / 软校验 | T1 |
| 预填三分支 | T8 |
| 管理面数据：includePaused / running 判定 | T3（collectStatus 既有 pi-loop 测试）|
| PATCH round-trip：正文 byte/非法 400 | T2 |
| run：锁互斥 409 / 失败释放 / 命名 / 优先行 | T6 |
| stop：daemon DELETE+reap / beat 409 | T5 |
