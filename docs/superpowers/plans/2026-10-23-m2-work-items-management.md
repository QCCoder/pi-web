# 里程碑二：中央工作项管理与人工交付流程实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作项交付工作区作用域的中央管理页（方案 A：列表/看板/详情/深链）与显式启用的人工标准交付流程（七阶段 + 版本绑定确认/验证/发布 + 导入去重与回收站），中央页与聊天快捷面板共享同一份数据层。

**Architecture:** 业务全部落在 `lib/work-items/` 扩展模块（HTTP 路由与 LLM 工具共用同一服务实现）；delivery 元数据是 `item.yaml` 的可选透传块（protocolVersion 1，mode=manual），`item.phase` 仍是阶段唯一权威；UI 层从 `WorkspaceManager` 抽出工作项组件到 `components/work-items/`，新增 `hooks/useWorkItems.ts` 作为按 workspaceId 索引的共享缓存与 mutation 层；中央页复用 CenterPage 承载，深链 `?workspace=<id>&page=work-items&item=<key>` 独立于现有 view= 语法。

**Tech Stack:** Next.js App Router、react hooks、node:test + jiti（纯逻辑与 source 断言）、既有 work-items YAML/JSONL 文件协议。

**Spec:** `docs/superpowers/specs/2026-10-23-phase-one-host-and-work-items-design.md` §6–§9、§10 验证 5–8 与 10。

**前置:** 里程碑一（`docs/superpowers/plans/2026-10-23-m1-single-process-host.md`）已合入（会话/循环走单进程宿主）。本计划的文件改动与 M1 不相交，但执行中断记录的「关联工作项跳转」（spec §5.4 末句）在本计划 T9 落地。

## Global Constraints

- `item.phase` 是阶段唯一权威，不另存 `delivery.stage`（spec §7.1）；外层 schemaVersion 保持现有兼容格式，`delivery` 是可选透传块。
- 未启用标准流程的项（无 `delivery` 块）行为与现在完全一致：旧 loop、旧 phase/status、generic PATCH 全部照旧（spec §7.1–7.2）。
- 标准流程项的 generic PATCH 不得改 phase/status 绕过门禁；流程命令统一走 delivery 动作服务（spec §7.2、§9）。
- 旧 `complete` 显示「历史已完成」，不推断为已发布；旧 analysis/requirement_approval/plan_approval 看板投影到设计组并显示原始标签（spec §7.2）。
- 无门禁豁免：未验证/失败/缺依据不能作为通过推进；第一阶段验收与发布都是人工登记（actor=user）（spec §7.3）。
- 已发布基线冻结：发布后仅展示性字段可改；需求/设计/候选改动走失效回退规则或建关联后续项（spec §7.3）。
- 中央页明确绑定 workspaceId，不得用当前聊天 tab 的 activeWorkspace 代替页面身份（spec §6.1）；深链不与 view= 语法混用（spec §6.1）。
- 导入去重扫描 = 活动 ∪ 归档 ∪ 回收站；重复同步不覆盖本地内容、不复活归档/取消/回收站项（spec §8.1）。
- 「移入回收站」= 移动整个目录到 `.pi/trash/work-items/`，不删除文件、不删除关联会话；恢复原 key 冲突返回 409（spec §6.2、§8.1）。
- 路径安全：所有文件/产物引用继续执行工作区路径约束，禁止穿越与符号链接逃逸（spec §9）。
- 测试 = `node --test`（lib 纯逻辑 + source 断言）+ tsc + lint + 浏览器手测；**不运行 `next build`**。频繁提交。

---

### Task 1: delivery 元数据模型与阶段增补

**Files:**
- Modify: `lib/work-items/types.ts`
- Modify: `lib/work-items/service.ts`（`WORK_ITEM_PHASES` 常量、`parseWorkItem` 透传/校验 `delivery`、`serializeWorkItem` round-trip）
- Create: `lib/work-items/delivery-types.ts`
- Test: `lib/work-items/delivery-types.test.mjs`

**Interfaces:**
- Produces（全计划依赖）：

```ts
// lib/work-items/delivery-types.ts
export type DeliveryAction =
  | "start-design" | "confirm-design" | "start-development" | "submit-verification"
  | "record-verification" | "prepare-release" | "record-release"
  | "rework" | "block" | "unblock" | "cancel";

export interface DeliveryCandidate { repositoryId: string; commit: string }

export interface DeliveryDesignConfirmation {
  at: string;
  actor: "user";
  requirementDigest: string;
  designDigest: string;
}

export interface DeliveryVerificationRecord {
  at: string;
  actor: "user";
  requirementDigest: string;
  candidateDigest: string;
  checks: Array<{ name: string; outcome: "passed" | "failed" | "unverified"; note?: string }>;
}

export interface DeliveryReleaseRecord {
  at: string;
  actor: "user";
  version: string;
  candidates: DeliveryCandidate[];
  notes?: string;
  rollback?: string;
}

export interface DeliveryReleasePlan { notes?: string; rollback?: string }

export interface DeliveryMetadata {
  protocolVersion: 1;
  mode: "manual";
  designConfirmed?: DeliveryDesignConfirmation;
  candidates?: DeliveryCandidate[];
  verification?: DeliveryVerificationRecord;
  releasePlan?: DeliveryReleasePlan;
  release?: DeliveryReleaseRecord;
  /** 幂等指纹（spec §9）：最近一次已受理的动作。同 requestId+action 重放直接返回现态。 */
  lastRequest?: { requestId: string; action: DeliveryAction; at: string };
}

export function contentDigest(content: string): string  // sha256 hex（crypto）
export function candidatesDigest(candidates: DeliveryCandidate[]): string  // 规范序（按 repositoryId 排序）后 JSON 序列化的 sha256
export function parseDelivery(value: unknown): DeliveryMetadata  // 校验 protocolVersion===1，否则 throw WorkItemValidationError("Unknown delivery protocolVersion: N")；mode!=="manual" 同样拒绝
```

- `WorkItemRecord` 追加 `delivery?: DeliveryMetadata`（types.ts）。
- `WorkItemPhase` 增补 `"ready_for_implementation" | "release_ready" | "released"`（旧八个值不动）。

- [ ] **Step 1: 写失败测试**

```js
// lib/work-items/delivery-types.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const dt = await jiti.import("./delivery-types.ts");

test("parseDelivery accepts v1 manual and round-trips optional fields", () => {
  const delivery = dt.parseDelivery({ protocolVersion: 1, mode: "manual" });
  assert.equal(delivery.protocolVersion, 1);
  const full = dt.parseDelivery({
    protocolVersion: 1, mode: "manual",
    designConfirmed: { at: "t", actor: "user", requirementDigest: "a", designDigest: "b" },
    candidates: [{ repositoryId: "r2", commit: "c2" }, { repositoryId: "r1", commit: "c1" }],
  });
  assert.equal(full.candidates.length, 2);
});

test("parseDelivery rejects unknown protocolVersion and non-manual mode", () => {
  assert.throws(() => dt.parseDelivery({ protocolVersion: 2, mode: "manual" }), /Unknown delivery protocolVersion/);
  assert.throws(() => dt.parseDelivery({ protocolVersion: 1, mode: "auto" }), /mode/);
});

test("digests are stable and order-insensitive for candidates", () => {
  const a = dt.candidatesDigest([{ repositoryId: "r1", commit: "c" }, { repositoryId: "r2", commit: "d" }]);
  const b = dt.candidatesDigest([{ repositoryId: "r2", commit: "d" }, { repositoryId: "r1", commit: "c" }]);
  assert.equal(a, b);
  assert.equal(dt.contentDigest("x"), dt.contentDigest("x"));
  assert.notEqual(dt.contentDigest("x"), dt.contentDigest("y"));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/work-items/delivery-types.test.mjs
```

- [ ] **Step 3: 实现 delivery-types.ts + types/service 接线**

`delivery-types.ts` 按上方接口实现（`parseDelivery` 逐字段校验：确认/验证/发布记录的字段类型与 actor==="user"；candidates 每项 repositoryId/commit 非空字符串）。

`types.ts`：
- `WorkItemPhase` 增补三个值。
- `import type { DeliveryMetadata } from "./delivery-types"` + `WorkItemRecord.delivery?: DeliveryMetadata`。
- `CreateWorkItemInput` 追加 `enableDelivery?: boolean`（HTTP 表单勾选用；LLM 工具不透传）。

`service.ts`：
- `WORK_ITEM_PHASES` 常量数组追加三值（`parseWorkItem` 的 phase 校验自动放行）。
- `parseWorkItem`：value 里存在 `delivery` 键时 `next.delivery = parseDelivery(value.delivery)`（缺省跳过——旧项无此块）。
- `serializeWorkItem`：`delivery` 存在时原样序列化（YAML 对象嵌套）。
- `createWorkItem`：`input.enableDelivery === true` 时新项 `delivery = { protocolVersion: 1, mode: "manual" }`、`phase = "intake"`（缺省不动现状）。

- [ ] **Step 4: 跑测试 + 回归**

```bash
node --test lib/work-items/*.test.mjs
node_modules/.bin/tsc --noEmit
```
Expected: 新测试 PASS，旧 work-items 测试不回归。

- [ ] **Step 5: Commit**

```bash
git add lib/work-items
git commit -m "feat: add delivery metadata model and standard-flow phases"
```

---

### Task 2: 交付流程状态机与动作服务

**Files:**
- Create: `lib/work-items/delivery.ts`
- Create: `lib/work-items/delivery.test.mjs`
- Create: `lib/workspaces/file-lock.ts`、`lib/workspaces/file-lock.test.mjs`
- Modify: `lib/work-items/service.ts`（generic PATCH 门禁 + 内容/设计变更失效规则）
- Modify: `lib/workspaces/service.ts`（withWorkspaceWriteLock 双层化）
- Create: `app/api/workspaces/[id]/work-items/[key]/design/route.ts`（设计正文编辑）

**Interfaces:**
- Consumes: Task 1 全部；`service.ts` 的 `readWorkItem`/`updateWorkItem`/`appendEvent`/`withWorkspaceWriteLock`/`eventFor`、`getWorkspace`。
- Produces（T3 路由消费）：

```ts
// lib/work-items/delivery.ts
export interface DeliveryActionInput {
  workspaceId: string;
  key: string;
  action: DeliveryAction;
  expectedRevision: number;
  requestId: string;                 // 幂等键（非空字符串）
  actor?: "user";
  conversationId?: string;
  payload?: Record<string, unknown>; // 动作参数：candidates/checks/version/notes/rollback/reason/releaseNotes
}
export interface DeliveryActionOutcome {
  detail: WorkItemDetail;
  replayed: boolean;                 // requestId 命中 → 未重放变更
}
export async function applyDeliveryAction(input: DeliveryActionInput): Promise<DeliveryActionOutcome>
/** 纯转移规划：非法动作/缺失依据 throw WorkItemValidationError（HTTP 400/422）。 */
export function planDeliveryTransition(
  item: WorkItemRecord,
  action: DeliveryAction,
  payload: Record<string, unknown>,
  now: Date,
): { phase: WorkItemPhase; status?: WorkItemStatus; delivery: DeliveryMetadata; eventType: string; eventData: Record<string, unknown>; designContent?: string }
export function legalDeliveryActions(item: WorkItemRecord): DeliveryAction[]  // 详情页动作条渲染
```

- [ ] **Step 1: 写失败测试（状态机核心规则）**

```js
// lib/work-items/delivery.test.mjs —— 全部针对纯函数 planDeliveryTransition / legalDeliveryActions
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const delivery = await jiti.import("./delivery.ts");
const { planDeliveryTransition, legalDeliveryActions } = delivery;

const baseItem = (over = {}) => ({
  schemaVersion: 1, id: "id", key: "REQ-0001", revision: 1, type: "requirement",
  title: "t", status: "open", phase: "intake", priority: "P2",
  repositories: [], tags: [], conversations: [], relatedItems: [], designs: [], plans: [],
  archivedAt: null, createdAt: "t", updatedAt: "t",
  delivery: { protocolVersion: 1, mode: "manual" }, ...over,
});

test("start-design moves intake to design", () => {
  const plan = planDeliveryTransition(baseItem(), "start-design", {}, new Date("2026-10-23T00:00:00Z"));
  assert.equal(plan.phase, "design");
  assert.match(plan.eventType, /delivery\.start-design/);
});

test("confirm-design requires a design digest and moves to ready_for_implementation", () => {
  const item = baseItem({ phase: "design" });
  const plan = planDeliveryTransition(item, "confirm-design", {}, new Date("2026-10-23T00:00:00Z"));
  assert.equal(plan.phase, "ready_for_implementation");
  assert.equal(plan.delivery.designConfirmed.actor, "user");
  assert.ok(plan.delivery.designConfirmed.designDigest);
  assert.ok(plan.delivery.designConfirmed.requirementDigest);
});

test("confirm-design is rejected outside design phase", () => {
  assert.throws(() => planDeliveryTransition(baseItem({ phase: "intake" }), "confirm-design", {}, new Date()), /phase/);
});

test("submit-verification requires at least one candidate with repositoryId+commit", () => {
  const item = baseItem({ phase: "implementation", delivery: { protocolVersion: 1, mode: "manual" } });
  assert.throws(() => planDeliveryTransition(item, "submit-verification", { candidates: [] }, new Date()), /candidate/i);
  const plan = planDeliveryTransition(item, "submit-verification",
    { candidates: [{ repositoryId: "r1", commit: "abc" }] }, new Date());
  assert.equal(plan.phase, "verification");
  assert.equal(plan.delivery.candidates.length, 1);
  assert.equal(plan.delivery.verification, undefined);  // 旧通过结果不得沿用
});

test("record-verification passes only when every check passed", () => {
  const cand = [{ repositoryId: "r1", commit: "abc" }];
  const item = baseItem({ phase: "verification", delivery: { protocolVersion: 1, mode: "manual", candidates: cand } });
  assert.throws(() => planDeliveryTransition(item, "record-verification",
    { checks: [{ name: "回归", outcome: "failed" }] }, new Date()), /rework|未通过/);
  const plan = planDeliveryTransition(item, "record-verification",
    { checks: [{ name: "回归", outcome: "passed" }] }, new Date());
  assert.equal(plan.phase, "release_ready");
  assert.equal(plan.delivery.verification.checks[0].outcome, "passed");
  assert.ok(plan.delivery.verification.candidateDigest);
});

test("record-release freezes the baseline and marks done", () => {
  const cand = [{ repositoryId: "r1", commit: "abc" }];
  const item = baseItem({ phase: "release_ready", delivery: {
    protocolVersion: 1, mode: "manual", candidates: cand,
    verification: { at: "t", actor: "user", requirementDigest: "d", candidateDigest: "cd", checks: [{ name: "x", outcome: "passed" }] },
  } });
  const plan = planDeliveryTransition(item, "record-release", { version: "v1.2.0" }, new Date());
  assert.equal(plan.phase, "released");
  assert.equal(plan.status, "done");
  assert.equal(plan.delivery.release.version, "v1.2.0");
  assert.deepEqual(plan.delivery.release.candidates, cand);
});

test("record-release requires version", () => {
  const item = baseItem({ phase: "release_ready", delivery: { protocolVersion: 1, mode: "manual", candidates: [{ repositoryId: "r", commit: "c" }] } });
  assert.throws(() => planDeliveryTransition(item, "record-release", {}, new Date()), /version/);
});

test("rework records a reason and rewinds to implementation or design", () => {
  const item = baseItem({ phase: "verification", delivery: { protocolVersion: 1, mode: "manual", candidates: [{ repositoryId: "r", commit: "c" }] } });
  assert.throws(() => planDeliveryTransition(item, "rework", {}, new Date()), /reason/);
  const impl = planDeliveryTransition(item, "rework", { reason: "实现缺陷 X", target: "implementation" }, new Date());
  assert.equal(impl.phase, "implementation");
  assert.equal(impl.delivery.designConfirmed, undefined);      // 下游证据失效
  assert.equal(impl.delivery.verification, undefined);
  const design = planDeliveryTransition(item, "rework", { reason: "方案不成立", target: "design" }, new Date());
  assert.equal(design.phase, "design");
});

test("block/unblock toggle status without touching phase; cancel terminal", () => {
  const item = baseItem({ phase: "implementation", status: "in_progress" });
  assert.equal(planDeliveryTransition(item, "block", { reason: "等环境" }, new Date()).status, "blocked");
  const b = planDeliveryTransition(baseItem({ phase: "implementation", status: "blocked" }), "unblock", {}, new Date());
  assert.equal(b.status, "in_progress");
  assert.equal(planDeliveryTransition(item, "cancel", { reason: "不做" }, new Date()).status, "cancelled");
});

test("released baseline rejects further flow actions except display ones", () => {
  const released = baseItem({ phase: "released", status: "done" });
  assert.throws(() => planDeliveryTransition(released, "start-development", {}, new Date()), /已发布|released/);
  assert.throws(() => planDeliveryTransition(released, "rework", { reason: "x" }, new Date()), /已发布|released/);
});

test("unmanaged items have no legal delivery actions", () => {
  const item = baseItem();
  delete item.delivery;
  assert.deepEqual(legalDeliveryActions(item), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test lib/work-items/delivery.test.mjs
```

- [ ] **Step 3: 实现 `lib/work-items/delivery.ts`**

要点（`planDeliveryTransition` 纯函数，不碰 fs）：

- **managed 判定**：`item.delivery?.protocolVersion === 1`；未启用项任何动作 → `WorkItemValidationError("Standard delivery flow is not enabled on this item")`。
- **已发布冻结**：`item.phase === "released"` 时除 `block/unblock/cancel` 外全拒（"已发布基线冻结，请创建关联后续项"）。
- 各动作按测试语义实现；`payload` 解析用小型 require 辅助（`requireCandidates`/`requireChecks`/`requireText`）；`designContent` 仅 `start-design` 返回（种子模板，见 apply 落盘）。
- `eventType` 统一 `delivery.<action>`；`eventData` 带 `{ reason?, candidates?, checks?, version?, phase, requestId }`。
- `confirm-design` 的 `requirementDigest`/`designDigest` 由 apply 阶段计算（纯函数收 `payload.requirementDigest`/`payload.designDigest`，由 apply 填入——plan 的默认实现：payload 缺失时用 `"pending"` 占位并断言 apply 一定传入）。**简化**：`planDeliveryTransition` 直接接收 payload 中已算好的 digest（apply 计算），测试里 `confirm-design` 断言字段存在即可（payload 由 apply 注入 `"x"`…）——为保测试如上所写，plan 在 payload 缺 digest 时以 `contentDigest(action + item.key + now.toISOString())` 生成确定值占位不可取。**最终口径**：`planDeliveryTransition(item, action, payload, now, digests?: { requirement?: string; design?: string })`，`confirm-design` 与 `record-verification` 从 `digests` 取（apply 传入真值）；测试传 `digests: { requirement: "d", design: "d" }` 形参（上面测试代码相应补一个参数——执行者按此对齐，断言不变）。

`applyDeliveryAction`（锁内编排）：

```ts
export async function applyDeliveryAction(input: DeliveryActionInput): Promise<DeliveryActionOutcome> {
  if (!input.requestId || typeof input.requestId !== "string") {
    throw new WorkItemValidationError("requestId is required");
  }
  const { path: workspacePath } = await getWorkspace(input.workspaceId);
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, input.key);
    // 幂等重放：同 requestId+action 直接返回现态（不 bump 不追加）
    if (current.item.delivery?.lastRequest?.requestId === input.requestId
      && current.item.delivery.lastRequest.action === input.action) {
      return { detail: current, replayed: true };
    }
    if (input.expectedRevision !== current.item.revision) {
      throw new WorkItemConflictError(
        `Expected revision ${input.expectedRevision}, current revision is ${current.item.revision}`);
    }
    const now = new Date();
    const content = current.content;
    const designPath = join(current.path, "delivery", "artifacts", "design.md");
    let designContent: string | undefined;
    try { designContent = await readFile(designPath, "utf8"); } catch { /* absent */ }
    const digests = {
      requirement: contentDigest(content),
      ...(designContent !== undefined ? { design: contentDigest(designContent) } : {}),
    };
    const plan = planDeliveryTransition(current.item, input.action, input.payload ?? {}, now, digests);
    // 落盘：design.md 种子（start-design 且文件缺失）
    if (plan.designContent !== undefined && designContent === undefined) {
      await mkdir(dirname(designPath), { recursive: true });
      await writeAtomic(designPath, plan.designContent);
    }
    const next: WorkItemRecord = structuredClone(current.item);
    next.phase = plan.phase;
    if (plan.status !== undefined) next.status = plan.status;
    next.delivery = { ...plan.delivery, lastRequest: { requestId: input.requestId, action: input.action, at: now.toISOString() } };
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(current.path, "item.yaml"), serializeWorkItem(next));
    await appendEvent(current.path, eventFor(plan.eventType, input.actor ?? "user", input.conversationId,
      { ...plan.eventData, revision: next.revision, requestId: input.requestId }));
    await commitWorkspaceChanges(workspacePath, `workspace: delivery ${input.action} ${input.key}`);
    return { detail: await readWorkItem(workspacePath, input.key), replayed: false };
  });
}
```

（`start-design` 的 `plan.designContent` = 设计模板种子：`# 设计：${item.title}\n\n## 方案\n\n## 验收条件\n- [ ] \n`。`confirm-design` 要求 design.md 已存在且非空——`planDeliveryTransition` 由 `digests.design` 的有无判定，缺 → throw "先编写设计内容与验收条件"。）

- [ ] **Step 4: 跨进程短写锁（spec §8.2：Web 与 pi-loop CLI/外部加载共用同一套锁）**

现有 `withWorkspaceWriteLock`（`lib/workspaces/service.ts:108`）是进程内 promise 队列——单进程 Web 内互斥足够，但外部进程（未来的 CLI 侧扩展加载）无法参与。升级为双层：

Create: `lib/workspaces/file-lock.ts`：

```ts
/** 跨进程工作区短写锁：O_EXCL 创建 `<ws>/.pi/.write-lock`，内容 = owner token
 *  （`${pid}@${hostname}:${randomUUID()}` + 创建时间）。获取失败 → 读持有者：
 *  持有者 pid 死亡或超过 stale 窗（默认 30s，短事务）→ 删锁重试一次；仍失败
 *  → 抛 WorkItemConflictError("workspace write lock is busy")。释放时核对
 *  owner token 再删（不误删他人锁）。删除自身目录内文件不受信任边界影响
 *  （.pi/ 本就是宿主文件区）。 */
export async function withWorkspaceFileLock<T>(workspacePath: string, operation: () => Promise<T>, options?: { staleMs?: number }): Promise<T>
export function readLockOwner(lockPath: string): { pid: number; hostname: string; token: string; createdAt: number } | null  // 纯解析
export function isLockStale(owner: ReturnType<typeof readLockOwner>, now: number, staleMs: number): boolean  // 纯判定：pid 不可 kill(0) 或超窗
```

`lib/workspaces/service.ts` 的 `withWorkspaceWriteLock` 改为：进程内队列（防本进程自锁竞争）之外再包 `withWorkspaceFileLock`。测试 `lib/workspaces/file-lock.test.mjs`：mkdtemp 两个「进程」视角（直接两次调用 + 注入假 owner 文件：活 pid / 死 pid / 超窗）验证获取、stale 抢占、token 校验不误删。

- [ ] **Step 5: generic PATCH 门禁 + 内容/设计失效规则（service.ts）**

`updateWorkItem` 锁内、构造 `next` 之前追加：

```ts
    // 标准流程项：phase/status 只能走流程动作（spec §7.2），generic PATCH 绕门禁即 400
    if (current.item.delivery?.protocolVersion === 1 && (input.phase !== undefined || input.status !== undefined)) {
      throw new WorkItemValidationError(
        "Standard-flow items change phase/status only through delivery actions");
    }
    // 已发布基线冻结：仅展示性字段（spec §7.3）
    if (current.item.phase === "released" && (input.repositories !== undefined || input.loop !== undefined)) {
      throw new WorkItemValidationError("Released baseline is frozen — create a follow-up item instead");
    }
```

`updateWorkItemContent` 锁内追加确定性失效规则（§7.3 输入变化的回退）：

```ts
    if (current.item.delivery?.protocolVersion === 1 && current.item.phase !== "released"
      && current.item.delivery.designConfirmed) {
      next.delivery = {
        ...next.delivery,
        designConfirmed: undefined,
        candidates: undefined,
        verification: undefined,
      };
      next.phase = "design";  // 已确认后修改需求 → 撤销确认与下游证据，回设计等待重新确认
      // （事件在既有 work_item.content_updated 之外追加失效事件）
      await appendEvent(current.path, eventFor("delivery.invalidated", input.actor ?? "user", input.conversationId,
        { reason: "requirement-changed", fromPhase: current.item.phase }));
    }
```

（放在既有 revision bump 之前，与现有写入流程合并——revision 照常 bump。）

- [ ] **Step 6: 设计正文路由 `app/api/workspaces/[id]/work-items/[key]/design/route.ts`**

```ts
import { NextResponse } from "next/server";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { readDesign, updateDesignContent } from "@/lib/work-items/delivery";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  try {
    const { id, key } = await params;
    return NextResponse.json(await readDesign(id, key));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  try {
    const { id, key } = await params;
    const input = await req.json() as { expectedRevision: number; content: string; actor?: "user" };
    return NextResponse.json(await updateDesignContent(id, key, input));
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
```

`delivery.ts` 补 `readDesign(workspaceId, key)`（不存在 → 404 型 NotFound）与 `updateDesignContent`（锁内写 design.md；若 `designConfirmed` 存在且新 digest ≠ 旧 → 与需求变更同一失效规则：清确认/验证/候选、phase 回 `design`、追加 `delivery.invalidated` 事件 reason:"design-changed"；revision bump）。

- [ ] **Step 7: 跑测试 + tsc**

```bash
node --test lib/work-items/delivery.test.mjs lib/work-items/delivery-types.test.mjs lib/workspaces/file-lock.test.mjs
node_modules/.bin/tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add lib/work-items app/api/workspaces
git commit -m "feat: standard delivery flow state machine, actions and freeze rules"
```

---

### Task 3: 流程动作 API 路由

**Files:**
- Create: `app/api/workspaces/[id]/work-items/[key]/delivery/[action]/route.ts`
- Test: `lib/work-items/delivery-route.test.mjs`（source 断言 + web.ts 错误映射确认）

**Interfaces:**
- Consumes: Task 2 `applyDeliveryAction`、`DeliveryAction`、`workItemErrorResponse`。
- Produces: `POST /api/workspaces/[id]/work-items/[key]/delivery/[action]`，body = `{ expectedRevision, requestId, payload? }`；响应 `{ detail, replayed }`；错误经 `workItemErrorResponse`（NotFound 404 / Conflict 409 / Validation 400；「缺失依据」= Validation 400 携带 message）。

- [ ] **Step 1: 写失败测试**

```js
// lib/work-items/delivery-route.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("delivery action route validates the action slug and delegates to the service", async () => {
  const src = await readFile(new URL("../../app/api/workspaces/[id]/work-items/[key]/delivery/[action]/route.ts", import.meta.url), "utf8");
  assert.match(src, /DELIVERY_ACTIONS/);
  assert.match(src, /applyDeliveryAction/);
  assert.match(src, /workItemErrorResponse/);
  assert.match(src, /400/);  // 未知 action
});
```

- [ ] **Step 2: 实现**

```ts
// app/api/workspaces/[id]/work-items/[key]/delivery/[action]/route.ts
import { NextResponse } from "next/server";
import { workItemErrorResponse } from "@/lib/work-items/web";
import { applyDeliveryAction, type DeliveryAction } from "@/lib/work-items/delivery";

const DELIVERY_ACTIONS = new Set<string>([
  "start-design", "confirm-design", "start-development", "submit-verification",
  "record-verification", "prepare-release", "record-release", "rework", "block", "unblock", "cancel",
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; key: string; action: string }> },
) {
  try {
    const { id, key, action } = await params;
    if (!DELIVERY_ACTIONS.has(action)) {
      return NextResponse.json({ error: `Unknown delivery action: ${action}` }, { status: 400 });
    }
    const body = await req.json() as {
      expectedRevision?: number; requestId?: string; payload?: Record<string, unknown>;
    };
    const outcome = await applyDeliveryAction({
      workspaceId: id,
      key,
      action: action as DeliveryAction,
      expectedRevision: body.expectedRevision as number,
      requestId: body.requestId as string,
      payload: body.payload,
    });
    return NextResponse.json(outcome);
  } catch (error) {
    return workItemErrorResponse(error);
  }
}
```

（`workItemErrorResponse` 现有映射已覆盖三类错误；`prepare-release` 的 payload `{ notes?, rollback? }` 只更新 `delivery.releasePlan`，实现于 `planDeliveryTransition`：phase 保持 `release_ready`，event `delivery.prepare-release`。）

- [ ] **Step 3: 跑测试 + 手测（curl）**

```bash
node --test lib/work-items/delivery-route.test.mjs && node_modules/.bin/tsc --noEmit
npm run dev
# curl -X POST .../work-items/REQ-0001/delivery/start-design -d '{"expectedRevision":3,"requestId":"r1"}'
# 重复同 requestId → replayed:true 且 revision 不变；错误 action → 400
```

- [ ] **Step 4: Commit**

```bash
git add app/api/workspaces lib/work-items
git commit -m "feat: HTTP surface for delivery flow actions"
```

---

### Task 4: 导入去重（活动 ∪ 归档 ∪ 回收站）

**Files:**
- Modify: `lib/work-items/service.ts`（`createWorkItem` 锁内去重 + trash 扫描）
- Modify: `app/api/workspaces/[id]/work-items/route.ts`（POST 响应 importOutcome/状态码）
- Test: `lib/work-items/import-dedup.test.mjs`

**Interfaces:**
- Produces:
  - `createWorkItem` 返回类型改为 `Promise<{ detail: WorkItemDetail; importOutcome: "created" | "existing" | "existing_trashed" }>`（**破坏性变更**：本项目内调用方 = POST 路由、extension.ts 的 `workspace_create_work_item`、WorkspaceManager 前端 fetch——全部在本任务同步适配；extension 返回值取 `.detail`）。
  - POST 响应：`created` → 201 `{ ...detail展开字段保持, importOutcome: "created" }`；`existing`/`existing_trashed` → 200 `{ importOutcome, item, content, events, path }`（保留 WorkItemDetail 字段，旧脚本读得到）。
- Consumes: 现有 `withWorkspaceWriteLock`、`parseWorkItem`、trash 路径约定 `.pi/trash/work-items/<key>-<timestamp>/item.yaml`。

- [ ] **Step 1: 写失败测试（真临时工作区）**

```js
// lib/work-items/import-dedup.test.mjs —— jiti 装载 service，mkdtemp 造工作区：
// .pi/workspace.yaml（最小 manifest，capabilities 含 work-items）+ 借 getWorkspace？
// —— getWorkspace 走全局索引，测试不便。改测 service 内新增的纯扫描函数：
// findExistingByExternal(workspacePath, source, sourceId) 覆盖活动/归档/回收站。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const service = await jiti.import("./service.ts");

const itemYaml = (key, external) => [
  "schemaVersion: 1", `id: ${key.toLowerCase()}`, `key: ${key}`, "revision: 1",
  "type: requirement", "title: t", "status: open", "phase: intake", "priority: P2",
  "repositories: []", "tags: []", "conversations: []", "relatedItems: []", "designs: []", "plans: []",
  "archivedAt: null", "createdAt: t", "updatedAt: t",
  ...(external ? [`external:`, `  source: ${external.source}`, `  sourceId: "${external.sourceId}"`, "  lastSyncedAt: t"] : []),
].join("\n");

test("findExistingByExternal scans active, archived and trash", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-dedup-"));
  await mkdir(join(ws, ".pi/work-items/requirements/REQ-0001-a"), { recursive: true });
  await writeFile(join(ws, ".pi/work-items/requirements/REQ-0001-a/item.yaml"), itemYaml("REQ-0001", { source: "chandao", sourceId: "99" }));
  await mkdir(join(ws, ".pi/work-items/requirements/REQ-0002-b"), { recursive: true });
  await writeFile(join(ws, ".pi/work-items/requirements/REQ-0002-b/item.yaml"), itemYaml("REQ-0002", { source: "chandao", sourceId: "100" })
    .replace("archivedAt: null", "archivedAt: \"2026-10-01\""));
  await mkdir(join(ws, ".pi/trash/work-items/REQ-0003-c"), { recursive: true });
  await writeFile(join(ws, ".pi/trash/work-items/REQ-0003-c/item.yaml"), itemYaml("REQ-0003", { source: "chandao", sourceId: "101" }));

  assert.equal((await service.findExistingByExternal(ws, "chandao", "99")).outcome, "existing");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "100")).outcome, "existing");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "101")).outcome, "existing_trashed");
  assert.equal((await service.findExistingByExternal(ws, "chandao", "999")).outcome, undefined);
  await rm(ws, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`service.ts` 新增（锁外可调，但 createWorkItem 在锁内调用它保证并发安全）：

```ts
export type ExternalLookupOutcome =
  | { outcome: "existing"; key: string }
  | { outcome: "existing_trashed"; key: string }
  | { outcome: undefined; key?: undefined };

/** 按 source+sourceId 查找已存在项：活动 ∪ 归档（listWorkItems）∪ 回收站
 *  （spec §8.1 —— 回收站 item.yaml 即来源去重墓碑）。坏文件跳过不阻塞。 */
export async function findExistingByExternal(
  workspacePath: string,
  source: string,
  sourceId: string,
): Promise<ExternalLookupOutcome> {
  const { items, archivedItems } = await listWorkItems(workspacePath);
  for (const item of [...items, ...archivedItems]) {
    if (item.external?.source === source && item.external.sourceId === sourceId) {
      return { outcome: "existing", key: item.key };
    }
  }
  const trashRoot = join(workspacePath, ".pi", "trash", "work-items");
  let entries;
  try {
    entries = await readdir(trashRoot, { withFileTypes: true });
  } catch {
    return { outcome: undefined };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const item = parseWorkItem(parse(await readFile(join(trashRoot, entry.name, "item.yaml"), "utf8")));
      if (item.external?.source === source && item.external.sourceId === sourceId) {
        return { outcome: "existing_trashed", key: item.key };
      }
    } catch {
      // malformed trash entry — skip
    }
  }
  return { outcome: undefined };
}
```

`createWorkItem`：锁内、分配 key 之前：

```ts
  if (external) {
    const found = await findExistingByExternal(workspacePath, external.source, external.sourceId);
    if (found.outcome) {
      const detail = await readWorkItem(workspacePath, found.key);
      return { detail, importOutcome: found.outcome };
    }
  }
```

返回值统一 `{ detail, importOutcome: "created" | ... }`。POST 路由：

```ts
    const result = await createWorkItem(id, input);
    const { importOutcome } = result;
    return NextResponse.json({ ...result.detail, importOutcome }, { status: importOutcome === "created" ? 201 : 200 });
```

`extension.ts` `workspace_create_work_item`：`const { detail } = await createWorkItem(...)`，返回 detail（LLM 无需感知 outcome；可在结果 JSON 附 `importOutcome`）。

前端适配：`components/WorkspaceManager.tsx` 创建流程的 fetch 响应按 detail 解析（响应是 detail 展开 + importOutcome 超集，`existing`/`existing_trashed` 时 toast 提示「已存在，未重复创建」并打开既有项详情，不当作新建成功）。

- [ ] **Step 4: 跑测试 + 全量回归（createWorkItem 调用方全部编译过）**

```bash
node --test lib/work-items/*.test.mjs
node_modules/.bin/tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add lib/work-items app/api/workspaces
git commit -m "feat: import dedup across active, archived and trashed items"
```

---

### Task 5: 回收站恢复

**Files:**
- Create: `app/api/workspaces/[id]/work-items/[key]/restore-from-trash/route.ts`
- Modify: `lib/work-items/service.ts`（`restoreWorkItemFromTrash`）
- Test: `lib/work-items/restore-from-trash.test.mjs`

**Interfaces:**
- Produces: `POST .../restore-from-trash` → `200 { detail }`；目标 key 被占用 → `409`；回收站无此 key → `404`。
- `service.ts` 新增：

```ts
export async function restoreWorkItemFromTrash(workspaceId: string, key: string): Promise<WorkItemDetail>
// 锁内：扫 .pi/trash/work-items/ 找目录名以 key 开缀（多个取最新 mtime）；
// 解析 item.yaml 定 type → 目标 <root>/requirements|bugs/<原目录名>；existsSync 目标 → WorkItemConflictError；
// rename 回；appendEvent work_item.restored { restoredFrom }；commitWorkspaceChanges。
```

- 测试：临时工作区造 trash 目录 + 冲突场景，断言 200/409（Conflict → web.ts 已映射 409）与事件追加。

- [ ] **Step 1: 写失败测试（同 Task 4 手法：mkdtemp + itemYaml 造 trash 条目；调用 restoreWorkItemFromTrash 需要 workspaceId —— 该函数签名改为收 workspacePath？与 trashWorkItem 对齐收 workspaceId + getWorkspace。测试注入：导出内部 `restoreWorkItemFromTrashInRoot(workspacePath, key)` 供测试，路由层包 getWorkspace。）**

- [ ] **Step 2–4: 实现（按上面接口注释）→ 测试 → tsc。** 关键代码：

```ts
export async function restoreWorkItemFromTrashInRoot(workspacePath: string, key: string): Promise<WorkItemDetail> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const trashRoot = join(workspacePath, ".pi", "trash", "work-items");
    const type = workItemTypeFromKey(key); // "requirement" | "bug"，非法 key 抛 Validation
    let entries;
    try {
      entries = await readdir(trashRoot, { withFileTypes: true });
    } catch {
      throw new WorkItemNotFoundError(`No trashed work item: ${key}`);
    }
    const candidates = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(`${key}-`))
      .map((e) => join(trashRoot, e.name));
    if (candidates.length === 0) throw new WorkItemNotFoundError(`No trashed work item: ${key}`);
    // 最新 mtime 的一条 = 最近一次移入
    let newest = candidates[0];
    let newestMtime = -1;
    for (const path of candidates) {
      const mtime = (await stat(path)).mtimeMs;
      if (mtime > newestMtime) { newest = path; newestMtime = mtime; }
    }
    const item = parseWorkItem(parse(await readFile(join(newest, "item.yaml"), "utf8")));
    const destination = join(workItemRoot(workspacePath, type === "requirement" ? "requirements" : "bugs"), basename(newest));
    if (existsSync(destination)) {
      throw new WorkItemConflictError(`Work item key ${key} is already in use`);
    }
    await rename(newest, destination);
    await appendEvent(destination, eventFor("work_item.restored", "user", undefined, { restoredFrom: newest }));
    await commitWorkspaceChanges(workspacePath, `workspace: restore ${key}`);
    return readWorkItem(workspacePath, key);
  });
}
```

路由薄壳（getWorkspace → `restoreWorkItemFromTrashInRoot` → `workItemErrorResponse`）。

- [ ] **Step 5: Commit**

```bash
git add lib/work-items app/api/workspaces
git commit -m "feat: restore trashed work items with key-conflict guard"
```

---

### Task 6: LLM 工具 managed 门控

**Files:**
- Modify: `lib/work-items/extension.ts`
- Test: `lib/work-items/extension-gating.test.mjs`（source 断言）

**Interfaces:** 工具行为变化（spec §7.2）：
- `workspace_list_work_items`：默认**排除** `delivery` 存在的项；新增可选参数 `include_managed: boolean`（true = 只读可见 + 每项附 `managed: true`）。
- `workspace_get_work_item`：响应附 `managed: boolean`。
- `workspace_update_work_item`：对 managed 项传 `phase`/`status` → 报错提示走流程（服务层 Task 2 已拦，工具层直接透传错误即可——补 source 断言确认未绕过 service）。

- [ ] **Step 1: source 断言测试**

```js
// lib/work-items/extension-gating.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("list tool excludes managed items by default with explicit opt-in", async () => {
  const src = await readFile(new URL("./extension.ts", import.meta.url), "utf8");
  assert.match(src, /include_managed/);
  assert.match(src, /delivery/);
});

test("tools do not bypass the service-layer flow gate", async () => {
  const src = await readFile(new URL("./extension.ts", import.meta.url), "utf8");
  assert.match(src, /updateWorkItem\(/);
  assert.doesNotMatch(src, /writeAtomic|appendEvent/, "extension must call the service, not write files");
});
```

- [ ] **Step 2: 实现** —— list 工具的实现函数（extension 内调 `listWorkItems` 后）追加过滤：

```ts
        const includeManaged = args.include_managed === true;
        const visible = includeManaged
          ? all
          : all.filter((item) => item.delivery?.protocolVersion !== 1);
        // 每项序列化附 managed: item.delivery?.protocolVersion === 1
```

get 工具响应对象展开 `managed: detail.item.delivery?.protocolVersion === 1`。

- [ ] **Step 3: 跑测试 + Commit**

```bash
node --test lib/work-items/extension-gating.test.mjs && node_modules/.bin/tsc --noEmit
git add lib/work-items && git commit -m "feat: gate loop-facing work item tools against standard-flow items"
```

---

### Task 7: 共享数据层 hooks/useWorkItems

**Files:**
- Create: `lib/work-items/store.ts`（模块级 registry 纯逻辑，node:test 可测）
- Create: `hooks/useWorkItems.ts`
- Test: `lib/work-items/store.test.mjs`

**Interfaces:**
- Produces（T8–T10 消费）：

```ts
// lib/work-items/store.ts —— 模块级单例缓存（同 workspace 一份，双宿主共享）
export interface WorkItemsSnapshot { items: WorkItemRecord[]; archivedItems: WorkItemRecord[]; invalid: InvalidWorkItem[]; fetchedAt: number }
export function getSnapshot(workspaceId: string): WorkItemsSnapshot | null
export function setSnapshot(workspaceId: string, snapshot: WorkItemsSnapshot): void
export function clearSnapshot(workspaceId: string): void
export function shouldRefetch(snapshot: WorkItemsSnapshot | null, now: number, maxAgeMs = 5_000): boolean  // 纯函数

// hooks/useWorkItems.ts
export interface UseWorkItemsResult {
  snapshot: WorkItemsSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  invalidate(): void;   // mutation 成功后清快照 → 下个渲染周期重取
}
export function useWorkItems(workspaceId: string | null, options?: { pollMs?: number }): UseWorkItemsResult
```

- [ ] **Step 1: 写失败测试（store 纯逻辑）**

```js
// lib/work-items/store.test.mjs —— get/set/clear round-trip + shouldRefetch 的空快照/过期/新鲜三分支
```

- [ ] **Step 2: 实现 store + hook**

hook 行为（spec §6.3）：
- 挂载/切换 workspaceId 时：`shouldRefetch(getSnapshot(id), Date.now())` → fetch `GET /api/workspaces/<id>/work-items` 写快照；否则直接用快照（双宿主第二处秒开）。
- 轮询：`document.visibilityState === "visible"` 时 `setInterval(pollMs ?? 5000)` 增量重取；`visibilitychange` 隐藏即停、可见立即校验一次；`window.focus` 校验一次。同 workspace 多个宿主共用一个 interval（store 内挂 listener 计数——实现为模块级 `ensurePoller(workspaceId)`/`releasePoller(workspaceId)`）。
- mutation 成功（create/update/trash/delivery action/restore）后调用方 `invalidate()` → `clearSnapshot` + `refresh()`。

- [ ] **Step 3: 跑测试 + tsc + Commit**

```bash
node --test lib/work-items/store.test.mjs && node_modules/.bin/tsc --noEmit
git add lib/work-items hooks && git commit -m "feat: shared per-workspace work items store and hook"
```

---

### Task 8: 中央页骨架、深链、列表与看板

**Files:**
- Create: `lib/work-items-page-url.ts` + `lib/work-items-page-url.test.mjs`
- Create: `components/work-items/WorkItemsPage.tsx`、`WorkItemsToolbar.tsx`、`WorkItemsList.tsx`、`WorkItemsBoard.tsx`、`WorkItemRow.tsx`、`work-item-phases.ts`（阶段→看板列投影纯逻辑 + 测试）
- Modify: `components/shell/useAppShellState.ts`（CenterPage 增 kind、URL 前置分支、`openWorkItemsPage`）
- Modify: `components/shell/DesktopShell.tsx`（renderCenterPage 分派；聊天 chrome/右坞隐藏同配置页）
- Test: `lib/work-items-page-url.test.mjs`、`components/work-items/work-item-phases.test.mjs`（放 lib 可测路径或直接 components 下 node:test——repo 已有 components/**/*.test.mjs 约定）

**Interfaces:**
- Produces:

```ts
// lib/work-items-page-url.ts
export function buildWorkItemsPageUrl(workspaceId: string, itemKey?: string): string
// "?workspace=<enc>&page=work-items" (+ "&item=<enc>")
export function parseWorkItemsPageParams(params: URLSearchParams): { workspaceId: string; itemKey?: string } | null
// params.get("page") === "work-items" 时返回；workspace 缺失 → null

// components/work-items/work-item-phases.ts（纯逻辑）
export const BOARD_COLUMNS = ["intake", "design", "ready_for_implementation", "implementation", "verification", "release_ready", "released"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export function boardColumnForPhase(phase: WorkItemPhase): BoardColumn
// intake→intake；analysis/requirement_approval/plan_approval/design→design（旧子阶段投影设计组，UI 显示原始标签）；
// implementation→implementation；verification→verification；release_ready→release_ready；released/complete→released（complete 显示「历史已完成」标记）
export function isHistoricalComplete(phase: WorkItemPhase): boolean  // complete && !delivery → 历史已完成，不推断已发布

// useAppShellState:
//   CenterPage 增 { kind: "work-items"; workspaceId: string }
//   openWorkItemsPage(workspaceId: string, itemKey?: string): void
//   —— setCenterPage + navigateUrl(buildWorkItemsPageUrl(...), replace) + 确保 workspace 上下文（不 focusChat）
```

- [ ] **Step 1: 写失败测试（URL 往返 + 阶段投影）**

```js
// lib/work-items-page-url.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const url = await jiti.import("./work-items-page-url.ts");

test("round-trips workspace and item, ignores view syntax", () => {
  const q = url.buildWorkItemsPageUrl("01WS", "REQ-0001");
  assert.equal(q, "?workspace=01WS&page=work-items&item=REQ-0001");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q.slice(1)));
  assert.deepEqual(parsed, { workspaceId: "01WS", itemKey: "REQ-0001" });
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("workspace=01WS&view=chat")), null);
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("page=work-items")), null);
});

// components/work-items/work-item-phases.test.mjs —— boardColumnForPhase/isHistoricalComplete 全分支
```

- [ ] **Step 2: URL 接线（useAppShellState）**

`applyUrlToTabs` 入口前置（约 818 行函数体首部）：

```ts
    const workItemsPage = parseWorkItemsPageParams(params);
    if (workItemsPage) {
      const workspace = workspaces.find((w) => w.id === workItemsPage.workspaceId && isWorkspaceSelectable(w));
      if (workspace) {
        setCenterPage({ kind: "work-items", workspaceId: workspace.id });
        if (workItemsPage.itemKey) workItemsItemKeyRef.current = workItemsPage.itemKey;
        // 不动 tabs：聊天 tab 状态原样保留，返回即回
        return;
      }
      // 无效 workspace id → 落空 URL（清除 page 参数，走正常 tab 投影）
    }
```

（`workItemsItemKeyRef` 为新增 `useRef<string | null>`，`openWorkItemsPage` 写入后由页面消费并清空。）`openWorkItemsPage`：

```ts
  const openWorkItemsPage = useCallback((workspaceId: string, itemKey?: string) => {
    if (itemKey) workItemsItemKeyRef.current = itemKey;
    setCenterPage({ kind: "work-items", workspaceId });
    navigateUrl(buildWorkItemsPageUrl(workspaceId, itemKey ?? undefined), true);
  }, [navigateUrl]);
```

URL 写侧：现有 navigateUrl 的调用点都写 tabQuery；中央页打开后聊天 tab 不变，无需改其它调用——但**页面内选中项变化**时 `navigateUrl(buildWorkItemsPageUrl(wsId, key), true)` 由页面自己调（replace，不埋历史陷阱）。

- [ ] **Step 3: WorkItemsPage 骨架（列表态）**

`components/work-items/WorkItemsPage.tsx` 结构：

```tsx
interface WorkItemsPageProps {
  workspaceId: string;
  initialItemKey?: string | null;
  onOpenConversation: (sessionId: string) => void;   // 「查看会话」→ locate 打开聊天 tab（关中央页）
  onConsumedInitialItem?: () => void;
}
```

- 页头：工作区名 + 工作区选择器（切换前 `confirm` 未保存草稿；`openWorkItemsPage(otherId)`）+ `[列表 | 看板]` 分段 + 「＋新建」。
- capability 检查：无 `work-items` → 未启用空态（不隐式改 capabilities）。
- `useWorkItems(workspaceId)` 驱动；筛选栏（搜索/类型/阶段/优先级/来源/阻塞·待确认/活动·归档·回收站）写 `localStorage pi-work-items-filters:<wsId>`；视图偏好 `pi-work-items-view:<wsId>`（默认列表）。
- 排序：P0→P3 → updatedAt 倒序 → key 稳定（纯函数 `sortWorkItems(items)`，测试覆盖）。
- 列表行：KEY（+来源徽章，复用 `source-labels`）、标题、类型、阶段（旧 phase 显示原始标签 + 标准项显示流程位置）、优先级、阻塞/待确认标记、更新时间。点击 → 右侧/主区详情（T9 接入，本任务先占位详情区显示「选择工作项」）。
- 看板（`WorkItemsBoard.tsx`）：BOARD_COLUMNS 列；卡片 = 行信息紧凑版；`isHistoricalComplete` 的项进「历史已完成」折叠列；**无拖拽跳阶段**——卡片上的阶段操作走动作按钮（T9）。
- 移动端适配由 T10 统一处理（本任务组件全 responsive class，不写死宽度）。

- [ ] **Step 4: DesktopShell 分派 + chrome 隐藏**

`renderCenterPage` 增分支：

```tsx
  if (centerPage?.kind === "work-items") {
    return (
      <WorkItemsPage
        workspaceId={centerPage.workspaceId}
        initialItemKey={workItemsItemKey}
        onOpenConversation={handleOpenConversation}
      />
    );
  }
```

配置页打开时隐藏 tab 条/右坞的既有条件（`centerPage != null` 一类判断）确认覆盖新 kind（同一 centerPage 变量，天然覆盖——执行者验证隐藏逻辑按 `centerPage` 而非按 kind 枚举）。

- [ ] **Step 5: 跑测试 + tsc + 手测（spec §10 验证 6 部分）**

```bash
node --test lib/work-items-page-url.test.mjs components/work-items/work-item-phases.test.mjs
node_modules/.bin/tsc --noEmit && npm run lint && npm run dev
# 手测：深链直开/刷新/后退/无效 id；筛选与看板投影；旧 complete 显示「历史已完成」
```

- [ ] **Step 6: Commit**

```bash
git add lib components hooks && git commit -m "feat: central work items page with deep links, list and board"
```

---

### Task 9: 工作项详情与流程动作 UI

**Files:**
- Create: `components/work-items/WorkItemDetailView.tsx`（详情主体）、`WorkItemCreateForm.tsx`、`WorkItemActionbar.tsx`、`WorkItemEvents.tsx`
- Move/抽用: 从 `components/WorkspaceManager.tsx` 抽出附件上传、Markdown 渲染、来源展示等既有实现到 `components/work-items/`（WorkspaceManager 引用新位置，自身其余功能不动）
- Modify: `components/work-items/WorkItemsPage.tsx`（接入详情）
- Test: `components/work-items/work-item-detail.test.mjs`（source 断言：动作条只渲染 legalDeliveryActions；创建表单带启用标准流程勾选且缺省不勾）

**Interfaces:**
- Consumes: `legalDeliveryActions`/`applyDeliveryAction`（经 HTTP）、`useWorkItems`、既有 attachments/content/events API、M1 的执行中断记录展示（Loops 相关，见下）。
- Produces: 详情视图含：概况（标题/优先级/标签/仓库范围只读非空展示）、原始描述+附件（快照不覆盖）、验收条件与设计（design.md 查看与编辑，编辑前警示失效规则）、代码与验证（candidates+checks+验证记录）、关联会话（「查看会话」→ `onOpenConversation`；含已归档轮会话）、审计历史（events 时间线，含 delivery.* 事件）、动作条 + 新建/编辑/归档/恢复/移入回收站/从回收站恢复。
- 创建表单：`enableDelivery` 勾选（缺省**不勾**，spec §7.1）。

- [ ] **Step 1: source 断言测试**（见上：`legalDeliveryActions` 渲染门、`enableDelivery` 缺省、回收站恢复按钮存在）。
- [ ] **Step 2: 抽共用件** —— 把 WorkspaceManager 的工作项详情子树（概况/附件/事件时间线/来源行）移到 `components/work-items/`，WorkspaceManager（右栏快捷面板 + 设置页）改为 import 新组件；行为不变（`npm run dev` 手测右栏面板回归）。
- [ ] **Step 3: 详情主体** —— 动作条按 `legalDeliveryActions(item)` 渲染按钮；每个动作弹最小表单（confirm-design 需展示 digest 摘要与验收条件清单；submit-verification 需 candidates 编辑；record-verification 需 checks 表格 outcome 三态；record-release 需 version 必填；rework 需 reason + target 单选 implementation|design；block/cancel 需 reason）；提交 = `POST .../delivery/<action>` body `{ expectedRevision: item.revision, requestId: crypto.randomUUID(), payload }` → 成功 `invalidate()` + 详情刷新；409 → 提示重取。
- [ ] **Step 4: 执行中断跳转（补 M1 留口，spec §5.4）** —— 详情的关联区当 `GET .../loops` 的 `interruptions` 含 `item.loop` 匹配（或轮会话即本项关联会话）时显示「执行中断，待恢复 → 去处理」链接，跳 Loops 面板对应行（`openRailModule(LOOPS_TAB_ID)`）。
- [ ] **Step 5: 手测（spec §10 验证 5、8）** —— 中央页与右栏在创建/编辑/归档/恢复/导入后显示一致；确认与验证绑定版本（改需求后确认失效回设计）；旧 complete 不显示已发布。
- [ ] **Step 6: Commit**

```bash
git add components && git commit -m "feat: work item detail view with delivery action UI"
```

---

### Task 10: 右栏快捷面板、总览入口与移动端页

**Files:**
- Modify: `components/WorkspaceManager.tsx`（panel 模式顶部「打开完整管理」入口）
- Modify: `components/WorkspaceOverview.tsx`（工作项入口 → `openWorkItemsPage`）
- Modify: `components/shell/DesktopShell.tsx`（传 `openWorkItemsPage`；总览 hub 与 rail 的接线）
- Modify: `components/shell/MobileShell.tsx`（work-items 目的地页改宿 `WorkItemsPage` 移动布局）
- Modify: `components/shell/useAppShellState.ts`（`openWorkItemsPage` 暴露进 context）
- Test: source 断言 `lib/work-items-entry.test.mjs`

**Interfaces:**
- Produces: 快捷面板顶部「打开完整管理」→ `openWorkItemsPage(wsId)`（rail 图标单击行为不变——模块切换；入口是面板内按钮，两个动作不冲突，spec §6.1）；移动端 work-items 页 = `WorkItemsPage` 的全屏列表→详情导航（`mobilePage === "work-items"` 时渲染，‹返回回聊天），看板以阶段筛选列表呈现。

- [ ] **Step 1: source 断言**（WorkspaceManager panel 模式含「打开完整管理」且调用 openWorkItemsPage；MobileShell work-items case 渲染 WorkItemsPage）。
- [ ] **Step 2: 实现接线** —— `useAppShellState` 把 `openWorkItemsPage` 加入返回值与 `AppShellContext`；DesktopShell/WorkspaceOverview 传用；MobileShell 替换目的地页宿主（保留 capability 门控）。中央页「查看/开始会话」（spec §6.1）：`onOpenConversation` 关闭中央页 → `openSessionTab(会话)` → 同时 `openDockModule(会话所属工作区, WORK_ITEMS)` 定位右侧快捷面板到该工作项所在工作区，允许用户从右栏回到详情。
- [ ] **Step 3: 手测（spec §10 验证 6 移动端部分）** —— 移动端全屏列表→详情、触摸不丢草稿、窄屏看板为筛选列表、工作区切换不串数据。
- [ ] **Step 4: Commit**

```bash
git add components && git commit -m "feat: wire work items full-page entries across dock, overview and mobile"
```

---

### Task 11: AGENTS.md 基线与回归验证

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: AGENTS.md 更新** —— 工作项章补：delivery 元数据块与七阶段、动作 API、导入去重（活动∪归档∪回收站）与 importOutcome、回收站恢复、LLM 工具 managed 门控、`hooks/useWorkItems` 共享缓存、中央页与深链语法、组件新位置 `components/work-items/`。只记已实现内容。
- [ ] **Step 2: spec §10 里程碑二验证清单逐项勾验** —— 项 5–8、10：
  - 5：中央页与侧栏一致、切工作区不串、回收站恢复保 key 与来源去重、冲突 409。
  - 6：筛选/详情返回/移动端/未保存草稿/深链刷新与前进后退。
  - 7：并发导入同 source/sourceId 只建一项；重复同步不改内容、不复活。
  - 8：确认/验证绑定版本；缺依据不能推进；旧 complete ≠ 已发布。
  - 10：动作重放（同 requestId）不产生重复阶段/事件；内容/设计变更的失效回退。
- [ ] **Step 3: 全量回归 + 提交**

```bash
npm test && node_modules/.bin/tsc --noEmit && npm run lint
git add AGENTS.md && git commit -m "docs: update AGENTS.md baseline for work items management"
```

---

## 自审记录（写计划时已核对）

- Spec 覆盖：§6.1→T8（入口/作用域/深链/chrome）；§6.2→T8/T9（列表看板详情/归档回收站/移动端）；§6.3→T7/T9/T10（抽组件、共享缓存、5s 轮询）；§7.1→T1（兼容状态/显式启用/透传块）；§7.2→T1/T2/T6（阶段表/看板投影/工具门禁）；§7.3→T2（版本绑定/返工/回退/冻结）；§8.1→T4/T5（去重/回收站墓碑/importOutcome）；§8.2→T2（锁内事务、跨进程文件锁双层化、operationId=requestId 幂等、产物先落盘后改状态）；§9→T3（动作路由/错误区分）；§10→各任务手测步骤 + T11 汇总。
- 类型一致：`DeliveryAction`/`DeliveryMetadata`/`contentDigest`/`candidatesDigest`（T1）→ T2/T3/T6 消费；`applyDeliveryAction`/`planDeliveryTransition`/`legalDeliveryActions`（T2）→ T3/T9；`findExistingByExternal`/`importOutcome`（T4）→ 路由与前端；`useWorkItems`/`WorkItemsSnapshot`（T7）→ T8/T9/T10；`buildWorkItemsPageUrl`/`parseWorkItemsPageParams`（T8）→ shell 双侧。
- 已知简化（执行者按此实现，不算占位符）：`planDeliveryTransition` 的 digest 参数由 apply 计算注入；`prepare-release` 只更新 `delivery.releasePlan` 不改阶段；`restoreWorkItemFromTrashInRoot` 以 workspacePath 为测试缝。
