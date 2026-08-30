export const WORK_ITEM_SCHEMA_VERSION = 1 as const;

export type WorkItemType = "requirement" | "bug";
export type WorkItemStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type WorkItemPhase =
  | "intake"
  | "analysis"
  | "requirement_approval"
  | "design"
  | "plan_approval"
  | "implementation"
  | "verification"
  | "complete";
export type WorkItemPriority = "P0" | "P1" | "P2" | "P3";
export type WorkItemActor = "user" | "agent" | "system" | "external";

export interface WorkItemRecord {
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION;
  id: string;
  key: string;
  revision: number;
  type: WorkItemType;
  title: string;
  status: WorkItemStatus;
  phase: WorkItemPhase;
  priority: WorkItemPriority;
  repositories: string[];
  tags: string[];
  conversations: string[];
  relatedItems: string[];
  designs: string[];
  plans: string[];
  /** Optional kit-loop binding by loop NAME (not pattern — names are stable,
   *  patterns can change; spec §3.1). Soft-validated: an unresolvable name is
   *  treated as unbound, never an error. */
  loop?: string;
  /** Importer-written external link; absent for manually created items. */
  external?: WorkItemExternalRef;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemEvent {
  id: string;
  at: string;
  type: string;
  actor: WorkItemActor;
  conversationId?: string;
  data?: Record<string, unknown>;
}

/** Optional link to an external source (Importer-written). `source` + `sourceId`
 *  form the dedup key so re-importing the same Chandao item never duplicates the
 *  work item (design §4/§5). Written at creation by an Importer; not mutated by
 *  the LLM tools. */
export interface WorkItemExternalRef {
  /** Source adapter id, e.g. "chandao". */
  source: string;
  /** Stable id at the source, e.g. the Chandao bug/task id. */
  sourceId: string;
  /** Optional deep link back to the source item. */
  url?: string;
  /** ISO timestamp of the last successful import sync. */
  lastSyncedAt: string;
}

export interface WorkItemDetail {
  path: string;
  item: WorkItemRecord;
  content: string;
  events: WorkItemEvent[];
}

export interface InvalidWorkItem {
  path: string;
  key: string;
  error: string;
}

export interface CreateWorkItemInput {
  type: WorkItemType;
  title: string;
  originalDescription: string;
  priority?: WorkItemPriority;
  repositories?: string[];
  tags?: string[];
  actor?: WorkItemActor;
  conversationId?: string;
  /** Importer-only: stamps the external dedup link at creation. */
  external?: WorkItemExternalRef;
  /** Optional kit-loop binding by loop name (soft — existence not checked). */
  loop?: string;
}

export interface UpdateWorkItemInput {
  expectedRevision: number;
  title?: string;
  status?: WorkItemStatus;
  phase?: WorkItemPhase;
  priority?: WorkItemPriority;
  repositories?: string[];
  tags?: string[];
  conversations?: string[];
  relatedItems?: string[];
  designs?: string[];
  plans?: string[];
  archived?: boolean;
  actor?: WorkItemActor;
  conversationId?: string;
  /** Kit-loop binding by name; null clears it. */
  loop?: string | null;
}

export interface UpdateWorkItemContentInput {
  expectedRevision: number;
  content: string;
  actor?: WorkItemActor;
  conversationId?: string;
}

export interface RecordWorkItemMilestoneInput {
  expectedRevision?: number;
  type: string;
  actor?: WorkItemActor;
  conversationId?: string;
  data?: Record<string, unknown>;
}
