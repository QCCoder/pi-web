"use client";

import { useEffect, useState } from "react";
import type { AttentionEntry, AttentionKind } from "@/lib/api-types";

/**
 * 中央页顶部「待处理」条（final-arch step-2 Task 6，spec §8——唯一人工待办
 * 队列的 UI 面）：GET /api/workspaces/[id]/attention 的四类条目按 kind 计数成
 * chips（待答问题 / 待确认设计 / 待登记发布 / 阻塞），展开后逐行 KEY · 标题 ·
 * 已 N 天 · 已催办/已泊车 徽标（完整 detail 进 title），点行 → onSelectItem(key)
 * 定位详情——未答澄清在详情的 ClarificationPanel 作答。取数时机 = 挂载 +
 * refreshToken 变化：宿主 WorkItemsPage 把共享快照的 fetchedAt 传进来，即复用
 * 既有 5s 轮询节拍，本组件不建第二个 timer。空队列渲染 null；取数失败降级为
 * 一行 muted 提示（advisory 面板不抛错、不打断页面；已有条目时保留旧列表）。
 * AttentionBarView 是纯展示子件，测试直染（WorkItemExecution 的 props 注入
 * 同款习语）。条在页面流内，不设固定视口高度（ui-shell 键盘适配规则）。
 */

/** kind 定序与文案（chips 固定序 = 任务书列举序）。 */
const KIND_ORDER: readonly AttentionKind[] = ["question", "confirm", "release", "blocked"];

const KIND_LABELS: Record<AttentionKind, string> = {
  question: "待答问题",
  confirm: "待确认设计",
  release: "待登记发布",
  blocked: "阻塞",
};

const KIND_COLORS: Record<AttentionKind, string> = {
  question: "var(--accent)",
  confirm: "#b45309",
  release: "#16a34a",
  blocked: "#dc2626",
};

export function AttentionBarView({
  entries,
  error = null,
  initialExpanded = false,
  onSelectItem,
}: {
  entries: AttentionEntry[];
  /** 最近一次取数的失败提示（advisory——与条目并存，不替换列表）。 */
  error?: string | null;
  /** 展开态播种（测试缝；产品缺省收起，只显 chips）。 */
  initialExpanded?: boolean;
  onSelectItem: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  if (entries.length === 0 && !error) return null;
  const counts = new Map<AttentionKind, number>();
  for (const entry of entries) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  return (
    <div
      style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        padding: "5px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 20 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", flexShrink: 0 }}>
          待处理{entries.length > 0 ? ` ${entries.length}` : ""}
        </span>
        {KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => (
          <span
            key={kind}
            title={KIND_LABELS[kind]}
            style={{
              padding: "1px 8px",
              borderRadius: 999,
              border: `1px solid color-mix(in srgb, ${KIND_COLORS[kind]} 40%, var(--border))`,
              color: KIND_COLORS[kind],
              fontSize: 10.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {KIND_LABELS[kind]} {counts.get(kind)}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        {entries.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            style={{
              border: 0,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 4px",
              flexShrink: 0,
            }}
          >
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </div>
      {expanded && entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {entries.map((entry) => (
            <button
              key={`${entry.key}:${entry.kind}`}
              type="button"
              role="listitem"
              data-key={entry.key}
              title={entry.detail}
              onClick={() => onSelectItem(entry.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "4px 2px",
                border: 0,
                borderTop: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11.5,
                textAlign: "left",
                minHeight: 24,
              }}
            >
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", flexShrink: 0 }}>
                {entry.key}
              </code>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                {entry.title}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>已 {entry.ageDays} 天</span>
              {entry.nudged && (
                <span style={{ padding: "0 6px", borderRadius: 999, border: "1px solid var(--border)", color: "#b45309", fontSize: 10, flexShrink: 0 }}>
                  已催办
                </span>
              )}
              {entry.parked && (
                <span style={{ padding: "0 6px", borderRadius: 999, border: "1px solid color-mix(in srgb, #dc2626 40%, var(--border))", color: "#dc2626", fontSize: 10, flexShrink: 0 }}>
                  已泊车
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>待处理队列加载失败：{error}</div>
      )}
    </div>
  );
}

/** 取数包装：挂载 + refreshToken 变化时重取（宿主传快照 fetchedAt = 复用 5s
 *  节拍）；切工作区/重取竞窗用 cancelled 守卫。失败只记提示，不清空旧条目。 */
export function AttentionBar({
  workspaceId,
  onSelectItem,
  refreshToken,
}: {
  workspaceId: string;
  onSelectItem: (key: string) => void;
  /** 变化即重取的信号（宿主的快照 fetchedAt——值比较进 effect 依赖）。 */
  refreshToken?: unknown;
}) {
  const [entries, setEntries] = useState<AttentionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/attention`);
        const data = (await response.json().catch(() => ({}))) as {
          entries?: AttentionEntry[];
          error?: string;
        };
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

  return <AttentionBarView entries={entries} error={error} onSelectItem={onSelectItem} />;
}
