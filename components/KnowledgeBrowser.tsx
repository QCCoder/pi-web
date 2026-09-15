"use client";

import { useMemo, useState } from "react";
import { FileExplorer } from "./FileExplorer";
import { joinFilePath } from "@/lib/file-paths";
import type { GitFileStatus } from "@/lib/git-types";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * 知识库浏览（W-中收敛，docs/session-tabs-design.md Phase 2）：原中栏知识库
 * 模块视图的提升版，现在挂在工作区家 tab（总览 hub）的 knowledge 子视图里
 * （移动端 = 工作台 tab 的 overview 栈页）。内容不变：知识库 chips 选择器 +
 * OKF bundle 的 FileExplorer（L0：read/ls/grep 常驻，open index.md 为入口提示）。
 */
interface Props {
  workspace: WorkspaceSummary;
  onOpenFile: (path: string, name: string) => void;
  refreshKey?: number;
}

export function KnowledgeBrowser({ workspace, onOpenFile, refreshKey = 0 }: Props) {
  const knowledgeRepositories = useMemo(
    () => workspace.repositories.filter((repository) => repository.kind === "knowledge" && repository.status === "active"),
    [workspace.repositories],
  );
  const [selectedKnowledgeRepoId, setSelectedKnowledgeRepoId] = useState<string | null>(null);
  const effectiveKnowledgeRepo = useMemo(
    () => knowledgeRepositories.find((repository) => repository.id === selectedKnowledgeRepoId)
      ?? knowledgeRepositories[0],
    [knowledgeRepositories, selectedKnowledgeRepoId],
  );

  if (knowledgeRepositories.length === 0) {
    return (
      <div style={{ padding: "14px 16px", color: "var(--text-dim)", fontSize: 13 }}>
        暂无知识库（设置 › 工作区 里添加 kind=knowledge 的仓库）
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 16px 6px", flexShrink: 0 }}>
        {knowledgeRepositories.map((repository) => {
          const selected = repository.id === effectiveKnowledgeRepo?.id;
          return (
            <button
              key={repository.id}
              onClick={() => setSelectedKnowledgeRepoId(repository.id)}
              style={{
                padding: "3px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: selected ? "var(--bg-selected)" : "var(--bg)",
                color: selected ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {repository.name}
            </button>
          );
        })}
      </div>
      {effectiveKnowledgeRepo && (
        <>
          <div style={{ padding: "4px 16px 8px", color: "var(--text-dim)", fontSize: 12, flexShrink: 0 }}>
            OKF bundle —{" "}
            <button
              type="button"
              onClick={() => onOpenFile(`${joinFilePath(workspace.path, effectiveKnowledgeRepo.path)}/index.md`, "index.md")}
              style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}
            >
              open index.md
            </button>
            {" "}to traverse (L0: read/ls/grep).
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <FileExplorer
              cwd={joinFilePath(workspace.path, effectiveKnowledgeRepo.path)}
              onOpenFile={onOpenFile}
              refreshKey={refreshKey}
              gitStatusByPath={EMPTY_GIT_STATUS_BY_PATH}
              changedDirectoryPaths={EMPTY_CHANGED_DIRECTORY_PATHS}
            />
          </div>
        </>
      )}
    </div>
  );
}

const EMPTY_GIT_STATUS_BY_PATH = new Map<string, GitFileStatus>();
const EMPTY_CHANGED_DIRECTORY_PATHS = new Set<string>();
