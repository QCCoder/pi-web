/** cron 人话摘要（Overview Loops 区块用，纯函数）。只概括常见形态：
 *  分钟为任意值 / 步进（分钟字段写「星号斜杠 n」）/ 固定值；小时 `*` / 固定 /
 *  范围 / 列表；dow `*` / `1-5` / `0,6` / 数字列表。dom/month 受限或其它形态
 *  → null（UI 回落显示原始 cron，不撒谎）。
 *  注意：分钟固定值（如 `0 9-22 * * 0,6`）≠ 每 60 分钟步进 —— 语义诚实，说
 *  「每小时的 0 分」而不是「每 60 分钟」。 */
const WEEKDAY_TEXT: Record<string, string> = { "1-5": "工作日", "0,6": "周末" };
const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dowText(dow: string): string | undefined {
  if (dow === "*") return "";
  if (WEEKDAY_TEXT[dow] !== undefined) return WEEKDAY_TEXT[dow];
  const parts = dow.split(",").map((part) => DOW_NAMES[Number(part)]).filter(Boolean);
  return parts.length > 0 ? parts.join("/") : undefined;
}

function hourText(hour: string): string | undefined {
  if (hour === "*") return "";
  const single = hour.match(/^(\d+)$/);
  if (single) {
    const value = Number(single[1]);
    return value >= 0 && value <= 23 ? `${value} 点` : undefined;
  }
  const range = hour.match(/^(\d+)-(\d+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return lo >= 0 && hi <= 23 && lo <= hi ? `${lo}–${hi} 点` : undefined;
  }
  const list = hour.split(",").map(Number);
  if (list.length > 1 && list.every((value) => Number.isInteger(value) && value >= 0 && value <= 23)) {
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
  const prefix = [dowPart, hourPart].filter(Boolean).join(" ");

  const step = minute.match(/^\*\/(\d+)$/);
  if (step) {
    const every = Number(step[1]);
    if (!(every >= 1 && every <= 59)) return null;
    return prefix ? `${prefix}每 ${every} 分钟` : `每 ${every} 分钟`;
  }
  const at = minute.match(/^(\d+)$/);
  if (at) {
    const mm = Number(at[1]);
    if (!(mm >= 0 && mm <= 59)) return null;
    const exactHour = hour.match(/^(\d+)$/);
    if (exactHour) {
      // hour 可行性已由 hourText 校验（0-23），这里只取数值去补零
      return `${dowPart || "每天"} ${Number(exactHour[1])}:${String(mm).padStart(2, "0")}`;
    }
    return prefix ? `${prefix}每小时的 ${mm} 分` : `每小时的 ${mm} 分`;
  }
  return null;
}
