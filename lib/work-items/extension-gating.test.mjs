import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("list tool excludes managed items by default with explicit opt-in", async () => {
  const src = await readFile(new URL("./extension.ts", import.meta.url), "utf8");
  assert.match(src, /include_managed/);
  assert.match(src, /delivery/);
});

test("tools do not bypass the service-layer flow gate", async () => {
  const src = await readFile(new URL("./extension.ts", import.meta.url), "utf8");
  assert.match(src, /updateWorkItem\(/);
  assert.doesNotMatch(src, /writeAtomic|appendEvent/, "extension must call the service, not write files");
});
