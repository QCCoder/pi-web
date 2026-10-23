import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const url = await jiti.import("./work-items-page-url.ts");

// buildWorkItemsPageUrl 返回**裸 query**（navigateUrl 的契约：它自己补 "?"）。
test("round-trips workspace and item, ignores view syntax", () => {
  const q = url.buildWorkItemsPageUrl("01WS", "REQ-0001");
  assert.equal(q, "workspace=01WS&page=work-items&item=REQ-0001");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q));
  assert.deepEqual(parsed, { workspaceId: "01WS", itemKey: "REQ-0001" });
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("workspace=01WS&view=chat")), null);
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("page=work-items")), null);
});

test("page URL without item omits the item param and parses without itemKey", () => {
  const q = url.buildWorkItemsPageUrl("01WS");
  assert.equal(q, "workspace=01WS&page=work-items");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q));
  assert.deepEqual(parsed, { workspaceId: "01WS" });
  assert.equal("itemKey" in parsed, false);
});

test("ids needing encoding survive the round-trip", () => {
  const weird = "01W X/Y&=Z";
  const q = url.buildWorkItemsPageUrl(weird, "REQ 0001&x");
  const parsed = url.parseWorkItemsPageParams(new URLSearchParams(q));
  assert.deepEqual(parsed, { workspaceId: weird, itemKey: "REQ 0001&x" });
});

test("page param with another value is not a work-items page", () => {
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams("workspace=01WS&page=other")), null);
});

// fix round 1 Critical 回归：真实边界是 navigateUrl 组合出的 URL（"?" + query）。
// query 若自带前导 "?"，组合出 "??"，URLSearchParams 只剥一个 "?"，深链即死。
test("composed URL form (? + query) parses — builder must return the BARE query", () => {
  const query = url.buildWorkItemsPageUrl("01WS", "REQ-0001");
  assert.ok(!query.startsWith("?"), "builder must not prefix '?' (navigateUrl adds it)");
  const params = new URLSearchParams(`?${query}`);
  assert.equal(params.get("workspace"), "01WS");
  assert.equal(params.get("page"), "work-items");
  assert.equal(params.get("item"), "REQ-0001");
  assert.deepEqual(url.parseWorkItemsPageParams(params), { workspaceId: "01WS", itemKey: "REQ-0001" });
  // 旧 bug 形态（query 带 "?" + navigateUrl 再补一个 = 双问号）确实解析不出。
  assert.equal(new URLSearchParams(`??${query}`).get("workspace"), null);
  assert.equal(url.parseWorkItemsPageParams(new URLSearchParams(`??${query}`)), null);
});
