import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, ThinkingBlock, formatMessageBytes } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

// Just over the guard: skips the markdown pipeline but keeps the message body.
const OVERSIZED = "x".repeat(101 * 1000);

function renderMessage(message) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(MessageView, { message })),
  );
}

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("formats message sizes for the oversized-content notice", () => {
  assert.equal(formatMessageBytes(512), "512 B");
  assert.equal(formatMessageBytes(101_000), "101 KB");
  assert.equal(formatMessageBytes(2_500_000), "2.5 MB");
});

test("an oversized user message renders as a click-to-reveal notice, not markdown", () => {
  const html = renderMessage({ role: "user", content: OVERSIZED, timestamp: 1 });

  assert.match(html, /⚠/);
  assert.match(html, /101 KB/);
  // The raw payload must not be painted anywhere before the user opts in.
  assert.doesNotMatch(html, new RegExp(OVERSIZED.slice(0, 64)));
  assert.doesNotMatch(html, /<p>/);
});

test("an oversized assistant text block is guarded the same way", () => {
  const html = renderMessage(assistantMessage(OVERSIZED));

  assert.match(html, /⚠/);
  assert.doesNotMatch(html, /<p>/);
});

test("regular-size messages keep rendering through the markdown pipeline", () => {
  const html = renderMessage({ role: "user", content: "Hello **world**", timestamp: 1 });

  assert.match(html, /<p>Hello <strong>world<\/strong><\/p>/);
  assert.doesNotMatch(html, /⚠/);
});

test("renders standalone thinking with the saved default and accessible disclosure state", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "Independent reasoning" },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      assert.equal(html.includes("Independent reasoning"), expanded);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("marks apply_patch returned failures as errors even when isError is unset (upstream e70c367)", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-fail",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
    },
  };
  const failed = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed.\nRecovery: MUST read src/a.ts before retrying." }],
    details: {
      result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "context mismatch" }] },
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(MessageView, {
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-test",
        content: [block],
      },
      toolResults: new Map([[block.toolCallId, failed]]),
    })),
  );

  assert.match(html, /border:1px solid rgba\(248,113,113,0\.45\)/);
  assert.match(html, />apply_patch</);
  assert.doesNotMatch(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
});

test("apply_patch renders split diff on wide viewports and unified rows on mobile (本地适配)", async () => {
  const { rememberBlockExpanded } = await jiti.import("./MessageView.tsx");
  const { IsMobileContext } = await jiti.import("./shell/context.tsx");
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-view",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Add File: new.ts\n+brand new line\n*** End Patch",
    },
  };
  const message = {
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  };
  rememberBlockExpanded(block.toolCallId, true);

  const splitGrid = /grid-template-columns:minmax\(0, 1fr\) minmax\(0, 1fr\)/;
  const desktopHtml = renderToStaticMarkup(
    React.createElement(I18nProvider, { initialLocale: "en" },
      React.createElement(IsMobileContext.Provider, { value: false },
        React.createElement(MessageView, { message })),
    ),
  );
  assert.match(desktopHtml, splitGrid);
  assert.match(desktopHtml, /brand new line/);

  const mobileHtml = renderToStaticMarkup(
    React.createElement(I18nProvider, { initialLocale: "en" },
      React.createElement(IsMobileContext.Provider, { value: true },
        React.createElement(MessageView, { message })),
    ),
  );
  assert.doesNotMatch(mobileHtml, splitGrid);
  assert.match(mobileHtml, /brand new line/);
});
