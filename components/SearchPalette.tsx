"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { SessionInfo } from "@/lib/types";
import type { SessionSearchResponse } from "@/lib/session-search";
import type { CenterPage } from "./shell/useAppShellState";

/**
 * 搜索弹框（2026-09 用户反馈「搜索我也想可以做个弹框」，ZCode 命令面板同款）。
 * 结构：
 *
 *   ┌──────────────────────────────────┐
 *   │ 🔍 搜索任务或操作…               │  ← 大输入框（autofocus）
 *   │ [≔ 全部] [💬 任务] [⚡ 操作]      │  ← 分类 chips（全部=两节都出）
 *   │ ────────────────────────────────│
 *   │ 最近任务 / 任务                  │  ← 有词走 /api/sessions/search 全文
 *   │   · 会话行            相对时间   │    检索（300ms 防抖），命中行带片段
 *   │ 建议 / 操作                      │    预览，点击深跳转具体消息
 *   │   ⨂ 新建任务            ⌘N      │
 *   │   ⚙ 设置 …                      │
 *   └──────────────────────────────────┘
 *
 * 键盘：↑↓ 移动高亮（悬停同步）、Enter 确认、Esc 关闭；⌘K 由 ProjectSidebar
 * 的全局开关承担（开/关）。body-portal 渲染，点遮罩关闭。
 */

type Scope = "all" | "tasks" | "actions";

interface PaletteAction {
  id: string;
  label: string;
  /** 关键词（小写匹配用），含 label 本身。 */
  keywords: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

type PaletteItem =
  | { key: string; kind: "task"; session: SessionInfo; entryId?: string; blockIndex?: number }
  | { key: string; kind: "action"; action: PaletteAction };

interface Props {
  open: boolean;
  onClose: () => void;
  allSessions: SessionInfo[];
  selectedSessionId: string | null;
  /** 会话列表版本（跨窗口同步）：变化时让进行中的搜索重新执行。 */
  refreshKey: number | null;
  /** 命中行选择：打开会话并（带 entryId/blockIndex 时）深跳转到具体消息。 */
  onSelectSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  onNewSession: () => void;
  onCreateWorkspace: () => void;
  onImportDirectory: () => void;
  onOpenCenterPage: (page: CenterPage) => void;
}

const RECENT_COUNT = 6;

export function SearchPalette({
  open,
  onClose,
  allSessions,
  selectedSessionId,
  refreshKey,
  onSelectSession,
  onNewSession,
  onCreateWorkspace,
  onImportDirectory,
  onOpenCenterPage,
}: Props) {
  const { t, locale } = useI18n();
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();

  // 全文检索（SessionSearch 同款语义）：有词才发请求；resp.query 与当前词一致
  // 才展示（防旧响应回放）。
  const [resp, setResp] = useState<{ query: string; data?: SessionSearchResponse; failed?: boolean }>({ query: "" });
  useEffect(() => {
    if (!open || !search) {
      setResp({ query: "" });
      return;
    }
    const controller = new AbortController();
    setResp({ query: search });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sessions/search?${new URLSearchParams({ q: search })}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as SessionSearchResponse;
        if (!controller.signal.aborted) setResp({ query: search, data });
      } catch {
        if (!controller.signal.aborted) setResp({ query: search, failed: true });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, refreshKey]);

  const actions = useMemo<PaletteAction[]>(() => [
    {
      id: "new-task",
      label: "新建任务",
      keywords: "新建任务 新会话 new task",
      hint: "⌘N",
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8" /><path d="M8 12h8" />
        </svg>
      ),
      run: onNewSession,
    },
    {
      id: "create-workspace",
      label: "新建工作区…",
      keywords: "新建工作区 创建 项目 workspace",
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 10v6" /><path d="M9 13h6" />
        </svg>
      ),
      run: onCreateWorkspace,
    },
    {
      id: "import-directory",
      label: "导入目录…",
      keywords: "导入目录 文件夹 import",
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 16v-6" /><path d="m9 13 3 3 3-3" />
        </svg>
      ),
      run: onImportDirectory,
    },
    {
      id: "settings",
      label: "设置",
      keywords: "设置 preferences settings 配置",
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      run: () => onOpenCenterPage({ kind: "settings" }),
    },
    {
      id: "plugins-skills",
      label: "插件&技能",
      keywords: "插件 技能 skills plugins 配置",
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13 3v2a1 1 0 0 1-1 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 1 1-1h2" />
          <path d="M17 3h4v4" /><path d="M13 7l8-4" />
        </svg>
      ),
      run: () => onOpenCenterPage({ kind: "settings", section: "plugins" }),
    },
  ], [onNewSession, onCreateWorkspace, onImportDirectory, onOpenCenterPage]);

  // ---- 列表构建 -------------------------------------------------------------
  const searchResponse = resp.query === search && search ? resp.data : undefined;
  const searchFailed = resp.query === search && search ? resp.failed : false;
  const searchPending = Boolean(search) && !searchResponse && !searchFailed;

  const sections = useMemo(() => {
    const showTasks = scope !== "actions";
    const showActions = scope !== "tasks";
    const out: { id: string; title: string; items: PaletteItem[] }[] = [];
    if (!search) {
      if (showTasks) {
        const recent = [...allSessions]
          .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
          .slice(0, RECENT_COUNT)
          .map((session): PaletteItem => ({ key: `recent:${session.id}`, kind: "task", session }));
        out.push({ id: "recent", title: "最近任务", items: recent });
      }
      if (showActions) {
        out.push({ id: "suggest", title: "建议", items: actions.map((action): PaletteItem => ({ key: `act:${action.id}`, kind: "action", action })) });
      }
      return out;
    }
    if (showTasks && searchResponse) {
      out.push({
        id: "tasks",
        title: "任务",
        items: searchResponse.results.map(({ session, entryId, blockIndex }): PaletteItem => ({
          key: `hit:${session.id}:${entryId ?? ""}:${blockIndex ?? ""}`,
          kind: "task",
          session,
          entryId,
          blockIndex,
        })),
      });
    }
    if (showActions) {
      const hits = actions.filter((action) =>
        `${action.label} ${action.keywords}`.toLowerCase().includes(search));
      out.push({ id: "actions", title: "操作", items: hits.map((action): PaletteItem => ({ key: `act:${action.id}`, kind: "action", action })) });
    }
    return out;
  }, [scope, search, allSessions, actions, searchResponse]);

  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => { setActiveIndex(0); }, [query, scope, searchResponse]);
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(items.length ? items.length - 1 : 0);
  }, [items, activeIndex]);

  const activate = (item: PaletteItem) => {
    onClose();
    if (item.kind === "task") onSelectSession(item.session, item.entryId, item.blockIndex);
    else item.action.run();
  };

  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [activeIndex]);

  if (!open) return null;

  const handleInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length) setActiveIndex((index) => (index + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) setActiveIndex((index) => (index - 1 + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) activate(item);
    }
  };

  const renderTaskRow = (item: PaletteItem & { kind: "task" }, active: boolean) => {
    const { session } = item;
    return (
      <>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: active ? "var(--accent)" : "var(--text-dim)" }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
          {session.name || session.firstMessage || "（无标题会话）"}
        </span>
        <span style={{ flexShrink: 0, fontSize: 11.5, color: "var(--text-dim)" }}>
          {formatRelativeTime(session.modified, locale)}
        </span>
      </>
    );
  };

  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 2600, background: "rgba(0,0,0,0.42)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.toggleSessionSearch")}
        style={{
          position: "fixed",
          top: "10vh",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2601,
          width: "min(620px, calc(100vw - 32px))",
          maxHeight: "72vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        {/* 输入行 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            id="pi-search-palette-input"
            type="search"
            autoFocus
            value={query}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder="搜索任务或操作…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            style={{
              flex: 1,
              minWidth: 0,
              height: 30,
              border: 0,
              background: "transparent",
              color: "var(--text)",
              fontSize: 15,
              outline: "none",
            }}
          />
          <kbd style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 5, border: "1px solid var(--border)", fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>
            Esc
          </kbd>
        </div>

        {/* 分类 chips */}
        <div role="tablist" aria-label="搜索分类" style={{ display: "flex", gap: 6, padding: "8px 12px", flexShrink: 0 }}>
          {([
            { id: "all", label: "全部", icon: <path d="M8 6h13M8 12h13M8 18h13" /> },
            { id: "tasks", label: "任务", icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /> },
            { id: "actions", label: "操作", icon: <path d="M13 2 3 14h7l-1 8 10-12h-7z" /> },
          ] as { id: Scope; label: string; icon: React.ReactNode }[]).map((tab) => {
            const active = scope === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setScope(tab.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  border: 0,
                  borderRadius: 999,
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {tab.icon}
                </svg>
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* 列表 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
          {sections.map((section) => (
            <section key={section.id}>
              {section.items.length > 0 && (
                <div style={{ padding: "10px 16px 4px", fontSize: 11, fontWeight: 700, color: "var(--text-dim)", userSelect: "none" }}>
                  {section.title}
                </div>
              )}
              {section.items.map((item) => {
                const index = items.indexOf(item);
                const active = index === activeIndex;
                return (
                  <button
                    key={item.key}
                    type="button"
                    ref={active ? activeRef : undefined}
                    aria-current={item.kind === "task" && item.session.id === selectedSessionId ? "true" : undefined}
                    onClick={() => activate(item)}
                    onMouseEnter={() => setActiveIndex(index)}
                    title={item.kind === "task" ? item.session.cwd : item.action.label}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 16px",
                      border: 0,
                      background: active ? "var(--bg-hover)" : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {item.kind === "task" ? renderTaskRow(item, active) : (
                      <>
                        <span style={{ display: "flex", flexShrink: 0, color: active ? "var(--accent)" : "var(--text-muted)" }}>{item.action.icon}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                          {item.action.label}
                        </span>
                        {item.action.hint && (
                          <kbd style={{ flexShrink: 0, padding: "2px 6px", borderRadius: 5, border: "1px solid var(--border)", fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>
                            {item.action.hint}
                          </kbd>
                        )}
                      </>
                    )}
                  </button>
                );
              })}
            </section>
          ))}

          {/* 状态行：搜索中 / 失败 / 无匹配 */}
          {searchPending && (
            <div role="status" style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-muted)" }}>
              {t("sidebar.sessionSearching")}
            </div>
          )}
          {searchFailed && (
            <div role="status" style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-muted)" }}>
              {t("sidebar.sessionSearchFailed")}
            </div>
          )}
          {!searchPending && !searchFailed && search && searchResponse && searchResponse.truncated && (
            <div role="status" style={{ padding: "8px 16px", fontSize: 11.5, color: "var(--text-dim)" }}>
              {t("sidebar.sessionSearchPartial")}
            </div>
          )}
          {items.length === 0 && !searchPending && !searchFailed && (
            <div role="status" style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-muted)" }}>
              {search ? t("sidebar.sessionSearchEmpty") : "暂无任务——⌘N 新建一个。"}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
