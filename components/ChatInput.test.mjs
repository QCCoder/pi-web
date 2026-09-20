import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, getUpwardMenuMaxHeight, replaceLinksWithMarkdown } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
  // Composer sitting under a 36px top bar with only ~160px of air: a 400px
  // file list would paint through the bar and hide the leading matches.
  assert.equal(getUpwardMenuMaxHeight(200, 36), 156);
  assert.ok(getUpwardMenuMaxHeight(200, 36) < 400);
});

test("file mention menu applies the measured upward height cap", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("{atMenuOpen && atQuery !== null && (() => {");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 4000);
  assert.match(block, /ref=\{atMenuRef\}/);
  assert.match(block, /min\(48vh, 400px, \$\{atMenuMaxHeight\}px\)/);
  assert.match(block, /flexDirection: "column"/);
  assert.match(block, /minHeight: 0/);
  assert.equal(block.includes("maxHeight: \"min(48vh, 400px)\""), false);
});

test("file mention menu remeasures when its layout container shifts the anchor", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function subscribeUpwardMenuMaxHeight");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 1800);
  assert.match(block, /const layoutContainer = parent\?\.parentElement;/);
  assert.match(block, /anchorObserver\?\.observe\(layoutContainer\)/);
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

