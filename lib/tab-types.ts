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

/** Reserved id of the pinned「文件」leading tab (the workbench file tree in
 *  the right panel). NOT a member of `tabs` — it is rendered separately via
 *  `leadingTab` and never closable. `activeFileTabId` may equal this id. */
export const FILES_TAB_ID = "__files__";
