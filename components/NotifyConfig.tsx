"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type {
  NotifyChannelKind,
  NotifyConfigPublic,
  NotifyMode,
} from "@/lib/notify/config";

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

const CHANNEL_LABEL: Record<NotifyChannelKind, string> = {
  feishu: "飞书",
  wecom: "企业微信",
};

/** Multi-channel notify settings (design §6). Picks the delivery `mode`
 *  (failover vs all), toggles + reorders channels by priority, fills the WeCom
 *  webhook, and tests each channel. Feishu credentials themselves stay in the
 *  FeishuConfig panel above; this panel only decides ordering + enable. */
export function NotifyConfig({
  workspace,
}: {
  workspace: WorkspaceSummary;
}) {
  const [mode, setMode] = useState<NotifyMode>("failover");
  /** Channels in priority order (index 0 = highest priority). */
  const [order, setOrder] = useState<NotifyChannelKind[]>(["feishu", "wecom"]);
  const [enabled, setEnabled] = useState<Record<NotifyChannelKind, boolean>>({
    feishu: true,
    wecom: false,
  });
  const [webhook, setWebhook] = useState<Record<NotifyChannelKind, string>>({
    feishu: "",
    wecom: "",
  });
  const [hasWebhook, setHasWebhook] = useState<Record<NotifyChannelKind, boolean>>({
    feishu: false,
    wecom: false,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<NotifyChannelKind | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await responseJson<{ config: NotifyConfigPublic }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/notify`),
      );
      const cfg = data.config;
      setMode(cfg.mode);
      // Render order = priority ascending; fall back to a stable default.
      const sorted = [...cfg.channels].sort((a, b) => a.priority - b.priority);
      setOrder(sorted.map((c) => c.kind));
      const nextEnabled = { feishu: false, wecom: false } as Record<NotifyChannelKind, boolean>;
      const nextHas = { feishu: false, wecom: false } as Record<NotifyChannelKind, boolean>;
      for (const c of cfg.channels) {
        nextEnabled[c.kind] = c.enabled;
        nextHas[c.kind] = c.hasWebhook;
      }
      setEnabled(nextEnabled);
      setHasWebhook(nextHas);
      setWebhook({ feishu: "", wecom: "" }); // never hold the raw key; show masked placeholder
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = useCallback((kind: NotifyChannelKind, dir: -1 | 1) => {
    setOrder((prev) => {
      const idx = prev.indexOf(kind);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

  const buildPatch = useCallback(() => {
    const channels: Array<{ kind: NotifyChannelKind; enabled: boolean; priority: number; webhook?: string }> = order.map(
      (kind, idx) => {
        const entry: { kind: NotifyChannelKind; enabled: boolean; priority: number; webhook?: string } = {
          kind,
          enabled: enabled[kind],
          priority: idx + 1,
        };
        // Only send webhook when the user typed a new value; omit otherwise so the
        // stored key is preserved (the PUT merge rule).
        if (kind === "wecom" && webhook.wecom.trim()) entry.webhook = webhook.wecom.trim();
        return entry;
      },
    );
    return { mode, channels };
  }, [enabled, mode, order, webhook]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setTestResult({});
    try {
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/notify`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPatch()),
        }),
      );
      setWebhook({ feishu: "", wecom: "" });
      setSavedAt(Date.now());
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [buildPatch, load, workspace.id]);

  const sendTest = useCallback(
    async (kind: NotifyChannelKind) => {
      setTesting(kind);
      setError(null);
      try {
        await responseJson(
          await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/notify/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: kind }),
          }),
        );
        setTestResult((prev) => ({ ...prev, [kind]: { ok: true, text: "测试消息已发送" } }));
      } catch (testError) {
        setTestResult((prev) => ({
          ...prev,
          [kind]: { ok: false, text: testError instanceof Error ? testError.message : String(testError) },
        }));
      } finally {
        setTesting(null);
      }
    },
    [workspace.id],
  );

  return (
    <section className="workspace-settings-section">
      <div className="repository-section-header">
        <h3>通知渠道</h3>
      </div>
      <div className="workspace-summary-card">
        <div className="workspace-rail-meta" style={{ marginBottom: 8 }}>
          工作项进入「待评审 / 完成 / 受阻」时按以下渠道与优先级推送。
          <strong>故障转移</strong>：按优先级依次尝试，首个送达即停（不重复打扰）；
          <strong>全部发送</strong>：所有启用渠道各发一份。
        </div>

        {error && <div className="workspace-error">{error}</div>}

        {loading ? (
          <div className="workspace-rail-meta">加载通知配置…</div>
        ) : (
          <>
            <div className="workspace-field" style={{ marginBottom: 12 }}>
              <span>推送模式</span>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="radio"
                    checked={mode === "failover"}
                    onChange={() => setMode("failover")}
                  />
                  故障转移（推荐）
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="radio"
                    checked={mode === "all"}
                    onChange={() => setMode("all")}
                  />
                  全部发送
                </label>
              </div>
            </div>

            <div className="workspace-form-grid" style={{ flexDirection: "column", gap: 10 }}>
              {order.map((kind, idx) => (
                <div
                  key={kind}
                  className="workspace-field"
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: 10,
                    opacity: enabled[kind] ? 1 : 0.6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        color: "var(--accent)",
                        minWidth: 18,
                      }}
                      title="优先级（数字越小越优先）"
                    >
                      {idx + 1}
                    </span>
                    <strong style={{ minWidth: 64 }}>{CHANNEL_LABEL[kind]}</strong>
                    <button
                      className="workspace-action"
                      style={{ padding: "2px 8px" }}
                      disabled={idx === 0}
                      onClick={() => move(kind, -1)}
                      title="上移（提高优先级）"
                    >
                      ↑
                    </button>
                    <button
                      className="workspace-action"
                      style={{ padding: "2px 8px" }}
                      disabled={idx === order.length - 1}
                      onClick={() => move(kind, 1)}
                      title="下移（降低优先级）"
                    >
                      ↓
                    </button>
                    <label style={{ display: "flex", gap: 4, alignItems: "center", cursor: "pointer", marginLeft: "auto" }}>
                      <input
                        type="checkbox"
                        checked={enabled[kind]}
                        onChange={(e) => setEnabled((prev) => ({ ...prev, [kind]: e.target.checked }))}
                      />
                      启用
                    </label>
                  </div>

                  <div style={{ marginTop: 8 }}>
                    {kind === "feishu" ? (
                      <div className="workspace-rail-meta">
                        飞书凭证（appId / appSecret / receive_id）在上方「飞书推送」面板配置。
                      </div>
                    ) : (
                      <label style={{ display: "block" }}>
                        <span>群机器人 Webhook</span>
                        <input
                          value={webhook.wecom}
                          onChange={(e) => setWebhook((prev) => ({ ...prev, wecom: e.target.value }))}
                          placeholder={
                            hasWebhook.wecom
                              ? "已保存（留空保持不变，重新填写则覆盖）"
                              : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                          }
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </label>
                    )}
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    {testResult[kind] && (
                      <span
                        style={{
                          marginRight: "auto",
                          fontSize: 12,
                          color: testResult[kind].ok ? "#16a34a" : "#ef4444",
                          alignSelf: "center",
                        }}
                      >
                        {testResult[kind].text}
                      </span>
                    )}
                    <button
                      className="workspace-action"
                      disabled={testing === kind || !enabled[kind]}
                      onClick={() => void sendTest(kind)}
                    >
                      {testing === kind ? "发送中…" : `测试 ${CHANNEL_LABEL[kind]}`}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
              {savedAt > 0 && (
                <span style={{ marginRight: "auto", fontSize: 12, color: "#16a34a", alignSelf: "center" }}>
                  已保存
                </span>
              )}
              <button className="workspace-action" disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : "保存配置"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
