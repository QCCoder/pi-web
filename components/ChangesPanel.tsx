"use client";

import { useState } from "react";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { RepoGroup } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";
import { ChangeRow, GIT_STATUS_COLORS, type OpenFileHandler } from "./git-ui";

interface Props {
  groups: RepoGroup[];
  cwd: string;
  onOpenFile: OpenFileHandler;
}

/** Display label for a repository root relative to cwd: the cwd-relative path
 *  for nested repos, the basename for the cwd repo itself or an enclosing repo. */
function repoLabel(root: string, cwd: string): string {
  const rel = getRelativeFilePath(root, cwd);
  if (rel === "." || rel.startsWith("..")) return getFileName(root) || root;
  return rel;
}

/**
 * The Changes panel body. Renders a flat file list when there is a single
 * repository, and a per-repository collapsible grouping (each defaulting to
 * collapsed) when the cwd spans multiple repositories. Each multi-repo group
 * header shows its own file count and +/- subtotal.
 *
 * Grand totals live in the section header (SessionSidebar), not here.
 */
export function ChangesPanel({ groups, cwd, onOpenFile }: Props) {
  const { t } = useI18n();
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());

  const toggleRepo = (root: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  if (groups.length === 0) {
    return (
      <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 11 }}>
        {t("sidebar.noChanges")}
      </div>
    );
  }

  if (groups.length === 1) {
    const group = groups[0];
    return (
      <div style={{ padding: "0 4px 2px" }}>
        {group.files.map((status) => (
          <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ padding: "0 4px 2px" }}>
      {groups.map((group) => {
        const expanded = expandedRepos.has(group.repositoryRoot);
        const label = repoLabel(group.repositoryRoot, cwd);
        return (
          <div key={group.repositoryRoot} style={{ marginBottom: 2 }}>
            <button
              type="button"
              onClick={() => toggleRepo(group.repositoryRoot)}
              title={group.repositoryRoot}
              aria-expanded={expanded}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                height: 24,
                padding: "0 8px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label}
              </span>
              <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                {t("files.changedCount", { count: group.files.length })}
              </span>
              <span style={{ flexShrink: 0, color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{group.additions}</span>
              <span style={{ flexShrink: 0, color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{group.deletions}</span>
            </button>
            {expanded && group.files.map((status) => (
              <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
