"use client";

import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentEntry, SubagentEntryStatus } from "@/lib/session-subagents";

/**
 * "Subagents spawned in this session" quick access — the exact pattern of
 * SessionChangedFiles (agreed design):
 * - compact toolbar button (icon + count) at the end of the ChatInput controls
 *   row, right of the changed-files button; fully hidden when the session has
 *   not delegated anything;
 * - click → slide-in drawer (desktop) / full-screen list (mobile) listing the
 *   delegated child sessions, most-recent-first, with role/status/summary;
 * - clicking an entry opens the child session via the existing
 *   handleOpenSessionViewer → session-tab pipeline and closes the drawer.
 *
 * Why: children are hidden from every session list (subagent-child.ts) and kit
 * loop rounds are auto-archived — this drawer is the durable, scroll-free
 * entry into subagent work from the parent chat. See lib/session-subagents.ts.
 */

function statusGlyph(status: SubagentEntryStatus): string {
  switch (status) {
    case "succeeded": return "✓";
    case "failed":
    case "rejected": return "✗";
    case "skipped": return "⤼";
    case "running": return "◉";
    default: return "○"; // pending
  }
}

function statusColor(status: SubagentEntryStatus): string {
  return status === "succeeded" ? "#16a34a"
    : status === "failed" || status === "rejected" ? "#f87171"
    : status === "running" ? "var(--accent)"
    : "var(--text-dim)";
}

function statusLabel(t: (k: string) => string, status: SubagentEntryStatus): string {
  switch (status) {
    case "succeeded": return t("chat.subagentStatusSucceeded");
    case "failed": return t("chat.subagentStatusFailed");
    case "rejected": return t("chat.subagentStatusRejected");
    case "skipped": return t("chat.subagentStatusSkipped");
    case "running": return t("chat.subagentStatusRunning");
    default: return t("chat.subagentStatusPending");
  }
}

function SubagentRow({ sub, onOpenSession }: { sub: SubagentEntry; onOpenSession: (id: string) => void }) {
  const { t } = useI18n();
  const isFailure = sub.status === "failed" || sub.status === "rejected";
  return (
    <button
      title={sub.id}
      onClick={() => onOpenSession(sub.id)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        width: "100%",
        padding: "7px 12px",
        background: "none",
        border: "none",
        borderTop: "1px solid var(--border)",
        color: "var(--text-muted)",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
    >
      <span
        aria-label={statusLabel(t, sub.status)}
        style={{ color: statusColor(sub.status), fontSize: 11, width: 14, textAlign: "center", flexShrink: 0, lineHeight: "17px" }}
      >
        {statusGlyph(sub.status)}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{sub.role}</span>
        {sub.summary && (
          <span
            style={{
              display: "block",
              color: isFailure ? "#f87171" : "var(--text-dim)",
              fontSize: 11,
              marginTop: 2,
              whiteSpace: "pre-wrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {sub.summary}
          </span>
        )}
      </span>
      <span style={{ color: "var(--accent)", fontSize: 10, flexShrink: 0, lineHeight: "17px" }}>open →</span>
    </button>
  );
}

/** Compact toolbar entry — rendered by ChatInput at the end of its controls
 *  row (right of the changed-files button). Icon + live count. */
export function SessionSubagentsButton({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const label = t("chat.subagents", { count });
  return (
    <button
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={open}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
        height: 32,
        padding: "0 6px",
        background: open ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: 9,
        color: open ? "var(--accent)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        fontFamily: "var(--font-mono)",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
        e.currentTarget.style.color = open ? "var(--accent)" : "var(--text-muted)";
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <line x1="8" y1="16" x2="8" y2="16.01" />
        <line x1="16" y1="16" x2="16" y2="16.01" />
      </svg>
      <span style={{ whiteSpace: "nowrap" }}>{count}</span>
    </button>
  );
}

interface DrawerProps {
  subs: SubagentEntry[];
  open: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  variant: "desktop" | "mobile";
}

/** Slide-in drawer (desktop, 360px) / full-screen list (mobile). Fixed-position
 *  overlay, so it renders from wherever in the tree. */
export function SessionSubagentsDrawer({ subs, open, onClose, onOpenSession, variant }: DrawerProps) {
  const { t } = useI18n();

  // Escape closes the drawer; safe no-op when closed.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || subs.length === 0) return null;

  const label = t("chat.subagents", { count: subs.length });
  const handleOpen = (id: string) => {
    onClose();
    onOpenSession(id);
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 390,
          background: "rgba(0,0,0,0.18)",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          right: 0,
          zIndex: 400,
          width: variant === "mobile" ? "100%" : 360,
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          borderLeft: variant === "mobile" ? "none" : "1px solid var(--border)",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.18)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600 }}>{label}</span>
          <button
            onClick={onClose}
            aria-label="close"
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {subs.map((s) => (
            <SubagentRow key={s.id} sub={s} onOpenSession={handleOpen} />
          ))}
        </div>
      </div>
    </>
  );
}
