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

// NOTE (task-2 deviation): the brief's verbatim code used TypeScript parameter
// properties (constructor(readonly status: number, ...)) — Node's strip-only
// type stripping rejects that syntax (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), so the
// mandated `node --test` runner could not load the module. Fields are assigned in
// the constructor body instead; the public surface (instanceof/.status/.details)
// is identical. No repo .ts uses parameter properties for the same reason.
export class LoopManageError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
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
  // fix(final-review F1): 畸形 target（未知 kind / constitution 非法 file）此前落入宪法
  // 路径使 CONSTITUTION_FILES[target.file] === undefined → join(path, undefined) TypeError →
  // HTTP 500；路由层壳无法从 500 还原语义，按写面收窄原则在此显式 400。
  if (target.kind !== "constitution" || (target.file !== "constraints" && target.file !== "budget")) {
    throw new LoopManageError("未知的写入 target", 400);
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

export interface CreateLoopInput {
  name: string;
  cron: string;
  timezone?: string;
  level?: "L1" | "L2" | "L3";
  maxMinutes?: number;
  pattern?: string;
}

export async function createLoop(
  workspacePath: string,
  input: CreateLoopInput,
): Promise<{ name: string; skillReused: boolean }> {
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
  // fix(final-review F2): initLoop 对既有 .agents/skills/<pattern>/SKILL.md 不覆盖——
  // 先记下复用事实，随响应返回让表单提示诚实化（此前 footer 谎称「骨架已生成」）。
  const skillExisted = existsSync(
    join(workspacePath, ".agents", "skills", input.pattern ?? input.name, "SKILL.md"),
  );
  initLoop(workspacePath, {
    name: input.name,
    cron: input.cron,
    pattern: input.pattern,
    level: input.level,
    maxMinutes: input.maxMinutes,
    timezone: input.timezone,
  });
  return { name: input.name, skillReused: skillExisted };
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
