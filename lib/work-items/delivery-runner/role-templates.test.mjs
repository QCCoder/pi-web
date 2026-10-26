// Seam-repositioning Task 3（2026-10-26）：剧本模板 + 播种。
// 1. 模板形状：四键齐（DELIVERY_ROLES）、frontmatter {name, description,
//    seeded_from: "<role>@<ROLE_TEMPLATE_VERSION>"}、正文非空；两组守卫不命中
//    （不变式六条的句子不得出现在剧本；工作区专属事实不得混进通用模板）。
// 2. subagent 可读：播种后的 designer.md 能被 resolveSubagentProfile 读出
//    非空 systemPrompt（.pi/agents 同为 subagent project 作用域，与
//    listSubagentProfiles 共存不报错）。
// 3. 播种行为（真临时工作区）：空工作区 → written 4 且内容逐字节等于模板、
//    .pi/agents 自动创建；二次 → skipped 4（幂等）；预置 designer.md 自定义
//    内容 → written 3 / skipped 1 且该文件字节不变（永不改写）。
// 路由侧（PUT 响应 seeded、写入先于播种）在 config.test.mjs 的源断言用例。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const rt = await jiti.import("./role-templates.ts");
const rolesMod = await jiti.import("./roles.ts");
const frontmatter = await jiti.import("../../frontmatter.ts");
const subagents = await jiti.import("../../subagents.ts");

// 守卫 1：引擎不变式合同的句子（剧本只写干活内容，规则归引擎）。
const INVARIANT_GUARD = /交付回合不变式|成功才动手|那是人的手/;
// 守卫 2：工作区专属事实（模板是通用脚手架，不掺任何具体项目）。
const WS_FACT_GUARD = /jdk|mvn|npm|origin\/master|constraints\.md|budget\.md|cargoware/i;

test("templates cover all four roles with exact frontmatter and non-empty body", () => {
  assert.equal(typeof rt.ROLE_TEMPLATE_VERSION, "number");
  for (const role of rolesMod.DELIVERY_ROLES) {
    const template = rt.ROLE_PROFILE_TEMPLATES[role];
    assert.equal(typeof template, "string", `${role} template is a string`);
    const { data, rest } = frontmatter.parseFrontmatter(template);
    assert.equal(data?.name, role, `${role} frontmatter name`);
    assert.equal(data?.seeded_from, `${role}@${rt.ROLE_TEMPLATE_VERSION}`, `${role} seeded_from`);
    assert.ok(
      typeof data?.description === "string" && data.description.trim().length > 0,
      `${role} description is a non-empty sentence`,
    );
    assert.ok(rest.trim().length > 0, `${role} body is non-empty`);
  }
});

test("templates contain no invariant sentences and no workspace-specific facts", () => {
  for (const role of rolesMod.DELIVERY_ROLES) {
    const template = rt.ROLE_PROFILE_TEMPLATES[role];
    assert.doesNotMatch(template, INVARIANT_GUARD, `${role} must not restate the invariant contract`);
    assert.doesNotMatch(template, WS_FACT_GUARD, `${role} must not embed workspace-specific facts`);
  }
});

test("seeded designer is readable by resolveSubagentProfile with non-empty systemPrompt", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-subagent-"));
  try {
    await rt.seedRoleProfileTemplates(ws);
    const profile = subagents.resolveSubagentProfile(ws, "designer");
    assert.ok(profile, "resolveSubagentProfile finds the seeded designer");
    assert.ok(profile.systemPrompt.trim().length > 0, "systemPrompt (body) is non-empty");
    // 与 subagent 列表共存不报错：四个角色剧本都出现在列表里（project 作用域）。
    const names = subagents.listSubagentProfiles(ws).map((p) => p.name);
    for (const role of rolesMod.DELIVERY_ROLES) {
      assert.ok(names.includes(role), `listSubagentProfiles includes ${role}`);
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("seeding an empty workspace writes all four templates and creates .pi/agents", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-seed-"));
  try {
    const result = await rt.seedRoleProfileTemplates(ws);
    // DELIVERY_ROLES 顺序；空 skipped。
    assert.deepEqual(result.written, [...rolesMod.DELIVERY_ROLES]);
    assert.deepEqual(result.skipped, []);
    // 落盘内容逐字节等于模板（write-if-missing 写的就是模板本身）。
    for (const role of rolesMod.DELIVERY_ROLES) {
      const onDisk = await readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8");
      assert.equal(onDisk, rt.ROLE_PROFILE_TEMPLATES[role], `${role}.md equals template`);
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("seeding is idempotent: second run skips all four, files unchanged", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-idem-"));
  try {
    await rt.seedRoleProfileTemplates(ws);
    const before = await Promise.all(
      rolesMod.DELIVERY_ROLES.map((role) => readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8")),
    );
    const second = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.skipped, [...rolesMod.DELIVERY_ROLES]);
    const after = await Promise.all(
      rolesMod.DELIVERY_ROLES.map((role) => readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8")),
    );
    assert.deepEqual(after, before, "existing files are never rewritten");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("pre-existing user designer.md is skipped byte-for-byte (written 3 / skipped 1)", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-user-"));
  try {
    await mkdir(join(ws, ".pi", "agents"), { recursive: true });
    const custom = "---\nname: designer\ndescription: 工作区自己的设计师剧本\n---\n\n用户改过的正文，播种不得碰。\n";
    const designerPath = join(ws, ".pi", "agents", "designer.md");
    await writeFile(designerPath, custom, "utf8");
    const result = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(result.written, ["developer", "verifier", "release-preparer"]);
    assert.deepEqual(result.skipped, ["designer"]);
    assert.equal(await readFile(designerPath, "utf8"), custom, "user file untouched byte-for-byte");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
