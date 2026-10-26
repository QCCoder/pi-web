// Seam-repositioning Task 3（2026-10-26）：剧本模板 + 播种。
// 1. 模板形状：四活值角色全键同形（Task 4 起 reviewer 真模板落位、verifier
//    模板随角色退役——Partial 过渡态消失）、frontmatter {name, description,
//    seeded_from: "<role>@<ROLE_TEMPLATE_VERSION>"}（版本 2）、正文非空；两组
//    守卫不命中（不变式六条的句子不得出现在剧本；工作区专属事实不得混进通用
//    模板）；reviewer 正文含三层审查与 rework 条目格式。
// 2. subagent 可读：播种后的 designer.md 能被 resolveSubagentProfile 读出
//    非空 systemPrompt（.pi/agents 同为 subagent project 作用域，与
//    listSubagentProfiles 共存不报错）。
// 3. 播种行为（真临时工作区）：空工作区 → written = 词表全集且内容逐字节等
//    于模板、.pi/agents 自动创建；二次 → skipped 全集（幂等）；预置 designer.md
//    自定义内容 → 该文件字节不变（永不改写）。
// 4. 一次性播种（final-fix A，2026-10-26）：产品记录 .pi/delivery-seeded.json
//    （schemaVersion 1）——已记录角色永不重播（用户删除即终局，不重建）；预置
//    用户剧本收养为 "existing"（收养后删除也不代写）；无记录的旧库文件在场
//    → 全收养、字节不动；记录不可读/畸形 → fail-safe（一字不写、全 skipped、
//    console.error 一次）。
// 5. 旧记录迁移（Task 4）：记录含 verifier@1、四个旧文件在场、无 reviewer →
//    只写 reviewer（reviewer@2）、其余原样（verifier 记录原样保留——未知键
//    不销毁；verifier.md 不再代写）。
// 路由侧（PUT 响应 seeded、写入先于播种）在 config.test.mjs 的源断言用例。
// （原「无模板角色整个缺席」用例随全键同形表消失——四活值角色全有模板，
//   该断言已无对象，留此存照。）
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const rt = await jiti.import("./role-templates.ts");
const rolesMod = await jiti.import("./roles.ts");
const frontmatter = await jiti.import("../../frontmatter.ts");
const subagents = await jiti.import("../../subagents.ts");

/** 当前有模板的角色（DELIVERY_ROLES 序）——播种 written/skipped 的全集。
 *  Task 4 起模板表全键同形：恒等于 DELIVERY_ROLES。 */
const templatedRoles = () =>
  rolesMod.DELIVERY_ROLES.filter((role) => rt.ROLE_PROFILE_TEMPLATES[role] !== undefined);

// 守卫 1：引擎不变式合同的句子（剧本只写干活内容，规则归引擎）。
const INVARIANT_GUARD = /交付回合不变式|成功才动手|那是人的手/;
// 守卫 2：工作区专属事实（模板是通用脚手架，不掺任何具体项目）。
const WS_FACT_GUARD = /jdk|mvn|npm|origin\/master|constraints\.md|budget\.md|cargoware/i;

test("ROLE_PROFILE_TEMPLATES is complete: every active role has frontmatter + body", () => {
  assert.equal(typeof rt.ROLE_TEMPLATE_VERSION, "number");
  assert.ok(rt.ROLE_TEMPLATE_VERSION >= 2, "version bumped with the reviewer template");
  // 全键同形：词表全集逐键在场（Task 4 起 reviewer 落位、verifier 摘除）。
  assert.deepEqual(Object.keys(rt.ROLE_PROFILE_TEMPLATES).sort(), [...rolesMod.DELIVERY_ROLES].sort());
  for (const role of templatedRoles()) {
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
  // verifier 不再有模板（角色已退役——模板随词表摘除）。
  assert.equal(rt.ROLE_PROFILE_TEMPLATES.verifier, undefined);
});

test("reviewer template carries the three-layer review and the rework entry format", () => {
  const template = rt.ROLE_PROFILE_TEMPLATES.reviewer;
  // 三层审查：SPEC/design.md 合规、README 原始验收、代码质量。
  assert.match(template, /design\.md/, "layer 1: spec/design.md compliance");
  assert.match(template, /README/, "layer 2: original acceptance re-check");
  assert.match(template, /代码质量/, "layer 3: code quality");
  // rework 条目格式（file:line 问题 期望 [源头: code|spec]）+ submit 形状。
  assert.match(template, /file:line/, "rework entry format present");
  assert.match(template, /\[源头: code\|spec\]/, "source segment in the entry format");
  assert.match(template, /outcome/, "submit carries outcome");
  assert.match(template, /pass[\s\S]*rework|rework[\s\S]*pass/, "both outcomes described");
  // 检查语义：run_check 只是佐证、全量权威运行归系统（提交 pass 后自动执行）。
  assert.match(template, /delivery_run_check/, "targeted evidence tool named");
  assert.match(template, /系统[\s\S]*自动/, "system runs the authoritative full pass");
  // 守卫续绿（reviewer 模板同样不命中两组 guard——显式断言防回潮）。
  assert.doesNotMatch(template, INVARIANT_GUARD);
  assert.doesNotMatch(template, WS_FACT_GUARD);
});

test("templates contain no invariant sentences and no workspace-specific facts", () => {
  for (const role of templatedRoles()) {
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
    // 与 subagent 列表共存不报错：有模板的角色剧本都出现在列表里（project 作用域）。
    const names = subagents.listSubagentProfiles(ws).map((p) => p.name);
    for (const role of templatedRoles()) {
      assert.ok(names.includes(role), `listSubagentProfiles includes ${role}`);
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("seeding an empty workspace writes exactly the templated roles and creates .pi/agents", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-seed-"));
  try {
    const result = await rt.seedRoleProfileTemplates(ws);
    // DELIVERY_ROLES 序；空 skipped。
    assert.deepEqual(result.written, [...templatedRoles()]);
    assert.deepEqual(result.skipped, []);
    // 落盘内容逐字节等于模板（write-if-missing 写的就是模板本身）。
    for (const role of templatedRoles()) {
      const onDisk = await readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8");
      assert.equal(onDisk, rt.ROLE_PROFILE_TEMPLATES[role], `${role}.md equals template`);
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("seeding is idempotent: second run skips all templated roles, files unchanged", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-idem-"));
  try {
    await rt.seedRoleProfileTemplates(ws);
    const before = await Promise.all(
      templatedRoles().map((role) => readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8")),
    );
    const second = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.skipped, [...templatedRoles()]);
    const after = await Promise.all(
      templatedRoles().map((role) => readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8")),
    );
    assert.deepEqual(after, before, "existing files are never rewritten");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("pre-existing user designer.md is skipped byte-for-byte (其余模板照写)", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-user-"));
  try {
    await mkdir(join(ws, ".pi", "agents"), { recursive: true });
    const custom = "---\nname: designer\ndescription: 工作区自己的设计师剧本\n---\n\n用户改过的正文，播种不得碰。\n";
    const designerPath = join(ws, ".pi", "agents", "designer.md");
    await writeFile(designerPath, custom, "utf8");
    const result = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(result.written, templatedRoles().filter((role) => role !== "designer"));
    assert.deepEqual(result.skipped, ["designer"]);
    assert.equal(await readFile(designerPath, "utf8"), custom, "user file untouched byte-for-byte");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------- 一次性播种记录（final-fix A，2026-10-26）

/** 读播种记录（.pi/delivery-seeded.json）为对象；JSON 破损由调用方断言。 */
async function readSeedRecord(ws) {
  return JSON.parse(await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8"));
}

/** 有模板角色的 "<role>@<ROLE_TEMPLATE_VERSION>" 记录表（fresh 播种后的期望形状）。 */
const versionedRecordRoles = () =>
  Object.fromEntries(templatedRoles().map((role) => [role, `${role}@${rt.ROLE_TEMPLATE_VERSION}`]));

test("fresh seeding writes a valid delivery-seeded record (schemaVersion 1, role@version entries)", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-record-"));
  try {
    const result = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(result.written, [...templatedRoles()]);
    // 记录 = 合法 JSON、schemaVersion 1、有模板角色各记 "<role>@<版本>"。
    const record = await readSeedRecord(ws);
    assert.equal(record.schemaVersion, 1);
    assert.deepEqual(record.roles, versionedRecordRoles());
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// （原「a role without a template …」用例随全键同形表移除：四活值角色全有
//   模板，无模板角色已不存在——vacuous 断言不留，留此存照。）

// Task 4：旧记录迁移——记录含 verifier@1、四个旧文件在场、无 reviewer →
// 只写 reviewer，其余角色（含已退役的 verifier）原样不动。
test("legacy record with verifier@1 and four old files: only reviewer is written, nothing else touched", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-legacy-ver-"));
  try {
    await mkdir(join(ws, ".pi", "agents"), { recursive: true });
    // 四个旧文件（含已退役 verifier 的剧本）+ 对应旧记录（全部 @1）。
    const oldRoles = ["designer", "developer", "verifier", "release-preparer"];
    const customs = new Map();
    for (const role of oldRoles) {
      const content = `---\nname: ${role}\nseeded_from: "${role}@1"\n---\n\n${role} 旧剧本。\n`;
      customs.set(role, content);
      await writeFile(join(ws, ".pi", "agents", `${role}.md`), content, "utf8");
    }
    await writeFile(
      join(ws, ".pi", "delivery-seeded.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          roles: Object.fromEntries(oldRoles.map((role) => [role, `${role}@1`])),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await rt.seedRoleProfileTemplates(ws);
    // 只写 reviewer（新模板，@2）；其余全部 skipped。
    assert.deepEqual(result.written, ["reviewer"]);
    assert.deepEqual(
      result.skipped,
      [...rolesMod.DELIVERY_ROLES].filter((role) => role !== "reviewer"),
    );
    // reviewer.md 逐字节等于新模板；旧文件（含 verifier.md）字节不动。
    assert.equal(
      await readFile(join(ws, ".pi", "agents", "reviewer.md"), "utf8"),
      rt.ROLE_PROFILE_TEMPLATES.reviewer,
      "reviewer.md equals the new template",
    );
    for (const role of oldRoles) {
      assert.equal(
        await readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8"),
        customs.get(role),
        `${role}.md untouched`,
      );
    }
    // 记录：reviewer 记 @2；verifier@1 等旧条目原样保留（未知键不销毁）。
    const record = await readSeedRecord(ws);
    assert.equal(record.roles.reviewer, `reviewer@${rt.ROLE_TEMPLATE_VERSION}`);
    assert.equal(record.roles.verifier, "verifier@1");
    assert.equal(record.roles.designer, "designer@1");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("deleting a seeded profile is final: re-seed skips all, file not recreated, record unchanged", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-delete-"));
  try {
    await rt.seedRoleProfileTemplates(ws);
    const recordBefore = await readSeedRecord(ws);
    await rm(join(ws, ".pi", "agents", "developer.md"));
    const second = await rt.seedRoleProfileTemplates(ws);
    // 已记录 → skipped（删除即终局，产品永不重建）。
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.skipped, [...templatedRoles()]);
    await assert.rejects(
      () => readFile(join(ws, ".pi", "agents", "developer.md"), "utf8"),
      (error) => error.code === "ENOENT",
      "deleted profile must not be recreated",
    );
    assert.deepEqual(await readSeedRecord(ws), recordBefore, "record untouched by re-seed");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("pre-existing user designer.md adopted as existing; user deletion later never re-seeds it", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-adopt-"));
  try {
    await mkdir(join(ws, ".pi", "agents"), { recursive: true });
    const custom = "用户自己的设计师剧本。\n";
    await writeFile(join(ws, ".pi", "agents", "designer.md"), custom, "utf8");
    const first = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(first.written, templatedRoles().filter((role) => role !== "designer"));
    // 收养记录 = "existing"（永不代写）。
    const record = await readSeedRecord(ws);
    assert.equal(record.roles.designer, "existing");
    // 用户随后删掉自己预置的剧本 → 已收养，删除即终局。
    await rm(join(ws, ".pi", "agents", "designer.md"));
    const second = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(second.written, []);
    assert.ok(second.skipped.includes("designer"));
    await assert.rejects(
      () => readFile(join(ws, ".pi", "agents", "designer.md"), "utf8"),
      (error) => error.code === "ENOENT",
      "adopted-then-deleted profile must not be re-seeded",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("legacy workspace (templated files, no record): all adopted as existing, byte-identical, nothing written", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-legacy-"));
  try {
    await mkdir(join(ws, ".pi", "agents"), { recursive: true });
    const customs = new Map();
    for (const role of templatedRoles()) {
      const content = `---\nname: ${role}\n---\n\n${role} 的既有剧本。\n`;
      customs.set(role, content);
      await writeFile(join(ws, ".pi", "agents", `${role}.md`), content, "utf8");
    }
    const result = await rt.seedRoleProfileTemplates(ws);
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.skipped, [...templatedRoles()]);
    assert.deepEqual(
      (await readSeedRecord(ws)).roles,
      Object.fromEntries(templatedRoles().map((role) => [role, "existing"])),
    );
    for (const role of templatedRoles()) {
      assert.equal(
        await readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8"),
        customs.get(role),
        `${role}.md byte-identical`,
      );
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("malformed record: nothing written, all skipped, one console.error, no throw, record untouched", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-bad-record-"));
  try {
    await mkdir(join(ws, ".pi"), { recursive: true });
    const malformed = "{ not json";
    await writeFile(join(ws, ".pi", "delivery-seeded.json"), malformed, "utf8");
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => {
      errors.push(args);
    };
    let result;
    try {
      // fail-safe 不抛：永不重建的承诺压过播种。
      result = await rt.seedRoleProfileTemplates(ws);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.skipped, [...templatedRoles()]);
    assert.equal(errors.length, 1, "fail-safe logs exactly one console.error");
    // 一字不写：agents 目录空、记录原样。
    assert.deepEqual(await readdir(join(ws, ".pi", "agents")), []);
    assert.equal(await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8"), malformed);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ---------------------- 模板另存副本（final-arch step-6 Task 3，2026-10-26）

test("writeRoleTemplateCopy writes the current template to <role>.template.md", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-copy-"));
  try {
    const result = await rt.writeRoleTemplateCopy(ws, "designer");
    assert.equal(result.path, join(ws, ".pi", "agents", "designer.template.md"));
    const onDisk = await readFile(result.path, "utf8");
    // 副本 = 当前内置模板逐字节（frontmatter seeded_from 带版本——出处的依据）。
    assert.equal(onDisk, rt.ROLE_PROFILE_TEMPLATES.designer);
    // .pi/agents 自动创建（全新工作区无该目录）。
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("second writeRoleTemplateCopy conflicts (WorkItemConflictError) and never overwrites", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-copy-conflict-"));
  try {
    const first = await rt.writeRoleTemplateCopy(ws, "developer");
    // 副本在场时人为改动它——二次另存若覆盖会暴露（永不覆盖钉死）。
    await writeFile(first.path, "用户自己的副本。", "utf8");
    await assert.rejects(
      () => rt.writeRoleTemplateCopy(ws, "developer"),
      // moduleCache:false 下 instanceof 跨注册表失效——按构造名断言
      //（delivery.test.mjs 同款习语）。
      (error) => error instanceof Error && error.constructor?.name === "WorkItemConflictError",
      "second save-as must throw WorkItemConflictError",
    );
    assert.equal(await readFile(first.path, "utf8"), "用户自己的副本。", "existing copy untouched");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("writeRoleTemplateCopy never touches <role>.md or the seeding record", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-tpl-copy-isolation-"));
  try {
    // 先播种（<role>.md + 记录落盘），再另存 designer 副本。
    await rt.seedRoleProfileTemplates(ws);
    const profileBefore = await readFile(join(ws, ".pi", "agents", "designer.md"), "utf8");
    const recordBefore = await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8");
    await rt.writeRoleTemplateCopy(ws, "designer");
    assert.equal(
      await readFile(join(ws, ".pi", "agents", "designer.md"), "utf8"),
      profileBefore,
      "<role>.md byte-identical before/after save-as",
    );
    assert.equal(
      await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8"),
      recordBefore,
      "seeding record untouched by save-as",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
