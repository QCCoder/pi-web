"use client";

import { useState } from "react";
import type { WorkItemRecord, WorkItemStatus } from "@/lib/work-items/types";
import { sourceLabel } from "@/lib/work-items/source-labels";
import { formatRelativeTime } from "@/lib/format-time";
import {
  PHASE_LABELS,
  STATUS_DOT_COLORS,
  STATUS_LABELS,
} from "./work-item-phases";

/**
 * 状态卡板（2026-10 用户需求「管理弹窗 + 列表/卡片布局，卡片按状态拖拽」）：
 * 五列 = WorkItemStatus（待处理/处理中/已阻塞/已完成/已取消），卡片拖到其它
 * 列 → onMove（WorkItemsPage PATCH status，expectedRevision 乐观并发）。
 *
 * 拖拽边界（与服务层门禁对齐）：**标准流程项（delivery 块）不可拖**——generic
 * PATCH 改 status 在服务层就是 400，其阶段/状态只能走交付动作；归档/回收站
 * 范围（scope ≠ active）同样只读。HTML5 DnD（桌面）；窄屏（触屏不触发
 * HTML5 拖拽）由 WorkItemsPage 回落为列表，本组件只在宽屏挂载。
 */

const STATUS_COLUMNS: WorkItemStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

/** 卡片左缘优先级色条。 */
const PRIORITY_STRIPE: Record<string, string> = {
  P0: "#dc2626",
  P1: "#ea580c",
  P2: "#64748b",
  P3: "#cbd5e1",
};

function isManaged(item: WorkItemRecord): boolean {
  return item.delivery?.protocolVersion === 1;
}

function StatusCard({
  item,
  selected,
  dragging,
  draggable,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItemRecord;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  onSelect: (key: string) => void;
  onDragStart: (item: WorkItemRecord) => void;
  onDragEnd: () => void;
}) {
  const locked = !draggable;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        // Firefox 需要 dataTransfer 有数据才会启动拖拽。
        event.dataTransfer.setData("text/plain", item.key);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(item);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(item.key)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item.key);
        }
      }}
      title={locked ? "标准流程项（或当前范围只读）：状态由交付动作 / 详情操作管理，不支持拖拽" : undefined}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "8px 10px 8px 13px",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 9,
        background: selected ? "var(--bg-selected)" : "var(--bg-panel)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
        color: "var(--text)",
        cursor: draggable ? "grab" : "pointer",
        textAlign: "left",
        fontSize: 12,
        opacity: dragging ? 0.45 : 1,
        userSelect: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 8,
          bottom: 8,
          width: 3,
          borderRadius: 2,
          background: PRIORITY_STRIPE[item.priority] ?? "var(--border)",
        }}
      />
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
        {isManaged(item) && (
          <span
            title="标准交付流程项：阶段/状态由流程动作推进"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "1px 5px",
              borderRadius: 4,
              border: "1px dashed var(--border)",
              fontSize: 10,
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            流程
          </span>
        )}
        {item.status === "blocked" && (
          <span style={{ fontSize: 10, color: "#dc2626", whiteSpace: "nowrap" }}>阻塞</span>
        )}
        <span style={{ flex: 1 }} />
        {item.external && (
          <span
            title={`来源：${sourceLabel(item.external.source)} #${item.external.sourceId}`}
            style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}
          >
            {sourceLabel(item.external.source)}
          </span>
        )}
      </span>
      <span
        style={{
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          lineHeight: 1.45,
          color: item.status === "cancelled" ? "var(--text-muted)" : "var(--text)",
        }}
      >
        {item.title}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-dim)" }}>
        <span
          style={{
            padding: "1px 5px",
            borderRadius: 4,
            background: "var(--bg-hover)",
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {PHASE_LABELS[item.phase]}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ whiteSpace: "nowrap" }}>{formatRelativeTime(item.updatedAt)}</span>
      </span>
    </div>
  );
}

function StatusColumn({
  status,
  items,
  selectedKey,
  dragging,
  cardsDraggable,
  dropActive,
  onSelect,
  onCardDragStart,
  onCardDragEnd,
  onDragOver,
  onDrop,
  onDragLeave,
}: {
  status: WorkItemStatus;
  items: WorkItemRecord[];
  selectedKey: string | null;
  dragging: WorkItemRecord | null;
  /** 板级判定（scope=active）透传；managed 项在卡片层再拦一道。 */
  cardsDraggable: boolean;
  dropActive: boolean;
  onSelect: (key: string) => void;
  onCardDragStart: (item: WorkItemRecord) => void;
  onCardDragEnd: () => void;
  onDragOver: (status: WorkItemStatus) => void;
  onDrop: (status: WorkItemStatus) => void;
  onDragLeave: (status: WorkItemStatus) => void;
}) {
  return (
    <div
      onDragOver={(event) => {
        if (!dragging) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver(status);
      }}
      onDragLeave={(event) => {
        // 只在真正离开列容器时清高亮（子元素间移动也会冒泡 dragleave）。
        if (!event.currentTarget.contains(event.relatedTarget as Node)) onDragLeave(status);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(status);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: 246,
        minWidth: 246,
        flexShrink: 0,
        padding: 8,
        borderRadius: 10,
        background: dropActive
          ? "color-mix(in srgb, var(--accent) 8%, var(--bg-hover))"
          : "var(--bg-hover)",
        border: dropActive
          ? "1px dashed color-mix(in srgb, var(--accent) 55%, transparent)"
          : "1px solid transparent",
        transition: "background 0.12s ease, border-color 0.12s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px", flexShrink: 0 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_DOT_COLORS[status], flexShrink: 0 }} />
        <strong style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap" }}>{STATUS_LABELS[status]}</strong>
        <span
          style={{
            minWidth: 18,
            padding: "0 5px",
            borderRadius: 999,
            background: "var(--bg-panel)",
            fontSize: 10.5,
            color: "var(--text-dim)",
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          {items.length}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 }}>
        {items.map((item) => (
          <StatusCard
            key={item.key}
            item={item}
            selected={item.key === selectedKey}
            dragging={dragging?.key === item.key}
            draggable={cardsDraggable && !isManaged(item)}
            onSelect={onSelect}
            onDragStart={onCardDragStart}
            onDragEnd={onCardDragEnd}
          />
        ))}
        {dragging && (
          <div
            aria-hidden="true"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: dropActive ? "14px 8px" : "10px 8px",
              borderRadius: 9,
              border: `1px dashed ${dropActive ? "color-mix(in srgb, var(--accent) 60%, transparent)" : "var(--border)"}`,
              color: dropActive ? "var(--accent)" : "var(--text-dim)",
              fontSize: 10.5,
              transition: "padding 0.12s ease",
            }}
          >
            {dropActive ? `松开 → ${STATUS_LABELS[status]}` : "拖到这里"}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkItemsStatusBoard({
  items,
  scope,
  selectedKey,
  onSelect,
  onMove,
}: {
  /** 已按 scope+筛选+排序处理过的项。 */
  items: WorkItemRecord[];
  /** 拖拽仅在「活动」范围开放（归档/回收站只读）。 */
  scope: "active" | "archived" | "trash";
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** 卡片落到目标状态列（页面负责 PATCH + invalidate；同状态落点由页面去重）。 */
  onMove: (item: WorkItemRecord, toStatus: WorkItemStatus) => void;
}) {
  const [dragging, setDragging] = useState<WorkItemRecord | null>(null);
  const [overStatus, setOverStatus] = useState<WorkItemStatus | null>(null);
  const dragEnabled = scope === "active";

  const endDrag = () => {
    setDragging(null);
    setOverStatus(null);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowX: "auto", overflowY: "hidden", display: "flex", gap: 8, padding: "10px 10px 12px" }}>
      {STATUS_COLUMNS.map((status) => (
        <StatusColumn
          key={status}
          status={status}
          items={items.filter((item) => item.status === status)}
          selectedKey={selectedKey}
          dragging={dragEnabled ? dragging : null}
          cardsDraggable={dragEnabled}
          dropActive={dragEnabled && overStatus === status && dragging != null && dragging.status !== status}
          onSelect={onSelect}
          onCardDragStart={setDragging}
          onCardDragEnd={endDrag}
          onDragOver={setOverStatus}
          onDragLeave={(column) => {
            if (overStatus === column) setOverStatus(null);
          }}
          onDrop={(column) => {
            if (dragging && dragging.status !== column) onMove(dragging, column);
            endDrag();
          }}
        />
      ))}
    </div>
  );
}
