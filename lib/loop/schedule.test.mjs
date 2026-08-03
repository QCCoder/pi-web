import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./schedule.ts");
}

// Helper: a UTC instant. All test "now" values are picked so the Shanghai
// wall-clock (UTC+8) is known exactly.
const utc = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));

test("parseSchedule accepts strict HH:MM, rejects garbage", async () => {
  const { parseSchedule } = await loadSubject();
  assert.deepEqual(parseSchedule("15:05"), { hour: 15, minute: 5 });
  assert.deepEqual(parseSchedule("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseSchedule(" 23:59 "), { hour: 23, minute: 59 });
  assert.equal(parseSchedule("24:00"), null);
  assert.equal(parseSchedule("12:60"), null);
  assert.equal(parseSchedule("9:05"), null); // hour must be two digits
  assert.equal(parseSchedule("9:5"), null); // minute must be two digits
  assert.equal(parseSchedule("noon"), null);
  assert.equal(parseSchedule(""), null);
});

test("isJobDue: before today's slot -> not due", async () => {
  const { isJobDue } = await loadSubject();
  // schedule 15:00 Shanghai; now 14:00 Shanghai (06:00 UTC)
  const now = utc(2024, 1, 15, 6, 0);
  assert.equal(isJobDue(now, "15:00", null), false);
});

test("isJobDue: at/after slot, never run -> due", async () => {
  const { isJobDue } = await loadSubject();
  // now exactly 15:00 Shanghai (07:00 UTC)
  const now = utc(2024, 1, 15, 7, 0);
  assert.equal(isJobDue(now, "15:00", null), true);
  // now 15:30 Shanghai
  assert.equal(isJobDue(utc(2024, 1, 15, 7, 30), "15:00", null), true);
});

test("isJobDue: catch-up after restart (last run before today's slot)", async () => {
  const { isJobDue } = await loadSubject();
  // last run 13:00 Shanghai (05:00 UTC) today; now 15:30 Shanghai
  const last = utc(2024, 1, 15, 5, 0);
  const now = utc(2024, 1, 15, 7, 30);
  assert.equal(isJobDue(now, "15:00", last), true);
});

test("isJobDue: already ran at/after today's slot -> not due", async () => {
  const { isJobDue } = await loadSubject();
  // last run 15:10 Shanghai (07:10 UTC); now 16:00 Shanghai
  const last = utc(2024, 1, 15, 7, 10);
  const now = utc(2024, 1, 15, 8, 0);
  assert.equal(isJobDue(now, "15:00", last), false);
});

test("isJobDue: missed slot across midnight is not caught up", async () => {
  const { isJobDue } = await loadSubject();
  // schedule 23:59; now next day 00:01 Shanghai = prev day 16:01 UTC
  const last = utc(2024, 1, 14, 5, 0); // ran two days ago
  const now = utc(2024, 1, 15, 16, 1);
  assert.equal(isJobDue(now, "23:59", last), false);
});

test("isJobDue: early-morning slot, ran yesterday, now past -> due (rollover)", async () => {
  const { isJobDue } = await loadSubject();
  // schedule 00:05; now Jan16 00:06 Shanghai = Jan15 16:06 UTC; ran yesterday
  const last = utc(2024, 1, 14, 16, 0);
  const now = utc(2024, 1, 15, 16, 6);
  assert.equal(isJobDue(now, "00:05", last), true);
});

test("isJobDue: invalid schedule -> never due", async () => {
  const { isJobDue } = await loadSubject();
  assert.equal(isJobDue(new Date(), "nope", null), false);
});

test("nextScheduledMs: later today when before slot; tomorrow otherwise", async () => {
  const { nextScheduledMs, scheduledInstantTodayMs } = await loadSubject();
  const { SHANGHAI_OFFSET_MS } = await loadSubject();
  const hour = 15, minute = 0;
  const before = utc(2024, 1, 15, 6, 0); // 14:00 Shanghai
  const todayInstant = scheduledInstantTodayMs(before, hour, minute);
  assert.equal(nextScheduledMs(before, "15:00"), todayInstant);

  const after = utc(2024, 1, 15, 8, 0); // 16:00 Shanghai
  assert.equal(nextScheduledMs(after, "15:00"), todayInstant + 24 * 60 * 60 * 1000);

  assert.equal(nextScheduledMs(after, "bad"), null);
  // sanity: today's 15:00 Shanghai == 07:00 UTC of Jan 15
  assert.equal(todayInstant + SHANGHAI_OFFSET_MS, Date.UTC(2024, 0, 15, 15, 0));
});
