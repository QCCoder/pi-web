/**
 * models-store.test.ts
 *
 * 验证 fetchModels 的 SWR / in-flight 去重 / epoch 防覆盖 / 按 cwd 独立，以及
 * deriveNewSessionDefaultModel。用 node 内置 test runner + mock fetch（零新增依赖）。
 * 运行：node --import jiti/register --test lib/stores/models-store.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  modelsStore,
  fetchModels,
  deriveNewSessionDefaultModel,
  type ModelsResponse,
} from "./models-store";

let fetchCalls: string[];
let originalFetch: typeof globalThis.fetch;

function jsonResponse(d: Partial<ModelsResponse>): Response {
  return new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  for (const k of modelsStore.keys()) modelsStore.delete(k);
  fetchCalls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string) => Partial<ModelsResponse> | null): void {
  globalThis.fetch = (((url: URL | string) => {
    const u = typeof url === "string" ? url : url.toString();
    fetchCalls.push(u);
    const body = handler(u);
    return Promise.resolve(body ? jsonResponse(body) : new Response("{}", { status: 200 }));
  }) as unknown) as typeof globalThis.fetch;
}

describe("fetchModels — SWR + dedup", () => {
  it("fetches once per cwd and writes state; second call within TTL skips the network", async () => {
    installFetch(() => ({ models: { "p:m": "M" }, modelList: [{ id: "m", name: "M", provider: "p" }] }));
    await fetchModels("/a");
    await fetchModels("/a");
    assert.equal(fetchCalls.length, 1);
    const s = modelsStore.get("/a");
    assert.deepEqual(s?.modelList, [{ id: "m", name: "M", provider: "p" }]);
    assert.equal(s?.models["p:m"], "M");
    assert.ok(s && s.loadedAt > 0);
  });

  it("force=true bypasses TTL and refetches", async () => {
    installFetch((url) => (url.includes("cwd=%2Fa") ? { models: { "p:m": "v2" } } : null));
    await fetchModels("/a");
    await fetchModels("/a"); // TTL hit → no fetch
    await fetchModels("/a", { force: true });
    assert.equal(fetchCalls.length, 2);
    assert.equal(modelsStore.get("/a")?.models["p:m"], "v2");
  });

  it("different cwds are independent (各自的缓存/请求)", async () => {
    installFetch((url) => {
      const models: Record<string, string> = url.includes("cwd=%2Fa") ? { "p:a": "A" } : { "p:b": "B" };
      return { models };
    });
    await fetchModels("/a");
    await fetchModels("/b");
    assert.equal(fetchCalls.length, 2);
    assert.equal(modelsStore.get("/a")?.models["p:a"], "A");
    assert.equal(modelsStore.get("/b")?.models["p:b"], "B");
  });

  it("concurrent same-cwd calls share one in-flight (不重复请求)", async () => {
    installFetch(() => ({ models: { "p:m": "M" } }));
    await Promise.all([fetchModels("/a"), fetchModels("/a"), fetchModels("/a")]);
    assert.equal(fetchCalls.length, 1);
  });

  it("non-ok response does not write state", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof globalThis.fetch;
    await fetchModels("/a");
    assert.equal(modelsStore.get("/a"), undefined);
  });
});

describe("deriveNewSessionDefaultModel", () => {
  const list = [
    { id: "a", name: "A", provider: "p" },
    { id: "b", name: "B", provider: "p" },
  ];

  it("prefers defaultModel when it is visible in the list", () => {
    const r = deriveNewSessionDefaultModel({
      models: {}, modelList: list, modelError: null, thinkingLevels: {}, thinkingLevelMaps: {},
      defaultModel: { provider: "p", modelId: "b" }, loadedAt: 0,
    });
    assert.deepEqual(r, { provider: "p", modelId: "b" });
  });

  it("falls back to first list entry when defaultModel is not in the list", () => {
    const r = deriveNewSessionDefaultModel({
      models: {}, modelList: list, modelError: null, thinkingLevels: {}, thinkingLevelMaps: {},
      defaultModel: { provider: "p", modelId: "zzz" }, loadedAt: 0,
    });
    assert.deepEqual(r, { provider: "p", modelId: "a" });
  });

  it("falls back to first list entry when there is no defaultModel", () => {
    const r = deriveNewSessionDefaultModel({
      models: {}, modelList: list, modelError: null, thinkingLevels: {}, thinkingLevelMaps: {},
      defaultModel: null, loadedAt: 0,
    });
    assert.deepEqual(r, { provider: "p", modelId: "a" });
  });

  it("returns null when the list is empty", () => {
    const r = deriveNewSessionDefaultModel({
      models: {}, modelList: [], modelError: null, thinkingLevels: {}, thinkingLevelMaps: {},
      defaultModel: null, loadedAt: 0,
    });
    assert.equal(r, null);
  });
});
