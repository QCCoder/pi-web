"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkItemRecord } from "@/lib/work-items/types";

interface ArchivedSession {
  id: string;
  path: string;
  cwd: string;
  name: string;
  firstMessage: string;
  modified: string;
  archivedAt: string;
}

interface Props {
  workspaceId: string;
  /** Absolute workspace path — archived sessions are filtered to those whose
   *  cwd belongs to this workspace, matching the active session list. */
  workspacePath: string;
  onClose?: () => void;
  /** Called after any restore/delete so the sidebar can refresh its counts. */
  onChanged?: () => void;
  /** Embedded (middle-column panel) mode: no fixed overlay / panel chrome —
   *  the body fills its container; the internal header is suppressed (the
   *  panel's unified header carries the title instead). */
  embedded?: boolean;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
};

const panelStyle: React.CSSProperties = {
  width: "min(620px, 92vw)",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
};

function belongsToWorkspace(session: ArchivedSession, workspacePath: string): boolean {
  const prefix = `${workspacePath.replace(/\/+$/, "")}/`;
  return session.cwd === workspacePath || session.cwd.startsWith(prefix);
}

export function ArchiveModal({ workspaceId, workspacePath, onClose, onChanged, embedded }: Props) {
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [items, setItems] = useState<WorkItemRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 分组折叠态：默认展开，会话内存态（与 SkillsConfig 分组折叠一致，不持久化）。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    const [s, i] = await Promise.all([
      fetch("/api/sessions?archived").then((r) => (r.ok ? r.json() : { sessions: [] })).catch(() => ({ sessions: [] })),
      fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-items`)
        .then((r) => (r.ok ? r.json() : { archivedItems: [] }))
        .catch(() => ({ archivedItems: [] })),
    ]);
    const allSessions = (s.sessions ?? []) as ArchivedSession[];
    setSessions(allSessions.filter((session) => belongsToWorkspace(session, workspacePath)));
    setItems((i.archivedItems ?? []) as WorkItemRecord[]);
    setLoading(false);
  }, [workspaceId, workspacePath]);

  useEffect(() => { void reload(); }, [reload]);

  const after = useCallback(() => { onChanged?.(); void reload(); }, [onChanged, reload]);

  const restoreSession = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
      await after();
    } finally { setBusy(null); }
  }, [after]);

  const purgeSession = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      setConfirmDelete(null);
      await after();
    } finally { setBusy(null); }
  }, [after]);

  const restoreItem = useCallback(async (item: WorkItemRecord) => {
    setBusy(item.id);
    try {
      await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: item.revision, archived: false }),
      });
      await after();
    } finally { setBusy(null); }
  }, [after, workspaceId]);

  const purgeItem = useCallback(async (item: WorkItemRecord) => {
    setBusy(item.id);
    try {
      await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}`, {
        method: "DELETE",
      });
      setConfirmDelete(null);
      await after();
    } finally { setBusy(null); }
  }, [after, workspaceId]);

  const empty = !loading && sessions.length === 0 && items.length === 0;

  const body = (
    <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px 12px" }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>加载中…</div>
          ) : empty ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>暂无归档内容</div>
          ) : (
            <>
              {sessions.length > 0 && (
                <Section label={`会话 (${sessions.length})`} collapsed={collapsed.has("会话")} onToggle={() => toggleGroup("会话")}>
                  {sessions.map((s) => (
                    <ArchiveRow
                      key={`s-${s.id}`}
                      title={s.name || s.firstMessage || "未命名会话"}
                      sub={s.cwd}
                      isBusy={busy === s.id}
                      isConfirming={confirmDelete === `s-${s.id}`}
                      onRestore={() => restoreSession(s.id)}
                      onDelete={() => setConfirmDelete(`s-${s.id}`)}
                      onConfirmDelete={() => purgeSession(s.id)}
                      onCancelDelete={() => setConfirmDelete(null)}
                    />
                  ))}
                </Section>
              )}
              {items.length > 0 && (
                <Section label={`需求与 Bug (${items.length})`} collapsed={collapsed.has("需求与 Bug")} onToggle={() => toggleGroup("需求与 Bug")}>
                  {items.map((item) => (
                    <ArchiveRow
                      key={`i-${item.id}`}
                      title={item.title}
                      sub={item.key}
                      isBusy={busy === item.id}
                      isConfirming={confirmDelete === `i-${item.id}`}
                      onRestore={() => restoreItem(item)}
                      onDelete={() => setConfirmDelete(`i-${item.id}`)}
                      onConfirmDelete={() => purgeItem(item)}
                      onCancelDelete={() => setConfirmDelete(null)}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
  );

  if (embedded) {
    return <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>{body}</div>;
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 14 }}>归档</strong>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>
        {body}
      </div>
    </div>
  );
}

const closeBtnStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  width: 26,
  height: 26,
};

function Section({ label, collapsed, onToggle, children }: { label: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        title={collapsed ? "展开" : "收起"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          width: "100%",
          padding: "8px 10px 4px",
          border: 0,
          background: "transparent",
          color: "var(--text-dim)",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          textAlign: "left",
          userSelect: "none",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            fontSize: 8,
            lineHeight: 1,
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform 0.15s",
            flexShrink: 0,
          }}
        >
          ▶
        </span>
        <span>{label}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function ArchiveRow({
  title, sub, isBusy, isConfirming, onRestore, onDelete, onConfirmDelete, onCancelDelete,
}: {
  title: string;
  sub: string;
  isBusy: boolean;
  isConfirming: boolean;
  onRestore: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 7, opacity: isBusy ? 0.5 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{title}</div>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{sub}</div>
      </div>
      {isConfirming ? (
        <>
          <button onClick={onConfirmDelete} style={{ ...actionBtn, background: "#ef4444", color: "#fff", borderColor: "transparent" }}>永久删除</button>
          <button onClick={onCancelDelete} style={actionBtn}>取消</button>
        </>
      ) : (
        <>
          <button onClick={onRestore} disabled={isBusy} style={actionBtn}>恢复</button>
          <button onClick={onDelete} disabled={isBusy} style={{ ...actionBtn, color: "#ef4444" }}>删除</button>
        </>
      )}
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 10px",
};
