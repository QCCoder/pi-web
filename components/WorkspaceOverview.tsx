"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkItemRecord, WorkItemType } from "@/lib/work-items/types";
import type { WorkspaceRepositoryState, WorkspaceSummary } from "@/lib/workspaces/types";
import { summarizeCron } from "@/lib/loops/cron-summary";
import { STATUS_LABELS } from "./WorkspaceManager";
import { useIsMobile } from "@/hooks/useIsMobile";

interface Props {
  workspace: WorkspaceSummary;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenWorkItems: () => void;
  onCreateWorkItem: (type: WorkItemType) => void;
  onSelectSession: (session: SessionInfo) => void;
  /** Navigate the sidebar's focused Activity Bar view (仓库 rows → 工作台文件区, 知识库 row). */
  onSwitchSidebarView: (view: "workbench" | "knowledge") => void;
  /** Open the workspace settings' add-repository form (AppShell wires it). */
  onAddRepository: () => void;
  onSessionDeleted?: (id: string) => void;
}

/** Loop 行（GET /api/workspaces/:id/loops —— pi-loop/status.ts 的 LoopStatusEntry）。 */
interface LoopRow {
  name: string;
  pattern: string;
  level: string;
  cron: string;
  timezone: string;
  maxMinutes: number;
  paused: boolean;
  running: boolean;
  lastRun?: string;
  nextDue?: string;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "刚刚"; // clock skew / future
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString();
}

function formatLoopClock(iso: string): string {
  const date = new Date(iso);
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

const sectionStyle: React.CSSProperties = { marginTop: 26 };

const sectionHeaderStyle: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 15,
  color: "var(--text)",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const sectionHeaderLinkStyle: React.CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--accent)",
  cursor: "pointer",
  padding: 0,
  fontSize: 12,
  fontWeight: 500,
};

const cardRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  marginBottom: 8,
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  transition: "background 0.12s",
};

const emptyHintStyle: React.CSSProperties = {
  padding: "22px 16px",
  textAlign: "center",
  color: "var(--text-dim)",
  fontSize: 13,
  border: "1px dashed var(--border)",
  borderRadius: 10,
};

export function WorkspaceOverview({
  workspace,
  onNewSession,
  onOpenSettings,
  onOpenWorkItems,
  onCreateWorkItem,
  onSelectSession,
  onSwitchSidebarView,
  onAddRepository,
  onSessionDeleted,
}: Props) {
  const isMobile = useIsMobile();
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [repositories, setRepositories] = useState<WorkspaceRepositoryState[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loops, setLoops] = useState<LoopRow[]>([]);
  const [loopsBusy, setLoopsBusy] = useState(false);
  const [editingLoop, setEditingLoop] = useState<LoopRow | null>(null);
  const [loopForm, setLoopForm] = useState({ cron: "", timezone: "", level: "L1", maxMinutes: 30 });
  const [loopError, setLoopError] = useState<string | null>(null);

  const refreshLoops = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/loops`);
      if (!response.ok) return;
      const data = (await response.json()) as { loops?: LoopRow[] };
      setLoops(data.loops ?? []);
    } catch { /* offline — keep last */ }
  }, [workspace.id]);

  useEffect(() => { void refreshLoops(); }, [refreshLoops]);

  const loopAction = useCallback(async (name: string, action: "pause" | "resume" | "stop") => {
    if (action === "stop" && !window.confirm("终止本轮进程？未完成的工作由下轮补跑。")) return;
    setLoopsBusy(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(name)}/${action}`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        window.alert(body.error || `操作失败（HTTP ${response.status}）`);
      }
      await refreshLoops();
    } finally {
      setLoopsBusy(false);
    }
  }, [refreshLoops, workspace.id]);

  const saveLoopEdit = useCallback(async () => {
    if (!editingLoop) return;
    setLoopsBusy(true);
    setLoopError(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/loops/${encodeURIComponent(editingLoop.name)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cron: loopForm.cron,
            timezone: loopForm.timezone,
            level: loopForm.level,
            max_minutes: Number(loopForm.maxMinutes),
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setLoopError(body.error || `保存失败（HTTP ${response.status}）`);
        return;
      }
      setEditingLoop(null);
      await refreshLoops();
    } finally {
      setLoopsBusy(false);
    }
  }, [editingLoop, loopForm, refreshLoops, workspace.id]);

  const hasWorkItems = workspace.capabilities.includes("work-items");
  const hasRepositories = workspace.capabilities.includes("repositories");
  const hasKnowledge = workspace.capabilities.includes("knowledge");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      hasWorkItems
        ? fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/work-items`, {
          signal: controller.signal,
        })
        : null,
      hasRepositories || hasKnowledge
        ? fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/repositories`, {
          signal: controller.signal,
        })
        : null,
      fetch("/api/sessions", { signal: controller.signal }),
    ]).then(async ([itemsResponse, repositoriesResponse, sessionsResponse]) => {
      if (itemsResponse?.ok) {
        const data = await itemsResponse.json() as { items?: WorkItemRecord[] };
        setWorkItems(data.items ?? []);
      }
      if (repositoriesResponse?.ok) {
        const data = await repositoriesResponse.json() as {
          repositories?: WorkspaceRepositoryState[];
        };
        setRepositories(data.repositories ?? []);
      }
      if (sessionsResponse.ok) {
        const data = await sessionsResponse.json() as { sessions?: SessionInfo[] };
        setSessions(data.sessions ?? []);
      }
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("Failed to load workspace overview:", error);
      }
    });
    return () => controller.abort();
  }, [workspace.id, hasWorkItems, hasRepositories, hasKnowledge]);

  const wsPath = workspace.path.replace(/\/+$/, "");
  const recentSessions = useMemo(() => {
    const path = workspace.path;
    const prefix = `${wsPath}/`;
    return sessions
      .filter((session) =>
        !session.subagentChild
        && (
          session.cwd === path
          || session.cwd.startsWith(prefix)
          || session.projectRoot === path
        ),
      )
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, 5);
  }, [sessions, wsPath, workspace.path]);

  // 活跃工作项：非终态（status 非 done/cancelled、未归档），按 updatedAt 倒序取前 5。
  const activeWorkItems = useMemo(
    () => workItems
      .filter((item) =>
        !item.archivedAt
        && item.status !== "done"
        && item.status !== "cancelled")
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
      .slice(0, 5),
    [workItems],
  );

  const activeCodeRepositories = useMemo(
    () => repositories.filter((repository) =>
      repository.kind === "code" && repository.status === "active"),
    [repositories],
  );
  const knowledgeBundleCount = useMemo(
    () => repositories.filter((repository) =>
      repository.kind === "knowledge" && repository.status === "active").length,
    [repositories],
  );

  return (
    <main
      aria-label={`${workspace.name} overview`}
      style={{ height: "100%", overflow: "auto", padding: "clamp(20px, 4vw, 48px)" }}
    >
      <div style={{ width: "min(860px, 100%)", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ color: "var(--text-dim)", fontSize: 10, letterSpacing: "0.08em" }}>WORKSPACE</div>
            <h1 style={{ margin: "6px 0 4px", fontSize: 24, color: "var(--text)" }}>{workspace.name}</h1>
            <code style={{ color: "var(--text-muted)", fontSize: 11 }}>{workspace.path}</code>
          </div>
          <button className="workspace-action" onClick={onOpenSettings}>工作区设置</button>
        </div>

        {/* Quick actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
          <button
            onClick={onNewSession}
            style={{
              flex: "1 1 160px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "13px 16px",
              border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
              borderRadius: 10,
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              color: "var(--accent)",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建会话
          </button>
          {hasWorkItems && (
            <button
              onClick={() => onCreateWorkItem("requirement")}
              style={{
                flex: "0 1 auto",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "13px 16px",
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              新建工作项
            </button>
          )}
        </div>

        {/* Active work items */}
        {hasWorkItems && (
          <section style={sectionStyle}>
            <h2 style={{ ...sectionHeaderStyle, margin: "0 0 10px" }}>
              活跃工作项
              <span style={{ color: "var(--text-dim)", fontSize: 12, fontWeight: 400 }}>{activeWorkItems.length}</span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => onCreateWorkItem("requirement")}
                style={{
                  ...sectionHeaderLinkStyle,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "2px 8px",
                }}
              >
                ＋ 新建工作项
              </button>
            </h2>
            {activeWorkItems.length === 0 ? (
              <div style={emptyHintStyle}>暂无活跃工作项</div>
            ) : (
              activeWorkItems.map((item) => (
                <button
                  key={item.id}
                  onClick={onOpenWorkItems}
                  title={`${item.key} ${item.title}`}
                  style={cardRowStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                    }}
                  >
                    {item.key}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 13,
                    }}
                  >
                    {item.title}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {STATUS_LABELS[item.status]}
                  </span>
                </button>
              ))
            )}
          </section>
        )}

        {/* Repositories / knowledge */}
        {(hasRepositories || hasKnowledge) && (
          <section style={sectionStyle}>
            <h2 style={{ ...sectionHeaderStyle, margin: "0 0 10px", display: "flex", alignItems: "baseline", gap: 10 }}>
              <span>仓库 / 知识库</span>
              {hasRepositories && (
                <button onClick={onAddRepository} style={sectionHeaderLinkStyle}>＋ 添加仓库</button>
              )}
            </h2>
            {hasRepositories && activeCodeRepositories.length === 0 && !hasKnowledge && (
              <div style={emptyHintStyle}>暂无代码仓库</div>
            )}
            {hasRepositories && activeCodeRepositories.map((repository) => (
              <button
                key={repository.id}
                onClick={() => onSwitchSidebarView("workbench")}
                title="在工作台文件区中浏览"
                style={cardRowStyle}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    maxWidth: 220,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                  }}
                >
                  {repository.name}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {repository.branch || "—"}
                  {repository.dirty && (
                    <span
                      title="有未提交改动"
                      aria-label="有未提交改动"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "#d6a84b",
                        display: "inline-block",
                      }}
                    />
                  )}
                </span>
              </button>
            ))}
            {hasKnowledge && (
              <button
                onClick={() => onSwitchSidebarView("knowledge")}
                title="在侧边栏知识库视图中查看"
                style={cardRowStyle}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
              >
                <span style={{ flexShrink: 0, fontSize: 13 }}>知识库</span>
                <span style={{ flex: 1 }} />
                <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}>
                  {knowledgeBundleCount > 0 ? `${knowledgeBundleCount} 个知识库` : "尚未配置"}
                </span>
              </button>
            )}
          </section>
        )}

        {/* Loops 管理（spec §5.3：状态总览 / 暂停恢复 / frontmatter 编辑 / 停止本轮；有 loop 才渲染） */}
        {loops.length > 0 && (
          <section style={sectionStyle}>
            <h2 style={{ ...sectionHeaderStyle, margin: "0 0 10px" }}>Loops</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {loops.map((loop) => (
                <div
                  key={loop.name}
                  style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8 }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{loop.name}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {summarizeCron(loop.cron) ?? loop.cron}
                  </span>
                  <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--bg-hover)" }}>{loop.level}</span>
                  <span style={{ fontSize: 12, color: loop.running ? "#15803d" : loop.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
                    {loop.running
                      ? "● 运行中"
                      : loop.paused
                        ? "已暂停"
                        : loop.nextDue
                          ? (new Date(loop.nextDue).getTime() > Date.now()
                              ? `下次 ${formatLoopClock(loop.nextDue)}`
                              : "已到期 · 待心跳")
                          : "空闲"}
                  </span>
                  <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                    <button
                      disabled={loopsBusy}
                      onClick={() => void loopAction(loop.name, loop.paused ? "resume" : "pause")}
                      style={sectionHeaderLinkStyle}
                    >
                      {loop.paused ? "恢复" : "暂停"}
                    </button>
                    <button
                      disabled={loopsBusy}
                      onClick={() => {
                        setEditingLoop(loop);
                        setLoopForm({ cron: loop.cron, timezone: loop.timezone, level: loop.level, maxMinutes: loop.maxMinutes });
                        setLoopError(null);
                      }}
                      style={sectionHeaderLinkStyle}
                    >
                      编辑
                    </button>
                    {loop.running && (
                      <button disabled={loopsBusy} onClick={() => void loopAction(loop.name, "stop")} style={sectionHeaderLinkStyle}>
                        停止
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {editingLoop && (
              <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--border)", borderRadius: 8, display: "grid", gap: 8, maxWidth: 420 }}>
                <strong style={{ fontSize: 13 }}>编辑 {editingLoop.name}</strong>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  cron
                  <input value={loopForm.cron} onChange={(e) => setLoopForm({ ...loopForm, cron: e.target.value })} style={{ fontFamily: "var(--font-mono)" }} />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  timezone
                  <input value={loopForm.timezone} onChange={(e) => setLoopForm({ ...loopForm, timezone: e.target.value })} />
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  level
                  <select value={loopForm.level} onChange={(e) => setLoopForm({ ...loopForm, level: e.target.value })}>
                    <option value="L1">L1</option>
                    <option value="L2">L2</option>
                    <option value="L3">L3</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                  max_minutes
                  <input type="number" min={1} value={loopForm.maxMinutes} onChange={(e) => setLoopForm({ ...loopForm, maxMinutes: Number(e.target.value) })} />
                </label>
                {loopError && <div style={{ color: "#b91c1c", fontSize: 12 }}>{loopError}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={loopsBusy} onClick={() => void saveLoopEdit()}>保存</button>
                  <button disabled={loopsBusy} onClick={() => setEditingLoop(null)}>取消</button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Recent sessions */}
        <section style={sectionStyle}>
          <h2 style={{ ...sectionHeaderStyle, margin: "0 0 12px" }}>最近会话</h2>
          {recentSessions.length === 0 ? (
            <div style={emptyHintStyle}>
              还没有会话。点击上方「新建会话」开始。
            </div>
          ) : (
            <div>
              {recentSessions.map((session) => (
                <RecentSessionRow
                  key={session.id}
                  session={session}
                  isMobile={isMobile}
                  onOpen={() => onSelectSession(session)}
                  onRemoved={(id) => setSessions((prev) => prev.filter((item) => item.id !== id))}
                  onDeleted={onSessionDeleted}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function RecentSessionRow({
  session,
  isMobile,
  onOpen,
  onRemoved,
  onDeleted,
}: {
  session: SessionInfo;
  isMobile: boolean;
  onOpen: () => void;
  onRemoved: (id: string) => void;
  onDeleted?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const title = session.name || session.firstMessage || "未命名会话";

  const performDelete = async () => {
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        onRemoved(session.id);
        onDeleted?.(session.id);
      }
    } catch {
      // ignore network errors — row stays, user can retry
    }
    setDeleting(false);
    setConfirming(false);
  };

  const showDelete = isMobile || hovered || confirming;

  return (
    <div
      role="button"
      tabIndex={confirming ? -1 : 0}
      onClick={confirming ? undefined : onOpen}
      onKeyDown={(e) => {
        if (!confirming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 12px",
        marginBottom: 8,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: hovered && !confirming ? "var(--bg-hover)" : "var(--bg-panel)",
        cursor: confirming ? "default" : "pointer",
        transition: "background 0.12s",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 13,
          color: "var(--text)",
        }}
      >
        {title}
      </span>

      {confirming ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>确认删除？</span>
          <button
            onClick={performDelete}
            disabled={deleting}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              border: "1px solid rgba(239,68,68,0.4)",
              borderRadius: 6,
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            删除
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={deleting}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {formatRelativeTime(session.modified)} · {session.messageCount} 条
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            aria-label="删除会话"
            title="删除会话"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              flexShrink: 0,
              border: "none",
              borderRadius: 7,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              opacity: showDelete ? 1 : 0,
              transition: "opacity 0.12s, color 0.12s",
              pointerEvents: showDelete ? "auto" : "none",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
