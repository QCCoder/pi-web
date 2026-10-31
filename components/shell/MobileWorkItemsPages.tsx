"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AttentionEntry, AttentionKind } from "@/lib/api-types";
import { useWorkItems } from "@/hooks/useWorkItems";
import { formatRelativeTime } from "@/lib/format-time";
import { sourceLabel } from "@/lib/work-items/source-labels";
import type {
  WorkItemDetail,
  WorkItemImportOutcome,
  WorkItemPhase,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemStatus,
  WorkItemType,
} from "@/lib/work-items/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { WorkItemDetailView } from "../work-items/WorkItemDetailView";
import { WorkItemCreateForm, type WorkItemCreateFormValues } from "../work-items/WorkItemCreateForm";
import { responseJson, uploadWorkItemAttachments } from "../work-items/work-item-api";
import { useDeliveryExecution } from "../work-items/useDeliveryExecution";
import { PHASE_LABELS, STATUS_LABELS } from "../work-items/work-item-phases";
import {
  defaultWorkItemFilters,
  filterWorkItems,
  isItemFlagged,
  parseStoredWorkItemFilters,
  sortWorkItems,
  type WorkItemsFilters,
} from "../work-items/work-item-queries";
import {
  ATTENTION_KIND_LABELS,
  groupActiveWorkItems,
  primaryAttentionByKey,
  type MobileGroup,
  type PrimaryAttention,
} from "../work-items/mobile-groups";
import {
  MobileCard,
  MobileEmpty,
  MobileErrorBanner,
  MobileNavBar,
  MobilePrimaryButton,
  MobileSearchField,
  MobileSecondaryButton,
} from "./mobile-ui";

/**
 * 手机壳（<768px）的工作项三页（2026-10，knowledge/designs/mobile-work-items-design.md）：
 *
 *   MobileWorkItemsPage        列表根页：‹ + 工作项 + ＋ → 搜索 → 活动|归档|回收站
 *                              分段 → 筛选筹片（原生 select 盖在筹片上，不自绘弹层）
 *                              → 「需要你处理」琥珀带（attention 队列）→ 进行中 / 待处理 /
 *                              已阻塞 / 已结束（缺省折叠）分组卡片。标准流程项每行带
 *                              七段**阶段轨迹**——不读字也知道走到哪了。
 *   MobileWorkItemDetailPage   详情子页：‹ 工作项 + KEY；正文复用 WorkItemDetailView
 *                              （hideClose——返回由页头承担）；执行状态走 useDeliveryExecution。
 *   MobileWorkItemCreatePage   新建子页：复用 WorkItemCreateForm；创建成功 → onCreated(key)
 *                              由壳 replaceTop 成详情页（‹ 直接回列表，不经表单）。
 *
 * 推入/返回由 MobileTabShell 的 pushStack 承担（work-item-detail / work-item-create
 * 两种 PushPage）——Android 返回键、‹、tab 切换清栈的语义与 Skill 三页一致。筛选
 * 持久化键与桌面同款 `pi-work-items-filters:<wsId>`，两端互认。
 */

const RED = "#dc2626";
const ORANGE = "#ea580c";
const AMBER = "#b45309";
const GREEN = "#16a34a";
const BLUE = "#2563eb";

const PRIORITY_COLORS: Record<WorkItemPriority, string> = {
  P0: RED,
  P1: ORANGE,
  P2: "var(--text-muted)",
  P3: "var(--text-dim)",
};

/** 与桌面 AttentionBar 同一套 kind 配色：问题 = accent，确认 = 琥珀（等你的手），
 *  发布 = 绿，验收 = 蓝，阻塞 = 红。 */
const KIND_COLORS: Record<AttentionKind, string> = {
  question: "var(--accent)",
  confirm: AMBER,
  release: GREEN,
  acceptance: BLUE,
  blocked: RED,
};

const ALL_PHASES: WorkItemPhase[] = [
  "intake", "analysis", "requirement_approval", "design", "plan_approval",
  "implementation", "verification", "complete",
  "ready_for_implementation", "release_ready", "released",
];

function keyColor(type: WorkItemType): string {
  return type === "bug" ? RED : "var(--accent)";
}

// ----------------------------------------------------------------------------
// 小件
// ----------------------------------------------------------------------------

/** 页头右侧 ＋（MobileIconButton 同几何 40×40；accent 色——它是这一页的主动作）。 */
function HeaderPlusButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="新建工作项"
      title="新建工作项"
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 40, height: 40, padding: 0, border: 0, borderRadius: 10,
        background: "transparent", color: "var(--accent)", cursor: "pointer", flexShrink: 0,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  );
}

const chipBaseStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex", alignItems: "center", gap: 5,
  height: 32, padding: "0 10px 0 12px", borderRadius: 999,
  fontSize: 12.5, whiteSpace: "nowrap", flexShrink: 0,
  cursor: "pointer", userSelect: "none",
};

function chipTone(active: boolean, color = "var(--accent)"): CSSProperties {
  return active
    ? {
        border: `1px solid color-mix(in srgb, ${color} 45%, var(--border))`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
        fontWeight: 600,
      }
    : {
        border: "1px solid var(--border)",
        background: "var(--bg-panel)",
        color: "var(--text)",
        fontWeight: 400,
      };
}

/** 筹片形态的原生 select：一个透明的 <select> 盖满筹片——点筹片就弹系统选择器
 *  （iOS 滚轮 / Android 下拉），零自绘弹层。选中非「全部」时筹片文案换成选中项并点亮。 */
function ChipSelect<T extends string>({
  label,
  ariaLabel,
  value,
  allValue,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: T;
  allValue: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const active = value !== allValue;
  const current = options.find((option) => option.value === value)?.label ?? label;
  return (
    <label style={{ ...chipBaseStyle, ...chipTone(active) }}>
      <span>{active ? current : label}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.7 }}>
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          opacity: 0, appearance: "none", border: 0, margin: 0, padding: 0,
          cursor: "pointer", fontSize: 16,
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function ChipToggle({ label, active, color, onClick }: { label: string; active: boolean; color?: string; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} style={{ ...chipBaseStyle, ...chipTone(active, color), padding: "0 12px" }}>
      {label}
    </button>
  );
}

function ScopeSegmented({
  value,
  counts,
  onChange,
}: {
  value: WorkItemsFilters["scope"];
  counts: Record<WorkItemsFilters["scope"], number>;
  onChange: (scope: WorkItemsFilters["scope"]) => void;
}) {
  const entries: Array<{ scope: WorkItemsFilters["scope"]; label: string }> = [
    { scope: "active", label: "活动" },
    { scope: "archived", label: "归档" },
    { scope: "trash", label: "回收站" },
  ];
  return (
    <div
      role="tablist"
      aria-label="范围"
      style={{
        display: "flex", gap: 2, margin: "10px 12px 0", padding: 3,
        background: "var(--bg-hover)", borderRadius: 11,
      }}
    >
      {entries.map((entry) => {
        const selected = value === entry.scope;
        return (
          <button
            key={entry.scope}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(entry.scope)}
            style={{
              flex: 1, height: 32, border: 0, borderRadius: 9,
              background: selected ? "var(--bg-panel)" : "transparent",
              boxShadow: selected ? "0 1px 3px rgba(0,0,0,0.14)" : "none",
              color: selected ? "var(--text)" : "var(--text-muted)",
              fontSize: 13, fontWeight: selected ? 600 : 500, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
            }}
          >
            {entry.label}
            <span style={{ fontSize: 11.5, color: selected ? "var(--text-muted)" : "var(--text-dim)", fontWeight: 500 }}>
              {counts[entry.scope]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 分组标题行：与 MobileSection 同一字号/内边距；可折叠组整行是按钮。 */
function GroupHeader({
  label,
  count,
  color,
  collapsible = false,
  collapsed = false,
  onToggle,
}: {
  label: string;
  count: number;
  /** 标题色（「需要你处理」用琥珀——与它下面的琥珀卡是同一个信号，不另加圆点）。 */
  color?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span style={{ flex: 1, fontSize: 12, color: color ?? "var(--text-muted)", fontWeight: color ? 600 : 400, letterSpacing: 0.2 }}>{label}</span>
      <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{count}</span>
      {collapsible && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-dim)", transform: collapsed ? "none" : "rotate(180deg)", transition: "transform 0.12s" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      )}
    </>
  );
  const style: CSSProperties = { display: "flex", alignItems: "center", gap: 7, padding: "16px 22px 6px", width: "100%" };
  if (collapsible) {
    return (
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} style={{ ...style, border: 0, background: "transparent", textAlign: "left", cursor: "pointer" }}>
        {content}
      </button>
    );
  }
  return <div style={style}>{content}</div>;
}

const rowButtonStyle = (first: boolean): CSSProperties => ({
  display: "flex", flexDirection: "column", gap: 5,
  width: "100%", padding: "11px 14px",
  border: 0,
  borderTopWidth: first ? 0 : 1, borderTopStyle: first ? "none" : "solid", borderTopColor: "var(--border)",
  background: "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer",
});

const rowTitleStyle: CSSProperties = {
  fontSize: 15, fontWeight: 500, lineHeight: 1.35, color: "var(--text)",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};

const rowMetaStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, minHeight: 16,
  fontSize: 12, color: "var(--text-muted)", overflow: "hidden",
};

/** 第二行状态：KEY · 优先级 · 阶段（children = 各行自己的状态/标记），右端 trailing。 */
function RowMetaLine({
  item,
  trailing,
  children,
}: {
  item: WorkItemRecord;
  trailing: ReactNode;
  children?: ReactNode;
}) {
  return (
    <span style={rowMetaStyle}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: keyColor(item.type), flexShrink: 0 }}>{item.key}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: PRIORITY_COLORS[item.priority], flexShrink: 0 }}>{item.priority}</span>
      {children}
      <span style={{ flex: 1 }} />
      {trailing}
    </span>
  );
}

/** 工作项 cell 两行（2026-10-26 用户反馈）：第一行标题，第二行状态——
 *  KEY · 优先级 · 阶段（+ 待确认 / 状态）⋯ 时间。 */
function WorkItemListRow({
  item,
  first,
  showStatus,
  onOpen,
}: {
  item: WorkItemRecord;
  first: boolean;
  /** 组名已隐含状态时不显（活动范围的 进行中/待处理/已阻塞 组）。 */
  showStatus: boolean;
  onOpen: (key: string) => void;
}) {
  const managed = item.delivery?.protocolVersion === 1;
  const awaitingLegacyConfirm = !managed && isItemFlagged(item) && item.status !== "blocked";
  return (
    <button type="button" onClick={() => onOpen(item.key)} style={rowButtonStyle(first)}>
      <span style={rowTitleStyle}>{item.title}</span>
      <RowMetaLine
        item={item}
        trailing={<span style={{ fontSize: 11.5, color: "var(--text-dim)", flexShrink: 0 }}>{formatRelativeTime(item.updatedAt)}</span>}
      >
        <span>{PHASE_LABELS[item.phase]}</span>
        {awaitingLegacyConfirm && <span style={{ color: AMBER, fontWeight: 600 }}>待确认</span>}
        {showStatus && (
          <span style={{ color: item.status === "blocked" ? RED : "var(--text-dim)" }}>{STATUS_LABELS[item.status]}</span>
        )}
      </RowMetaLine>
    </button>
  );
}

/** 「需要你处理」行：同样两行——标题 / KEY · 优先级 · 阶段 · 已催办/已泊车 ⋯
 *  行尾 kind 文案（问题/确认/发布/阻塞 +N）+ 已等天数；问题原文 / 阻塞原因
 *  另起一行——问题就是你要回答的东西，值得单独一行。 */
function AttentionListRow({
  item,
  attention,
  first,
  onOpen,
}: {
  item: WorkItemRecord;
  attention: PrimaryAttention;
  first: boolean;
  onOpen: (key: string) => void;
}) {
  const { entry, extra } = attention;
  const color = KIND_COLORS[entry.kind];
  const detailLine = entry.kind === "question" || entry.kind === "blocked" ? entry.detail : null;
  const waited = entry.ageDays <= 0 ? "今天" : `已等 ${entry.ageDays} 天`;
  return (
    <button type="button" onClick={() => onOpen(item.key)} style={rowButtonStyle(first)}>
      <span style={rowTitleStyle}>{item.title}</span>
      <RowMetaLine
        item={item}
        trailing={(
          <>
            <span style={{ fontSize: 12, fontWeight: 600, color, flexShrink: 0 }}>
              {ATTENTION_KIND_LABELS[entry.kind]}{extra > 0 ? ` +${extra}` : ""}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--text-dim)", flexShrink: 0 }}>{waited}</span>
          </>
        )}
      >
        <span>{PHASE_LABELS[item.phase]}</span>
        {entry.nudged && <span style={{ fontSize: 11, color: AMBER, flexShrink: 0 }}>已催办</span>}
        {entry.parked && <span style={{ fontSize: 11, color: RED, flexShrink: 0 }}>已泊车</span>}
      </RowMetaLine>
      {detailLine && (
        <span
          style={{
            fontSize: 12.5, lineHeight: 1.4, color: "var(--text-muted)",
            display: "-webkit-box", WebkitLineClamp: entry.kind === "question" ? 2 : 1, WebkitBoxOrient: "vertical",
            overflow: "hidden", overflowWrap: "anywhere",
          }}
        >
          {detailLine}
        </span>
      )}
    </button>
  );
}

function SkeletonRows() {
  const bar = (width: number | string, height: number): CSSProperties => ({ width, height, borderRadius: 4, background: "var(--bg-hover)" });
  return (
    <MobileCard style={{ marginTop: 14 }} >
      {[0, 1, 2].map((index) => (
        <div key={index} aria-hidden style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 14px", borderTop: index === 0 ? 0 : "1px solid var(--border)" }}>
          <span style={bar("72%", 14)} />
          <span style={bar(160, 9)} />
        </div>
      ))}
    </MobileCard>
  );
}

// ----------------------------------------------------------------------------
// attention 队列取数（与桌面 AttentionBar 同节拍：refreshToken = 快照 fetchedAt）
// ----------------------------------------------------------------------------

function useAttentionEntries(workspaceId: string | null, refreshToken: unknown): { entries: AttentionEntry[]; error: string | null } {
  const [entries, setEntries] = useState<AttentionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) {
      setEntries([]);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/attention`);
        const data = (await response.json().catch(() => ({}))) as { entries?: AttentionEntry[]; error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(data.error ?? `HTTP ${response.status}`);
          return;
        }
        setError(null);
        setEntries(data.entries ?? []);
      } catch {
        if (!cancelled) setError("网络错误");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshToken]);
  return { entries, error };
}

// ----------------------------------------------------------------------------
// 列表根页
// ----------------------------------------------------------------------------

export function MobileWorkItemsPage({
  workspace,
  onBack,
  backLabel,
  onOpenItem,
  onCreate,
  initialItemKey,
  onConsumedInitialItem,
  createRequest,
  onConsumedCreateRequest,
}: {
  workspace: WorkspaceSummary;
  onBack: () => void;
  backLabel: string;
  /** 行点击 → 壳推入详情页。 */
  onOpenItem: (key: string) => void;
  /** ＋ / 空态按钮 → 壳推入新建页。 */
  onCreate: (type?: WorkItemType) => void;
  /** 深链 `&item=<key>`（一次性意图，消费后由宿主清空）。 */
  initialItemKey?: string | null;
  onConsumedInitialItem?: () => void;
  /** 总览「新建工作项」的一次性请求（nonce 驱动）。 */
  createRequest?: { type: WorkItemType; id: number } | null;
  onConsumedCreateRequest?: () => void;
}) {
  const hasCapability = workspace.capabilities.includes("work-items");
  const workspaceId = workspace.id;
  const { snapshot, error, refresh } = useWorkItems(hasCapability ? workspaceId : null);
  // attention 队列与桌面 AttentionBar 同节拍：refreshToken = 共享快照的 fetchedAt，
  // 不自建 timer；范围切到归档/回收站时不渲染带，但请求照常（与桌面一致、少一个分叉）。
  const { entries: attentionEntries, error: attentionError } = useAttentionEntries(
    hasCapability ? workspaceId : null,
    snapshot?.fetchedAt,
  );

  const [filters, setFilters] = useState<WorkItemsFilters>(defaultWorkItemFilters);
  const [finishedOpen, setFinishedOpen] = useState(false);

  // 筛选按工作区持久化（与桌面同键，两端互认）；挂载后 hydrate 避免 SSR 不一致。
  useEffect(() => {
    let stored = defaultWorkItemFilters();
    try {
      stored = parseStoredWorkItemFilters(localStorage.getItem(`pi-work-items-filters:${workspaceId}`));
    } catch { /* localStorage unavailable — keep defaults */ }
    setFilters(stored);
  }, [workspaceId]);
  useEffect(() => {
    try { localStorage.setItem(`pi-work-items-filters:${workspaceId}`, JSON.stringify(filters)); } catch { /* ignore */ }
  }, [workspaceId, filters]);

  // 深链选中项 / 总览新建请求：一次性意图，消费即清。
  useEffect(() => {
    if (!initialItemKey) return;
    onOpenItem(initialItemKey);
    onConsumedInitialItem?.();
  }, [initialItemKey, onOpenItem, onConsumedInitialItem]);
  useEffect(() => {
    if (!createRequest) return;
    onCreate(createRequest.type);
    onConsumedCreateRequest?.();
  }, [createRequest, onCreate, onConsumedCreateRequest]);

  const patchFilters = useCallback((patch: Partial<WorkItemsFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const allItems = useMemo(
    () => [...(snapshot?.items ?? []), ...(snapshot?.archivedItems ?? [])],
    [snapshot],
  );
  const scoped = useMemo(() => filters.scope === "archived"
    ? snapshot?.archivedItems ?? []
    : filters.scope === "trash"
      ? snapshot?.trashedItems ?? []
      : snapshot?.items ?? [], [snapshot, filters.scope]);
  const visible = useMemo(() => sortWorkItems(filterWorkItems(scoped, filters)), [scoped, filters]);
  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const item of allItems) if (item.external?.source) set.add(item.external.source);
    return [...set].sort();
  }, [allItems]);

  const attentionByKey = useMemo(() => primaryAttentionByKey(attentionEntries), [attentionEntries]);
  const groups = useMemo<MobileGroup[]>(
    () => (filters.scope === "active" ? groupActiveWorkItems(visible, new Set(attentionByKey.keys())) : []),
    [filters.scope, visible, attentionByKey],
  );

  const hasNarrowingFilters = filters.search.trim() !== ""
    || filters.type !== "all" || filters.phase !== "all" || filters.priority !== "all"
    || filters.source !== "all" || filters.flaggedOnly;
  const clearNarrowingFilters = () => patchFilters({ ...defaultWorkItemFilters(), scope: filters.scope });

  let body: ReactNode;
  if (!hasCapability) {
    body = (
      <MobileEmpty
        title="这个工作区还没启用「工作项」"
        body="在 工作区设置 › 能力 里开启后，就能在这里管理需求与缺陷。"
      />
    );
  } else if (!snapshot) {
    // 没拿到快照就是加载中——useWorkItems 的 loading 初值为 false，首帧若按它判断
    // 会闪一帧「还没有工作项」的假空态；拉取失败才换成错误 + 重试。
    body = error ? (
      <>
        <MobileErrorBanner>{error}</MobileErrorBanner>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
          <MobileSecondaryButton onClick={() => void refresh()}>重试</MobileSecondaryButton>
        </div>
      </>
    ) : (
      <SkeletonRows />
    );
  } else if (scoped.length === 0) {
    body = filters.scope === "active" ? (
      <MobileEmpty
        title="还没有工作项"
        body="记一个需求或缺陷，交付流就从这里开始。"
        action={<MobilePrimaryButton onClick={() => onCreate()}>新建工作项</MobilePrimaryButton>}
      />
    ) : (
      <MobileEmpty title={filters.scope === "archived" ? "没有归档的工作项" : "回收站是空的"} />
    );
  } else if (visible.length === 0) {
    body = (
      <MobileEmpty
        title="没有匹配的工作项"
        body="换个关键词，或者清除筛选。"
        action={<MobileSecondaryButton onClick={clearNarrowingFilters}>清除筛选</MobileSecondaryButton>}
      />
    );
  } else if (filters.scope !== "active") {
    // 归档 / 回收站：范围分段已经说明了身份，一张卡平铺即可（行上显状态）。
    body = (
      <MobileCard style={{ marginTop: 14 }}>
        {visible.map((item, index) => (
          <WorkItemListRow key={item.key} item={item} first={index === 0} showStatus onOpen={onOpenItem} />
        ))}
      </MobileCard>
    );
  } else {
    body = (
      <>
        {attentionError && (
          <div style={{ margin: "12px 22px 0", fontSize: 11.5, color: "var(--text-dim)" }}>待处理队列加载失败：{attentionError}</div>
        )}
        {groups.map((group) => {
          if (group.id === "attention") {
            return (
              <div key={group.id}>
                <GroupHeader label={group.label} count={group.items.length} color={AMBER} />
                <MobileCard
                  style={{
                    background: `color-mix(in srgb, ${AMBER} 7%, var(--bg-panel))`,
                    borderColor: `color-mix(in srgb, ${AMBER} 32%, var(--border))`,
                  }}
                >
                  {group.items.map((item, index) => {
                    const attention = attentionByKey.get(item.key);
                    return attention ? (
                      <AttentionListRow key={item.key} item={item} attention={attention} first={index === 0} onOpen={onOpenItem} />
                    ) : (
                      <WorkItemListRow key={item.key} item={item} first={index === 0} showStatus={false} onOpen={onOpenItem} />
                    );
                  })}
                </MobileCard>
              </div>
            );
          }
          const collapsible = group.collapsedByDefault;
          const collapsed = collapsible && !finishedOpen;
          return (
            <div key={group.id}>
              <GroupHeader
                label={group.label}
                count={group.items.length}
                collapsible={collapsible}
                collapsed={collapsed}
                onToggle={() => setFinishedOpen((open) => !open)}
              />
              {!collapsed && (
                <MobileCard>
                  {group.items.map((item, index) => (
                    <WorkItemListRow
                      key={item.key}
                      item={item}
                      first={index === 0}
                      showStatus={group.id === "finished"}
                      onOpen={onOpenItem}
                    />
                  ))}
                </MobileCard>
              )}
            </div>
          );
        })}
      </>
    );
  }

  const counts: Record<WorkItemsFilters["scope"], number> = {
    active: snapshot?.items.length ?? 0,
    archived: snapshot?.archivedItems.length ?? 0,
    trash: snapshot?.trashedItems.length ?? 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar
        title="工作项"
        onBack={onBack}
        backLabel={backLabel}
        actions={hasCapability ? <HeaderPlusButton onClick={() => onCreate()} /> : undefined}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: "calc(28px + env(safe-area-inset-bottom, 0px))" }}>
        {hasCapability && snapshot && (
          <>
            <MobileSearchField
              value={filters.search}
              onChange={(search) => patchFilters({ search })}
              placeholder="搜索 KEY 或标题"
            />
            <ScopeSegmented value={filters.scope} counts={counts} onChange={(scope) => patchFilters({ scope })} />
            <div
              style={{
                display: "flex", gap: 8, padding: "10px 12px 0",
                overflowX: "auto", scrollbarWidth: "none", WebkitOverflowScrolling: "touch",
              }}
            >
              <ChipSelect
                label="类型"
                ariaLabel="类型"
                value={filters.type}
                allValue="all"
                options={[
                  { value: "all", label: "全部类型" },
                  { value: "requirement", label: "需求" },
                  { value: "bug", label: "缺陷" },
                ]}
                onChange={(type) => patchFilters({ type })}
              />
              <ChipSelect
                label="优先级"
                ariaLabel="优先级"
                value={filters.priority}
                allValue="all"
                options={[
                  { value: "all", label: "全部优先级" },
                  { value: "P0", label: "P0" },
                  { value: "P1", label: "P1" },
                  { value: "P2", label: "P2" },
                  { value: "P3", label: "P3" },
                ]}
                onChange={(priority) => patchFilters({ priority })}
              />
              <ChipSelect
                label="阶段"
                ariaLabel="阶段"
                value={filters.phase}
                allValue="all"
                options={[
                  { value: "all" as WorkItemsFilters["phase"], label: "全部阶段" },
                  ...ALL_PHASES.map((phase) => ({ value: phase as WorkItemsFilters["phase"], label: PHASE_LABELS[phase] })),
                ]}
                onChange={(phase) => patchFilters({ phase })}
              />
              <ChipToggle
                label="阻塞 / 待确认"
                active={filters.flaggedOnly}
                color={RED}
                onClick={() => patchFilters({ flaggedOnly: !filters.flaggedOnly })}
              />
              {sources.length > 0 && (
                <ChipSelect
                  label="来源"
                  ariaLabel="来源"
                  value={filters.source}
                  allValue="all"
                  options={[
                    { value: "all", label: "全部来源" },
                    { value: "manual", label: "手动创建" },
                    ...sources.map((source) => ({ value: source, label: sourceLabel(source) })),
                  ]}
                  onChange={(source) => patchFilters({ source })}
                />
              )}
              {hasNarrowingFilters && (
                <button
                  type="button"
                  onClick={clearNarrowingFilters}
                  style={{ ...chipBaseStyle, border: 0, background: "transparent", color: "var(--accent)", padding: "0 6px", fontWeight: 600 }}
                >
                  清除
                </button>
              )}
            </div>
          </>
        )}
        {body}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 详情子页
// ----------------------------------------------------------------------------

export function MobileWorkItemDetailPage({
  workspace,
  itemKey,
  onBack,
  backLabel,
  onOpenConversation,
  onOpenLoopsRecovery,
}: {
  workspace: WorkspaceSummary;
  itemKey: string;
  onBack: () => void;
  backLabel: string;
  onOpenConversation: (sessionId: string) => void;
  onOpenLoopsRecovery?: () => void;
}) {
  const { snapshot, invalidate } = useWorkItems(workspace.id);
  const activeItem = useMemo(
    () => snapshot?.items.find((item) => item.key === itemKey)
      ?? snapshot?.archivedItems.find((item) => item.key === itemKey)
      ?? null,
    [snapshot, itemKey],
  );
  const trashedItem = useMemo(
    () => snapshot?.trashedItems.find((item) => item.key === itemKey) ?? null,
    [snapshot, itemKey],
  );
  const item = activeItem ?? trashedItem;
  const trashed = activeItem === null && trashedItem !== null;
  const exec = useDeliveryExecution({ workspaceId: workspace.id, item, trashed, invalidate });

  const dirtyRef = useRef(false);
  const handleBack = useCallback(() => {
    if (dirtyRef.current && !window.confirm("有未保存的编辑，返回将丢失。继续？")) return;
    onBack();
  }, [onBack]);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  let body: ReactNode;
  if (!snapshot) {
    body = <SkeletonRows />;
  } else if (!item) {
    body = (
      <MobileEmpty
        title="这个工作项已不在列表中"
        body="它可能刚被删除，或者属于另一个工作区。"
        action={<MobileSecondaryButton onClick={onBack}>返回工作项</MobileSecondaryButton>}
      />
    );
  } else {
    body = (
      <WorkItemDetailView
        workspaceId={workspace.id}
        item={item}
        repositories={workspace.repositories}
        trashed={trashed}
        execution={exec.execution}
        executionBusy={exec.busy}
        hideClose
        onOpenConversation={onOpenConversation}
        onOpenLoopsRecovery={onOpenLoopsRecovery}
        onStopExecution={exec.stop}
        onRecoverExecution={exec.recover}
        onResumeAutomation={exec.resumeAutomation}
        onChanged={invalidate}
        onClose={onBack}
        onDirtyChange={handleDirtyChange}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar
        title={item?.key ?? itemKey}
        onBack={handleBack}
        backLabel={backLabel}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {body}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 新建子页
// ----------------------------------------------------------------------------

export function MobileWorkItemCreatePage({
  workspace,
  initialType = "bug",
  onBack,
  backLabel,
  onCreated,
}: {
  workspace: WorkspaceSummary;
  initialType?: WorkItemType;
  onBack: () => void;
  backLabel: string;
  /** 创建成功 → 壳把本页换成该项的详情页。 */
  onCreated: (key: string) => void;
}) {
  const { invalidate } = useWorkItems(workspace.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 与桌面 WorkItemsPage.handleCreate 同一条流：POST 创建（含 enableDelivery）→
   *  附件上到新项 → 打开详情；导入去重（existing/existing_trashed）不当作新建。 */
  const handleSubmit = useCallback(async (values: WorkItemCreateFormValues) => {
    setSaving(true);
    setError(null);
    try {
      let detail = await responseJson<WorkItemDetail & { importOutcome?: WorkItemImportOutcome }>(
        await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/work-items`, {
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
        invalidate();
        setError(detail.importOutcome === "existing_trashed"
          ? `同来源工作项 ${detail.item.key} 已在回收站，未重复创建——切到「回收站」范围可恢复`
          : `同来源工作项 ${detail.item.key} 已存在，未重复创建`);
        return;
      }
      if (values.files.length > 0) {
        // 失败不静默丢：工作项已创建——报错并保留它，附件可后续在详情补传。
        try {
          detail = await uploadWorkItemAttachments(workspace.id, detail.item.key, values.files);
        } catch (attachmentError) {
          window.alert(
            `工作项 ${detail.item.key} 已创建，但附件上传失败：${
              attachmentError instanceof Error ? attachmentError.message : String(attachmentError)
            }`,
          );
        }
      }
      invalidate();
      onCreated(detail.item.key);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }, [invalidate, onCreated, workspace.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <MobileNavBar title="新建工作项" onBack={onBack} backLabel={backLabel} />
      {error && <MobileErrorBanner>{error}</MobileErrorBanner>}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 12px calc(20px + env(safe-area-inset-bottom, 0px))" }}>
        <WorkItemCreateForm
          repositories={workspace.repositories.filter((repository) => repository.status === "active")}
          initialType={initialType}
          saving={saving}
          onCancel={onBack}
          onSubmit={(values) => void handleSubmit(values)}
        />
      </div>
    </div>
  );
}
