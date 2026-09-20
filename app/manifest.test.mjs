import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Ported upstream PWA manifest fix #379 (upstream 99d4ea1): unset the manifest
// orientation so the PWA respects the OS rotation lock instead of being
// forced to "any".

const manifestSource = await readFile(new URL("./manifest.ts", import.meta.url), "utf8");

test("does not lock the PWA orientation so the OS rotation lock is respected", () => {
  assert.doesNotMatch(manifestSource, /orientation/);
});
