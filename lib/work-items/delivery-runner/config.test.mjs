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
