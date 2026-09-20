"use client";

import { useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { WorkspaceSessionGroup } from "@/lib/home-quick-switch";
import { SessionRow } from "./SessionRow";

/**
 * 全局会话分组列表（按工作区分组，每组列出该工作区全部会话，组内按修改
 * 时间降序，分组按组内最新会话活跃度降序——排序由 lib/home-quick-switch 的
 * groupSessionsByWorkspace 负责）。宿主（2026-09 全局左栏 + 方案 A 后）：桌面
 * 中栏的会话面板（工作台与首页同体，WorkspaceSidebar）+ 移动端首页
 * （HomeLanding 最近区，即移动端唯一的全局跨工作区列表——工作区 tab 落地
 * 总览，本工作区会话在总览「会话」区块）。
 *
 * 交互：
 * - 组头 = 工作区名 + 会话总数，点击 = 打开该工作区；
 * - 组头右侧 chevron 折叠/展开该组（默认全展开，状态不持久化）；
 * - 会话行 = 共享 SessionRow（运行/完成徽章 + 相对时间 + Cmd/中键新 tab
 *   + 行内归档——原「切换器无管理操作」契约随全局左栏升级作废）；
 *   点击 = C1 分派（当前 tab 变身；首页/家 tab 上=开新 tab；Cmd/中键=新 tab）。
 */
interface Props {
  groups: WorkspaceSessionGroup[];
  runningSessionIds: Set<string>;
  /** 完成未读徽章（useSessionActivity.completedIds）；不传则不显示。 */
  completedSessionIds?: Set<string>;
  selectedSessionId?: string | null;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onSelectSession: (session: SessionInfo) => void;
  /** C1 并行手势：Cmd/Ctrl-点击、中键（桌面传入；移动端首页不传；无可见按钮）。 */
  onOpenSessionInNewTab?: (session: SessionInfo) => void;
  /** 行内归档后回调（shell 从 allSessions 移除）。 */
  onSessionRemoved?: (id: string) => void;
}

export function HomeSessionGroups({
  groups,
  runningSessionIds,
  completedSessionIds,
  selectedSessionId,
  onSelectWorkspace,
  onSelectSession,
  onOpenSessionInNewTab,
  onSessionRemoved,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (groups.length === 0) {
    return (
      <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
        尚无工作区。
      </div>
    );
  }

  return (
    <div>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.workspace.id);
        return (
          <section key={group.workspace.id} style={{ marginBottom: 10 }}>
            {/* Group header: click = open workspace; chevron = collapse (separate button) */}
            <div style={{ display: "flex", alignItems: "stretch", gap: 2 }}>
              <button
                onClick={() => onSelectWorkspace(group.workspace)}
                title={`打开工作区 ${group.workspace.name}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  border: 0,
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <strong style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {group.workspace.name}
                </strong>
                <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}>
                  {group.sessions.length}
                </span>
              </button>
              <button
                aria-label={isCollapsed ? "展开" : "折叠"}
                onClick={() => toggle(group.workspace.id)}
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  border: 0,
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.12s" }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>

            {!isCollapsed && (
              group.sessions.length === 0 ? (
                <div style={{ padding: "5px 10px 5px 30px", color: "var(--text-dim)", fontSize: 11 }}>
                  暂无会话
                </div>
              ) : (
                group.sessions.map((session) => {
                  const activity = runningSessionIds.has(session.id)
                    ? "running"
                    : completedSessionIds?.has(session.id)
                      ? "completed"
                      : undefined;
                  return (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isSelected={selectedSessionId === session.id}
                      activity={activity}
                      showTime
                      onSelect={() => onSelectSession(session)}
                      onOpenInNewTab={onOpenSessionInNewTab ? () => onOpenSessionInNewTab(session) : undefined}
                      onRemoved={onSessionRemoved}
                    />
                  );
                })
              )
            )}
          </section>
        );
      })}
    </div>
  );
}
