import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "localhost:30141" },
  })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("allows IPv6 and an explicitly configured hostname", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const ipv6 = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "[::1]:30141",
      origin: "http://[::1]:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const configured = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi-web.internal:30141",
      origin: "http://pi-web.internal:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(ipv6), true);
  assert.equal(isApiRequestAllowed(configured, ["pi-web.internal"]), true);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { host: "localhost:30141", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestAllowed(crossSiteGet), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects DNS rebinding even when browser headers say same-origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "attacker.example:30141",
      origin: "http://attacker.example:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects missing, malformed, and unconfigured Host headers", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test")), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "localhost@attacker.example:30141" },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "pi-web.internal:30141" },
  })), false);
});

test("recognizes JSON request content types", async () => {
  const { hasJsonContentType } = await loadSubject();
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/problem+json" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "text/plain" },
  })), false);
});

test("accepts genuinely same-origin requests behind a scheme-rewriting proxy (upstream e44639f+b80ed3d)", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  // 实测（next start :3199）: Next 自己会把 x-forwarded-proto 折算进
  // request.url —— 所以反代后 Origin=https 时 requestOrigin 也是 https, 精确
  // 比较已经通过（审计推断的误拒方向实测证伪）。真正 403 的是上游 #497 方向:
  // 隧道把 Origin 改写成后端 authority（http）而 request.url 是 https ——
  // 下一组断言按该形态建模（request.url https + Origin http）。
  assert.equal(isApiRequestOriginAllowed(new Request("https://127.0.0.1:3199/api/web-auth", {
    method: "GET",
    headers: {
      host: "127.0.0.1:3199",
      origin: "http://127.0.0.1:3199",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  })), true);

  // 带端口的 authority 同样按 host:port 精确对齐（Origin 与 Host 同 authority,
  // 仅 scheme 相异）。
  assert.equal(isApiRequestOriginAllowed(new Request("https://myhost.example:8443/api/web-auth", {
    headers: {
      host: "myhost.example:8443",
      origin: "http://myhost.example:8443",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  })), true);
});

test("proxy relaxation stays fail-closed without same-origin evidence", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const base = {
    host: "myhost.example",
    origin: "https://myhost.example",
    "x-forwarded-proto": "https",
  };
  // Fetch Metadata 报 cross-site：即使 authority 匹配也拒绝。
  assert.equal(isApiRequestOriginAllowed(new Request("http://127.0.0.1:3199/api/test", {
    headers: { ...base, "sec-fetch-site": "cross-site" },
  })), false);
  // 无 Fetch Metadata（非浏览器或旧浏览器）：保持精确比较, 不放宽。
  assert.equal(isApiRequestOriginAllowed(new Request("http://127.0.0.1:3199/api/test", {
    headers: { ...base },
  })), false);
  // 无 x-forwarded-proto（直连）：行为与修复前一致, 拒绝。
  assert.equal(isApiRequestOriginAllowed(new Request("http://127.0.0.1:3199/api/test", {
    headers: { host: "myhost.example", origin: "https://myhost.example", "sec-fetch-site": "same-origin" },
  })), false);
  // authority 不匹配（不可信来源借道）：拒绝。
  assert.equal(isApiRequestOriginAllowed(new Request("http://127.0.0.1:3199/api/test", {
    headers: {
      host: "myhost.example",
      origin: "https://otherhost.example",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  })), false);
});
