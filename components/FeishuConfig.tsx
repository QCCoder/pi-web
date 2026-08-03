"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceCapability, WorkspaceSummary } from "@/lib/workspaces/types";
import type { FeishuConfigPublic, FeishuReceiveIdType } from "@/lib/feishu/types";
import { CapabilityToggle } from "./CapabilityToggle";

const FEISHU_CAPABILITY: WorkspaceCapability = "feishu-transport";

const RECEIVE_ID_TYPES: ReadonlyArray<{ value: FeishuReceiveIdType; label: string }> = [
  { value: "open_id", label: "open_id（用户）" },
  { value: "user_id", label: "user_id（用户）" },
  { value: "chat_id", label: "chat_id（群）" },
  { value: "email", label: "email" },
];

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/**
 * feishu-transport settings panel: toggle the capability, edit the Feishu app
 * credentials / default push target, and send a test message. Embedded in the
 * Workspace settings view (WorkspaceManager), so it reuses the workspace-*
 * classes scoped there.
 */
export function FeishuConfig({
  workspace,
  onWorkspaceChanged,
}: {
  workspace: WorkspaceSummary;
  onWorkspaceChanged: () => void;
}) {
  const enabled = workspace.capabilities.includes(FEISHU_CAPABILITY);
  const [config, setConfig] = useState<FeishuConfigPublic | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [receiveIdType, setReceiveIdType] = useState<FeishuReceiveIdType>("open_id");
  const [receiveId, setReceiveId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await responseJson<{ config: FeishuConfigPublic | null }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/feishu`),
      );
      setConfig(data.config);
      setAppId(data.config?.appId ?? "");
      setReceiveIdType(data.config?.receiveIdType ?? "open_id");
      setReceiveId(data.config?.receiveId ?? "");
      setAppSecret("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleCapability = useCallback(async (next: boolean) => {
    setToggling(true);
    setError(null);
    try {
      const capabilities = workspace.capabilities.filter((capability) => capability !== FEISHU_CAPABILITY);
      if (next) capabilities.push(FEISHU_CAPABILITY);
      await responseJson(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: workspace.updatedAt,
            capabilities,
          }),
        }),
      );
      onWorkspaceChanged();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setToggling(false);
    }
  }, [onWorkspaceChanged, workspace]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setTestMessage(null);
    try {
      const data = await responseJson<{ config: FeishuConfigPublic | null }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/feishu`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId, appSecret, receiveIdType, receiveId }),
        }),
      );
      setConfig(data.config);
      setAppSecret("");
      onWorkspaceChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [appId, appSecret, onWorkspaceChanged, receiveId, receiveIdType, workspace.id]);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    setTestMessage(null);
    try {
      const data = await responseJson<{ ok: boolean; messageId?: string }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/feishu/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      setTestMessage({
        ok: true,
        text: `测试消息已发送${data.messageId ? `（message_id=${data.messageId}）` : ""}`,
      });
    } catch (testError) {
      setTestMessage({ ok: false, text: testError instanceof Error ? testError.message : String(testError) });
    } finally {
      setTesting(false);
    }
  }, [workspace.id]);

  const hasStoredSecret = Boolean(config?.hasAppSecret);
  const canSave =
    appId.trim().length > 0
    && receiveId.trim().length > 0
    && (appSecret.trim().length > 0 || hasStoredSecret);

  return (
    <section className="workspace-settings-section">
      <div className="repository-section-header">
        <h3>飞书推送</h3>
        <CapabilityToggle enabled={enabled} loading={toggling} onToggle={(next) => void toggleCapability(next)} />
      </div>
      <div className="workspace-summary-card">
        <div className="workspace-rail-meta" style={{ marginBottom: 8 }}>
          启用后，工作区会话里可调用 <code>feishu_send_message</code> / <code>feishu_send_card</code> 出站推送。
          {enabled ? " 当前已启用。" : " 当前未启用。"}
        </div>

        {error && <div className="workspace-error">{error}</div>}

        {loading ? (
          <div className="workspace-rail-meta">加载飞书配置…</div>
        ) : (
          <>
            <div className="workspace-form-grid">
              <label className="workspace-field">
                <span>App ID</span>
                <input
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  placeholder="cli_xxxxxxxxxxxxxxxx"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>
                  App Secret
                  {hasStoredSecret && (
                    <em style={{ color: "var(--text-dim)", marginLeft: 6 }}>已保存，留空保持不变</em>
                  )}
                </span>
                <input
                  type="password"
                  value={appSecret}
                  onChange={(event) => setAppSecret(event.target.value)}
                  placeholder={hasStoredSecret ? "••••••••（不修改则留空）" : "应用 App Secret"}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>接收者类型</span>
                <select
                  value={receiveIdType}
                  onChange={(event) => setReceiveIdType(event.target.value as FeishuReceiveIdType)}
                >
                  {RECEIVE_ID_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="workspace-field">
                <span>默认推送目标 receive_id</span>
                <input
                  value={receiveId}
                  onChange={(event) => setReceiveId(event.target.value)}
                  placeholder="ou_xxxxxxxx / chat_id / 邮箱"
                  spellCheck={false}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
              {testMessage && (
                <span
                  style={{
                    marginRight: "auto",
                    fontSize: 12,
                    color: testMessage.ok ? "#16a34a" : "#ef4444",
                    alignSelf: "center",
                  }}
                >
                  {testMessage.text}
                </span>
              )}
              <button
                className="workspace-action"
                disabled={testing || !hasStoredSecret}
                title={hasStoredSecret ? "用已保存的凭证发送一条测试消息" : "先保存凭证再测试"}
                onClick={() => void sendTest()}
              >
                {testing ? "发送中…" : "发送测试消息"}
              </button>
              <button
                className="workspace-action"
                disabled={saving || !canSave}
                onClick={() => void save()}
              >
                {saving ? "保存中…" : "保存配置"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
