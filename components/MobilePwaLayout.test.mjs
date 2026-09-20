import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Ported from upstream components/MobilePwaLayout.test.mjs (upstream 0ada6c7).
// Only the overflow-containment subset applies to this fork: the rest of the
// upstream file asserts the upstream viewport hook (--app-viewport-height),
// black-translucent standalone chrome, and mobile drawer safe-area CSS — this
// fork deliberately uses useVisualViewportKeyboard (--app-height/--app-lift),
// the default status bar, and MobileShell bottom tabs instead (t6-report.md).

const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("contains chat content and inputs within the mobile viewport", () => {
  assert.match(cssSource, /\.markdown-body \{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: hidden;/);
  assert.match(cssSource, /\.markdown-code-block \{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;/);
  assert.match(chatWindowSource, /overflow-x-hidden overflow-y-auto/);
  assert.match(chatInputSource, /flex: 1,\s*minWidth: 0,\s*width: "100%",/);
});
