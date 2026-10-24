// Phase-3 Task 1: 双角色 TaskPool 投影（designer P2 + developer 谓词，spec
// 2026-10-24-phase-three §3/§1.2）；Phase-4 T1 增第三角色 verifier（spec
// 2026-10-24-phase-four §3：verification 阶段谓词）；Phase-5 T1 增第四角色
// release-preparer（spec 2026-10-25-phase-five §2：release_ready 阶段谓词——
// 纯文档角色，材料准备就是该阶段的活动；T2 增循环闸 carried ruling #1：
// releasePlan 已在场即不再自动重派）。就绪任务不是存储实体——
// 每次查询从文件状态推导。本模块分两层：
//
//   projectDeliveryPool —— 纯投影：零 fs，全部输入（含每项预计算的
//     requirementDigest、manifest 仓库登记表与配置验证命令 checks）由调用方
//     传入；只比较，只排序，只分桶标记。角色由项所处阶段决定（spec §1.2 +
//     phase-four §6 + phase-five §2）：ready_for_implementation → developer
//     （§3 谓词），verification → verifier（phase-four §3 谓词），
//     release_ready → release-preparer（phase-five §2 谓词——verification
//     通过记录在场且 candidateDigest 与当前候选集一致），其余 → designer——
//     designer 谓词保持 P2 行为逐字节不变（非 intake 阶段照旧 wrong-phase，
//     blocked 桶对存量项的投影与 P2 完全一致）。
//
//   listDeliveryPool —— 读取端装配器：listWorkItems（仅活动 items，归档/
//     回收站永不可领）+ 配置（缺文件 = disabled）+ 每项运行时信号（claim /
//     未确认中断 / automation-paused / 失败预算计数——单项经
//     countRecentFailures（尾随连续失败 + resume 窗口），读自 `./attempts.ts`
//     ——静态 import：webpack 打包的 server bundle 里动态相对 import 会
//     ERR_MODULE_NOT_FOUND）+ manifest 仓库登记表（registeredRepos：id →
//     active|removed；manifest 缺失/损坏 → 空登记表——developer 项以
//     repo-not-registered 可见、designer 项不受影响，与运行时信号的 fs 容错
//     同习语）。digest 由读取端计算（contentDigest(README)），纯函数不碰 fs。
import {
  countRecentFailures,
  listPendingInterruptions,
  readClaim,
  readPaused,
} from "./attempts.ts";
import { readDeliveryRunnerConfig, DEFAULT_DELIVERY_RUNNER_CONFIG } from "./config.ts";
import type { DeliveryCheckConfig } from "./config.ts";
import { candidatesDigest, contentDigest } from "../delivery-types.ts";
import type { DeliveryCandidate } from "../delivery-types.ts";
import { listWorkItems, readWorkItem } from "../service.ts";
import { readWorkspaceManifest } from "../../workspaces/service.ts";

/** 投影角色（spec §1.2：执行槽位单槽位跨角色共享，角色由项所处阶段决定；
 *  Phase-4 §6：verifier 为第三角色——单槽位三角色共享；Phase-5 §2：
 *  release-preparer 为第四角色——纯文档角色，同一单槽位与失败预算）。 */
export type DeliveryRole = "designer" | "developer" | "verifier" | "release-preparer";

export type DesignerPoolReason =
  | "not-managed" | "automation-disabled" | "wrong-phase" | "active-claim"
  | "pending-interruption" | "automation-paused" | "failure-limit"
  | "terminal-status" | "archived"
  // developer 专属（spec §3）：设计未确认 / 空仓库范围 / 仓未登记或非 active。
  | "design-unconfirmed" | "no-repo-scope" | "repo-not-registered"
  // verifier 专属（spec 2026-10-24-phase-four §3）：未配置验证命令（引导人
  // 配置或走人工验证）。空候选复用 no-repo-scope（候选即 verifier 的仓范围）、
  // 仓候选外/未登记/removed 复用 repo-not-registered。
  | "no-checks-configured"
  // release-preparer 专属（spec 2026-10-25-phase-five §2）：验证通过记录缺失
  //（release_ready 但无人/verifier 登记过验证——材料必须由验证证据支撑）/
  // 候选被换（verification.candidateDigest 与当前候选集摘要不匹配——旧验证
  // 下的材料不许准备，人须重走验证）。
  | "verification-missing" | "stale-verification"
  // release-preparer 循环闸（Phase-5 T2，T1 review carried ruling #1——spec 级
  // 缺口修复）：releasePlan 已在场（前轮自动准备或人工 prepare-release 写入）
  // ——已准备过的项不再自动重派；人重新起草走人工 prepare-release 路由。无此
  // 闸，自动准备 → submit 写 releasePlan → 池子仍 ready → 下一拍再领再写，
  // 循环刷 attempt。
  | "release-plan-exists";

export interface PoolEntry {
  key: string;
  title: string;
  priority: string;
  /** 读取端预计算（managed 项 = contentDigest(README)，读取失败 = 空；
   *  非 managed 项恒为 ""——纯函数只透传/比较，从不计算）。 */
  requirementDigest: string;
  ready: boolean;
  reasons: DesignerPoolReason[];
  /** 该项当前所处角色的投影（由 phase 决定，见模块头）。 */
  role: DeliveryRole;
}

/** 纯投影的项输入（listDeliveryPool 从 WorkItemRecord 装配）。delivery
 * 只看「块存在与否」（managed 判定）、designConfirmed 真值与 candidates——
 * protocolVersion 校验已在 parseWorkItem 的 delivery 解析路径完成。 */
export interface DeliveryPoolItem {
  key: string;
  title: string;
  priority: string;
  status: string;
  phase: string;
  archivedAt: string | null;
  /** 项的仓库范围（repositoryId 列表）——只有 developer 谓词消费；
   *  designer 不看（P2 语义）。 */
  repositories: string[];
  requirementDigest: string;
  delivery?: {
    protocolVersion: number;
    designConfirmed?: unknown;
    /** 提交的候选（Phase-4 verifier 消费仓范围；Phase-5 release-preparer
     *  消费 candidatesDigest 比对——候选被换即 stale）。 */
    candidates?: DeliveryCandidate[];
    /** 验证通过记录（Phase-5）——只有 release-preparer 谓词消费；纯函数只读
     *  candidateDigest（结构子集即可，读取端透传完整
     *  DeliveryVerificationRecord）。 */
    verification?: { candidateDigest: string };
    /** 发布材料（Phase-5 T2 循环闸）——只有 release-preparer 谓词消费，只看
     *  在场与否（在场 → release-plan-exists，已准备过的项不再自动重派；读取
     *  端透传完整 DeliveryReleasePlan，纯投影不读内容）。 */
    releasePlan?: unknown;
  } | null;
}

export interface DeliveryPoolContext {
  enabled: boolean;
  /** 有活动领取（runtime/claim.json 存在且未失效）的 item key 集。 */
  activeClaims: Set<string>;
  /** 有未确认中断记录（needsAttention）的 item key 集。 */
  pendingInterruptions: Set<string>;
  /** 连续失败达上限后 automation-paused 的 item key 集。 */
  paused: Set<string>;
  /** 每项的失败预算计数（fix-round 裁定 #2：作用域 = 单项——key → 该项的
   *  尾随连续失败数，读取端经 countRecentFailures 按项装配；跨角色共享同一
   *  预算——spec §8 裁定，防 A/B 角色互相刷次数绕上限）。 */
  failureCountByKey: Map<string, number>;
  maxAttemptsPerInput: number;
  /** manifest 仓库登记表（repositoryId → active|removed），读取端从
   *  readWorkspaceManifest 的 repositories[] 装配——developer 与 verifier
   *  谓词消费。 */
  registeredRepos: Map<string, "active" | "removed">;
  /** 配置的验证命令（Phase-4 T1：config.verification.checks，读取端从配置
   *  装配，claim.ts 复验同源）——只有 verifier 谓词消费；undefined / 空数组
   *  = 未配置（no-checks-configured）。 */
  checks?: DeliveryCheckConfig[];
}

/** 可领状态白名单（spec §5.1，T4 carried ruling）：只有 open 与 blocked(可解)
 * 可领。白名单而非黑名单——claim 事务写 status=in_progress 后即使 claim.json
 * 尚未落盘就崩溃，项也不再投影 ready（双派发窗口消除）。 */
const CLAIMABLE_STATUSES: readonly string[] = ["open", "blocked"];
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const UNKNOWN_PRIORITY_RANK = PRIORITY_RANK.P3 + 1;

/** designer 可领阶段（领取事务内流转到 design 后不再可领）。 */
const DESIGNER_READY_PHASE = "intake";
/** developer 可领阶段（spec §3）——也是角色判定：处于该阶段的项按 developer
 * 谓词投影，其余（含 developer 领取后的 implementation）按 designer 谓词
 * （P2 wrong-phase 语义不变）。 */
const DEVELOPER_READY_PHASE = "ready_for_implementation";
/** verifier 可领阶段（Phase-4 spec §3）——角色判定同款：处于该阶段的项按
 *  verifier 谓词投影（claim 不改阶段，验证就是该阶段的活动）。 */
const VERIFIER_READY_PHASE = "verification";
/** release-preparer 可领阶段（Phase-5 spec §2）——角色判定同款：处于该阶段的
 *  项按 release-preparer 谓词投影（claim 不改阶段，准备发布材料就是该阶段的
 *  活动；released 等更后阶段照旧 designer wrong-phase）。 */
const RELEASE_PREPARER_READY_PHASE = "release_ready";

/** 两角色共用的阻塞检查（运行时信号 + 状态白名单 + 归档）。 */
function sharedReasons(item: DeliveryPoolItem, ctx: DeliveryPoolContext): DesignerPoolReason[] {
  const reasons: DesignerPoolReason[] = [];
  if (ctx.activeClaims.has(item.key)) reasons.push("active-claim");
  if (ctx.pendingInterruptions.has(item.key)) reasons.push("pending-interruption");
  if (ctx.paused.has(item.key)) reasons.push("automation-paused");
  if ((ctx.failureCountByKey.get(item.key) ?? 0) >= ctx.maxAttemptsPerInput) {
    reasons.push("failure-limit");
  }
  if (!CLAIMABLE_STATUSES.includes(item.status)) reasons.push("terminal-status");
  if (item.archivedAt !== null) reasons.push("archived");
  return reasons;
}

/** designer 谓词（P2 行为逐字节不变——spec 2026-10-24-phase-two §5.1）：
 * ready ⇔ managed ∧ enabled ∧ phase==="intake" ∧ 共用检查。 */
function designerReasons(item: DeliveryPoolItem, ctx: DeliveryPoolContext): DesignerPoolReason[] {
  const reasons: DesignerPoolReason[] = [];
  if (!item.delivery) reasons.push("not-managed");
  if (!ctx.enabled) reasons.push("automation-disabled");
  if (item.phase !== DESIGNER_READY_PHASE) reasons.push("wrong-phase");
  return [...reasons, ...sharedReasons(item, ctx)];
}

/** developer 谓词（spec §3）：ready ⇔ managed ∧ enabled ∧（阶段由角色判定
 * 保证——只有 ready_for_implementation 的项按本谓词投影）∧ designConfirmed
 * 真值 ∧ 仓库范围非空 ∧ 范围内每个 repositoryId 已登记且 active ∧ 共用检查。 */
function developerReasons(item: DeliveryPoolItem, ctx: DeliveryPoolContext): DesignerPoolReason[] {
  const reasons: DesignerPoolReason[] = [];
  if (!item.delivery) reasons.push("not-managed");
  if (!ctx.enabled) reasons.push("automation-disabled");
  if (!item.delivery?.designConfirmed) reasons.push("design-unconfirmed");
  if (item.repositories.length === 0) {
    reasons.push("no-repo-scope");
  } else if (
    item.repositories.some((repositoryId) => ctx.registeredRepos.get(repositoryId) !== "active")
  ) {
    reasons.push("repo-not-registered");
  }
  return [...reasons, ...sharedReasons(item, ctx)];
}

/** verifier 谓词（Phase-4 spec §3，binding）：ready ⇔ managed ∧ enabled ∧
 * （阶段由角色判定保证——只有 verification 的项按本谓词投影）∧ designConfirmed
 * 真值 ∧ 候选非空 ∧ 配置 checks 非空 ∧ 每个 check 的 repositoryId（缺省=候选
 * 首仓）在候选仓集合内且 manifest 登记 active ∧ 共用检查。空候选 →
 * no-repo-scope（候选即 verifier 的仓范围，与 developer 空范围同因）；checks
 * 未配置/为空 → no-checks-configured（引导人配置或走人工验证）。仓解析检查在
 * 候选/检查齐备前无意义（缺省仓无从解析 / 空集恒空过）——同 developer 的
 * if/elif 结构。 */
function verifierReasons(item: DeliveryPoolItem, ctx: DeliveryPoolContext): DesignerPoolReason[] {
  const reasons: DesignerPoolReason[] = [];
  if (!item.delivery) reasons.push("not-managed");
  if (!ctx.enabled) reasons.push("automation-disabled");
  if (!item.delivery?.designConfirmed) reasons.push("design-unconfirmed");
  const candidates = item.delivery?.candidates ?? [];
  const checks = ctx.checks ?? [];
  if (candidates.length === 0) {
    reasons.push("no-repo-scope");
  } else if (checks.length === 0) {
    reasons.push("no-checks-configured");
  } else {
    const candidateRepoIds = new Set(candidates.map((candidate) => candidate.repositoryId));
    // 缺省 repositoryId = 候选首仓（spec §7）。
    const fallbackRepositoryId = candidates[0].repositoryId;
    const repoViolation = checks.some((check) => {
      const repositoryId = check.repositoryId ?? fallbackRepositoryId;
      return (
        !candidateRepoIds.has(repositoryId) ||
        ctx.registeredRepos.get(repositoryId) !== "active"
      );
    });
    if (repoViolation) reasons.push("repo-not-registered");
  }
  return [...reasons, ...sharedReasons(item, ctx)];
}

/** release-preparer 谓词（Phase-5 spec §2，binding；T2 增循环闸 carried
 *  ruling #1）：ready ⇔ managed ∧ enabled ∧（阶段由角色判定保证——只有
 *  release_ready 的项按本谓词投影）∧ verification 通过记录存在 ∧
 *  verification.candidateDigest === candidatesDigest(当前候选集)（候选未被换
 *  ——旧验证下的材料不许准备，人须重走验证）∧ **releasePlan 未在场**（已
 *  准备过的项不再自动重派——人重新起草走人工 prepare-release 路由）∧ 共用
 *  检查。纯文档角色：不消费 registeredRepos / checks。candidatesDigest 从
 *  delivery-types 引入（纯摘要，零 fs）；候选被清（rework 四清式）时摘要与
 *  记录不匹配，同样落 stale-verification。 */
function releasePreparerReasons(item: DeliveryPoolItem, ctx: DeliveryPoolContext): DesignerPoolReason[] {
  const reasons: DesignerPoolReason[] = [];
  if (!item.delivery) reasons.push("not-managed");
  if (!ctx.enabled) reasons.push("automation-disabled");
  const verification = item.delivery?.verification;
  if (verification === undefined) {
    reasons.push("verification-missing");
  } else if (verification.candidateDigest !== candidatesDigest(item.delivery?.candidates ?? [])) {
    reasons.push("stale-verification");
  }
  if (item.delivery?.releasePlan !== undefined) {
    reasons.push("release-plan-exists");
  }
  return [...reasons, ...sharedReasons(item, ctx)];
}

/**
 * 四角色纯投影：每项按所处阶段选定角色（ready_for_implementation →
 * developer，verification → verifier，release_ready → release-preparer，
 * 其余 → designer）后套该角色谓词。所有命中原因按声明顺序累积（供 UI 与
 * 日志），不短路——多项违例一次看全。输出按 P0→P3→key 升序（未知优先级
 * 垫底）；角色不作 tiebreaker——同优先级跨角色按 key 交错。
 */
export function projectDeliveryPool(
  items: DeliveryPoolItem[],
  ctx: DeliveryPoolContext,
): PoolEntry[] {
  const entries: PoolEntry[] = items.map((item) => {
    const role: DeliveryRole = item.phase === DEVELOPER_READY_PHASE
      ? "developer"
      : item.phase === VERIFIER_READY_PHASE
        ? "verifier"
        : item.phase === RELEASE_PREPARER_READY_PHASE
          ? "release-preparer"
          : "designer";
    const reasons = role === "developer"
      ? developerReasons(item, ctx)
      : role === "verifier"
        ? verifierReasons(item, ctx)
        : role === "release-preparer"
          ? releasePreparerReasons(item, ctx)
          : designerReasons(item, ctx);
    return {
      key: item.key,
      title: item.title,
      priority: item.priority,
      requirementDigest: item.requirementDigest,
      ready: reasons.length === 0,
      reasons,
      role,
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

/** manifest 仓库登记表（id → active|removed）。manifest 缺失/损坏 → 空表
 * （developer/verifier 项以 repo-not-registered 可见，designer 不受影响——池子
 * 读路径的既有 fs 容错习语；dispatcher 路径本就先经 assertAutomationCapable
 * 复验）。 */
async function readRegisteredRepos(
  workspacePath: string,
): Promise<Map<string, "active" | "removed">> {
  try {
    const manifest = await readWorkspaceManifest(workspacePath);
    return new Map(manifest.repositories.map((repo) => [repo.id, repo.status]));
  } catch {
    return new Map();
  }
}

/**
 * 读取端：装配 ctx 后调用纯投影，按 ready/blocked 分桶（各自保持投影排序，
 * 四角色合并在同一队列）。详情读（README → digest + item 目录）只对 managed
 * 项做（未 managed 项的原因无需 digest，恒 ""）；fs 容错：目录/README/events
 * 缺失 → 空内容摘要，项仍被投影（缺项不静默消失）。
 */
export async function listDeliveryPool(
  workspacePath: string,
): Promise<{ ready: PoolEntry[]; blocked: PoolEntry[] }> {
  const [config, { items }, registeredRepos] = await Promise.all([
    readDeliveryRunnerConfig(workspacePath),
    listWorkItems(workspacePath),
    readRegisteredRepos(workspacePath),
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
  const failureCountByKey = new Map<string, number>();
  for (const [key, itemPath] of itemPaths) {
    try {
      if (readClaim(itemPath)) activeClaims.add(key);
      if ((await listPendingInterruptions(itemPath)).length > 0) {
        pendingInterruptions.add(key);
      }
      if (readPaused(itemPath)) paused.add(key);
      // fix-round 裁定 #1/#2：预算 = 单项自最近 resume 以来的尾随连续失败
      // （shared helper 与 claim 事务同一口径；不再跨项按 digest 聚合）。
      failureCountByKey.set(
        key,
        await countRecentFailures(itemPath, requirementDigests.get(key) ?? "", maxAttemptsPerInput),
      );
    } catch {
      // 运行时信号读取失败不阻塞投影：视为该项无信号。
    }
  }

  const entries = projectDeliveryPool(
    items.map((item) => ({
      key: item.key,
      title: item.title,
      priority: item.priority,
      status: item.status,
      phase: item.phase,
      archivedAt: item.archivedAt,
      repositories: item.repositories,
      requirementDigest: requirementDigests.get(item.key) ?? "",
      delivery: item.delivery ?? null,
    })),
    {
      enabled: config?.enabled ?? false,
      activeClaims,
      pendingInterruptions,
      paused,
      failureCountByKey,
      maxAttemptsPerInput,
      registeredRepos,
      checks: config?.verification?.checks,
    },
  );
  return {
    ready: entries.filter((entry) => entry.ready),
    blocked: entries.filter((entry) => !entry.ready),
  };
}
