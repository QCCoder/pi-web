"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkItems } from "@/hooks/useWorkItems";
import { buildWorkItemsPageUrl } from "@/lib/work-items-page-url";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import { formatRelativeTime } from "@/lib/format-time";
import type { WorkItemRecord } from "@/lib/work-items/types";
import { PanelHeader } from "../PanelHeader";
import { WorkItemsToolbar } from "./WorkItemsToolbar";
import { WorkItemsList } from "./WorkItemsList";
import { WorkItemsBoard } from "./WorkItemsBoard";
import { PHASE_LABELS, TYPE_LABELS } from "./work-item-phases";
import {
  defaultWorkItemFilters,
  filterWorkItems,
  parseStoredWorkItemFilters,
  sortWorkItems,
  type WorkItemsFilters,
} from "./work-item-queries";

/**
 * 中央工作项管理整页（M2 T8，spec §6.1/§6.2）：页头（工作区选择器 + 列表|看板
 * 分段 + ＋新建）+ 共享筛选栏 + 列表/看板 + 详情占位区（T9 接入完整详情）。
 *
 * 页面身份显式绑定 props.workspaceId（spec §6.1：不用 activeWorkspace 代替，
 * 防止打开另一工作区的管理页时误写项目）。视图/筛选按工作区持久化：
 * `pi-work-items-view:<wsId>`、`pi-work-items-filters:<wsId>`。数据来自共享
 * store 的 useWorkItems（与右坞快捷面板同缓存）；选中项变化由页面自己 replace
 * URL（buildWorkItemsPageUrl，不埋历史陷阱）。移动端宿主由 T10 接入——本组件
 * 全响应式布局，不写死桌面宽度。
 */

type WorkItemsView = "list" | "board";

interface WorkItemsPageProps {
  workspaceId: string;
  /** 深链/openWorkItemsPage 带来的初始选中项（一次性意图，消费后由宿主清空）。 */
  initialItemKey?: string | null;
  /** 「查看会话」→ locate 打开聊天 tab（关闭中央页）。 */
  onOpenConversation: (sessionId: string) => void;
  /** initialItemKey 已消费（宿主清 workItemsItemKeyRef）。 */
  onConsumedInitialItem?: () => void;
  /** ✕ 关闭中央页。 */
  onClose?: () => void;
  /** 页头切换工作区（保持中央页形态，换页面身份）。 */
  onOpenWorkItemsPage?: (workspaceId: string, itemKey?: string) => void;
  /** 页面内选中项变化 → replace URL（裸 query，navigateUrl 自己补 "?"）。 */
  onReplaceUrl?: (query: string) => void;
  /** 工作区列表（页头选择器 + capability/名称解析）。 */
  workspaces: WorkspaceSummary[];
}

/** 页头的工作区选择器：向下展开的轻量下拉（WorkspaceSelector 是 composer 的
 * bottom 锚定形态，不适配页头）。 */
function HeaderWorkspaceSelector({
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
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换工作区（管理页作用域）"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          padding: "0 8px",
          maxWidth: 220,
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: open ? "var(--bg-hover)" : "var(--bg)",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 11.5,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>工作区:</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--accent)" }}>{selected.name}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="切换工作区"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 300,
            minWidth: 200,
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-panel)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          }}
        >
          {workspaces.map((workspace) => {
            const isSelected = workspace.id === selected.id;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
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

function DetailPlaceholder({
  item,
  onOpenConversation,
}: {
  item: WorkItemRecord | null;
  onOpenConversation: (sessionId: string) => void;
}) {
  if (!item) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
        选择工作项
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: item.type === "bug" ? "#dc2626" : "var(--accent)" }}>
          {item.key}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{TYPE_LABELS[item.type]}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>·</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{PHASE_LABELS[item.phase]}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{item.priority}</span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", lineHeight: 1.5 }}>{item.title}</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>更新于 {formatRelativeTime(item.updatedAt)}</div>
      {item.conversations.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>关联会话 {item.conversations.length}</span>
          <button
            type="button"
            onClick={() => onOpenConversation(item.conversations[item.conversations.length - 1])}
            style={{
              height: 26,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11.5,
              whiteSpace: "nowrap",
            }}
          >
            查看会话
          </button>
        </div>
      ) : null}
      {/* T9 接入完整详情（概况/原始描述/附件/验收/设计/验证/历史/动作条）。 */}
      <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
        完整详情视图即将上线（当前为占位）。
      </div>
    </div>
  );
}

export function WorkItemsPage({
  workspaceId,
  initialItemKey,
  onOpenConversation,
  onConsumedInitialItem,
  onClose,
  onOpenWorkItemsPage,
  onReplaceUrl,
  workspaces,
}: WorkItemsPageProps) {
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const hasCapability = Boolean(workspace?.capabilities.includes("work-items"));
  const { snapshot, loading, error, refresh } = useWorkItems(workspace && hasCapability ? workspaceId : null);

  const [view, setView] = useState<WorkItemsView>("list");
  const [filters, setFilters] = useState<WorkItemsFilters>(defaultWorkItemFilters);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // 视图偏好 + 筛选按工作区持久化；换工作区时重读（FilesExplorerPanel 的
  // pi-explorer-tab 同款挂载后 hydrate 语义，避免 SSR/水合不一致）。
  useEffect(() => {
    let storedView: WorkItemsView = "list";
    let storedFilters = defaultWorkItemFilters();
    try {
      storedView = localStorage.getItem(`pi-work-items-view:${workspaceId}`) === "board" ? "board" : "list";
      storedFilters = parseStoredWorkItemFilters(localStorage.getItem(`pi-work-items-filters:${workspaceId}`));
    } catch { /* localStorage unavailable — keep defaults */ }
    setView(storedView);
    setFilters(storedFilters);
  }, [workspaceId]);

  useEffect(() => {
    try { localStorage.setItem(`pi-work-items-view:${workspaceId}`, view); } catch { /* ignore */ }
  }, [workspaceId, view]);

  useEffect(() => {
    try { localStorage.setItem(`pi-work-items-filters:${workspaceId}`, JSON.stringify(filters)); } catch { /* ignore */ }
  }, [workspaceId, filters]);

  // 深链选中项（一次性意图）：消费后交宿主清空 ref。
  useEffect(() => {
    if (!initialItemKey) return;
    setSelectedKey(initialItemKey);
    onConsumedInitialItem?.();
  }, [initialItemKey, onConsumedInitialItem]);

  const handleSelect = useCallback((key: string) => {
    if (key === selectedKey) return;
    setSelectedKey(key);
    // 选中项变化由页面自己 replace URL（不埋历史陷阱；spec §6.1）。
    onReplaceUrl?.(buildWorkItemsPageUrl(workspaceId, key));
  }, [selectedKey, workspaceId, onReplaceUrl]);

  const handleFilterChange = useCallback((patch: Partial<WorkItemsFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const handleSwitchWorkspace = useCallback((id: string) => {
    if (id === workspaceId || !onOpenWorkItemsPage) return;
    // T9 接入创建/编辑表单后：切换前 confirm 未保存草稿（spec §6.1）。
    onOpenWorkItemsPage(id);
  }, [workspaceId, onOpenWorkItemsPage]);

  const allItems = useMemo(
    () => [...(snapshot?.items ?? []), ...(snapshot?.archivedItems ?? [])],
    [snapshot],
  );
  const scoped = useMemo(
    () => (filters.scope === "archived" ? snapshot?.archivedItems ?? [] : snapshot?.items ?? []),
    [snapshot, filters.scope],
  );
  const visible = useMemo(() => sortWorkItems(filterWorkItems(scoped, filters)), [scoped, filters]);
  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const item of allItems) {
      if (item.external?.source) set.add(item.external.source);
    }
    return [...set].sort();
  }, [allItems]);
  const selectedItem = useMemo(
    () => allItems.find((item) => item.key === selectedKey) ?? null,
    [allItems, selectedKey],
  );

  const viewButton = (value: WorkItemsView, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setView(value)}
      aria-pressed={view === value}
      style={{
        height: 26,
        padding: "0 10px",
        border: 0,
        borderRadius: 6,
        background: view === value ? "var(--bg-panel)" : "transparent",
        boxShadow: view === value ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
        color: view === value ? "var(--text)" : "var(--text-muted)",
        fontWeight: 600,
        fontSize: 11.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );

  let body: React.ReactNode;
  if (!workspace) {
    body = (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
        工作区不存在或已删除。
      </div>
    );
  } else if (!hasCapability) {
    body = (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: 12.5, textAlign: "center", padding: 24 }}>
        <span>该工作区未启用「工作项」能力。</span>
        <span style={{ fontSize: 11.5 }}>在 设置 › 工作区 中开启后即可在这里管理需求与缺陷。</span>
      </div>
    );
  } else if (!snapshot && loading) {
    body = (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
        加载中…
      </div>
    );
  } else if (error && !snapshot) {
    body = (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-dim)", fontSize: 12.5 }}>
        <span>{error}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          style={{ height: 28, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
        >
          重试
        </button>
      </div>
    );
  } else {
    const emptyHint = scoped.length === 0
      ? (filters.scope === "archived" ? "暂无归档工作项" : "暂无工作项")
      : undefined;
    body = view === "board" ? (
      <WorkItemsBoard items={visible} selectedKey={selectedKey} onSelect={handleSelect} />
    ) : (
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <WorkItemsList items={visible} selectedKey={selectedKey} onSelect={handleSelect} emptyHint={emptyHint} />
        </div>
        <div
          style={{
            flex: "0 0 34%",
            minWidth: 260,
            maxWidth: 420,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            borderLeft: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <div style={{ height: 30, display: "flex", alignItems: "center", padding: "0 12px", flexShrink: 0, borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em" }}>
            详情
          </div>
          <DetailPlaceholder item={selectedItem} onOpenConversation={onOpenConversation} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <PanelHeader
        title="工作项"
        actions={
          <>
            {workspace && (
              <HeaderWorkspaceSelector
                workspaces={workspaces.filter(isWorkspaceSelectable)}
                selected={workspace}
                onSelect={handleSwitchWorkspace}
              />
            )}
            <div role="tablist" aria-label="视图" style={{ display: "flex", gap: 2, padding: 2, background: "var(--bg-hover)", borderRadius: 7, flexShrink: 0 }}>
              {viewButton("list", "列表")}
              {viewButton("board", "看板")}
            </div>
            {/* T9 接入创建表单；本任务先占位（disabled）。 */}
            <button
              type="button"
              disabled
              title="新建工作项表单即将上线"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                height: 26,
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
                color: "var(--text-dim)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "default",
                opacity: 0.6,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              ＋ 新建
            </button>
          </>
        }
        onClose={onClose}
      />
      {workspace && hasCapability && (
        <WorkItemsToolbar
          filters={filters}
          onChange={handleFilterChange}
          sources={sources}
          activeCount={snapshot?.items.length ?? 0}
          archivedCount={snapshot?.archivedItems.length ?? 0}
        />
      )}
      {body}
    </div>
  );
}
