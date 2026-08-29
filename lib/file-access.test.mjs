import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

async function loadSubject() {
  return import("./path-security.ts");
}

// file-access.ts uses extensionless relative imports, which Node's native TS
// loader cannot resolve; jiti (the project's standard loader for such modules)
// resolves them. See lib/loop/runtime.test.mjs.
const jiti = createJiti(import.meta.url);
function loadFileAccess() {
  return jiti.import("./file-access.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("getAllowedFileRoots includes workspace paths from the global index", async (t) => {
  const prevEnv = process.env.PI_WORKSPACE_INDEX_FILE;
  const prevCache = globalThis.__piAllowedRootsCache;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ws-index-"));
  t.after(() => {
    if (prevEnv === undefined) delete process.env.PI_WORKSPACE_INDEX_FILE;
    else process.env.PI_WORKSPACE_INDEX_FILE = prevEnv;
    globalThis.__piAllowedRootsCache = prevCache;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A fake workspace root with a nested knowledge-bundle file under it.
  const wsPath = path.join(tmp, "workspace-fake");
  const kbFile = path.join(wsPath, "repositories", "knowledge", "foo", "index.md");
  fs.mkdirSync(path.dirname(kbFile), { recursive: true });
  fs.writeFileSync(kbFile, "# foo\n");

  // A fake global index that lists exactly this workspace.
  const indexPath = path.join(tmp, "workspace.yaml");
  fs.writeFileSync(
    indexPath,
    `schema_version: 1\nworkspaces:\n  - id: x\n    path: ${wsPath}\n    name: fake\n`,
  );
  process.env.PI_WORKSPACE_INDEX_FILE = indexPath;
  // Bust the short-TTL cache so the new env var takes effect immediately.
  globalThis.__piAllowedRootsCache = undefined;

  const { getAllowedFileRoots, isFilePathAllowed } = await loadFileAccess();
  const roots = await getAllowedFileRoots();

  assert.ok(
    roots.has(wsPath),
    `roots should contain the indexed workspace path ${wsPath}; got ${JSON.stringify([...roots])}`,
  );
  // A nested workspace-owned file must be allowed (prefix coverage), even though
  // only the workspace root (not the bundle subdir) was added to the index.
  assert.equal(isFilePathAllowed(kbFile, roots), true);
});

test("getAllowedFileRoots tolerates a missing/unreadable global index", async (t) => {
  const prevEnv = process.env.PI_WORKSPACE_INDEX_FILE;
  const prevCache = globalThis.__piAllowedRootsCache;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.PI_WORKSPACE_INDEX_FILE;
    else process.env.PI_WORKSPACE_INDEX_FILE = prevEnv;
    globalThis.__piAllowedRootsCache = prevCache;
  });

  // Point at a path that does not exist; getAllowedFileRoots must not throw and
  // must still return a valid set (session/additional roots remain in effect).
  process.env.PI_WORKSPACE_INDEX_FILE = path.join(os.tmpdir(), "pi-web-does-not-exist.yaml");
  globalThis.__piAllowedRootsCache = undefined;

  const { getAllowedFileRoots } = await loadFileAccess();
  const roots = await getAllowedFileRoots();
  assert.ok(roots instanceof Set);
});
