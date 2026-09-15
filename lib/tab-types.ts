import type { SessionInfo } from "./types";

/** An open entry of the right panel's file-tab strip. (Moved here from
 *  components/TabBar.tsx so the pure session-tab model in lib/session-tabs.ts
 *  can reference it without a lib→components dependency.) */
export type Tab =
  | {
      id: string;
      kind: "file";
      label: string;
      filePath: string;
      sourceSessionId?: string | null;
      initialDisplayMode?: "source" | "preview" | "diff";
    }
  | {
      id: string;
      kind: "session";
      label: string;
      sessionId: string;
      sessionInfo: SessionInfo;
    };

/** Reserved ids of the right dock's pinned module tabs (right-dock design S1:
 *  the desktop right panel is a tabbed extension dock — module tabs are
 *  pinned non-closable entries in the SAME TabBar strip as file/session
 *  tabs, rendered via `leadingTabs`). NOT members of `tabs`; `activeFileTabId`
 *  may equal any of them. 文件 is "one of the modules" — the dock's default.
 *  门控（design §5）：文件 = 有工作区上下文；Loops = 常驻（无 capability，空态
 *  + 新建入口）；知识库 = knowledge capability（S2）；工作项 = work-items
 *  capability（S3，宿主 WorkspaceManager panel 模式推进航）。 */
export const FILES_TAB_ID = "__files__";
export const LOOPS_TAB_ID = "__loops__";
export const KNOWLEDGE_TAB_ID = "__knowledge__";
export const WORK_ITEMS_TAB_ID = "__work-items__";

export const MODULE_TAB_IDS = [FILES_TAB_ID, LOOPS_TAB_ID, KNOWLEDGE_TAB_ID, WORK_ITEMS_TAB_ID] as const;
export type ModuleTabId = (typeof MODULE_TAB_IDS)[number];

/** Is `id` one of the dock's pinned module tab ids (not a file/session tab)? */
export function isModuleTabId(id: string | null | undefined): id is ModuleTabId {
  return id != null && (MODULE_TAB_IDS as readonly string[]).includes(id);
}
