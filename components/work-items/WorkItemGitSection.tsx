"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkItemRepoBranchStatus, WorkItemMergeCheck } from "@/lib/work-items/branch-status";
import type { WorkspaceRepository } from "@/lib/workspaces/types";
import type { WorkItemRecord } from "@/lib/work-items/types";
import { useIsMobile } from "@/hooks/useIsMobile";
import { responseJson } from "./work-item-api";

/**
 * Git 分支区块（详情页，PC/手机共用）：每关联仓库展示「登记的开发分支 + 是否
 * 已合入 develop/master（兜底 main）」。合并状态由 /work-items/{key}/git 实时
 * 计算（本组件只展示，不落盘）；分支登记走通用 PATCH branches（released 冻结，
 * 由服务端把门）。刷新按钮 ?refresh=1 穿透服务端两层缓存。
 *
 * 两端操作习惯（2026-10）：桌面 = 输入框与动作按钮同一行内联；手机（触屏）=
 * 输入框独占一行（触屏上全局 16px 输入字号，flex-basis 100% 自然换行）、动作
 * 按钮换行加大触控目标、分支名输入关闭自动大写/自动纠正（手机键盘直接打
 * feature/xxx）。查看态徽标在手机上放大一号。
 */

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  minHeight: 24,
  padding: "0 9px",
  font: "inherit",
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const touchButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  minHeight: 32,
  padding: "0 12px",
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  flex: "1 1 160px",
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "4px 8px",
  font: "inherit",
  fontSize: 11.5,
  fontFamily: "var(--font-mono)",
  outline: "none",
};

function MergeBadge({ check, dense }: { check: WorkItemMergeCheck; dense: boolean }) {
  return (
    <span
      title={`相对 ${check.target} 的合并状态（实时计算）`}
      style={{
        padding: dense ? "1px 6px" : "2px 8px",
        borderRadius: 4,
        fontSize: dense ? 10.5 : 11.5,
        whiteSpace: "nowrap",
        color: check.merged ? "#16a34a" : "var(--text-muted)",
        background: check.merged ? "color-mix(in srgb, #16a34a 10%, transparent)" : "var(--bg-hover)",
        border: `1px solid ${check.merged ? "color-mix(in srgb, #16a34a 35%, var(--border))" : "var(--border)"}`,
      }}
    >
      {check.merged ? "已合入" : "未合入"} {check.target}
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11.5, minHeight: 20 }}>
      <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 52 }}>{label}</span>
      <span style={{ color: "var(--text-muted)", display: "inline-flex", gap: 5, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

export function WorkItemGitSection({
  workspaceId,
  item,
  repositories,
  frozen,
  onChanged,
  refreshKey = 0,
}: {
  workspaceId: string;
  item: WorkItemRecord;
  repositories: WorkspaceRepository[];
  /** released 基线冻结：分支登记只读（服务端对 branches PATCH 一律 400）。 */
  frozen: boolean;
  onChanged?: () => void;
  /** 父级「刷新」按钮信号：每次递增触发一次穿透缓存的重新计算。 */
  refreshKey?: number;
}) {
  const isMobile = useIsMobile();
  const [gitStatus, setGitStatus] = useState<WorkItemRepoBranchStatus[] | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [editingRepo, setEditingRepo] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState("");
  const [savingRepo, setSavingRepo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadGitStatus = useCallback(async (refresh = false) => {
    if (item.repositories.length === 0) return;
    setGitLoading(true);
    try {
      const data = await responseJson<{ repositories: WorkItemRepoBranchStatus[] }>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}/git${refresh ? "?refresh=1" : ""}`,
        ),
      );
      setGitStatus(data.repositories);
      setGitError(null);
    } catch (fetchError) {
      setGitError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setGitLoading(false);
    }
  }, [item.key, item.repositories.length, workspaceId]);

  useEffect(() => {
    void loadGitStatus(refreshKey > 0);
    // revision 变化（含本区块的分支登记 PATCH）→ 重拉合并状态。
  }, [loadGitStatus, item.revision, refreshKey]);

  const repositoryName = (id: string) => repositories.find((repo) => repo.id === id)?.name ?? id;

  const startEdit = (repositoryId: string, current: string | null) => {
    setEditingRepo(repositoryId);
    setBranchDraft(current ?? "");
    setSaveError(null);
  };

  const saveBranch = async (repositoryId: string) => {
    setSavingRepo(repositoryId);
    setSaveError(null);
    try {
      const branch = branchDraft.trim();
      const nextBranches = (item.branches ?? []).filter((entry) => entry.repositoryId !== repositoryId);
      if (branch) nextBranches.push({ repositoryId, branch });
      await responseJson(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: item.revision, branches: nextBranches }),
          },
        ),
      );
      setEditingRepo(null);
      onChanged?.();
    } catch (saveFailure) {
      const conflict = saveFailure instanceof Error && /409|conflict/i.test(saveFailure.message);
      setSaveError(
        conflict
          ? "版本冲突（内容已被其他修改更新），已过期——请重试。"
          : saveFailure instanceof Error ? saveFailure.message : String(saveFailure),
      );
      if (conflict) onChanged?.();
    } finally {
      setSavingRepo(null);
    }
  };

  if (item.repositories.length === 0) {
    return (
      <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
        未关联仓库——登记仓库后可在这里跟踪开发分支与合并状态。
      </div>
    );
  }

  const btn = isMobile ? touchButtonStyle : buttonStyle;
  // 手机：输入框 flex-basis 100% 独占一行，动作按钮自然换到下一行（触屏上
  // 输入框由全局 coarse-pointer 规则抬到 16px，高度再托底）。
  const editInputStyle: React.CSSProperties = isMobile
    ? { ...inputStyle, flex: "1 1 100%", minHeight: 36, fontSize: 12 }
    : inputStyle;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {(gitError ?? (!gitStatus && !gitLoading)) && (
        <div style={{ fontSize: 11, color: "#b45309" }}>
          {gitError ?? "分支状态加载中…"}
        </div>
      )}
      {saveError && <div style={{ fontSize: 11, color: "#dc2626" }}>{saveError}</div>}
      {item.repositories.map((repositoryId) => {
        const status = gitStatus?.find((repo) => repo.repositoryId === repositoryId);
        const registered = item.branches?.find((entry) => entry.repositoryId === repositoryId)?.branch ?? null;
        const editing = editingRepo === repositoryId;
        return (
          <div
            key={repositoryId}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: isMobile ? "10px 12px" : "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: isMobile ? 12.5 : 11.5, color: "var(--text)" }}>{repositoryName(repositoryId)}</strong>
              <span style={{ flex: 1 }} />
              {!frozen && !editing && (
                <button type="button" style={btn} onClick={() => startEdit(repositoryId, registered)}>
                  {registered ? "更改" : "登记分支"}
                </button>
              )}
            </div>
            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: isMobile ? 8 : 6, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    style={editInputStyle}
                    value={branchDraft}
                    placeholder="feature/20261026/xxx"
                    // 手机键盘习惯：分支名是小写+斜杠，关掉自动大写/纠正/拼写检查
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => setBranchDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && branchDraft.trim()) void saveBranch(repositoryId);
                      if (event.key === "Escape") setEditingRepo(null);
                    }}
                  />
                  <button
                    type="button"
                    style={btn}
                    disabled={!branchDraft.trim() || savingRepo === repositoryId}
                    onClick={() => void saveBranch(repositoryId)}
                  >
                    {savingRepo === repositoryId ? "保存中…" : "保存"}
                  </button>
                  {status?.repoBranch && (
                    <button type="button" style={btn} onClick={() => setBranchDraft(status.repoBranch ?? "")}>
                      取仓库当前分支
                    </button>
                  )}
                  <button type="button" style={btn} onClick={() => setEditingRepo(null)}>取消</button>
                </div>
                {status && status.deliveryBranches.length > 0 && (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>交付分支：</span>
                    {status.deliveryBranches.map((branch) => (
                      <button
                        key={branch}
                        type="button"
                        style={{ ...btn, fontFamily: "var(--font-mono)", fontWeight: 400, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
                        onClick={() => setBranchDraft(branch)}
                      >
                        {branch}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <MetaRow label="开发分支">
                  {registered ? (
                    <code
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: isMobile ? 12 : 11,
                        color: "var(--accent)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {registered}
                    </code>
                  ) : (
                    <span style={{ color: "var(--text-dim)" }}>未登记</span>
                  )}
                  {registered && status && !status.itemBranchExists && (
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>（仓库中不存在，可能已删除）</span>
                  )}
                  {status?.branchTargets.map((check) => <MergeBadge key={check.target} check={check} dense={isMobile} />)}
                </MetaRow>
                <MetaRow label="仓库分支">
                  {status ? (status.repoBranch ?? "—") : "…"}
                </MetaRow>
                {status?.latestDelivery && (
                  <MetaRow label="交付分支">
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: isMobile ? 12 : 11, overflowWrap: "anywhere" }}>
                      {status.latestDelivery.branch}
                    </code>
                    {status.latestDelivery.targets.map((check) => <MergeBadge key={check.target} check={check} dense={isMobile} />)}
                  </MetaRow>
                )}
                {status?.candidate && (
                  <MetaRow label="候选提交">
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: isMobile ? 12 : 11, overflowWrap: "anywhere" }}>
                      {status.candidate.commit}
                    </code>
                    {status.candidate.targets.map((check) => <MergeBadge key={check.target} check={check} dense={isMobile} />)}
                  </MetaRow>
                )}
                {status?.error && (
                  <div style={{ fontSize: 10.5, color: "#b45309" }}>{status.error}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
