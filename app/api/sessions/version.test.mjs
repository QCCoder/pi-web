import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  alias: { "@": fileURLToPath(new URL("../../../", import.meta.url)) },
});
const { GET: getSessionListVersionRoute } = await jiti.import("./version/route.ts");
const { getSessionListVersion, invalidateSessionListCache } = await jiti.import("../../../lib/session-reader.ts");

test("version endpoint mirrors the session list generation without bumping it", async () => {
  invalidateSessionListCache();
  const before = getSessionListVersion();
  const response = await getSessionListVersionRoute();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.sessionListVersion, before);
  assert.equal((await (await getSessionListVersionRoute()).json()).sessionListVersion, before, "reads must not create a refresh loop");

  invalidateSessionListCache();
  const after = getSessionListVersion();
  assert.ok(after > before);
  assert.equal((await (await getSessionListVersionRoute()).json()).sessionListVersion, after);
});

test("list responses capture the version before the scan so mid-scan mutations stay visible", () => {
  // 与上游同款源断言：版本必须先于 buildSessionsPayload 的 await 捕获，
  // 否则扫描期间的 mutation 版本被吞、其他窗口永远等不到刷新。
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const capture = source.indexOf("getSessionListVersion()");
  const scan = source.indexOf("await buildSessionsPayload");
  assert.ok(capture !== -1 && scan !== -1);
  assert.ok(capture < scan);
});
