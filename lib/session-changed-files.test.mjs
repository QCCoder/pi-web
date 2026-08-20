import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionChangedFiles, isEditToolName } from "./session-changed-files.ts";

function assistant(toolCalls) {
  return {
    role: "assistant",
    model: "m",
    provider: "p",
    content: toolCalls.map(([toolName, input], i) => ({
      type: "toolCall",
      toolCallId: `tc-${toolName}-${i}`,
      toolName,
      input,
    })),
  };
}

function subagentResult(toolCallId, items) {
  return {
    role: "toolResult",
    toolCallId,
    content: [],
    details: {
      mode: "single",
      results: [
        {
          agent: "general",
          status: "completed",
          displayItems: items.map((item, i) =>
            item.type === "toolCall"
              ? { type: "toolCall", name: item.name, args: item.args ?? { file_path: `/w/f${i}.txt` } }
              : item,
          ),
        },
      ],
    },
  };
}

test("collects write and edit tool calls with dedup, count, and most-recent-first order", () => {
  const messages = [
    assistant([
      ["write", { file_path: "/w/first.md" }],
      ["edit", { file_path: "/w/second.md" }],
    ]),
    assistant([["edit", { file_path: "/w/first.md" }]]),
  ];
  const files = deriveSessionChangedFiles(messages);
  assert.deepEqual(
    files.map((f) => [f.filePath, f.kind, f.count]),
    [
      ["/w/first.md", "edit", 2],
      ["/w/second.md", "edit", 1],
    ],
  );
});

test("write kind reflects the most recent touch", () => {
  const messages = [
    assistant([
      ["edit", { file_path: "/w/a.md" }],
      ["write", { file_path: "/w/a.md" }],
    ]),
  ];
  assert.deepEqual(deriveSessionChangedFiles(messages), [
    { filePath: "/w/a.md", kind: "write", count: 2 },
  ]);
});

test("counts edit tool-name variants (str_replace, replace_editor, edit_*)", () => {
  assert.ok(isEditToolName("str_replace_editor"));
  assert.ok(isEditToolName("Edit_File"));
  assert.ok(!isEditToolName("write"));
  const messages = [
    assistant([
      ["str_replace_based_edit", { file_path: "/w/v1.md" }],
      ["replace_editor", { path: "/w/v2.md" }],
    ]),
  ];
  const files = deriveSessionChangedFiles(messages);
  assert.deepEqual(files.map((f) => f.kind), ["edit", "edit"]);
});

test("ignores read, bash, git-commit and pathless tool calls", () => {
  const messages = [
    assistant([
      ["read", { file_path: "/w/read-only.md" }],
      ["bash", { command: "git commit -am x" }],
      ["bash", { command: "cat > /w/sneaky.md <<EOF" }],
      ["edit", {}],
      ["write", { file_path: "" }],
      ["write", { file_path: 42 }],
    ]),
  ];
  assert.deepEqual(deriveSessionChangedFiles(messages), []);
});

test("collects subagent displayItems write/edit from finalized result details", () => {
  const messages = [
    assistant([["subagent", { agent: "general", task: "t" }]]),
    subagentResult("tc-subagent-0", [
      { type: "text", text: "working" },
      { type: "toolCall", name: "write", args: { file_path: "/w/child-new.ts" } },
      { type: "toolCall", name: "edit", args: { file_path: "/w/child-edit.ts" } },
      { type: "toolCall", name: "bash", args: { command: "npm test" } },
    ]),
  ];
  const files = deriveSessionChangedFiles(messages);
  assert.deepEqual(
    files.map((f) => [f.filePath, f.kind]),
    [
      ["/w/child-edit.ts", "edit"],
      ["/w/child-new.ts", "write"],
    ],
  );
});

test("counts live partial results but not once finalized (toolCallId dedup)", () => {
  const finalized = subagentResult("tc-1", [
    { type: "toolCall", name: "write", args: { file_path: "/w/final.ts" } },
  ]);
  const partialSame = subagentResult("tc-1", [
    { type: "toolCall", name: "write", args: { file_path: "/w/final.ts" } },
  ]);
  const partialLive = subagentResult("tc-2", [
    { type: "toolCall", name: "edit", args: { file_path: "/w/live.ts" } },
  ]);

  // While streaming: finalized one + the still-live partial both count.
  const during = deriveSessionChangedFiles([assistant([["subagent", {}]]), finalized], {
    partialResults: [partialSame, partialLive],
  });
  assert.deepEqual(
    during.map((f) => [f.filePath, f.count]),
    [
      ["/w/live.ts", 1],
      ["/w/final.ts", 1],
    ],
  );
});

test("counts the streaming message's tool calls immediately", () => {
  const files = deriveSessionChangedFiles([], {
    streamingMessage: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "tc-x", toolName: "edit", input: { file_path: "/w/inflight.md" } }],
    },
  });
  assert.deepEqual(files, [{ filePath: "/w/inflight.md", kind: "edit", count: 1 }]);
});

test("resolves relative file_path args against the session cwd", () => {
  const messages = [
    assistant([["edit", { file_path: "components/ChatInput.tsx" }]]),
  ];
  const files = deriveSessionChangedFiles(messages, { cwd: "/w/pi-web" });
  assert.deepEqual(files.map((f) => f.filePath), ["/w/pi-web/components/ChatInput.tsx"]);
});

test("dedupes a relative tool-call path against its absolute twin", () => {
  const messages = [
    assistant([
      ["edit", { file_path: "lib/a.ts" }],
      ["write", { file_path: "/w/pi-web/lib/a.ts" }],
    ]),
  ];
  const files = deriveSessionChangedFiles(messages, { cwd: "/w/pi-web" });
  assert.deepEqual(files, [{ filePath: "/w/pi-web/lib/a.ts", kind: "write", count: 2 }]);
});

test("collapses dot segments and keeps relative paths when no cwd is provided", () => {
  const messages = [assistant([["edit", { file_path: "./src/../lib/a.ts" }]])];
  assert.deepEqual(
    deriveSessionChangedFiles(messages, { cwd: "/w" }).map((f) => f.filePath),
    ["/w/lib/a.ts"],
  );
  assert.deepEqual(
    deriveSessionChangedFiles(messages).map((f) => f.filePath),
    ["lib/a.ts"],
  );
});

test("ignores malformed details shapes without throwing", () => {
  const messages = [
    { role: "toolResult", toolCallId: "tc-bad", content: [], details: { results: "not-an-array" } },
    { role: "toolResult", toolCallId: "tc-null", content: [], details: null },
    { role: "toolResult", toolCallId: "tc-items", content: [], details: { results: [{ displayItems: [null, 42, { type: "text", text: "hi" }] }] } },
  ];
  assert.deepEqual(deriveSessionChangedFiles(messages), []);
});
