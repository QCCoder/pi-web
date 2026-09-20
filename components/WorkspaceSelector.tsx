"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * 「工作区: name ▾」选择器 — 宿主在 composer 控制行（上传按钮左侧，
 * ChatInput leadingControl 槽），下拉向上展开（bottom 锚定）。
 *
 * 共享宿主（2026-09 树形侧栏改版）：首页 HomeNewSession + 桌面新会话占位
 * tab（DesktopShell）——「新建任务」在任何上下文都能就地改选目标工作区。
 */
export function WorkspaceSelector({
  workspaces,
  selected,
  onSelect,
}: {
  workspaces: WorkspaceSummary[];
  selected: WorkspaceSummary;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((value) => !value)}
        title="选择本次会话归属的工作区"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 32,
          padding: "0 8px",
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: open ? "var(--bg-hover)" : "transparent",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 11.5,
          fontWeight: 600,
          maxWidth: 190,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>工作区:</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--accent)" }}>
          {selected.name}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 300,
            minWidth: 200,
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 -4px 16px rgba(0,0,0,0.14)",
          }}
        >
          {workspaces.map((workspace) => {
            const isSelected = selected.id === workspace.id;
            return (
              <button
                key={workspace.id}
                onClick={() => {
                  onSelect(workspace.id);
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  border: 0,
                  borderRadius: 7,
                  background: isSelected ? "var(--bg-selected)" : "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12.5,
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {workspace.name}
                </span>
                {isSelected && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
