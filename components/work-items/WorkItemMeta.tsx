"use client";

import { sourceLabel } from "@/lib/work-items/source-labels";
import type { WorkItemExternalRef } from "@/lib/work-items/types";
import { formatEventDate } from "./WorkItemEvents";

/** 概况的共用展示片段（从 WorkspaceManager 抽出，M2 T9）：来源行内容与仓库
 *  范围 chips。宿主给外层布局（label/卡片），这里只管内容，两处样式系统
 *  （workspace-* class 与中央页 inline style）都能用。 */

/** 来源行内容：外部源链接（禅道 ↗）+ 最近同步时间。 */
export function SourceRefValue({ external }: { external: WorkItemExternalRef }) {
  return (
    <>
      {external.url ? (
        <a href={external.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
          {sourceLabel(external.source)} #{external.sourceId} ↗
        </a>
      ) : (
        <span>
          {sourceLabel(external.source)} #{external.sourceId}
        </span>
      )}
      {external.lastSyncedAt && (
        <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>
          同步于 {formatEventDate(external.lastSyncedAt)}
        </span>
      )}
    </>
  );
}

export interface RepositoryChipOption {
  id: string;
  name: string;
  status?: string;
}

/** 仓库范围只读 chips（2026-09 反馈：详情页勾选无实际作用，只读非空展示；
 *  字段由创建表单/外部源脚本/LLM 工具写入，loop 选品 verifiable 判定读它）。 */
export function WorkItemRepositoryChips({
  repositoryIds,
  repositories,
}: {
  repositoryIds: string[];
  repositories: RepositoryChipOption[];
}) {
  return (
    <>
      {repositoryIds.map((repositoryId) => {
        const repository = repositories.find((repo) => repo.id === repositoryId);
        return (
          <span
            key={repositoryId}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "4px 9px",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            {repository ? repository.name : repositoryId}
            {repository?.status === "removed" ? "（已停用）" : ""}
          </span>
        );
      })}
    </>
  );
}
