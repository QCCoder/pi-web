"use client";

import { useCallback, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format-time";

/**
 * 会话行（全局左栏 2026-09 抽出共享）：运行/完成徽章 + Cmd/中键新 tab
 * C1 并行手势 + 行内「归档」（hover 不再有「新 tab」按钮——手势即可，按钮去掉）。
 * 宿主：HomeSessionGroups（桌面全局左栏 + 首页 + 移动端首页）。
 * `showTime`（默认关）：行尾相对时间（hover 时隐藏——归档按钮出现，把行宽还给标题；全局列表用）。
 */
const hoverActionBtn: React.CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-hover)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  padding: "2px 8px",
};

function rowStyle(active = false, rounded = false): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "var(--pi-sidebar-row-py) 12px var(--pi-sidebar-row-py) 22px",
    ...(rounded ? { borderRadius: 8 } : undefined),
    border: 0,
    background: active ? "var(--bg-selected)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: "var(--pi-sidebar-fs)",
    textAlign: "left",
  };
}

export function SessionRow({
  session,
  isSelected,
  activity,
  onSelect,
  onOpenInNewTab,
  onChanged,
  onRemoved,
  showTime = false,
  rounded = false,
}: {
  session: SessionInfo;
  isSelected: boolean;
  activity?: "running" | "completed";
  onSelect: () => void;
  /** C1 的显式并行手势：Cmd/Ctrl-点击与鼠标中键 → 新开（或聚焦）该会话的 tab（无可见按钮）。 */
  onOpenInNewTab?: () => void;
  /** 归档成功后的刷新回调（全局列表可缺省——onRemoved 已驱动重渲染）。 */
  onChanged?: () => void;
  onRemoved?: (id: string) => void;
  showTime?: boolean;
  /** 圆角行（选中/hover 底带 borderRadius）——桌面项目树侧栏用；移动端首页
   *  保持直角全宽行（不动）。 */
  rounded?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = session.name || session.firstMessage || "未命名会话";

  const archive = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
      onRemoved?.(session.id);
      onChanged?.();
    } finally { setBusy(false); }
  }, [session.id, onChanged, onRemoved]);

  return (
    <div
      onClick={(event) => {
        if (onOpenInNewTab && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onOpenInNewTab();
          return;
        }
        onSelect();
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !onOpenInNewTab) return;
        event.preventDefault();
        onOpenInNewTab();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...rowStyle(isSelected, rounded),
        justifyContent: "space-between",
        opacity: busy ? 0.5 : 1,
        background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{label}</span>
      {showTime && !hovered && (
        <span style={{ flexShrink: 0, fontSize: "var(--pi-sidebar-fs-meta)", color: "var(--text-dim)" }}>
          {formatRelativeTime(session.modified)}
        </span>
      )}
      {activity === "running" && !hovered && (
        <span
          title="运行中"
          aria-label="运行中"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            height: 12,
            flexShrink: 0,
            color: "var(--text)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 12 12"
                to="360 12 12"
                dur="0.9s"
                repeatCount="indefinite"
              />
            </g>
          </svg>
        </span>
      )}
      {activity === "completed" && !hovered && (
        <span
          title="完成，尚未查看"
          aria-label="完成"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            background: "var(--accent)",
          }}
        />
      )}
      {hovered && !busy && (
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <button title="归档" onClick={() => void archive()} style={hoverActionBtn}>归档</button>
        </div>
      )}
    </div>
  );
}
