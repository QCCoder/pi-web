"use client";

import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getRelativeFilePath } from "@/lib/file-paths";
import type { ChangedFileEntry } from "@/lib/session-changed-files";

/**
 * "Files changed in this session" quick access (agreed design):
 * - compact toolbar button (icon + count) at the end of the ChatInput controls
 *   row, right of the sound toggle; fully hidden when the agent has not
 *   written/edited anything this session;
 * - click → slide-in drawer (desktop) / full-screen list (mobile) with the
 *   full paths, most-recent-first, ×N badge for hot files;
 * - clicking an entry opens the file via the existing openFile → file-tab
 *   pipeline and closes the drawer.
 *
 * Derived purely from the session message stream (lib/session-changed-files) —
 * this is "files this session touched", NOT the git changes panel; the list
 * survives commits.
 */

function KindMark({ kind }: { kind: "write" | "edit" }) {
  // + for a freshly written file, ✎ for an edited one — color-only meaning
  // would fail contrast checks, so use glyphs.
  const glyph = kind === "write" ? "＋" : "✎";
  const color = kind === "write" ? "#16a34a" : "var(--accent)";
  return (
    <span
      aria-label={kind}
      style={{ color, fontSize: 11, fontFamily: "var(--font-mono)", width: 14, textAlign: "center", flexShrink: 0 }}
    >
      {glyph}
    </span>
  );
}

function FileRow({ file, cwd, onOpenFile }: { file: ChangedFileEntry; cwd?: string; onOpenFile: (p: string) => void }) {
  const { t } = useI18n();
  const rel = getRelativeFilePath(file.filePath, cwd);
  return (
    <button
      title={file.filePath}
      onClick={() => onOpenFile(file.filePath)}
      style={{
        display: "flex",
        alignItems: "center",
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
      <KindMark kind={file.kind} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
        {rel}
      </span>
      {file.count > 1 && (
        <span
          title={t("chat.changedFilesTimes", { count: file.count })}
          style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
        >
          ×{file.count}
        </span>
      )}
    </button>
  );
}

/** Compact toolbar entry — rendered by ChatInput at the end of its controls
 *  row (right of the sound toggle). Icon + live count; tooltip carries the
 *  full label. */
export function SessionChangedFilesButton({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const label = t("chat.changedFiles", { count });
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
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="9" y1="13" x2="15" y2="13" />
        <line x1="9" y1="17" x2="13" y2="17" />
      </svg>
      <span style={{ whiteSpace: "nowrap" }}>{count}</span>
    </button>
  );
}

interface DrawerProps {
  files: ChangedFileEntry[];
  open: boolean;
  onClose: () => void;
  cwd?: string;
  onOpenFile: (filePath: string) => void;
  variant: "desktop" | "mobile";
}

/** Slide-in drawer (desktop, 360px) / full-screen list (mobile). Fixed-position
 *  overlay, so it renders from wherever in the tree. */
export function SessionChangedFilesDrawer({ files, open, onClose, cwd, onOpenFile, variant }: DrawerProps) {
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

  if (!open || files.length === 0) return null;

  const label = t("chat.changedFiles", { count: files.length });
  const handleOpen = (p: string) => {
    onClose();
    onOpenFile(p);
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
        className="scf-drawer"
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
          {files.map((f) => (
            <FileRow key={f.filePath} file={f} cwd={cwd} onOpenFile={handleOpen} />
          ))}
        </div>
      </div>
    </>
  );
}
