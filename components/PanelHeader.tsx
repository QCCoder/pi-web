"use client";

import type { ReactNode } from "react";

/**
 * The unified ~36px header of every middle-column panel (three-column layout
 * consensus): title + optional back link + optional context actions + optional
 * overlay close (mobile full-screen panels). One visual spec for native panels
 * (workbench / knowledge) and slot panels (settings / archive /
 * work-items manager) alike — the header follows content
 * ownership: whoever renders the panel content renders its PanelHeader.
 */
export function PanelHeader({
  title,
  meta,
  onBack,
  backLabel,
  actions,
  onClose,
}: {
  title: string;
  /** Secondary context line (e.g. workspace name, path) rendered next to the title. */
  meta?: ReactNode;
  /** Back link (e.g. "‹ 设置" on a settings subpage). */
  onBack?: () => void;
  backLabel?: string;
  /** Right-aligned action buttons (e.g. ＋ 新建会话). */
  actions?: ReactNode;
  /** × close — rendered when the panel runs as a mobile full-screen overlay. */
  onClose?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 36,
        padding: "0 8px 0 6px",
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          title={backLabel ?? "返回"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            border: 0,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            padding: "4px 6px",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          ‹ {backLabel ?? "返回"}
        </button>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          flex: 1,
          minWidth: 0,
          paddingLeft: onBack ? 0 : 6,
        }}
      >
        <strong style={{ fontSize: 13, color: "var(--text)", whiteSpace: "nowrap" }}>{title}</strong>
        {meta && (
          <span
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-mono)",
            }}
          >
            {meta}
          </span>
        )}
      </div>
      {actions}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            flexShrink: 0,
            padding: 0,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Small header action button (used inside PanelHeader's `actions` slot). */
export function PanelHeaderButton({
  onClick,
  title,
  children,
  primary,
}: {
  onClick: () => void;
  title?: string;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 26,
        padding: "0 10px",
        border: primary
          ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))"
          : "1px solid var(--border)",
        borderRadius: 6,
        background: primary ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "var(--bg)",
        color: primary ? "var(--accent)" : "var(--text-muted)",
        fontWeight: primary ? 700 : 500,
        cursor: "pointer",
        fontSize: 12,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
