"use client";

import type { WorkItemEvent } from "@/lib/work-items/types";

/** 事件时间线（从 WorkspaceManager 抽出的共用件，M2 T9）：inline-style 渲染
 *  （两处宿主——WorkspaceManager 面板与中央页详情——样式系统不同，inline 在两
 *  处都成立）。事件行的三列 grid（时间 / 内容 / 会话按钮）与原 CSS 版同构；
 *  除 summary 外还展示 delivery.* 事件的 reason/version（审计可读性）。 */

export function formatEventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const actionButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  minHeight: 26,
  padding: "0 9px",
  font: "inherit",
  fontSize: 11.5,
  whiteSpace: "nowrap",
};

export function WorkItemEvents({
  events,
  onOpenConversation,
  headerActions,
  title = "审计历史",
}: {
  events: WorkItemEvent[];
  /** 每条带 conversationId 的事件渲染「查看会话」（locate 打开，含已归档轮会话）。 */
  onOpenConversation?: (sessionId: string) => void;
  /** 右端动作区（宿主注入，如 WorkspaceManager 的「移到回收站」）。 */
  headerActions?: React.ReactNode;
  title?: string;
}) {
  return (
    <section style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{title}</h3>
        {headerActions}
      </div>
      {events.map((event) => {
        const data = event.data as Record<string, unknown> | undefined;
        const detail = typeof data?.summary === "string" && data.summary
          ? data.summary
          : typeof data?.reason === "string" && data.reason
            ? `原因：${data.reason}`
            : typeof data?.version === "string" && data.version
              ? `版本：${data.version}`
              : null;
        return (
          <div
            key={event.id}
            style={{
              display: "grid",
              gridTemplateColumns: "108px minmax(0, 1fr) auto",
              gap: 10,
              padding: "8px 0",
              borderBottom: "1px solid var(--border)",
              fontSize: 11,
              alignItems: "start",
            }}
          >
            <time style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatEventDate(event.at)}</time>
            <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <strong>{event.type}</strong>
              <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>{event.actor}</span>
              {detail && <div style={{ color: "var(--text-muted)", marginTop: 3 }}>{detail}</div>}
            </div>
            {onOpenConversation && event.conversationId && (
              <button
                type="button"
                style={actionButtonStyle}
                onClick={() => onOpenConversation(event.conversationId as string)}
                title={`打开产生此事件的会话查看完整消息（${event.conversationId}）`}
              >
                查看会话
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
