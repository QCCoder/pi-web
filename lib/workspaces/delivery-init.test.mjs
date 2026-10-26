// final-arch step-6 Task 1（2026-10-26）：交付初始化（只补缺、只建议）+ 就绪
// 清单投影。真临时工作区（createWorkspace 同 service.test.mjs 惯例），行为面：
//   1. 空工作区 init：delivery.yaml v2 默认（enabled false）、四剧本播种、动作
//      清单、就绪 = no-checks（能力齐全时仅此一项）；input.checks 落盘。
//   2. 幂等：二次 init 全 skipped/unchanged（文件字节 + mtime 不动）；
//      enabled:true 既有配置永不翻。
//   3. from 同布局目录：复制先于播种（spec §13.2 步骤 5：源提供的角色 from 赢、
//      源缺的播种兜底——C1 回归钉死），角色缺文件才复制（seeded_from 剥换
//      copied_from——带版
//      本源透传版本、无 seeded_from 的 frontmatter 插 copied_from: <role>、无
//      frontmatter 原文）、integrate.sh 复制、AGENTS.md / delivery.yaml 永不复
//      制（from checks 剥 repositoryId 只进 suggestedChecks）、既有目标永不覆
//      盖；预置用户 designer.md 播种收养 + from 都不覆盖。
//   4. 工具链探测：登记活跃 code 仓 × 根 marker 文件 → 草稿进响应（带
//      repositoryId），从不落盘；knowledge 仓不探测。
//   5. readiness 五类缺项各自出现/消失；路由：POST 门（assertAutomationCapable）、
//      GET 只读无门（源断言，routes.test.mjs 同款惯例）。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorkspace, readWorkspaceManifest } from "./service.ts";
import { deliveryReadiness, initializeDelivery } from "./delivery-init.ts";
import {
  parseDeliveryRunnerConfig,
  readDeliveryRunnerConfig,
  writeDeliveryRunnerConfig,
} from "../work-items/delivery-runner/config.ts";
import { ROLE_TEMPLATE_VERSION } from "../work-items/delivery-runner/role-templates.ts";

const execFileAsync = promisify(execFile);

async function rmWithRetry(target, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** 真临时工作区（capability 驱动创建，同 service.test.mjs 惯例）。 */
async function workspaceFixture(t, capabilities = ["work-items", "workflows"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-delivery-init-"));
  t.after(() => rmWithRetry(root));
  const summary = await createWorkspace({ name: "Delivery", slug: "delivery", capabilities }, root);
  return summary.path;
}

async function makeGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
}

/** from 源：同布局目录（.pi/ 齐全；三个角色文件覆盖 copied_from 三分支）。 */
async function writeSourceLayout(sourceRoot) {
  const pi = join(sourceRoot, ".pi");
  await mkdir(join(pi, "agents"), { recursive: true });
  await mkdir(join(pi, "scripts"), { recursive: true });
  // 带版本 seeded_from（旧模板 v1）→ copied_from 原样透传出处。
  await writeFile(
    join(pi, "agents", "developer.md"),
    '---\nname: developer\ndescription: team developer\nseeded_from: "developer@1"\n---\n\nTeam developer playbook body.\n',
  );
  // 无 seeded_from 的 frontmatter → 块首插 copied_from: <role>。
  await writeFile(
    join(pi, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: team reviewer\n---\n\nTeam reviewer playbook body.\n",
  );
  // 无 frontmatter → 原文复制。
  await writeFile(
    join(pi, "agents", "release-preparer.md"),
    "# Plain release-preparer playbook\n\nNo frontmatter at all.\n",
  );
  await writeFile(join(pi, "scripts", "integrate.sh"), "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  // from 的 delivery.yaml：checks 带 repositoryId —— 只进 suggestedChecks（剥除），永不落盘。
  await writeFile(
    join(pi, "delivery.yaml"),
    "schemaVersion: 2\nenabled: true\nverification:\n  checks:\n    - name: api\n      command: dotnet test\n      repositoryId: src-repo\n    - name: smoke\n      command: make check\n",
  );
  await writeFile(join(sourceRoot, "AGENTS.md"), "# Source project facts — must not propagate\n");
  return pi;
}

test("empty workspace init writes default delivery.yaml, seeds four profiles and reports actions", async (t) => {
  const ws = await workspaceFixture(t);
  const result = await initializeDelivery(ws, {});

  // delivery.yaml v2 默认：enabled 恒 false、阶段全关、预算/attention 缺省、无 verification。
  const config = await readDeliveryRunnerConfig(ws);
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.enabled, false);
  assert.deepEqual(config.stages, {
    review: { enabled: false },
    integrate: { enabled: false },
    acceptance: { enabled: false },
  });
  assert.deepEqual(config.budget, { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 });
  assert.deepEqual(config.attention, { nudgeAfterDays: 3, parkAfterDays: 7 });
  assert.deepEqual(config.roles, {});
  assert.equal(config.verification, undefined);

  // 四剧本播种（frontmatter seeded_from: "<role>@<版本>"）。
  for (const role of ["designer", "developer", "reviewer", "release-preparer"]) {
    const content = await readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8");
    assert.match(content, new RegExp(`seeded_from: "${role}@${ROLE_TEMPLATE_VERSION}"`));
  }

  // 动作清单：写默认配置 + 播种全集 + 扫描登记。
  assert.ok(result.actions.includes("config: 写入默认 delivery.yaml（enabled: false）"));
  assert.ok(
    result.actions.includes("profiles: 播种 designer、developer、reviewer、release-preparer"),
    "seeding folded into actions",
  );
  assert.ok(result.actions.some((line) => line.startsWith("repositories: ")));
  // 空工作区、能力齐全、checks 未给 → 就绪仅 no-checks 一项。
  assert.deepEqual(result.readiness.map((item) => item.kind), ["no-checks"]);
  // 无 from、无登记仓 → 无草稿（键整个缺席）。
  assert.equal(result.suggestedChecks, undefined);
});

test("input.checks are validated and written into the config on first init", async (t) => {
  const ws = await workspaceFixture(t);
  await initializeDelivery(ws, {
    checks: [
      { name: "unit", command: "npm test", repositoryId: "repo-1" },
      { name: "lint", command: "eslint .", timeout_seconds: 120 },
    ],
  });
  const config = await readDeliveryRunnerConfig(ws);
  // 可选字段缺席时键整个剥掉（parseDeliveryRunnerConfig 同一习语）。
  assert.deepEqual(config.verification.checks, [
    { name: "unit", repositoryId: "repo-1", command: "npm test" },
    { name: "lint", command: "eslint .", timeout_seconds: 120 },
  ]);
});

test("stages flags from input land in the written config (never enabled overall)", async (t) => {
  const ws = await workspaceFixture(t);
  await initializeDelivery(ws, {
    stagesReview: true,
    integrate: { enabled: true, command: "./scripts/merge.sh" },
    acceptance: { enabled: true },
  });
  const config = await readDeliveryRunnerConfig(ws);
  assert.equal(config.enabled, false, "init never flips the global switch");
  assert.deepEqual(config.stages, {
    review: { enabled: true },
    integrate: { enabled: true, command: "./scripts/merge.sh" },
    acceptance: { enabled: true },
  });
});

test("second init is idempotent: no file rewritten, actions report unchanged", async (t) => {
  const ws = await workspaceFixture(t);
  await initializeDelivery(ws, {});

  const watched = [
    join(ws, ".pi", "delivery.yaml"),
    join(ws, ".pi", "delivery-seeded.json"),
    ...["designer", "developer", "reviewer", "release-preparer"].map((role) =>
      join(ws, ".pi", "agents", `${role}.md`)),
  ];
  const before = [];
  for (const path of watched) {
    before.push({ bytes: await readFile(path), mtimeMs: (await stat(path)).mtimeMs });
  }

  const second = await initializeDelivery(ws, {});
  for (let i = 0; i < watched.length; i++) {
    const after = await stat(watched[i]);
    assert.deepEqual(await readFile(watched[i]), before[i].bytes, `${watched[i]} bytes unchanged`);
    assert.equal(after.mtimeMs, before[i].mtimeMs, `${watched[i]} mtime unchanged`);
  }
  assert.ok(second.actions.includes("config: 已存在，未改动"));
  assert.ok(
    second.actions.includes("profiles: 跳过（已播种或已存在）designer、developer、reviewer、release-preparer"),
    "seeding skipped folded into actions",
  );
  assert.equal(second.actions.some((line) => line.includes("复制")), false, "no copy lines without from");
});

test("init does not flip an existing enabled:true config", async (t) => {
  const ws = await workspaceFixture(t);
  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({
      schemaVersion: 2,
      enabled: true,
      verification: { checks: [{ name: "unit", command: "npm test" }] },
    }),
  );
  const before = await readFile(join(ws, ".pi", "delivery.yaml"));
  const result = await initializeDelivery(ws, {});
  assert.equal((await readDeliveryRunnerConfig(ws)).enabled, true);
  assert.deepEqual(await readFile(join(ws, ".pi", "delivery.yaml")), before, "config bytes untouched");
  assert.ok(result.actions.includes("config: 已存在，未改动"));
});

test("from copies missing roles with copied_from markers, integrate.sh, and suggests checks stripped of repositoryId", async (t) => {
  const ws = await workspaceFixture(t);
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-delivery-from-"));
  t.after(() => rmWithRetry(sourceRoot));
  const sourcePi = await writeSourceLayout(sourceRoot);

  // 第一遍 init（无 from）：四剧本播种 + 一次性记录。
  await initializeDelivery(ws, {});
  // 用户删掉 developer / reviewer / release-preparer（记录仍在——删除即终局，
  // 不重建）；designer 留场（源也无 designer 源文件）。
  const seededDesigner = await readFile(join(ws, ".pi", "agents", "designer.md"));
  await rm(join(ws, ".pi", "agents", "developer.md"));
  await rm(join(ws, ".pi", "agents", "reviewer.md"));
  await rm(join(ws, ".pi", "agents", "release-preparer.md"));
  const agentsMdBefore = await readFile(join(ws, "AGENTS.md"));

  const result = await initializeDelivery(ws, { from: sourceRoot });

  // 带版本源：seeded_from 剥换 copied_from（版本原样透传），正文保留。
  const developerCopy = await readFile(join(ws, ".pi", "agents", "developer.md"), "utf8");
  assert.match(developerCopy, /copied_from: "developer@1"/);
  assert.doesNotMatch(developerCopy, /seeded_from/);
  assert.match(developerCopy, /Team developer playbook body\./);
  // 无 seeded_from 的 frontmatter：块首插 copied_from: <role>，其余键保留。
  const reviewerCopy = await readFile(join(ws, ".pi", "agents", "reviewer.md"), "utf8");
  assert.match(reviewerCopy, /copied_from: reviewer/);
  assert.doesNotMatch(reviewerCopy, /seeded_from/);
  assert.match(reviewerCopy, /description: team reviewer/);
  // 无 frontmatter：原文逐字节复制。
  assert.equal(
    await readFile(join(ws, ".pi", "agents", "release-preparer.md"), "utf8"),
    await readFile(join(sourcePi, "agents", "release-preparer.md"), "utf8"),
  );
  // 既有目标永不覆盖：designer 维持本轮播种的模板字节（源里也没有 designer）。
  assert.deepEqual(await readFile(join(ws, ".pi", "agents", "designer.md")), seededDesigner);
  // integrate.sh 骨架复制。
  assert.equal(
    await readFile(join(ws, ".pi", "scripts", "integrate.sh"), "utf8"),
    await readFile(join(sourcePi, "scripts", "integrate.sh"), "utf8"),
  );
  // AGENTS.md / delivery.yaml 永不从 from 复制。
  assert.deepEqual(await readFile(join(ws, "AGENTS.md")), agentsMdBefore);
  const yamlText = await readFile(join(ws, ".pi", "delivery.yaml"), "utf8");
  assert.ok(!yamlText.includes("dotnet test"), "from checks never written to target config");
  assert.ok(!yamlText.includes("repositoryId: src-repo"));

  // from checks 剥 repositoryId 进 suggestedChecks（供人确认——不落盘）。
  assert.deepEqual(result.suggestedChecks, [
    { name: "api", command: "dotnet test" },
    { name: "smoke", command: "make check" },
  ]);
  // 动作清单：三个复制行，designer（目标在场）无复制行。
  assert.ok(result.actions.includes("from: 复制 developer.md"));
  assert.ok(result.actions.includes("from: 复制 reviewer.md"));
  assert.ok(result.actions.includes("from: 复制 release-preparer.md"));
  assert.equal(result.actions.includes("from: 复制 designer.md"), false);
  assert.ok(result.actions.includes("config: 已存在，未改动"));

  // 幂等：再跑一遍 from —— 目标全齐、源仍在：一个都不复制，动作行如实归因
  // （目标在场，而非「源无可复制项」）。
  const third = await initializeDelivery(ws, { from: sourceRoot });
  assert.ok(third.actions.includes("from: 目标均已存在，未复制"));
  assert.equal(third.actions.includes("from: 无可复制项，未复制"), false);
  assert.deepEqual(await readFile(join(ws, ".pi", "agents", "developer.md"), "utf8"), developerCopy);
});

// final-fix wave（2026-10-26，C1 回归）：spec §13.2 步骤 5——播种（§6.2）**或**
// 自 from 复制（§13.3）：from 给定时源提供的角色复制优先（先于播种执行），源
// 缺的角色才落到播种兜底。此前播种先行把四角色全写盘 + 记录，from 复制被
// seedWritten 全量跳过——fresh 工作区上 from 永远复制不到任何东西。
test("fresh workspace with from: source playbooks win over seeding, missing roles fall back to templates", async (t) => {
  const ws = await workspaceFixture(t);
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-delivery-from-fresh-"));
  t.after(() => rmWithRetry(sourceRoot));
  const pi = join(sourceRoot, ".pi");
  await mkdir(join(pi, "agents"), { recursive: true });
  // 自带 developer（正文与内置模板不同）——from 必须赢过播种；reviewer 等其余
  // 角色源里没有 → 播种兜底。
  const customDeveloper =
    '---\nname: developer\ndescription: team developer\nseeded_from: "developer@1"\n---\n\nTeam developer playbook body — NOT the built-in template.\n';
  await writeFile(join(pi, "agents", "developer.md"), customDeveloper);

  const result = await initializeDelivery(ws, { from: sourceRoot });

  // developer == 源正文 + copied_from（seeded_from 剥换，版本透传），内置模板一字不沾。
  const developer = await readFile(join(ws, ".pi", "agents", "developer.md"), "utf8");
  assert.match(developer, /copied_from: "developer@1"/);
  assert.doesNotMatch(developer, /seeded_from/);
  assert.match(developer, /Team developer playbook body — NOT the built-in template\./);
  assert.doesNotMatch(developer, /开发者剧本/);
  // 源缺 reviewer → 播种兜底：内置模板 + seeded_from 带版本。
  const reviewer = await readFile(join(ws, ".pi", "agents", "reviewer.md"), "utf8");
  assert.match(reviewer, new RegExp(`seeded_from: "reviewer@${ROLE_TEMPLATE_VERSION}"`));
  // 一次性播种记录：developer 按预置收养记 existing，reviewer 记产品播种版本。
  const record = JSON.parse(await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8"));
  assert.equal(record.roles.developer, "existing");
  assert.equal(record.roles.reviewer, `reviewer@${ROLE_TEMPLATE_VERSION}`);
  // 动作行如实：developer 是复制行、reviewer 落播种行；无「无可复制项」误报。
  assert.ok(result.actions.includes("from: 复制 developer.md"));
  assert.ok(result.actions.includes("profiles: 播种 designer、reviewer、release-preparer"));
  assert.ok(result.actions.includes("profiles: 跳过（已播种或已存在）developer"));
  assert.equal(result.actions.includes("from: 无可复制项，未复制"), false);
});

test("from without any role files: seeding covers all four (fallback) and the action line says so", async (t) => {
  const ws = await workspaceFixture(t);
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-delivery-from-empty-"));
  t.after(() => rmWithRetry(sourceRoot));
  await mkdir(join(sourceRoot, ".pi"), { recursive: true }); // .pi/ 在场但无角色剧本

  const result = await initializeDelivery(ws, { from: sourceRoot });

  // 源真的没有可复制项 → 动作行如实；四角色全走播种兜底。
  assert.ok(result.actions.includes("from: 无可复制项，未复制"));
  assert.ok(result.actions.includes("profiles: 播种 designer、developer、reviewer、release-preparer"));
  for (const role of ["designer", "developer", "reviewer", "release-preparer"]) {
    const content = await readFile(join(ws, ".pi", "agents", `${role}.md`), "utf8");
    assert.match(content, new RegExp(`seeded_from: "${role}@${ROLE_TEMPLATE_VERSION}"`));
  }
  const record = JSON.parse(await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8"));
  assert.equal(record.roles.developer, `developer@${ROLE_TEMPLATE_VERSION}`);
});

test("preset user designer.md survives seeding adoption and from-copy", async (t) => {
  const ws = await workspaceFixture(t);
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-delivery-from-"));
  t.after(() => rmWithRetry(sourceRoot));
  await writeSourceLayout(sourceRoot);

  await mkdir(join(ws, ".pi", "agents"), { recursive: true });
  const preset = "# My own designer playbook\n\nHands off.\n";
  await writeFile(join(ws, ".pi", "agents", "designer.md"), preset);

  await initializeDelivery(ws, {});
  assert.equal(await readFile(join(ws, ".pi", "agents", "designer.md"), "utf8"), preset, "seeding adopts, never writes");
  const record = JSON.parse(await readFile(join(ws, ".pi", "delivery-seeded.json"), "utf8"));
  assert.equal(record.roles.designer, "existing", "preset adopted as existing in the seed record");

  await initializeDelivery(ws, { from: sourceRoot });
  assert.equal(
    await readFile(join(ws, ".pi", "agents", "designer.md"), "utf8"),
    preset,
    "from never overwrites an existing target",
  );
});

test("toolchain probe drafts per marker file per registered code repo, never on disk", async (t) => {
  const ws = await workspaceFixture(t);
  await makeGitRepo(join(ws, "svc"));
  await writeFile(join(ws, "svc", "package.json"), "{}\n");
  await writeFile(join(ws, "svc", "pom.xml"), "<project/>\n");
  await makeGitRepo(join(ws, "lib"));
  await writeFile(join(ws, "lib", "go.mod"), "module example.com/lib\n");
  // OKF 知识库（index.md + log.md）→ 登记 kind knowledge，不探测。
  await mkdir(join(ws, "docs"));
  await writeFile(join(ws, "docs", "index.md"), "# k\n");
  await writeFile(join(ws, "docs", "log.md"), "# l\n");

  const result = await initializeDelivery(ws, {});
  const manifest = await readWorkspaceManifest(ws);
  const byAlias = Object.fromEntries(manifest.repositories.map((repo) => [repo.alias, repo]));
  assert.equal(byAlias.docs.kind, "knowledge");
  assert.ok(result.actions.includes("repositories: 扫描登记更新"));

  // 每 marker × 每登记 code 仓一条（manifest 序：docs 排除；svc 双 marker 两条）。
  assert.deepEqual(result.suggestedChecks, [
    { name: "lib", repositoryId: byAlias.lib.id, command: "go test ./..." },
    { name: "svc", repositoryId: byAlias.svc.id, command: "mvn -q test" },
    { name: "svc", repositoryId: byAlias.svc.id, command: "npm test" },
  ]);
  // 探测从不落盘：首次写默认配置不带 verification。
  const config = await readDeliveryRunnerConfig(ws);
  assert.equal(config.verification, undefined);
  const yamlText = await readFile(join(ws, ".pi", "delivery.yaml"), "utf8");
  assert.ok(!yamlText.includes("npm test"));
  assert.ok(!yamlText.includes("mvn"));
});

test("readiness: no-checks and missing-profile appear and clear; explicit roles.<role>.profile respected", async (t) => {
  const ws = await workspaceFixture(t);

  // 全新工作区（无配置无剧本）：no-checks + 四角色 missing-profile，词表序。
  const fresh = await deliveryReadiness(ws);
  assert.equal(fresh.currentTemplateVersion, ROLE_TEMPLATE_VERSION);
  assert.deepEqual(
    fresh.items.map((item) => item.kind),
    [
      "no-checks",
      "missing-profile:designer",
      "missing-profile:developer",
      "missing-profile:reviewer",
      "missing-profile:release-preparer",
    ],
  );

  // init 后：剧本齐了，只剩 no-checks。
  await initializeDelivery(ws, {});
  const afterInit = await deliveryReadiness(ws);
  assert.deepEqual(afterInit.items.map((item) => item.kind), ["no-checks"]);

  // 显式 roles.<role>.profile：指向的文件缺失才算缺（同名 designer.md 在场不算数）。
  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({
      schemaVersion: 2,
      enabled: false,
      roles: { designer: { profile: "custom-designer" } },
    }),
  );
  const explicit = await deliveryReadiness(ws);
  const designerItem = explicit.items.find((item) => item.kind === "missing-profile:designer");
  assert.ok(designerItem, "explicit profile missing is reported");
  assert.match(designerItem.detail, /custom-designer/);
  await writeFile(join(ws, ".pi", "agents", "custom-designer.md"), "---\nname: custom-designer\n---\n\nbody\n");
  const resolved = await deliveryReadiness(ws);
  assert.equal(resolved.items.some((item) => item.kind === "missing-profile:designer"), false);

  // checks 配置后 no-checks 消失。
  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({
      schemaVersion: 2,
      enabled: false,
      verification: { checks: [{ name: "unit", command: "npm test" }] },
    }),
  );
  const withChecks = await deliveryReadiness(ws);
  assert.equal(withChecks.items.some((item) => item.kind === "no-checks"), false);

  // 空数组 = 等同无配置 → no-checks 回归。
  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({ schemaVersion: 2, enabled: false, verification: { checks: [] } }),
  );
  const emptyChecks = await deliveryReadiness(ws);
  assert.ok(emptyChecks.items.some((item) => item.kind === "no-checks"));
});

test("readiness: capabilities-missing lists what is absent", async (t) => {
  const ws = await workspaceFixture(t, ["sessions"]);
  const readiness = await deliveryReadiness(ws);
  const item = readiness.items.find((entry) => entry.kind === "capabilities-missing");
  assert.ok(item, "capabilities-missing reported");
  assert.match(item.detail, /work-items/);
  assert.match(item.detail, /workflows/);
});

test("readiness: check-repo-unregistered per configured check pointing outside the registry", async (t) => {
  const ws = await workspaceFixture(t);
  await makeGitRepo(join(ws, "svc"));
  await initializeDelivery(ws, {}); // 触发扫描登记 svc
  const manifest = await readWorkspaceManifest(ws);
  const svcId = manifest.repositories.find((repo) => repo.alias === "svc").id;

  await writeDeliveryRunnerConfig(
    ws,
    parseDeliveryRunnerConfig({
      schemaVersion: 2,
      enabled: false,
      verification: {
        checks: [
          { name: "ghost", command: "make ghost", repositoryId: "nope" },
          { name: "bound", command: "make bound", repositoryId: svcId },
          { name: "default-repo", command: "make default" },
        ],
      },
    }),
  );
  const readiness = await deliveryReadiness(ws);
  const unregistered = readiness.items.filter((item) => item.kind === "check-repo-unregistered");
  assert.equal(unregistered.length, 1, "only the unregistered binding is flagged");
  assert.match(unregistered[0].detail, /ghost/);
  assert.match(unregistered[0].detail, /nope/);
});

test("readiness: integrate-no-command detected in configs the strict parser rejects", async (t) => {
  const ws = await workspaceFixture(t);
  await mkdir(join(ws, ".pi"), { recursive: true });
  // 手写 yaml：integrate 开着但无 command —— readDeliveryRunnerConfig 会 Validation，
  // readiness（非门禁投影）仍要能报出缺项而不是炸掉。
  await writeFile(
    join(ws, ".pi", "delivery.yaml"),
    "schemaVersion: 2\nenabled: false\nstages:\n  integrate:\n    enabled: true\n",
  );
  await assert.rejects(readDeliveryRunnerConfig(ws));
  const readiness = await deliveryReadiness(ws);
  const item = readiness.items.find((entry) => entry.kind === "integrate-no-command");
  assert.ok(item, "integrate enabled without command is reported even when strict parse fails");
});

test("init rejects a from directory without a .pi/ layout", async (t) => {
  const ws = await workspaceFixture(t);
  const bare = await mkdtemp(join(tmpdir(), "pi-delivery-bare-"));
  t.after(() => rmWithRetry(bare));
  await assert.rejects(initializeDelivery(ws, { from: bare }), /\.pi/);
});

// ---- 路由接线（源断言，routes.test.mjs 同款惯例——行为由上方服务用例覆盖）----

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const INIT_ROUTE = "../../app/api/workspaces/[id]/delivery/init/route.ts";
const READINESS_ROUTE = "../../app/api/workspaces/[id]/delivery/readiness/route.ts";

test("init route: POST with automation capability gate, thin shell over initializeDelivery", async () => {
  const src = await read(INIT_ROUTE);
  assert.ok(src.trim().length > 0, `${INIT_ROUTE} exists and is non-empty`);
  assert.match(src, /export async function POST/);
  assert.doesNotMatch(src, /export async function (GET|PUT|PATCH|DELETE)/);
  assert.match(src, /getWorkspace/);
  assert.match(src, /assertAutomationCapable/);
  assert.match(src, /parseInitInput/);
  assert.match(src, /initializeDelivery\(path/);
  assert.match(src, /workItemErrorResponse/);
});

test("readiness route: GET only, read-only, no capability gate", async () => {
  const src = await read(READINESS_ROUTE);
  assert.ok(src.trim().length > 0, `${READINESS_ROUTE} exists and is non-empty`);
  assert.match(src, /export async function GET/);
  assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(src, /assertAutomationCapable/);
  assert.match(src, /deliveryReadiness\(path/);
  assert.match(src, /workItemErrorResponse/);
});

test("response mirror types live in api-types (single definition, type-only import)", async () => {
  const src = await read("./delivery-init.ts");
  assert.match(src, /from "\.\.\/api-types\.ts"/);
  const mirror = await read("../../lib/api-types.ts");
  for (const name of ["DeliverySuggestedCheck", "DeliveryReadinessItem", "DeliveryInitResponse", "DeliveryReadinessResponse"]) {
    assert.match(mirror, new RegExp(`interface ${name}\\b`), `${name} mirrored in api-types`);
  }
});
