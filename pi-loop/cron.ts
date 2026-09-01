/** Vixie-cron matching + next-due computation（design: docs/pi-loop-host-design.md §5 纯逻辑层）。
 *  Originally the v3 loop scheduler's matcher (moved out ahead of the v3 teardown,
 *  then into the pi-loop package); pure, no daemon deps — daemon spawner 与 beat CLI
 *  共用。契约：畸形输入「返回 false/undefined、永不抛」。 */

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

function makeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric",
    month: "numeric", weekday: "short", hourCycle: "h23",
  });
}

function matchFields(fields: string[], fmt: Intl.DateTimeFormat, now: Date): boolean {
  const parts = fmt.formatToParts(now);
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

export function cronMatches(expression: string, timezone: string, now: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  try {
    return matchFields(fields, makeFormatter(timezone), now);
  } catch {
    // 无效时区（如 Asia/Shanghao）是人写 frontmatter 的现实输入 — 遵守本文件
    // 「畸形输入返回 false、永不抛」的契约，一个坏声明不得炸掉整个 tick。
    return false;
  }
}

/** 预解析表达式得到可复用的匹配函数。**不含时区** —— 按 UTC 字段评估（Date 的
 *  原始时刻字段，无换算）；时区语义由调用方传给 cronMatches/nextDue。
 *  无效表达式返回恒 false 函数（字段数错则立即；字段垃圾则逐次评估为 false）。 */
export function buildMatcher(expression: string): (now: Date) => boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return () => false;
  const fmt = makeFormatter("UTC");
  return (now: Date) => matchFields(fields, fmt, now);
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
