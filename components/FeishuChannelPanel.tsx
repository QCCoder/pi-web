"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ChatSessionBinding,
  FeishuChannelStatus,
} from "@/lib/feishu-channel/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

interface Props {
  workspace: WorkspaceSummary;
  /** Refresh workspace data after a capability toggle (typically loadWorkspaces). */
  onRefresh: () => Promise<void> | void;
}

const STATE_LABEL: Record<FeishuChannelStatus["state"], string> = {
  disabled: "未启用",
  stopped: "已停止",
  connecting: "连接中…",
  connected: "已连接",
  reconnecting: "重连中…",
  error: "错误",
};

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * feishu-channel config panel. Always rendered in workspace settings so the
 * capability can be toggled on; the binding/status content shows only when the
 * capability is enabled (per the design: the binding/status panel is
 * conditioned on the feishu-channel capability).
 */
export function FeishuChannelPanel({ workspace, onRefresh }: Props) {
  const [status, setStatus] = useState<FeishuChannelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = workspace.capabilities.includes("feishu-channel");

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/feishu-channel`,
      );
      const data = (await res.json().catch(() => ({}))) as {
        status?: FeishuChannelStatus;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus(data.status ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspace.id]);

  useEffect(() => {
    if (enabled) void loadStatus();
  }, [enabled, loadStatus]);

  const toggleCapability = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const caps = new Set(workspace.capabilities);
        if (next) caps.add("feishu-channel");
        else caps.delete("feishu-channel");
        const res = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: workspace.updatedAt,
            capabilities: [...caps],
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        await onRefresh();
        if (next) await loadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [workspace.id, workspace.capabilities, workspace.updatedAt, onRefresh, loadStatus],
  );

  const restart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/feishu-channel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        status?: FeishuChannelStatus;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus(data.status ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [workspace.id]);

  return (
    <section className="workspace-settings-section">
      <div className="repository-section-header">
        <h3>飞书机器人入站 (feishu-channel)</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(event) => void toggleCapability(event.target.checked)}
          />
          <span className="workspace-rail-meta">{enabled ? "已启用" : "启用"}</span>
        </label>
      </div>
      <div className="workspace-summary-card">
        {error && <div className="workspace-error">{error}</div>}
        <div className="workspace-rail-meta">
          接收飞书单聊消息并路由到本工作区的 pi 会话（1 个会话 ↔ 1 个单聊；发送 <code>/new</code> 开启新会话）。复用 feishu-transport 的 appId/appSecret。
        </div>
        {enabled && (
          <>
            <div className="workspace-form-grid" style={{ marginTop: 10 }}>
              <div>
                <div className="workspace-rail-meta">连接状态</div>
                <div>{status ? (STATE_LABEL[status.state] ?? status.state) : "—"}</div>
              </div>
              <div>
                <div className="workspace-rail-meta">App ID</div>
                <div><code>{status?.appId ?? "—"}</code></div>
              </div>
              <div>
                <div className="workspace-rail-meta">App Secret</div>
                <div>{status?.hasAppSecret ? "已配置" : "未配置"}</div>
              </div>
              <div>
                <div className="workspace-rail-meta">最近事件</div>
                <div>{formatDate(status?.lastEventAt ?? undefined)}</div>
              </div>
            </div>
            {status && !status.hasAppSecret && (
              <div className="workspace-rail-meta" style={{ marginTop: 8 }}>
                ⚠️ 尚未配置 Feishu 凭证（appId/appSecret）。请先在 feishu-transport 设置中填写。
              </div>
            )}
            {status?.message && (
              <div className="workspace-rail-meta" style={{ marginTop: 8 }}>{status.message}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button
                className="workspace-action"
                disabled={busy}
                onClick={() => void restart()}
              >
                {busy ? "处理中…" : "重连"}
              </button>
            </div>
            <BindingsList bindings={status?.bindings ?? []} />
          </>
        )}
      </div>
    </section>
  );
}

function BindingsList({ bindings }: { bindings: ChatSessionBinding[] }) {
  if (bindings.length === 0) {
    return (
      <div className="workspace-rail-meta" style={{ marginTop: 10 }}>
        暂无会话绑定。在飞书单聊里给机器人发消息即可创建。
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="workspace-rail-meta">会话绑定（chat ↔ session）</div>
      <div className="repository-list">
        {bindings.map((binding) => (
          <div
            key={binding.chatId}
            className="work-item-row"
            style={{ gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}
          >
            <div>
              <div style={{ fontSize: 12 }}><code>{binding.chatId}</code></div>
              <div className="workspace-rail-meta">
                session <code>{binding.sessionId.slice(0, 8)}</code>
                {" · 最近消息 "}
                {formatDate(binding.lastMessageAt)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
