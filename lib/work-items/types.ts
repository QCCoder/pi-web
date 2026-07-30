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
  actor?: WorkItemActor;
  conversationId?: string;
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
