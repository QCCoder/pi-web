"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileExplorer } from "./FileExplorer";
import { ChangesPanel } from "./ChangesPanel";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useI18n } from "@/hooks/useI18n";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * The pinned「文件」tab content of the desktop right panel — the workbench
 * file tree (moved out of the middle column, which is sessions-only now).
 *
 * Toolbar: the [ 文件 | 改动(N) ] segmented switch (git directories only,
 * persisted per workspace under `pi-explorer-tab:<wsId>` — the same key the
 * mobile workbench section uses, so both surfaces agree) + the ⟳ manual
 * refresh (external deletions/edits emit no events; only agent turns
 * auto-refresh at agent_end). Below it: the FileExplorer tree or the git
 * ChangesPanel, scoped to the workspace root.
 *
 * Stays MOUNTED while other right-panel tabs are active (DesktopShell hides
 * it via display:none) — the tree keeps its expansion state across switches.
 */
interface Props {
  workspace: WorkspaceSummary;
  /** Shell-driven refresh signal (agent_end etc.) — stacked with the manual ⟳. */
  explorerRefreshKey: number;
  onOpenFile: (path: string, name: string) => void;
  /** Loops-panel reveal signal: expands the tree to the target path (nonce
   *  re-triggers the same path; effective only while the tree shows). */
  reveal?: { path: string; nonce: number };
  /** 打开/聚焦该工作区路径的集成终端 tab（desktop 右坞接线；上游 Explorer
   *  头部的终端动作，#695。不传则无入口——移动端工作台不接终端）。 */
  onOpenTerminal?: (cwd: string) => void;
}

/** Workbench [ 文件 | 改动 ] segmented switch — shared by this panel and the
 *  mobile workbench files section (WorkspaceSidebar). Margin 0; the enclosing
 *  toolbar provides the spacing. */
export function ExplorerSegmentedTabs({
  active,
  changesCount,
  onSelect,
}: {
  active: "files" | "changes";
  changesCount: number;
  onSelect: (tab: "files" | "changes") => void;
}) {
  const tabBase: React.CSSProperties = {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "4px 8px",
    border: 0,
    borderRadius: 5,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: "var(--pi-sidebar-fs-meta)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
  const activeStyle: React.CSSProperties = {
    background: "var(--bg-panel)",
    color: "var(--text)",
    boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
  };
  return (
    <div
      role="tablist"
      aria-label="Explorer 视图"
      style={{
        display: "flex",
        gap: 3,
        padding: 3,
        background: "var(--bg-hover)",
        borderRadius: 7,
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active === "files"}
        style={active === "files" ? { ...tabBase, ...activeStyle } : tabBase}
        onClick={() => onSelect("files")}
      >
        文件
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "changes"}
        style={active === "changes" ? { ...tabBase, ...activeStyle } : tabBase}
        onClick={() => onSelect("changes")}
      >
        改动
        {changesCount > 0 && (
          <span
            title={`${changesCount} 个改动`}
            style={{
              minWidth: 16,
              height: 16,
              padding: "0 5px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
              background: "var(--accent)",
              color: "var(--bg-panel)",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {changesCount}
          </span>
        )}
      </button>
    </div>
  );
}

export function FilesExplorerPanel({ workspace, explorerRefreshKey, onOpenFile, reveal, onOpenTerminal }: Props) {
  const { t } = useI18n();
  const [explorerTab, setExplorerTab] = useState<"files" | "changes">("files");
  // ⟳ 手动刷新：叠加在 shell 驱动的 explorerRefreshKey 上，同时刷文件树缓存
  // 与 git 状态（外部删除/编辑等无事件的变化只能靠它）。
  const [manualExplorerKey, setManualExplorerKey] = useState(0);
  // 快速文件搜索开关（#591，upstream b24ecad）：本地 Explorer 的工具栏在本面板，
  // 故开关状态也收在这里（上游放在 SessionSidebar 头部工具栏）。
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  const { status: gitStatus, gitStatusByPath, changedDirectoryPaths } = useGitStatus(
    workspace.path,
    explorerRefreshKey + manualExplorerKey,
  );
  const changesCount = gitStatus ? gitStatus.groups.reduce((total, group) => total + group.files.length, 0) : 0;
  const isGitRepo = Boolean(gitStatus?.isGitRepository);
  // 非 git 目录隐藏「改动」分段，强制回落到「文件」。
  const effectiveExplorerTab: "files" | "changes" =
    isGitRepo && explorerTab === "changes" ? "changes" : "files";

  // 分段选择按工作区持久化（与移动端工作台文件段共用同一 key，两端一致）。
  useEffect(() => {
    const stored = localStorage.getItem(`pi-explorer-tab:${workspace.id}`);
    setExplorerTab(stored === "changes" ? "changes" : "files");
  }, [workspace.id]);

  const handleSelectExplorerTab = useCallback((tab: "files" | "changes") => {
    setExplorerTab(tab);
    localStorage.setItem(`pi-explorer-tab:${workspace.id}`, tab);
  }, [workspace.id]);

  // reveal（如 Loops 面板 loop 名点击的跨视图定位）到达时联动切回「文件」分段：
  // 用户停在「改动」时树未渲染，不切回则看不见 reveal 结果。
  const lastRevealNonceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!reveal || reveal.nonce === lastRevealNonceRef.current) return;
    lastRevealNonceRef.current = reveal.nonce;
    setExplorerTab("files");
  }, [reveal]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          padding: "4px 8px",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {isGitRepo ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ExplorerSegmentedTabs
              active={effectiveExplorerTab}
              changesCount={changesCount}
              onSelect={handleSelectExplorerTab}
            />
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 0, color: "var(--text)", fontSize: "var(--pi-sidebar-fs-meta)", fontWeight: 600 }}>
            文件
          </div>
        )}
        {onOpenTerminal && (
          <button
            type="button"
            onClick={() => onOpenTerminal(workspace.path)}
            title="打开工作区终端"
            aria-label="打开工作区终端"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              padding: 0,
              flexShrink: 0,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={() => setFileSearchOpen((open) => !open)}
          title={t("sidebar.searchFiles")}
          aria-label={t("sidebar.searchFiles")}
          aria-pressed={fileSearchOpen}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            flexShrink: 0,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: fileSearchOpen ? "var(--bg-selected)" : "transparent",
            color: fileSearchOpen ? "var(--accent)" : "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setManualExplorerKey((key) => key + 1)}
          title="刷新文件树与改动状态"
          aria-label="刷新文件树与改动状态"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            flexShrink: 0,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {isGitRepo && effectiveExplorerTab === "changes" ? (
          <ChangesPanel
            groups={gitStatus?.groups ?? []}
            cwd={workspace.path}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileExplorer
            cwd={workspace.path}
            onOpenFile={onOpenFile}
            refreshKey={explorerRefreshKey + manualExplorerKey}
            gitStatusByPath={gitStatusByPath}
            changedDirectoryPaths={changedDirectoryPaths}
            reveal={reveal}
            fileSearchOpen={fileSearchOpen}
            onFileSearchOpenChange={setFileSearchOpen}
          />
        )}
      </div>
    </div>
  );
}
