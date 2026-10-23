import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const lock = await jiti.import("./file-lock.ts");
const {
  withWorkspaceFileLock,
  readLockOwner,
  parseLockOwner,
  formatLockOwner,
  isLockStale,
  resolveLockPath,
  WorkItemConflictError,
} = lock;

const UUID_RE = /^[0-9a-f-]{36}$/;

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-lock-"));
  return { dir, lockPath: join(dir, ".pi", ".write-lock") };
}

function ownerString(pid, createdAt = Date.now(), uuid = crypto.randomUUID()) {
  return formatLockOwner(pid, "tester.local", uuid, createdAt);
}

/** Pre-seed a foreign lock file the way another process would leave it. */
async function seedLock(lockPath, owner) {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${owner}\n`, "utf8");
}

test("parseLockOwner round-trips formatLockOwner; malformed content is null", () => {
  const uuid = crypto.randomUUID();
  const owner = parseLockOwner(formatLockOwner(4242, "host.example", uuid, 1234567890));
  assert.equal(owner.pid, 4242);
  assert.equal(owner.hostname, "host.example");
  assert.equal(owner.createdAt, 1234567890);
  assert.ok(UUID_RE.test(owner.token.split(":")[1] ?? ""));
  assert.equal(owner.token, formatLockOwner(4242, "host.example", uuid, 1234567890));
  assert.equal(parseLockOwner("garbage"), null);
  assert.equal(parseLockOwner(""), null);
  assert.equal(parseLockOwner("-1@h:".concat(uuid, ":1")), null);
});

test("isLockStale: null owner stealable; dead pid stealable; live pid in window not; over window stealable", async () => {
  assert.equal(isLockStale(null, Date.now(), 30_000), true);
  const now = Date.now();
  assert.equal(isLockStale({ pid: process.pid, hostname: "h", token: "t", createdAt: now }, now + 1000, 30_000), false);
  assert.equal(isLockStale({ pid: process.pid, hostname: "h", token: "t", createdAt: now - 60_000 }, now, 30_000), true);
  // A certainly-dead pid (a child that already exited).
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(isLockStale({ pid: child.pid, hostname: "h", token: "t", createdAt: now }, now, 30_000), true);
});

test("acquire → release removes the lock; a second run succeeds (two views of one workspace)", async () => {
  const { dir, lockPath } = await tempWorkspace();
  try {
    const first = await withWorkspaceFileLock(dir, async () => {
      const owner = readLockOwner(lockPath);
      assert.ok(owner, "lock file exists while held");
      assert.equal(owner.pid, process.pid);
      return "first";
    });
    assert.equal(first, "first");
    assert.equal(readLockOwner(lockPath), null, "lock removed after release");
    const second = await withWorkspaceFileLock(dir, async () => "second");
    assert.equal(second, "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a held live lock rejects a second caller and is left untouched", async () => {
  const { dir, lockPath } = await tempWorkspace();
  try {
    await seedLock(lockPath, ownerString(process.pid));
    await assert.rejects(
      () => withWorkspaceFileLock(dir, async () => "should not run"),
      (error) => error instanceof WorkItemConflictError && /busy/.test(error.message),
    );
    const owner = readLockOwner(lockPath);
    assert.equal(owner.pid, process.pid, "holder's lock file untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-process concurrent calls: the later caller fails fast with busy, no deadlock", async () => {
  const { dir } = await tempWorkspace();
  try {
    let signalAcquired;
    const acquired = new Promise((resolve) => { signalAcquired = resolve; });
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = withWorkspaceFileLock(dir, async () => {
      signalAcquired();
      await gate;
      return "first";
    });
    await acquired; // first definitively holds the lock
    await assert.rejects(
      () => withWorkspaceFileLock(dir, async () => "second"),
      (error) => error instanceof WorkItemConflictError && /busy/.test(error.message),
    );
    releaseFirst();
    assert.equal(await first, "first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dead-pid holder's lock is stale-stealed and the operation runs", async () => {
  const { dir, lockPath } = await tempWorkspace();
  try {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => child.on("close", resolve));
    await seedLock(lockPath, ownerString(child.pid));
    const result = await withWorkspaceFileLock(dir, async () => "stolen");
    assert.equal(result, "stolen");
    assert.equal(readLockOwner(lockPath), null, "our own lock released after the steal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live holder over the stale window is preempted", async () => {
  const { dir, lockPath } = await tempWorkspace();
  try {
    await seedLock(lockPath, ownerString(process.pid, Date.now() - 60_000));
    const result = await withWorkspaceFileLock(dir, async () => "preempted");
    assert.equal(result, "preempted");
    assert.equal(readLockOwner(lockPath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release verifies the owner token — a replaced lock is never deleted", async () => {
  const { dir, lockPath } = await tempWorkspace();
  try {
    await withWorkspaceFileLock(dir, async () => {
      // Simulate a peer replacing our lock while we run.
      await writeFile(lockPath, `${ownerString(process.pid)}\n`, "utf8");
      return "done";
    });
    const thief = readLockOwner(lockPath);
    assert.ok(thief, "foreign lock survived our release (token mismatch)");
    assert.notEqual(thief.token, "");
    const content = await readFile(lockPath, "utf8");
    assert.equal(parseLockOwner(content).token, thief.token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveLockPath: directory → .pi/.write-lock, file → sibling, absent → null", async () => {
  const { dir } = await tempWorkspace();
  try {
    assert.equal(await resolveLockPath(dir), join(dir, ".pi", ".write-lock"));
    const filePath = join(dir, "index.yaml");
    await writeFile(filePath, "{}\n", "utf8");
    assert.equal(await resolveLockPath(filePath), `${filePath}.write-lock`);
    assert.equal(await resolveLockPath(join(dir, "nope")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
