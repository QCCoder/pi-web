"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceRepository } from "@/lib/workspaces/types";
import type {
  WorkItemDetail,
  WorkItemPriority,
  WorkItemRecord,
} from "@/lib/work-items/types";
import { MarkdownBody } from "../MarkdownBody";
import { formatRelativeTime } from "@/lib/format-time";
import { responseJson, uploadWorkItemAttachments, WorkItemRequestError } from "./work-item-api";
import { WorkItemActionbar } from "./WorkItemActionbar";
import { WorkItemAttachmentPicker } from "./WorkItemCreateForm";
import { WorkItemEvents } from "./WorkItemEvents";
import {
  DeliveryExecutionState,
  ExecutionActionResult,
  WorkItemExecution,
} from "./WorkItemExecution";
import { SourceRefValue, WorkItemRepositoryChips } from "./WorkItemMeta";
import { PHASE_LABELS, STATUS_LABELS, TYPE_LABELS } from "./work-item-phases";

/** 中央工作项详情视图（M2 T9，spec §6.2/§7）：概况（只读非空 + 编辑模式）、
 *  原始描述与附件（MarkdownBody cwd=工作项目录，附件引用可渲染）、验收条件
 *  与设计（design.md 查看/编辑，改已确认设计前警示失效规则）、代码与验证
 *  （candidates/checks/发布登记，只读）、关联会话（含执行中断跳转）、审计
 *  历史（events 时间线）与标准流程动作条。回收站范围选中时进入 trashed 模式
 *  ——只读概况 + 「从回收站恢复」（POST restore-from-trash；key 冲突 409）。
 *
 * 详情数据由本组件按 key 拉取（revision 感知：快照里的 item.revision 变化
 * 即重取，动作成功 → 宿主 invalidate() → 快照新 revision → 自动刷新详情）。 */

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-dim)",
  letterSpacing: "0.04em",
};

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  minHeight: 26,
  padding: "0 10px",
  font: "inherit",
  fontSize: 11.5,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  color: "#dc2626",
  borderColor: "color-mix(in srgb, #dc2626 40%, var(--border))",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "6px 9px",
  font: "inherit",
  fontSize: 12,
  outline: "none",
};

function Section({ title, children, actions }: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={sectionTitleStyle}>{title}</h3>
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {children}
    </section>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11.5, minHeight: 20 }}>
      <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 52 }}>{label}</span>
      <span style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

const OUTCOME_LABELS: Record<string, string> = {
  passed: "通过",
  failed: "未通过",
  unverified: "未验证",
};

/** 交付证据只读块（spec §7.3）：候选 / 验证记录（含 checks）/ 发布计划 /
 *  发布登记。结构化数据来自 item.delivery，UI 只展示不改写。 */
function DeliveryEvidence({ item, repositories }: {
  item: WorkItemRecord;
  repositories: WorkspaceRepository[];
}) {
  const delivery = item.delivery;
  if (!delivery) return null;
  const repositoryName = (id: string) => repositories.find((repo) => repo.id === id)?.name ?? id;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5 }}>
      {delivery.designConfirmed && (
        <div style={{ color: "var(--text-muted)" }}>
          设计已确认 {formatRelativeTime(delivery.designConfirmed.at)}（绑定当时的需求与设计版本，变更即失效）
        </div>
      )}
      {delivery.candidates && delivery.candidates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <strong style={{ fontSize: 11, color: "var(--text-dim)" }}>候选提交</strong>
          {delivery.candidates.map((candidate) => (
            <div key={candidate.repositoryId} style={{ display: "flex", gap: 8, overflowWrap: "anywhere" }}>
              <span style={{ color: "var(--text-muted)" }}>{repositoryName(candidate.repositoryId)}</span>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{candidate.commit}</code>
            </div>
          ))}
        </div>
      )}
      {delivery.verification && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <strong style={{ fontSize: 11, color: "var(--text-dim)" }}>
            验证记录 {formatRelativeTime(delivery.verification.at)}
          </strong>
          {delivery.verification.checks.map((check, index) => (
            <div key={`${check.name}-${index}`} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: 5,
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: check.outcome === "passed" ? "#16a34a" : check.outcome === "failed" ? "#dc2626" : "var(--text-dim)",
                  background: check.outcome === "passed"
                    ? "rgba(22,163,74,0.12)"
                    : check.outcome === "failed"
                      ? "rgba(220,38,38,0.1)"
                      : "var(--bg-hover)",
                }}
              >
                {OUTCOME_LABELS[check.outcome] ?? check.outcome}
              </span>
              <span style={{ color: "var(--text-muted)" }}>{check.name}</span>
              {check.note && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{check.note}</span>}
            </div>
          ))}
        </div>
      )}
      {delivery.releasePlan && (delivery.releasePlan.notes || delivery.releasePlan.rollback) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <strong style={{ fontSize: 11, color: "var(--text-dim)" }}>发布计划</strong>
          {delivery.releasePlan.notes && (
            <div style={{ color: "var(--text-muted)" }}>说明：{delivery.releasePlan.notes}</div>
          )}
          {delivery.releasePlan.rollback && (
            <div style={{ color: "var(--text-muted)" }}>回滚：{delivery.releasePlan.rollback}</div>
          )}
        </div>
      )}
      {delivery.release && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <strong style={{ fontSize: 11, color: "var(--text-dim)" }}>
            已发布 · {delivery.release.version}（{formatRelativeTime(delivery.release.at)}）
          </strong>
          {delivery.release.candidates.map((candidate) => (
            <div key={candidate.repositoryId} style={{ display: "flex", gap: 8, overflowWrap: "anywhere" }}>
              <span style={{ color: "var(--text-muted)" }}>{repositoryName(candidate.repositoryId)}</span>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{candidate.commit}</code>
            </div>
          ))}
          {delivery.release.notes && <div style={{ color: "var(--text-muted)" }}>说明：{delivery.release.notes}</div>}
          {delivery.release.rollback && <div style={{ color: "var(--text-muted)" }}>回滚：{delivery.release.rollback}</div>}
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
            已发布基线冻结——后续改动请新建关联工作项。
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkItemDetailView({
  workspaceId,
  item,
  repositories,
  trashed = false,
  execution = null,
  executionBusy = false,
  onOpenConversation,
  onOpenLoopsRecovery,
  onStopExecution,
  onRecoverExecution,
  onResumeAutomation,
  onChanged,
  onClose,
  onRestored,
  onDirtyChange,
}: {
  workspaceId: string;
  /** 快照里的选中记录（列表/看板/回收站行）。 */
  item: WorkItemRecord;
  repositories: WorkspaceRepository[];
  /** 回收站范围选中：只读概况 + 恢复入口，不拉取详情（路径在 .pi/trash 下）。 */
  trashed?: boolean;
  /** 交付自动执行状态（Phase-2 Task 9）：宿主 WorkItemsPage 拉取（仅 managed
   *  项），经本视图转投 WorkItemExecution；null = 未拉/拉取中。 */
  execution?: DeliveryExecutionState | null;
  /** 执行动作进行中（宿主持有）——busy 期间禁用全部执行按钮。 */
  executionBusy?: boolean;
  onOpenConversation: (sessionId: string) => void;
  /** 执行中断（spec §5.4）：绑定的 loop 有未确认中断记录 → 「去处理」跳 Loops 面板。 */
  onOpenLoopsRecovery?: () => void;
  /** 交付执行三动作（宿主 POST 对应路由后刷新执行状态 + 快照）：停止执行。 */
  onStopExecution?: () => Promise<ExecutionActionResult>;
  /** 交付执行三动作：重新检查并恢复（409 pids → {ok:false,error} 内联提示）。 */
  onRecoverExecution?: () => Promise<ExecutionActionResult>;
  /** 交付执行三动作：恢复自动领取（清暂停标记 + 重置失败窗口）。 */
  onResumeAutomation?: () => Promise<ExecutionActionResult>;
  /** 任一 mutation 成功（或 409 后）→ 宿主 invalidate()；快照新 revision 触发详情重取。 */
  onChanged?: () => void;
  /** 清除选中（× / 移入回收站后）。 */
  onClose?: () => void;
  /** 从回收站恢复成功 → 宿主切回活动范围并选中原 key。 */
  onRestored?: (key: string) => void;
  /** 草稿态上报（概况编辑 / 正文编辑 / 设计编辑）——宿主在切项/切工作区前 confirm。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [priorityDraft, setPriorityDraft] = useState<WorkItemPriority>(item.priority);
  const [tagsDraft, setTagsDraft] = useState("");
  const [repoDraft, setRepoDraft] = useState<string[]>([]);
  const [contentEditing, setContentEditing] = useState(false);
  const [contentDraft, setContentDraft] = useState("");
  const [design, setDesign] = useState<{ content: string } | null>(null);
  const [designMissing, setDesignMissing] = useState(false);
  const [designEditing, setDesignEditing] = useState(false);
  const [designDraft, setDesignDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [interruptionPending, setInterruptionPending] = useState(false);

  // —— 详情拉取（revision 感知：动作/编辑成功 → invalidate → 快照新 revision
  // → 本 effect 重跑拿新详情）。 ——
  const loadDetail = useCallback(async () => {
    if (trashed) return;
    setDetailError(null);
    try {
      const next = await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}`,
        ),
      );
      setDetail(next);
    } catch (loadError) {
      setDetail(null);
      setDetailError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [item.key, trashed, workspaceId]);

  useEffect(() => {
    if (trashed) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    void loadDetail();
  }, [loadDetail, trashed, item.revision]);

  // —— design.md 拉取（managed 项才有；404 = 尚未生成）。 ——
  useEffect(() => {
    if (trashed || item.delivery?.protocolVersion !== 1) {
      setDesign(null);
      setDesignMissing(false);
      setDesignEditing(false);
      return;
    }
    let cancelled = false;
    setDesignMissing(false);
    void fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}/design`,
    )
      .then(async (response) => {
        if (!response.ok) return null; // 404 = not seeded yet
        return (await response.json()) as { content: string };
      })
      .then((result) => {
        if (cancelled) return;
        if (result) setDesign(result);
        else {
          setDesign(null);
          setDesignMissing(true);
        }
      })
      .catch(() => {
        if (!cancelled) setDesignMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.key, item.delivery?.protocolVersion, item.revision, trashed, workspaceId]);

  // —— 执行中断（M1 留口，spec §5.4）：绑定的 loop 存在未确认中断记录时展示
  //    「执行中断，待恢复 → 去处理」。仅在 item.loop 有值时拉取 loops 状态。 ——
  useEffect(() => {
    if (!item.loop || trashed) {
      setInterruptionPending(false);
      return;
    }
    let cancelled = false;
    void fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/loops`)
      .then(async (response) => {
        if (!response.ok) return { interruptions: [] };
        return (await response.json()) as { interruptions?: Array<{ loopName: string }> };
      })
      .then((data) => {
        if (cancelled) return;
        setInterruptionPending(
          (data.interruptions ?? []).some((interruption) => interruption.loopName === item.loop),
        );
      })
      .catch(() => {
        if (!cancelled) setInterruptionPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.key, item.loop, trashed, workspaceId, item.revision]);

  // —— 编辑草稿在进入编辑态那一刻播种（不跟随 5s 轮询刷新——快照每次轮询都换
  //  对象身份，跟随 effect 会把打字中的草稿冲掉）。
  const enterEditMode = () => {
    setTitleDraft(item.title);
    setPriorityDraft(item.priority);
    setTagsDraft(item.tags.join(", "));
    setRepoDraft(item.repositories);
    setEditMode(true);
  };

  const startContentEdit = () => {
    if (!detail) return;
    setContentDraft(detail.content);
    setContentEditing(true);
  };

  const startDesignEdit = () => {
    if (!design) return;
    if (item.delivery?.designConfirmed) {
      const proceed = window.confirm(
        "设计已确认：保存修改将撤销确认与下游证据（候选、验证、发布计划），阶段回到「设计」等待重新确认。继续编辑？",
      );
      if (!proceed) return;
    }
    setDesignDraft(design.content);
    setDesignEditing(true);
  };

  // —— 草稿态上报 ——
  const dirty = editMode
    || (contentEditing && detail != null && contentDraft !== detail.content)
    || (designEditing && design != null && designDraft !== design.content);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const handleConflict = (error: unknown, fallback: () => void) => {
    if (error instanceof WorkItemRequestError && error.status === 409) {
      setActionError("内容已被其他修改更新（版本冲突），已重新获取最新状态，请重试。");
      onChanged?.();
      fallback();
      return true;
    }
    return false;
  };

  const patchItem = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setActionError(null);
    try {
      await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: item.revision, ...patch }),
          },
        ),
      );
      setEditMode(false);
      onChanged?.();
    } catch (patchError) {
      if (!handleConflict(patchError, () => setEditMode(false))) {
        setActionError(patchError instanceof Error ? patchError.message : String(patchError));
      }
    } finally {
      setSaving(false);
    }
  };

  const saveContent = async () => {
    if (!detail) return;
    setSaving(true);
    setActionError(null);
    try {
      await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}/content`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: item.revision, content: contentDraft }),
          },
        ),
      );
      setContentEditing(false);
      onChanged?.();
    } catch (saveError) {
      if (!handleConflict(saveError, () => setContentEditing(false))) {
        setActionError(saveError instanceof Error ? saveError.message : String(saveError));
      }
    } finally {
      setSaving(false);
    }
  };

  const saveDesign = async () => {
    setSaving(true);
    setActionError(null);
    try {
      await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}/design`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: item.revision, content: designDraft }),
          },
        ),
      );
      setDesignEditing(false);
      onChanged?.();
    } catch (saveError) {
      if (!handleConflict(saveError, () => setDesignEditing(false))) {
        setActionError(saveError instanceof Error ? saveError.message : String(saveError));
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    const archived = Boolean(item.archivedAt);
    if (!archived && !window.confirm(`归档 ${item.key}？归档后默认列表将不再显示。`)) return;
    await patchItem({ archived: !archived });
  };

  const trash = async () => {
    if (!window.confirm(`将 ${item.key} 移到 Workspace 回收站？目录与关联会话保留，可在「回收站」范围恢复。`)) return;
    setSaving(true);
    setActionError(null);
    try {
      await responseJson(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}`,
          { method: "DELETE" },
        ),
      );
      onChanged?.();
      onClose?.();
    } catch (trashError) {
      if (!handleConflict(trashError, () => undefined)) {
        setActionError(trashError instanceof Error ? trashError.message : String(trashError));
      }
    } finally {
      setSaving(false);
    }
  };

  const restoreFromTrash = async () => {
    setSaving(true);
    setActionError(null);
    try {
      const restored = await responseJson<WorkItemDetail>(
        await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}/restore-from-trash`,
          { method: "POST" },
        ),
      );
      onChanged?.();
      onRestored?.(restored.item.key);
    } catch (restoreError) {
      setActionError(restoreError instanceof Error ? restoreError.message : String(restoreError));
    } finally {
      setSaving(false);
    }
  };

  const uploadAttachments = async () => {
    if (pendingFiles.length === 0) return;
    setSaving(true);
    setActionError(null);
    try {
      await uploadWorkItemAttachments(workspaceId, item.key, pendingFiles);
      setPendingFiles([]);
      onChanged?.();
    } catch (uploadError) {
      setActionError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setSaving(false);
    }
  };

  const activeRepositories = useMemo(
    () => repositories.filter((repository) => repository.status === "active"),
    [repositories],
  );

  const header = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: item.type === "bug" ? "#dc2626" : "var(--accent)",
          }}
        >
          {item.key}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{TYPE_LABELS[item.type]}</span>
        <span
          style={{
            padding: "1px 7px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            fontSize: 10.5,
            color: item.status === "blocked" ? "#dc2626" : "var(--text-muted)",
          }}
        >
          {STATUS_LABELS[item.status]}
        </span>
        <span
          style={{
            padding: "1px 7px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            fontSize: 10.5,
            color: "var(--text-muted)",
          }}
        >
          {PHASE_LABELS[item.phase]}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{item.priority}</span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button type="button" style={buttonStyle} onClick={onClose} aria-label="关闭详情">✕</button>
        )}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {item.title}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        更新于 {formatRelativeTime(item.updatedAt)} · revision {item.revision}
        {item.archivedAt ? " · 已归档" : ""}
      </div>
    </div>
  );

  if (trashed) {
    return (
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
        {header}
        <div
          style={{
            border: "1px solid color-mix(in srgb, #f59e0b 40%, var(--border))",
            borderRadius: 9,
            background: "color-mix(in srgb, #f59e0b 7%, var(--bg))",
            padding: 12,
            fontSize: 11.5,
            color: "var(--text-muted)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div>此工作项已移入回收站（目录保留在 .pi/trash/work-items，未删除）。</div>
          <div style={{ color: "var(--text-dim)" }}>
            恢复将按原 key 原子移回活动区并记录恢复事件；key 已被新项占用时返回 409。
          </div>
          {actionError && <div style={{ color: "#dc2626" }}>{actionError}</div>}
          <div>
            <button type="button" style={buttonStyle} disabled={saving} onClick={() => void restoreFromTrash()}>
              {saving ? "恢复中…" : "从回收站恢复"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      {header}

      {actionError && (
        <div
          role="alert"
          style={{
            border: "1px solid color-mix(in srgb, #ef4444 40%, var(--border))",
            borderRadius: 8,
            background: "color-mix(in srgb, #ef4444 7%, var(--bg))",
            color: "#dc2626",
            padding: "8px 10px",
            fontSize: 11.5,
          }}
        >
          {actionError}
        </div>
      )}

      {/* 动作区：详情级操作 + 标准流程动作条（只渲染合法动作）。 */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <button type="button" style={buttonStyle} onClick={() => (editMode ? setEditMode(false) : enterEditMode())}>
          {editMode ? "取消编辑" : "编辑"}
        </button>
        <button type="button" style={buttonStyle} disabled={saving} onClick={() => void toggleArchive()}>
          {item.archivedAt ? "取消归档" : "归档"}
        </button>
        <button type="button" style={dangerButtonStyle} disabled={saving} onClick={() => void trash()}>
          移到回收站
        </button>
      </div>

      {editMode ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
            <span>标题</span>
            <input style={inputStyle} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-muted)", flex: "0 0 110px" }}>
              <span>优先级</span>
              <select
                style={inputStyle}
                value={priorityDraft}
                onChange={(event) => setPriorityDraft(event.target.value as WorkItemPriority)}
              >
                {(["P0", "P1", "P2", "P3"] as const).map((priority) => (
                  <option key={priority} value={priority}>{priority}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-muted)", flex: "1 1 160px" }}>
              <span>标签（逗号分隔）</span>
              <input
                style={inputStyle}
                value={tagsDraft}
                placeholder="frontend, urgent"
                onChange={(event) => setTagsDraft(event.target.value)}
              />
            </label>
          </div>
          {item.phase !== "released" && activeRepositories.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
              <span>仓库范围</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {activeRepositories.map((repository) => (
                  <label
                    key={repository.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      border: "1px solid var(--border)",
                      borderRadius: 999,
                      padding: "4px 9px",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={repoDraft.includes(repository.id)}
                      onChange={(event) => {
                        setRepoDraft((current) => event.target.checked
                          ? [...new Set([...current, repository.id])]
                          : current.filter((id) => id !== repository.id));
                      }}
                    />
                    {repository.name} · {repository.kind === "code" ? "代码" : "知识库"}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" style={buttonStyle} onClick={() => setEditMode(false)}>取消</button>
            <button
              type="button"
              style={buttonStyle}
              disabled={saving || !titleDraft.trim()}
              onClick={() =>
                void patchItem({
                  title: titleDraft.trim(),
                  priority: priorityDraft,
                  tags: tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean),
                  // 已发布基线：仓库范围只读（服务端对 released 的 repositories
                  // PATCH 一律 400），只送展示性字段。
                  ...(item.phase !== "released" ? { repositories: repoDraft } : {}),
                })
              }
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : (
        <Section title="概况">
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {item.tags.length > 0 && (
              <MetaRow label="标签">
                <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                  {item.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{ padding: "1px 7px", borderRadius: 999, border: "1px solid var(--border)", fontSize: 10.5 }}
                    >
                      {tag}
                    </span>
                  ))}
                </span>
              </MetaRow>
            )}
            {item.repositories.length > 0 && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 11.5 }}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 52 }}>仓库</span>
                <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap" }}>
                  <WorkItemRepositoryChips repositoryIds={item.repositories} repositories={repositories} />
                </span>
              </div>
            )}
            {item.external && (
              <MetaRow label="来源">
                <SourceRefValue external={item.external} />
              </MetaRow>
            )}
            {item.loop && (
              <MetaRow label="Loop">
                {item.loop}
                {interruptionPending && onOpenLoopsRecovery && (
                  <button
                    type="button"
                    style={{ ...buttonStyle, marginLeft: 8, color: "#b45309" }}
                    onClick={onOpenLoopsRecovery}
                    title="该 loop 上次关停留下未确认的执行中断记录——去 Loops 面板重新检查并恢复"
                  >
                    执行中断，待恢复 → 去处理
                  </button>
                )}
              </MetaRow>
            )}
          </div>
        </Section>
      )}

      {/* 标准交付流：证据块（只读）+ 动作条。 */}
      {item.delivery?.protocolVersion === 1 && (
        <Section title="代码与验证">
          <DeliveryEvidence item={item} repositories={repositories} />
        </Section>
      )}
      <WorkItemActionbar
        workspaceId={workspaceId}
        item={item}
        onChanged={onChanged}
        onError={setActionError}
      />

      {/* 交付自动执行区（Phase-2 Task 9）：managed 项专属——非 managed 不挂载
          （宿主也不会为其拉取执行状态）。 */}
      {item.delivery?.protocolVersion === 1 && (
        <Section title="自动执行">
          <WorkItemExecution
            execution={execution}
            busy={executionBusy}
            onStop={onStopExecution ?? (() => Promise.resolve({ ok: false, error: "停止执行不可用" }))}
            onRecover={onRecoverExecution ?? (() => Promise.resolve({ ok: false, error: "恢复不可用" }))}
            onResumeAutomation={onResumeAutomation ?? (() => Promise.resolve({ ok: false, error: "恢复自动领取不可用" }))}
            onOpenConversation={onOpenConversation}
          />
        </Section>
      )}

      {/* 验收条件与设计（managed 项）：design.md 查看/编辑。 */}
      {item.delivery?.protocolVersion === 1 && (
        <Section
          title="验收条件与设计"
          actions={
            design && !designEditing && item.phase !== "released" && (
              <button type="button" style={buttonStyle} onClick={startDesignEdit}>
                编辑设计
              </button>
            )
          }
        >
          {designEditing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {item.delivery.designConfirmed && (
                <div style={{ color: "#b45309", fontSize: 11 }}>
                  设计已确认：保存修改将撤销确认与下游证据，阶段回到「设计」。
                </div>
              )}
              <textarea
                style={{
                  ...inputStyle,
                  minHeight: 220,
                  resize: "vertical",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
                value={designDraft}
                onChange={(event) => setDesignDraft(event.target.value)}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" style={buttonStyle} onClick={() => setDesignEditing(false)}>取消</button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={saving || !designDraft.trim()}
                  onClick={() => void saveDesign()}
                >
                  {saving ? "保存中…" : "保存设计"}
                </button>
              </div>
            </div>
          ) : design ? (
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 9,
                background: "var(--bg)",
                padding: 12,
                maxHeight: 300,
                overflowY: "auto",
              }}
            >
              <MarkdownBody>{design.content}</MarkdownBody>
            </div>
          ) : designMissing ? (
            <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>
              尚未生成设计文档——「开始设计」后在此编写方案与验收条件。
            </div>
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>加载设计文档…</div>
          )}
        </Section>
      )}

      {/* 原始描述与正文（快照不覆盖）：MarkdownBody cwd=工作项目录，附件相对引用可渲染。 */}
      <Section
        title="原始描述与正文"
        actions={
          !contentEditing && (
            <button type="button" style={buttonStyle} onClick={startContentEdit}>
              编辑正文
            </button>
          )
        }
      >
        {contentEditing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              style={{
                ...inputStyle,
                minHeight: 240,
                resize: "vertical",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
              value={contentDraft}
              onChange={(event) => setContentDraft(event.target.value)}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setContentEditing(false)}>取消</button>
              <button
                type="button"
                style={buttonStyle}
                disabled={saving || !contentDraft.trim()}
                onClick={() => void saveContent()}
              >
                {saving ? "保存中…" : "保存正文"}
              </button>
            </div>
          </div>
        ) : detailError ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "#dc2626", fontSize: 11.5 }}>
            <span>{detailError}</span>
            <span style={{ color: "var(--text-dim)" }}>
              工作项可能已移入回收站或被删除——切换「回收站」范围可查看/恢复。
            </span>
            <div>
              <button type="button" style={buttonStyle} onClick={() => void loadDetail()}>重试</button>
            </div>
          </div>
        ) : detail ? (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 9,
              background: "var(--bg)",
              padding: 12,
            }}
          >
            {/* cwd = 工作项目录：attachments/ 相对图片引用经 /api/files 解析可渲染。 */}
            <MarkdownBody cwd={detail.path}>{detail.content}</MarkdownBody>
          </div>
        ) : (
          <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>加载正文…</div>
        )}
      </Section>

      {/* 附件：上传到既有工作项（attachments/ + README「## 附件」小节）——
          已发布项也允许（添加追记不改写基线）。 */}
        <Section title="附件">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <WorkItemAttachmentPicker files={pendingFiles} onChange={setPendingFiles} disabled={saving} />
            {pendingFiles.length > 0 && (
              <div>
                <button type="button" style={buttonStyle} disabled={saving} onClick={() => void uploadAttachments()}>
                  {saving ? "上传中…" : `上传 ${pendingFiles.length} 个附件`}
                </button>
              </div>
            )}
          </div>
        </Section>

      {/* 关联会话（含已归档轮会话——locate 全域打开）。 */}
      <Section title="关联会话">
        {item.conversations.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {item.conversations.map((conversationId) => (
              <button
                key={conversationId}
                type="button"
                style={buttonStyle}
                onClick={() => onOpenConversation(conversationId)}
                title={conversationId}
              >
                {conversationId.slice(0, 8)}
              </button>
            ))}
          </div>
        ) : (
          <span style={{ color: "var(--text-dim)", fontSize: 11.5 }}>暂无关联会话。</span>
        )}
      </Section>

      {/* 审计历史（含 delivery.* 事件）。 */}
      {detail && <WorkItemEvents events={detail.events} onOpenConversation={onOpenConversation} title="审计历史" />}
    </div>
  );
}
