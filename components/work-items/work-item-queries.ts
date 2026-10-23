import type {
  WorkItemPhase,
  WorkItemPriority,
  WorkItemRecord,
  WorkItemType,
} from "@/lib/work-items/types";

/**
 * List/board shared query logic for the central WorkItemsPage (M2 T8,
 * spec §6.2): one filter set drives both views, persisted per workspace under
 * `pi-work-items-filters:<wsId>`; sort is P0→P3 → updatedAt desc → key.
 * PURE module (type-only imports) so it is node:test-able and bundle-safe.
 */

export interface WorkItemsFilters {
  /** Free text, matched against key + title (case-insensitive). */
  search: string;
  type: "all" | WorkItemType;
  /** Exact raw-phase match — the board projection does NOT widen this. */
  phase: "all" | WorkItemPhase;
  priority: "all" | WorkItemPriority;
  /** "all" | "manual"（无 external） | 外部源 id（如 "chandao"）。 */
  source: "all" | "manual" | string;
  /** 仅看 阻塞（status blocked）或 待确认（需求/计划确认阶段）的项。 */
  flaggedOnly: boolean;
  /** 列表范围：活动 | 归档 | 回收站（T9 恢复面：只读 + 「从回收站恢复」）。 */
  scope: "active" | "archived" | "trash";
}

export function defaultWorkItemFilters(): WorkItemsFilters {
  return {
    search: "",
    type: "all",
    phase: "all",
    priority: "all",
    source: "all",
    flaggedOnly: false,
    scope: "active",
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

const TYPES = ["all", "requirement", "bug"] as const;
const PRIORITIES = ["all", "P0", "P1", "P2", "P3"] as const;
const SCOPES = ["active", "archived", "trash"] as const;
const ALL_PHASES = [
  "all",
  "intake", "analysis", "requirement_approval", "design", "plan_approval",
  "implementation", "verification", "complete",
  "ready_for_implementation", "release_ready", "released",
] as const;

/** 持久化筛选的守门解析：坏 JSON / 未知枚举值按默认处理（老版本存储或
 * 手改 localStorage 永不崩页面）。source 是开放值域（外部源 id 不可枚举），
 * 字符串即接受；"all"/"manual" 之外的约定同上。 */
export function parseStoredWorkItemFilters(raw: string | null): WorkItemsFilters {
  const defaults = defaultWorkItemFilters();
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
  const record = parsed as Record<string, unknown>;
  const filters: WorkItemsFilters = {
    ...defaults,
    search: typeof record.search === "string" ? record.search : "",
    type: oneOf(record.type, TYPES) ?? "all",
    phase: oneOf(record.phase, ALL_PHASES) ?? "all",
    priority: oneOf(record.priority, PRIORITIES) ?? "all",
    source: typeof record.source === "string" && record.source ? record.source : "all",
    flaggedOnly: typeof record.flaggedOnly === "boolean" ? record.flaggedOnly : false,
    scope: oneOf(record.scope, SCOPES) ?? "active",
  };
  return filters;
}

/** 阻塞 / 待确认标记（列表行徽章与 flaggedOnly 筛选共用）：阻塞 =
 * status blocked；待确认 = 老流程的 需求确认/计划确认 阶段（等人答复）。 */
export function isItemFlagged(item: WorkItemRecord): boolean {
  if (item.status === "blocked") return true;
  return item.phase === "requirement_approval" || item.phase === "plan_approval";
}

export function filterWorkItems(items: WorkItemRecord[], filters: WorkItemsFilters): WorkItemRecord[] {
  const needle = filters.search.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.type !== "all" && item.type !== filters.type) return false;
    if (filters.phase !== "all" && item.phase !== filters.phase) return false;
    if (filters.priority !== "all" && item.priority !== filters.priority) return false;
    if (filters.source === "manual" && item.external) return false;
    if (filters.source !== "all" && filters.source !== "manual" && item.external?.source !== filters.source) return false;
    if (filters.flaggedOnly && !isItemFlagged(item)) return false;
    if (needle) {
      const haystack = `${item.key} ${item.title}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

const PRIORITY_ORDER: Record<WorkItemPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** P0→P3 → updatedAt 倒序 → key 升序稳定。返回排序副本，不改入参。 */
export function sortWorkItems(items: WorkItemRecord[]): WorkItemRecord[] {
  return [...items].sort((left, right) => {
    const byPriority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (byPriority !== 0) return byPriority;
    const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return left.key.localeCompare(right.key);
  });
}
