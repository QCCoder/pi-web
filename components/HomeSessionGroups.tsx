"use client";

import { useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import { formatRelativeTime } from "@/lib/format-time";
import type { WorkspaceSessionGroup } from "@/lib/home-quick-switch";

/**
 * 首页快速切换列表：按工作区分组，每组列出该工作区全部会话（组内按修改
 * 时间降序，分组按组内最新会话活跃度降序——排序由 lib/home-quick-switch 的
 * groupSessionsByWorkspace 负责）。两个宿主共用：桌面首页的中栏面板
 * （WorkspaceSidebar home 分支）与移动端首页的「最近会话」区（HomeLanding）。
 *
 * 交互（grill 共识）：
 * - 组头 = 工作区名 + 会话总数，点击 = 打开该工作区；
 * - 组头右侧 chevron 折叠/展开该组（默认全展开，状态不持久化）；
 * - 会话行 = 运行中呼吸点 + 名称/首条消息 + 相对时间，点击 = 直达会话；
 * - 无行内管理操作——本组件是切换器，不是管理器。
 */
interface Props {
  groups: WorkspaceSessionGroup[];
  runningSessionIds: Set<string>;
  selectedSessionId?: string | null;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onSelectSession: (session: SessionInfo) => void;
}

export function HomeSessionGroups({
  groups,
  runningSessionIds,
  selectedSessionId,
  onSelectWorkspace,
  onSelectSession,
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
                  const running = runningSessionIds.has(session.id);
                  const selected = selectedSessionId === session.id;
                  return (
                    <button
                      key={session.id}
                      onClick={() => onSelectSession(session)}
                      title={session.name || session.firstMessage || "未命名会话"}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "6px 10px 6px 30px",
                        border: 0,
                        borderRadius: 8,
                        background: selected ? "var(--bg-selected)" : "transparent",
                        color: selected ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                      }}
                      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                    >
                      {running && (
                        <span
                          aria-label="运行中"
                          style={{
                            flexShrink: 0,
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: "var(--accent)",
                            animation: "pulse 1.6s ease-in-out infinite",
                          }}
                        />
                      )}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {session.name || session.firstMessage || "未命名会话"}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                        {formatRelativeTime(session.modified)}
                      </span>
                    </button>
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
