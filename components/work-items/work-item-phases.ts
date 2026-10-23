import type { WorkItemPhase, WorkItemStatus, WorkItemType } from "@/lib/work-items/types";

/**
 * Phase → board-column projection for the central WorkItemsPage board view
 * (M2 T8, spec §6.2) plus the shared display labels. PURE module (type-only
 * imports) so it is node:test-able and safe in any client bundle.
 *
 * 看板仅展示阶段投影；首版无拖拽跳阶段——阶段操作走明确动作按钮（T9）。
 */

export const BOARD_COLUMNS = [
  "intake",
  "design",
  "ready_for_implementation",
  "implementation",
  "verification",
  "release_ready",
  "released",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** 标准交付流七列的列头标签。 */
export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  intake: "收集",
  design: "设计",
  ready_for_implementation: "待实现",
  implementation: "实现",
  verification: "验证",
  release_ready: "待发布",
  released: "已发布",
};

/** 类型标签（列表行/看板卡片共用）。 */
export const TYPE_LABELS: Record<WorkItemType, string> = {
  requirement: "需求",
  bug: "缺陷",
};

/** 状态标签（详情/列表共用；M2 T9 起与 PHASE_LABELS 同居本模块——中央页组件
 *  不再从 WorkspaceManager 反向导入）。 */
export const STATUS_LABELS: Record<WorkItemStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  blocked: "已阻塞",
  done: "已完成",
  cancelled: "已取消",
};

/** 全量 phase 标签（含老流程子阶段与 complete）：看板卡片上老项显示
 * 原始 phase 标签（不谎报它已进入标准列），列表行同表。 */
export const PHASE_LABELS: Record<WorkItemPhase, string> = {
  intake: "收集",
  analysis: "分析",
  requirement_approval: "需求确认",
  design: "设计",
  plan_approval: "计划确认",
  implementation: "实现",
  verification: "验证",
  complete: "完成",
  ready_for_implementation: "待实现",
  release_ready: "待发布",
  released: "已发布",
};

/** Phase → 看板列：标准列自映射；老流程的设计前子阶段（analysis /
 * requirement_approval / design / plan_approval）全部投影进 design 列；
 * 老 complete 投影进 released（UI 用 isHistoricalComplete 把它收进
 * 「历史已完成」折叠组，不推断已发布）。 */
export function boardColumnForPhase(phase: WorkItemPhase): BoardColumn {
  switch (phase) {
    case "intake":
      return "intake";
    case "analysis":
    case "requirement_approval":
    case "design":
    case "plan_approval":
      return "design";
    case "implementation":
      return "implementation";
    case "verification":
      return "verification";
    case "ready_for_implementation":
      return "ready_for_implementation";
    case "release_ready":
      return "release_ready";
    case "released":
    case "complete":
      return "released";
  }
}

/** 「历史已完成」：老流程的 complete 终态（交付流项以 released 终结，
 * 不会停在 complete，所以 phase 本身即充分判据）。展示上不推断它已发布
 * ——收进看板的「历史已完成」折叠组，released 列只放真正的 released 项。 */
export function isHistoricalComplete(phase: WorkItemPhase): boolean {
  return phase === "complete";
}
