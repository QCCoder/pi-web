import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionSubagents } from "./session-subagents.ts";

function toolResult(toolCallId, details) {
  return {
    role: "toolResult",
    toolCallId,
    content: [],
    details,
  };
}

function delegateDetails(entries) {
  return { mode: "single", entries };
}

test("collects entries with session ids, dedup by id keeping latest status, most-recent-first", () => {
  const messages = [
    toolResult("tc-1", delegateDetails([
      { id: "e1", index: 0, role: "implementer", status: "running", session: { id: "pi-subagent-aaa", cwd: "/w/one" } },
    ])),
    toolResult("tc-2", delegateDetails([
      { id: "e2", index: 0, role: "reviewer", status: "succeeded", summary: "LGTM", session: { id: "pi-subagent-bbb", cwd: "/w/two" } },
      { id: "e1", index: 0, role: "implementer", status: "succeeded", summary: "done", session: { id: "pi-subagent-aaa", cwd: "/w/one" } },
    ])),
  ];
  const subs = deriveSessionSubagents(messages);
  assert.deepEqual(
    subs.map((s) => [s.id, s.role, s.status, s.summary]),
    [
      ["pi-subagent-aaa", "implementer", "succeeded", "done"],
      ["pi-subagent-bbb", "reviewer", "succeeded", "LGTM"],
    ],
  );
  assert.equal(subs[0].cwd, "/w/one");
});

test("entries without session, malformed shapes, and non-toolResult messages are ignored", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", model: "m", provider: "p", content: [{ type: "toolCall", toolCallId: "tc-x", toolName: "delegate_task", input: {} }] },
    toolResult("tc-x", delegateDetails([
      { id: "e1", index: 0, role: "implementer", status: "succeeded" }, // no session
      { id: "e2", index: 1, role: "reviewer", status: "succeeded", session: { cwd: "/w" } }, // no id
      null, // eslint-disable-line no-null/no-null
      "junk",
    ])),
    toolResult("tc-y", "details-is-a-string"),
    toolResult("tc-z", { entries: "not-an-array" }),
  ];
  assert.deepEqual(deriveSessionSubagents(messages), []);
});

test("streaming partials contribute and win recency over persisted results", () => {
  const messages = [
    toolResult("tc-1", delegateDetails([
      { id: "e1", index: 0, role: "implementer", status: "succeeded", session: { id: "pi-subagent-old", cwd: "/w" } },
    ])),
  ];
  const streaming = new Map([
    ["tc-2", toolResult("tc-2", delegateDetails([
      { id: "e2", index: 0, role: "checker", status: "running", summary: "halfway", session: { id: "pi-subagent-live", cwd: "/w/live" } },
    ]))],
  ]);
  const subs = deriveSessionSubagents(messages, { streamingToolResults: streaming });
  assert.deepEqual(
    subs.map((s) => [s.id, s.status]),
    [
      ["pi-subagent-live", "running"],
      ["pi-subagent-old", "succeeded"],
    ],
  );
});

test("unknown status values fall back to pending; missing role falls back to agent", () => {
  const messages = [
    toolResult("tc-1", delegateDetails([
      { id: "e1", index: 0, status: "weird-future-status", session: { id: "pi-subagent-x" } },
    ])),
  ];
  const subs = deriveSessionSubagents(messages);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].status, "pending");
  assert.equal(subs[0].role, "agent");
  assert.equal(subs[0].summary, undefined);
  assert.equal(subs[0].cwd, undefined);
});
