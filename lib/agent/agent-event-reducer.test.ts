/**
 * agent-event-reducer.test.ts
 *
 * 用 node 内置 test runner（Node 22+，零新增依赖）+ jiti 加载 TS 验证 applyAgentEvent。
 * 运行：node --import jiti/register --test lib/agent/agent-event-reducer.test.ts
 *
 * 覆盖原 handleAgentEvent 的全部分支，逐一对比语义：流式累积、tool 解析、tool phase
 * 转移、result 匹配、compaction 新老事件名、晚到事件 guard、乐观气泡去重、
 * extension_ui_request 的 runtime 更新 vs effect、引用稳定性。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage, AssistantMessage, UserMessage } from "../types";
import { applyAgentEvent, type AgentEventCtx } from "./agent-event-reducer";
import type { AgentEvent } from "./agent-types";
import { createDefaultSessionRuntimeState, type SessionRuntimeState } from "../stores/session-runtime-store";
import { userMessageKey } from "./agent-event-helpers";

const SID = "s1";
const ctx = (messages: AgentMessage[] = []): AgentEventCtx => ({ sessionId: SID, messages });

function assistantText(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p" };
}

function runningPrev(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  return { ...createDefaultSessionRuntimeState(), agentRunning: true, ...overrides };
}

interface Step {
  rt: SessionRuntimeState;
  msgs: AgentMessage[];
  res: ReturnType<typeof applyAgentEvent>;
}

/** 跑一个事件并把结果 fold 进 (rt, msgs)。 */
function step(rt: SessionRuntimeState, msgs: AgentMessage[], event: AgentEvent): Step {
  const res = applyAgentEvent(rt, event, ctx(msgs));
  return { rt: res.runtime, msgs: res.messages ?? msgs, res };
}

describe("applyAgentEvent — run lifecycle", () => {
  it("agent_start sets running + waiting_model + streaming, no effects", () => {
    const prev = createDefaultSessionRuntimeState();
    const res = applyAgentEvent(prev, { type: "agent_start" }, ctx());
    assert.equal(res.runtime.agentRunning, true);
    assert.deepEqual(res.runtime.agentPhase, { kind: "waiting_model" });
    assert.equal(res.runtime.streamState.isStreaming, true);
    assert.equal(res.runtime.streamState.streamingMessage, null);
    assert.equal(res.messages, undefined);
    assert.deepEqual(res.effects, []);
    assert.notEqual(res.runtime, prev);
  });

  it("full assistant turn chains through phases", () => {
    let rt = createDefaultSessionRuntimeState();
    let msgs: AgentMessage[] = [];

    ({ rt } = step(rt, msgs, { type: "agent_start" }));
    assert.equal(rt.agentRunning, true);

    // message_update: streaming text lands in streamingMessage, agentPhase cleared
    ({ rt } = step(rt, msgs, { type: "message_update", message: assistantText("Hello") }));
    assert.equal(rt.streamState.isStreaming, true);
    assert.deepEqual(rt.streamState.streamingMessage, assistantText("Hello"));
    assert.equal(rt.agentPhase, null);

    // tool_execution_start
    ({ rt } = step(rt, msgs, { type: "tool_execution_start", toolCallId: "t1", toolName: "read" }));
    assert.deepEqual(rt.agentPhase, { kind: "running_tools", tools: [{ id: "t1", name: "read" }] });

    // tool_execution_end → empty tools → waiting_model
    ({ rt } = step(rt, msgs, { type: "tool_execution_end", toolCallId: "t1" }));
    assert.deepEqual(rt.agentPhase, { kind: "waiting_model" });

    // message_end assistant: append + reset stream
    const completed = assistantText("Hello world");
    let s = step(rt, msgs, { type: "message_end", message: completed });
    rt = s.rt;
    msgs = s.msgs;
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], completed);
    assert.equal(rt.streamState.isStreaming, false);
    assert.deepEqual(rt.agentPhase, { kind: "waiting_model" });

    // agent_end: stop + effects (order sensitive)
    s = step(rt, msgs, { type: "agent_end" });
    assert.equal(s.rt.agentRunning, false);
    assert.deepEqual(s.rt.agentPhase, null);
    assert.equal(s.rt.retryInfo, null);
    assert.deepEqual(s.res.effects.map((e) => e.kind), ["reloadSession", "refreshAgentState", "onAgentEnd"]);
  });

  it("normalizes pi toolCall fields ({id,name,arguments}) to UI fields in streaming", () => {
    const event: AgentEvent = {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
        model: "m",
        provider: "p",
      },
    };
    const res = applyAgentEvent(runningPrev(), event, ctx());
    const block = (res.runtime.streamState.streamingMessage as AssistantMessage).content[0] as {
      toolCallId: string;
      toolName: string;
      input: unknown;
    };
    assert.equal(block.toolCallId, "tc1");
    assert.equal(block.toolName, "read");
    assert.deepEqual(block.input, { path: "a.ts" });
  });

  it("multiple tool_execution_start accumulate; end removes only the matching id", () => {
    let rt = createDefaultSessionRuntimeState();
    ({ rt } = step(rt, [], { type: "agent_start" }));
    ({ rt } = step(rt, [], { type: "tool_execution_start", toolCallId: "a", toolName: "ra" }));
    ({ rt } = step(rt, [], { type: "tool_execution_start", toolCallId: "b", toolName: "rb" }));
    assert.deepEqual(
      rt.agentPhase,
      { kind: "running_tools", tools: [{ id: "a", name: "ra" }, { id: "b", name: "rb" }] },
    );
    ({ rt } = step(rt, [], { type: "tool_execution_end", toolCallId: "a" }));
    assert.deepEqual(rt.agentPhase, { kind: "running_tools", tools: [{ id: "b", name: "rb" }] });
    // duplicate start does not double-add
    ({ rt } = step(rt, [], { type: "tool_execution_start", toolCallId: "b", toolName: "rb" }));
    assert.deepEqual(rt.agentPhase, { kind: "running_tools", tools: [{ id: "b", name: "rb" }] });
  });

  it("tool_execution_update without a prior start promotes phase to running_tools (mid-run joiner)", () => {
    // daemon 持有的会话（如 kit 轮）在 subagent 运行中途被打开：观看者没收到
    // tool_execution_start，只看到 subagent 流出的 partial —— 据此升级 phase，
    // 否则整个 subagent 运行期间 phase 停在 waiting_model（「思考中」）。
    const withToolCall: AgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "sub1", toolName: "subagent", input: { agent: "brainstorm" } }],
      model: "m",
      provider: "p",
    };
    const res = applyAgentEvent(
      runningPrev(),
      { type: "tool_execution_update", toolCallId: "sub1", partialResult: { content: [{ type: "text", text: "running" }] } },
      ctx([withToolCall]),
    );
    assert.deepEqual(res.runtime.agentPhase, { kind: "running_tools", tools: [{ id: "sub1", name: "subagent" }] });
    assert.deepEqual(res.runtime.toolExecutionUpdates["sub1"], {
      toolCallId: "sub1",
      content: [{ type: "text", text: "running" }],
      details: undefined,
    });
    // 后续的 tool_execution_end 正常收回 waiting_model。
    const res2 = applyAgentEvent(res.runtime, { type: "tool_execution_end", toolCallId: "sub1" }, ctx([withToolCall]));
    assert.deepEqual(res2.runtime.agentPhase, { kind: "waiting_model" });
  });

  it("tool_execution_update keeps an existing running_tools phase untouched (no dup)", () => {
    const prev = runningPrev({ agentPhase: { kind: "running_tools", tools: [{ id: "t9", name: "bash" }] } });
    const res = applyAgentEvent(
      prev,
      { type: "tool_execution_update", toolCallId: "t9", partialResult: { content: [{ type: "text", text: "x" }] } },
      ctx(),
    );
    assert.deepEqual(res.runtime.agentPhase, { kind: "running_tools", tools: [{ id: "t9", name: "bash" }] });
  });

  it("tool_execution_update with unknown toolCallId falls back to generic name", () => {
    const res = applyAgentEvent(
      runningPrev(),
      { type: "tool_execution_update", toolCallId: "ghost", partialResult: { content: [{ type: "text", text: "x" }] } },
      ctx(),
    );
    assert.deepEqual(res.runtime.agentPhase, { kind: "running_tools", tools: [{ id: "ghost", name: "tool" }] });
  });
});

describe("applyAgentEvent — late-event guards & reference stability", () => {
  it("message_update after run ended is a no-op (same ref)", () => {
    const prev = createDefaultSessionRuntimeState(); // agentRunning = false
    const res = applyAgentEvent(prev, { type: "message_update", message: assistantText("x") }, ctx());
    assert.equal(res.runtime, prev);
    assert.equal(res.messages, undefined);
    assert.deepEqual(res.effects, []);
  });

  it("message_end after run ended is a no-op (no duplicate append)", () => {
    const prev = createDefaultSessionRuntimeState();
    const res = applyAgentEvent(prev, { type: "message_end", message: assistantText("x") }, ctx([assistantText("a")]));
    assert.equal(res.runtime, prev);
    assert.equal(res.messages, undefined);
  });

  it("agent_end when already idle does not re-trigger completion", () => {
    const prev = createDefaultSessionRuntimeState();
    const res = applyAgentEvent(prev, { type: "agent_end" }, ctx());
    assert.equal(res.runtime, prev);
    assert.deepEqual(res.effects, []);
  });

  it("prompt_done when idle is a no-op", () => {
    const prev = createDefaultSessionRuntimeState();
    const res = applyAgentEvent(prev, { type: "prompt_done" }, ctx());
    assert.equal(res.runtime, prev);
    assert.deepEqual(res.effects, []);
  });

  it("prompt_done while running emits finishPromptWithoutStream only", () => {
    const prev = runningPrev();
    const res = applyAgentEvent(prev, { type: "prompt_done" }, ctx());
    assert.deepEqual(res.effects, [{ kind: "finishPromptWithoutStream" }]);
    assert.equal(res.runtime, prev, "prompt_done does not change runtime");
  });

  it("unrecognized event returns prev unchanged", () => {
    const prev = runningPrev();
    const res = applyAgentEvent(prev, { type: "totally_unknown" }, ctx());
    assert.equal(res.runtime, prev);
    assert.equal(res.messages, undefined);
    assert.deepEqual(res.effects, []);
  });
});

describe("applyAgentEvent — optimistic user bubble reconciliation", () => {
  it("dedups when delivered user message matches the optimistic key", () => {
    const optimistic: UserMessage = { role: "user", content: "hi" };
    const prev = runningPrev({ optimisticUserMessageKey: userMessageKey(optimistic) });
    const res = applyAgentEvent(prev, { type: "message_end", message: optimistic }, ctx([optimistic]));
    assert.equal(res.messages, undefined, "identical optimistic bubble → messages unchanged (bailout)");
    assert.equal(res.runtime.optimisticUserMessageKey, null, "optimistic key consumed");
  });

  it("replaces the optimistic bubble when delivered text differs", () => {
    const optimistic: UserMessage = { role: "user", content: "draft" };
    const delivered: UserMessage = { role: "user", content: "final" };
    const prev = runningPrev({ optimisticUserMessageKey: userMessageKey(optimistic) });
    const res = applyAgentEvent(prev, { type: "message_end", message: delivered }, ctx([optimistic]));
    assert.equal(res.messages?.length, 1);
    assert.deepEqual(res.messages?.[0], delivered);
    assert.equal(res.runtime.optimisticUserMessageKey, null);
  });

  it("appends delivered user message when there is no optimistic key", () => {
    const delivered: UserMessage = { role: "user", content: "queue msg" };
    const prev = runningPrev();
    const res = applyAgentEvent(prev, { type: "message_end", message: delivered }, ctx([]));
    assert.equal(res.messages?.length, 1);
    assert.deepEqual(res.messages?.[0], delivered);
  });

  it("ignores message_update whose message is a user role (steering etc.)", () => {
    const prev = runningPrev();
    const res = applyAgentEvent(prev, { type: "message_update", message: { role: "user", content: "x" } }, ctx());
    assert.equal(res.runtime, prev, "user-role update leaves runtime untouched");
  });
});

describe("applyAgentEvent — compaction (new + legacy event names)", () => {
  it("compaction_start / compaction_end success", () => {
    let rt = createDefaultSessionRuntimeState();
    ({ rt } = step(rt, [], { type: "compaction_start" }));
    assert.equal(rt.isCompacting, true);
    assert.equal(rt.compactError, null);
    assert.equal(rt.compactResult, null);
    const res = applyAgentEvent(
      rt,
      { type: "compaction_end", result: { tokensBefore: 100, estimatedTokensAfter: 20 }, reason: "manual" },
      ctx(),
    );
    assert.equal(res.runtime.isCompacting, false);
    assert.deepEqual(res.runtime.compactResult, { reason: "manual", tokensBefore: 100, estimatedTokensAfter: 20 });
    assert.deepEqual(res.effects.map((e) => e.kind), ["reloadSession"]);
  });

  it("auto_compaction_* legacy names behave the same", () => {
    let rt = createDefaultSessionRuntimeState();
    ({ rt } = step(rt, [], { type: "auto_compaction_start" }));
    assert.equal(rt.isCompacting, true);
    const res = applyAgentEvent(
      rt,
      { type: "auto_compaction_end", result: { tokensBefore: 50, estimatedTokensAfter: 10 } },
      ctx(),
    );
    assert.equal(res.runtime.compactResult?.reason, "auto");
    assert.equal(res.runtime.compactResult?.tokensBefore, 50);
  });

  it("compaction_end error sets compactError and skips reload", () => {
    const prev = runningPrev({ isCompacting: true });
    const res = applyAgentEvent(prev, { type: "compaction_end", errorMessage: "boom" }, ctx());
    assert.equal(res.runtime.isCompacting, false);
    assert.equal(res.runtime.compactError, "boom");
    assert.equal(res.runtime.compactResult, null);
    assert.deepEqual(res.effects, []);
  });

  it("compaction_end aborted only clears isCompacting", () => {
    const prev = runningPrev({ isCompacting: true });
    const res = applyAgentEvent(prev, { type: "compaction_end", aborted: true }, ctx());
    assert.equal(res.runtime.isCompacting, false);
    assert.equal(res.runtime.compactResult, null);
    assert.deepEqual(res.effects, []);
  });
});

describe("applyAgentEvent — queue & retry", () => {
  it("queue_update sets steering + followUp", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "queue_update", steering: ["s1"], followUp: ["f1"] }, ctx());
    assert.deepEqual(res.runtime.queuedMessages, { steering: ["s1"], followUp: ["f1"] });
  });

  it("auto_retry_start / auto_retry_end", () => {
    let rt = createDefaultSessionRuntimeState();
    ({ rt } = step(rt, [], { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "err" }));
    assert.deepEqual(rt.retryInfo, { attempt: 1, maxAttempts: 3, errorMessage: "err" });
    ({ rt } = step(rt, [], { type: "auto_retry_end" }));
    assert.equal(rt.retryInfo, null);
  });
});

describe("applyAgentEvent — extension_ui_request", () => {
  it("setStatus adds/updates a status into runtime.extensionStatuses", () => {
    const res = applyAgentEvent(
      createDefaultSessionRuntimeState(),
      { type: "extension_ui_request", id: "r1", method: "setStatus", statusKey: "k", statusText: "running" },
      ctx(),
    );
    assert.deepEqual(res.runtime.extensionStatuses, [{ key: "k", text: "running" }]);
  });

  it("setStatus with undefined text removes the status", () => {
    const prev = runningPrev({ extensionStatuses: [{ key: "k", text: "running" }] });
    const res = applyAgentEvent(prev, { type: "extension_ui_request", id: "r1", method: "setStatus", statusKey: "k", statusText: undefined }, ctx());
    assert.deepEqual(res.runtime.extensionStatuses, []);
  });

  it("setWidget adds a widget with default placement", () => {
    const res = applyAgentEvent(
      createDefaultSessionRuntimeState(),
      { type: "extension_ui_request", id: "r1", method: "setWidget", widgetKey: "w", widgetLines: ["a", "b"] },
      ctx(),
    );
    assert.deepEqual(res.runtime.extensionWidgets, [{ key: "w", lines: ["a", "b"], placement: "aboveEditor" }]);
  });

  it("notify emits addNotice effect with id (no runtime change)", () => {
    const prev = createDefaultSessionRuntimeState();
    const res = applyAgentEvent(prev, { type: "extension_ui_request", id: "n1", method: "notify", message: "hi", notifyType: "warning" }, ctx());
    assert.equal(res.runtime, prev);
    assert.deepEqual(res.effects, [{ kind: "addNotice", id: "n1", message: "hi", type: "warning" }]);
  });

  it("select emits setExtensionDialog effect", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"] }, ctx());
    assert.equal(res.effects.length, 1);
    assert.equal(res.effects[0].kind, "setExtensionDialog");
  });

  it("setTitle emits setDocumentTitle effect", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "extension_ui_request", id: "t1", method: "setTitle", title: "New Title" }, ctx());
    assert.deepEqual(res.effects, [{ kind: "setDocumentTitle", title: "New Title" }]);
  });

  it("set_editor_text emits editorInsertText effect", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "hello" }, ctx());
    assert.deepEqual(res.effects, [{ kind: "editorInsertText", text: "hello" }]);
  });

  it("custom emits resolveExtensionCustomUi effect (caller merges closed state)", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "extension_ui_request", id: "c1", method: "custom", lines: ["x"] }, ctx());
    assert.equal(res.effects.length, 1);
    assert.equal(res.effects[0].kind, "resolveExtensionCustomUi");
  });
});

describe("applyAgentEvent — prompt / extension errors", () => {
  it("prompt_error emits error notice with fallback message", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "prompt_error" }, ctx());
    assert.deepEqual(res.effects, [{ kind: "addNotice", type: "error", message: "Command failed" }]);
  });

  it("extension_error emits error notice with fallback message", () => {
    const res = applyAgentEvent(createDefaultSessionRuntimeState(), { type: "extension_error" }, ctx());
    assert.deepEqual(res.effects, [{ kind: "addNotice", type: "error", message: "Extension command failed" }]);
  });
});
