// final-arch step-6 Task 2（2026-10-26）：profile 保存乐观并发（spec §13.5.1）。
// frontmatter `content_hash` = 正文 sha256（正文 = frontmatter 之外的部分，即
// parseFrontmatter(...).rest，写时自算）；列表 contentHash 读时从正文现算——
// 不信任存储的 content_hash（外部改了 frontmatter 的哈希值也不影响判定）。
// saveSubagentProfile 对 project 作用域已有文件 + expectedContentHash 给定：
// 不符 → ProfileConflictError（携带 currentContentHash）；相符 → 覆写并更新
// 哈希；不传 = 宽容写（现行为）；global 作用域与新文件永不设防。
// 路由 409 形状走源断言（profiles 路由依赖宿主模块，惯例见 delivery routes）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-profile-hash-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  ProfileConflictError,
  listSubagentProfileSources,
  saveSubagentProfile,
} = await createJiti(import.meta.url).import("./subagents.ts");
const { parseFrontmatter } = await createJiti(import.meta.url).import("./frontmatter.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function profile(overrides = {}) {
  return {
    name: "hash-agent",
    displayName: "Hash agent",
    description: "Conflict probe",
    systemPrompt: "Steady prompt.\nSecond line.",
    tools: ["read"],
    loadSkills: false,
    loadExtensions: false,
    promptMode: "append",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    ...overrides,
  };
}

async function projectCwd(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-profile-hash-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return cwd;
}

const profilePath = (cwd, name) => join(cwd, ".pi", "agents", `${name}.md`);

/** 落盘文件的正文（frontmatter 之外的精确字节——哈希的基准面）。 */
async function persistedBody(cwd, name) {
  const source = await readFile(profilePath(cwd, name), "utf8");
  return parseFrontmatter(source).rest;
}

test("save writes frontmatter content_hash equal to sha256 of the persisted body", async (t) => {
  const cwd = await projectCwd(t);
  saveSubagentProfile(cwd, "project", profile());
  const source = await readFile(profilePath(cwd, "hash-agent"), "utf8");
  const { data, rest } = parseFrontmatter(source);
  assert.equal(data.content_hash, sha256(rest));
  assert.match(source, /^content_hash: [0-9a-f]{64}$/m);
});

test("listing exposes contentHash computed from the body, not the stored frontmatter value", async (t) => {
  const cwd = await projectCwd(t);
  saveSubagentProfile(cwd, "project", profile({ name: "listed" }));
  const expected = sha256(await persistedBody(cwd, "listed"));

  const listed = listSubagentProfileSources(cwd).find((p) => p.scope === "project" && p.name === "listed");
  assert.equal(listed.contentHash, expected);

  // 外部篡改 frontmatter 里的 content_hash → 读时现算，不受存储值影响。
  const source = await readFile(profilePath(cwd, "listed"), "utf8");
  await writeFile(profilePath(cwd, "listed"), source.replace(/^content_hash: .*$/m, "content_hash: deadbeef"));
  const tampered = listSubagentProfileSources(cwd).find((p) => p.scope === "project" && p.name === "listed");
  assert.equal(tampered.contentHash, expected);
});

test("expected hash mismatch on an existing project profile throws ProfileConflictError with the current hash", async (t) => {
  const cwd = await projectCwd(t);
  saveSubagentProfile(cwd, "project", profile());
  const staleHash = sha256(await persistedBody(cwd, "hash-agent"));

  // 外部改动：正文换掉 → 当前正文哈希随之变化。
  const source = await readFile(profilePath(cwd, "hash-agent"), "utf8");
  await writeFile(profilePath(cwd, "hash-agent"), source.replace("Steady prompt.", "Externally edited."));
  const currentHash = sha256(await persistedBody(cwd, "hash-agent"));
  assert.notEqual(currentHash, staleHash);

  assert.throws(
    () => saveSubagentProfile(cwd, "project", profile(), { expectedContentHash: staleHash }),
    (error) => {
      assert.ok(error instanceof ProfileConflictError);
      assert.equal(error.currentContentHash, currentHash);
      assert.match(error.message, /modified externally|reload/i);
      return true;
    },
  );
  // 冲突即拒写：文件保持外部版本。
  assert.match(await readFile(profilePath(cwd, "hash-agent"), "utf8"), /Externally edited\./);
});

test("expected hash match saves and the stored hash updates with the new body", async (t) => {
  const cwd = await projectCwd(t);
  saveSubagentProfile(cwd, "project", profile());
  const currentHash = sha256(await persistedBody(cwd, "hash-agent"));

  const saved = saveSubagentProfile(cwd, "project", profile({ systemPrompt: "Rewritten body." }), {
    expectedContentHash: currentHash,
  });
  assert.equal(saved.contentHash, sha256(await persistedBody(cwd, "hash-agent")));
  const source = await readFile(profilePath(cwd, "hash-agent"), "utf8");
  assert.match(source, /Rewritten body\./);
  assert.equal(parseFrontmatter(source).data.content_hash, sha256(await persistedBody(cwd, "hash-agent")));
});

test("omitting expectedContentHash stays tolerant (overwrites external edits)", async (t) => {
  const cwd = await projectCwd(t);
  saveSubagentProfile(cwd, "project", profile());
  const source = await readFile(profilePath(cwd, "hash-agent"), "utf8");
  await writeFile(profilePath(cwd, "hash-agent"), source.replace("Steady prompt.", "Externally edited."));

  saveSubagentProfile(cwd, "project", profile({ systemPrompt: "Tolerant overwrite." }));
  assert.match(await readFile(profilePath(cwd, "hash-agent"), "utf8"), /Tolerant overwrite\./);
});

test("global scope ignores expectedContentHash (never conflicts)", async () => {
  saveSubagentProfile(globalScopeDir(), "global", profile({ name: "global-hash" }));
  assert.doesNotThrow(() =>
    saveSubagentProfile(globalScopeDir(), "global", profile({ name: "global-hash", systemPrompt: "Global v2." }), {
      expectedContentHash: "0".repeat(64),
    })
  );
  assert.match(readGlobal("global-hash"), /Global v2\./);
});

test("a brand-new project profile never conflicts even with an expected hash", async (t) => {
  const cwd = await projectCwd(t);
  assert.doesNotThrow(() =>
    saveSubagentProfile(cwd, "project", profile({ name: "fresh" }), { expectedContentHash: "0".repeat(64) })
  );
});

test("profiles route PUT plumbs expectedContentHash and maps ProfileConflictError to 409 (source assertions)", async () => {
  const src = await readFile(new URL("../app/api/subagents/profiles/route.ts", import.meta.url), "utf8");
  assert.match(src, /ProfileConflictError/);
  // PUT body 的可选 expectedContentHash 进 options（类型收窄：非 string 不传）。
  assert.match(src, /expectedContentHash/);
  assert.match(src, /typeof body\.expectedContentHash === "string"/);
  // 冲突 → 409 { error, currentContentHash }；其余错误维持既有映射。
  assert.match(src, /status:\s*409/);
  assert.match(src, /currentContentHash:\s*error\.currentContentHash/);
  // GET 的 profiles 列表（contentHash 随 SubagentProfile 类型自动带出）。
  assert.match(src, /listSubagentProfileSources/);
});

function globalScopeDir() {
  return process.env.PI_CODING_AGENT_DIR;
}

function readGlobal(name) {
  return readFileSync(join(globalScopeDir(), "agents", `${name}.md`), "utf8");
}
