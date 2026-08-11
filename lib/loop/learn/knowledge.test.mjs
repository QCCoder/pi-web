import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { learningNotePath, formatLearningNote } = await jiti.import("./knowledge.ts");

test("learningNotePath: unique per runId, under learnings/, slug-safe", () => {
  assert.equal(learningNotePath("finance-service", "01KZ"), "learnings/finance-service-01KZ.md");
  assert.equal(learningNotePath("SeaExport/Booking", "r1"), "learnings/seaexport-booking-r1.md");
});

test("formatLearningNote: OKF frontmatter marks author:loop + autoManaged + derivedFrom", () => {
  const md = formatLearningNote({
    module: "finance-service", runId: "01KZ", title: "费用计算依赖 isTransfer",
    body: "改 charge 前必查 BookingRoute.isTransfer。", tags: ["fee"],
  });
  assert.match(md, /type: learning/);
  assert.match(md, /author: loop/);
  assert.match(md, /autoManaged: true/);
  assert.match(md, /derivedFrom: "run:01KZ"/);
  assert.match(md, /module: finance-service/);
  assert.match(md, /- fee/);
  assert.match(md, /费用计算依赖 isTransfer/);
  assert.match(md, /研发 Loop run `01KZ`/);
});

test("formatLearningNote: includes module in tags when no tags passed", () => {
  const md = formatLearningNote({ module: "mdm-service", runId: "r9", title: "t", body: "b" });
  assert.match(md, /- mdm-service/);
});
