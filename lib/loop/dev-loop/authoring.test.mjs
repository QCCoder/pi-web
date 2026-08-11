import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createDevLoopDefinition, ensureDevLoopDefinition } = await jiti.import("./authoring.ts");
const { readLoopDefinition } = await jiti.import("../store.ts");

function ws(path) {
  return { id: "ws", name: "cxin", path };
}

test("createDevLoopDefinition writes the full contract and is readable by the engine", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-devloop-"));
  const definition = await createDevLoopDefinition(ws(path));
  assert.equal(definition.id, "dev-loop");
  assert.equal(definition.autonomy, "L2");
  assert.equal(definition.triggers.length, 2);
  const cron = definition.triggers.find((t) => t.type === "cron");
  assert.equal(cron.expression, "0 9 * * 1-5");
  const directory = join(path, "loops", "dev-loop");
  assert.match(await readFile(join(directory, "LOOP.md"), "utf8"), /三重判定/);
  assert.match(await readFile(join(directory, "STATE.md"), "utf8"), /dev-loop:derived:start/);
  assert.match(await readFile(join(directory, "agents", "developer.md"), "utf8"), /name: developer/);
  assert.match(await readFile(join(directory, "agents", "tester.md"), "utf8"), /name: tester/);
  assert.equal((await stat(join(directory, "audit"))).isDirectory(), true);
  // LEARN.jsonl seeded empty
  assert.equal((await readFile(join(directory, "LEARN.jsonl"), "utf8")), "");
});

test("createDevLoopDefinition rejects duplicates", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-devloop-dup-"));
  await createDevLoopDefinition(ws(path));
  await assert.rejects(() => createDevLoopDefinition(ws(path)), /already exists/);
});

test("ensureDevLoopDefinition is idempotent (create then return existing)", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-devloop-ensure-"));
  const first = await ensureDevLoopDefinition(ws(path));
  assert.equal(first.created, true);
  const second = await ensureDevLoopDefinition(ws(path));
  assert.equal(second.created, false);
  assert.equal(second.definition.id, "dev-loop");
  // engine can still read it
  const read = await readLoopDefinition(ws(path), "dev-loop");
  assert.equal(read.autonomy, "L2");
});
