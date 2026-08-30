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
