import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  const projectRoot = new URL("..", import.meta.url).pathname;
  return createJiti(import.meta.url, { alias: { "@": projectRoot } }).import("./provider-usage.ts");
}

const {
  fetchProviderUsageJson,
  isOfficialProviderUsageOrigin,
  isProviderUsageId,
  normalizeProviderUsagePayload,
} = await loadSubject();

test("recognizes only providers with usage adapters", () => {
  assert.equal(isProviderUsageId("openai-codex"), true);
  assert.equal(isProviderUsageId("anthropic"), false);
});

test("accepts only the official origin for provider usage credentials", () => {
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "https://api.deepseek.com/v1"), true);
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "https://proxy.example.com/v1"), false);
  assert.equal(isOfficialProviderUsageOrigin("deepseek", "not a URL"), false);
});

test("normalizes Codex windows into remaining percentages and reset times", () => {
  const report = normalizeProviderUsagePayload("openai-codex", {
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800 },
    },
  }, 123);
  assert.deepEqual(report.buckets.map((bucket) => [bucket.label, bucket.groupLabel, bucket.remaining, bucket.resetsAt]), [
    ["5h", undefined, 88, 1_800_000_000],
    ["Weekly", undefined, 60, undefined],
  ]);
});

test("normalizes MiniMax token-plan counts using the reported remaining percent", () => {
  const report = normalizeProviderUsagePayload("minimax", {
    model_remains: [{
      model_name: "MiniMax-M2",
      current_interval_usage_count: 20,
      current_interval_total_count: 100,
      current_interval_remaining_percent: 80,
      current_interval_status: 1,
      start_time: 1_700_000_000_000,
      end_time: 1_700_360_000_000,
      current_weekly_usage_count: 1,
      current_weekly_total_count: 1,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 3,
      weekly_start_time: 1_700_000_000_000,
      weekly_end_time: 1_706_000_000_000,
    }],
  }, 123);
  assert.equal(report.buckets[0].remaining, 80);
  assert.equal(report.buckets[0].used, 20);
  assert.equal(report.buckets[1].period, "Unlimited");
});

// The fetch layer is exercised through an injected fetch stub so no test ever
// touches the network.

function stubResponse(body, init = {}) {
  return {
    ok: init.status === undefined || (init.status >= 200 && init.status < 300),
    status: init.status ?? 200,
    text: async () => body,
  };
}

test("queries the official endpoint with the resolved auth and a timeout signal", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: Object.fromEntries(init.headers), signal: init.signal });
    return stubResponse(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1.5" }] }));
  };
  const payload = await fetchProviderUsageJson(
    "deepseek",
    { apiKey: "sk-test" },
    fetchImpl,
  );

  assert.equal(payload.is_available, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(calls[0].headers.authorization, "Bearer sk-test");
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("falls back to the endpoint variant matching the bearer token for MiniMax", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return stubResponse("{}");
  };
  await fetchProviderUsageJson("minimax-cn", { apiKey: "sk-api-legacy" }, fetchImpl);
  await fetchProviderUsageJson("minimax-cn", { apiKey: "eyJ subscription" }, fetchImpl);

  assert.deepEqual(urls, [
    "https://api.minimaxi.com/account/query_balance",
    "https://api.minimaxi.com/v1/token_plan/remains",
  ]);
});

test("an explicit auth header wins over the raw api key", async () => {
  const headersSeen = [];
  const fetchImpl = async (_url, init) => {
    headersSeen.push(Object.fromEntries(init.headers));
    return stubResponse("{}");
  };
  await fetchProviderUsageJson("openrouter", { apiKey: "raw", headers: { authorization: "Bearer explicit" } }, fetchImpl);

  assert.equal(headersSeen[0].authorization, "Bearer explicit");
});

test("non-ok responses, oversized payloads and non-object bodies are errors", async () => {
  await assert.rejects(
    fetchProviderUsageJson("deepseek", {}, async () => stubResponse("nope", { status: 503 })),
    /returned 503/,
  );
  await assert.rejects(
    fetchProviderUsageJson("deepseek", {}, async () => stubResponse("x".repeat(65_537))),
    /too large/,
  );
  await assert.rejects(
    fetchProviderUsageJson("deepseek", {}, async () => stubResponse("[1,2]")),
    /not an object/,
  );
});

test("a custom provider origin can never be used for official usage queries", async () => {
  await assert.rejects(
    fetchProviderUsageJson("deepseek", { apiKey: "k", baseUrl: "https://proxy.example.com" }, async () => {
      throw new Error("should not fetch");
    }),
    /custom provider origin/,
  );
});

test("network rejections (timeout or abort) propagate as query failures", async () => {
  await assert.rejects(
    fetchProviderUsageJson("deepseek", {}, async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }),
    (error) => error.name === "TimeoutError",
  );
});
