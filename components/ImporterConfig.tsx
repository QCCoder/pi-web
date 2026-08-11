"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceCapability, WorkspaceSummary } from "@/lib/workspaces/types";
import type { ChandaoConfigPublic } from "@/lib/importers/types";
import { CapabilityToggle } from "./CapabilityToggle";

const CAPABILITY: WorkspaceCapability = "requirement-sources";

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/**
 * requirement-sources settings panel: toggle the capability, edit the Chandao
 * (禅道) importer credentials (REST token API), and test the connection.
 * Embedded in the Workspace settings view (WorkspaceManager), so it reuses the
 * workspace-* classes scoped there. Mirrors FeishuConfig.tsx.
 */
export function ImporterConfig({
  workspace,
  onWorkspaceChanged,
}: {
  workspace: WorkspaceSummary;
  onWorkspaceChanged: () => void;
}) {
  const enabled = workspace.capabilities.includes(CAPABILITY);
  const [config, setConfig] = useState<ChandaoConfigPublic | null>(null);
  const [base, setBase] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [assignee, setAssignee] = useState("");
  const [productId, setProductId] = useState("2");
  const [executionId, setExecutionId] = useState("3");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await responseJson<{ config: { chandao?: ChandaoConfigPublic } | null }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/importers`),
      );
      const chandao = data.config?.chandao ?? null;
      setConfig(chandao);
      setBase(chandao?.base ?? "");
      setAccount(chandao?.account ?? "");
      setAssignee(chandao?.assignee ?? "");
      setProductId(String(chandao?.productId ?? 2));
      setExecutionId(String(chandao?.executionId ?? 3));
      setPassword("");
      setToken("");
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
      const capabilities = workspace.capabilities.filter((capability) => capability !== CAPABILITY);
      if (next) capabilities.push(CAPABILITY);
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
    setTestResult(null);
    try {
      const data = await responseJson<{ config: { chandao?: ChandaoConfigPublic } | null }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/importers`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base,
            account,
            password,
            token: token || undefined,
            assignee,
            productId: Number(productId),
            executionId: Number(executionId),
          }),
        }),
      );
      setConfig(data.config?.chandao ?? null);
      setPassword("");
      setToken("");
      onWorkspaceChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [account, assignee, base, executionId, onWorkspaceChanged, password, productId, token, workspace.id]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const data = await responseJson<{
        ok: boolean;
        counts?: { bugs: number; tasks: number };
      }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/importers/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      setTestResult({
        ok: true,
        text: `连接成功：bugs ${data.counts?.bugs ?? 0} 条，tasks ${data.counts?.tasks ?? 0} 条`,
      });
    } catch (testError) {
      setTestResult({ ok: false, text: testError instanceof Error ? testError.message : String(testError) });
    } finally {
      setTesting(false);
    }
  }, [workspace.id]);

  const hasStoredPassword = Boolean(config?.hasPassword);
  const hasStoredToken = Boolean(config?.hasToken);
  const canSave =
    base.trim().length > 0
    && account.trim().length > 0
    && assignee.trim().length > 0
    && (password.trim().length > 0 || hasStoredPassword);

  return (
    <section className="workspace-settings-section">
      <div className="repository-section-header">
        <h3>需求来源（禅道 Importer）</h3>
        <CapabilityToggle enabled={enabled} loading={toggling} onToggle={(next) => void toggleCapability(next)} />
      </div>
      <div className="workspace-summary-card">
        <div className="workspace-rail-meta" style={{ marginBottom: 8 }}>
          启用后，可配置禅道凭据，定时把分派的 bug/task 拉取成本工作项（含图片）。
          {enabled ? " 当前已启用。" : " 当前未启用。"}
        </div>

        {error && <div className="workspace-error">{error}</div>}

        {loading ? (
          <div className="workspace-rail-meta">加载禅道配置…</div>
        ) : (
          <>
            <div className="workspace-form-grid">
              <label className="workspace-field">
                <span>禅道地址 base</span>
                <input
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                  placeholder="https://chandao.example.com"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>账号 account</span>
                <input
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder="qiancheng"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>
                  密码 password
                  {hasStoredPassword && (
                    <em style={{ color: "var(--text-dim)", marginLeft: 6 }}>已保存，留空保持不变</em>
                  )}
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={hasStoredPassword ? "••••••••（不修改则留空）" : "禅道登录密码"}
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>
                  Token（可选）
                  {hasStoredToken && (
                    <em style={{ color: "var(--text-dim)", marginLeft: 6 }}>已保存，留空保持不变</em>
                  )}
                </span>
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={hasStoredToken ? "••••••（不修改则留空，失效会自动重签）" : "留空则首次拉取时自动获取"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>分派人 assignee</span>
                <input
                  value={assignee}
                  onChange={(event) => setAssignee(event.target.value)}
                  placeholder="qiancheng"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>产品 productId</span>
                <input
                  value={productId}
                  onChange={(event) => setProductId(event.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="numeric"
                  placeholder="2"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="workspace-field">
                <span>执行 executionId</span>
                <input
                  value={executionId}
                  onChange={(event) => setExecutionId(event.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="numeric"
                  placeholder="3"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" }}>
              {testResult && (
                <span
                  style={{
                    marginRight: "auto",
                    fontSize: 12,
                    color: testResult.ok ? "#16a34a" : "#ef4444",
                    alignSelf: "center",
                  }}
                >
                  {testResult.text}
                </span>
              )}
              <button
                className="workspace-action"
                disabled={testing || !hasStoredPassword}
                title={hasStoredPassword ? "用已保存的凭据测试连接" : "先保存凭据再测试"}
                onClick={() => void testConnection()}
              >
                {testing ? "测试中…" : "测试连接"}
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
