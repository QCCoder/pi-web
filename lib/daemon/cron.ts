/** Vixie-cron matching. Originally the v3 loop scheduler's matcher (moved
 *  out ahead of the v3 teardown); the kit spawner is now its only consumer. */

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
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric",
      month: "numeric", weekday: "short", hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    // 无效时区（如 Asia/Shanghao）是人写 frontmatter 的现实输入 — 遵守本文件
    // 「畸形输入返回 false、永不抛」的契约，一个坏声明不得炸掉整个 tick。
    return false;
  }
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
