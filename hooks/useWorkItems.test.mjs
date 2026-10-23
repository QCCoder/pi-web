import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useWorkItems.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true, moduleCache: false });
const { coalesceNotifiedSnapshot } = await jiti.import("./useWorkItems.ts");

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

  // Hot-switching workspaceId (same component, no remount) must reset
  // loading/error on EVERY id change: the previous workspace's in-flight
  // fetch is cancelled and its settle path skips setState, so a fresh
  // snapshot on the new workspace would otherwise leave loading stuck true
  // (and a stale error visible) over displayed data.
  assert.match(
    source,
    /const current = getSnapshot\(workspaceId\);\s*\n\s*setSnapshotState\(current\);\s*\n\s*setLoading\(current === null\);\s*\n\s*setError\(null\);/,
    "the id-change catch-up branch must reset loading and error from the new workspace's store state",
  );
});

test("coalesceNotifiedSnapshot: null notifications keep the last snapshot (invalidate flicker fix)", () => {
  const stale = { items: [], archivedItems: [], trashedItems: [], invalid: [], fetchedAt: 1 };
  const fresh = { items: [], archivedItems: [], trashedItems: [], invalid: [], fetchedAt: 2 };
  // invalidate() 先 clearSnapshot → 订阅者同步收到 null：忽略之，保留旧快照，
  // 强制重取落地（setSnapshot 通知）才替换——每次 create/archive/restore 不再
  // 闪一轮「暂无工作项」/「选择工作项」空态。
  assert.equal(coalesceNotifiedSnapshot(stale, null), stale, "null notification is ignored — keep the last snapshot");
  assert.equal(coalesceNotifiedSnapshot(stale, fresh), fresh, "a real snapshot replaces the previous one");
  // 首载语义不受影响：无旧快照 + null 通知仍是 null（loading 由 mount effect 呈现）。
  assert.equal(coalesceNotifiedSnapshot(null, null), null, "no prior snapshot + null notification stays null");
  assert.equal(coalesceNotifiedSnapshot(null, fresh), fresh, "no prior snapshot adopts the first real snapshot");
});

test("hook source contract: subscription ignores null notifications; refetch gating still reads the store", () => {
  // 订阅回调必须经 coalesceNotifiedSnapshot（函数式 setState）——不能把 null
  // 直接传播进 hook state。
  assert.match(
    source,
    /subscribeWorkItems\(workspaceId,\s*\(next\) => setSnapshotState\(\(prev\) => coalesceNotifiedSnapshot\(prev, next\)\),?\s*\)/,
    "the store subscription must coalesce null notifications through coalesceNotifiedSnapshot",
  );
  // 强制重取的闸门必须继续读 STORE（getSnapshot），不是 hook state——invalidate
  // 清了 store，mount/gate 仍会强制重取，不存在「hook state 看似新鲜而跳过重取」的路径。
  assert.match(
    source,
    /if \(shouldRefetch\(getSnapshot\(workspaceId\), Date\.now\(\), pollMs\)\)/,
    "the mount gate keeps reading the store snapshot, not hook state",
  );
});
