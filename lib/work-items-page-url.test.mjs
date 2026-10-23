import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const url = await jiti.import("./work-items-page-url.ts");

test("round-trips workspace and item, ignores view syntax", () => {
  const q = url.buildWorkItemsPageUrl("01WS", "REQ-0001");
  assert.equal(q, "?workspace=01WS&page=work-items&item=REQ-0001");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q.slice(1)));
  assert.deepEqual(parsed, { workspaceId: "01WS", itemKey: "REQ-0001" });
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("workspace=01WS&view=chat")), null);
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("page=work-items")), null);
});

test("page URL without item omits the item param and parses without itemKey", () => {
  const q = url.buildWorkItemsPageUrl("01WS");
  assert.equal(q, "?workspace=01WS&page=work-items");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q.slice(1)));
  assert.deepEqual(parsed, { workspaceId: "01WS" });
  assert.equal("itemKey" in parsed, false);
});

test("ids needing encoding survive the round-trip", () => {
  const weird = "01W X/Y&=Z";
  const q = url.buildWorkItemsPageUrl(weird, "REQ 0001&x");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q.slice(1)));
  assert.deepEqual(parsed, { workspaceId: weird, itemKey: "REQ 0001&x" });
});

test("page param with another value is not a work-items page", () => {
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("workspace=01WS&page=other")), null);
});
