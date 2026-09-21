import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  hasModelCostDraftValue,
  modelCostToDraft,
  parseCompleteModelCost,
} = await jiti.import("./models-config-helpers.ts");

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");

test("model cost drafts default blank prices to zero unless all are blank (upstream c3b741e)", () => {
  const complete = {
    input: "1.25",
    output: "10",
    cacheRead: "0.125",
    cacheWrite: "0",
  };
  assert.deepEqual(parseCompleteModelCost(complete), {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });
  assert.deepEqual(parseCompleteModelCost({ ...complete, input: "", cacheWrite: "" }), {
    input: 0,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });
  assert.deepEqual(parseCompleteModelCost({ input: "1.25", output: "", cacheRead: "", cacheWrite: "" }), {
    input: 1.25,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(parseCompleteModelCost(modelCostToDraft()), undefined);
  assert.equal(parseCompleteModelCost({ ...complete, output: "not-a-price" }), undefined);
  assert.equal(parseCompleteModelCost({ ...complete, output: "-1" }), undefined);
  assert.equal(hasModelCostDraftValue(modelCostToDraft()), false);
  assert.equal(hasModelCostDraftValue({ ...complete, cacheWrite: "" }), true);
});

test("manual price editing commits completed costs and removes only an all-blank group", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.match(modelDetail, /const completeCost = parseCompleteModelCost\(nextDraft\)/);
  assert.match(modelDetail, /if \(completeCost\)/);
  assert.match(modelDetail, /delete nextModel\.cost/);
  assert.match(modelDetail, /const nextDraft = \{ \.\.\.costDraftRef\.current, \[key\]: value \}/);
  assert.match(modelDetail, /costDraftRef\.current = nextDraft/);
  assert.match(modelDetail, /costTemplateRef\.current/);
  assert.match(modelDetail, /value=\{costDraft\[key\]\}/);
});

test("model specs keep catalog-filled prices visible outside advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );
  const specsIndex = modelDetail.indexOf('t("models.modelSpecs")');
  const costIndex = modelDetail.indexOf('t("models.costPerMillion")');
  const advancedIndex = modelDetail.indexOf('t("models.advancedSettings")');

  assert.ok(specsIndex >= 0);
  assert.ok(costIndex > specsIndex);
  assert.ok(advancedIndex > costIndex);
  assert.match(modelDetail, /setCostEditing\(false\)/);
  assert.match(modelDetail, /formatCost\(key\)/);
});

test("per-model settings use one primary divider before advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.equal(
    (modelDetail.match(/borderTop: "1px solid var\(--border\)"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(modelDetail, /borderBottom: "1px solid var\(--border\)"/);
});

test("thinking level overrides keep explicit default, disabled, and custom controls", () => {
  const editor = source.slice(
    source.indexOf("function ThinkingLevelMapEditor"),
    source.indexOf("// ── Model detail"),
  );

  assert.match(editor, /THINKING_LEVELS\.map/);
  assert.match(editor, /Default\s*</);
  assert.match(editor, /Disabled\s*</);
  assert.match(editor, /Custom\s*</);
  assert.match(editor, /state === "omit"/);
  assert.match(editor, /state === "null"/);
  assert.match(editor, /state === "string"/);
});
