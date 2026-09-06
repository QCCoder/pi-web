import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { acquireRoundLock, releaseRoundLock } from "../../packages/pi-loop/round-lock.ts";
import {
  LoopManageError, isValidDocFilename, getLoopDocs, writeLoopFile,
  createLoop, deleteLoop,
} from "./manage.ts";

const LOOP_MD = [
  "---",
  'name: dev-loop',
  'pattern: dev-loop',
  'cron: "*/30 9-22 * * 1-5"',
  'timezone: "Asia/Shanghai"',
  "level: L2",
  "max_minutes: 45",
  "---",
  "# 本轮合同指针",
  "",
  "1. 读宪法",
  "2. 执行 /skill:dev-loop",
  "",
].join("\n");

const ITEM_YAML = [
  "schema_version: 1",
  "id: 0123456789abcdef01234567",
  "key: REQ-0001",
  "revision: 1",
  "type: requirement",
  "title: 绑定测试项",
  "status: in_progress",
  "phase: analysis",
  "priority: P2",
  "repositories: []",
  "tags: []",
  "conversations: []",
  "related_items: []",
  "designs: []",
  "plans: []",
  "loop: dev-loop",
  "created_at: 2026-09-03T00:00:00.000Z",
  "updated_at: 2026-09-03T00:00:00.000Z",
].join("\n");

function makeWorkspace(t, { withItem = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-loop-manage-"));
  const dir = join(root, "loops", "dev-loop");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOOP.md"), LOOP_MD);
  writeFileSync(join(dir, "STATE.md"), "# STATE\n\nLast run: -\n");
  writeFileSync(join(dir, "loop-ledger.json"), "{}");
  writeFileSync(join(dir, "chandao.md"), "# 来源说明\n");
  if (withItem) {
    const itemDir = join(root, "requirements", "REQ-0001-loop-manage-test");
    mkdirSync(itemDir, { recursive: true });
    writeFileSync(join(itemDir, "item.yaml"), ITEM_YAML);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const assertThrows = async (status, fn) => {
  await assert.rejects(fn, (error) => error instanceof LoopManageError && error.status === status);
};

test("isValidDocFilename 白名单", () => {
  assert.equal(isValidDocFilename("chandao.md"), true);
  assert.equal(isValidDocFilename("selection-rules.v2.md"), true);
  assert.equal(isValidDocFilename("LOOP.md"), false); // 保留名
  assert.equal(isValidDocFilename("STATE.md"), false); // 保留名
  assert.equal(isValidDocFilename(".hidden.md"), false); // 隐藏
  assert.equal(isValidDocFilename("a/b.md"), false); // 路径分隔符
  assert.equal(isValidDocFilename("../escape.md"), false);
  assert.equal(isValidDocFilename("notes.txt"), false); // 非 .md
  assert.equal(isValidDocFilename(""), false);
});

test("getLoopDocs 返回配置面板数据包", async (t) => {
  const root = makeWorkspace(t);
  const bundle = await getLoopDocs(root, "dev-loop");
  assert.equal(bundle.docs.length, 1);
  assert.equal(bundle.docs[0].name, "chandao.md");
  assert.equal(bundle.docs[0].content, "# 来源说明\n");
  assert.ok(bundle.docs[0].mtimeMs > 0);
  assert.equal(bundle.loopBody.startsWith("# 本轮合同指针"), true);
  assert.equal(bundle.stateMd, "# STATE\n\nLast run: -\n");
  assert.equal(bundle.frontmatter.level, "L2");
  assert.equal(bundle.frontmatter.maxMinutes, 45);
  assert.equal(bundle.frontmatter.pattern, "dev-loop");
  assert.equal(bundle.running, false);
  assert.equal(bundle.paused, false);
  assert.equal(bundle.constitution.constraints, undefined); // 根宪法缺失
  assert.equal(bundle.constitution.budget, undefined);
  assert.ok(bundle.constitutionTemplates.constraints.length > 0); // 模板始终带上
  assert.ok(bundle.constitutionTemplates.budget.length > 0);
  assert.deepEqual(bundle.boundItems, ["REQ-0001"]);
});

test("getLoopDocs 未知 loop 404", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(404, () => getLoopDocs(root, "nope"));
});

test("writeLoopFile: 新建知识文档并读回", async (t) => {
  const root = makeWorkspace(t);
  const result = await writeLoopFile(root, "dev-loop", { kind: "doc", file: "guide.md" }, "# 指南\n");
  assert.ok(result.mtimeMs > 0);
  const bundle = await getLoopDocs(root, "dev-loop");
  assert.equal(bundle.docs.find((d) => d.name === "guide.md")?.content, "# 指南\n");
});

test("writeLoopFile: 保留名/路径分隔符/非 md → 400", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "LOOP.md" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "a/b.md" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: ".x.md" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "notes.txt" }, "x"));
});

test("writeLoopFile: mtime 冲突 → 409 带当前内容；省略 baseMtime = 覆盖", async (t) => {
  const root = makeWorkspace(t);
  const path = join(root, "loops", "dev-loop", "chandao.md");
  const first = await writeLoopFile(root, "dev-loop", { kind: "doc", file: "chandao.md" }, "# v1\n");
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // 外部编辑：mtime 必变
  await assert.rejects(
    () => writeLoopFile(root, "dev-loop", { kind: "doc", file: "chandao.md" }, "# v2\n", first.mtimeMs),
    (error) => error instanceof LoopManageError && error.status === 409 && error.details.currentContent === "# v1\n",
  );
  await writeLoopFile(root, "dev-loop", { kind: "doc", file: "chandao.md" }, "# v3\n"); // 强制覆盖
  assert.equal(readFileSync(path, "utf8"), "# v3\n");
});

test("writeLoopFile: body 保存后 frontmatter 字节不变", async (t) => {
  const root = makeWorkspace(t);
  const path = join(root, "loops", "dev-loop", "LOOP.md");
  const before = readFileSync(path, "utf8");
  await writeLoopFile(root, "dev-loop", { kind: "body" }, "# 新指针\n\n1. 新步骤\n");
  const after = readFileSync(path, "utf8");
  const split = (raw) => raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)[0];
  assert.equal(split(after), split(before));
  assert.equal(after.slice(split(before).length), "# 新指针\n\n1. 新步骤\n");
});

test("writeLoopFile: constitution 写根级文件（缺失即创建）", async (t) => {
  const root = makeWorkspace(t);
  await writeLoopFile(root, "dev-loop", { kind: "constitution", file: "budget" }, "# 预算\n");
  const bundle = await getLoopDocs(root, "dev-loop");
  assert.equal(bundle.constitution.budget?.content, "# 预算\n");
});

test("writeLoopFile: 未知 loop 404", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(404, () => writeLoopFile(root, "nope", { kind: "body" }, "x"));
});

test("createLoop: 脚手架 + 参数校验", async (t) => {
  const root = makeWorkspace(t, { withItem: false });
  await createLoop(root, { name: "ops-loop", cron: "*/5 * * * *", timezone: "Asia/Shanghai" });
  assert.ok(existsSync(join(root, "loops", "ops-loop", "LOOP.md")));
  assert.ok(existsSync(join(root, "loops", "ops-loop", ".lastrun"))); // initLoop 写 .lastrun=now
  assert.ok(existsSync(join(root, "loop-constraints.md"))); // 根宪法缺失时由 init 复制模板
  assert.ok(existsSync(join(root, ".agents", "skills", "ops-loop", "SKILL.md"))); // SKILL 骨架
  await assertThrows(409, () => createLoop(root, { name: "ops-loop", cron: "*/5 * * * *" })); // 重名
  await assertThrows(400, () => createLoop(root, { name: "My Loop", cron: "*/5 * * * *" })); // 非 slug
  await assertThrows(400, () => createLoop(root, { name: "ok-name", cron: "not-a-cron" })); // 非法 cron
  await assertThrows(400, () => createLoop(root, { name: "ok-name", cron: "*/5 * * * *", timezone: "Mars/Olympus" }));
});

test("deleteLoop: 锁活 409 / 绑定项 409+确认放行 / SKILL 与宪法不删", async (t) => {
  const root = makeWorkspace(t);
  const dir = join(root, "loops", "dev-loop");
  // fix(final-review F3): 标题声称「SKILL 与宪法不删」却从未落盘这两个文件——
  // 先创建，末尾断言删除后仍在，让断言与标题相符。
  const skillPath = join(root, ".agents", "skills", "dev-loop", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "# skill\n");
  writeFileSync(join(root, "loop-constraints.md"), "# 宪法\n");
  // 锁活：daemon 持有 + 本进程 pid（活）
  assert.equal(acquireRoundLock(dir, { pid: process.pid, host: hostname(), kind: "daemon", sessionId: "s-test" }), true);
  await assert.rejects(
    () => deleteLoop(root, "dev-loop"),
    (error) => error instanceof LoopManageError && error.status === 409 && error.details.running === true,
  );
  releaseRoundLock(dir);
  // 绑定项：REQ-0001 绑给 dev-loop（fixture）
  await assert.rejects(
    () => deleteLoop(root, "dev-loop"),
    (error) => error instanceof LoopManageError && error.status === 409
      && JSON.stringify(error.details.boundItems) === JSON.stringify(["REQ-0001"]),
  );
  await deleteLoop(root, "dev-loop", { confirmBound: true });
  assert.equal(existsSync(dir), false); // 整目录删除
  assert.ok(existsSync(join(root, "requirements"))); // 工作项不动
  assert.ok(existsSync(skillPath)); // SKILL 不删（loop 目录外）
  assert.ok(existsSync(join(root, "loop-constraints.md"))); // 根宪法不删（可能被其它 loop 共享）
});

test("deleteLoop: 未知 loop 404", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(404, () => deleteLoop(root, "nope"));
});

// fix(final-review F1): 畸形 target 此前落入宪法路径（CONSTITUTION_FILES[undefined] →
// join TypeError → 500）；守卫后应答 400。
test("writeLoopFile: 畸形 target → 400", async (t) => {
  const root = makeWorkspace(t);
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "weird" }, "x"));
  await assertThrows(400, () => writeLoopFile(root, "dev-loop", { kind: "constitution", file: "bogus" }, "x"));
});
