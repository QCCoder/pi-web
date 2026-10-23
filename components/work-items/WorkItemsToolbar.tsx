"use client";

import type { WorkItemPhase } from "@/lib/work-items/types";
import { sourceLabel } from "@/lib/work-items/source-labels";
import { PHASE_LABELS } from "./work-item-phases";
import type { WorkItemsFilters } from "./work-item-queries";

/**
 * 列表/看板共享的筛选栏（spec §6.2）：搜索、类型、阶段、优先级、来源、
 * 阻塞·待确认、活动|归档（回收站随 T9 的恢复面接入）。值由 WorkItemsPage
 * 持有并按工作区持久化（pi-work-items-filters:<wsId>）；本组件只发 patch。
 */

const ALL_PHASES: WorkItemPhase[] = [
  "intake", "analysis", "requirement_approval", "design", "plan_approval",
  "implementation", "verification", "complete",
  "ready_for_implementation", "release_ready", "released",
];

const selectStyle: React.CSSProperties = {
  height: 26,
  maxWidth: 130,
  padding: "0 4px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11.5,
  flexShrink: 0,
};

export function WorkItemsToolbar({
  filters,
  onChange,
  sources,
  activeCount,
  archivedCount,
}: {
  filters: WorkItemsFilters;
  onChange: (patch: Partial<WorkItemsFilters>) => void;
  /** 数据里实际出现的外部源 id（去重升序）。 */
  sources: string[];
  activeCount: number;
  archivedCount: number;
}) {
  const scopeButton = (scope: "active" | "archived", label: string) => (
    <button
      key={scope}
      type="button"
      onClick={() => onChange({ scope })}
      style={{
        height: 26,
        padding: "0 10px",
        border: 0,
        borderRadius: 6,
        background: filters.scope === scope ? "var(--bg-panel)" : "transparent",
        boxShadow: filters.scope === scope ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
        color: filters.scope === scope ? "var(--text)" : "var(--text-muted)",
        fontWeight: 600,
        fontSize: 11.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        padding: "6px 10px",
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
      }}
    >
      <input
        type="search"
        value={filters.search}
        onChange={(e) => onChange({ search: e.target.value })}
        placeholder="搜索 KEY / 标题"
        aria-label="搜索工作项"
        style={{
          ...selectStyle,
          maxWidth: 180,
          flex: "0 1 180px",
          minWidth: 120,
          padding: "0 8px",
        }}
      />
      <select
        aria-label="类型"
        value={filters.type}
        onChange={(e) => onChange({ type: e.target.value as WorkItemsFilters["type"] })}
        style={selectStyle}
      >
        <option value="all">全部类型</option>
        <option value="requirement">需求</option>
        <option value="bug">缺陷</option>
      </select>
      <select
        aria-label="阶段"
        value={filters.phase}
        onChange={(e) => onChange({ phase: e.target.value as WorkItemsFilters["phase"] })}
        style={selectStyle}
      >
        <option value="all">全部阶段</option>
        {ALL_PHASES.map((phase) => (
          <option key={phase} value={phase}>{PHASE_LABELS[phase]}</option>
        ))}
      </select>
      <select
        aria-label="优先级"
        value={filters.priority}
        onChange={(e) => onChange({ priority: e.target.value as WorkItemsFilters["priority"] })}
        style={selectStyle}
      >
        <option value="all">全部优先级</option>
        <option value="P0">P0</option>
        <option value="P1">P1</option>
        <option value="P2">P2</option>
        <option value="P3">P3</option>
      </select>
      <select
        aria-label="来源"
        value={filters.source}
        onChange={(e) => onChange({ source: e.target.value })}
        style={selectStyle}
      >
        <option value="all">全部来源</option>
        <option value="manual">手动创建</option>
        {sources.map((source) => (
          <option key={source} value={source}>{sourceLabel(source)}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onChange({ flaggedOnly: !filters.flaggedOnly })}
        aria-pressed={filters.flaggedOnly}
        title="仅看阻塞或待人工确认的工作项"
        style={{
          height: 26,
          padding: "0 10px",
          border: filters.flaggedOnly
            ? "1px solid color-mix(in srgb, #dc2626 40%, var(--border))"
            : "1px solid var(--border)",
          borderRadius: 6,
          background: filters.flaggedOnly ? "color-mix(in srgb, #dc2626 8%, transparent)" : "var(--bg)",
          color: filters.flaggedOnly ? "#dc2626" : "var(--text-muted)",
          fontWeight: 600,
          fontSize: 11.5,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        阻塞/待确认
      </button>
      <div style={{ flex: 1 }} />
      <div
        role="tablist"
        aria-label="范围"
        style={{ display: "flex", gap: 2, padding: 2, background: "var(--bg-hover)", borderRadius: 7 }}
      >
        {scopeButton("active", `活动 ${activeCount}`)}
        {scopeButton("archived", `归档 ${archivedCount}`)}
      </div>
    </div>
  );
}
