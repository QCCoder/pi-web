import assert from "node:assert/strict";
import test from "node:test";
import { ChandaoImporter } from "./chandao-importer.ts";

const BASE = "https://chandao.example.com";

/** @typedef {import("./types.ts").ChandaoConfig} ChandaoConfig */

/** @param {Partial<ChandaoConfig>} [over] @returns {ChandaoConfig} */
function baseConfig(over = {}) {
  return {
    base: BASE,
    account: "qiancheng",
    password: "secret",
    assignee: "qiancheng",
    productId: 2,
    executionId: 3,
    ...over,
  };
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x45, 0x4e, 0x44,
]);

/** Build a mock Response-like object. */
function res({ status = 200, json, body, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() { return body ? body.toString("utf8") : json ? JSON.stringify(json) : ""; },
    async json() { return json ?? JSON.parse(body ? body.toString("utf8") : "{}"); },
    async arrayBuffer() { return body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0); },
  };
}

/** A scriptable mock fetch: routes keyed by regex (+ optional method). */
function mockFetch(routes) {
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const route of routes) {
      if (route.method && route.method.toUpperCase() !== method) continue;
      if (!route.match.test(url)) continue;
      return res(route);
    }
    throw new Error(`mock fetch: no route for ${method} ${url}`);
  };
}

test("sign-in obtains a token via POST /tokens", async () => {
  let signInCalled = 0;
  const fetchImpl = mockFetch([
    { match: /\/api\.php\/v1\/tokens$/, method: "POST", status: 201, json: { token: "tok-abc" } },
    { match: /\/api\.php\/v1\/products\/2\/bugs/, json: { bugs: [{ id: 50, title: "Login blank", status: "active", assignedTo: { account: "qiancheng" } }] } },
    { match: /\/api\.php\/v1\/executions\/3\/tasks/, json: { tasks: [] } },
  ]);
  const countingFetch = async (input, init) => {
    if (String(input).endsWith("/tokens")) signInCalled += 1;
    return fetchImpl(input, init);
  };
  const importer = new ChandaoImporter(baseConfig(), { fetchImpl: countingFetch });
  const items = await importer.listAssigned();
  assert.ok(signInCalled >= 1, "token route must be hit at least once");
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, "50");
  assert.equal(items[0].kind, "bug");
});

test("listAssigned merges bugs and tasks", async () => {
  const fetchImpl = mockFetch([
    { match: /\/tokens$/, method: "POST", status: 201, json: { token: "t" } },
    { match: /products\/2\/bugs/, json: { bugs: [{ id: 50, title: "B1", status: "active", assignedTo: { account: "qiancheng" } }, { id: 51, title: "B2", status: "active", assignedTo: { account: "qiancheng" } }] } },
    { match: /executions\/3\/tasks/, json: { tasks: [{ id: 3, name: "T1", status: "doing", assignedTo: { account: "qiancheng" } }] } },
  ]);
  const importer = new ChandaoImporter(baseConfig(), { fetchImpl });
  const items = await importer.listAssigned();
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.sourceId}:${i.title}`),
    ["bug:50:B1", "bug:51:B2", "task:3:T1"],
  );
  assert.match(items[0].url ?? "", /bugID=50/);
  assert.match(items[2].url ?? "", /taskID=3/);
});

test("listAssigned filters to ready (bug active / task doing) AND real assignee", async () => {
  // The chandao REST API ignores the `assignedTo` query param, so listAssigned
  // must filter client-side by assignedTo.account === assignee AND by status.
  const fetchImpl = mockFetch([
    { match: /\/tokens$/, method: "POST", status: 201, json: { token: "t" } },
    {
      match: /products\/2\/bugs/,
      json: { bugs: [
        { id: 1, title: "active-mine", status: "active", assignedTo: { account: "qiancheng" } },
        { id: 2, title: "active-other", status: "active", assignedTo: { account: "someone" } },
        { id: 3, title: "resolved-mine", status: "resolved", assignedTo: { account: "qiancheng" } },
        { id: 4, title: "active-string-assignee", status: "active", assignedTo: "qiancheng" },
        { id: 5, title: "active-null-assignee", status: "active", assignedTo: null },
      ] },
    },
    {
      match: /executions\/3\/tasks/,
      json: { tasks: [
        { id: 10, name: "doing-mine", status: "doing", assignedTo: { account: "qiancheng" } },
        { id: 11, name: "wait-mine", status: "wait", assignedTo: { account: "qiancheng" } },
        { id: 12, name: "doing-other", status: "doing", assignedTo: { account: "someone" } },
        { id: 13, name: "done-mine", status: "done", assignedTo: { account: "qiancheng" } },
      ] },
    },
  ]);
  const importer = new ChandaoImporter(baseConfig(), { fetchImpl });
  const items = await importer.listAssigned();
  // bug 1 (active+mine), bug 4 (active+string-assignee) ; task 10 (doing+mine)
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.sourceId}`),
    ["bug:1", "bug:4", "task:10"],
  );
});

test("getDetail returns bug steps containing <img>", async () => {
  const fetchImpl = mockFetch([
    { match: /\/tokens$/, method: "POST", status: 201, json: { token: "t" } },
    {
      match: /\/api\.php\/v1\/bugs\/50$/,
      json: { id: 50, title: "Login blank", steps: 'see <img src="/index.php?m=file&f=read&t=png&fileID=507">' },
    },
  ]);
  const importer = new ChandaoImporter(baseConfig(), { fetchImpl });
  const detail = await importer.getDetail("50");
  assert.equal(detail.kind, "bug");
  assert.equal(detail.title, "Login blank");
  assert.match(detail.body, /fileID=507/);
});

test("getAttachment returns valid PNG (magic bytes)", async () => {
  const fetchImpl = mockFetch([
    { match: /\/tokens$/, method: "POST", status: 201, json: { token: "t" } },
    { match: /\/api\.php\/v1\/files\/507$/, body: PNG_BYTES, headers: { "content-type": "image/png" } },
  ]);
  const importer = new ChandaoImporter(baseConfig(), { fetchImpl });
  const att = await importer.getAttachment("507");
  assert.equal(att.ext, "png");
  assert.equal(att.bytes[0], 0x89);
  assert.equal(att.bytes[1], 0x50);
  assert.equal(att.bytes[2], 0x4e);
  assert.equal(att.bytes[3], 0x47);
});

test("401 triggers a single re-sign then retries successfully", async () => {
  let tokenCalls = 0;
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/tokens")) {
      tokenCalls += 1;
      return res({ status: 201, json: { token: `tok-${tokenCalls}` } });
    }
    if (method === "GET" && /\/api\.php\/v1\/bugs\/50$/.test(url)) {
      const sentToken = init?.headers?.Token;
      if (sentToken === "tok-1") return res({ status: 401 });
      return res({ json: { id: 50, title: "ok", steps: "body" } });
    }
    throw new Error(`no route for ${method} ${url}`);
  };
  const importer = new ChandaoImporter(baseConfig(), { fetchImpl });
  const detail = await importer.getDetail("50");
  assert.equal(tokenCalls, 2); // initial sign-in + one re-sign after 401
  assert.equal(detail.title, "ok");
});

test("listAssigned uses config assignee by default, override via filter", async () => {
  let captured = "";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith("/tokens")) return res({ status: 201, json: { token: "t" } });
    if (/products\/2\/bugs/.test(url)) { captured = url; return res({ json: { bugs: [] } }); }
    if (/executions\/3\/tasks/.test(url)) return res({ json: { tasks: [] } });
    throw new Error(`no route ${url}`);
  };
  const importer = new ChandaoImporter(baseConfig({ assignee: "alice" }), { fetchImpl });
  await importer.listAssigned();
  assert.match(captured, /assignedTo=alice/);
  await importer.listAssigned({ assignee: "bob" });
  assert.match(captured, /assignedTo=bob/);
});
