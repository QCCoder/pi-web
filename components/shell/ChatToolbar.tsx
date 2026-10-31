"use client";

import { useCallback } from "react";
import { BranchNavigator } from "../BranchNavigator";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useShell } from "./context";
import { computeCacheHitRatePercent } from "@/lib/session-stats";

type SessionCopyField = "file" | "id";

const TOP_BAR_ICON_BUTTON_SIZE = 36;

export type ToolbarNavToggle = "sidebar" | "hidden";

/** A row of the mobile ⋯ overflow menu（全局组 + 会话组）。44px 触控行高。 */
function MoreMenuRow({ icon, label, onClick, disabled = false, testColor, hint, hintColor }: {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  testColor?: string;
  /** 行尾摘要（如 会话信息 行的上下文用量「42% / 200k」），可带状态色。 */
  hint?: React.ReactNode;
  hintColor?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        width: "100%", minHeight: 40, padding: "0 10px",
        border: "none", borderRadius: 6,
        background: "transparent",
        color: disabled ? "var(--text-dim)" : testColor ?? "var(--text)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 13, textAlign: "left", whiteSpace: "nowrap",
        opacity: disabled ? 0.55 : 1,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ display: "flex", alignItems: "center", flexShrink: 0, opacity: 0.85 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span style={{ fontSize: 11.5, color: hintColor ?? "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {hint}
        </span>
      )}
    </button>
  );
}

/**
 * The tool strip — theme / language / (chat-scoped) history, auto-name,
 * branch navigator, system prompt, token usage — plus the shared dropdown
 * panels (branches / system / session info / language menu / mobile ⋯ menu)
 * anchored to it.
 *
 * Rendered by all three shells: desktop puts it at the top of its center
 * column (36px); the tablet shell (MobileShell, ≥768px) and the phone shell
 * (MobileTabShell, <768px) at the top of the screen (44px touch height). The
 * leading slot comes from two props: `navToggle` — "sidebar" (default —
 * desktop tree collapse) or "hidden" (tablet: the tree is permanent, nothing
 * to toggle) — and `onBack` (phone chat page: ‹ back to the session list;
 * when set it takes the leading slot and `navToggle` is ignored).
 *
 * Mobile (2026-09 重排 → 2026-10 底部 tab 改版，knowledge/designs/mobile-drawer-design.md
 * 文末补充记录)：定位优先 —— `‹ | 会话标题（居中，纯标签）| ⋯`。
 * 会话信息（行尾带上下文用量）/主题/语言/完整历史/自动命名/分支/系统提示词全部收进 ⋯ 菜单；
 * 统计按钮只在桌面/平板顶栏
 * （全局组 + 会话组分隔），分支面板由隐藏触发钮的 BranchNavigator 承载。
 * 旧 ☰ 抽屉开关与后台状态圆点随抽屉退役一并删除——后台活动改由会话首页的
 * 行级运行/完成徽章承载。
 */
/** 手机聊天页 ⋯ 菜单的「工作区」组条目（MobileTabShell 注入：文件 / 工作项 /
 *  知识库 / Loops / 工作区设置，作用于当前会话所属工作区；点击 = 收起菜单 + 执行）。 */
export interface ToolbarMenuExtra {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export function ChatToolbar({
  navToggle = "sidebar",
  onBack,
  backLabel = "返回",
  moreMenuExtras,
}: { navToggle?: ToolbarNavToggle; onBack?: () => void; backLabel?: string; moreMenuExtras?: ToolbarMenuExtra[] } = {}) {
  const s = useShell();
  const { isDark, toggleTheme } = useTheme();
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();

  const {
    sidebarOpen,
    setSidebarOpen,
    activeWorkspace,
    activeTopPanel,
    setActiveTopPanel,
    toggleTopPanel,
    topBarRef,
    languageBtnRef,
    systemBtnRef,
    topPanelPos,
    systemPrompt,
    sessionStats,
    contextUsage,
    showChat,
    selectedSession,
    projectTrust,
    setProjectTrustError,
    setProjectTrustDialogOpen,
    rightPanelOpen,
    branchTree,
    branchActiveLeafId,
    handleBranchLeafChange,
    autoNameStatus,
    handleAutoName,
    handleViewFullHistory,
    copiedSessionField,
    handleCopySessionField,
  } = s;

  // The desktop middle-column toggle (VS Code collapse). Owned here so the ☰
  // button sits next to its effect.
  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, [setSidebarOpen]);

  // 上下文用量摘要（百分比 + 预警色）：桌面/平板显示在顶栏统计按钮里；手机顶栏
  // 不放统计按钮（2026-10 用户反馈「也收进 ⋯」），改作 ⋯ 菜单「会话信息」行尾 hint。
  const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  let ctxColor = "var(--text-muted)";
  let ctxStr: string | null = null;
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    if (pct !== null && pct > 90) ctxColor = "#ef4444";
    else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
    ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmtTokens(contextUsage.contextWindow)}` : `? / ${fmtTokens(contextUsage.contextWindow)}`;
  }

  return (
<div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: isMobile ? 44 : 36, background: "var(--bg-panel)" }}>
  {onBack ? (
  /* 手机聊天页（MobileTabShell 推入）：‹ 回上一页（会话首页 / 工作区页）。 */
  <button
    type="button"
    onClick={onBack}
    title={backLabel}
    aria-label={backLabel}
    style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
      background: "none", border: "none", borderRight: "1px solid var(--border)",
      color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  </button>
  ) : navToggle !== "hidden" && (
  <button
    onClick={handleSidebarToggle}
     title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
     aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
     aria-expanded={sidebarOpen}
    style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      position: "relative",
      width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
      background: "none", border: "none", borderRight: "1px solid var(--border)",
      color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
  >
    {sidebarOpen ? (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    ) : (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    )}
  </button>
  )}
  {/* 主题/语言：全局低频设置。桌面端保持原位常驻；移动端收进 ⋯ 菜单（2026-09
      重排）——顶栏让位给「我在哪」定位与状态。 */}
  {!isMobile && (
  <button
    onClick={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }}
     title={isDark ? translate("theme.light") : translate("theme.dark")}
     aria-label={isDark ? translate("theme.light") : translate("theme.dark")}
    aria-pressed={isDark}
    style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
      background: "none", border: "none", borderRight: "1px solid var(--border)",
      color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
    }}
    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
  >
    {isDark ? (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ) : (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    )}
   </button>
  )}
  {!isMobile && (
   <button
     ref={languageBtnRef}
     type="button"
     onClick={() => toggleTopPanel("language")}
     title={translate("common.language")}
     aria-label={translate("common.language")}
     aria-haspopup="menu"
     aria-expanded={activeTopPanel === "language"}
     aria-pressed={activeTopPanel === "language"}
     style={{
       display: "flex", alignItems: "center", justifyContent: "center",
       width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
       background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
       border: "none", borderRight: "1px solid var(--border)",
       color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
       cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
     }}
     onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
     onMouseLeave={(e) => {
       e.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
     }}
   >
     <svg
       width="16"
       height="16"
       viewBox="0 0 24 24"
       fill="none"
       stroke="currentColor"
       strokeWidth="1.8"
       strokeLinecap="round"
       strokeLinejoin="round"
       aria-hidden="true"
     >
       <path d="m5 8 6 6" />
       <path d="m4 14 6-6 2-3" />
       <path d="M2 5h12" />
       <path d="M7 2h1" />
       <path d="m22 22-5-10-5 10" />
       <path d="M14 18h6" />
     </svg>
   </button>
  )}
  {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
    <button
      type="button"
      onClick={() => {
        setProjectTrustError(null);
        setProjectTrustDialogOpen(true);
      }}
      title={translate("trust.resourcesNotLoaded")}
      aria-label={translate("trust.resourcesNotLoaded")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "100%",
        padding: isMobile ? "0 10px" : "0 12px",
        background: "none",
        border: "none",
        borderRight: "1px solid var(--border)",
        color: "#d97706",
        cursor: "pointer",
        flexShrink: 0,
        fontSize: 11,
        whiteSpace: "nowrap",
      }}
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
        aria-hidden="true"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
      {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
    </button>
  )}
  {showChat && (
    <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
      {/* 会话级工具（完整历史/自动命名/系统提示词）：桌面端原位常驻；移动端
          收进 ⋯ 菜单（2026-09 重排）。分支面板两端都要 —— 移动端用
          hideTrigger 只挂面板，入口在 ⋯ 菜单里。 */}
      {!isMobile && (
      <button
        onClick={handleViewFullHistory}
        disabled={!selectedSession}
         title={selectedSession ? translate("history.full") : translate("history.unsaved")}
         aria-label={translate("history.full")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 12px",
          background: "none",
          border: "none",
          borderTop: "2px solid transparent",
          borderRight: "1px solid var(--border)",
          color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
          cursor: selectedSession ? "pointer" : "not-allowed",
          opacity: selectedSession ? 1 : 0.45,
          flexShrink: 0,
          fontSize: 11,
          whiteSpace: "nowrap",
          transition: "color 0.1s, background 0.1s, opacity 0.1s",
        }}
        onMouseEnter={(e) => {
          if (!selectedSession) return;
          e.currentTarget.style.color = "var(--text)";
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
          e.currentTarget.style.background = "none";
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
            flexShrink: 0,
          }}
        >
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
         {!isMobile && <span>{translate("history.label")}</span>}
      </button>
      )}
      {(() => {
        // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
        const hasMessages = Boolean(
          selectedSession
          && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
        );
        const disabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
        const isSuccess = autoNameStatus.kind === "success";
        const isError = autoNameStatus.kind === "error";
        const label = autoNameStatus.kind === "naming"
           ? translate("title.generating")
            : isSuccess
            ? translate("title.updated")
            : isError
              ? translate("title.failed")
              : translate("title.generate");
        const title = !selectedSession
           ? translate("title.unsaved")
           : !hasMessages
             ? translate("title.noMessages")
             : isError
               ? autoNameStatus.message
               : translate("title.generateSession");
        return (
          !isMobile && (
          <button
            type="button"
            onClick={() => void handleAutoName()}
            disabled={disabled}
            title={title}
            aria-label={label}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              height: "100%", padding: "0 12px",
              background: "none", border: "none",
              borderTop: "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
              flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s, opacity 0.1s",
            }}
            onMouseEnter={(e) => {
              if (disabled) return;
              e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
              e.currentTarget.style.background = "none";
            }}
          >
            {autoNameStatus.kind === "naming" ? (
              <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : isSuccess ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m15 4 5 5L7 22l-5-5Z" />
                <path d="m14 5 5 5" />
                <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
              </svg>
            )}
             <span>{label}</span>
          </button>
          )
        );
      })()}
      <BranchNavigator
        tree={branchTree}
        activeLeafId={branchActiveLeafId}
        onLeafChange={handleBranchLeafChange}
        inline
        compact={isMobile}
        hideTrigger={isMobile}
        containerRef={topBarRef}
        open={activeTopPanel === "branches"}
        onToggle={() => toggleTopPanel("branches")}
        hasSession
      />
      {!isMobile && (
      <button
        ref={systemBtnRef}
        onClick={() => toggleTopPanel("system")}
         title={translate("system.prompt")}
         aria-label={translate("system.prompt")}
        aria-pressed={activeTopPanel === "system"}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          height: "100%", padding: "0 12px",
          background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
          borderRight: "1px solid var(--border)",
          cursor: "pointer",
          color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
          fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
         <span>{translate("system.label")}</span>
      </button>
      )}
    </div>
  )}
  {/* 当前会话标题（移动端 only，knowledge/designs/mobile-drawer-design.md §5）：chips 行
      删除后的「我在哪」方位感。会话名优先（自动命名后的 name），回落首条
      消息，无会话时显示当前工作区名。2026-09 重排：居中、主文字色；2026-10：
      回归纯标签——「会话信息」入口移进 ⋯ 菜单（用户反馈），不再点标题弹面板。 */}
  {isMobile && (() => {
    const titleText = selectedSession ? (selectedSession.name || selectedSession.firstMessage) : (activeWorkspace?.name ?? "");
    return (
      <div
        title={titleText}
        style={{
          flex: 1, minWidth: 0, height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 8px", overflow: "hidden",
          fontSize: 13, fontWeight: 500, color: "var(--text)",
          userSelect: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleText}</span>
      </div>
    );
  })()}
  {/* Session stats — right-aligned in top bar（桌面/平板；手机顶栏不放，见 ⋯ 会话信息行 hint）。 */}
  {!isMobile && showChat && (sessionStats || contextUsage) && (() => {
     const tokens = sessionStats?.tokens;
    const c = sessionStats?.cost ?? 0;
    const fmt = fmtTokens;
    const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;
    const tooltipParts: string[] = [];
     if (tokens) {
       tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
       tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
       tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
       tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const pct = contextUsage.percent;
      tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
       title={tooltip || translate("session.title")}
         aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        style={{
          marginLeft: "auto",
          display: "flex", alignItems: "center", gap: 10,
          paddingLeft: 12,
          paddingRight: isMobile ? 4 : (rightPanelOpen ? 12 : 48),
          height: "100%",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: "pointer",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)"; }}
      >
         {tokens && tokens.input > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
            </svg>
             {fmt(tokens.input)}
          </span>
        )}
         {tokens && tokens.output > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
            </svg>
             {fmt(tokens.output)}
          </span>
        )}
         {tokens && tokens.cacheRead > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
            </svg>
             {fmt(tokens.cacheRead)}
          </span>
        )}
        {costStr && (
          <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
            {costStr}
          </span>
        )}
        {ctxStr && (
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
            </svg>
            {ctxStr}
          </span>
        )}
      </button>
    );
  })()}
  {/* ⋯ 溢出菜单（移动端 only，2026-09 重排 → 2026-10 收口）：全局组（主题/语言）+
      会话组（会话信息〔行尾上下文用量〕/完整历史/生成标题/分支/系统提示词）+ 工作区组
      （手机壳注入）——顶栏本体只留 ‹ + 标题 + ⋯，统计按钮也收进来了。 */}
  {isMobile && (
    <button
      type="button"
      onClick={() => toggleTopPanel("more")}
      title={translate("i18n.more")}
      aria-label={translate("i18n.more")}
      aria-haspopup="menu"
      aria-expanded={activeTopPanel === "more"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
        background: activeTopPanel === "more" ? "var(--bg-selected)" : "none",
        border: "none",
        borderTop: activeTopPanel === "more" ? "2px solid var(--accent)" : "2px solid transparent",
        color: activeTopPanel === "more" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "more" ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
        <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
      </svg>
    </button>
  )}
  {/* Top panel dropdown — shared, only one active at a time */}
  {activeTopPanel && topPanelPos && (
    <div style={{
      position: "fixed",
      top: topPanelPos.top,
      left: topPanelPos.left,
      width: topPanelPos.width,
      maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
      overflowY: "auto",
      zIndex: 500,
    }}>
      {activeTopPanel === "language" && (
        <div
          role="menu"
          aria-label={translate("common.language")}
          style={{
            background: "var(--bg-panel)",
            borderLeft: "1px solid var(--border)",
            borderRight: "1px solid var(--border)",
            borderBottom: "1px solid var(--border)",
            overflow: "hidden",
            padding: 4,
          }}
        >
          {supportedLocales.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              onClick={() => {
                setLocale(plugin.id as typeof locale);
                setActiveTopPanel(null);
              }}
              role="menuitemradio"
              aria-checked={locale === plugin.id}
              style={{
                display: "flex", alignItems: "center",
                width: "100%", height: 34, padding: "0 10px",
                border: "none", borderRadius: 4,
                background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
              }}
            >
              <span>{plugin.label}</span>
            </button>
          ))}
        </div>
      )}
      {activeTopPanel === "more" && (() => {
        // 移动端 ⋯ 菜单体。行点击语义：主题/历史/命名 = 执行并收起；语言 =
        // 原位换成语言列表（复用 "language" 面板）；分支/系统 = 换成对应面板
        // （single-active 语义自动关闭菜单）。自动命名的禁用判定与桌面按钮
        // 同源（消息数含压缩前口径）。
        const hasMessages = Boolean(
          selectedSession
          && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
        );
        const autoNameDisabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
        const autoNameLabel = autoNameStatus.kind === "naming"
          ? translate("title.generating")
          : autoNameStatus.kind === "success"
            ? translate("title.updated")
            : autoNameStatus.kind === "error"
              ? translate("title.failed")
              : translate("title.generate");
        const separator = <div style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />;
        return (
          <div
            role="menu"
            aria-label={translate("i18n.more")}
            style={{
              background: "var(--bg-panel)",
              borderLeft: "1px solid var(--border)",
              borderRight: "1px solid var(--border)",
              borderBottom: "1px solid var(--border)",
              boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
              overflow: "hidden",
              padding: 6,
            }}
          >
            <MoreMenuRow
              icon={isDark ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
              label={isDark ? translate("theme.light") : translate("theme.dark")}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                setActiveTopPanel(null);
              }}
            />
            <MoreMenuRow
              icon={(
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" />
                  <path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
                </svg>
              )}
              label={translate("common.language")}
              onClick={() => setActiveTopPanel("language")}
            />
            {showChat && separator}
            {showChat && (
              <>
                {/* 会话信息（2026-10：原「点居中标题弹面板」入口移到这里，标题回归纯标签）。 */}
                <MoreMenuRow
                  icon={(
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8" r="0.6" fill="currentColor" />
                    </svg>
                  )}
                  label={translate("session.info")}
                  disabled={!selectedSession}
                  onClick={() => toggleTopPanel("session")}
                  hint={ctxStr ?? undefined}
                  hintColor={ctxColor}
                />
                <MoreMenuRow
                  icon={(
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
                    </svg>
                  )}
                  label={translate("history.label")}
                  disabled={!selectedSession}
                  onClick={() => {
                    handleViewFullHistory();
                    setActiveTopPanel(null);
                  }}
                />
                <MoreMenuRow
                  icon={autoNameStatus.kind === "naming" ? (
                    <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  ) : autoNameStatus.kind === "success" ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m15 4 5 5L7 22l-5-5Z" /><path d="m14 5 5 5" />
                      <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                    </svg>
                  )}
                  label={autoNameLabel}
                  disabled={autoNameDisabled}
                  onClick={() => {
                    void handleAutoName();
                    setActiveTopPanel(null);
                  }}
                />
                <MoreMenuRow
                  icon={(
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                  )}
                  label={translate("i18n.branches")}
                  onClick={() => toggleTopPanel("branches")}
                />
                <MoreMenuRow
                  icon={(
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={systemPrompt ? "var(--accent)" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" />
                    </svg>
                  )}
                  label={translate("system.label")}
                  onClick={() => toggleTopPanel("system")}
                />
              </>
            )}
            {/* 工作区组（手机壳注入，2026-10）：当前会话所属工作区的模块入口。 */}
            {moreMenuExtras && moreMenuExtras.length > 0 && (
              <>
                {separator}
                {moreMenuExtras.map((extra) => (
                  <MoreMenuRow
                    key={extra.id}
                    icon={extra.icon}
                    label={extra.label}
                    onClick={() => { setActiveTopPanel(null); extra.onClick(); }}
                  />
                ))}
              </>
            )}
          </div>
        );
      })()}
      {activeTopPanel === "system" && (
        <div style={{
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          {systemPrompt ? (
            <div style={{
              maxHeight: "min(600px, 75vh)",
              overflowY: "auto",
              padding: "12px 16px",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              fontFamily: "var(--font-mono)",
            }}>
              {systemPrompt}
            </div>
          ) : systemPrompt === "" ? (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
               {translate("system.empty")}
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
               {translate("system.load")}
            </div>
          )}
        </div>
      )}
      {activeTopPanel === "session" && (
        <div className="session-info-popover" style={{
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
          padding: "12px 16px",
        }}>
          {sessionStats ? (() => {
            const sessionRows = [
               ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
               { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
               { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
            ];
            const messageRows = [
               [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
               [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
               [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
               [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
               [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
            ];
            const tokenRows = [
               [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
               [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
               ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
               ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
               [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
            ];
            const ctx = contextUsage ?? sessionStats.contextUsage;
            const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const cacheHitRate = computeCacheHitRatePercent(sessionStats.tokens);
            const extraTokenRows = [
               ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
               ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
               // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
               ...(cacheHitRate !== null ? [[translate("session.cacheHitRate"), `${cacheHitRate.toFixed(1)}%`]] : []),
            ];
            const formatDuration = (ms: number) => {
              if (ms <= 0) return "0s";
              const totalSec = Math.floor(ms / 1000);
              const h = Math.floor(totalSec / 3600);
              const m = Math.floor((totalSec % 3600) / 60);
              const s = totalSec % 60;
              if (h > 0) return `${h}h ${m}m`;
              if (m > 0) return `${m}m ${s}s`;
              return `${s}s`;
            };
            const totalActiveMs = sessionStats.totalActiveMs ?? 0;
            const section = (
              title: string,
              sectionRows: string[][],
              valueAlign: "left" | "right" = "left",
              compact = false,
            ) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                    columnGap: compact ? 14 : 12,
                    rowGap: 4,
                    justifyContent: compact ? "start" : undefined,
                  }}>
                    {sectionRows.map(([label, value]) => (
                      <div key={`${title}:${label}`} style={{ display: "contents" }}>
                        <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                        <div style={{
                          color: "var(--text-muted)",
                          minWidth: 0,
                          overflowWrap: compact ? "normal" : "anywhere",
                          textAlign: valueAlign,
                          whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                        }}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            const copyButton = (field: SessionCopyField, value: string) => {
              const copied = copiedSessionField === field;
              return (
                <button
                  type="button"
                   title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                  onClick={() => handleCopySessionField(field, value)}
                  style={{
                    alignSelf: "start",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    marginTop: -2,
                    color: copied ? "var(--accent)" : "var(--text-dim)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    cursor: "pointer",
                    flex: "0 0 auto",
                    transition: "color 0.12s, border-color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--accent)";
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  {copied ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              );
            };
            const sessionInfoSection = (
              <div style={{ minWidth: 0 }}>
                 <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                  {sessionRows.map((row) => (
                    <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                      <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                      <div style={{
                        color: "var(--text-muted)",
                        minWidth: 0,
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        whiteSpace: "normal",
                      }}>{row.value}</div>
                      <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
            return (
              <>
              <div style={{
                display: "grid",
                gridTemplateColumns: isMobile
                  ? "1fr"
                  : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                gap: isMobile ? 16 : 24,
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: "var(--font-mono)",
              }}>
                {sessionInfoSection}
                 {section(translate("session.messages"), messageRows)}
                 {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
              </div>
              {totalActiveMs > 0 ? (
                <div style={{
                  marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)",
                  display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 10, rowGap: 2,
                  color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--font-mono)",
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }} aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>{translate("session.totalActive")} <span style={{ color: "var(--accent)", fontWeight: 600 }}>{formatDuration(totalActiveMs)}</span></span>
                </div>
              ) : null}
              </>
            );
          })() : (
            <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
               {translate("session.load")}
            </div>
          )}
        </div>
      )}
    </div>
  )}
</div>

  );
}
