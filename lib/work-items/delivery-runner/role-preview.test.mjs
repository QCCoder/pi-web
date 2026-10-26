// Seam-repositioning Task 4（2026-10-26）：角色摘要与组合预览的只读投影
// （role-preview.ts）——功能测试（真临时 fs）：
//   1. summarizeRoles：四行且序固定（DELIVERY_ROLES 序）；explicit vs 同名缺省
//      （profile.name = resolveRoleProfileName，explicit = 配置了
//      roles.<role>.profile）；exists 随文件；seededFrom 取自 frontmatter
//      seeded_from（缺 → 键省略）；model 三态与优先级（覆写压剧本、剧本压默认
//      ——与 launch 完全一致）；config null = 全角色缺省（同名/非显式/default）。
//   2. previewRolePrompt：composed 与 composeRoleSystemPrompt 逐字相等（预览
//      与 launch 同一函数——杜绝「预览与实际不一致」）；invariant 以
//      `# 交付回合不变式` 开头且含 `<KEY>` 占位；agentsMd 缺 → null、在 → 全文；
//      剧本缺 → body ""（composed = 仅不变式）。
//   3. final-fix D：读取器抛错（deps.readProfile 注入缝）→ 两条投影都按缺场
//      降级（exists:false / default / body "" / composed = 不变式），每次读盘
//      失败恰一条 console.error——预览恰一条同时钉死 final-fix C 的单次读盘。
// 路由层的接线（薄壳）在 routes.test.mjs 的源断言用例。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const preview = await jiti.import("./role-preview.ts");
const roleSession = await jiti.import("./role-session.ts");
const rolesMod = await jiti.import("./roles.ts");

async function makeWorkspace() {
  const ws = await mkdtemp(join(tmpdir(), "pi-role-preview-"));
  await mkdir(join(ws, ".pi", "agents"), { recursive: true });
  return ws;
}

async function writeProfile(ws, name, content) {
  await writeFile(join(ws, ".pi", "agents", `${name}.md`), content, "utf8");
}

test("summarizeRoles: four rows in DELIVERY_ROLES order with explicit/exists/seededFrom/model semantics", async (t) => {
  const ws = await makeWorkspace();
  t.after(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  // designer：同名剧本在场（frontmatter model + seeded_from）。
  await writeProfile(
    ws,
    "designer",
    "---\nname: designer\nseeded_from: \"designer@1\"\nmodel: zai/glm-4.7\n---\n\n设计师剧本正文。\n",
  );
  // developer：别名剧本（config 显式 profile）在场，无 model / seeded_from。
  await writeProfile(ws, "analyst", "---\nname: analyst\n---\n\n分析师剧本正文。\n");
  // verifier / release-preparer：无文件。

  const config = {
    schemaVersion: 2,
    enabled: true,
    roles: {
      designer: { model: { provider: "openai", modelId: "gpt-5" } },
      developer: { profile: "analyst" },
    },
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  };
  const rows = preview.summarizeRoles(ws, config);

  assert.deepEqual(rows.map((row) => row.role), [...rolesMod.DELIVERY_ROLES], "DELIVERY_ROLES order");

  const designer = rows[0];
  assert.equal(designer.profile.name, "designer"); // 缺省同名
  assert.equal(designer.profile.explicit, false); // 未配置 roles.designer.profile
  assert.equal(designer.profile.exists, true);
  assert.equal(designer.profile.seededFrom, "designer@1");
  assert.equal(designer.profile.path, join(ws, ".pi", "agents", "designer.md"));
  // 模型优先级 1：config 覆写压剧本 frontmatter model。
  assert.equal(designer.model.source, "override");
  assert.deepEqual(designer.model.effective, { provider: "openai", modelId: "gpt-5" });

  const developer = rows[1];
  assert.equal(developer.profile.name, "analyst"); // 显式别名
  assert.equal(developer.profile.explicit, true);
  assert.equal(developer.profile.exists, true);
  assert.equal(developer.profile.seededFrom, undefined); // frontmatter 无 seeded_from → 键省略
  assert.equal(developer.profile.path, join(ws, ".pi", "agents", "analyst.md"));
  // 模型优先级 2：无覆写 → 剧本 frontmatter model（该剧本无 model → default）。
  assert.equal(developer.model.source, "default");
  assert.equal(developer.model.effective, undefined);

  const verifier = rows[2];
  assert.equal(verifier.profile.name, "verifier");
  assert.equal(verifier.profile.explicit, false);
  assert.equal(verifier.profile.exists, false); // 无文件
  assert.equal(verifier.model.source, "default");

  const releasePreparer = rows[3];
  assert.equal(releasePreparer.profile.name, "release-preparer");
  assert.equal(releasePreparer.profile.exists, false);
  assert.equal(releasePreparer.model.source, "default");
});

test("summarizeRoles: profile frontmatter model is the source when config omits override; config null = all defaults", async (t) => {
  const ws = await makeWorkspace();
  t.after(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  await writeProfile(
    ws,
    "designer",
    "---\nmodel: glm-4.7\n---\n\n正文。\n",
  );
  // 优先级 2：剧本 frontmatter model（裸 modelId 形原样透传）。
  const withProfileModel = preview.summarizeRoles(ws, {
    schemaVersion: 2,
    enabled: false,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
  assert.equal(withProfileModel[0].model.source, "profile");
  assert.deepEqual(withProfileModel[0].model.effective, { modelId: "glm-4.7" });

  // config === null（.pi/delivery.yaml 缺失）：每个角色同名、非显式；模型解析
  // 与 launch 完全一致——剧本 frontmatter model 照样生效（同名剧本无配置也压
  // 默认），其余角色 default。
  const rows = preview.summarizeRoles(ws, null);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.profile.name, row.role);
    assert.equal(row.profile.explicit, false);
    if (row.role === "designer") continue;
    assert.equal(row.model.source, "default");
    assert.equal(row.model.effective, undefined);
  }
  // designer 剧本文件在场（model 解析照样走 profile → effective 在、source profile）。
  assert.equal(rows[0].profile.exists, true);
  assert.equal(rows[0].model.source, "profile");
});

test("previewRolePrompt: composed === composeRoleSystemPrompt verbatim; invariant header + <KEY>; agentsMd null-or-full; missing profile → empty body", async (t) => {
  const ws = await makeWorkspace();
  t.after(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  await writeProfile(ws, "designer", "---\nmodel: zai/glm-4.7\n---\n\n设计师剧本正文。\n");
  await writeProfile(ws, "analyst", "别名剧本（无 frontmatter）。\n");
  // AGENTS.md 缺席 → agentsMd null（verifier 预览）。

  const config = {
    schemaVersion: 2,
    enabled: true,
    roles: { developer: { profile: "analyst" } },
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  };

  // 有剧本：composed = 不变式（key 用 <KEY> 占位）+ 剧本正文，与 launch 同一函数。
  const designerPreview = preview.previewRolePrompt(ws, "designer", config);
  assert.equal(
    designerPreview.composed,
    roleSession.composeRoleSystemPrompt(
      { role: "designer", key: "<KEY>" },
      await roleSession.readRoleProfile(ws, "designer"),
    ),
  );
  assert.ok(designerPreview.invariant.startsWith("# 交付回合不变式"));
  assert.ok(designerPreview.invariant.includes("<KEY>"));
  assert.equal(designerPreview.body, "设计师剧本正文。");
  assert.ok(designerPreview.composed.includes("设计师剧本正文。"));
  assert.equal(designerPreview.agentsMd, null, "AGENTS.md missing → null");
  // 摘要字段随行（RolePromptPreview extends RoleSummary）。
  assert.equal(designerPreview.profile.exists, true);
  assert.equal(designerPreview.model.source, "profile");

  // 别名剧本（developer → analyst，无 frontmatter）。
  const developerPreview = preview.previewRolePrompt(ws, "developer", config);
  assert.equal(developerPreview.profile.name, "analyst");
  assert.equal(developerPreview.body, "别名剧本（无 frontmatter）。");
  assert.equal(developerPreview.model.source, "default");

  // 剧本缺场（verifier）：body ""、composed = 仅不变式（无尾分隔）。
  const verifierPreview = preview.previewRolePrompt(ws, "verifier", config);
  assert.equal(verifierPreview.body, "");
  assert.equal(verifierPreview.composed, verifierPreview.invariant);
  assert.equal(verifierPreview.profile.exists, false);

  // AGENTS.md 在场 → agentsMd = 全文（仅展示；不进 composed）。
  const agentsMd = "# 工作区守则\n\n项目事实写在这里。\n";
  await writeFile(join(ws, "AGENTS.md"), agentsMd, "utf8");
  const withAgents = preview.previewRolePrompt(ws, "designer", config);
  assert.equal(withAgents.agentsMd, agentsMd);
  assert.ok(!withAgents.composed.includes("工作区守则"), "AGENTS.md is display-only, not composed");

  // config null 同样可预览（全缺省语义）。
  const nullConfigPreview = preview.previewRolePrompt(ws, "designer", null);
  assert.equal(nullConfigPreview.model.source, "profile");
  assert.equal(nullConfigPreview.profile.explicit, false);
});

// ---------------------- 读取器抛错路径（final-fix D，2026-10-26）

test("readProfile throwing: projections degrade to absent profile, one console.error per read", async (t) => {
  const ws = await makeWorkspace();
  t.after(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  // 剧本文件在场也无妨——读取器抛错一律按缺场（与 launch「读盘异常当缺场」
  // 同口径：文件在但读不到 ≠ 有剧本）。
  await writeProfile(ws, "designer", "---\nmodel: zai/glm-4.7\n---\n\n设计师剧本正文。\n");
  const throwing = () => {
    throw new Error("disk on fire");
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    // summarizeRoles：四行全部 exists:false / source:default / effective 缺省
    // （每角色恰一次读盘失败 → 四条 console.error）。
    const rows = preview.summarizeRoles(ws, null, { readProfile: throwing });
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.profile.exists, false);
      assert.equal(row.model.source, "default");
      assert.equal(row.model.effective, undefined);
    }
    assert.equal(errors.length, 4, "one console.error per role read");
    // previewRolePrompt：摘要与正文共用同一次读取（final-fix C 单次读盘）→
    // 恰一条 console.error；body "" 且 composed 退化为仅不变式。
    errors.length = 0;
    const thrown = preview.previewRolePrompt(ws, "designer", null, { readProfile: throwing });
    assert.equal(thrown.profile.exists, false);
    assert.equal(thrown.model.source, "default");
    assert.equal(thrown.body, "");
    assert.equal(thrown.composed, thrown.invariant);
    assert.equal(errors.length, 1, "preview reads the profile exactly once");
  } finally {
    console.error = originalError;
  }
});
