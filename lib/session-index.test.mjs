import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

// Each test points PI_CODING_AGENT_DIR at a fresh tmp dir (getAgentDir honors
// it) so the index under test is fully isolated from the real ~/.pi/agent.
// PI_SESSION_INDEX_MEMO_TTL_MS=0 disables the in-process memo: every ensure
// re-walks, which is exactly the "fresh session file must be visible" seam.
process.env.PI_SESSION_INDEX_MEMO_TTL_MS = "0";
const { ensureSessionIndex, findSessionIndexEntry, invalidateSessionIndexMemory } =
  await jiti.import("./session-index.ts");

// Mirrors the module's FIRST_MESSAGE_MAX_CHARS — the tests assert that the
// skill reduction happens BEFORE this clip, so wrappers must exceed it.
const FIRST_MESSAGE_MAX_CHARS = 400;

function withTmpAgentDir(fn) {
  return async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-session-index-test-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    mkdirSync(join(dir, "sessions"), { recursive: true });
    invalidateSessionIndexMemory();
    try {
      await fn(t, join(dir, "sessions"));
    } finally {
      invalidateSessionIndexMemory();
      delete process.env.PI_CODING_AGENT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function writeSessionFile(sessionsDir, id, opts = {}) {
  const cwdDir = join(sessionsDir, "--tmp-proj--");
  mkdirSync(cwdDir, { recursive: true });
  const file = join(cwdDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/proj" }),
    ...opts.extraLines ?? [JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello first message" } })],
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("a session file created after the first ensure becomes visible on the next ensure",
  withTmpAgentDir(async (_t, sessionsDir) => {
    writeSessionFile(sessionsDir, "11111111-1111-4111-8111-111111111111");
    const first = await ensureSessionIndex();
    assert.equal(first.length, 1);

    // A subagent child spawned by the daemon AFTER the web process built its
    // snapshot — historically invisible until a process restart.
    writeSessionFile(sessionsDir, "22222222-2222-4222-8222-222222222222");
    const second = await ensureSessionIndex();
    assert.equal(second.length, 2, "fresh .jsonl must appear without a process restart");
    const found = await findSessionIndexEntry("22222222-2222-4222-8222-222222222222");
    assert.ok(found, "locate-by-id must resolve the fresh session");
    assert.equal(found.firstMessage, "hello first message");
  }));

test("changes to an existing session file are picked up on re-walk",
  withTmpAgentDir(async (_t, sessionsDir) => {
    const id = "33333333-3333-4333-8333-333333333333";
    writeSessionFile(sessionsDir, id);
    await ensureSessionIndex();
    assert.equal((await findSessionIndexEntry(id)).messageCount, 1);

    // Append two more messages (an active session grows while being viewed).
    writeSessionFile(sessionsDir, id, {
      extraLines: [
        JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello first message" } }),
        JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
        JSON.stringify({ type: "message", id: "m3", parentId: "m2", message: { role: "user", content: "follow up" } }),
      ],
    });
    const entries = await ensureSessionIndex();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageCount, 3, "re-walk must re-parse the changed file");
  }));

test("a /skill: expansion is reduced to its arguments before truncation",
  withTmpAgentDir(async (_t, sessionsDir) => {
    const id = "55555555-5555-4555-8555-555555555555";
    // Realistic shape: multi-KB SKILL.md body, user args only AFTER </skill> —
    // a naive 400-char clip lands mid-body and buries the args.
    const wrapper = [
      `<skill name="dev-loop" location="/ws/.agents/skills/dev-loop/SKILL.md">`,
      `References are relative to /ws/.agents/skills/dev-loop.`,
      ``,
      `# Dev Loop`.padEnd(FIRST_MESSAGE_MAX_CHARS + 200, "…"),
      `</skill>`,
      ``,
      `执行 REQ-0123`,
    ].join("\n");
    writeSessionFile(sessionsDir, id, {
      extraLines: [JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: wrapper } })],
    });
    const entries = await ensureSessionIndex();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].firstMessage, "执行 REQ-0123");
  }));

test("a /skill: expansion without arguments reduces to the command form",
  withTmpAgentDir(async (_t, sessionsDir) => {
    const id = "66666666-6666-4666-8666-666666666666";
    const wrapper = [
      `<skill name="grilling" location="/a/.pi/agent/skills/grilling/SKILL.md">`,
      `References are relative to /a/.pi/agent/skills/grilling.`,
      ``,
      `Interview me relentlessly.`.padEnd(FIRST_MESSAGE_MAX_CHARS + 100, "…"),
      `</skill>`,
    ].join("\n");
    writeSessionFile(sessionsDir, id, {
      extraLines: [JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: wrapper } })],
    });
    const entries = await ensureSessionIndex();
    assert.equal(entries[0].firstMessage, "/skill:grilling");
  }));

test("deleted session files drop out of the index on re-walk",
  withTmpAgentDir(async (_t, sessionsDir) => {
    const id = "44444444-4444-4444-8444-444444444444";
    const file = writeSessionFile(sessionsDir, id);
    await ensureSessionIndex();
    rmSync(file);
    const entries = await ensureSessionIndex();
    assert.equal(entries.length, 0, "deleted file must leave the index");
  }));
