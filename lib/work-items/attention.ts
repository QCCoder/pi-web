// final-arch step-2 Task 5（2026-10-26）：attention 队列（spec §8）——唯一的
// 人工待办投影。不是新存储：nudged/parked 全部由 events.jsonl 里已有事件推导
// （appendEvent 不动 item.yaml——不 bump revision）；泊车复用既有
// automation-paused 机制（writePaused reason=attention-parked），人经既有
// resumeAutomation 恢复。两层（对照 pool.ts 分层）：
//
//   projectAttention —— 纯投影：零 fs，全部输入（项摘要 + readWorkItem 已随读
//     的 events + paused/未确认中断 key 集）由调用方传入；只判定，只排序。
//     kind 与 since 锚点（事件名以代码真实写点为准）：
//       question  任一 delivery.clarifications 未答（answer 缺席）→ since =
//                 最早未答 askedAt，detail = 问题原文，带 clarificationId；
//                 一项只出一条（多问不多条）。
//       confirm   phase==="design" ∧ !designConfirmed → 最近 delivery.start-design
//                 （start-design/confirm-design 人工动作写点），否则 updatedAt。
//       release   phase==="release_ready" ∧ !release → 最近入阶段事件：
//                 delivery.record-verification（人工动作——服务侧校验全 passed）、
//                 delivery.submitted data.outcome==="verified"（verifier 退役前
//                 提交写点）或 delivery.checks_passed data.outcome==="verified"
//                 （system 检查步入阶段写点，finalizeChecks），否则 updatedAt。
//       acceptance final-arch step-4 Task 3：acceptanceEnabled ∧
//                 phase==="release_ready" ∧ 有候选 ∧（无 delivery.acceptance ∨
//                 其 candidateDigest ≠ 当前候选摘要）→ since = release 同一入阶段
//                 锚点（复用谓词），detail = 「待人工验收」。开关在 workspace
//                 config 的 stages.acceptance.enabled——纯投影不读 config，标志
//                 由调用方传入（digests/acceptanceRequired 的注入同款）；匹配的
//                 验收记录落地（record-acceptance）即消失，候选换过则重现。
//       blocked   status==="blocked" ∨ paused 集 ∨ interrupted 集 → 四事件最新者：
//                 delivery.block（detail=block 原因）/ delivery.checks_unverified
//                 （system 检查步环境未就绪写点，detail=未过检查名，缺名
//                 「环境未就绪待修复」）/ delivery.automation_paused
//                 （detail=「自动化已暂停待恢复」——暂停 reason 文本只在
//                 automation-paused.json，纯投影输入只有 key 集）/ 
//                 delivery.exec_interrupted（detail=「执行中断待恢复」，
//                 recordInterruption 写点）；零事件回落 updatedAt（detail 按信号
//                 静态文案）。
//     nudged/parked = events 中 at 严格晚于 since 且 data.kind === kind 的
//     delivery.nudged / delivery.parked（dispatcher 写点；旧事件不算——跨 kind
//     与跨轮次都不串）。排序 P0→P3→key（同 pool），同项多 kind 再按 kind 定序。
//
//   collectAttention —— 读取端装配：managed 项才付详情读（readWorkItem：events
//     已随读，无需单独 reader）+ readPaused + listPendingInterruptions（与
//     pool.ts listDeliveryPool 同一对调用）+ readDeliveryRunnerConfig（一读——
//     stages.acceptance.enabled 进投影输入；nudge/park 阈值仍在 dispatcher）。
//     详情读失败的项跳过：与池子「缺详情不静默消失」不同——attention 的
//     nudge/park 幂等全靠事件推导，读不出事件的项无法可靠判定，宁缺勿错。
import { listPendingInterruptions, readPaused } from "./delivery-runner/attempts.ts";
import { readDeliveryRunnerConfig } from "./delivery-runner/config.ts";
import { candidatesDigest } from "./delivery-types.ts";
import { listWorkItems, readWorkItem } from "./service.ts";
import type { WorkItemEvent, WorkItemRecord } from "./types.ts";
// 类型单一定义处 = api-types（浏览器镜像）；此处 type-only 引用再 re-export——
// 服务端形状与浏览器形状零漂移。
import type { AttentionEntry, AttentionKind } from "../api-types.ts";

export type { AttentionEntry, AttentionKind };
export type { AttentionResponse } from "../api-types.ts";

export interface AttentionInput {
  items: Array<{ item: WorkItemRecord; events: WorkItemEvent[] }>;
  paused: Set<string>;
  interrupted: Set<string>;
  now: Date;
  /** stages.acceptance.enabled（final-arch step-4）——acceptance 待办的可见
   *  开关。纯投影零 fs：标志由调用方读 config 后传入（plan 的 options 注入
   *  同款），缺省关闭 = 开关未开的 workspace 零噪音。 */
  acceptanceEnabled: boolean;
}

const DAY_MS = 86_400_000;
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const UNKNOWN_PRIORITY_RANK = PRIORITY_RANK.P3 + 1;

const PAUSED_DETAIL = "自动化已暂停待恢复";
const INTERRUPTED_DETAIL = "执行中断待恢复";

/** 该类型事件中 at 最新的一条（events.jsonl 是追加序，但按 at 比较更稳健——
 *  测试与人工补写都可能乱序）。 */
function latestEvent(events: WorkItemEvent[], type: string): WorkItemEvent | undefined {
  let newest: WorkItemEvent | undefined;
  for (const event of events) {
    if (event.type !== type) continue;
    if (newest === undefined || event.at > newest.at) newest = event;
  }
  return newest;
}

/** 满足谓词的最新事件（release 锚点：两类事件取时间最新）。 */
function latestEventWhere(
  events: WorkItemEvent[],
  predicate: (event: WorkItemEvent) => boolean,
): WorkItemEvent | undefined {
  let newest: WorkItemEvent | undefined;
  for (const event of events) {
    if (!predicate(event)) continue;
    if (newest === undefined || event.at > newest.at) newest = event;
  }
  return newest;
}

/** 入 release_ready 的事件（人工 record-verification 全 passed / verifier 退役
 *  前的 submitted verified / system 检查步 checks_passed——写点均已服务侧校验
 *  全 passed，人工路径此处防御性复验）。 */
function enteredReleaseReady(event: WorkItemEvent): boolean {
  if (event.type === "delivery.checks_passed") return event.data?.outcome === "verified";
  if (event.type === "delivery.submitted") return event.data?.outcome === "verified";
  if (event.type !== "delivery.record-verification") return false;
  const checks = event.data?.checks;
  return Array.isArray(checks) && checks.every((check) => check?.outcome === "passed");
}

/** 是否存在晚于 sinceMs 的同 kind 标记事件（delivery.nudged / delivery.parked）。 */
function hasKindMarker(
  events: WorkItemEvent[],
  type: "delivery.nudged" | "delivery.parked",
  kind: AttentionKind,
  sinceMs: number,
): boolean {
  return events.some(
    (event) => event.type === type && event.data?.kind === kind && Date.parse(event.at) > sinceMs,
  );
}

function entry(
  item: WorkItemRecord,
  kind: AttentionKind,
  since: string,
  detail: string,
  now: Date,
  events: WorkItemEvent[],
  clarificationId?: string,
): AttentionEntry {
  const sinceMs = Date.parse(since);
  return {
    key: item.key,
    title: item.title,
    kind,
    since,
    ageDays: Math.floor((now.getTime() - sinceMs) / DAY_MS),
    nudged: hasKindMarker(events, "delivery.nudged", kind, sinceMs),
    parked: hasKindMarker(events, "delivery.parked", kind, sinceMs),
    detail,
    ...(clarificationId !== undefined ? { clarificationId } : {}),
  };
}

/** blocked 的 since/detail：各信号的事件锚点取最新，detail 跟随胜出信号；
 *  零事件回落 updatedAt + 按信号静态文案（block 优先，与任务书列举序一致）。
 *  system 检查步的 blocked 不写 delivery.block——checks_unverified 同为锚点
 *  （detail = 未过检查名，缺名回落固定文案）。 */
function blockedSinceDetail(
  item: WorkItemRecord,
  events: WorkItemEvent[],
  paused: Set<string>,
  interrupted: Set<string>,
): { since: string; detail: string } {
  const candidates: Array<{ at: string; detail: string }> = [];
  if (item.status === "blocked") {
    const block = latestEvent(events, "delivery.block");
    if (block !== undefined && typeof block.data?.reason === "string") {
      candidates.push({ at: block.at, detail: block.data.reason });
    }
    const checksUnverified = latestEvent(events, "delivery.checks_unverified");
    if (checksUnverified !== undefined) {
      const raw = checksUnverified.data?.checks;
      const names = Array.isArray(raw)
        ? raw.map((check) => check?.name).filter((name): name is string => typeof name === "string")
        : [];
      candidates.push({
        at: checksUnverified.at,
        detail: names.length > 0 ? names.join("、") : "环境未就绪待修复",
      });
    }
  }
  if (paused.has(item.key)) {
    const automationPaused = latestEvent(events, "delivery.automation_paused");
    if (automationPaused !== undefined) {
      candidates.push({ at: automationPaused.at, detail: PAUSED_DETAIL });
    }
  }
  if (interrupted.has(item.key)) {
    const execInterrupted = latestEvent(events, "delivery.exec_interrupted");
    if (execInterrupted !== undefined) {
      candidates.push({ at: execInterrupted.at, detail: INTERRUPTED_DETAIL });
    }
  }
  if (candidates.length === 0) {
    const detail = item.status === "blocked"
      ? "blocked"
      : paused.has(item.key)
        ? PAUSED_DETAIL
        : INTERRUPTED_DETAIL;
    return { since: item.updatedAt, detail };
  }
  const winner = candidates.reduce((left, right) => (left.at >= right.at ? left : right));
  return { since: winner.at, detail: winner.detail };
}

/** 单项投影：每命中 kind 恰一条；skip 规则（archived/cancelled/released/非
 *  managed）在此把关。 */
function projectItem(
  item: WorkItemRecord,
  events: WorkItemEvent[],
  paused: Set<string>,
  interrupted: Set<string>,
  now: Date,
  acceptanceEnabled: boolean,
): AttentionEntry[] {
  const delivery = item.delivery;
  if (!delivery) return [];
  if (item.archivedAt !== null || item.status === "cancelled" || item.phase === "released") {
    return [];
  }
  const entries: AttentionEntry[] = [];
  const unanswered = (delivery.clarifications ?? []).filter(
    (clarification) => clarification.answer === undefined,
  );
  if (unanswered.length > 0) {
    const earliest = unanswered.reduce((left, right) => (left.askedAt <= right.askedAt ? left : right));
    entries.push(entry(item, "question", earliest.askedAt, earliest.question, now, events, earliest.id));
  }
  if (item.phase === "design" && !delivery.designConfirmed) {
    const start = latestEvent(events, "delivery.start-design");
    entries.push(entry(item, "confirm", start?.at ?? item.updatedAt, "设计待确认", now, events));
  }
  if (item.phase === "release_ready" && !delivery.release) {
    const anchor = latestEventWhere(events, enteredReleaseReady);
    entries.push(entry(item, "release", anchor?.at ?? item.updatedAt, "待登记发布", now, events));
  }
  // acceptance（final-arch step-4 Task 3）：release_ready 且有候选且验收记录
  // 缺失/摘要失准 → 待人工验收。锚点复用 release 的入阶段谓词（同一事件进
  // 阶段，两种待办同起算）；release 类条件不变——两 kind 可并存。
  const candidates = delivery.candidates;
  if (
    acceptanceEnabled
    && item.phase === "release_ready"
    && candidates !== undefined
    && candidates.length > 0
    && delivery.acceptance?.candidateDigest !== candidatesDigest(candidates)
  ) {
    const anchor = latestEventWhere(events, enteredReleaseReady);
    entries.push(entry(item, "acceptance", anchor?.at ?? item.updatedAt, "待人工验收", now, events));
  }
  if (item.status === "blocked" || paused.has(item.key) || interrupted.has(item.key)) {
    const { since, detail } = blockedSinceDetail(item, events, paused, interrupted);
    entries.push(entry(item, "blocked", since, detail, now, events));
  }
  return entries;
}

/**
 * 纯投影：每项零或多条（不同 kind），同 kind 至多一条；输出按 P0→P3→key
 * 升序（未知优先级垫底，同 pool），同项多 kind 按 kind 字典序定序。
 */
export function projectAttention(input: AttentionInput): AttentionEntry[] {
  const projected: Array<{ priority: string; entry: AttentionEntry }> = [];
  for (const { item, events } of input.items) {
    for (
      const attention of projectItem(
        item,
        events,
        input.paused,
        input.interrupted,
        input.now,
        input.acceptanceEnabled,
      )
    ) {
      projected.push({ priority: item.priority, entry: attention });
    }
  }
  projected.sort(
    (left, right) =>
      (PRIORITY_RANK[left.priority] ?? UNKNOWN_PRIORITY_RANK) -
        (PRIORITY_RANK[right.priority] ?? UNKNOWN_PRIORITY_RANK) ||
      left.entry.key.localeCompare(right.entry.key) ||
      left.entry.kind.localeCompare(right.entry.kind),
  );
  return projected.map((projectedEntry) => projectedEntry.entry);
}

/**
 * 读取端：装配后调纯投影（路由与 dispatcher 共用）。managed 项才付详情读；
 * 详情读失败（目录缺失/README 或 events 坏）→ 该项跳过——见模块头「宁缺勿错」。
 */
export async function collectAttention(
  workspacePath: string,
  now: Date = new Date(),
): Promise<AttentionEntry[]> {
  // stages.acceptance.enabled（final-arch step-4）：一读 config 进投影输入
  // （文件缺失 → null = 关）。nudge/park 阈值仍在 dispatcher 消费。
  const runnerConfig = await readDeliveryRunnerConfig(workspacePath);
  const acceptanceEnabled = runnerConfig?.stages?.acceptance?.enabled === true;
  const { items } = await listWorkItems(workspacePath);
  const inputs: AttentionInput["items"] = [];
  const paused = new Set<string>();
  const interrupted = new Set<string>();
  for (const item of items) {
    if (!item.delivery) continue;
    try {
      const detail = await readWorkItem(workspacePath, item.key);
      if (readPaused(detail.path)) paused.add(item.key);
      if ((await listPendingInterruptions(detail.path)).length > 0) interrupted.add(item.key);
      inputs.push({ item: detail.item, events: detail.events });
    } catch {
      // 详情读失败 → 跳过（nudge/park 幂等依赖事件，读不出事件的项不投影）。
    }
  }
  return projectAttention({ items: inputs, paused, interrupted, now, acceptanceEnabled });
}
