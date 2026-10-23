import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
  jsx: { runtime: "automatic" },
});
const phases = await jiti.import("./work-item-phases.ts");

const { BOARD_COLUMNS, BOARD_COLUMN_LABELS, PHASE_LABELS, boardColumnForPhase, isHistoricalComplete } = phases;

test("BOARD_COLUMNS is the seven standard flow columns in order", () => {
  assert.deepEqual([...BOARD_COLUMNS], [
    "intake",
    "design",
    "ready_for_implementation",
    "implementation",
    "verification",
    "release_ready",
    "released",
  ]);
});

test("boardColumnForPhase: standard columns map to themselves", () => {
  for (const column of BOARD_COLUMNS) {
    assert.equal(boardColumnForPhase(column), column);
  }
});

test("boardColumnForPhase: legacy pre-design sub-phases project into the design column", () => {
  assert.equal(boardColumnForPhase("analysis"), "design");
  assert.equal(boardColumnForPhase("requirement_approval"), "design");
  assert.equal(boardColumnForPhase("plan_approval"), "design");
  assert.equal(boardColumnForPhase("design"), "design");
});

test("boardColumnForPhase: legacy complete projects to released (no separate column)", () => {
  assert.equal(boardColumnForPhase("complete"), "released");
});

test("isHistoricalComplete: only legacy complete, never the released delivery terminal", () => {
  assert.equal(isHistoricalComplete("complete"), true);
  for (const phase of [
    "intake", "analysis", "requirement_approval", "design", "plan_approval",
    "implementation", "verification", "ready_for_implementation",
    "release_ready", "released",
  ]) {
    assert.equal(isHistoricalComplete(phase), false, phase);
  }
});

test("every WorkItemPhase and board column has a display label", () => {
  // 老子阶段在看板上显示原始标签，所以标签表必须覆盖全部 phase（编译期类型
  // 已保证键域，这里防手滑删漏 + 保证新 phase 加了类型就有标签）。
  const allPhases = [
    "intake", "analysis", "requirement_approval", "design", "plan_approval",
    "implementation", "verification", "complete",
    "ready_for_implementation", "release_ready", "released",
  ];
  for (const phase of allPhases) {
    assert.ok(typeof PHASE_LABELS[phase] === "string" && PHASE_LABELS[phase].length > 0, phase);
  }
  for (const column of BOARD_COLUMNS) {
    assert.ok(typeof BOARD_COLUMN_LABELS[column] === "string" && BOARD_COLUMN_LABELS[column].length > 0, column);
  }
});
