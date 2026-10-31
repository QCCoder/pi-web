"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeliveryRoleSummary } from "@/lib/api-types";
import type { WorkspaceCapability, WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";
import { isWorkspaceSelectable } from "@/lib/workspaces/types";
import { workspaceAvatarStyle } from "../ProjectSidebar";
import {
  MobileCard,
  MobileErrorBanner,
  MobileNavBar,
  MobileNote,
  MobilePill,
  MobilePrimaryButton,
  MobileRow,
  MobileSecondaryButton,
  MobileSection,
  MobileSwitch,
} from "./mobile-ui";
import { shortenPath } from "./useMobileSkills";

/**
 * 手机壳推入页：单个工作区的设置（2026-10 底部 tab 改版；用户反馈「工作区设置 UI
 * 太丑」后由内嵌桌面 WorkspaceManager 双栏改为手机原生分组卡片页）。与桌面走
 * 同一套后端契约（knowledge/reference/workspace.md）：
 *
 *   基本信息   名称（PATCH {expectedUpdatedAt,name}）/ 路径 / 启用开关
 *              （PATCH {expectedUpdatedAt,disabled}；停用 = 首页与选择器不再出现，
 *              已打开会话不受影响——重启用路径就在这里）
 *   能力       只读 pills（桌面亦为创建时选定、详情只读；sessions/explorer 常驻）
 *   Skill      入口 → Skill tab（项目 + 全局 skill 的列表/启停/安装；2026-10 工作区白名单已退役）
 *   仓库       GET/DELETE/PATCH /repositories（停用 / 恢复；新增走桌面端）
 *   交付自动化 GET /delivery + /delivery/roles 只读摘要（配置改动走桌面端）
 *   移除       DELETE /api/workspaces/{id}（仅从列表注销，目录与配置保留；两步确认）
 *
 * 所有 PATCH 带 expectedUpdatedAt；409 = 别处已改 → 提示并重拉列表。成功后把
 * 响应里的 workspace 合并回壳（桌面 Manager 是整表重拉，手机页合并即可）。
 */

const CAPABILITY_LABELS: Record<WorkspaceCapability, string> = {
  sessions: "会话",
  explorer: "文件浏览",
  "work-items": "工作项",
  repositories: "代码仓库",
  knowledge: "知识库",
  workflows: "Loops",
  subagent: "子代理",
};

const ROLE_LABELS: Record<string, string> = {
  designer: "设计师",
  developer: "开发者",
  verifier: "验证者",
  "release-preparer": "发布准备者",
};

interface DeliveryConfigSummary {
  enabled: boolean;
  roles: Record<string, unknown>;
}

function repoStateText(repo: WorkspaceRepositoryState): string {
  if (repo.status === "removed") return `${repo.kind === "code" ? "代码" : "知识库"} · 已停用`;
  if (!repo.exists) return "路径不可用";
  return `${repo.branch || "detached"}${repo.dirty ? " · 有修改" : " · 干净"}`;
}

export function MobileWorkspaceSettings({
  workspace,
  onBack,
  backLabel,
  onWorkspaceUpdated,
  onReloadWorkspaces,
  onDeleted,
  onOpenSkills,
}: {
  workspace: WorkspaceSummary;
  onBack: () => void;
  backLabel: string;
  /** PATCH 成功：把响应里的 workspace 合并回壳的列表。 */
  onWorkspaceUpdated: (workspace: WorkspaceSummary) => void;
  /** 409 冲突 / 仓库变更后整表重拉。 */
  onReloadWorkspaces: () => void;
  /** DELETE 成功（从列表注销）。 */
  onDeleted: (workspace: WorkspaceSummary) => void;
  /** Skill 白名单 → 切到 Skill tab（白名单模式）。 */
  onOpenSkills: () => void;
}) {
  const selectable = isWorkspaceSelectable(workspace);
  const [nameDraft, setNameDraft] = useState(workspace.name);
  const [savingName, setSavingName] = useState(false);
  const [togglingDisabled, setTogglingDisabled] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    setNameDraft(workspace.name);
  }, [workspace.id, workspace.name]);

  const patchWorkspace = useCallback(async (body: Record<string, unknown>) => {
    setPatchError(null);
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: workspace.updatedAt, ...body }),
    });
    const data = (await res.json()) as { workspace?: WorkspaceSummary; error?: string };
    if (res.status === 409) {
      onReloadWorkspaces();
      throw new Error("工作区已在别处修改，列表已刷新，请重试。");
    }
    if (!res.ok || !data.workspace) throw new Error(data.error ?? `HTTP ${res.status}`);
    onWorkspaceUpdated(data.workspace);
  }, [workspace.id, workspace.updatedAt, onReloadWorkspaces, onWorkspaceUpdated]);

  const saveName = useCallback(async () => {
    const next = nameDraft.trim();
    if (!next || next === workspace.name) return;
    setSavingName(true);
    try {
      await patchWorkspace({ name: next });
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingName(false);
    }
  }, [nameDraft, workspace.name, patchWorkspace]);

  const toggleDisabled = useCallback(async () => {
    setTogglingDisabled(true);
    try {
      await patchWorkspace({ disabled: !workspace.disabled });
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : String(error));
    } finally {
      setTogglingDisabled(false);
    }
  }, [workspace.disabled, patchWorkspace]);

  // ---- 仓库 ------------------------------------------------------------------
  const hasRepositories = workspace.capabilities.includes("repositories");
  const [repos, setRepos] = useState<WorkspaceRepositoryState[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoBusyId, setRepoBusyId] = useState<string | null>(null);
  const loadRepos = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories?refresh=1`);
      const data = (await res.json()) as { repositories?: WorkspaceRepositoryState[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRepos(data.repositories ?? []);
      setReposError(null);
    } catch (error) {
      setReposError(error instanceof Error ? error.message : String(error));
    }
  }, [workspace.id]);
  useEffect(() => {
    if (!hasRepositories) return;
    void loadRepos();
  }, [hasRepositories, loadRepos]);

  const deactivateRepo = useCallback(async (repo: WorkspaceRepositoryState) => {
    if (!window.confirm(`停用 ${repo.alias}？仓库文件会保留在原目录。`)) return;
    setRepoBusyId(repo.id);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories?repositoryId=${encodeURIComponent(repo.id)}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadRepos();
      onReloadWorkspaces();
    } catch (error) {
      setReposError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepoBusyId(null);
    }
  }, [workspace.id, loadRepos, onReloadWorkspaces]);

  const restoreRepo = useCallback(async (repo: WorkspaceRepositoryState) => {
    setRepoBusyId(repo.id);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId: repo.id, action: "restore" }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadRepos();
      onReloadWorkspaces();
    } catch (error) {
      setReposError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepoBusyId(null);
    }
  }, [workspace.id, loadRepos, onReloadWorkspaces]);

  // ---- 交付自动化（只读摘要）---------------------------------------------------
  const automationCapable = workspace.capabilities.includes("work-items") && workspace.capabilities.includes("workflows");
  const [delivery, setDelivery] = useState<DeliveryConfigSummary | null | undefined>(undefined);
  const [roles, setRoles] = useState<DeliveryRoleSummary[] | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  useEffect(() => {
    if (!automationCapable) return;
    let cancelled = false;
    (async () => {
      try {
        const [configRes, rolesRes] = await Promise.all([
          fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/delivery`),
          fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/delivery/roles`),
        ]);
        const configData = (await configRes.json()) as { config?: DeliveryConfigSummary | null; error?: string };
        const rolesData = (await rolesRes.json()) as { roles?: DeliveryRoleSummary[]; error?: string };
        if (!configRes.ok) throw new Error(configData.error ?? `HTTP ${configRes.status}`);
        if (cancelled) return;
        setDelivery(configData.config ?? null);
        setRoles(rolesRes.ok ? (rolesData.roles ?? []) : null);
      } catch (error) {
        if (!cancelled) setDeliveryError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [automationCapable, workspace.id]);

  // ---- 移除 -------------------------------------------------------------------
  const removeWorkspace = useCallback(async () => {
    setRemoving(true);
    setPatchError(null);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      const data = (await res.json()) as { removed?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onDeleted(workspace);
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : String(error));
      setRemoving(false);
    }
  }, [workspace, onDeleted]);

  const avatar = workspaceAvatarStyle(workspace.name);
  const initial = [...workspace.name][0]?.toUpperCase() ?? "?";
  const nameDirty = nameDraft.trim() !== "" && nameDraft.trim() !== workspace.name;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar title="工作区设置" onBack={onBack} backLabel={backLabel} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 36 }}>
        {/* hero-lite */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 2px" }}>
          <span aria-hidden style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, fontWeight: 700, ...avatar }}>
            {initial}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workspace.name}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <MobilePill tone={selectable ? "accent" : "muted"}>
                {workspace.disabled ? "已停用" : !workspace.available ? "目录不可用" : "启用中"}
              </MobilePill>
              {workspace.configStatus !== "ready" && <MobilePill>{workspace.configStatus}</MobilePill>}
            </div>
          </div>
        </div>

        {patchError && <MobileErrorBanner>{patchError}</MobileErrorBanner>}

        <MobileSection title="基本信息" />
        <MobileCard>
          <div style={{ padding: "12px 14px 10px" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>名称</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }}
                aria-label="工作区名称"
                style={{
                  flex: 1, minWidth: 0, height: 38, borderRadius: 10, border: "1px solid var(--border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 15, padding: "0 12px", outline: "none",
                }}
              />
              {nameDirty && (
                <MobilePrimaryButton onClick={() => { void saveName(); }} busy={savingName}>
                  {savingName ? "保存中…" : "保存"}
                </MobilePrimaryButton>
              )}
            </div>
          </div>
          <MobileRow label="路径" hint={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }} title={workspace.path}>{shortenPath(workspace.path)}</span>} />
          <MobileRow
            label={workspace.disabled ? "已停用" : "启用"}
            sublabel={workspace.disabled ? "首页与选择器不再出现；已打开的会话不受影响" : "出现在首页与各工作区选择器"}
            trailing={(
              <MobileSwitch
                checked={!workspace.disabled}
                onChange={() => { void toggleDisabled(); }}
                disabled={togglingDisabled || !workspace.available}
                label={workspace.disabled ? "启用工作区" : "停用工作区"}
              />
            )}
          />
        </MobileCard>
        {!workspace.available && (
          <MobileNote>目录不可用（{workspace.configStatus}）：请在桌面端检查路径或重新导入。</MobileNote>
        )}

        <MobileSection title="能力" />
        <MobileCard>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "12px 14px" }}>
            {workspace.capabilities.map((capability) => (
              <MobilePill key={capability} tone={capability === "sessions" || capability === "explorer" ? "muted" : "accent"}>
                {CAPABILITY_LABELS[capability] ?? capability}
              </MobilePill>
            ))}
          </div>
        </MobileCard>
        <MobileNote>能力在创建工作区时选定（会话与文件浏览常驻）；与桌面一致，创建后不在此处切换。</MobileNote>

        <MobileSection title="Skill" />
        <MobileCard>
          <MobileRow
            first
            label="项目与全局 Skill"
            sublabel={selectable ? "列表 / 启停 / 安装到本项目在 Skill tab" : "启用工作区后可进入"}
            onClick={selectable ? onOpenSkills : undefined}
            disabled={!selectable}
            chevron={selectable}
          />
        </MobileCard>

        {hasRepositories && (
          <>
            <MobileSection title="仓库" trailing={repos ? <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{repos.length}</span> : undefined} />
            {reposError && <MobileErrorBanner>{reposError}</MobileErrorBanner>}
            <MobileCard>
              {repos === null && !reposError && (
                <div style={{ padding: "18px 14px", fontSize: 13, color: "var(--text-dim)", textAlign: "center" }}>加载中…</div>
              )}
              {repos && repos.length === 0 && (
                <div style={{ padding: "18px 14px", fontSize: 13, color: "var(--text-dim)", textAlign: "center" }}>
                  还没有登记仓库——根目录下的 git 仓库与 OKF 知识库会在桌面端打开设置时自动登记。
                </div>
              )}
              {repos?.map((repo, index) => {
                const removed = repo.status === "removed";
                const busy = repoBusyId === repo.id;
                return (
                  <MobileRow
                    key={repo.id}
                    first={index === 0}
                    label={repo.name}
                    sublabel={<><span style={{ fontFamily: "var(--font-mono)" }}>{repo.path}</span> · {repoStateText(repo)}</>}
                    disabled={removed}
                    trailing={(
                      removed ? (
                        <MobileSecondaryButton onClick={() => { void restoreRepo(repo); }} busy={busy}>恢复</MobileSecondaryButton>
                      ) : (
                        <MobileSecondaryButton onClick={() => { void deactivateRepo(repo); }} busy={busy}>停用</MobileSecondaryButton>
                      )
                    )}
                  />
                );
              })}
            </MobileCard>
            <MobileNote>新增仓库（克隆 / 初始化 / 登记已有目录）请在桌面端操作；这里只做停用与恢复。</MobileNote>
          </>
        )}

        {automationCapable && (
          <>
            <MobileSection title="交付自动化" />
            {deliveryError && <MobileErrorBanner>{deliveryError}</MobileErrorBanner>}
            <MobileCard>
              <MobileRow
                first
                label="自动执行"
                hint={delivery === undefined ? "加载中…" : delivery === null ? "未配置" : delivery.enabled ? "开启" : "关闭"}
              />
              {roles?.map((role) => (
                <MobileRow
                  key={role.role}
                  label={ROLE_LABELS[role.role] ?? role.role}
                  sublabel={`${role.profile.name}${role.profile.exists ? "" : "（缺剧本）"} · ${role.model.effective ? role.model.effective.modelId : "默认模型"}`}
                />
              ))}
            </MobileCard>
            <MobileNote>四角色剧本、模型覆写与检查项在桌面端「设置 › 工作区 › 交付自动化」配置；这里只读。</MobileNote>
          </>
        )}

        <MobileSection title="移除" />
        <MobileCard>
          {!removeConfirm ? (
            <MobileRow
              first
              label={<span style={{ color: "#dc2626" }}>从列表移除</span>}
              sublabel="目录与 Workspace 配置不会被删除"
              onClick={() => setRemoveConfirm(true)}
              chevron={false}
            />
          ) : (
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13.5, color: "var(--text)" }}>从列表移除「{workspace.name}」？</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>只从 Pi 的工作区列表注销；目录、配置与会话文件都保留，之后可重新导入。</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <MobileSecondaryButton onClick={() => setRemoveConfirm(false)} disabled={removing}>取消</MobileSecondaryButton>
                <button
                  type="button"
                  onClick={() => { void removeWorkspace(); }}
                  disabled={removing}
                  style={{ height: 34, padding: "0 14px", borderRadius: 10, border: 0, background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 600, cursor: removing ? "default" : "pointer", opacity: removing ? 0.7 : 1 }}
                >
                  {removing ? "移除中…" : "确认移除"}
                </button>
              </div>
            </div>
          )}
        </MobileCard>
      </div>
    </div>
  );
}
