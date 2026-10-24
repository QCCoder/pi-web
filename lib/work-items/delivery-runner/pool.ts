// Phase-2 Task 2: designer TaskPool 投影（spec 2026-10-24-phase-two §5.1）。
// 就绪任务不是存储实体——每次查询从文件状态推导。本模块分两层：
//
//   projectDesignerPool —— 纯投影：零 fs，全部输入（含每项预计算的
//     requirementDigest）由调用方传入；只比较、只排序、只分桶标记。
//
//   listDesignerPool —— 读取端装配器：listWorkItems（仅活动 items，归档/
//     回收站永不可领）+ Task 1 配置（缺文件 = disabled）+ 每项运行时信号
//     （claim / 未确认中断 / automation-paused / 失败 attempt 计数，读自
//     `./attempts.ts`——静态 import：webpack 打包的 server bundle 里动态
//     相对 import 会 ERR_MODULE_NOT_FOUND → 永久空读 → claimed 项投影为
//     ready，T2 时代的动态 seam 已按 T3 ruling 移除）。digest 由读取端计算
//     （contentDigest(README)），纯函数不碰 fs。
import {
  listAttempts,
  listPendingInterruptions,
  readClaim,
  readPaused,
} from "./attempts.ts";
import { readDeliveryRunnerConfig, DEFAULT_DELIVERY_RUNNER_CONFIG } from "./config.ts";
import { contentDigest } from "../delivery-types.ts";
import { listWorkItems, readWorkItem } from "../service.ts";

export type DesignerPoolReason =
  | "not-managed" | "automation-disabled" | "wrong-phase" | "active-claim"
  | "pending-interruption" | "automation-paused" | "failure-limit"
  | "terminal-status" | "archived";

export interface PoolEntry {
  key: string;
  title: string;
  priority: string;
  /** 读取端预计算（managed 项 = contentDigest(README)，读取失败 = 空；
   *  非 managed 项恒为 ""——纯函数只透传/比较，从不计算）。 */
  requirementDigest: string;
  ready: boolean;
  reasons: DesignerPoolReason[];
}

/** 纯投影的项输入（listDesignerPool 从 WorkItemRecord 装配）。delivery
 *  只看「块存在与否」——managed 判定与 protocolVersion 校验都已在
 *  parseWorkItem 的 delivery 解析路径完成。 */
export interface DesignerPoolItem {
  key: string;
  title: string;
  priority: string;
  status: string;
  phase: string;
  archivedAt: string | null;
  requirementDigest: string;
  delivery?: { protocolVersion: number; designConfirmed?: unknown } | null;
}

export interface DesignerPoolContext {
  enabled: boolean;
  /** 有活动领取（runtime/claim.json 存在且未失效）的 item key 集。 */
  activeClaims: Set<string>;
  /** 有未确认中断记录（needsAttention）的 item key 集。 */
  pendingInterruptions: Set<string>;
  /** 连续失败达上限后 automation-paused 的 item key 集。 */
  paused: Set<string>;
  /** 同 requirementDigest 的 failed attempt 计数（跨项共享输入）。 */
  failedCountByDigest: Map<string, number>;
  maxAttemptsPerInput: number;
}

const TERMINAL_STATUSES: readonly string[] = ["cancelled", "done"];
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const UNKNOWN_PRIORITY_RANK = PRIORITY_RANK.P3 + 1;

/** designer 可领阶段（领取事务内流转到 design 后不再可领）。 */
const READY_PHASE = "intake";

/**
 * 纯投影谓词（spec §5.1）：ready ⇔ managed ∧ enabled ∧ phase==="intake" ∧
 * !activeClaim ∧ !pendingInterruption ∧ !paused ∧ failedCount(digest) < max ∧
 * status 非 cancelled/done ∧ 未归档。所有命中原因按 DesignerPoolReason 声明
 * 顺序累积（供 UI 与日志），不短路——多项违例一次看全。输出按
 * P0→P3→key 升序（未知优先级垫底）。
 */
export function projectDesignerPool(
  items: DesignerPoolItem[],
  ctx: DesignerPoolContext,
): PoolEntry[] {
  const entries: PoolEntry[] = items.map((item) => {
    const reasons: DesignerPoolReason[] = [];
    if (!item.delivery) reasons.push("not-managed");
    if (!ctx.enabled) reasons.push("automation-disabled");
    if (item.phase !== READY_PHASE) reasons.push("wrong-phase");
    if (ctx.activeClaims.has(item.key)) reasons.push("active-claim");
    if (ctx.pendingInterruptions.has(item.key)) reasons.push("pending-interruption");
    if (ctx.paused.has(item.key)) reasons.push("automation-paused");
    if ((ctx.failedCountByDigest.get(item.requirementDigest) ?? 0) >= ctx.maxAttemptsPerInput) {
      reasons.push("failure-limit");
    }
    if (TERMINAL_STATUSES.includes(item.status)) reasons.push("terminal-status");
    if (item.archivedAt !== null) reasons.push("archived");
    return {
      key: item.key,
      title: item.title,
      priority: item.priority,
      requirementDigest: item.requirementDigest,
      ready: reasons.length === 0,
      reasons,
    };
  });
  entries.sort(
    (left, right) =>
      (PRIORITY_RANK[left.priority] ?? UNKNOWN_PRIORITY_RANK) -
        (PRIORITY_RANK[right.priority] ?? UNKNOWN_PRIORITY_RANK) ||
      left.key.localeCompare(right.key),
  );
  return entries;
}

// -------------------------------------------------------------------- read side

/**
 * 读取端：装配 ctx 后调用纯投影，按 ready/blocked 分桶（各自保持投影排序）。
 * 详情读（README → digest + item 目录）只对 managed 项做（未 managed 项
 * 的原因无需 digest，恒 ""）；fs 容错：目录/README/events 缺失 → 空内容
 * 摘要，项仍被投影（缺项不静默消失）。
 */
export async function listDesignerPool(
  workspacePath: string,
): Promise<{ ready: PoolEntry[]; blocked: PoolEntry[] }> {
  const [config, { items }] = await Promise.all([
    readDeliveryRunnerConfig(workspacePath),
    listWorkItems(workspacePath),
  ]);
  const maxAttemptsPerInput =
    config?.budget.maxAttemptsPerInput ??
    DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxAttemptsPerInput;

  // 只为 managed 项付详情读（readWorkItem：item.yaml+README+events 全读，
  // 池子小可接受）；顺带取 item 目录路径供运行时信号读取。
  const requirementDigests = new Map<string, string>();
  const itemPaths = new Map<string, string>();
  for (const item of items) {
    if (!item.delivery) continue;
    try {
      const detail = await readWorkItem(workspacePath, item.key);
      requirementDigests.set(item.key, contentDigest(detail.content));
      itemPaths.set(item.key, detail.path);
    } catch {
      // 目录缺失/详情损坏 → 空内容摘要，投影照常输出该项。
      requirementDigests.set(item.key, contentDigest(""));
    }
  }

  const activeClaims = new Set<string>();
  const pendingInterruptions = new Set<string>();
  const paused = new Set<string>();
  const failedCountByDigest = new Map<string, number>();
  for (const [key, itemPath] of itemPaths) {
    try {
      if (readClaim(itemPath)) activeClaims.add(key);
      if ((await listPendingInterruptions(itemPath)).length > 0) {
        pendingInterruptions.add(key);
      }
      if (readPaused(itemPath)) paused.add(key);
      for (const attempt of await listAttempts(itemPath)) {
        // 形状守卫只保 attemptId+key，digest 仍作运行时防御（手写文件可缺字段）。
        if (
          attempt &&
          attempt.outcome === "failed" &&
          typeof attempt.requirementDigest === "string"
        ) {
          failedCountByDigest.set(
            attempt.requirementDigest,
            (failedCountByDigest.get(attempt.requirementDigest) ?? 0) + 1,
          );
        }
      }
    } catch {
      // 运行时信号读取失败不阻塞投影：视为该项无信号。
    }
  }

  const entries = projectDesignerPool(
    items.map((item) => ({
      key: item.key,
      title: item.title,
      priority: item.priority,
      status: item.status,
      phase: item.phase,
      archivedAt: item.archivedAt,
      requirementDigest: requirementDigests.get(item.key) ?? "",
      delivery: item.delivery ?? null,
    })),
    {
      enabled: config?.enabled ?? false,
      activeClaims,
      pendingInterruptions,
      paused,
      failedCountByDigest,
      maxAttemptsPerInput,
    },
  );
  return {
    ready: entries.filter((entry) => entry.ready),
    blocked: entries.filter((entry) => !entry.ready),
  };
}
