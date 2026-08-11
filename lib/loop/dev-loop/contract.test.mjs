import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  renderDeveloperAgent,
  renderTesterAgent,
  renderDevLoopState,
  renderDevLoopInstructions,
  DEV_LOOP_ID,
  PHASE_SELECTION,
  PHASE_REVIEW,
  PHASE_COMPLETE,
} = await jiti.import("./contract.ts");

test("constants: dev-loop id + phase mapping present", () => {
  assert.equal(DEV_LOOP_ID, "dev-loop");
  assert.equal(PHASE_SELECTION, "intake");
  assert.equal(PHASE_REVIEW, "verification");
  assert.equal(PHASE_COMPLETE, "complete");
});

test("developer agent: TDD + branch rules + never-merge-trunk invariants", () => {
  const md = renderDeveloperAgent();
  assert.match(md, /name: developer/);
  assert.match(md, /feature\/\{date\}\/\{slug\}/);
  assert.match(md, /hotfix\/\{date\}\/\{slug\}/);
  assert.match(md, /NEVER merge to trunk/i);
  assert.match(md, /test-first|TDD|failing test/i);
});

test("tester agent: binary verdict + separation (never writes prod code)", () => {
  const md = renderTesterAgent();
  assert.match(md, /name: tester/);
  assert.match(md, /LOOP_VERDICT: green/);
  assert.match(md, /LOOP_VERDICT: red/);
  assert.match(md, /NEVER write or edit production code/i);
  assert.match(md, /mvn -pl <module> test/);
  assert.match(md, /npm run test:ci/);
});

test("STATE: has managed derived markers + baseline", () => {
  const md = renderDevLoopState();
  assert.match(md, /<!-- dev-loop:derived:start -->/);
  assert.match(md, /<!-- dev-loop:derived:end -->/);
  assert.match(md, /standards\/dev-loop-modules\.md/);
});

test("LOOP.md contract: encodes the full OODA + L0 invariants + phase mapping", () => {
  const md = renderDevLoopInstructions();
  // L0 invariants (hard)
  assert.match(md, /永不自动合并主干/);
  assert.match(md, /只能动工作项/);
  assert.match(md, /feature\/hotfix 分支/);
  assert.match(md, /同时只一个工作项在途/);
  // phase mapping
  assert.match(md, /intake/);
  assert.match(md, /verification/);
  assert.match(md, /complete/);
  // triple judgment
  assert.match(md, /三重判定/);
  assert.match(md, /① 信心/);
  assert.match(md, /③ 风险/);
  // maker/checker separation + subagent delegation
  assert.match(md, /subagent\(\{ agent: "developer"/);
  assert.match(md, /subagent\(\{ agent: "tester"/);
  assert.match(md, /永不自证/);
  // gate2 never skipped
  assert.match(md, /gate2/);
  assert.match(md, /永不跳过/);
  // learn minimal + LEARN schema
  assert.match(md, /LEARN\.jsonl/);
  assert.match(md, /predictedConf/);
  assert.match(md, /outcome.*merged/);
  // PR = push branch (no gh)
  assert.match(md, /git push origin/);
  // knowledge append-only (anti-pollution)
  assert.match(md, /永远新建文件/);
  // P5 tuning (from real-machine run): selection excludes data/ops bugs; learn is mandatory
  assert.match(md, /选品排除（硬）/);
  assert.match(md, /learn 步必须 append 一条 LEARN 记录/);
});
