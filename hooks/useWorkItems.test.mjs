import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./useWorkItems.ts", import.meta.url), "utf8");

test("hook source contract: one refcounted poller per workspace with visibility/focus revalidation", () => {
  // ONE module-level poller registry, refcounted — multiple hosts of the same
  // workspace share one interval (spec §6.3 同一工作区不启动两个轮询器).
  assert.match(source, /const pollers = new Map<string, PollerEntry>/);
  assert.match(source, /function ensurePoller\(/);
  assert.match(source, /function releasePoller\(/);
  assert.match(source, /refCount -= 1/);
  assert.match(source, /refCount \+= 1/);
  // Mount effect pairs ensure/release so unmount tears the last host's poller down.
  assert.match(source, /ensurePoller\(workspaceId, pollMs\)/);
  assert.match(source, /releasePoller\(workspaceId\)/);

  // Page-visible polling, hidden stop, focus revalidation.
  assert.match(source, /"visibilitychange"/);
  assert.match(source, /"focus"/);
  assert.match(source, /visibilityState !== "visible"/);
  assert.match(source, /clearInterval/);

  // Mount is gated by the store's age check — a fresh snapshot from another
  // host short-circuits the fetch (双宿主秒开, no fetch storm).
  assert.match(source, /shouldRefetch\(getSnapshot\(workspaceId\), Date\.now\(\), pollMs\)/);

  // invalidate() = clearSnapshot + immediate refetch.
  assert.match(source, /clearSnapshot\(workspaceId\)/);

  // Snapshot writes go through the shared store (subscribers fan out).
  assert.match(source, /setSnapshot\(workspaceId, result\.snapshot\)/);

  // SSR safety: no bare `document`/`window` access at module scope — DOM
  // touches sit behind typeof guards or inside functions called from effects.
  assert.match(source, /typeof document === "undefined"/);
});
