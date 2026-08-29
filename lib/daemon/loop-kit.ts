/** pi-loop kit 协议的纯解析层（design: docs/pi-loop-kit-design.md §4）。
 *  纯 fs + yaml，无 daemon 依赖 —— web 进程（kit-loops 列表路由）亦可导入。 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
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
  // name 可选、缺省取目录名（kit/README.md 契约）；pattern 缺省跟随 loopName。
  const loopName = typeof record.name === "string" && record.name.trim()
    ? record.name.trim() : basename(dir);
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
  // NOTE (task-3 deviation): brief annotated this as ReturnType<typeof readdirSync>,
  // which resolves the wrong overload (Dirent<NonSharedBuffer>[]) under @types/node 25.
  // The withFileTypes:true call returns Dirent<string>[] — annotate that directly.
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
