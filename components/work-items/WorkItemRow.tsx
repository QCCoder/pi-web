"use client";

import type { WorkItemRecord } from "@/lib/work-items/types";
import { sourceLabel } from "@/lib/work-items/source-labels";
import { formatRelativeTime } from "@/lib/format-time";
import { TYPE_LABELS, PHASE_LABELS, isHistoricalComplete } from "./work-item-phases";
import { isItemFlagged } from "./work-item-queries";

/**
 * 列表行（spec §6.2）：KEY（+ 来源徽章）、标题、类型、阶段（老 phase 显示
 * 原始标签）、优先级、阻塞/待确认标记、更新时间。纯展示行——选中回调由
 * WorkItemsList 传入，点击在中央内容区打开详情（T8 占位、T9 接入）。
 */

const PRIORITY_COLORS: Record<string, string> = {
  P0: "#dc2626",
  P1: "#ea580c",
  P2: "var(--text-muted)",
  P3: "var(--text-dim)",
};

export function WorkItemRow({
  item,
  selected,
  onSelect,
}: {
  item: WorkItemRecord;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const flagged = isItemFlagged(item);
  const historical = isHistoricalComplete(item.phase);
  return (
    <button
      type="button"
      onClick={() => onSelect(item.key)}
      aria-current={selected}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        border: 0,
        borderTop: "1px solid var(--border)",
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 12,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--bg-selected)" : "transparent"; }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: item.type === "bug" ? "#dc2626" : "var(--accent)",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {item.key}
      </span>
      {item.external && (
        <span
          title={`来源：${sourceLabel(item.external.source)} #${item.external.sourceId}`}
          style={{
            flexShrink: 0,
            padding: "1px 5px",
            borderRadius: 4,
            border: "1px solid var(--border)",
            fontSize: 10,
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {sourceLabel(item.external.source)}
        </span>
      )}
      <span
        style={{
          flex: 1,
          minWidth: 80,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: historical ? "var(--text-muted)" : "var(--text)",
        }}
      >
        {item.title}
      </span>
      <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}>{TYPE_LABELS[item.type]}</span>
      <span
        style={{
          flexShrink: 0,
          padding: "1px 6px",
          borderRadius: 4,
          background: "var(--bg-hover)",
          fontSize: 10.5,
          color: historical ? "var(--text-dim)" : "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {PHASE_LABELS[item.phase]}
      </span>
      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: PRIORITY_COLORS[item.priority] ?? "var(--text-muted)" }}>
        {item.priority}
      </span>
      {flagged && (
        <span
          style={{
            flexShrink: 0,
            padding: "1px 5px",
            borderRadius: 4,
            border: "1px solid color-mix(in srgb, #dc2626 40%, var(--border))",
            color: "#dc2626",
            fontSize: 10,
            whiteSpace: "nowrap",
          }}
        >
          {item.status === "blocked" ? "阻塞" : "待确认"}
        </span>
      )}
      <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
        {formatRelativeTime(item.updatedAt)}
      </span>
    </button>
  );
}
