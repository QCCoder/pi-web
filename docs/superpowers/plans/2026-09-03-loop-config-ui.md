# Loop 配置面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 pi-web 工作区获得 loop 配置 UI：创建/删除 loop、frontmatter 编辑、人写文件（知识文档 / LOOP.md 指针正文 / 根级宪法）编辑器，STATE.md 只读。

**Architecture:** Overview Loops 区块保留仪表盘职责并常驻；配置详情由 shell 直接挂载在右栏 config 区（`PreferencesPage` 先例，不走 portal）；全部服务端逻辑收在 `lib/loops/manage.ts`（import pi-loop 纯逻辑，镜像 `lib/loops/rounds.ts`），路由薄壳；唯一 PUT 写入口 + 文件名白名单 + tmp+rename 原子写 + mtime 乐观并发。移动端复用工作台 tab 的 overview 本地栈。

**Tech Stack:** Next.js App Router（既有路由模式）、React client components（inline styles + CSS vars）、node:test（`lib/**/*.test.mjs` + `pi-loop/**/*.test.mjs` glob，`.mjs` 直 import `.ts`）。

**Spec:** `docs/superpowers/specs/2026-09-03-loop-config-ui-design.md`（计划从 spec 立论，执行者两份都读）

## Global Constraints

- TypeScript 严格模式；每个 task 结束 `node_modules/.bin/tsc --noEmit` 必须 0 错误。
- 测试命令：全量 `npm test`；单文件 `node --test lib/loops/manage.test.mjs`。测试是 `.mjs` 直 import `.ts` 源文件（依赖 node 的 type stripping），所以 **lib 内 import 必须用相对路径 + 显式 `.ts` 扩展名**（如 `../../pi-loop/init.ts`）；`@/` 别名只允许出现在 `app/` 与 `components/`。
- **绝不运行 `next build`**（污染 `.next/`，破坏 `npm run dev`）。
- 不新增 npm 依赖；不引入 Monaco/CodeMirror（textarea 即编辑器）。
- Lint：`npm run lint`（最终 task 跑一次全量）。
- 提交信息用 `feat:`/`test:`/`docs:` 前缀（仓库惯例）；每个 task 至少一次 commit。
- 写面安全不变式（spec §5.3）：客户端只传 loop 名/文件名/内容，路径一律服务端拼接；知识文档名白名单 `^[A-Za-z0-9][A-Za-z0-9._-]*\.md$` 且拒绝 `LOOP.md`/`STATE.md`；写后 resolve 复核仍在 loop 目录内；STATE.md 无任何写路径；`.lastrun`/`.round.lock`/`PAUSED` 不读写（暂停恢复走既有 PAUSED 路由）。
- daemon 零改动（无新 daemon 路由）。

---

### Task 1: `pi-loop/frontmatter.ts` 导出 `splitLoopFile`

**Files:**
- Modify: `pi-loop/frontmatter.ts`（文件末尾追加导出；**不改** `applyLoopFrontmatterPatch` 现有实现）
- Test: `pi-loop/frontmatter.test.mjs`（若已存在则追加用例；不存在则创建）

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `splitLoopFile(raw: string): { front: string; body: string } | null`——`front` 含 `---` 定界线（原样字节），`body` 为其后全部；无 frontmatter 块返回 `null`。Task 2 的 manage.ts 依赖它读写 LOOP.md 正文。

- [ ] **Step 1: 写失败测试**

创建/追加 `pi-loop/frontmatter.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { splitLoopFile } from "./frontmatter.ts";

test("splitLoopFile 拆出 frontmatter 与正文（字节保真）", () => {
  const raw = '---\nname: dev-loop\ncron: "*/30 * * * *"\n---\n# 指针\n\n1. 步骤\n';
  const parts = splitLoopFile(raw);
  assert.ok(parts);
  assert.equal(parts.front, '---\nname: dev-loop\ncron: "*/30 * * * *"\n---\n');
  assert.equal(parts.body, "# 指针\n\n1. 步骤\n");
  assert.equal(parts.front + parts.body, raw);
});

test("splitLoopFile 无 frontmatter 返回 null", () => {
  assert.equal(splitLoopFile("# 只有正文\n"), null);
});

test("splitLoopFile 空 frontmatter 块", () => {
  const parts = splitLoopFile("---\n---\nbody");
  assert.ok(parts);
  assert.equal(parts.front, "---\n---\n");
  assert.equal(parts.body, "body");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test pi-loop/frontmatter.test.mjs`
Expected: FAIL（`splitLoopFile` 未导出 / not a function）

- [ ] **Step 3: 最小实现**

在 `pi-loop/frontmatter.ts` 末尾追加：

```ts
/** 拆分 LOOP.md 原始字节：front = 含 --- 定界线的 frontmatter 块（原样字节），
 *  body = 其后全部。无 frontmatter 块 → null。供 lib/loops/manage.ts 读正文，
 *  以及写正文时用 raw.slice(0, raw.length - body.length) + newBody 保前缀字节
 *  （与 applyLoopFrontmatterPatch 的"正文 byte 保留"互为反向）。 */
export function splitLoopFile(raw: string): { front: string; body: string } | null {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return null;
  return { front: match[0], body: raw.slice(match[0].length) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test pi-loop/frontmatter.test.mjs`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add pi-loop/frontmatter.ts pi-loop/frontmatter.test.mjs
git commit -m "feat: pi-loop splitLoopFile 导出（frontmatter 字节保真拆分）"
```

---

### Task 2: `lib/loops/manage.ts` —— 配置面全部服务端逻辑（TDD）

**Files:**
- Create: `lib/loops/manage.ts`
- Test: `lib/loops/manage.test.mjs`

**Interfaces:**
- Consumes: `findKitLoopByName(workspacePath: string, name: string): LoopDeclaration | undefined`（`./lookup.ts`）；`listWorkItems(workspacePath: string): Promise<{ items: WorkItemRecord[]; archivedItems: WorkItemRecord[]; invalid: InvalidWorkItem[] }>`（`../work-items/service.ts`）；`initLoop(root, { name, cron, pattern?, level?, maxMinutes?, timezone? })`（`../../pi-loop/init.ts`）；`isValidCronExpression(expression: string): boolean`（`../../pi-loop/cron.ts`，**已存在**）；`isValidTimezone` / `splitLoopFile`（`../../pi-loop/frontmatter.ts`）；`readRoundLock(dir)` / `isRoundLockStale(lock, maxStaleMs)` / `acquireRoundLock(dir, holder)` / `releaseRoundLock(dir)`（`../../pi-loop/round-lock.ts`，`RoundLockHolder = { pid, host, kind: "beat"|"daemon", sessionId? }`）。
- Produces（Task 3/4 依赖，签名精确）:

```ts
export class LoopManageError extends Error {
  constructor(message: string, status: number, details?: Record<string, unknown>);
  readonly status: number;
  readonly details: Record<string, unknown>;
}
export type WriteTarget =
  | { kind: "doc"; file: string }
  | { kind: "body" }
  | { kind: "constitution"; file: "constraints" | "budget" };
export interface DocEntry { name: string; content: string; mtimeMs: number; }
export interface ConstitutionEntry { content: string; mtimeMs: number; }
export interface LoopDocsBundle {
  frontmatter: { cron: string; timezone: string; level: string; maxMinutes: number; pattern: string };
  running: boolean; paused: boolean;
  docs: DocEntry[];
  loopBody: string; loopBodyMtimeMs: number; stateMd: string;
  constitution: { constraints?: ConstitutionEntry; budget?: ConstitutionEntry };
  constitutionTemplates: { constraints: string; budget: string };
  boundItems: string[];
}
export function isValidDocFilename(file: string): boolean;
export async function getLoopDocs(workspacePath: string, name: string): Promise<LoopDocsBundle>; // 404 unknown
export async function writeLoopFile(workspacePath: string, name: string, target: WriteTarget, content: string, baseMtimeMs?: number): Promise<{ mtimeMs: number }>; // 404/400/409
export interface CreateLoopInput { name: string; cron: string; timezone?: string; level?: "L1"|"L2"|"L3"; maxMinutes?: number; pattern?: string; }
export async function createLoop(workspacePath: string, input: CreateLoopInput): Promise<{ name: string }>; // 400/409
export async function deleteLoop(workspacePath: string, name: string, opts?: { confirmBound?: boolean }): Promise<{ deleted: true }>; // 404/409
export async function listBoundItems(workspacePath: string, name: string): Promise<string[]>;
```

- [ ] **Step 1: 写测试夹具 + 第一组失败测试（白名单 / getLoopDocs）**

创建 `lib/loops/manage.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { acquireRoundLock, releaseRoundLock } from "../../pi-loop/round-lock.ts";
import {
  LoopManageError, isValidDocFilename, getLoopDocs, writeLoopFile,
  createLoop, deleteLoop,
} from "./manage.ts";

const LOOP_MD = [
  "---",
  'name: dev-loop',
  'pattern: dev-loop',
  'cron: "*/30 9-22 * * 1-5"',
  'timezone: "Asia/Shanghai"',
  "level: L2",
  "max_minutes: 45",
  "---",
  "# 本轮合同指针",
  "",
  "1. 读宪法",
  "2. 执行 /skill:dev-loop",
  "",
].join("\n");

const ITEM_YAML = [
  "schema_version: 1",
  "id: 0123456789abcdef01234567",
  "key: REQ-0001",
  "revision: 1",
  "type: requirement",
  "title: 绑定测试项",
  "status: in_progress",
  "phase: analysis",
  "priority: P2",
  "repositories: []",
  "tags: []",
  "conversations: []",
  "related_items: []",
  "designs: []",
  "plans: []",
  "loop: dev-loop",
  "created_at: 2026-09-03T00:00:00.000Z",
  "updated_at: 2026-09-03T00:00:00.000Z",
].join("\n");

function makeWorkspace(t, { withItem = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-loop-manage-"));
  const dir = join(root, "loops", "dev-loop");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), LOOP_MD);
  writeFileSync(join(dir, "STATE.md"), "# STATE\n\nLast run: -\n");
  writeFileSync(join(dir, "loop-ledger.json"), "{}");
  writeFileSync(join(dir, "chandao.md"), "# 来源说明\n");
  if (withItem) {
    const itemDir = join(root, "requirements", "REQ-0001-loop-manage-test");
    mkdirSync(itemDir, { recursive: true });
    writeFileSync(join(itemDir, "item.yaml"), ITEM_YAML);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const assertThrows = async (status, fn) => {
  await assert.rejects(fn, (error) => error instanceof LoopManageError && error.status === status);
};

test("isValidDocFilename 白名单", () => {
  assert.equal(isValidDocFilename("chandao.md"), true);
  assert.equal(isValidDocFilename("selection-rules.v2.md"), true);
  assert.equal(isValidDocFilename("LOOP.md"), false); // 保留名
  assert.equal(isValidDocFilename("STATE.md"), false); // 保留名
  assert.equal(isValidDocFilename(".hidden.md"), false); // 隐藏
  assert.equal(isValidDocFilename("a/b.md"), false); // 路径分隔符
  assert.equal(isValidDocFilename("../escape.md"), false);
  assert.equal(isValidDocFilename("notes.txt"), false); // 非 .md
  assert.equal(isValidDocFilename(""), false);
});

test("getLoopDocs 返回配置面板数据包", async (t) => {
  const root = makeWorkspace(t);
  const bundle = await getLoopDocs(root, "dev-loop");
  assert.equal(bundle.docs.length, 1);
  assert.equal(bundle.docs[0].name, "chandao.md");
  assert.equal(bundle.docs[0].content, "# 来源说明\n");
  assert.ok(bundle.docs[0].mtimeMs > 0);
  assert.equal(bundle.loopBody.startsWith("# 本轮合同指针"), true);
  assert.equal(bundle.stateMd, "# STATE\n\nLast run: -\n");
  assert.equal(bundle.frontmatter.level, "L2");
  assert.equal(bundle.frontmatter.maxMinutes, 45);
  assert.equal(bundle.frontmatter.pattern, "dev-loop");
  assert.equal(bundle.running, false);
  assert.equal(bundle.paused, false);
  assert.equal(bundle.constitution.constraints, undefined); // 根宪法缺失
  assert.equal(bundle.constitution.budget, undefined);
  assert.ok(bundle.constitutionTemplates.constraints.length > 0); // 模板始终带上
  assert.ok(bundle.constitutionTemplates.budget.length > 0);
  assert.deepEqual(bundle.boundItems, ["REQ-0001"]);
});

test("getLoopDocs 未知 loop 404", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(404, () => getLoopDocs(root, "nope"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test lib/loops/manage.test.mjs`
Expected: FAIL（`Cannot find module './manage.ts'`）

- [ ] **Step 3: 实现 manage.ts 骨架 + 第一组功能**

创建 `lib/loops/manage.ts`：

```ts
/** loop 配置面服务端逻辑（spec docs/superpowers/specs/2026-09-03-loop-config-ui-design.md §5）：
 *  校验/路径解析/读写/守卫全部集中于此，路由保持薄壳。写面按域收窄——唯一 PUT
 *  入口 + 文件名白名单 + 服务端拼路径；不触 /api/files 的只读 allow-list。
 *  并发语义（spec §5.4）：知识/正文/宪法在轮开场被读取，编辑不加锁、下一轮生效；
 *  STATE.md 无写路径；删除在锁活时拒绝。 */
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findKitLoopByName } from "./lookup.ts";
import { listWorkItems } from "../work-items/service.ts";
import { initLoop } from "../../pi-loop/init.ts";
import { isValidCronExpression } from "../../pi-loop/cron.ts";
import { isValidTimezone, splitLoopFile } from "../../pi-loop/frontmatter.ts";
import { isRoundLockStale, readRoundLock } from "../../pi-loop/round-lock.ts";
import type { LoopDeclaration } from "../../pi-loop/protocol.ts";

export class LoopManageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type WriteTarget =
  | { kind: "doc"; file: string }
  | { kind: "body" }
  | { kind: "constitution"; file: "constraints" | "budget" };

export interface DocEntry { name: string; content: string; mtimeMs: number; }
export interface ConstitutionEntry { content: string; mtimeMs: number; }
export interface LoopDocsBundle {
  frontmatter: { cron: string; timezone: string; level: string; maxMinutes: number; pattern: string };
  running: boolean;
  paused: boolean;
  docs: DocEntry[];
  loopBody: string;
  loopBodyMtimeMs: number;
  stateMd: string;
  constitution: { constraints?: ConstitutionEntry; budget?: ConstitutionEntry };
  constitutionTemplates: { constraints: string; budget: string };
  boundItems: string[];
}

const DOC_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const RESERVED_DOC_NAMES = new Set(["LOOP.md", "STATE.md"]);
const LOOP_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONSTITUTION_FILES = { constraints: "loop-constraints.md", budget: "loop-budget.md" } as const;
const TEMPLATES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "kit", "templates", "basic", "root",
);

export function isValidDocFilename(file: string): boolean {
  return DOC_FILENAME_RE.test(file) && !RESERVED_DOC_NAMES.has(file);
}

function requireDeclaration(workspacePath: string, name: string): LoopDeclaration {
  const declaration = findKitLoopByName(workspacePath, name);
  if (!declaration) throw new LoopManageError(`Unknown loop: ${name}`, 404);
  return declaration;
}

function isRunning(declaration: LoopDeclaration): boolean {
  const lock = readRoundLock(declaration.dir);
  return !!lock && !isRoundLockStale(lock, declaration.maxMinutes * 60_000 + 15 * 60_000);
}

async function readIfExists(path: string): Promise<ConstitutionEntry | undefined> {
  try {
    const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { content, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

async function atomicWrite(path: string, content: string): Promise<number> {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return (await stat(path)).mtimeMs;
}

export async function listBoundItems(workspacePath: string, name: string): Promise<string[]> {
  const { items, archivedItems } = await listWorkItems(workspacePath);
  return [...items, ...archivedItems].filter((item) => item.loop === name).map((item) => item.key);
}

export async function getLoopDocs(workspacePath: string, name: string): Promise<LoopDocsBundle> {
  const declaration = requireDeclaration(workspacePath, name);
  const entries = await readdir(declaration.dir, { withFileTypes: true }).catch(() => []);
  const docs: DocEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isValidDocFilename(entry.name)) continue;
    const file = await readIfExists(join(declaration.dir, entry.name));
    if (file) docs.push({ name: entry.name, content: file.content, mtimeMs: file.mtimeMs });
  }
  docs.sort((a, b) => a.name.localeCompare(b.name));
  const loopFile = await readIfExists(join(declaration.dir, "LOOP.md"));
  if (!loopFile) throw new LoopManageError(`LOOP.md 不可读：${name}`, 500);
  const stateFile = await readIfExists(join(declaration.dir, "STATE.md"));
  return {
    frontmatter: {
      cron: declaration.cron,
      timezone: declaration.timezone,
      level: declaration.level,
      maxMinutes: declaration.maxMinutes,
      pattern: declaration.pattern,
    },
    running: isRunning(declaration),
    paused: declaration.paused ?? false,
    docs,
    loopBody: splitLoopFile(loopFile.content)?.body ?? loopFile.content,
    loopBodyMtimeMs: loopFile.mtimeMs,
    stateMd: stateFile?.content ?? "",
    constitution: {
      constraints: await readIfExists(join(workspacePath, CONSTITUTION_FILES.constraints)),
      budget: await readIfExists(join(workspacePath, CONSTITUTION_FILES.budget)),
    },
    constitutionTemplates: {
      constraints: await readFile(join(TEMPLATES_ROOT, CONSTITUTION_FILES.constraints), "utf8"),
      budget: await readFile(join(TEMPLATES_ROOT, CONSTITUTION_FILES.budget), "utf8"),
    },
    boundItems: await listBoundItems(workspacePath, name),
  };
}
```

- [ ] **Step 4: 跑第一组测试确认通过**

Run: `node --test lib/loops/manage.test.mjs`
Expected: PASS（3 用例）

- [ ] **Step 5: 追加第二组失败测试（writeLoopFile 三种 target + mtime 冲突）**

在 `lib/loops/manage.test.mjs` 末尾追加：

```js
test("writeLoopFile: 新建知识文档并读回", async (t) => {
  const root = makeWorkspace(t);
  const result = await writeLoopFile(root, "dev-loop", { kind: "doc", file: "guide.md" }, "# 指南\n");
  assert.ok(result.mtimeMs > 0);
  const bundle = await getLoopDocs(root, "dev-loop");
  assert.equal(bundle.docs.find((d) => d.name === "guide.md")?.content, "# 指南\n");
});

test("writeLoopFile: 保留名/路径分隔符/非 md → 400", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "LOOP.md" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "a/b.md" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: ".x.md" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "notes.txt" }, "x"));
});

test("writeLoopFile: mtime 冲突 → 409 带当前内容；省略 baseMtime = 覆盖", async (t) => {
  const root = makeWorkspace(t);
  const path = join(root, "loops", "dev-loop", "chandao.md");
  const first = await writeLoopFile(root, "dev-loop", { kind: "doc", file: "chandao.md" }, "# v1\n");
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // 外部编辑：mtime 必变
  await assert.rejects(
    () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "chandao.md" }, "# v2\n", first.mtimeMs),
    (error) => error instanceof LoopManageError && error.status === 409 && error.details.currentContent === "# v1\n",
  );
  await writeLoopFile(root, "dev-loop", { kind: "doc", file: "chandao.md" }, "# v3\n"); // 强制覆盖
  assert.equal(readFileSync(path, "utf8"), "# v3\n");
});

test("writeLoopFile: body 保存后 frontmatter 字节不变", async (t) => {
  const root = makeWorkspace(t);
  const path = join(root, "loops", "dev-loop", "LOOP.md");
  const before = readFileSync(path, "utf8");
  await writeLoopFile(root, "dev-loop", { kind: "body" }, "# 新指针\n\n1. 新步骤\n");
  const after = readFileSync(path, "utf8");
  const split = (raw) => raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)[0];
  assert.equal(split(after), split(before));
  assert.equal(after.slice(split(before).length), "# 新指针\n\n1. 新步骤\n");
});

test("writeLoopFile: constitution 写根级文件（缺失即创建）", async (t) => {
  const root = makeWorkspace(t);
  await writeLoopFile(root, "dev-loop", { kind: "constitution", file: "budget" }, "# 预算\n");
  const bundle = await getLoopDocs(root, "dev-loop");
  assert.equal(bundle.constitution.budget?.content, "# 预算\n");
});

test("writeLoopFile: 未知 loop 404", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(404, () => writeLoopFile(root, "nope", { kind: "body" }, "x"));
});
```

- [ ] **Step 6: 跑测试确认新用例失败**

Run: `node --test lib/loops/manage.test.mjs`
Expected: 新 6 用例 FAIL（`writeLoopFile` 未定义），旧 3 用例仍 PASS

- [ ] **Step 7: 实现 writeLoopFile**

在 `manage.ts` 末尾追加：

```ts
export async function writeLoopFile(
  workspacePath: string,
  name: string,
  target: WriteTarget,
  content: string,
  baseMtimeMs?: number,
): Promise<{ mtimeMs: number }> {
  const declaration = requireDeclaration(workspacePath, name);
  if (target.kind === "doc") {
    if (!isValidDocFilename(target.file)) {
      throw new LoopManageError(
        `非法文档名（仅 loop 目录人写 .md，禁路径分隔符/隐藏文件/LOOP.md/STATE.md）：${target.file}`,
        400,
      );
    }
    const path = resolve(declaration.dir, target.file); // 纵深防御：拼路径后复核仍在 loop 目录内
    if (!path.startsWith(declaration.dir + sep)) throw new LoopManageError("路径越界", 400);
    const existing = await readIfExists(path);
    if (baseMtimeMs !== undefined && existing && existing.mtimeMs !== baseMtimeMs) {
      throw new LoopManageError("文档已被其它编辑修改", 409, {
        currentContent: existing.content,
        currentMtimeMs: existing.mtimeMs,
      });
    }
    return { mtimeMs: await atomicWrite(path, content) };
  }
  if (target.kind === "body") {
    const path = join(declaration.dir, "LOOP.md");
    const raw = await readFile(path, "utf8");
    const parts = splitLoopFile(raw);
    if (!parts) throw new LoopManageError("LOOP.md 缺少 frontmatter 块", 400);
    const info = await stat(path);
    if (baseMtimeMs !== undefined && info.mtimeMs !== baseMtimeMs) {
      throw new LoopManageError("LOOP.md 已被其它编辑修改", 409, {
        currentContent: parts.body,
        currentMtimeMs: info.mtimeMs,
      });
    }
    const next = raw.slice(0, raw.length - parts.body.length) + content; // frontmatter 前缀字节保真
    return { mtimeMs: await atomicWrite(path, next) };
  }
  const fileName = CONSTITUTION_FILES[target.file];
  const path = join(workspacePath, fileName);
  const existing = await readIfExists(path);
  if (baseMtimeMs !== undefined && existing && existing.mtimeMs !== baseMtimeMs) {
    throw new LoopManageError(`${fileName} 已被其它编辑修改`, 409, {
      currentContent: existing.content,
      currentMtimeMs: existing.mtimeMs,
    });
  }
  return { mtimeMs: await atomicWrite(path, content) }; // 缺失即创建（含「从模板创建」预填后的保存）
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test lib/loops/manage.test.mjs`
Expected: PASS（9 用例）

- [ ] **Step 9: 追加第三组失败测试（createLoop / deleteLoop）**

在 `lib/loops/manage.test.mjs` 末尾追加：

```js
test("createLoop: 脚手架 + 参数校验", async (t) => {
  const root = makeWorkspace(t, { withItem: false });
  await createLoop(root, { name: "ops-loop", cron: "*/5 * * * *", timezone: "Asia/Shanghai" });
  assert.ok(existsSync(join(root, "loops", "ops-loop", "LOOP.md")));
  assert.ok(existsSync(join(root, "loops", "ops-loop", ".lastrun"))); // initLoop 写 .lastrun=now
  assert.ok(existsSync(join(root, "loop-constraints.md"))); // 根宪法缺失时由 init 复制模板
  assert.ok(existsSync(join(root, ".agents", "skills", "ops-loop", "SKILL.md"))); // SKILL 骨架
  await assertThrows(409, () => createLoop(root, { name: "ops-loop", cron: "*/5 * * * *" })); // 重名
  await assertThrows(400, () => createLoop(root, { name: "My Loop", cron: "*/5 * * * *" })); // 非 slug
  await assertThrows(400, () => createLoop(root, { name: "ok-name", cron: "not-a-cron" })); // 非法 cron
  await assertThrows(400, () => createLoop(root, { name: "ok-name", cron: "*/5 * * * *", timezone: "Mars/Olympus" }));
});

test("deleteLoop: 锁活 409 / 绑定项 409+确认放行 / SKILL 与宪法不删", async (t) => {
  const root = makeWorkspace(t);
  const dir = join(root, "loops", "dev-loop");
  // 锁活：daemon 持有 + 本进程 pid（活）
  assert.equal(acquireRoundLock(dir, { pid: process.pid, host: hostname(), kind: "daemon", sessionId: "s-test" }), true);
  await assert.rejects(
    () => deleteLoop(root, "dev-loop"),
    (error) => error instanceof LoopManageError && error.status === 409 && error.details.running === true,
  );
  releaseRoundLock(dir);
  // 绑定项：REQ-0001 绑给 dev-loop（fixture）
  await assert.rejects(
    () => deleteLoop(root, "dev-loop"),
    (error) => error instanceof LoopManageError && error.status === 409
      && JSON.stringify(error.details.boundItems) === JSON.stringify(["REQ-0001"]),
  );
  await deleteLoop(root, "dev-loop", { confirmBound: true });
  assert.equal(existsSync(dir), false); // 整目录删除
  assert.ok(existsSync(join(root, "requirements"))); // 工作项不动
});

test("deleteLoop: 未知 loop 404", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(404, () => deleteLoop(root, "nope"));
});
```

- [ ] **Step 10: 跑测试确认新用例失败**

Run: `node --test lib/loops/manage.test.mjs`
Expected: 新 3 用例 FAIL（`createLoop`/`deleteLoop` 未定义）

- [ ] **Step 11: 实现 createLoop / deleteLoop**

在 `manage.ts` 末尾追加：

```ts
export interface CreateLoopInput {
  name: string;
  cron: string;
  timezone?: string;
  level?: "L1" | "L2" | "L3";
  maxMinutes?: number;
  pattern?: string;
}

export async function createLoop(workspacePath: string, input: CreateLoopInput): Promise<{ name: string }> {
  if (typeof input.name !== "string" || !LOOP_NAME_RE.test(input.name)) {
    throw new LoopManageError("name 必须是小写字母/数字/连字符的 slug（如 dev-loop）", 400);
  }
  if (typeof input.cron !== "string" || !isValidCronExpression(input.cron)) {
    throw new LoopManageError("cron 必须是合法的 5 字段 Vixie cron 表达式", 400);
  }
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new LoopManageError(`timezone 不合法：${input.timezone}`, 400);
  }
  if (input.level !== undefined && !["L1", "L2", "L3"].includes(input.level)) {
    throw new LoopManageError("level 只能是 L1/L2/L3", 400);
  }
  if (input.maxMinutes !== undefined && (!Number.isInteger(input.maxMinutes) || input.maxMinutes < 1)) {
    throw new LoopManageError("maxMinutes 必须是 ≥1 的整数", 400);
  }
  if (input.pattern !== undefined && !LOOP_NAME_RE.test(input.pattern)) {
    throw new LoopManageError("pattern 必须是小写字母/数字/连字符的 slug", 400);
  }
  if (existsSync(join(workspacePath, "loops", input.name))) {
    throw new LoopManageError(`loop 已存在：${input.name}`, 409);
  }
  initLoop(workspacePath, {
    name: input.name,
    cron: input.cron,
    pattern: input.pattern,
    level: input.level,
    maxMinutes: input.maxMinutes,
    timezone: input.timezone,
  });
  return { name: input.name };
}

export async function deleteLoop(
  workspacePath: string,
  name: string,
  opts: { confirmBound?: boolean } = {},
): Promise<{ deleted: true }> {
  const declaration = requireDeclaration(workspacePath, name);
  if (isRunning(declaration)) {
    throw new LoopManageError("轮正在跑——先停止本轮再删除", 409, { running: true });
  }
  const boundItems = await listBoundItems(workspacePath, name);
  if (boundItems.length > 0 && !opts.confirmBound) {
    throw new LoopManageError("有工作项绑定到该 loop，需二次确认", 409, { boundItems });
  }
  // 整目录删除（git 历史即审计）；SKILL.md 与根级宪法不删（宪法可能被其它 loop 共享）。
  await rm(declaration.dir, { recursive: true, force: true });
  return { deleted: true };
}
```

- [ ] **Step 12: 全量跑 + typecheck**

Run: `node --test lib/loops/manage.test.mjs && node_modules/.bin/tsc --noEmit`
Expected: 12 用例 PASS；tsc 0 错误

- [ ] **Step 13: Commit**

```bash
git add lib/loops/manage.ts lib/loops/manage.test.mjs
git commit -m "feat: lib/loops/manage.ts loop 配置面服务端逻辑（docs 读写/创建/删除守卫）"
```

---

### Task 3: API 路由（薄壳）

**Files:**
- Modify: `app/api/workspaces/[id]/loops/route.ts`（现有 GET 上加 POST）
- Modify: `app/api/workspaces/[id]/loops/[name]/route.ts`（现有 PATCH 上加 DELETE）
- Create: `app/api/workspaces/[id]/loops/[name]/docs/route.ts`（GET + PUT）

**Interfaces:**
- Consumes: Task 2 的 `createLoop` / `deleteLoop` / `getLoopDocs` / `writeLoopFile` / `LoopManageError`；`getWorkspace(id)` → `{ path, manifest }`；既有 PATCH 行为不变。
- Produces（Task 4 依赖的 HTTP 契约）:
  - `POST /api/workspaces/:id/loops` body `{name,cron,timezone?,level?,maxMinutes?,pattern?}` → 201 `{name}`；400/409 `{error}`
  - `GET /api/workspaces/:id/loops/:name/docs` → 200 `LoopDocsBundle`；404 `{error}`
  - `PUT /api/workspaces/:id/loops/:name/docs` body `{target,content,baseMtimeMs?}` → 200 `{mtimeMs}`；400/404/409（409 附 `currentContent`/`currentMtimeMs` 或 `running`/`boundItems`）
  - `DELETE /api/workspaces/:id/loops/:name` body 可选 `{confirmBound}` → 200 `{deleted:true}`；404/409（409 附 `running:true` 或 `boundItems:string[]`）

- [ ] **Step 1: loops/route.ts 加 POST**

在 `app/api/workspaces/[id]/loops/route.ts`：导入区追加

```ts
import { createLoop, LoopManageError } from "@/lib/loops/manage";
```

`errorResponse` 改为（`LoopManageError` 分支带 details 展开）：

```ts
function errorResponse(error: unknown): NextResponse {
  if (error instanceof LoopManageError) {
    return NextResponse.json(
      { error: error.message, ...error.details },
      { status: error.status },
    );
  }
  const status = error instanceof WorkspaceNotFoundError
    ? 404
    : error instanceof WorkspaceConflictError
      ? 409
      : error instanceof WorkspaceValidationError
        ? 400
        : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}
```

文件末尾追加：

```ts
/** 创建 loop（spec §5.1）：向导表单 → 校验 → pi-loop initLoop 脚手架
 *  （五件套 + SKILL 骨架 + .lastrun=now，首轮等自然槽）。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { path } = await getWorkspace(id);
    const input = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const created = await createLoop(path, input);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 2: [name]/route.ts 加 DELETE**

在 `app/api/workspaces/[id]/loops/[name]/route.ts`：导入区追加

```ts
import { deleteLoop, LoopManageError } from "@/lib/loops/manage";
```

其 `errorResponse` 同 Step 1 的改法（加 `LoopManageError` 分支）。文件末尾追加：

```ts
/** 删除 loop（spec §5.3）：锁活 409；有绑定工作项需 {confirmBound:true} 二次确认；
 *  整目录删除（git 历史即审计），SKILL 与根宪法不动。 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const body = (await req.json().catch(() => ({}))) as { confirmBound?: boolean };
    return NextResponse.json(await deleteLoop(path, name, { confirmBound: body.confirmBound }));
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 3: 新建 [name]/docs/route.ts**

创建 `app/api/workspaces/[id]/loops/[name]/docs/route.ts`：

```ts
import { NextResponse } from "next/server";
import { getWorkspace, WorkspaceNotFoundError } from "@/lib/workspaces/service";
import { getLoopDocs, writeLoopFile, LoopManageError, type WriteTarget } from "@/lib/loops/manage";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof LoopManageError) {
    return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
  }
  const status = error instanceof WorkspaceNotFoundError ? 404 : 500;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** 配置面板数据包（spec §5.1）：知识文档列表+内容 / LOOP.md 正文 / STATE.md（只读）/
 *  宪法两文件（存在性+内容+模板）/ 绑定工作项 / running+paused。 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    return NextResponse.json(await getLoopDocs(path, name));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 唯一写入口（spec §5.1/§5.2）：target 判别联合 doc|body|constitution；
 *  文件名白名单与路径越界校验在 manage.ts；baseMtime 乐观并发（409 附当前内容）。 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    const { path } = await getWorkspace(id);
    const body = (await req.json().catch(() => ({}))) as {
      target?: WriteTarget;
      content?: string;
      baseMtimeMs?: number;
    };
    if (!body.target || typeof body.content !== "string") {
      return NextResponse.json({ error: "body 需要 {target, content}" }, { status: 400 });
    }
    return NextResponse.json(
      await writeLoopFile(path, name, body.target, body.content, body.baseMtimeMs),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 4: typecheck + 既有测试全绿**

Run: `node_modules/.bin/tsc --noEmit && npm test`
Expected: tsc 0 错误；全部测试 PASS（路由无单测——薄壳，逻辑全在 manage.ts，仓库惯例 app/ 无测试）

- [ ] **Step 5: Commit**

```bash
git add "app/api/workspaces/[id]/loops/route.ts" "app/api/workspaces/[id]/loops/[name]/route.ts" "app/api/workspaces/[id]/loops/[name]/docs/route.ts"
git commit -m "feat: loop 配置面 API（POST 创建 / GET+PUT docs / DELETE 删除守卫）"
```

---

### Task 4: `components/LoopsConfig.tsx`（配置视图组件）

**Files:**
- Create: `components/LoopsConfig.tsx`

**Interfaces:**
- Consumes: Task 2 类型 `LoopDocsBundle` / `WriteTarget`（`import type`，类型导入会被擦除——client 组件 import 带 node:fs 的模块文件是安全的）；`WorkspaceSummary`（含 `path`）；`summarizeCron`（`@/lib/loops/cron-summary`）；`MarkdownBody`（props：`children` markdown 字符串 + 可选 `cwd`）；Task 3 的 HTTP 契约。
- Produces（Task 5/6 依赖）:

```ts
export type LoopConfigTarget = { kind: "loop"; name: string } | { kind: "new" };
// <LoopsConfig workspace target onClose onOpenLoop onChanged? />
```

无单测（仓库 UI 无组件测试）；验证 = tsc + Task 6 后手测。

- [ ] **Step 1: 写组件**

创建 `components/LoopsConfig.tsx`（完整内容）：

```tsx
"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { summarizeCron } from "@/lib/loops/cron-summary";
import { MarkdownBody } from "./MarkdownBody";
import type { LoopDocsBundle, WriteTarget } from "@/lib/loops/manage";

/** 右栏（桌面）/ overview 栈页（移动）共用的 loop 配置目标。
 *  useAppShellState 持有，生命周期镜像 workItemDetail。 */
export type LoopConfigTarget = { kind: "loop"; name: string } | { kind: "new" };

interface Props {
  workspace: WorkspaceSummary;
  target: LoopConfigTarget;
  /** 删除成功 / ×：由 shell 清 loopConfig / 弹栈。 */
  onClose: () => void;
  /** 创建成功后打开新 loop 的配置视图。 */
  onOpenLoop: (name: string) => void;
  /** create/delete/frontmatter 保存后触发——桌面借此 bump loopsRefreshKey。 */
  onChanged?: () => void;
}

const sectionTitle: CSSProperties = { fontSize: 13, fontWeight: 600, margin: "16px 0 6px" };
const box: CSSProperties = { display: "grid", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 };
const input: CSSProperties = { width: "100%", padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12 };
const textarea: CSSProperties = { ...input, minHeight: 180, resize: "vertical", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" };
const linkButton: CSSProperties = { fontSize: 12, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer" };
const primaryButton: CSSProperties = { ...linkButton, fontWeight: 600, justifySelf: "start" };
const dangerButton: CSSProperties = { fontSize: 12, color: "#b91c1c", background: "none", border: "1px solid #b91c1c", borderRadius: 6, padding: "4px 10px", cursor: "pointer", justifySelf: "start" };
const errorText: CSSProperties = { color: "#b91c1c", fontSize: 12 };
const muted: CSSProperties = { color: "var(--text-muted)", fontSize: 12 };
const chip: CSSProperties = { fontSize: 12, padding: "2px 10px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer" };
const chipActive: CSSProperties = { ...chip, borderColor: "var(--accent)", color: "var(--accent)" };
const summaryStyle: CSSProperties = { cursor: "pointer", color: "var(--text-muted)", fontSize: 12 };

const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const CON_LABEL: Record<"constraints" | "budget", string> = {
  constraints: "loop-constraints.md（绑定约束）",
  budget: "loop-budget.md（token/轮数预算总帽）",
};

interface PutResult { ok: boolean; error?: string }

export function LoopsConfig(props: Props) {
  if (props.target.kind === "new") return <LoopCreateForm {...props} />;
  return (
    <LoopConfigDetail
      workspace={props.workspace}
      name={props.target.name}
      onClose={props.onClose}
      onChanged={props.onChanged}
    />
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      {label}
      {children}
    </label>
  );
}

/** 统一 PUT（唯一写入口）。409 冲突 → confirm 后无 baseMtime 强制覆盖（spec §6）。 */
function usePut(api: (suffix: string) => string) {
  return useCallback(
    async (loopName: string, target: WriteTarget, content: string, baseMtimeMs?: number): Promise<PutResult> => {
      const send = async (mtime?: number) =>
        fetch(api(`/${encodeURIComponent(loopName)}/docs`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, content, baseMtimeMs: mtime }),
        });
      const first = await send(baseMtimeMs);
      if (first.ok) return { ok: true };
      const body = (await first.json().catch(() => ({}))) as { error?: string };
      if (first.status === 409) {
        if (window.confirm(`${body.error ?? "文件已被其它编辑修改"}\n\n用当前编辑覆盖？`)) {
          const second = await send(undefined);
          if (second.ok) return { ok: true };
          const b2 = (await second.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: b2.error ?? `保存失败（HTTP ${second.status}）` };
        }
        return { ok: false, error: body.error ?? "已取消——磁盘上有新版本" };
      }
      return { ok: false, error: body.error ?? `保存失败（HTTP ${first.status}）` };
    },
    [api],
  );
}

function LoopCreateForm({ workspace, onOpenLoop, onChanged }: Props) {
  const [form, setForm] = useState({ name: "", cron: "*/30 9-22 * * 1-5", timezone: "", level: "L1", maxMinutes: 30, pattern: "" });
  const [showPattern, setShowPattern] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          cron: form.cron.trim(),
          timezone: form.timezone.trim() || undefined,
          level: form.level,
          maxMinutes: Number(form.maxMinutes) || undefined,
          pattern: form.pattern.trim() || undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { name?: string; error?: string };
      if (!response.ok || !body.name) {
        setError(body.error ?? `创建失败（HTTP ${response.status}）`);
        return;
      }
      onChanged?.();
      onOpenLoop(body.name);
    } finally {
      setBusy(false);
    }
  }, [form, onChanged, onOpenLoop, workspace.id]);

  return (
    <div style={{ padding: "14px 16px", fontSize: 12 }}>
      <div style={box}>
        <strong style={{ fontSize: 13 }}>新建 Loop</strong>
        <Field label="名称（slug，如 dev-loop）">
          <input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={<>cron（5 字段 Vixie）—— {summarizeCron(form.cron) ?? "（未识别形态，按原文保存）"}</>}>
          <input style={{ ...input, fontFamily: "var(--font-mono)" }} value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
        </Field>
        <Field label="时区（缺省 = 系统本地）">
          <input style={input} placeholder="Asia/Shanghai" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </Field>
        <Field label="level —— 新 loop 一律 L1（report-only）起步；L2/L3 由人手动晋级">
          <select style={input} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
        </Field>
        <Field label="max_minutes（单轮超时）">
          <input style={input} type="number" min={1} value={form.maxMinutes} onChange={(e) => setForm({ ...form, maxMinutes: Number(e.target.value) })} />
        </Field>
        <button style={linkButton} onClick={() => setShowPattern(!showPattern)}>
          {showPattern ? "▾" : "▸"} pattern（高级，缺省 = 名称）
        </button>
        {showPattern && (
          <Field label="pattern（对应 .agents/skills/<pattern>/ 的 SKILL）">
            <input style={input} value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
          </Field>
        )}
        {error && <div style={errorText}>{error}</div>}
        <button disabled={busy || !form.name.trim() || !form.cron.trim()} style={primaryButton} onClick={() => void submit()}>
          创建（脚手架五件套 + SKILL 骨架 + .lastrun=now，首轮等自然槽）
        </button>
        <div style={muted}>创建后请在配置视图改写 LOOP.md 指针正文与知识文档；SKILL.md 骨架在 .agents/skills/&lt;pattern&gt;/，按本 loop 职责手改。</div>
      </div>
    </div>
  );
}

function LoopConfigDetail({
  workspace,
  name,
  onClose,
  onChanged,
}: {
  workspace: WorkspaceSummary;
  name: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const api = useCallback(
    (suffix: string) => `/api/workspaces/${encodeURIComponent(workspace.id)}/loops${suffix}`,
    [workspace.id],
  );
  const put = usePut(api);

  const [bundle, setBundle] = useState<LoopDocsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fm, setFm] = useState({ cron: "", timezone: "", level: "L1", maxMinutes: 30 });
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docDraft, setDocDraft] = useState<string | null>(null);
  const [docPreview, setDocPreview] = useState(false);
  const [newDocName, setNewDocName] = useState("");
  const [conDraft, setConDraft] = useState<{ constraints: string | null; budget: string | null }>({ constraints: null, budget: null });
  const [delError, setDelError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(api(`/${encodeURIComponent(name)}/docs`));
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setLoadError(body.error ?? `加载失败（HTTP ${response.status}）`);
        return;
      }
      const data = (await response.json()) as LoopDocsBundle;
      setBundle(data);
      setFm({
        cron: data.frontmatter.cron,
        timezone: data.frontmatter.timezone,
        level: data.frontmatter.level,
        maxMinutes: data.frontmatter.maxMinutes,
      });
      setBodyDraft(null);
      setDocDraft(null);
      setNewDocName("");
      setConDraft({ constraints: null, budget: null });
      setSelectedDoc((current) => (current && data.docs.some((d) => d.name === current) ? current : null));
    } catch (cause) {
      setLoadError(String(cause));
    }
  }, [api, name]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveFrontmatter = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(api(`/${encodeURIComponent(name)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: fm.cron, timezone: fm.timezone, level: fm.level, max_minutes: Number(fm.maxMinutes) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `保存失败（HTTP ${response.status}）`);
        return;
      }
      await refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }, [api, fm, name, onChanged, refresh]);

  const saveBody = useCallback(async () => {
    if (!bundle || bodyDraft === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "body" }, bodyDraft, bundle.loopBodyMtimeMs);
      if (!result.ok) { setError(result.error ?? "保存失败"); return; }
      await refresh();
    } finally { setBusy(false); }
  }, [bundle, bodyDraft, name, put, refresh]);

  const selectedDocEntry = bundle?.docs.find((d) => d.name === selectedDoc) ?? null;

  const saveDoc = useCallback(async () => {
    if (!selectedDocEntry || docDraft === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "doc", file: selectedDocEntry.name }, docDraft, selectedDocEntry.mtimeMs);
      if (!result.ok) { setError(result.error ?? "保存失败"); return; }
      await refresh();
    } finally { setBusy(false); }
  }, [docDraft, name, put, refresh, selectedDocEntry]);

  const createDoc = useCallback(async () => {
    if (!DOC_NAME_RE.test(newDocName) || newDocName === "LOOP.md" || newDocName === "STATE.md") return;
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "doc", file: newDocName }, `# ${newDocName.replace(/\.md$/, "")}\n\n`);
      if (!result.ok) { setError(result.error ?? "创建失败"); return; }
      setSelectedDoc(newDocName);
      setDocPreview(false);
      await refresh();
    } finally { setBusy(false); }
  }, [name, newDocName, put, refresh]);

  const saveConstitution = useCallback(async (which: "constraints" | "budget") => {
    if (!bundle) return;
    const draft = conDraft[which];
    const existing = bundle.constitution[which];
    const value = draft ?? existing?.content ?? bundle.constitutionTemplates[which];
    setBusy(true);
    setError(null);
    try {
      const result = await put(name, { kind: "constitution", file: which }, value, existing?.mtimeMs);
      if (!result.ok) { setError(result.error ?? "保存失败"); return; }
      await refresh();
    } finally { setBusy(false); }
  }, [bundle, conDraft, name, put, refresh]);

  const doDelete = useCallback(async () => {
    if (!bundle) return;
    setDelError(null);
    if (bundle.running) {
      setDelError("轮正在跑——请先在总览 Loops 区块「停止」，再删除。");
      return;
    }
    const boundNote = bundle.boundItems.length > 0
      ? `\n\n${bundle.boundItems.length} 个工作项绑定到该 loop（${bundle.boundItems.join("、")}）——删除后绑定按未绑定处理。`
      : "";
    if (!window.confirm(`删除 loop "${name}"（整个 loops/${name}/ 目录）？git 历史保留审计。${boundNote}`)) return;
    setBusy(true);
    try {
      let response = await fetch(api(`/${encodeURIComponent(name)}`), { method: "DELETE" });
      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; running?: boolean; boundItems?: string[] };
        if (body.running) { setDelError(body.error ?? "轮正在跑"); return; }
        if (body.boundItems?.length
          && window.confirm(`${body.error}\n\n${body.boundItems.join("、")} 删除后按未绑定处理，仍要删除？`)) {
          response = await fetch(api(`/${encodeURIComponent(name)}`), {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmBound: true }),
          });
        } else {
          setDelError("已取消");
          return;
        }
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setDelError(body.error ?? `删除失败（HTTP ${response.status}）`);
        return;
      }
      onChanged?.();
      onClose();
    } finally { setBusy(false); }
  }, [api, bundle, name, onChanged, onClose]);

  if (loadError) return <div style={{ ...errorText, padding: 16 }}>{loadError}</div>;
  if (!bundle) return <div style={{ ...muted, padding: 16 }}>加载中…</div>;

  return (
    <div style={{ padding: "0 16px 24px", fontSize: 12, display: "grid", gap: 2 }}>
      {/* 头部状态 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 0" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13 }}>{name}</span>
        <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--bg-hover)" }}>{bundle.frontmatter.level}</span>
        <span style={{ color: bundle.running ? "#15803d" : bundle.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
          {bundle.running ? "● 运行中" : bundle.paused ? "已暂停" : "空闲"}
        </span>
        <span style={muted}>pattern: {bundle.frontmatter.pattern}</span>
      </div>

      {/* 1. frontmatter（沿用既有 PATCH 路由） */}
      <h3 style={sectionTitle}>frontmatter</h3>
      <div style={box}>
        <Field label={<>cron —— {summarizeCron(fm.cron) ?? fm.cron}</>}>
          <input style={{ ...input, fontFamily: "var(--font-mono)" }} value={fm.cron} onChange={(e) => setFm({ ...fm, cron: e.target.value })} />
        </Field>
        <Field label="timezone">
          <input style={input} value={fm.timezone} onChange={(e) => setFm({ ...fm, timezone: e.target.value })} />
        </Field>
        <Field label="level（L2/L3 晋级是人的手）">
          <select style={input} value={fm.level} onChange={(e) => setFm({ ...fm, level: e.target.value })}>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
        </Field>
        <Field label="max_minutes">
          <input style={input} type="number" min={1} value={fm.maxMinutes} onChange={(e) => setFm({ ...fm, maxMinutes: Number(e.target.value) })} />
        </Field>
        <button disabled={busy} style={primaryButton} onClick={() => void saveFrontmatter()}>保存 frontmatter</button>
      </div>

      {/* 2. 合同指针正文 */}
      <h3 style={sectionTitle}>合同指针正文（LOOP.md body）</h3>
      <details>
        <summary style={summaryStyle}>编辑指针步骤（frontmatter 字节保留；每轮开场读取）</summary>
        <div style={{ ...box, marginTop: 6 }}>
          <textarea style={textarea} value={bodyDraft ?? bundle.loopBody} onChange={(e) => setBodyDraft(e.target.value)} />
          <button disabled={busy || bodyDraft === null || bodyDraft === bundle.loopBody} style={primaryButton} onClick={() => void saveBody()}>
            保存正文
          </button>
        </div>
      </details>

      {/* 3. 知识文档（不硬编码文件名） */}
      <h3 style={sectionTitle}>知识文档（人写 · agent 只读 · 任意命名）</h3>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {bundle.docs.map((doc) => (
          <button
            key={doc.name}
            style={selectedDoc === doc.name ? chipActive : chip}
            onClick={() => { setSelectedDoc(doc.name); setDocDraft(null); setDocPreview(false); }}
          >
            {doc.name}
          </button>
        ))}
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input style={{ ...input, width: 140 }} placeholder="新文档名.md" value={newDocName} onChange={(e) => setNewDocName(e.target.value)} />
          <button disabled={busy || !DOC_NAME_RE.test(newDocName) || newDocName === "LOOP.md" || newDocName === "STATE.md"} style={linkButton} onClick={() => void createDoc()}>
            ＋新建
          </button>
        </span>
      </div>
      {selectedDocEntry && (
        <div style={{ ...box, marginTop: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <strong>{selectedDocEntry.name}</strong>
            <button style={linkButton} onClick={() => setDocPreview(!docPreview)}>{docPreview ? "编辑" : "预览"}</button>
          </div>
          {docPreview ? (
            <MarkdownBody cwd={`${workspace.path}/loops/${name}`}>{docDraft ?? selectedDocEntry.content}</MarkdownBody>
          ) : (
            <textarea style={textarea} value={docDraft ?? selectedDocEntry.content} onChange={(e) => setDocDraft(e.target.value)} />
          )}
          <button disabled={busy || docDraft === null || docDraft === selectedDocEntry.content} style={primaryButton} onClick={() => void saveDoc()}>
            保存
          </button>
        </div>
      )}

      {/* 4. STATE.md 只读 */}
      <h3 style={sectionTitle}>STATE.md（只读 · loop 运行状态）</h3>
      <details>
        <summary style={summaryStyle}>展开查看</summary>
        <pre style={{ ...box, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", margin: "6px 0 0" }}>{bundle.stateMd || "（空）"}</pre>
      </details>

      {/* 5. 宪法文件（根共享） */}
      <h3 style={sectionTitle}>宪法文件（根共享 · 所有 loop 生效 · agent 禁改）</h3>
      {(["constraints", "budget"] as const).map((which) => {
        const existing = bundle.constitution[which];
        const draft = conDraft[which];
        const value = draft ?? existing?.content ?? bundle.constitutionTemplates[which];
        return (
          <details key={which} style={{ marginBottom: 4 }}>
            <summary style={summaryStyle}>
              {CON_LABEL[which]}{existing ? "" : "（缺失——已预填模板，保存即创建）"}
            </summary>
            <div style={{ ...box, marginTop: 6 }}>
              <textarea style={textarea} value={value} onChange={(e) => setConDraft({ ...conDraft, [which]: e.target.value })} />
              <button disabled={busy || draft === null || draft === value} style={primaryButton} onClick={() => void saveConstitution(which)}>
                保存
              </button>
            </div>
          </details>
        );
      })}

      {/* 6. 危险区 */}
      <h3 style={{ ...sectionTitle, color: "#b91c1c" }}>危险区</h3>
      <div style={{ ...box, borderColor: "#b91c1c55" }}>
        <div>
          删除 loop（整个 loops/{name}/ 目录；SKILL 与宪法不动；git 历史保留审计）
          {bundle.boundItems.length > 0 && (
            <div style={muted}>绑定工作项：{bundle.boundItems.join("、")}（删除后按未绑定处理）</div>
          )}
        </div>
        {delError && <div style={errorText}>{delError}</div>}
        <button disabled={busy || bundle.running} style={dangerButton} onClick={() => void doDelete()}>删除 loop</button>
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 错误（此时组件尚未被引用——孤立文件必须独立编译通过）

- [ ] **Step 3: Commit**

```bash
git add components/LoopsConfig.tsx
git commit -m "feat: LoopsConfig 组件（创建向导 + frontmatter/指针正文/知识文档/宪法编辑 + 删除）"
```

---

### Task 5: `useAppShellState` 挂 `loopConfig` 状态

**Files:**
- Modify: `components/shell/useAppShellState.ts`

**Interfaces:**
- Consumes: `LoopConfigTarget`（`import type { LoopConfigTarget } from "@/components/LoopsConfig"`——类型导入，无运行时环）。
- Produces: 返回对象新增 `loopConfig: LoopConfigTarget | null` 与 `setLoopConfig`（经 `AppShellState = ReturnType<typeof useAppShellState>` 自动流经 `useShell()`，context.tsx 无需改动）。

- [ ] **Step 1: 加状态与清空**

在 `workItemDetail` 声明（约 L127）后追加：

```ts
// Loop 配置视图（spec §4.1）：镜像 workItemDetail 的生命周期——
// panel 切换 / 会话选择 / 工作区切换 / configView 打开时一并清空。
const [loopConfig, setLoopConfig] = useState<LoopConfigTarget | null>(null);
```

导入区加 `import type { LoopConfigTarget } from "@/components/LoopsConfig";`。

然后 `grep -n "setWorkItemDetail(null)" components/shell/useAppShellState.ts`——对**每一处**命中行，紧邻追加一行 `setLoopConfig(null);`（约 11 处：L130/137/145/170/652/695/707/723/912/991/1042 附近；这些是 panel 切换、会话选择、新建会话、工作区切换、configView 打开等清空点位，与 workItemDetail 完全同集合）。

返回对象（约 L1311 `workItemDetail,` 处）追加：

```ts
    loopConfig,
    setLoopConfig,
```

- [ ] **Step 2: typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: 0 错误（状态尚未被 shell 消费）

- [ ] **Step 3: Commit**

```bash
git add components/shell/useAppShellState.ts
git commit -m "feat: useAppShellState 挂 loopConfig（镜像 workItemDetail 生命周期）"
```

---

### Task 6: 接线 —— WorkspaceOverview 常驻化 + DesktopShell 右栏 + MobileShell 栈

**Files:**
- Modify: `components/WorkspaceOverview.tsx`
- Modify: `components/shell/DesktopShell.tsx`
- Modify: `components/shell/MobileShell.tsx`

**Interfaces:**
- Consumes: Task 4 `LoopsConfig` / `LoopConfigTarget`；Task 5 `loopConfig`/`setLoopConfig`（DesktopShell 从 `useShell()` 解构）。
- Produces: `WorkspaceOverview` 新 props `onOpenLoopConfig: (target: LoopConfigTarget) => void`（必填，两 shell 同 task 传齐）与 `loopsRefreshKey?: number`。

- [ ] **Step 1: WorkspaceOverview —— Props + 常驻区块 + 移除内联表单**

`components/WorkspaceOverview.tsx`：

1. 导入区加 `import type { LoopConfigTarget } from "./LoopsConfig";`
2. `interface Props` 末尾（`onSessionDeleted?` 后）追加：

```ts
  /** 打开 loop 配置（桌面右栏 / 移动端 overview 栈）；新建走 { kind: "new" }。 */
  onOpenLoopConfig: (target: LoopConfigTarget) => void;
  /** loop 变更刷新信号（创建/删除/frontmatter 保存后由 shell bump）。 */
  loopsRefreshKey?: number;
```

3. 函数签名解构加 `onOpenLoopConfig, loopsRefreshKey,`。
4. **删除**三段 state 与一段逻辑：`editingLoop`/`loopForm`/`loopError` 三个 useState（约 L121-123）、`saveLoopEdit` 整个 useCallback（约 L154-183）。
5. 刷新 effect 改为：

```ts
useEffect(() => { void refreshLoops(); }, [refreshLoops, loopsRefreshKey]);
```

6. **整块替换** Loops 渲染区块（从 `{/* Loops 管理（spec §5.3…` 注释起到该 `<section>` 闭合止，含 `{editingLoop && (…)}` 内联表单）为：

```tsx
        {/* Loops 管理（仪表盘职责：状态/暂停恢复/停止；配置与新建走 onOpenLoopConfig；
            常驻渲染——无 loop 也有「新建」入口，spec §4.2） */}
        <section style={sectionStyle}>
          <h2 style={{ ...sectionHeaderStyle, margin: "0 0 10px" }}>Loops</h2>
          {loops.length === 0 ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--text-muted)", fontSize: 12 }}>
              <span>暂无 loop（文件即声明：loops/&lt;name&gt;/LOOP.md）</span>
              <button onClick={() => onOpenLoopConfig({ kind: "new" })} style={sectionHeaderLinkStyle}>＋ 新建 Loop</button>
            </div>
          ) : (
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
                    {loop.running
                      ? "● 运行中"
                      : loop.paused
                        ? "已暂停"
                        : loop.nextDue
                          ? (new Date(loop.nextDue).getTime() > Date.now()
                              ? `下次 ${formatLoopClock(loop.nextDue)}`
                              : "已到期 · 待心跳")
                          : "空闲"}
                  </span>
                  <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                    <button disabled={loopsBusy} onClick={() => onOpenLoopConfig({ kind: "loop", name: loop.name })} style={sectionHeaderLinkStyle}>
                      配置
                    </button>
                    <button
                      disabled={loopsBusy}
                      onClick={() => void loopAction(loop.name, loop.paused ? "resume" : "pause")}
                      style={sectionHeaderLinkStyle}
                    >
                      {loop.paused ? "恢复" : "暂停"}
                    </button>
                    {loop.running && (
                      <button disabled={loopsBusy} onClick={() => void loopAction(loop.name, "stop")} style={sectionHeaderLinkStyle}>
                        停止
                      </button>
                    )}
                  </span>
                </div>
              ))}
              <div>
                <button onClick={() => onOpenLoopConfig({ kind: "new" })} style={sectionHeaderLinkStyle}>＋ 新建 Loop</button>
              </div>
            </div>
          )}
        </section>
```

- [ ] **Step 2: DesktopShell —— 右栏分支 + prop**

`components/shell/DesktopShell.tsx`：

1. 导入区加 `import { LoopsConfig } from "../LoopsConfig";`；`useShell()` 解构（约 L47-55 区域）加 `loopConfig, setLoopConfig,`。
2. 组件内（`setModelsRefreshKey` 附近）加 `const [loopsRefreshKey, setLoopsRefreshKey] = useState(0);`（`useState` 已在用，如未导入则补）。
3. 右栏条件（约 L364）改为：

```tsx
{(configView || workItemDetail || loopConfig || (sidebarView === "settings" && settingsPage !== "index")) ? (
```

4. 在 `workItemDetail ? (…)` 分支与 `sidebarView === "settings" && settingsPage === "workspace" ?` 分支之间插入：

```tsx
          ) : loopConfig ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <PanelHeader
                title={loopConfig.kind === "new" ? "新建 Loop" : loopConfig.name}
                meta="Loop 配置"
                onClose={() => setLoopConfig(null)}
              />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                {activeWorkspace && (
                  <LoopsConfig
                    workspace={activeWorkspace}
                    target={loopConfig}
                    onClose={() => setLoopConfig(null)}
                    onOpenLoop={(name) => setLoopConfig({ kind: "loop", name })}
                    onChanged={() => setLoopsRefreshKey((key) => key + 1)}
                  />
                )}
              </div>
            </div>
```

5. 主区域 `<WorkspaceOverview …>`（约 L422）追加两个 prop：

```tsx
            onOpenLoopConfig={(target) => setLoopConfig(target)}
            loopsRefreshKey={loopsRefreshKey}
```

- [ ] **Step 3: MobileShell —— overview 栈泛化**

`components/shell/MobileShell.tsx`：

1. 导入区加 `import { LoopsConfig, type LoopConfigTarget } from "../LoopsConfig";`
2. 把 `const [overviewOpen, setOverviewOpen] = useState(false);`（约 L204）替换为：

```ts
type OverviewPage = { page: "overview" } | { page: "loop-config"; target: LoopConfigTarget };
const [overviewStack, setOverviewStack] = useState<OverviewPage | null>(null);
```

3. `grep -n "setOverviewOpen\|overviewOpen" components/shell/MobileShell.tsx`，按下表机械替换全部命中：

| 旧 | 新 |
|---|---|
| `setOverviewOpen(false)`（tab 离开/workspace 切换 effect） | `setOverviewStack(null)` |
| `setOverviewOpen(true)`（工作台 PanelHeader「总览」按钮） | `setOverviewStack({ page: "overview" })` |
| `if (overviewOpen && activeWorkspace)`（renderTabContent workbench 分支） | `if (overviewStack && activeWorkspace)` |
| `<PanelHeader … onBack={() => setOverviewOpen(false)}`（总览页头） | `onBack={() => setOverviewStack(null)}` |

4. renderTabContent 的 workbench 分支里，`{overviewStack && activeWorkspace}` 成立时先判页：

```tsx
        if (overviewStack && activeWorkspace) {
          if (overviewStack.page === "loop-config") {
            return (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
                <PanelHeader
                  title={overviewStack.target.kind === "new" ? "新建 Loop" : overviewStack.target.name}
                  meta="Loop 配置"
                  onBack={() => setOverviewStack({ page: "overview" })}
                  backLabel="总览"
                />
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                  <LoopsConfig
                    workspace={activeWorkspace}
                    target={overviewStack.target}
                    onClose={() => setOverviewStack({ page: "overview" })}
                    onOpenLoop={(name) => setOverviewStack({ page: "loop-config", target: { kind: "loop", name } })}
                  />
                </div>
              </div>
            );
          }
          return (
            /* 原总览 JSX 整体保留，仅追加一个 prop： */
            <WorkspaceOverview
              /* …既有 props 不动… */
              onOpenLoopConfig={(target) => setOverviewStack({ page: "loop-config", target })}
            />
          );
        }
```

（`onOpenLoopConfig` 推栈页，Overview 内部配置/新建按钮即达；返回总览 = `onBack`。）

- [ ] **Step 4: typecheck + 全量测试**

Run: `node_modules/.bin/tsc --noEmit && npm test`
Expected: 0 错误；全部 PASS

- [ ] **Step 5: 手测（`npm run dev`）**

1. 桌面：任意工作区总览 → Loops 区块常驻（无 loop 显示空态）→「＋ 新建 Loop」→ 右栏出现向导 → 创建 `demo-loop` → 右栏自动切到该 loop 配置 → 总览区块出现该 loop。
2. 配置视图：改 cron 保存（区块摘要变化）→ 折叠编辑指针正文保存 → 新建 `notes.md` 写内容保存 → 预览 toggle → STATE.md 只读展开 → 宪法「缺失——已预填模板」保存创建 → 危险区删除 `demo-loop`（二次确认）→ 右栏关闭、区块回空态。
3. 切面板/选会话/切工作区 → 右栏 loopConfig 关闭（镜像 workItemDetail）。
4. 移动端（DevTools ≤640px）：工作台 → 总览 → Loops「配置」→ 栈页推入 → ‹返回 回总览。
5. workspace-c：打开 dev-loop 配置 → 知识文档 chip 列出 chandao.md/selection.md → 编辑保存 → 轮不受影响（STATE.md 只读）。

- [ ] **Step 6: Commit**

```bash
git add components/WorkspaceOverview.tsx components/shell/DesktopShell.tsx components/shell/MobileShell.tsx
git commit -m "feat: loop 配置面接线（Overview 常驻 + 桌面右栏 + 移动栈页）"
```

---

### Task 7: AGENTS.md 更新 + 最终验证

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 AGENTS.md**

1. **Loop 章**（「工作项绑定 + 管理面」小节之后/Overview Loops 区块描述处）追加一段：

```markdown
- **Loop 配置面（2026-09）**：`components/LoopsConfig.tsx` —— 每个工作区的 loop 管理/创作 UI。
  Overview Loops 区块**常驻**（无 loop 显示空态 + 新建入口），仪表盘职责（状态/暂停恢复/停止）不变；
  「配置」/「新建」打开右栏 config 区的 LoopsConfig（shell 直接挂载，`loopConfig` 状态镜像
  `workItemDetail` 生命周期；移动端推工作台 tab 的 overview 栈）。能力：创建向导（`pi-loop init`
  脚手架）、frontmatter 编辑（区块内联表单已迁入）、LOOP.md 指针正文编辑（frontmatter 字节保留）、
  知识文档编辑（任意命名，白名单）、根级宪法编辑（缺失预填模板）、STATE.md 只读、删除（锁活 409 /
  绑定项二次确认 / SKILL 与宪法不删）。**不编辑 SKILL.md**。服务端逻辑全在 `lib/loops/manage.ts`
  （唯一 PUT 写入口 + 文件名白名单 + mtime 乐观并发 + 原子写），路由薄壳
  （`POST /loops`、`GET|PUT /loops/[name]/docs`、`DELETE /loops/[name]`）。
```

2. **File Map** 的 `app/api/` 区块，`workspaces/[id]/loops/[name]/stop/route.ts` 行后追加：

```
  workspaces/[id]/loops/[name]/docs/route.ts     GET 配置面板数据包 | PUT 唯一写入口（doc|body|constitution，mtime 乐观并发）
```

并给 `workspaces/route.ts`（GET list…）行下的 `workspaces/[id]/loops/route.ts` 行补 `| POST 创建（initLoop 脚手架）`；`[name]/route.ts` 行补 `| DELETE 删除（锁活/绑定守卫）`。

3. **File Map** 的 `lib/loops/` 区块追加：

```
    manage.ts               loop 配置面服务端逻辑：getLoopDocs/writeLoopFile/createLoop/deleteLoop + 守卫（白名单/原子写/mtime 并发/锁活/绑定扫描）
```

4. **components/** File Map 追加：

```
  LoopsConfig.tsx           loop 配置视图（创建向导 + frontmatter/指针正文/知识文档/宪法编辑 + STATE 只读 + 删除）——桌面右栏 / 移动 overview 栈页共用
```

- [ ] **Step 2: 最终全量验证**

Run: `node_modules/.bin/tsc --noEmit && npm test && npm run lint`
Expected: 三项全绿

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 记录 loop 配置面（LoopsConfig/manage.ts/新路由）"
```

---

## Self-Review（已执行）

**Spec coverage**：§4.1 右栏状态/直接挂载 → Task 5/6；§4.2 常驻区块+配置按钮+表单迁移 → Task 6 Step 1；§4.3 六节视图 → Task 4；§4.4 创建向导（L1 默认/自动打开/SKILL 提示）→ Task 4；§4.5 移动栈 → Task 6 Step 3；§5.1 四路由 → Task 3；§5.2 target 联合 → Task 2/3；§5.3 全部守卫 → Task 2（+测试）；§5.4 并发语义（不加锁/STATE 排除）→ Task 2 实现 + Task 4 UI；§6 错误映射（409 附体）→ Task 3/4；§7 测试计划 → Task 1/2（spec 列的每类用例都有对应 test 块；GET docs 形状由 `getLoopDocs` 用例覆盖）；§8 AGENTS.md 义务 → Task 7。**无缺口。**

**Placeholder scan**：无 TBD/TODO；所有代码步骤带完整代码；MobileShell 的「既有 props 不动」注释是既有代码保留指示（非待实现占位），替换表机械完备。

**Type consistency**：`LoopConfigTarget`（Task 4 定义，Task 5/6 消费）✓；`WriteTarget`/`LoopDocsBundle`（Task 2 定义，Task 3 路由透传、Task 4 `import type` 消费）✓；`writeLoopFile` 返回 `{mtimeMs}` 与 PUT 200 体一致 ✓；`LoopManageError.details` 键（`currentContent`/`currentMtimeMs`/`running`/`boundItems`）与 Task 3 errorResponse 展开、Task 4 UI 消费一致 ✓；`splitLoopFile`（Task 1）签名与 Task 2 用法一致 ✓。
