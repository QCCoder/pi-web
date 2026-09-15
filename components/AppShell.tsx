"use client";

import { useViewportIsMobile } from "@/hooks/useIsMobile";
import { useVisualViewportKeyboard } from "@/hooks/useVisualViewportKeyboard";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { SessionInfo } from "@/lib/types";
import { WorkspaceManager } from "./WorkspaceManager";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { useAppShellState } from "./shell/useAppShellState";
import { AppShellProvider, IsMobileContext } from "./shell/context";
import { DesktopShell } from "./shell/DesktopShell";
import { MobileShell } from "./shell/MobileShell";

/**
 * The app shell entry — a thin dispatcher. ALL shared state (workspace tabs,
 * sessions, SSE, panels, persistence) lives in `useAppShellState`, provided to
 * the shells through context; the shells own only navigation & layout:
 *
 * - `DesktopShell` — the three-column layout (activity rail + resizable
 *   middle column + center/right columns).
 * - `MobileShell` — bottom tab navigation (工作台/会话/capability modules/
 *   设置) with per-tab secondary stacks; no drawer.
 *
 * The viewport breakpoint decides which shell renders; the state layer is
 * shell-agnostic so the flip loses nothing. `initialIsMobile` is the
 * server's UA guess (see `app/page.tsx`) — it seeds SSR AND hydration so the
 * correct shell is in the very first HTML response; matchMedia corrects a
 * wrong guess right after mount. The shell-agnostic overlays
 * (home create-workspace wizard, directory import picker, project trust
 * dialog) render here for both.
 */
export function AppShell({
  initialIsMobile = false,
  initialWorkspaces = null,
  initialSessions = null,
  initialRunningIds = null,
}: {
  initialIsMobile?: boolean;
  /** SSR 预取种子（方案二，app/page.tsx）：null = 预取失败，退回客户端拉取 +
   *  骨架态。种子让首帧即真数据+真排序，挂载后的刷新是静默同数据更新。 */
  initialWorkspaces?: WorkspaceSummary[] | null;
  initialSessions?: SessionInfo[] | null;
  initialRunningIds?: string[] | null;
}) {
  const state = useAppShellState({ initialWorkspaces, initialSessions, initialRunningIds });
  const isMobile = useViewportIsMobile(initialIsMobile);
  // 移动端键盘高度同步（--app-height）：触屏设备上键盘弹起时把应用根压到
  // visualViewport 高度，输入框贴住键盘，消除键盘与输入框之间的大片空白。
  useVisualViewportKeyboard();
  const {
    workspaceManagerOpen,
    setWorkspaceManagerOpen,
    handleOpenWorkspace,
    handleWorkspaceDeleted,
    importPickerOpen,
    setImportPickerOpen,
    importBusy,
    importError,
    handleImportDirectory,
    projectTrustDialogOpen,
    setProjectTrustDialogOpen,
    projectTrustBusy,
    projectTrustError,
    projectTrustCwd,
    handleTrustProject,
    handleOpenWorkItemConversation,
    setRefreshKey,
  } = state;

  return (
    <AppShellProvider value={state}>
      <IsMobileContext.Provider value={isMobile}>
      <style>{`
        @keyframes session-info-pop {
          0% {
            opacity: 0;
            transform: translateY(-24px);
            filter: blur(6px);
            box-shadow: 0 2px 8px rgba(0,0,0,0);
          }
          55% {
            opacity: 1;
            transform: translateY(0);
            filter: blur(0);
            background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
            box-shadow: 0 18px 44px rgba(37,99,235,0.16);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
            filter: blur(0);
            background: var(--bg-panel);
            box-shadow: 0 10px 28px rgba(0,0,0,0.10);
          }
        }
        @keyframes session-info-light-wash {
          0% {
            opacity: 0;
            transform: translateX(-110%) skewX(-16deg);
          }
          24% {
            opacity: 0.42;
          }
          100% {
            opacity: 0;
            transform: translateX(115%) skewX(-16deg);
          }
        }
        .session-info-popover {
          position: relative;
          overflow: hidden;
          transform-origin: top right;
          animation: session-info-pop 360ms ease-out both;
          will-change: transform, opacity, filter, background, box-shadow;
        }
        .session-info-popover::after {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          width: 44%;
          pointer-events: none;
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
          animation: session-info-light-wash 620ms ease-out both;
        }
        @media (prefers-reduced-motion: reduce) {
          .session-info-popover,
          .session-info-popover::after {
            animation: none;
          }
        }
      `}</style>
      {isMobile ? <MobileShell /> : <DesktopShell />}

      {/* Home create-workspace wizard — the one remaining WorkspaceManager
          modal (creating is a focused flow; managing lives in settings). */}
      {workspaceManagerOpen && (
        <WorkspaceManager
          open
          initialSection="workspaces"
          activeWorkspacePath={null}
          createWorkspaceOnOpen
          onClose={() => setWorkspaceManagerOpen(false)}
          onOpenWorkspace={handleOpenWorkspace}
          onOpenWorkItemConversation={handleOpenWorkItemConversation}
          onWorkspaceDeleted={handleWorkspaceDeleted}
          onWorkItemsChanged={() => setRefreshKey((key) => key + 1)}
        />
      )}
      {importPickerOpen && (
        <DirectoryPicker
          onCancel={() => setImportPickerOpen(false)}
          onSelect={(path) => void handleImportDirectory(path)}
          busy={importBusy}
          error={importError}
        />
      )}
      {projectTrustDialogOpen && projectTrustCwd && (
        <ProjectTrustDialog
          cwd={projectTrustCwd}
          busy={projectTrustBusy}
          error={projectTrustError}
          onCancel={() => {
            if (!projectTrustBusy) setProjectTrustDialogOpen(false);
          }}
          onConfirm={() => void handleTrustProject()}
        />
      )}
      </IsMobileContext.Provider>
    </AppShellProvider>
  );
}
