import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// TextFileViewer opens EventSource/fetch on mount, so a render-level harness
// would need a browser-ish environment; the latch is a wiring contract, so
// these assertions follow the repo's source-assertion precedent
// (FileExplorer.file-search.test.mjs).
const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("the rendered-first default is a one-shot latch per opened file", () => {
  assert.match(source, /const defaultPreviewEligibleRef = useRef\(true\);/);
  // Consumed before the mode flip so the decision fires at most once.
  assert.match(source, /const eligible = defaultPreviewEligibleRef\.current;/);
  assert.match(source, /defaultPreviewEligibleRef\.current = false;/);
});

test("the decision waits for the first chunk and needs the complete file", () => {
  assert.match(source, /if \(!data\) return;/);
  assert.match(source, /eligible\s*\n\s*&& !data\.truncated/);
  assert.match(source, /data\.language === "markdown" \|\| data\.language === "html"/);
});

test("switching files re-arms the latch instead of losing the default", () => {
  // This instance persists across filePath changes (no per-tab key locally,
  // unlike upstream's keyed remount), so the initial-load effect re-arms it.
  assert.match(source, /defaultPreviewEligibleRef\.current = true;/);
  assert.match(source, /Re-arm the rendered-first default for the newly opened file\./);
});

test("appends and SSE reloads cannot re-flip the mode mid-reading", () => {
  // The decision effect keys on the data identity (every load-more append and
  // SSE refetch produces a new object), so without the consumed latch each of
  // those would re-evaluate the default; the latch is what makes it one-shot.
  assert.match(source, /\}, \[data, initialDisplayMode\]\);/);
});
