import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./route.ts");
const {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
} = await jiti.import("@/lib/session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("detail GET gzips large payloads while keeping the stat ETag and 304 path intact (upstream 09383ae)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-gzip-etag-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  let sessionId;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (sessionId) invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = SessionManager.create(dir, dir);
  sessionId = manager.getSessionId();
  cacheSessionPath(sessionId, manager.getSessionFile());
  // Large body so the detail response crosses the 1 KiB gzip threshold.
  manager.appendMessage({ role: "user", content: "fixture payload ".repeat(200), timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "compressed response body ".repeat(100) }], timestamp: Date.now() });

  const context = { params: Promise.resolve({ id: sessionId }) };
  const gzipHeaders = { "Accept-Encoding": "gzip" };

  const first = await getSessionDetail(
    new Request(`http://localhost:30141/api/sessions/${sessionId}`, { headers: gzipHeaders }),
    context,
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Content-Encoding"), "gzip");
  assert.match(first.headers.get("Vary") ?? "", /Accept-Encoding/i);
  const etag = first.headers.get("ETag");
  assert.ok(etag, "ETag must survive compression");
  const raw = gunzipSync(Buffer.from(await first.arrayBuffer())).toString("utf8");
  const payload = JSON.parse(raw);
  assert.equal(payload.revision, etag);

  const revalidation = await getSessionDetail(
    new Request(`http://localhost:30141/api/sessions/${sessionId}`, {
      headers: { ...gzipHeaders, "If-None-Match": etag },
    }),
    context,
  );
  assert.equal(revalidation.status, 304);
  assert.equal(revalidation.headers.get("ETag"), etag);
  assert.equal(revalidation.headers.get("Content-Encoding"), null);
});
