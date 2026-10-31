import type { AttentionEntry, AttentionKind } from "@/lib/api-types";
import type { WorkItemPhase, WorkItemRecord } from "@/lib/work-items/types";
import { BOARD_COLUMNS, boardColumnForPhase } from "./work-item-phases";

/**
 * 手机端工作项列表的分组投影（2026-10 手机原生工作项页，knowledge/designs/mobile-work-items-design.md）。
 * PURE module（仅类型导入 + work-item-phases 纯表）——node:test 可测、任何客户端
 * bundle 安全。
 *
 * 手机上的列表不是「筛选后的平铺」，而是按**动静**分组讲故事：
 *   需要你处理（attention 队列命中）→ 进行中 → 待处理 → 已阻塞 → 已结束（缺省折叠）。
 * 一项只落一组，attention 命中优先——它是 spec §8 唯一的人工待办队列，手机端
 * 的首要工作就是「当那只人的手」。
 */

export type MobileGroupId = "attention" | "in_progress" | "open" | "blocked" | "finished";

export interface MobileGroup {
  id: MobileGroupId;
  label: string;
  items: WorkItemRecord[];
  /** 缺省折叠（已结束组：done + cancelled，看一眼就够）。 */
  collapsedByDefault: boolean;
}

export const MOBILE_GROUP_LABELS: Record<MobileGroupId, string> = {
  attention: "需要你处理",
  in_progress: "进行中",
  open: "待处理",
  blocked: "已阻塞",
  finished: "已结束",
};

/** attention kind 的展示定序与文案（与桌面 AttentionBar 的 KIND_ORDER 一致：
 *  任务书列举序 待答问题 / 待确认设计 / 待登记发布 / 待人工验收 / 阻塞）。 */
export const ATTENTION_KIND_ORDER: readonly AttentionKind[] = ["question", "confirm", "release", "acceptance", "blocked"];

export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  question: "待答问题",
  confirm: "待确认设计",
  release: "待登记发布",
  acceptance: "待人工验收",
  blocked: "阻塞",
};

export interface PrimaryAttention {
  entry: AttentionEntry;
  /** 同项其余 kind 的条目数（行尾「+N」）。 */
  extra: number;
}

/** 每个 key 取一条主条目（按 ATTENTION_KIND_ORDER 取最靠前的 kind）+ 其余条目计数。
 *  API 对同项多 kind 按 kind 字典序输出（blocked < confirm < question < release），
 *  与展示定序不同，所以在这里重排。 */
export function primaryAttentionByKey(entries: AttentionEntry[]): Map<string, PrimaryAttention> {
  const byKey = new Map<string, AttentionEntry[]>();
  for (const entry of entries) {
    const list = byKey.get(entry.key);
    if (list) list.push(entry);
    else byKey.set(entry.key, [entry]);
  }
  const result = new Map<string, PrimaryAttention>();
  for (const [key, list] of byKey) {
    const sorted = [...list].sort(
      (left, right) => ATTENTION_KIND_ORDER.indexOf(left.kind) - ATTENTION_KIND_ORDER.indexOf(right.kind),
    );
    result.set(key, { entry: sorted[0], extra: sorted.length - 1 });
  }
  return result;
}

/**
 * 活动范围分组。输入保持调用方的排序（sortWorkItems：P0→P3 → updatedAt 倒序），
 * 各组内不重排；空组不输出。attention 只覆盖 managed 项，非 managed 的阻塞项落
 * 「已阻塞」组——不会因为不在队列里就看不见。
 */
export function groupActiveWorkItems(
  items: WorkItemRecord[],
  attentionKeys: ReadonlySet<string>,
): MobileGroup[] {
  const buckets: Record<MobileGroupId, WorkItemRecord[]> = {
    attention: [],
    in_progress: [],
    open: [],
    blocked: [],
    finished: [],
  };
  for (const item of items) {
    if (attentionKeys.has(item.key)) {
      buckets.attention.push(item);
      continue;
    }
    switch (item.status) {
      case "in_progress":
        buckets.in_progress.push(item);
        break;
      case "open":
        buckets.open.push(item);
        break;
      case "blocked":
        buckets.blocked.push(item);
        break;
      case "done":
      case "cancelled":
        buckets.finished.push(item);
        break;
    }
  }
  const order: MobileGroupId[] = ["attention", "in_progress", "open", "blocked", "finished"];
  return order
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({
      id,
      label: MOBILE_GROUP_LABELS[id],
      items: buckets[id],
      collapsedByDefault: id === "finished",
    }));
}

/** 阶段轨迹的段数 = 标准交付流七列。 */
export const PHASE_TRACK_LENGTH = BOARD_COLUMNS.length;

/** 阶段 → 轨迹上的位置（0..6）。只对 managed 项（delivery 块）渲染轨迹——
 *  只有它们真的在跑七阶段；老流程项按原始 phase 文案展示，不谎报进了标准列。 */
export function phaseTrackIndex(phase: WorkItemPhase): number {
  return BOARD_COLUMNS.indexOf(boardColumnForPhase(phase));
}
