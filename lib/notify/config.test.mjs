import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  defaultNotifyConfig,
  normalizeNotifyConfig,
  maskWebhook,
  toPublicNotifyConfig,
  orderedEnabledChannels,
  mergeNotifyConfig,
} = await jiti.import("./config.ts");

test("defaultNotifyConfig: failover, feishu on, wecom off (backward compatible)", () => {
  const c = defaultNotifyConfig();
  assert.equal(c.mode, "failover");
  const feishu = c.channels.find((x) => x.kind === "feishu");
  const wecom = c.channels.find((x) => x.kind === "wecom");
  assert.equal(feishu?.enabled, true);
  assert.equal(wecom?.enabled, false); // disabled until the user opts in
});

test("normalizeNotifyConfig: fills missing channels from defaults", () => {
  const c = normalizeNotifyConfig({ mode: "all", channels: [{ kind: "wecom", enabled: true, priority: 1, webhook: "https://x?key=ABCDEF" }] });
  assert.equal(c.mode, "all");
  assert.equal(c.channels.length, 2); // feishu seeded too
  const wecom = c.channels.find((x) => x.kind === "wecom");
  assert.equal(wecom?.enabled, true);
  assert.equal(wecom?.webhook, "https://x?key=ABCDEF");
});

test("normalizeNotifyConfig: rejects unknown mode/kind, coerces priority", () => {
  const c = normalizeNotifyConfig({ mode: "bogus", channels: [{ kind: "slack", enabled: true }, { kind: "wecom", enabled: true, priority: "oops" }] });
  assert.equal(c.mode, "failover");
  assert.equal(c.channels.find((x) => x.kind === "slack"), undefined);
  assert.equal(c.channels.find((x) => x.kind === "wecom")?.priority, 2); // fell back to default
});

test("normalizeNotifyConfig: trims empty webhook to undefined", () => {
  const c = normalizeNotifyConfig({ channels: [{ kind: "wecom", enabled: true, webhook: "   " }] });
  assert.equal(c.channels.find((x) => x.kind === "wecom")?.webhook, undefined);
});

test("maskWebhook: hides the key, keeps the host", () => {
  const m = maskWebhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd-1234-ef");
  assert.match(m, /key=abc/);
  assert.match(m, /ef$/);
  assert.equal(maskWebhook(undefined), undefined);
});

test("toPublicNotifyConfig: never leaks the raw webhook", () => {
  const pub = toPublicNotifyConfig(
    normalizeNotifyConfig({ channels: [{ kind: "wecom", enabled: true, webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRETKEY123" }] }),
  );
  const wecom = pub.channels.find((x) => x.kind === "wecom");
  assert.equal(wecom?.hasWebhook, true);
  assert.match(wecom?.webhookMasked ?? "", /key=/);
  assert.doesNotMatch(JSON.stringify(pub), /SECRETKEY123/);
});

test("orderedEnabledChannels: only enabled, ascending priority", () => {
  const c = normalizeNotifyConfig({
    channels: [
      { kind: "wecom", enabled: true, priority: 1 },
      { kind: "feishu", enabled: false, priority: 2 },
    ],
  });
  const enabled = orderedEnabledChannels(c);
  assert.deepEqual(enabled.map((x) => x.kind), ["wecom"]);
});

test("mergeNotifyConfig: omitted webhook is preserved (masked round-trip)", () => {
  const existing = normalizeNotifyConfig({ channels: [{ kind: "wecom", enabled: true, webhook: "https://x?key=SECRET" }] });
  // UI posts back without webhook (it only had the masked form)
  const merged = mergeNotifyConfig(existing, { mode: "all", channels: [{ kind: "wecom", enabled: true }] });
  assert.equal(merged.mode, "all");
  assert.equal(merged.channels.find((c) => c.kind === "wecom")?.webhook, "https://x?key=SECRET");
});

test("mergeNotifyConfig: new non-empty webhook replaces", () => {
  const existing = normalizeNotifyConfig({ channels: [{ kind: "wecom", enabled: true, webhook: "https://x?key=OLD" }] });
  const merged = mergeNotifyConfig(existing, { channels: [{ kind: "wecom", webhook: "https://x?key=NEW" }] });
  assert.equal(merged.channels.find((c) => c.kind === "wecom")?.webhook, "https://x?key=NEW");
  assert.equal(merged.channels.find((c) => c.kind === "wecom")?.enabled, true); // preserved
});

test("mergeNotifyConfig: toggling enabled/priority without touching webhook", () => {
  const existing = normalizeNotifyConfig({ channels: [{ kind: "wecom", enabled: false, priority: 2, webhook: "https://x?key=K" }] });
  const merged = mergeNotifyConfig(existing, { channels: [{ kind: "wecom", enabled: true, priority: 1 }] });
  const w = merged.channels.find((c) => c.kind === "wecom");
  assert.equal(w?.enabled, true);
  assert.equal(w?.priority, 1);
  assert.equal(w?.webhook, "https://x?key=K"); // preserved
});
