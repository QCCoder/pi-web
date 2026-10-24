import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Ordered-shutdown guarantee (final review finding 1): Node runs signal
// listeners in REGISTRATION order. The registry used to install its own
// SIGINT/SIGTERM cleanup on first use (first page render — which happens
// BEFORE the async host boot chain finishes), so on Ctrl+C mid-round the
// registry's cleanup destroyed every wrapper FIRST → destroy() sets
// _alive=false synchronously → background's ordered shutdown then snapshotted
// zero running rounds → zero interruption records → clean exit(0) and the
// recovery gate never engaged. The ordered shutdown must be the FIRST signal
// listener, owned by background.ts and registered SYNCHRONOUSLY at the top of
// ensureHostBooted; the registry keeps only the `exit` hook as the
// idempotent tail guarantee.

test("registry init registers only the exit hook — never SIGINT/SIGTERM", async () => {
  const src = await readFile(new URL("./registry.ts", import.meta.url), "utf8");
  assert.match(src, /process\.once\("exit", cleanup\)/);
  assert.doesNotMatch(src, /process\.once\("SIGINT"/);
  assert.doesNotMatch(src, /process\.once\("SIGTERM"/);
  // the init block must point readers at the ordered shutdown's real home
  assert.match(src, /lib\/session-host\/background\.ts/);
  assert.match(src, /registerShutdownHandlers/);
});

test("background registers SIGINT/SIGTERM synchronously inside ensureHostBooted, before the async boot chain", async () => {
  const src = await readFile(new URL("./background.ts", import.meta.url), "utf8");
  assert.match(src, /process\.once\("SIGINT"/);
  assert.match(src, /process\.once\("SIGTERM"/);
  const fn = src.slice(src.indexOf("export function ensureHostBooted"));
  const registerPos = fn.indexOf("registerShutdownHandlers(");
  assert.notEqual(registerPos, -1, "ensureHostBooted itself must register the shutdown handlers");
  const importPos = fn.indexOf("import(");
  const guardPos = fn.indexOf("void guard");
  assert.ok(importPos === -1 || registerPos < importPos, "registration must precede the dynamic spawner import");
  assert.ok(guardPos === -1 || registerPos < guardPos, "registration must precede the async boot chain");
  // and ONLY there — the async chain must not carry the registration anymore
  const chain = fn.slice(guardPos === -1 ? importPos : guardPos);
  assert.ok(!chain.includes("registerShutdownHandlers("), "registration must not live inside the async boot chain");
});

test("shutdown's stopBackground cannot throw out of the signal handler", async () => {
  const src = await readFile(new URL("./background.ts", import.meta.url), "utf8");
  // tolerant of a not-yet-started/failed job (registration now precedes job
  // start) AND of a stop() that throws — either must not abort the ordered
  // shutdown before interruption records are written. T7: both jobs (loop
  // spawner + delivery dispatcher) share the same guarded-stop loop.
  assert.match(src, /if \(!stop\) continue;/, "not-yet-started jobs must be a no-op");
  assert.match(src, /function stopBackgroundSafely\(\): void \{[\s\S]*?try \{[\s\S]*?catch/, "stop call must be wrapped in try/catch");
  assert.match(src, /registerShutdownHandlers\(stopBackgroundSafely\)/);
});
