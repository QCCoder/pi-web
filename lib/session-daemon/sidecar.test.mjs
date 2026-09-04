import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSidecarAction,
  ensureSessionDaemonStarted,
  resetSidecarStateForTest,
  sidecarSpawnEnv,
  spawnableDaemonUrl,
} from "./sidecar.ts";

// ---- ensureSessionDaemonStarted lifecycle (injected probe/spawn — no network) ----

/** Fake clock + instant sleeps so spawn health-wait loops are deterministic. */
function fakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

/** Deps bundle for lifecycle tests: health is a controllable flag, spawn is
 *  recorded (and optionally flips health, like a real daemon coming up). */
function harness(opts = {}) {
  const clock = fakeClock();
  let healthy = false;
  const spawns = [];
  return {
    clock,
    setHealthy: (v) => { healthy = v; },
    spawns,
    deps: {
      probe: async () => healthy,
      spawnDaemon: (entry) => { spawns.push(entry); opts.onSpawn?.(); },
      now: clock.now,
      sleep: () => Promise.resolve(),
    },
  };
}

test("ensureSessionDaemonStarted re-probes every call — a daemon that dies after attach is respawned on the next call", async () => {
  resetSidecarStateForTest();
  const h = harness({ onSpawn: () => h.setHealthy(true) });
  h.setHealthy(true);
  assert.equal(await ensureSessionDaemonStarted(h.deps), "attached");
  // The daemon dies AFTER a successful attach — the next call must notice and
  // respawn instead of trusting a cached "started" promise (regression: a
  // crashed daemon left every session route 500ing until a manual restart).
  h.setHealthy(false);
  assert.equal(await ensureSessionDaemonStarted(h.deps), "spawned");
  assert.equal(h.spawns.length, 1);
  // Healthy again → plain attach, no extra spawns.
  assert.equal(await ensureSessionDaemonStarted(h.deps), "attached");
  assert.equal(h.spawns.length, 1);
  resetSidecarStateForTest();
});

test("ensureSessionDaemonStarted shares one spawn attempt across concurrent callers", async () => {
  resetSidecarStateForTest();
  const h = harness({ onSpawn: () => h.setHealthy(true) });
  const results = await Promise.all([
    ensureSessionDaemonStarted(h.deps),
    ensureSessionDaemonStarted(h.deps),
    ensureSessionDaemonStarted(h.deps),
  ]);
  assert.deepEqual(results, ["spawned", "spawned", "spawned"]);
  assert.equal(h.spawns.length, 1);
  resetSidecarStateForTest();
});

test("ensureSessionDaemonStarted retries a failed spawn once the cooldown elapses", async () => {
  resetSidecarStateForTest();
  const clock = fakeClock();
  let failSpawns = true;
  const spawns = [];
  const deps = {
    probe: async () => false, // never healthy — spawn is the only path through
    spawnDaemon: (entry) => { spawns.push(entry); },
    now: clock.now,
    // Sleeping advances the fake clock, like real time — otherwise the
    // health-wait loop would spin forever on a frozen clock.
    sleep: (ms) => { clock.advance(ms); return Promise.resolve(); },
    spawnHealthTimeoutMs: 100,
    spawnRetryCooldownMs: 10_000,
  };
  // First attempt: spawned daemon never gets healthy → error.
  await assert.rejects(ensureSessionDaemonStarted(deps), /did not become healthy/);
  assert.equal(spawns.length, 1);
  // Immediate retry within the cooldown: fail fast, no new spawn.
  await assert.rejects(ensureSessionDaemonStarted(deps), /did not become healthy/);
  assert.equal(spawns.length, 1);
  // After the cooldown the next caller retries.
  clock.advance(10_001);
  await assert.rejects(ensureSessionDaemonStarted(deps), /did not become healthy/);
  assert.equal(spawns.length, 2);
  resetSidecarStateForTest();
});

test("decideSidecarAction attaches to a healthy daemon instead of spawning", () => {
  assert.deepEqual(decideSidecarAction(true), { kind: "attach" });
});

test("decideSidecarAction spawns only when the daemon is not healthy", () => {
  assert.deepEqual(decideSidecarAction(false), { kind: "spawn" });
});

test("spawnableDaemonUrl accepts local addresses only", () => {
  assert.equal(spawnableDaemonUrl("http://127.0.0.1:30142"), true);
  assert.equal(spawnableDaemonUrl("http://localhost:30142"), true);
  assert.equal(spawnableDaemonUrl("http://[::1]:30142"), true);
});

test("spawnableDaemonUrl rejects remote or non-http daemon addresses", () => {
  // A PI_LOOP_URL pointing elsewhere means the daemon is managed on another
  // machine — the local web process must never spawn a sidecar for it.
  assert.equal(spawnableDaemonUrl("http://10.0.0.5:30142"), false);
  assert.equal(spawnableDaemonUrl("https://loop.example.com"), false);
  assert.equal(spawnableDaemonUrl("not a url"), false);
});

test("sidecarSpawnEnv translates the daemon URL into the bind address", () => {
  // URL-only configuration: the spawned daemon must listen where the web
  // client will probe, not on the default 30142.
  const env = sidecarSpawnEnv("http://127.0.0.1:33198", {});
  assert.equal(env.PI_DAEMON_HOST, "127.0.0.1");
  assert.equal(env.PI_DAEMON_PORT, "33198");
});

test("sidecarSpawnEnv keeps explicit PI_DAEMON_HOST/PI_DAEMON_PORT over the URL", () => {
  const env = sidecarSpawnEnv("http://127.0.0.1:33198", { PI_DAEMON_PORT: "45555", PI_DAEMON_HOST: "localhost" });
  assert.equal(env.PI_DAEMON_PORT, "45555");
  assert.equal(env.PI_DAEMON_HOST, "localhost");
});

test("sidecarSpawnEnv honors legacy PI_LOOP_HOST/PI_LOOP_PORT spellings", () => {
  const env = sidecarSpawnEnv("http://127.0.0.1:33198", { PI_LOOP_PORT: "45555", PI_LOOP_HOST: "localhost" });
  assert.equal(env.PI_DAEMON_PORT, "45555");
  assert.equal(env.PI_DAEMON_HOST, "localhost");
});

test("sidecarSpawnEnv unbrackets IPv6 loopback hostnames", () => {
  const env = sidecarSpawnEnv("http://[::1]:33198", {});
  assert.equal(env.PI_DAEMON_HOST, "::1");
});
