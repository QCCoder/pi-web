import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
// A3 review F2: the extension cache must be success-only. rpc-manager awaits
// piSubagentExtension() for EVERY session, so a cached rejection would 500 all
// POST /v1/sessions until a daemon restart. The entryPath parameter is the
// test seam — production callers omit it and get the installed package.
import { piSubagentExtension } from "./pi-subagent-host.ts";

test("piSubagentExtension caches success — one shared promise per entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-host-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "extensions", "subagent.ts");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "export default function factory(pi, policy) {}\n", "utf8");

  const first = piSubagentExtension(entry);
  const again = piSubagentExtension(entry);
  assert.equal(again, first); // cached promise identity
  const extension = await first;
  assert.equal(extension.name, "pi-subagent");
  assert.equal(typeof extension.factory, "function");
  assert.equal(piSubagentExtension(entry), first); // success stays cached
});

test("a failed load is NOT sticky — the cache slot resets and the next call retries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-host-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "missing", "subagent.ts"); // jiti import fails

  const first = piSubagentExtension(missing);
  await assert.rejects(first);
  const second = piSubagentExtension(missing);
  assert.notEqual(second, first); // fresh attempt, not the cached rejection
  await assert.rejects(second); // still fails loudly (no stub fallback)
});
