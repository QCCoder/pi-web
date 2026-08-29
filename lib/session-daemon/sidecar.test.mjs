import assert from "node:assert/strict";
import test from "node:test";
import { decideSidecarAction, sidecarSpawnEnv, spawnableDaemonUrl } from "./sidecar.ts";

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
