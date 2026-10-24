// Phase-2 Task 1: 工作区交付配置 `.pi/delivery.yaml`。
// parse 校验/默认值回填、read/write round-trip（mkdtemp 真临时工作区）、
// capability 门控；GET|PUT 路由用 source 断言（capabilities 先于写入检查、
// 坏 JSON → WorkItemValidationError → 400 经 workItemErrorResponse）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const dt = await jiti.import("./config.ts");

const ROUTE_PATH = new URL(
  "../../../app/api/workspaces/[id]/delivery/route.ts",
  import.meta.url,
);

test("default config is schemaVersion 1 / disabled / empty roles / budget 3-30", () => {
  assert.deepEqual(dt.DEFAULT_DELIVERY_RUNNER_CONFIG, {
    schemaVersion: 1,
    enabled: false,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
});

test("parse fills defaults and rejects unknown schemaVersion", () => {
  const cfg = dt.parseDeliveryRunnerConfig({ schemaVersion: 1, enabled: true });
  assert.equal(cfg.budget.maxAttemptsPerInput, 3);
  assert.equal(cfg.budget.maxExecutionMinutes, 30);
  // enabled 缺省回填 false（读旧/手写文件时的安全缺省）。
  assert.equal(dt.parseDeliveryRunnerConfig({ schemaVersion: 1 }).enabled, false);
  assert.throws(() => dt.parseDeliveryRunnerConfig({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, enabled: true, budget: { maxAttemptsPerInput: 0, maxExecutionMinutes: 30 } }),
    /maxAttemptsPerInput/,
  );
});

test("parse rejects non-positive / non-integer budget values", () => {
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: -1 } }),
    /maxExecutionMinutes/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, budget: { maxAttemptsPerInput: 2.5, maxExecutionMinutes: 30 } }),
    /maxAttemptsPerInput/,
  );
  // 只回填缺省字段，显式提供的合法值保留。
  const cfg = dt.parseDeliveryRunnerConfig({ schemaVersion: 1, budget: { maxExecutionMinutes: 60 } });
  assert.equal(cfg.budget.maxAttemptsPerInput, 3);
  assert.equal(cfg.budget.maxExecutionMinutes, 60);
});

test("parse validates designer role shape", () => {
  const cfg = dt.parseDeliveryRunnerConfig({
    schemaVersion: 1,
    enabled: true,
    roles: { designer: { profile: "designer", model: { provider: "zai", modelId: "glm-4.7" } } },
  });
  assert.equal(cfg.roles.designer.profile, "designer");
  assert.equal(cfg.roles.designer.model.provider, "zai");
  assert.equal(cfg.roles.designer.model.modelId, "glm-4.7");
  // modelId 是 model 的必填字段。
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, roles: { designer: { model: { provider: "zai" } } } }),
    /modelId/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, roles: { designer: { profile: "  " } } }),
    /profile/,
  );
});

test("parse validates developer role shape (Phase-3 T5: roles 显式双字段)", () => {
  const cfg = dt.parseDeliveryRunnerConfig({
    schemaVersion: 1,
    roles: {
      designer: { profile: "designer" },
      developer: { profile: "implementer", model: { provider: "zai", modelId: "glm-4.7" } },
    },
  });
  assert.equal(cfg.roles.designer.profile, "designer");
  assert.equal(cfg.roles.developer.profile, "implementer");
  assert.equal(cfg.roles.developer.model.provider, "zai");
  assert.equal(cfg.roles.developer.model.modelId, "glm-4.7");
  // developer 与 designer 同规校验——错误消息带 roles.developer 字段路径。
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, roles: { developer: { profile: "   " } } }),
    /roles\.developer\.profile/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, roles: { developer: { model: { provider: "zai" } } } }),
    /roles\.developer\.model\.modelId/,
  );
});

// ------------------------------------------- verification.checks (Phase-4 T1)

test("parse: verification key absent → no verification block (undefined, key not fabricated)", () => {
  const cfg = dt.parseDeliveryRunnerConfig({ schemaVersion: 1, enabled: true });
  assert.equal(cfg.verification, undefined);
  // 精确形状断言：旧文件读回不虚构键（deepEqual 对 own-key 敏感）。
  assert.deepEqual(cfg, {
    schemaVersion: 1,
    enabled: true,
    roles: {},
    budget: { maxAttemptsPerInput: 3, maxExecutionMinutes: 30 },
  });
});

test("parse: verification.checks 空数组合法（等同无配置，池按空处理）", () => {
  const cfg = dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: [] } });
  assert.deepEqual(cfg.verification, { checks: [] });
});

test("parse validates each verification check entry (name/command required, repositoryId optional)", () => {
  const cfg = dt.parseDeliveryRunnerConfig({
    schemaVersion: 1,
    verification: {
      checks: [
        { name: "unit", command: "npm test" },
        { name: "lint", repositoryId: "01TESTREPO", command: "npm run lint", timeout_seconds: 600 },
      ],
    },
  });
  // 可选字段缺席时键整个剥掉（与 roles 的条件展开同一习语）。
  assert.deepEqual(cfg.verification, {
    checks: [
      { name: "unit", command: "npm test" },
      { name: "lint", repositoryId: "01TESTREPO", command: "npm run lint", timeout_seconds: 600 },
    ],
  });
  // 逐条校验：错误消息带 verification.checks[i].field 字段路径。
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: [{ command: "npm test" }] } }),
    /verification\.checks\[0\]\.name/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: [{ name: "unit" }] } }),
    /verification\.checks\[0\]\.command/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: [{ name: "   ", command: "npm test" }] } }),
    /verification\.checks\[0\]\.name/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: [{ name: "unit", command: "" }] } }),
    /verification\.checks\[0\]\.command/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: [{ name: "unit", repositoryId: "  ", command: "npm test" }] } }),
    /verification\.checks\[0\]\.repositoryId/,
  );
  // 条目必须是对象（字符串命令不是合法条目）。
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: ["npm test"] } }),
    /verification\.checks\[0\]/,
  );
});

test("parse validates timeout_seconds bounds: integers 1–3600 inclusive", () => {
  const withTimeout = (timeout_seconds) =>
    dt.parseDeliveryRunnerConfig({
      schemaVersion: 1,
      verification: { checks: [{ name: "unit", command: "npm test", timeout_seconds }] },
    });
  // 边界值合法（1 与 3600 都在界内）。
  assert.equal(withTimeout(1).verification.checks[0].timeout_seconds, 1);
  assert.equal(withTimeout(3600).verification.checks[0].timeout_seconds, 3600);
  // 出界/非整数/非数值一律 Validation。
  for (const bad of [0, -1, 3601, 2.5, "600", null]) {
    assert.throws(
      () => withTimeout(bad),
      /timeout_seconds/,
      `timeout_seconds=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("parse rejects malformed verification shapes", () => {
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: "nope" }),
    /verification/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: {} }),
    /verification\.checks/,
  );
  assert.throws(
    () => dt.parseDeliveryRunnerConfig({ schemaVersion: 1, verification: { checks: "npm test" } }),
    /verification\.checks/,
  );
});

test("round-trip preserves verification.checks (yaml snake_case keys survive)", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-delivery-cfg-checks-"));
  try {
    const original = dt.parseDeliveryRunnerConfig({
      schemaVersion: 1,
      enabled: true,
      roles: { designer: { profile: "designer" } },
      verification: {
        checks: [
          { name: "unit", command: "npm test" },
          { name: "lint", repositoryId: "01TESTREPO", command: "npm run lint", timeout_seconds: 120 },
        ],
      },
    });
    await dt.writeDeliveryRunnerConfig(ws, original);
    assert.deepEqual(await dt.readDeliveryRunnerConfig(ws), original);
    // 写出去的是人可改的 YAML（snake_case 字段名原样保留）。
    const raw = await readFile(dt.deliveryConfigPath(ws), "utf8");
    assert.match(raw, /timeout_seconds: 120/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("round-trip preserves both role keys; 旧单键（只有 designer）配置不丢", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-delivery-cfg-t5-"));
  try {
    const both = dt.parseDeliveryRunnerConfig({
      schemaVersion: 1,
      enabled: true,
      roles: {
        designer: { profile: "designer" },
        developer: { profile: "implementer", model: { modelId: "glm-4.7" } },
      },
    });
    await dt.writeDeliveryRunnerConfig(ws, both);
    assert.deepEqual(await dt.readDeliveryRunnerConfig(ws), both);

    // 旧文件只有 designer 键 → 读回 developer 缺省 undefined（round-trip 不虚构）。
    const legacy = dt.parseDeliveryRunnerConfig({
      schemaVersion: 1,
      roles: { designer: { profile: "solo" } },
    });
    await dt.writeDeliveryRunnerConfig(ws, legacy);
    const back = await dt.readDeliveryRunnerConfig(ws);
    assert.deepEqual(back, legacy);
    assert.equal(back.roles.developer, undefined);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("parse rejects non-object payloads", () => {
  assert.throws(() => dt.parseDeliveryRunnerConfig(null), /delivery runner config/);
  assert.throws(() => dt.parseDeliveryRunnerConfig("nope"), /delivery runner config/);
});

test("round-trip through read/write", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-delivery-cfg-"));
  try {
    // 无文件 → null（视为 disabled）。
    assert.equal(await dt.readDeliveryRunnerConfig(ws), null);

    const original = dt.parseDeliveryRunnerConfig({
      schemaVersion: 1,
      enabled: true,
      roles: { designer: { profile: "designer", model: { modelId: "glm-4.7" } } },
      budget: { maxAttemptsPerInput: 5, maxExecutionMinutes: 45 },
    });
    await dt.writeDeliveryRunnerConfig(ws, original);
    // 文件落在 <ws>/.pi/delivery.yaml。
    const filePath = dt.deliveryConfigPath(ws);
    assert.equal(filePath, join(ws, ".pi", "delivery.yaml"));
    assert.ok((await stat(filePath)).isFile());

    const back = await dt.readDeliveryRunnerConfig(ws);
    assert.deepEqual(back, original);

    // 写出去的是合法 YAML（人可读可手改）。
    const raw = await readFile(filePath, "utf8");
    assert.match(raw, /schemaVersion: 1/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("read of a malformed file raises Validation (route maps to 400, not 500)", async () => {
  const ws = await mkdtemp(join(tmpdir(), "pi-delivery-cfg-bad-"));
  try {
    await mkdir(join(ws, ".pi"), { recursive: true });
    await writeFile(dt.deliveryConfigPath(ws), "::: not yaml [\n", "utf8");
    await assert.rejects(() => dt.readDeliveryRunnerConfig(ws), /delivery runner config/);
    await writeFile(dt.deliveryConfigPath(ws), "just a string\n", "utf8");
    await assert.rejects(() => dt.readDeliveryRunnerConfig(ws), /delivery runner config/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("capability gate", () => {
  assert.doesNotThrow(() => dt.assertAutomationCapable({ capabilities: ["sessions", "work-items", "workflows"] }));
  assert.throws(() => dt.assertAutomationCapable({ capabilities: ["sessions", "work-items"] }), /workflows/);
  assert.throws(() => dt.assertAutomationCapable({ capabilities: ["sessions", "workflows"] }), /work-items/);
  assert.throws(() => dt.assertAutomationCapable({ capabilities: [] }), /capabilities/);
});

test("delivery route checks capabilities before writing and maps bad JSON to 400", async () => {
  const src = await readFile(ROUTE_PATH, "utf8");
  // GET 直读配置；PUT 校验门 + 解析 + 写入。
  assert.match(src, /readDeliveryRunnerConfig/);
  assert.match(src, /writeDeliveryRunnerConfig/);
  assert.match(src, /assertAutomationCapable/);
  assert.match(src, /workItemErrorResponse/);
  // capability 门必须在写入之前（source 顺序断言）。
  const gate = src.indexOf("assertAutomationCapable(");
  const write = src.indexOf("writeDeliveryRunnerConfig(");
  assert.ok(gate >= 0 && write >= 0 && gate < write, "assertAutomationCapable must precede writeDeliveryRunnerConfig");
  // 坏 JSON body → WorkItemValidationError("invalid JSON body") → 400。
  assert.match(src, /invalid JSON body/);
});
