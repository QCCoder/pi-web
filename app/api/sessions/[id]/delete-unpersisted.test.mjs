import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE: deleteSession } = await jiti.import("./route.ts");
const {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  resolveSessionPath,
} = await jiti.import("@/lib/session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("deleting an unpersisted runtime session answers ok and invalidates the caches", async (t) => {
  // pi flushes the .jsonl lazily on first append, but /api/agent/new seeds the
  // path cache already — a DELETE in that window must not 500 on ENOENT
  // (upstream edf0deb): the wrapper was torn down, so treat it as deleted.
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-empty-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();

  const manager = SessionManager.create(dir, dir);
  const id = manager.getSessionId();
  const filePath = manager.getSessionFile();
  cacheSessionPath(id, filePath);
  // Sanity: the runtime session exists in the cache but not on disk.
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
  assert.equal(await resolveSessionPath(id), filePath);

  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  // Both caches invalidated: the cached-but-never-flushed path is gone.
  assert.equal(await resolveSessionPath(id), null);
});
