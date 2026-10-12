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
    }
  | {
      id: string;
      kind: "terminal";
      label: string;
      /** Workspace cwd the terminal is bound to — part of its creation
       *  identity (same id + different cwd must never reuse a process). */
      cwd: string;
      /** True while a close/restart termination is in flight (upstream
       *  "closing" tab semantics: unresponsive until the DELETE settles). */
      closing?: boolean;
    };

/** Reserved ids of the right dock's rail modules（2026-10 rail 改版：右坞 =
 *  44px 常驻图标列 + 展开面板，模块不再是 tab 条里的条目）. NOT members of
 *  `tabs`; the dock rail's active module lives in the shell-level dockRail map
 *  (per-workspace persisted), NOT in `activeFileTabId` — that channel is back to
 *  files only（FILES_TAB_ID 仍是「文件树」伪 tab，住在文件模块面板内的横条）.
 *  门控（沿 2026-09 设计 §5）：文件 = 有工作区上下文；Loops = 常驻（无
 *  capability，空态+新建入口）；知识库 = knowledge capability；工作项 =
 *  work-items capability；终端 = 常驻（DesktopShell 自有，跨会话挂载）。 */
export const FILES_TAB_ID = "__files__";
export const LOOPS_TAB_ID = "__loops__";
export const KNOWLEDGE_TAB_ID = "__knowledge__";
export const WORK_ITEMS_TAB_ID = "__work-items__";
export const TERMINALS_TAB_ID = "__terminals__";

export const MODULE_TAB_IDS = [FILES_TAB_ID, LOOPS_TAB_ID, KNOWLEDGE_TAB_ID, WORK_ITEMS_TAB_ID, TERMINALS_TAB_ID] as const;
export type ModuleTabId = (typeof MODULE_TAB_IDS)[number];

/** Is `id` one of the dock's pinned module tab ids (not a file/session tab)? */
export function isModuleTabId(id: string | null | undefined): id is ModuleTabId {
  return id != null && (MODULE_TAB_IDS as readonly string[]).includes(id);
}
