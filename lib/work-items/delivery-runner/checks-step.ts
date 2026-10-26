// final-arch step-3 Task 3（2026-10-26，先审后跑的执行半）：引擎 system 检查步。
// verifier 角色（Phase-4）退役后，verification 阶段过审项的检查执行不再是 LLM
// 会话的活——dispatcher 每拍先按 checksDue 找 due 项，runChecksStep 以 system
// claim 占单槽位、锁外跑完配置命令、finalizeChecks(actor "system") 结算：
//
//   checksDue —— 纯谓词：due ⇔ managed ∧ enabled ∧ phase==="verification" ∧
//     候选非空 ∧ 配置 checks 非空 ∧ 过审门（review 关闭 ∨ reviewPending=false
//     ——与 pool.ts 角色投影共用同一 reviewPending，永不漂移）∧ 无 verification
//     或其 candidateDigest 与当前候选集不符（checks-done——该候选集已验证过）
//     ∧ 共用门（无 claim ∧ 无未确认中断 ∧ 未 paused ∧ 状态门：open 直跑 /
//       in_progress=人工 unblock 落点可跑 / blocked 等 unblock / 其余 terminal
//       ∧ 未归档）∧
//     仓解析门（每条 check 的 repositoryId 缺省解析候选首仓、须在候选集内且
//     manifest 登记 active—— retired verifier 谓词同款，防 prepareVerifyCheckouts
//     对未登记仓硬炸）。reasons 镜像池 reason 词表 + 本步专属：checks-empty
//     （checks 未配置/空——原 no-checks-configured）、checks-done（同 digest
//     验证记录已在场）、awaiting-review（共用词——欠审等 reviewer）。
//
//   runChecksStep —— 三段事务：
//     锁1 复验 due → 候选 checkout 预建（任何状态落盘之前——失败=零状态，
//       verifier 先例）→ 写 system claim（role "system"、sessionId
//       "system:<ulid>"、candidateDigest/checkContexts 冻结、worktrees、空证据
//       仓；无 ownerToken——ownerTokenHash 空串，结算不经 requireActiveClaim
//       凭据、以 sessionId 归属校验替代）→ status in_progress →
//       delivery.checks_started（actor system）→ commit。
//     锁外 逐条 runConfiguredCheck（真 shell、真候选 checkout）→
//       recordCheckResult（heartbeat 习语累积证据）。顺序执行。
//     锁外 集成段（final-arch step-4 T2，spec §5.3 第四步）：checks 全 passed ∧
//       stages.integrate.enabled（锁1 的 config 读取随身带出——不二读盘上配置）
//       → 逐候选仓（claim.worktrees 冻结序）在 checkout 内跑集成命令：bash -c、
//       cwd = 该仓 checkout、{repositoryId}/{branch} 原样替换、600s 上限；顺序
//       执行、首败短路（余仓不跑，失败现场只报首败仓）。
//     锁2 复读 item+claim（必须仍是本 run 的——否则 skip）+ 阶段守卫 + 候选
//       digest 守卫（中途被换 → 释放 claim 跳过，下一拍按新候选重跑）→
//       finalizeChecks(actor "system")：verified → verification（actor system）
//       + release_ready + delivery.checks_passed；rework → reworkTransition 四清
//       + ready_for_implementation + delivery.checks_failed；unverified →
//       blocked（阶段不动、verification 不写、下游不清——环境问题不是实现
//       失败）+ delivery.checks_unverified。三者均：清 claim、attempt（role
//       system、outcome "submitted" + verificationOutcome 判定——检查步完成
//       了一轮，不计失败；**全步零失败预算**）、commit。无会话自链接。
//       blocked 是硬停：等人工 unblock 才再次 due（spec §5.3「人修环境后
//       unblock 即再次 due」——不自动重试，不 hammer 机器；fix round 1）。
//       集成段失败的结算（integrate-failed）也在锁2 内、守卫同门，落点同
//       unverified 的 blocked 形（阶段不动、verification 不写、下游不清）+
//       delivery.integrate_failed（actor system，data 带首败仓/exitCode|signal/
//       stderr 尾部）+ attempt outcome "failed" + reason（本步唯一带失败语义的
//       终局；仍无失败预算——不写 failure-window、不触暂停）。
//
//   任何异常：清 claim（recordInterruption——needsAttention 中断，人「重新检查
//   并恢复」）后原样重抛（dispatcher catch 记日志）。宿主关停/崩溃的残留
//   system claim 由既有超时清道夫回收（probeSession null → 只记中断）——不设
//   第二套机制。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  commitWorkspaceChanges,
  readWorkspaceManifest,
  withWorkspaceWriteLock,
} from "../../workspaces/service.ts";
import { createUlid } from "../../workspaces/id.ts";
import { candidatesDigest, contentDigest } from "../delivery-types.ts";
import {
  clearClaim,
  listAttempts,
  listPendingInterruptions,
  readClaim,
  readPaused,
  writeAttempt,
  writeClaim,
  type ClaimState,
} from "./attempts.ts";
import {
  assertAutomationCapable,
  readDeliveryRunnerConfig,
} from "./config.ts";
import type { DeliveryCheckConfig } from "./config.ts";
import {
  ensureRuntimeGitignore,
  finalizeChecks,
  freezeCheckContexts,
  recordCheckResult,
  recordInterruption,
} from "./claim.ts";
import {
  deliveryPriorityRank,
  readRegisteredRepos,
  reviewPending,
  type DeliveryPoolItem,
} from "./pool.ts";
import { runConfiguredCheck, type CheckEvidence } from "./checks.ts";
import { appendEvent, eventFor, listWorkItems, readWorkItem, serializeWorkItem, writeAtomic } from "../service.ts";
import type { WorkItemDetail } from "../types.ts";
import { prepareVerifyCheckouts, type RoleWorktree } from "./worktrees.ts";

export type ChecksDueReason =
  | "not-managed" | "automation-disabled" | "wrong-phase"
  // 候选/检查/仓门（retired verifier 谓词同款语义，词表随本步落位）：
  | "no-repo-scope" | "checks-empty" | "repo-not-registered"
  // 先审后跑：欠审等 reviewer（与 pool.ts 角色投影共用 reviewPending 判定）。
  | "awaiting-review"
  // 同 digest 验证记录已在场——该候选集已验证过，不再重跑。
  | "checks-done"
  // 状态门（final-arch step-3 T3 fix round 1，spec §5.3：checks_unverified 落
  // blocked 后「人修环境后 unblock 即再次 due」——不自动重试、不计预算）。
  | "blocked-awaiting-unblock"
  // 共用门（与池 sharedReasons 同词表；失败预算刻意不是本步的门——检查步
  // 无失败预算，attempt outcome submitted 不计不断）。
  | "active-claim" | "pending-interruption" | "automation-paused"
  | "terminal-status" | "archived";

/** checksDue 的运行上下文（config 装配面 + 运行时信号）。与 pool 的
 *  DeliveryPoolContext 同源同形（enabled/registeredRepos/reviewEnabled/checks
 *  ——checks 在投影 ctx 已随 verifier 谓词退役，本处恢复其合法消费方）。 */
export interface ChecksDueContext {
  enabled: boolean;
  activeClaims: Set<string>;
  pendingInterruptions: Set<string>;
  paused: Set<string>;
  /** manifest 仓库登记表（readRegisteredRepos 同源）。 */
  registeredRepos: Map<string, "active" | "removed">;
  /** 配置的验证命令（config.verification.checks；undefined/空 = checks-empty）。 */
  checks?: DeliveryCheckConfig[];
  /** review 阶段开关（config.stages.review.enabled；缺省 false = 旧流程零变化）。 */
  reviewEnabled?: boolean;
}

/**
 * 系统检查步 due 谓词（纯函数零 fs）。原因按声明顺序累积、不短路（与池投影
 * 同习语）：角色/配置原因在前（not-managed → … → checks-done），运行时共用
 * 门在后（active-claim → … → archived）。 */
export function checksDue(
  item: Pick<DeliveryPoolItem, "key" | "status" | "phase" | "archivedAt" | "delivery">,
  ctx: ChecksDueContext,
): { due: boolean; reasons: ChecksDueReason[] } {
  const reasons: ChecksDueReason[] = [];
  if (!item.delivery) reasons.push("not-managed");
  if (!ctx.enabled) reasons.push("automation-disabled");
  if (item.phase !== "verification") reasons.push("wrong-phase");
  const candidates = item.delivery?.candidates ?? [];
  const checks = ctx.checks ?? [];
  if (candidates.length === 0) {
    reasons.push("no-repo-scope");
  } else if (checks.length === 0) {
    reasons.push("checks-empty");
  } else {
    // 仓解析门：每条 check 的 repositoryId（缺省 = 候选首仓）须在候选仓集合内
    // 且 manifest 登记 active——checkout 预建对未登记仓会硬炸，先拦成可见原因。
    const candidateRepoIds = new Set(candidates.map((candidate) => candidate.repositoryId));
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
  // 先审后跑门：review 开启且当前候选集尚未审查通过 → 等 reviewer（与池角色
  // 投影同一 reviewPending——判定永不漂移）。
  if (reviewPending(item, ctx)) reasons.push("awaiting-review");
  const verification = item.delivery?.verification;
  if (
    verification !== undefined &&
    verification.candidateDigest === candidatesDigest(candidates)
  ) {
    reasons.push("checks-done");
  }
  if (ctx.activeClaims.has(item.key)) reasons.push("active-claim");
  if (ctx.pendingInterruptions.has(item.key)) reasons.push("pending-interruption");
  if (ctx.paused.has(item.key)) reasons.push("automation-paused");
  // 状态门（spec §5.3）：blocked = checks_unverified 的落点——硬停等人工
  // unblock（不自动重试）；in_progress 是人工 unblock 的落点（delivery.ts
  // unblock → 非 released 相位落 in_progress），无 claim 即无并发面——解锁后
  // 立即可跑；其余（cancelled/done/released…）沿用池的 terminal-status 词。
  if (item.status === "blocked") reasons.push("blocked-awaiting-unblock");
  else if (item.status !== "open" && item.status !== "in_progress") {
    reasons.push("terminal-status");
  }
  if (item.archivedAt !== null) reasons.push("archived");
  return { due: reasons.length === 0, reasons };
}

/** dispatcher due 扫描的候选（项 + 该项运行时信号装配好的 ctx）。 */
export interface ChecksCandidate {
  key: string;
  priority: string;
  item: DeliveryPoolItem;
  ctx: ChecksDueContext;
}

/**
 * due 扫描的候选装配（dispatcher 默认数据源；全假 dispatcher 测试注入替换）：
 * listWorkItems 的 verification 阶段 managed 项逐个读运行时信号（claim /
 * 未确认中断 / paused——fs 容错，单项读失败视为无信号），config 与 manifest
 * 登记表整批装配一次。输出按 P0→P3→key 升序（pool 投影同一 priority 秩）。
 */
export async function checksCandidatesFor(
  workspacePath: string,
): Promise<ChecksCandidate[]> {
  const [config, { items }, registeredRepos] = await Promise.all([
    readDeliveryRunnerConfig(workspacePath),
    listWorkItems(workspacePath),
    readRegisteredRepos(workspacePath),
  ]);
  const base = {
    enabled: config?.enabled ?? false,
    registeredRepos,
    checks: config?.verification?.checks,
    reviewEnabled: config?.stages?.review?.enabled ?? false,
  };
  const candidates: ChecksCandidate[] = [];
  for (const item of items) {
    if (item.phase !== "verification" || !item.delivery) continue;
    const signals = { claim: false, interrupted: false, paused: false };
    try {
      const detail = await readWorkItem(workspacePath, item.key);
      if (readClaim(detail.path)) signals.claim = true;
      if ((await listPendingInterruptions(detail.path)).length > 0) signals.interrupted = true;
      if (readPaused(detail.path)) signals.paused = true;
    } catch {
      // fs 容错（池子读取端同习语）：运行时信号读失败不阻塞扫描。
    }
    candidates.push({
      key: item.key,
      priority: item.priority,
      item: {
        key: item.key,
        title: item.title,
        priority: item.priority,
        status: item.status,
        phase: item.phase,
        archivedAt: item.archivedAt,
        repositories: item.repositories,
        requirementDigest: "",
        delivery: item.delivery ?? null,
      },
      ctx: {
        ...base,
        activeClaims: signals.claim ? new Set([item.key]) : new Set<string>(),
        pendingInterruptions: signals.interrupted ? new Set([item.key]) : new Set<string>(),
        paused: signals.paused ? new Set([item.key]) : new Set<string>(),
      },
    });
  }
  candidates.sort(
    (left, right) =>
      deliveryPriorityRank(left.priority) - deliveryPriorityRank(right.priority) ||
      left.key.localeCompare(right.key),
  );
  return candidates;
}

// ------------------------------------------------------------------ run step

/** "integrate-failed"（final-arch step-4 T2）：集成段任一候选仓失败——blocked
 *  硬停 + delivery.integrate_failed，检查结算不发生（verification 不写）。 */
export type ChecksStepOutcome = "verified" | "rework" | "unverified" | "skipped" | "integrate-failed";

/** 集成命令的执行上限（spec §5.3 第四步：分钟级集成脚本——10 分钟，模块常量）。 */
export const INTEGRATE_TIMEOUT_MS = 600_000;

/** 集成命令执行入参（command 已完成 {repositoryId}/{branch} 替换）。 */
export interface IntegrateCommandArgs {
  command: string;
  cwd: string;
  timeoutMs: number;
}

/** 集成命令执行结果：ok=false 时 exitCode（正常退出）/ signal（超时等被杀）/
 *  stderrTail（stderr 尾部——默认执行器取 400 字符）至少其一在场。 */
export interface IntegrateCommandResult {
  ok: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals | string;
  stderrTail?: string;
}

export type IntegrateCommandRunner = (args: IntegrateCommandArgs) => IntegrateCommandResult;

const INTEGRATE_STDERR_TAIL_CHARS = 400;
const SPAWN_MAX_BUFFER = 1024 * 1024;

/** 字符串版尾部截断（checks.ts 的 tailText 同语义：超长砍头保尾）。 */
function tailChars(text: string | null | undefined, max: number): string {
  if (text === undefined || text === null || text.length === 0) return "";
  return text.length > max ? text.slice(text.length - max) : text;
}

/** 默认集成命令执行器：spawnSync 经 `bash -c`（集成脚本是整条 shell 命令，
 *  checks 的 /bin/sh 先例同构——bash 允许集成脚本用 bash 语法）、cwd = 候选
 *  checkout、timeout 到点 SIGTERM。signal 判定先于 error：超时（ETIMEDOUT）
 *  也带 signal——它是失败的一种（signal 形状），不是 spawn 失败。 */
function defaultIntegrateCommandRunner(args: IntegrateCommandArgs): IntegrateCommandResult {
  const result = spawnSync("bash", ["-c", args.command], {
    cwd: args.cwd,
    timeout: args.timeoutMs,
    env: process.env,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  const stderrTail = tailChars(result.stderr?.toString("utf8"), INTEGRATE_STDERR_TAIL_CHARS);
  if (result.signal !== null) {
    return { ok: false, signal: result.signal, stderrTail };
  }
  if (result.error != null) {
    return { ok: false, stderrTail: stderrTail || result.error.message };
  }
  if (result.status === 0) return { ok: true };
  return { ok: false, exitCode: result.status ?? undefined, stderrTail };
}

/** deps 注入缝（错误注入测试；默认真执行器）。 */
export interface ChecksStepDeps {
  runCheck?: typeof runConfiguredCheck;
  /** 集成命令执行缝（默认 spawnSync bash——见 defaultIntegrateCommandRunner）：
   *  测试注入假执行器钉住 signal/超时形状。 */
  integrateCommandRunner?: IntegrateCommandRunner;
}

/** 锁1 的产物（锁外执行与锁2 结算的归属凭据）。 */
interface StartedChecksRun {
  sessionId: string;
  attemptId: string;
  itemPath: string;
  claim: ClaimState;
  /** stages.integrate 快照（锁1 的 config 读取随身带出——锁外集成段不二读盘上
   *  配置，与 claim 冻结的候选/检查快照同拍一致）。 */
  integrate: { enabled: boolean; command?: string };
}

/** 锁1：复验 due → checkout 预建（零状态失败面）→ system claim → in_progress →
 *  delivery.checks_started → commit。不 due → null（调用方返回 skipped）。 */
async function startChecksRun(
  workspacePath: string,
  key: string,
): Promise<StartedChecksRun | null> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    const itemPath = current.path;

    // 事务内双检（claim 事务同习语）：config + 运行时信号装配后逐条复验。
    const [config, manifest] = await Promise.all([
      readDeliveryRunnerConfig(workspacePath),
      readWorkspaceManifest(workspacePath),
    ]);
    assertAutomationCapable(manifest);
    const ctx: ChecksDueContext = {
      enabled: config?.enabled ?? false,
      activeClaims: readClaim(itemPath) !== null ? new Set([key]) : new Set<string>(),
      pendingInterruptions: (await listPendingInterruptions(itemPath)).length > 0
        ? new Set([key])
        : new Set<string>(),
      paused: readPaused(itemPath) !== null ? new Set([key]) : new Set<string>(),
      registeredRepos: new Map(manifest.repositories.map((repo) => [repo.id, repo.status])),
      checks: config?.verification?.checks,
      reviewEnabled: config?.stages?.review?.enabled ?? false,
    };
    const requirementDigest = contentDigest(current.content);
    const verdict = checksDue(
      {
        key: current.item.key,
        status: current.item.status,
        phase: current.item.phase,
        archivedAt: current.item.archivedAt,
        delivery: current.item.delivery ?? null,
      },
      ctx,
    );
    if (!verdict.due) return null;

    const candidates = current.item.delivery?.candidates ?? [];
    const generation =
      (await listAttempts(itemPath)).reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
    const attemptId = createUlid();
    const sessionId = `system:${createUlid()}`;
    const now = new Date();

    // 候选 checkout 预建在任何状态落盘之前（verifier 先例）：任一仓失败整体
    // 抛——claim/gitignore/item.yaml/事件全未写（零状态）。
    const repoPaths = new Map(
      manifest.repositories
        .filter((repo) => repo.status === "active")
        .map((repo) => [repo.id, join(workspacePath, repo.path)]),
    );
    const worktrees = await prepareVerifyCheckouts(
      workspacePath,
      { key: current.item.key },
      candidates,
      generation,
      repoPaths,
    );

    // 冻结快照（claim 事务同源）：候选摘要 + 检查配置（缺省仓解析为候选首仓）。
    const candidateDigest = candidatesDigest(candidates);
    const checkContexts = freezeCheckContexts(ctx.checks, candidates[0].repositoryId);

    await ensureRuntimeGitignore(workspacePath);
    // system claim：无 ownerToken（结算以 sessionId 归属校验，不经
    // requireActiveClaim 凭据）——ownerTokenHash 空串占位。
    writeClaim(itemPath, {
      attemptId,
      generation,
      role: "system",
      sessionId,
      claimedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      requirementDigest,
      ownerTokenHash: "",
      candidateDigest,
      worktrees,
      checkContexts,
      checkResults: [],
    });

    // 状态后改：phase 不变（verification 就是检查步的活动阶段）、status
    // in_progress + revision+1。
    const next = structuredClone(current.item);
    next.status = "in_progress";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.checks_started", "system", undefined, {
        attemptId,
        generation,
        candidateDigest,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(workspacePath, `workspace: delivery checks ${key}`);
    const claim = readClaim(itemPath);
    if (claim === null) {
      throw new Error(`system claim for ${key} vanished right after write`);
    }
    return { sessionId, attemptId, itemPath, claim, integrate: config?.stages?.integrate ?? { enabled: false } };
  });
}

/** 锁外执行：逐条配置命令在候选 checkout 内真跑（runConfiguredCheck——日志
 *  落盘、证据产物），recordCheckResult heartbeat 习语累积进 claim。顺序执行；
 *  归属丢失（他人释放/中断）即停——锁2 结算按 skip 处理。返回本轮证据（集成
 *  段据其判定「全 passed」）；null = claim 中途丢失（后续全按 skip 走）。 */
async function executeChecks(
  workspacePath: string,
  key: string,
  run: StartedChecksRun,
  runCheck: typeof runConfiguredCheck,
): Promise<CheckEvidence[] | null> {
  const logDir = join(run.itemPath, "delivery", "artifacts", "verification-logs", run.attemptId);
  const checkoutByRepo = new Map(
    (run.claim.worktrees ?? []).map((worktree: RoleWorktree) => [worktree.repositoryId, worktree.path]),
  );
  const evidence: CheckEvidence[] = [];
  for (const context of run.claim.checkContexts ?? []) {
    const checkoutPath = checkoutByRepo.get(context.repositoryId);
    if (checkoutPath === undefined) {
      throw new Error(
        `checks step is missing the candidate checkout for repository ${context.repositoryId}`,
      );
    }
    // ClaimCheckContext 是 DeliveryCheckConfig 的已解析超集（repositoryId 必填）——
    // 执行器只消费 name/command/timeout_seconds。
    const evidenceEntry = runCheck(context as DeliveryCheckConfig, checkoutPath, logDir);
    evidence.push(evidenceEntry);
    const recorded = await recordCheckResult(workspacePath, key, run.sessionId, evidenceEntry);
    if (!recorded) return null; // claim 已不归本 run——结算阶段按 skip 走
  }
  return evidence;
}

/** 锁2：归属/阶段/候选 digest 三重守卫后经 finalizeChecks(actor "system") 结算
 *  （verified / rework / unverified 三终局 + 事件 + attempt + 清 claim + commit
 *  都在共享结算里）。守卫失配 → 释放领取跳过（结算借走的 in_progress 归还
 *  open——白名单否则把项永久排除在重跑之外）——不是错误：迟到结算不得覆写
 *  他人的新状态，下一拍 checksDue 按新输入复评（自愈）。 */
async function settleChecksRun(
  workspacePath: string,
  key: string,
  sessionId: string,
  attemptId: string,
): Promise<ChecksStepOutcome> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current: WorkItemDetail = await readWorkItem(workspacePath, key);
    const itemPath = current.path;
    const claim = readClaim(itemPath);
    if (claim === null || claim.sessionId !== sessionId || claim.attemptId !== attemptId) {
      return "skipped";
    }
    // 阶段守卫（verifier submit 同款）：人在窗口内推进（手工 record-verification
    // 等）→ 迟到结算不得覆写人的新状态。
    // 候选 digest 守卫（candidateDigest 复验的 system 形态）：候选中途被换
    // （人手工 rework/重提交）→ 本轮证据失准。两者同款释放：清 claim + 状态
    // 归还，无结算无事件（checks_started 之后没有终局事件——下一拍按新输入
    // 重开的 checks_started 自然接上时间线）。
    const phaseStale = current.item.phase !== "verification";
    const digestStale = claim.candidateDigest
      !== candidatesDigest(current.item.delivery?.candidates ?? []);
    if (phaseStale || digestStale) {
      clearClaim(itemPath);
      if (current.item.status === "in_progress") {
        const next = structuredClone(current.item);
        next.status = "open";
        next.revision += 1;
        next.updatedAt = new Date().toISOString();
        await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
      }
      return "skipped";
    }
    const finalized = await finalizeChecks({
      workspacePath,
      current,
      claim,
      actor: "system",
    });
    return finalized.outcome;
  });
}

/** 集成段的单仓失败现场（settleIntegrateFailure 的输入——首败仓）。 */
interface IntegrateFailure {
  repositoryId: string;
  exitCode?: number;
  signal?: NodeJS.Signals | string;
  stderrTail?: string;
}

/** 锁外集成段（spec §5.3 第四步）：checks 全 passed 后逐候选仓（claim.worktrees
 *  冻结序）跑集成命令——{repositoryId}/{branch} 原样替换、cwd = 该仓 checkout、
 *  600s 上限。顺序执行、首败短路（余仓不跑——失败现场只报首败仓）。返回 null
 *  = 全部成功（结算照旧走 finalizeChecks）。 */
function runIntegrateSegment(
  run: StartedChecksRun,
  integrateCommandRunner: IntegrateCommandRunner,
): IntegrateFailure | null {
  const template = run.integrate.command ?? "";
  for (const worktree of run.claim.worktrees ?? []) {
    const command = template
      .replaceAll("{repositoryId}", worktree.repositoryId)
      .replaceAll("{branch}", worktree.branch);
    const result = integrateCommandRunner({
      command,
      cwd: worktree.path,
      timeoutMs: INTEGRATE_TIMEOUT_MS,
    });
    if (!result.ok) {
      return {
        repositoryId: worktree.repositoryId,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.signal !== undefined ? { signal: result.signal } : {}),
        ...(result.stderrTail !== undefined && result.stderrTail !== ""
          ? { stderrTail: result.stderrTail }
          : {}),
      };
    }
  }
  return null;
}

/** 锁2（integrate-failed 终局，final-arch step-4 T2）：守卫与 settleChecksRun
 *  同门（claim 归属 / 阶段 / 候选 digest——失配即 skipped，迟到结算不得覆写
 *  他人的新状态）。落定同 unverified 的 blocked 形（阶段不动——verification
 *  就是集成活动的阶段、verification 不写、下游不清）：status blocked + 事件
 *  delivery.integrate_failed（actor system，data 带首败仓 / exitCode|signal /
 *  stderr 尾部）→ 清 claim → attempt outcome "failed" + reason（本步唯一带
 *  失败语义的终局；**无失败预算**——不写 failure-window、不触暂停）→ commit。 */
async function settleIntegrateFailure(
  workspacePath: string,
  key: string,
  sessionId: string,
  attemptId: string,
  failure: IntegrateFailure,
): Promise<ChecksStepOutcome> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current: WorkItemDetail = await readWorkItem(workspacePath, key);
    const itemPath = current.path;
    const claim = readClaim(itemPath);
    if (claim === null || claim.sessionId !== sessionId || claim.attemptId !== attemptId) {
      return "skipped";
    }
    // 阶段/候选 digest 守卫（settleChecksRun 同款）：窗口内被人推进/换候选 →
    // 本轮现场失准，释放领取跳过（不落自己的终局）。
    const phaseStale = current.item.phase !== "verification";
    const digestStale = claim.candidateDigest
      !== candidatesDigest(current.item.delivery?.candidates ?? []);
    if (phaseStale || digestStale) {
      clearClaim(itemPath);
      if (current.item.status === "in_progress") {
        const next = structuredClone(current.item);
        next.status = "open";
        next.revision += 1;
        next.updatedAt = new Date().toISOString();
        await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
      }
      return "skipped";
    }
    const now = new Date();
    const next = structuredClone(current.item);
    next.status = "blocked";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.integrate_failed", "system", undefined, {
        repositoryId: failure.repositoryId,
        ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
        ...(failure.signal !== undefined ? { signal: failure.signal } : {}),
        ...(failure.stderrTail !== undefined ? { stderrTail: failure.stderrTail } : {}),
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );
    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: claim.role,
      sessionId: claim.sessionId,
      workspacePath,
      key: current.item.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "failed",
      reason: `integrate failed (${failure.repositoryId})`,
      requirementDigest: claim.requirementDigest,
      worktrees: claim.worktrees,
      checkResults: claim.checkResults,
    });
    await commitWorkspaceChanges(workspacePath, `workspace: delivery integrate ${key}`);
    return "integrate-failed";
  });
}

/**
 * 系统检查步入口（dispatcher 每拍对首个 due 项调用，fire-and-forget）。返回
 * 终局词（"skipped" = 锁内复验/守卫判定本轮不开跑或不结算——不是错误）。
 * 集成段（final-arch step-4 T2）：checks 全 passed ∧ stages.integrate.enabled →
 * 锁外逐候选仓跑集成命令（runIntegrateSegment），任一失败 → settleIntegrate-
 * Failure（"integrate-failed"）；全成功 → 结算照旧（verified/rework/unverified
 * 分支零变化）。任何异常：recordInterruption 清 claim + 记 needsAttention 中断
 * 后原样重抛。
 */
export async function runChecksStep(
  workspacePath: string,
  key: string,
  deps: ChecksStepDeps = {},
): Promise<ChecksStepOutcome> {
  const runCheck = deps.runCheck ?? runConfiguredCheck;
  const integrateCommandRunner = deps.integrateCommandRunner ?? defaultIntegrateCommandRunner;
  let sessionId = "";
  try {
    const started = await startChecksRun(workspacePath, key);
    if (started === null) return "skipped";
    sessionId = started.sessionId;
    const evidence = await executeChecks(workspacePath, key, started, runCheck);
    if (evidence !== null && started.integrate.enabled === true) {
      // 集成段前置判断：checks 全 passed 才跑——有 failed/unverified 的轮次由
      // finalizeChecks 按原语义结算（rework/unverified），不叠加集成。
      const contexts = started.claim.checkContexts ?? [];
      const allPassed = contexts.every((context) =>
        evidence.some((entry) => entry.name === context.name && entry.outcome === "passed"));
      if (allPassed) {
        const failure = runIntegrateSegment(started, integrateCommandRunner);
        if (failure !== null) {
          return await settleIntegrateFailure(
            workspacePath, key, sessionId, started.attemptId, failure,
          );
        }
      }
    }
    return await settleChecksRun(workspacePath, key, sessionId, started.attemptId);
  } catch (error) {
    if (sessionId !== "") {
      // 清 claim + needsAttention 中断（人「重新检查并恢复」）；释放自身的
      // 失败不再包裹——原错误才是要抛给 dispatcher 的现场。
      await recordInterruption(workspacePath, key, sessionId, "checks step failed")
        .catch(() => {});
    }
    throw error;
  }
}
