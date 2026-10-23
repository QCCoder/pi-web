"use client";

import { useState } from "react";
import type { WorkItemRecord } from "@/lib/work-items/types";
import { sourceLabel } from "@/lib/work-items/source-labels";
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABELS,
  PHASE_LABELS,
  boardColumnForPhase,
  isHistoricalComplete,
} from "./work-item-phases";

/**
 * 看板视图（spec §6.2）：BOARD_COLUMNS 七列阶段投影；老流程的设计前子阶段
 * 投影进「设计」列但卡片显示原始 phase 标签；`complete`（历史已完成，不推断
 * 已发布）收进末尾的「历史已完成」折叠列。**无拖拽跳阶段**——阶段操作走
 * 明确动作按钮（T9 接入）；本任务卡片仅选中。
 */

function BoardCard({
  item,
  selected,
  onSelect,
}: {
  item: WorkItemRecord;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  // 投影列 ≠ 原始 phase 时（老子阶段 → 设计列），卡片显示原始标签。
  const projected = boardColumnForPhase(item.phase);
  const showRawPhase = projected !== item.phase;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.key)}
      aria-current={selected}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        width: "100%",
        padding: "8px 9px",
        border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: 8,
        background: selected ? "var(--bg-selected)" : "var(--bg-panel)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 12,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: item.type === "bug" ? "#dc2626" : "var(--accent)",
            whiteSpace: "nowrap",
          }}
        >
          {item.key}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: item.priority === "P0" ? "#dc2626" : "var(--text-muted)" }}>
          {item.priority}
        </span>
        {(item.status === "blocked" || item.phase === "requirement_approval" || item.phase === "plan_approval") && (
          <span style={{ fontSize: 10, color: "#dc2626", whiteSpace: "nowrap" }}>
            {item.status === "blocked" ? "阻塞" : "待确认"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {showRawPhase && (
          <span
            title={`看板投影：${BOARD_COLUMN_LABELS[projected]}（原始阶段：${PHASE_LABELS[item.phase]}）`}
            style={{
              padding: "1px 5px",
              borderRadius: 4,
              border: "1px dashed var(--border)",
              fontSize: 10,
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
            }}
          >
            {PHASE_LABELS[item.phase]}
          </span>
        )}
        {item.external && (
          <span
            title={`来源：${sourceLabel(item.external.source)} #${item.external.sourceId}`}
            style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}
          >
            {sourceLabel(item.external.source)}
          </span>
        )}
      </span>
      <span style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.45 }}>
        {item.title}
      </span>
    </button>
  );
}

function Column({ label, items, selectedKey, onSelect }: {
  label: string;
  items: WorkItemRecord[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: 232,
        minWidth: 232,
        flexShrink: 0,
        padding: "10px 10px 14px",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "0 2px" }}>
        <strong style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap" }}>{label}</strong>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{items.length}</span>
      </div>
      {items.map((item) => (
        <BoardCard key={item.key} item={item} selected={item.key === selectedKey} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function WorkItemsBoard({
  items,
  selectedKey,
  onSelect,
}: {
  /** 已按 scope+筛选+排序处理过的项（活动或归档，不含另一范围）。 */
  items: WorkItemRecord[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const flowing = items.filter((item) => !isHistoricalComplete(item.phase));
  const historical = items.filter((item) => isHistoricalComplete(item.phase));

  const columns = BOARD_COLUMNS.map((column) => ({
    column,
    items: flowing.filter((item) => boardColumnForPhase(item.phase) === column),
  }));

  return (
    <div style={{ flex: 1, minHeight: 0, overflowX: "auto", overflowY: "hidden", display: "flex" }}>
      {columns.map(({ column, items: columnItems }) => (
        <Column key={column} label={BOARD_COLUMN_LABELS[column]} items={columnItems} selectedKey={selectedKey} onSelect={onSelect} />
      ))}
      {/* 历史已完成：complete 终态不推断已发布，收进折叠列（默认收起）。 */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: historyExpanded ? 232 : 44,
          minWidth: historyExpanded ? 232 : 44,
          flexShrink: 0,
          padding: historyExpanded ? "10px 10px 14px" : "10px 6px",
          borderRight: "1px solid var(--border)",
          transition: "width 0.15s ease, min-width 0.15s ease",
        }}
      >
        <button
          type="button"
          onClick={() => setHistoryExpanded((value) => !value)}
          aria-expanded={historyExpanded}
          title="老流程 complete 终态（不推断已发布）"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            width: "100%",
            padding: "0 2px",
            border: 0,
            background: "transparent",
            color: "var(--text)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 700,
            textAlign: "left",
            whiteSpace: "nowrap",
          }}
        >
          {historyExpanded ? "历史已完成" : "历史"}
          <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--text-dim)" }}>{historical.length}</span>
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ color: "var(--text-dim)", transform: historyExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
          >
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </button>
        {historyExpanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {historical.map((item) => (
              <BoardCard key={item.key} item={item} selected={item.key === selectedKey} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
