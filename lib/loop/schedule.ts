/**
 * Loop scheduling math — pure, zero-dependency.
 *
 * Schedules are simple daily `HH:MM` in Asia/Shanghai. China Standard Time is
 * UTC+8 with no DST (DST was abolished in 1991), so we can convert between a
 * Shanghai wall-clock and a UTC instant with a fixed +8h offset, without Intl
 * parsing or a timezone library.
 */

/** Asia/Shanghai is a fixed UTC+8. */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface ParsedSchedule {
  hour: number;
  minute: number;
}

const SCHEDULE_RE = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*$/;

/** Parse a daily `HH:MM` schedule. Returns null for anything unparseable. */
export function parseSchedule(schedule: string): ParsedSchedule | null {
  if (typeof schedule !== "string") return null;
  const match = schedule.match(SCHEDULE_RE);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The ms timestamp that, read as UTC, equals `now`'s Asia/Shanghai wall-clock. */
function shanghaiWallMs(now: Date): number {
  return now.getTime() + SHANGHAI_OFFSET_MS;
}

/** Asia/Shanghai wall-clock fields for `now`. month is 1-based. */
export function shanghaiWallParts(now: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const wall = new Date(shanghaiWallMs(now));
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
  };
}

/** UTC instant (ms) of today's HH:MM in Asia/Shanghai. */
export function scheduledInstantTodayMs(now: Date, hour: number, minute: number): number {
  const wall = new Date(shanghaiWallMs(now));
  return (
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, minute, 0, 0)
    - SHANGHAI_OFFSET_MS
  );
}

/**
 * Should the job run now, given its schedule and last run?
 *
 * Same-day catch-up: if the server was down at the scheduled time and restarts
 * later the same day (Asia/Shanghai), the run fires once. A slot that the
 * server missed across the Shanghai midnight boundary is not caught up — the
 * next slot opens at its scheduled time. `lastRunAt` is the last recorded run
 * (success or error); if it falls at/after today's scheduled instant, the slot
 * is considered filled.
 */
export function isJobDue(
  now: Date,
  schedule: string,
  lastRunAt: Date | null,
): boolean {
  const parsed = parseSchedule(schedule);
  if (!parsed) return false;
  const scheduledTodayMs = scheduledInstantTodayMs(now, parsed.hour, parsed.minute);
  if (now.getTime() < scheduledTodayMs) return false;
  if (lastRunAt && lastRunAt.getTime() >= scheduledTodayMs) return false;
  return true;
}

/** Next future scheduled instant (ms) for display; null if schedule is invalid. */
export function nextScheduledMs(now: Date, schedule: string): number | null {
  const parsed = parseSchedule(schedule);
  if (!parsed) return null;
  const today = scheduledInstantTodayMs(now, parsed.hour, parsed.minute);
  if (now.getTime() < today) return today;
  // Shanghai has no DST, so +24h lands exactly on tomorrow's same wall time.
  return today + 24 * 60 * 60 * 1000;
}
