"use client";

import type { WorkItemRecord } from "@/lib/work-items/types";
import { WorkItemRow } from "./WorkItemRow";

/** 列表视图：已排序/已筛选的行 + 空态。滚动容器由宿主（WorkItemsPage）提供。 */
export function WorkItemsList({
  items,
  selectedKey,
  onSelect,
  emptyHint,
}: {
  items: WorkItemRecord[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  emptyHint?: string;
}) {
  if (items.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-dim)",
          fontSize: 12.5,
          padding: 24,
          textAlign: "center",
        }}
      >
        {emptyHint ?? "没有匹配的工作项"}
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      {items.map((item) => (
        <WorkItemRow
          key={item.key}
          item={item}
          selected={item.key === selectedKey}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
