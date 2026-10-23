"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkItems } from "@/hooks/useWorkItems";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { buildWorkItemsPageUrl } from "@/lib/work-items-page-url";
import { isWorkspaceSelectable, type WorkspaceSummary } from "@/lib/workspaces/types";
import type {
  WorkItemDetail,
  WorkItemImportOutcome,
  WorkItemType,
} from "@/lib/work-items/types";
import { PanelHeader } from "../PanelHeader";
import { WorkItemsToolbar } from "./WorkItemsToolbar";
import { WorkItemsList } from "./WorkItemsList";
import { WorkItemsBoard } from "./WorkItemsBoard";
import { WorkItemDetailView } from "./WorkItemDetailView";
import { WorkItemCreateForm, type WorkItemCreateFormValues } from "./WorkItemCreateForm";
import { responseJson, uploadWorkItemAttachments } from "./work-item-api";
import {
  defaultWorkItemFilters,
  filterWorkItems,
  parseStoredWorkItemFilters,
  sortWorkItems,
  type WorkItemsFilters,
} from "./work-item-queries";

/**
 * 中央工作项管理整页（M2 T8 页骨架 + T9 详情/创建/回收站接入，spec
 * §6.1/§6.2/§7）：页头（工作区选择器 + 列表|看板 分段 + ＋新建）+ 共享筛选栏
 * （活动|归档|回收站）+ 列表/看板 + 详情面板（WorkItemDetailView：概况/设计/
 * 证据/动作条/审计）。
 *
 * 页面身份显式绑定 props.workspaceId（spec §6.1：不用 activeWorkspace 代替，
 * 防止打开另一工作区的管理页时误写项目）。视图/筛选按工作区持久化：
 * `pi-work-items-view:<wsId>`、`pi-work-items-filters:<wsId>`。数据来自共享
 * store 的 useWorkItems（与右坞快捷面板同缓存）；mutation 成功统一走
 * invalidate()。选中项变化由页面自己 replace URL（buildWorkItemsPageUrl，不埋
 * 历史陷阱）。移动端宿主（M2 T10）：本组件全响应式——窄屏（≤640px）隐藏
 * 页头工作区选择器/视图分段，看板回落为阶段筛选列表（toolbar 的阶段筛选
 * 即筛选器），详情以全屏覆盖层呈现（列表→详情导航语义）；`onBack` 是移动
 * 端 ‹返回（回聊天）的透传，`createRequest` 承接总览「新建工作项」深链。
 */

type WorkItemsView = "list" | "board";

interface WorkItemsPageProps {
  workspaceId: string;
  /** 深链/openWorkItemsPage 带来的初始选中项（一次性意图，消费后由宿主清空）。 */
  initialItemKey?: string | null;
  /** 「查看会话」→ locate 打开聊天 tab（关闭中央页）。 */
  onOpenConversation: (sessionId: string) => void;
  /** 执行中断「去处理」（T9，spec §5.4）→ 宿主打开 Loops 面板（T10 接
   *  openRailModule(LOOPS_TAB_ID) 同款目的地）。 */
  onOpenLoopsRecovery?: () => void;
  /** initialItemKey 已消费（宿主清 workItemsItemKeyRef）。 */
  onConsumedInitialItem?: () => void;
  /** ✕ 关闭中央页。 */
  onClose?: () => void;
  /** 移动端 ‹返回（回聊天；PanelHeader 透传，与其它目的地页同款）。 */
  onBack?: () => void;
  backLabel?: string;
  /** 宿主的一次性「打开创建表单」请求（nonce 驱动；移动端总览「新建工作项」
   *  → 目的地页直达表单，与右坞快捷面板消费 createWorkItemRequest 同构）。 */
  createRequest?: { type: WorkItemType; id: number } | null;
  /** createRequest 已消费（nonce 一次性，fix round 1 Important）：页面打开
   *  表单后回调宿主清空请求——同 onConsumedInitialItem 的 consume-and-clear
   *  模式；不清空的话移动端 ‹聊天 卸载重挂载会让残留 nonce 自启表单。 */
  onConsumedCreateRequest?: () => void;
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

export function WorkItemsPage({
  workspaceId,
  initialItemKey,
  onOpenConversation,
  onOpenLoopsRecovery,
  onConsumedInitialItem,
  onClose,
  onBack,
  backLabel,
  createRequest,
  onConsumedCreateRequest,
  onOpenWorkItemsPage,
  onReplaceUrl,
  workspaces,
}: WorkItemsPageProps) {
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const hasCapability = Boolean(workspace?.capabilities.includes("work-items"));
  const { snapshot, loading, error, refresh, invalidate } = useWorkItems(workspace && hasCapability ? workspaceId : null);
  // 窄屏形态（移动端宿主，M2 T10 spec §6.1）：页头瘦身（选择器/视图分段
  // 隐藏，meta 显工作区名）、看板回落为列表（toolbar 阶段筛选即筛选器）、
  // 详情全屏覆盖（列表→详情导航）。
  const narrow = useMediaQuery("(max-width: 640px)");

  const [view, setView] = useState<WorkItemsView>("list");
  const [filters, setFilters] = useState<WorkItemsFilters>(defaultWorkItemFilters);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // ＋新建（T9）：表单面板开关 + 提交态。key 让每次打开都拿到干净草稿；
  // createFormType 记录打开时的预选类型（createRequest 深链带来，表单内仍可改）。
  const [createOpen, setCreateOpen] = useState(false);
  const [createFormKey, setCreateFormKey] = useState(0);
  const [createFormType, setCreateFormType] = useState<WorkItemType>("bug");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // 详情草稿态（概况/正文/设计编辑）——切项/切工作区前 confirm（spec §6.1）。
  const detailDirtyRef = useRef(false);

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

  /** 未保存草稿守卫（spec §6.1：切工作区/切项前 confirm）——创建表单开着或
   *  详情处于编辑草稿态时拦截一次确认。 */
  const confirmDiscardDrafts = useCallback((): boolean => {
    if (!createOpen && !detailDirtyRef.current) return true;
    return window.confirm("有未保存的草稿（创建表单或详情编辑），切换将丢失。继续？");
  }, [createOpen]);

  const handleSelect = useCallback((key: string) => {
    if (key === selectedKey) return;
    if (!confirmDiscardDrafts()) return;
    setSelectedKey(key);
    // 选中项变化由页面自己 replace URL（不埋历史陷阱；spec §6.1）。
    onReplaceUrl?.(buildWorkItemsPageUrl(workspaceId, key));
  }, [confirmDiscardDrafts, selectedKey, workspaceId, onReplaceUrl]);

  const handleFilterChange = useCallback((patch: Partial<WorkItemsFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const handleSwitchWorkspace = useCallback((id: string) => {
    if (id === workspaceId || !onOpenWorkItemsPage) return;
    if (!confirmDiscardDrafts()) return;
    onOpenWorkItemsPage(id);
  }, [confirmDiscardDrafts, workspaceId, onOpenWorkItemsPage]);

  const openCreateForm = useCallback((type?: WorkItemType) => {
    if (type) setCreateFormType(type);
    setCreateError(null);
    setCreateFormKey((value) => value + 1);
    setCreateOpen(true);
  }, []);

  // 宿主的一次性创建深链（nonce 驱动，重复请求可重复触发）：总览「新建
  // 工作项」在移动端直达目的地页的创建表单。消费即清（nonce 一次性——
  // 宿主清 shell 态，防止宿主重挂载时残留 nonce 再次自启表单）。
  useEffect(() => {
    if (!createRequest) return;
    openCreateForm(createRequest.type);
    onConsumedCreateRequest?.();
  }, [createRequest, openCreateForm, onConsumedCreateRequest]);

  /** 创建提交（沿用 WorkspaceManager 的流：POST 创建（含 enableDelivery）→
   *  附件上到新项 → 选中；导入去重（existing/existing_trashed）不当作新建。 */
  const handleCreate = useCallback(async (values: WorkItemCreateFormValues) => {
    setCreating(true);
    setCreateError(null);
    try {
      let detail = await responseJson<WorkItemDetail & { importOutcome?: WorkItemImportOutcome }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: values.type,
            title: values.title,
            originalDescription: values.originalDescription,
            priority: values.priority,
            repositories: values.repositories,
            enableDelivery: values.enableDelivery,
          }),
        }),
      );
      if (detail.importOutcome && detail.importOutcome !== "created") {
        // 导入去重（spec §8.1）：同 source+sourceId 已存在（含回收站墓碑）——
        // 服务端原样返回既有项、未重复创建。回收站项提示切到回收站范围恢复。
        setCreateOpen(false);
        invalidate();
        setCreateError(detail.importOutcome === "existing_trashed"
          ? `同来源工作项 ${detail.item.key} 已在回收站，未重复创建——切到「回收站」范围可恢复`
          : `同来源工作项 ${detail.item.key} 已存在，未重复创建`);
        return;
      }
      if (values.files.length > 0) {
        // 失败不静默丢：工作项已创建——报错并保留它，附件可后续在详情补传。
        try {
          detail = await uploadWorkItemAttachments(workspaceId, detail.item.key, values.files);
        } catch (attachmentError) {
          setCreateError(
            `工作项 ${detail.item.key} 已创建，但附件上传失败：${
              attachmentError instanceof Error ? attachmentError.message : String(attachmentError)
            }`,
          );
        }
      }
      setCreateOpen(false);
      invalidate();
      setSelectedKey(detail.item.key);
      onReplaceUrl?.(buildWorkItemsPageUrl(workspaceId, detail.item.key));
    } catch (createError) {
      setCreateError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  }, [invalidate, onReplaceUrl, workspaceId]);

  const allItems = useMemo(
    () => [...(snapshot?.items ?? []), ...(snapshot?.archivedItems ?? [])],
    [snapshot],
  );
  const scoped = useMemo(
    () => filters.scope === "archived"
      ? snapshot?.archivedItems ?? []
      : filters.scope === "trash"
        ? snapshot?.trashedItems ?? []
        : snapshot?.items ?? [],
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
  // 选中项跨范围解析：活动∪归档优先；仅存在于回收站时按 trashed 记录渲染
  // （详情进入只读 + 恢复模式）。同 key 复用（新建占掉被删 key）时以活树为准。
  const trashedSelected = useMemo(
    () => snapshot?.trashedItems.find((item) => item.key === selectedKey) ?? null,
    [snapshot, selectedKey],
  );
  const selectedItem = useMemo(
    () => allItems.find((item) => item.key === selectedKey) ?? trashedSelected,
    [allItems, selectedKey, trashedSelected],
  );
  const selectedIsTrashed = selectedItem != null && !allItems.some((item) => item.key === selectedItem.key);

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
      ? (filters.scope === "archived"
        ? "暂无归档工作项"
        : filters.scope === "trash"
          ? "回收站为空"
          : "暂无工作项")
      : undefined;
    // 详情面板（列表/看板共用，T9）：选中项 → WorkItemDetailView（回收站命中
    // 时只读 + 恢复）；未选中 → 空态。宽屏 = 贴右列（看板横向滚动同样贴右）；
    // 窄屏（移动端）= 全屏覆盖层盖住列表（列表→详情导航，详情 ‹关闭/自身
    // onClose 回列表）。
    const detailContent = (
      <div
        style={narrow ? {
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--bg-panel)",
        } : {
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
        {selectedItem ? (
          <WorkItemDetailView
            workspaceId={workspaceId}
            item={selectedItem}
            repositories={workspace?.repositories ?? []}
            trashed={selectedIsTrashed}
            onOpenConversation={onOpenConversation}
            onOpenLoopsRecovery={onOpenLoopsRecovery}
            onChanged={invalidate}
            onClose={() => {
              setSelectedKey(null);
              onReplaceUrl?.(buildWorkItemsPageUrl(workspaceId));
            }}
            onRestored={(key) => {
              handleFilterChange({ scope: "active" });
              setSelectedKey(key);
              onReplaceUrl?.(buildWorkItemsPageUrl(workspaceId, key));
            }}
            onDirtyChange={(dirty) => {
              detailDirtyRef.current = dirty;
            }}
          />
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
            选择工作项
          </div>
        )}
      </div>
    );
    body = (
      <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {createOpen ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14 }}>
              <WorkItemCreateForm
                key={createFormKey}
                initialType={createFormType}
                repositories={(workspace?.repositories ?? []).filter((repository) => repository.status === "active")}
                saving={creating}
                onCancel={() => {
                  setCreateOpen(false);
                  setCreateError(null);
                }}
                onSubmit={(values) => void handleCreate(values)}
              />
            </div>
          ) : view === "board" && !narrow ? (
            <WorkItemsBoard items={visible} selectedKey={selectedKey} onSelect={handleSelect} />
          ) : (
            <WorkItemsList items={visible} selectedKey={selectedKey} onSelect={handleSelect} emptyHint={emptyHint} />
          )}
        </div>
        {narrow
          ? (selectedItem && !createOpen ? (
            <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
              {detailContent}
            </div>
          ) : null)
          : detailContent}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <PanelHeader
        title="工作项"
        meta={narrow ? workspace?.name : undefined}
        onBack={onBack}
        backLabel={backLabel}
        actions={
          <>
            {workspace && !narrow && (
              <HeaderWorkspaceSelector
                workspaces={workspaces.filter(isWorkspaceSelectable)}
                selected={workspace}
                onSelect={handleSwitchWorkspace}
              />
            )}
            {!narrow && (
              <div role="tablist" aria-label="视图" style={{ display: "flex", gap: 2, padding: 2, background: "var(--bg-hover)", borderRadius: 7, flexShrink: 0 }}>
                {viewButton("list", "列表")}
                {viewButton("board", "看板")}
              </div>
            )}
            <button
              type="button"
              onClick={() => openCreateForm()}
              disabled={createOpen}
              title="新建工作项（需求 / Bug，可选启用标准交付流程）"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                height: 26,
                padding: "0 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
                color: "var(--text-muted)",
                fontSize: 12,
                fontWeight: 600,
                cursor: createOpen ? "default" : "pointer",
                opacity: createOpen ? 0.6 : 1,
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
          trashedCount={snapshot?.trashedItems.length ?? 0}
        />
      )}
      {createError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, #ef4444 6%, var(--bg))",
            color: "#dc2626",
            fontSize: 11.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{createError}</span>
          <button
            type="button"
            onClick={() => setCreateError(null)}
            aria-label="关闭提示"
            style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      )}
      {body}
    </div>
  );
}
