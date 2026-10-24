// Phase-2 Task 4: ClaimService 领取事务（spec 2026-10-24-phase-two §5.2）。
// claim / submit / fail 全部在 withWorkspaceWriteLock 窗口内（M2 双层写锁，
// 与 pi-loop CLI 等外部写者互斥）；heartbeat 无业务锁（原子写回 + 归属校验）。
//
// 服务函数收 workspacePath（T4 裁定——与 T2 读取端一致的测试缝；路由层做
// id→path 转换）。事务内双检：Dispatcher 的池子发现只是提示，领取才是权威
// ——capability（manifest 复验 assertAutomationCapable）+ 配置 + 纯投影谓词
// （复用 projectDeliveryPool，claim 与池子永不漂移）逐条复验后才流转。
//
// 写入顺序（崩溃窗口语义）：
//   产物先落盘、状态后改——design.md 播种 → runtime/ gitignore 接线 →
//   claim.json（先于 item.yaml：窗口内崩溃时 active-claim 标记已在场，池子
//   不投影 ready；即便 claim.json 也没写进去，status=in_progress 已被白名单
//   谓词排除——双派发窗口两头都堵死）→ item.yaml → 事件 → workspace git。
//
// 与 M2 的关系：
//   - design.md 播种复用 delivery.ts 的 DESIGN_SEED（同一模板串，两个动作
//     路径不得漂移）；design.md 写入不走 updateDesignContent——它自取
//     withWorkspaceWriteLock（不可重入，会自锁死）且签名绑 workspaceId/
//     expectedRevision，故按其实现同构锁内直写 + 自记 design_updated 事件。
//     designer 提交时设计必未确认（claim 谓词要求 phase=intake，而
//     designConfirmed 只在 design 之后阶段存在）——M2「已确认设计变更失效」
//     规则天然不触发；若人在领取窗口内抢先 confirm-design（路径上可能，
//     播种模板即非空 design.md），submit 以 Conflict 拒绝，不让确认证据
//     静默过期。
//   - item.yaml 的 delivery.lastRequest 是 M2 动作幂等指纹（action 枚举不
//     含 claim）——claim 的幂等指纹存 claim.json 的 lastRequest（T3 契约）。
//
// Phase-3 Task 3（developer 三函数）：claimDeveloperTask / submitDeveloperResult /
// failDeveloperTask 与 designer 共用同一套重放/并发/复验骨架（poolRecheck 装配
// 两角色同源，永不漂移）。差异面：
//   - claim：prepareWorktrees 在任何状态落盘【之前】（P2 语义——失败=零状态，
//     已建孤儿 worktree 无害）；designDigest 锁内自算快照（T1 carried ruling）；
//     phase ready_for_implementation→implementation。
//   - submit：M2 submit-verification 语义同构内联（不调 applyDeliveryAction——
//     其自取 withWorkspaceWriteLock 不可重入，designer design.md 直写同款先例）；
//     候选核验走 verifyCandidateCommits（范围仓=领取时预建的 worktree 集）；
//     双 digest 复验 + designConfirmed 真值 + 阶段未被人推进，任一漂移 →
//     Conflict（迟到会话不得基于被改过的输入提交，也不得覆写新状态）。
//   - fail：回退守卫仅当仍停 implementation（人的中途动作改了阶段不回滚）；
//     失败预算按 digest 跨角色共享（countRecentFailures 天然跨角色，无需改）。
//
// Phase-4 Task 3（verifier 三函数 + recordCheckResult，spec 2026-10-24-phase-four
// §4/§5）：与 designer/developer 共用同一套重放/并发/复验骨架。差异面：
//   - claim：候选 detached checkout（prepareVerifyCheckouts）在任何状态落盘之前
//     （失败=零状态）；phase 不变（verification 就是验证活动的阶段）、status
//     in_progress；claim.json 冻结 candidateDigest + checkContexts（领取时的检查
//     配置快照——repositoryId 缺省解析为候选首仓；submit 完整性与 run_check 的
//     配置查找都以它为准，配置变更不追溯）+ checkResults 空证据仓。
//   - submit：三凭据 + role 门 + candidateDigest 复验（候选被换 → 409）+ 阶段
//     守卫（人在窗口内推进 → 409）；证据只能来自 claim.checkResults（服务端
//     runConfiguredCheck 经 recordCheckResult 累积——LLM 无注入口），按
//     checkContexts 逐名比对：缺名 → Validation；unverified → Validation 零变化
//     （最终口径：submit 是终局动作，环境问题重跑或 fail(blocked)，不静默
//     blocked）；有 failed → M2 rework 四清同构内联 + delivery.rework_suggested；
//     全 passed → delivery.verification（actor=agent + evidence 组装）+ phase→
//     release_ready。delivery.verification 写入需要 delivery-types 的 actor
//     "user"|"agent" 放宽（只此一块——designConfirmed/release 仍 user-only）。
//   - fail：verifier claim 不改阶段——无阶段可归还（fail 与 recordInterruption
//     的 give-back 对 verifier 都是 verification→verification 零变化，只归还
//     status）。
//   - recordCheckResult：无业务锁轻量（heartbeat 习语）——claim.sessionId 匹配
//     才写，同名覆盖/新名追加，原子写回。
//
// Phase-5 Task 1（release-preparer 三函数，spec 2026-10-25-phase-five §2）：
// 与 designer/developer/verifier 共用同一套重放/并发/复验骨架。差异面：
//   - claim：**无环境预建**（纯文档角色——跳过 prepareXxx，零 git 操作）；
//     phase 不变（release_ready 就是准备材料的阶段）、status in_progress；
//     claim.json 只带 role + candidateDigest 快照（同 verifier 先例——submit
//     侧字符串复验候选未被换）。
//   - submit：requireActiveClaim 三凭据 + role 门 + candidateDigest 复验（候选
//     被换 → 409）+ 阶段守卫（人在窗口内 record-release → 409，冻结基线不得
//     覆写）+ verification 仍在场（材料必须由验证证据支撑——块被清 → 409）→
//     delivery.releasePlan = {notes, rollback?}（M2 prepare-release 语义的
//     actor=agent 变体：只写材料，phase 保持 release_ready 等人 record-release，
//     不触发布、不写 release 块）+ status→open。
//   - fail：release-preparer claim 不改阶段——无阶段可归还（release_ready→
//     release_ready 零变化，只归还 status，verifier 同款）。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commitWorkspaceChanges,
  readWorkspaceManifest,
  withWorkspaceWriteLock,
} from "../../workspaces/service.ts";
import { createUlid } from "../../workspaces/id.ts";
import type { WorkspaceManifest } from "../../workspaces/types.ts";
import { DESIGN_SEED } from "../delivery.ts";
import { candidatesDigest, contentDigest } from "../delivery-types.ts";
import {
  WorkItemConflictError,
  WorkItemValidationError,
} from "../errors.ts";
import {
  appendEvent,
  eventFor,
  readWorkItem,
  serializeWorkItem,
  writeAtomic,
} from "../service.ts";
import type { WorkItemDetail, WorkItemPhase, WorkItemRecord } from "../types.ts";
import {
  clearClaim,
  clearPaused,
  countRecentFailures,
  hashOwnerToken,
  listAttempts,
  listPendingInterruptions,
  readClaim,
  readPaused,
  writeAttempt,
  writeClaim,
  writeFailureWindow,
  writePaused,
  type AttemptRecord,
  type ClaimCheckContext,
  type ClaimState,
} from "./attempts.ts";
import type { CheckEvidence } from "./checks.ts";
import {
  assertAutomationCapable,
  DEFAULT_DELIVERY_RUNNER_CONFIG,
  readDeliveryRunnerConfig,
} from "./config.ts";
import type { DeliveryCheckConfig } from "./config.ts";
import { projectDeliveryPool, type DeliveryPoolContext, type PoolEntry } from "./pool.ts";
import { prepareVerifyCheckouts, prepareWorktrees, verifyCandidateCommits } from "./worktrees.ts";

export interface ClaimGrant {
  attemptId: string;
  generation: number;
  /** 明文 ownerToken 只在首次授予时返回一次（进程内 role grant 持有）；
   *  幂等重放无法重建明文 → 空串，调用方（工具层）对 replayed 不再核发。 */
  ownerToken: string;
  key: string;
  item: WorkItemDetail;
}

export interface ClaimInput {
  workspacePath: string;
  key: string;
  sessionId: string;
  requestId: string;
}

export interface SubmitDesignInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  designContent: string;
  acceptanceCriteria: string[];
  requestId: string;
  conversationId?: string;
}

export interface FailInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  reason: string;
  blocked?: boolean;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkItemValidationError(`${field} is required`);
  }
  return value.trim();
}

function designPathFor(itemPath: string): string {
  return join(itemPath, "delivery", "artifacts", "design.md");
}

async function readDesignFile(designPath: string): Promise<string | undefined> {
  try {
    return await readFile(designPath, "utf8");
  } catch {
    return undefined;
  }
}

// ------------------------------------------------ runtime/ gitignore wiring

const RUNTIME_GITIGNORE_ENTRY = ".pi/work-items/**/delivery/runtime/";

/** T3 carried ruling：claim 首写 runtime/ 时把该路径幂等接进工作区 .gitignore
 *  （文件缺失则创建，已含则不动；attempts/ 审计目录是事实源，不入 ignore）。
 *  读-改-写发生在 claim 事务锁内，无并发压力。 */
async function ensureRuntimeGitignore(workspacePath: string): Promise<void> {
  const gitignorePath = join(workspacePath, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }
  if (current.split("\n").some((line) => line.trim() === RUNTIME_GITIGNORE_ENTRY)) return;
  const prefix = current === ""
    ? ""
    : `${current}${current.endsWith("\n") ? "" : "\n"}`;
  await writeAtomic(
    gitignorePath,
    `${prefix}\n# delivery automation runtime state (advisory — claim.json / heartbeat)\n${RUNTIME_GITIGNORE_ENTRY}\n`,
  );
}

// -------------------------------------------------------- shared verification

/** developer 版附加校验（T3）：requireActiveClaim 可选参——designer 调用方
 *  不传即 P2 语义零变化。expectedRequirementDigest 无对应开关：README 侧的
 *  摘要复验 P2 起无条件常开（那本身就是期望值比对），加开关只会是死代码。 */
interface ActiveClaimExpectations {
  /** 活动 claim 必须由该角色持有（角色间不得互释对方的 claim——verifier 的
   *  submit/fail 不得释放 designer/developer 的 claim，反之亦然；Phase-5 起
   *  release-preparer 同门——四角色凭证互不通用）。 */
  expectedRole?: "designer" | "developer" | "verifier" | "release-preparer";
  /** true = designDigest 复验：claim 领取时的 design.md 摘要快照必须仍等于
   *  锁内重算的当前 design.md contentDigest（developer submit 专用——
   *  designer claim 无该字段）。 */
  expectedDesignDigest?: boolean;
  /** true = candidateDigest 复验（verifier 与 release-preparer 用，Phase-4 T3 /
   *  Phase-5 T1）：claim 领取时的候选集摘要快照（字符串）必须仍等于当前候选集
   *  的 candidatesDigest——人在领取窗口内 rework 清候选 / 换候选重提交都会漂移
   *  → 409 释放重领。 */
  expectedCandidateDigest?: boolean;
}

/** submit/fail 共用的锁内校验：claim 存在 ∧ attemptId/generation/ownerToken
 *  匹配 ∧ requirementDigest 与领取时一致（README 被人改过 → 409 要求重领）
 *  ∧ 项未被人在领取窗口内 cancel（终态不得被迟到会话复活——Phase-3 final
 *  review finding；recordInterruption/heartbeat 直读 claim 不经此处，恢复
 *  路径不受影响）。凭证/状态过期一律 Conflict——迟到会话不得改动新状态。 */
async function requireActiveClaim(
  workspacePath: string,
  key: string,
  credentials: { attemptId: string; generation: number; ownerToken: string },
  expectations?: ActiveClaimExpectations,
): Promise<{ detail: WorkItemDetail; claim: ClaimState }> {
  const detail = await readWorkItem(workspacePath, key);
  const claim = readClaim(detail.path);
  if (claim === null) {
    throw new WorkItemConflictError(`no active claim on ${key} — claim it first`);
  }
  if (expectations?.expectedRole !== undefined && claim.role !== expectations.expectedRole) {
    throw new WorkItemConflictError(
      `claim on ${key} is held by the ${claim.role} role — these credentials cannot release it`,
    );
  }
  if (claim.attemptId !== credentials.attemptId || claim.generation !== credentials.generation) {
    throw new WorkItemConflictError(
      `claim credentials are stale (active claim: ${claim.attemptId} generation ${claim.generation})`,
    );
  }
  if (claim.ownerTokenHash !== hashOwnerToken(credentials.ownerToken)) {
    throw new WorkItemConflictError("ownerToken does not match the active claim");
  }
  // 人在领取窗口内 cancel（M2 cancel 只写 status=cancelled，phase/digest/
  // designConfirmed 不动——其余守卫全拦不住）→ 领取已陈旧，迟到会话不得
  // 复活终态项。恢复路径（recordInterruption 清残留 claim）不经本函数。
  if (detail.item.status === "cancelled") {
    throw new WorkItemConflictError(
      "item was cancelled while the claim was active — release the claim and end",
    );
  }
  const requirementDigest = contentDigest(detail.content);
  if (claim.requirementDigest !== requirementDigest) {
    throw new WorkItemConflictError(
      "requirement changed since the claim (digest mismatch) — re-claim the item",
    );
  }
  if (expectations?.expectedDesignDigest === true) {
    const designContent = await readDesignFile(designPathFor(detail.path));
    if (claim.designDigest !== contentDigest(designContent ?? "")) {
      throw new WorkItemConflictError(
        "input changed since claim — release via fail and re-claim",
      );
    }
  }
  if (expectations?.expectedCandidateDigest === true) {
    const current = candidatesDigest(detail.item.delivery?.candidates ?? []);
    if (claim.candidateDigest !== current) {
      throw new WorkItemConflictError(
        "candidates changed since the claim (digest mismatch) — release via fail and re-claim",
      );
    }
  }
  return { detail, claim };
}

/** 领取事务的池子复验装配（designer/developer/verifier 共用，T3 抽出/P4 增
 *  checks——三角色的事务内双检读同一套规则，永不漂移）。活动 claim 已由调用
 *  方先行处理（Conflict/replay），此处 activeClaims 恒为空集。checks 是
 *  verifier 谓词输入（Phase-4 T1）；随返回值带出供 claim 冻结 checkContexts。 */
async function poolRecheck(
  workspacePath: string,
  manifest: Pick<WorkspaceManifest, "repositories">,
  current: WorkItemDetail,
): Promise<{
  entry: PoolEntry;
  attempts: AttemptRecord[];
  requirementDigest: string;
  checks: DeliveryCheckConfig[] | undefined;
}> {
  const config = await readDeliveryRunnerConfig(workspacePath);
  const maxAttemptsPerInput = config?.budget.maxAttemptsPerInput
    ?? DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxAttemptsPerInput;
  const requirementDigest = contentDigest(current.content);
  const attempts = await listAttempts(current.path);
  // fix-round 裁定 #1/#2：预算 = 单项自最近 resume 以来的尾随连续失败
  // （与 pool 读取端同一 helper，口径由构造保证一致）。
  const failureCountByKey = new Map<string, number>([
    [current.item.key, await countRecentFailures(current.path, requirementDigest, maxAttemptsPerInput)],
  ]);
  const ctx: DeliveryPoolContext = {
    enabled: config?.enabled ?? false,
    // 活动 claim 已在调用方以 Conflict/replay 处理，此处必为空集。
    activeClaims: new Set(),
    pendingInterruptions: (await listPendingInterruptions(current.path)).length > 0
      ? new Set([current.item.key])
      : new Set<string>(),
    paused: readPaused(current.path) !== null ? new Set([current.item.key]) : new Set<string>(),
    failureCountByKey,
    maxAttemptsPerInput,
    // designer 复验不消费仓库登记表（developer/verifier 谓词专属）；manifest
    // 已由调用方读过，按项内数据装配保持与池子读取端同源。
    registeredRepos: new Map(manifest.repositories.map((repo) => [repo.id, repo.status])),
    // verifier 谓词输入（Phase-4）：config.verification.checks——与池子读取端
    // 同源（undefined/空 = no-checks-configured）。
    checks: config?.verification?.checks,
  };
  const [entry] = projectDeliveryPool(
    [{
      key: current.item.key,
      title: current.item.title,
      priority: current.item.priority,
      status: current.item.status,
      phase: current.item.phase,
      archivedAt: current.item.archivedAt,
      repositories: current.item.repositories,
      requirementDigest,
      delivery: current.item.delivery ?? null,
    }],
    ctx,
  );
  return { entry, attempts, requirementDigest, checks: config?.verification?.checks };
}

async function maxAttemptsFor(workspacePath: string): Promise<number> {
  const config = await readDeliveryRunnerConfig(workspacePath);
  return config?.budget.maxAttemptsPerInput
    ?? DEFAULT_DELIVERY_RUNNER_CONFIG.budget.maxAttemptsPerInput;
}

// ------------------------------------------------------------------- claim

/**
 * 领取事务：幂等重放（同 requestId 的活动 claim → 现 grant，ownerToken 空串）
 * → capability/配置/谓词双检 → 同一事务内完成阶段流转（phase intake→design、
 * design.md 播种、status=in_progress、claim.json 落盘、delivery.claimed 事件）。
 * 前置不满足 → WorkItemValidationError（reason 串）；他人活动 claim →
 * WorkItemConflictError。
 */
export async function claimDesignerTask(
  input: ClaimInput,
): Promise<{ grant: ClaimGrant; replayed: boolean }> {
  const requestId = requireText(input.requestId, "requestId");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const current = await readWorkItem(input.workspacePath, input.key);
    const itemPath = current.path;

    // 幂等重放：claim.json 的 lastRequest 命中同 requestId → 返回现 grant
    // （不 bump revision、不追加事件、不写第二 attempt；明文 token 无法重建）。
    const existingClaim = readClaim(itemPath);
    if (existingClaim?.lastRequest?.requestId === requestId) {
      return {
        grant: {
          attemptId: existingClaim.attemptId,
          generation: existingClaim.generation,
          ownerToken: "",
          key: input.key,
          item: current,
        },
        replayed: true,
      };
    }
    if (existingClaim !== null) {
      throw new WorkItemConflictError(
        `item ${input.key} already has an active claim (attempt ${existingClaim.attemptId}, session ${existingClaim.sessionId})`,
      );
    }

    // 事务内双检（spec §5.2 step 1）：capability（manifest）→ 配置 → 纯投影
    // 谓词逐条复验（poolRecheck——designer/developer 共用同一装配）。
    const manifest = await readWorkspaceManifest(input.workspacePath);
    assertAutomationCapable(manifest);
    const { entry, attempts, requirementDigest } = await poolRecheck(
      input.workspacePath, manifest, current,
    );
    // 角色由阶段决定：rfi 项可能投影为 developer-ready，但本事务是 designer
    // 领取——须同时是 designer 角色且 ready（designer 谓词对非 intake 阶段
    // 照旧 wrong-phase，语义与 P2 一致）。
    if (!entry.ready || entry.role !== "designer") {
      const detail = entry.ready
        ? `item is ready for the developer role, not designer (phase ${current.item.phase})`
        : entry.reasons.join(", ");
      throw new WorkItemValidationError(
        `delivery claim preconditions failed: ${detail}`,
      );
    }

    // generation 从 attempt 审计推导（spec 的 item.delivery.claim 字段不在 M2
    // schema 中；attempt 记录追加式永不删除，是 generation 的持久账本）。
    const generation = attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
    const attemptId = createUlid();
    const ownerToken = randomUUID();
    const now = new Date();

    // 产物先落盘：design.md 播种（缺失才播——与 M2 start-design 同构）→
    // gitignore 接线 → claim.json（先于 item.yaml，见文件头崩溃窗口说明）。
    const designPath = designPathFor(itemPath);
    if ((await readDesignFile(designPath)) === undefined) {
      await writeAtomic(designPath, DESIGN_SEED(current.item.title));
    }
    await ensureRuntimeGitignore(input.workspacePath);
    writeClaim(itemPath, {
      attemptId,
      generation,
      role: "designer",
      sessionId: input.sessionId,
      claimedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      requirementDigest,
      ownerTokenHash: hashOwnerToken(ownerToken),
      lastRequest: { requestId, at: now.toISOString() },
    });

    // 状态后改：phase intake→design + status=in_progress + revision+1。
    const next: WorkItemRecord = structuredClone(current.item);
    next.phase = "design";
    next.status = "in_progress";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.claimed", "agent", undefined, {
        phase: { from: current.item.phase, to: next.phase },
        generation,
        attemptId,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery claim ${input.key}`);
    return {
      grant: {
        attemptId,
        generation,
        ownerToken,
        key: input.key,
        item: await readWorkItem(input.workspacePath, input.key),
      },
      replayed: false,
    };
  });
}

// ------------------------------------------------------------------ submit

/**
 * Designer 提交：写 design.md（正文 + 由 acceptanceCriteria 合成的「验收条件」
 * 节）→ 清 claim → attempt submitted → work_item.design_updated +
 * delivery.submitted 事件 → status 回 open（phase 保持 design 等人工
 * confirm-design——提交即结束，designer 不推进确认）。凭证过期 / 需求摘要
 * 变化 → Conflict（409）。
 */
export async function submitDesignerResult(input: SubmitDesignInput): Promise<WorkItemDetail> {
  requireText(input.requestId, "requestId");
  const designContent = requireText(input.designContent, "designContent");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) {
    throw new WorkItemValidationError("acceptanceCriteria must contain at least one criterion");
  }
  const criteria = input.acceptanceCriteria.map((criterion, index) =>
    requireText(criterion, `acceptanceCriteria[${index}]`));

  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
    );
    // 人在领取窗口内抢先 confirm-design：确认证据绑定的是当时的 design.md
    // 摘要，迟到的 designer 提交会让其静默过期——拒绝，让 claim 过期重领。
    if (current.item.delivery?.designConfirmed !== undefined) {
      throw new WorkItemConflictError(
        "design was confirmed while the claim was active — the claim is stale, re-claim after rework",
      );
    }
    const itemPath = current.path;
    const now = new Date();
    const designPath = designPathFor(itemPath);
    const previous = await readDesignFile(designPath);
    const content = `${designContent}\n\n## 验收条件\n${
      criteria.map((criterion) => `- [ ] ${criterion}\n`).join("")}`;

    // 产物先落盘，状态后改（同 claim 事务顺序纪律）。
    await writeAtomic(designPath, content);
    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "designer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "submitted",
      requirementDigest: claim.requirementDigest,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    next.status = "open";
    // 会话自链接（服务层不变式）：带 conversationId 的动作把会话挂入 conversations。
    if (input.conversationId && !next.conversations.includes(input.conversationId)) {
      next.conversations = [...next.conversations, input.conversationId];
    }
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("work_item.design_updated", "agent", input.conversationId, {
        revision: next.revision,
        before_length: previous?.length ?? 0,
        after_length: content.length,
      }),
    );
    await appendEvent(
      itemPath,
      eventFor("delivery.submitted", "agent", input.conversationId, {
        attemptId: claim.attemptId,
        generation: claim.generation,
        criteriaCount: criteria.length,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery submit ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

// -------------------------------------------------------------------- fail

/**
 * Designer 失败：清 claim → attempt failed → delivery.attempt_failed 事件 →
 * 归还领取（phase design→intake；blocked=true → status=blocked，可解阻塞仍
 * 在白名单内可领）→ 失败预算（同 digest failed ≥ max → writePaused +
 * delivery.automation_paused，自动领取停等人显式 resume）。
 */
export async function failDesignerTask(input: FailInput): Promise<WorkItemDetail> {
  const reason = requireText(input.reason, "reason");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
    );
    const itemPath = current.path;
    const now = new Date();

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "designer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "failed",
      reason,
      requirementDigest: claim.requirementDigest,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    // 失败即归还：designer 让出 claim 带来的 design 阶段（仅当还停在该阶段），
    // 项回到 intake 可再领——重试节流由失败预算（同 digest 计数）承担，不靠
    // 阶段卡死；blocked 是给人看的环境/依赖标志（白名单内仍可领）。
    if (next.phase === "design") next.phase = "intake";
    next.status = input.blocked === true ? "blocked" : "open";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.attempt_failed", "agent", undefined, {
        reason,
        blocked: input.blocked === true,
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );

    // 失败预算（fix-round 裁定 #1）：自最近 resume 以来的尾随连续失败（含刚
    // 记的这条）≥ max → 暂停自动领取，等人显式 resumeAutomation（resume 会写
    // 失败窗口重置连胜）。reason 如实说窗口口径。
    const maxAttemptsPerInput = await maxAttemptsFor(input.workspacePath);
    const failedCount = await countRecentFailures(itemPath, claim.requirementDigest);
    if (failedCount >= maxAttemptsPerInput) {
      writePaused(itemPath, {
        at: now.toISOString(),
        reason: `consecutive failures (${failedCount} since last resume)`,
        count: failedCount,
      });
      await appendEvent(
        itemPath,
        eventFor("delivery.automation_paused", "agent", undefined, {
          count: failedCount,
          maxAttemptsPerInput,
          attemptId: claim.attemptId,
          revision: next.revision,
        }),
      );
    }
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery fail ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

// -------------------------------------------------- developer (Phase-3 T3)

export interface DeveloperClaimInput {
  workspacePath: string;
  key: string;
  sessionId: string;
  requestId: string;
}

export interface DeveloperSubmitInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  candidates: Array<{ repositoryId: string; commit: string }>;
  notes?: string;
  conversationId?: string;
}

export interface DeveloperFailInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  reason: string;
  blocked?: boolean;
}

/**
 * Developer 领取事务（designer 同骨架）：幂等重放 → capability/配置/谓词
 * 双检（poolRecheck，developer 角色）→ worktree 预建（**在任何状态落盘之前**
 * ——失败=零状态，已建孤儿无害）→ designDigest 锁内快照 → claim.json →
 * phase ready_for_implementation→implementation + status=in_progress +
 * delivery.claimed 事件（data 带 worktrees）。
 */
export async function claimDeveloperTask(
  input: DeveloperClaimInput,
): Promise<{ grant: ClaimGrant; replayed: boolean }> {
  const requestId = requireText(input.requestId, "requestId");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const current = await readWorkItem(input.workspacePath, input.key);
    const itemPath = current.path;

    // 幂等重放（同 designer 契约）：claim.lastRequest 命中同 requestId → 现
    // grant（ownerToken 空串——明文无法重建；不 bump 不追加）。
    const existingClaim = readClaim(itemPath);
    if (existingClaim?.lastRequest?.requestId === requestId) {
      return {
        grant: {
          attemptId: existingClaim.attemptId,
          generation: existingClaim.generation,
          ownerToken: "",
          key: input.key,
          item: current,
        },
        replayed: true,
      };
    }
    if (existingClaim !== null) {
      throw new WorkItemConflictError(
        `item ${input.key} already has an active claim (attempt ${existingClaim.attemptId}, session ${existingClaim.sessionId})`,
      );
    }

    const manifest = await readWorkspaceManifest(input.workspacePath);
    assertAutomationCapable(manifest);
    const { entry, attempts, requirementDigest } = await poolRecheck(
      input.workspacePath, manifest, current,
    );
    // 角色由阶段决定（池子投影）：intake 项对 developer 是 wrong-phase——
    // 须同时 ready 且投影为 developer。
    if (!entry.ready || entry.role !== "developer") {
      const detail = entry.ready
        ? `item is ready for the ${entry.role} role, not developer (phase ${current.item.phase})`
        : entry.reasons.join(", ");
      throw new WorkItemValidationError(
        `delivery claim preconditions failed: ${detail}`,
      );
    }

    const generation = attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
    const attemptId = createUlid();
    const ownerToken = randomUUID();
    const now = new Date();

    // worktree 预建在写任何状态之前（P2 语义）：任一仓失败整体抛——claim/
    // gitignore/item.yaml/事件全未写（零状态）；已建的 worktree 不回滚
    // （孤儿无害——下代领取用新分支，不与旧代冲突）。
    const worktrees = await prepareWorktrees(
      input.workspacePath,
      { key: current.item.key, repositories: current.item.repositories },
      generation,
    );

    // designDigest 锁内自算快照（T1 carried ruling）：绑定当前 design.md 字节，
    // 不从池取（池无此字段）；缺失按空串（与 submit 侧对称）。
    const designContent = await readDesignFile(designPathFor(itemPath));
    const designDigest = contentDigest(designContent ?? "");

    await ensureRuntimeGitignore(input.workspacePath);
    writeClaim(itemPath, {
      attemptId,
      generation,
      role: "developer",
      sessionId: input.sessionId,
      claimedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      requirementDigest,
      ownerTokenHash: hashOwnerToken(ownerToken),
      designDigest,
      worktrees,
      lastRequest: { requestId, at: now.toISOString() },
    });

    const next: WorkItemRecord = structuredClone(current.item);
    next.phase = "implementation";
    next.status = "in_progress";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.claimed", "agent", undefined, {
        phase: { from: current.item.phase, to: next.phase },
        generation,
        attemptId,
        worktrees,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery claim ${input.key}`);
    return {
      grant: {
        attemptId,
        generation,
        ownerToken,
        key: input.key,
        item: await readWorkItem(input.workspacePath, input.key),
      },
      replayed: false,
    };
  });
}

/**
 * Developer 提交：requireActiveClaim 三凭据 + role 匹配 + 双 digest 复验
 * （requirementDigest ∧ designDigest）+ designConfirmed 仍真值 + 项仍在
 * implementation（人推进过阶段 → 迟到提交不得覆写新状态）——任一漂移 →
 * Conflict。候选经 verifyCandidateCommits 核验（范围仓 = 领取时预建的
 * worktree 集；候选是既有 commit，无新产物要先落盘）。之后按 M2
 * submit-verification 语义【同构内联】推进（不调 applyDeliveryAction——其
 * 自取 withWorkspaceWriteLock 不可重入，designer design.md 直写同款先例）：
 * candidates 写入、verification 清空、phase→verification、status→open。
 */
export async function submitDeveloperResult(input: DeveloperSubmitInput): Promise<WorkItemDetail> {
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new WorkItemValidationError(
      "candidates must contain at least one candidate ({ repositoryId, commit })",
    );
  }
  const candidates = input.candidates.map((candidate, index) => ({
    repositoryId: requireText(candidate?.repositoryId, `candidates[${index}].repositoryId`),
    commit: requireText(candidate?.commit, `candidates[${index}].commit`),
  }));
  const notes = input.notes === undefined || input.notes === null
    ? undefined
    : requireText(input.notes, "notes");

  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
      { expectedRole: "developer", expectedDesignDigest: true },
    );
    const delivery = current.item.delivery;
    if (delivery?.designConfirmed === undefined) {
      throw new WorkItemConflictError(
        "input changed since claim — release via fail and re-claim",
      );
    }
    if (current.item.phase !== "implementation") {
      throw new WorkItemConflictError(
        `claim is stale — the item phase is now ${current.item.phase} (expected implementation)`,
      );
    }

    // 候选核验（同步 spawnSync 锁内纯读——计划裁定可接受）：范围仓 = 领取时
    // 预建的 worktree 集；commit 可为任何可解析 ref（rev-parse 语义，不强校验
    // 40-hex），提交时原样存储与展示。
    const repoPaths = new Map(
      (claim.worktrees ?? []).map((worktree) => [worktree.repositoryId, worktree.repoPath]),
    );
    verifyCandidateCommits(repoPaths, candidates);

    const itemPath = current.path;
    const now = new Date();

    const next: WorkItemRecord = structuredClone(current.item);
    // 既有 verification 通过记录不得存活新提交（M2 submit-verification 同款）。
    next.delivery = { ...delivery, candidates, verification: undefined };
    next.phase = "verification";
    next.status = "open";
    // 会话自链接（服务层不变式）：带 conversationId 的动作把会话挂入 conversations。
    if (input.conversationId && !next.conversations.includes(input.conversationId)) {
      next.conversations = [...next.conversations, input.conversationId];
    }
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.submitted", "agent", input.conversationId, {
        attemptId: claim.attemptId,
        generation: claim.generation,
        candidates,
        ...(notes !== undefined ? { notes } : {}),
        revision: next.revision,
      }),
    );

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "developer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "submitted",
      requirementDigest: claim.requirementDigest,
      candidates,
      worktrees: claim.worktrees,
    });
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery submit ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

/**
 * Developer 失败（designer fail 同骨架）：清 claim → attempt failed（role
 * developer，worktrees 随 claim 入审计）→ 回退守卫（仅当仍停 implementation
 * 时回 ready_for_implementation——人在领取窗口内推进/回退过阶段则不回滚）→
 * 失败预算（按 digest 跨角色共享）→ commit。blocked 是给人看的环境/依赖
 * 标志（白名单内仍可领）。
 */
export async function failDeveloperTask(input: DeveloperFailInput): Promise<WorkItemDetail> {
  const reason = requireText(input.reason, "reason");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
      { expectedRole: "developer" },
    );
    const itemPath = current.path;
    const now = new Date();

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "developer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "failed",
      reason,
      requirementDigest: claim.requirementDigest,
      worktrees: claim.worktrees,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    // 失败即归还：developer 让出 claim 带来的 implementation 阶段——仅当仍
    // 停在该阶段（designer 的 design→intake 守卫同款写法：人若中途动作改了
    // 阶段，不回滚人的状态）。
    if (next.phase === "implementation") next.phase = "ready_for_implementation";
    next.status = input.blocked === true ? "blocked" : "open";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.attempt_failed", "agent", undefined, {
        reason,
        blocked: input.blocked === true,
        role: "developer",
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );

    // 失败预算跨角色共享（spec §8）：countRecentFailures 按 digest 计数天然
    // 跨角色——designer 与 developer 的失败互相消耗同一预算，防两角色互刷
    // 次数绕上限。
    const maxAttemptsPerInput = await maxAttemptsFor(input.workspacePath);
    const failedCount = await countRecentFailures(itemPath, claim.requirementDigest);
    if (failedCount >= maxAttemptsPerInput) {
      writePaused(itemPath, {
        at: now.toISOString(),
        reason: `consecutive failures (${failedCount} since last resume)`,
        count: failedCount,
      });
      await appendEvent(
        itemPath,
        eventFor("delivery.automation_paused", "agent", undefined, {
          count: failedCount,
          maxAttemptsPerInput,
          attemptId: claim.attemptId,
          revision: next.revision,
        }),
      );
    }
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery fail ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

// ------------------------------------------------- verifier (Phase-4 T3)

export interface VerifierClaimInput {
  workspacePath: string;
  key: string;
  sessionId: string;
  requestId: string;
}

export interface VerifierSubmitInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  notes?: string;
  /** 会话自链接（fix round 1）：带 conversationId 的动作把会话挂入
   *  item.conversations（与 designer/developer submit 同一服务层不变式——
   *  详情「关联会话」由此可达），并随 delivery.submitted 事件携带。 */
  conversationId?: string;
}

export interface VerifierFailInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  reason: string;
  blocked?: boolean;
}

/** claim 时冻结检查配置快照（carried ruling #2）：缺省 repositoryId 在此刻解析
 *  为候选首仓（池谓词同款缺省规则）；快照进 claim.checkContexts，领取后的
 *  配置变更不追溯（submit 完整性比对与 run_check 的配置查找都以它为准）。 */
function freezeCheckContexts(
  checks: DeliveryCheckConfig[] | undefined,
  fallbackRepositoryId: string,
): ClaimCheckContext[] {
  return (checks ?? []).map((check) => ({
    name: check.name,
    repositoryId: check.repositoryId ?? fallbackRepositoryId,
    command: check.command,
    ...(check.timeout_seconds !== undefined ? { timeout_seconds: check.timeout_seconds } : {}),
  }));
}

/**
 * Verifier 领取事务（designer/developer 同骨架）：幂等重放 → capability/
 * 配置/谓词双检（poolRecheck，verifier 角色）→ 候选 detached checkout 预建
 * （**在任何状态落盘之前**——失败=零状态，已建孤儿无害）→ claim.json（role
 * verifier + candidateDigest 快照 + checkContexts 冻结 + worktrees +
 * checkResults 空仓）→ **phase 不变**（verification 就是验证活动的阶段）+
 * status=in_progress + delivery.claimed 事件。
 */
export async function claimVerifierTask(
  input: VerifierClaimInput,
): Promise<{ grant: ClaimGrant; replayed: boolean }> {
  const requestId = requireText(input.requestId, "requestId");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const current = await readWorkItem(input.workspacePath, input.key);
    const itemPath = current.path;

    // 幂等重放（同 designer/developer 契约）：claim.lastRequest 命中同
    // requestId → 现 grant（ownerToken 空串——明文无法重建；不 bump 不追加）。
    const existingClaim = readClaim(itemPath);
    if (existingClaim?.lastRequest?.requestId === requestId) {
      return {
        grant: {
          attemptId: existingClaim.attemptId,
          generation: existingClaim.generation,
          ownerToken: "",
          key: input.key,
          item: current,
        },
        replayed: true,
      };
    }
    if (existingClaim !== null) {
      throw new WorkItemConflictError(
        `item ${input.key} already has an active claim (attempt ${existingClaim.attemptId}, session ${existingClaim.sessionId})`,
      );
    }

    const manifest = await readWorkspaceManifest(input.workspacePath);
    assertAutomationCapable(manifest);
    const { entry, attempts, requirementDigest, checks } = await poolRecheck(
      input.workspacePath, manifest, current,
    );
    // 角色由阶段决定（池子投影）：非 verification 的项按各自角色谓词投影——
    // 须同时 ready 且投影为 verifier。
    if (!entry.ready || entry.role !== "verifier") {
      const detail = entry.ready
        ? `item is ready for the ${entry.role} role, not verifier (phase ${current.item.phase})`
        : entry.reasons.join(", ");
      throw new WorkItemValidationError(
        `delivery claim preconditions failed: ${detail}`,
      );
    }

    const generation = attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
    const attemptId = createUlid();
    const ownerToken = randomUUID();
    const now = new Date();

    const candidates = current.item.delivery?.candidates ?? [];
    // 候选 checkout 预建在写任何状态之前（P2 语义同款）：任一仓失败整体抛——
    // claim/gitignore/item.yaml/事件全未写（零状态）；已建的 checkout 不回滚
    // （孤儿无害——generation 单调，下代领取用新目录）。repoPaths = manifest
    // 登记 active 仓（谓词已保证候选仓全部登记且 active，此处装配与池子同源）。
    const repoPaths = new Map(
      manifest.repositories
        .filter((repo) => repo.status === "active")
        .map((repo) => [repo.id, join(input.workspacePath, repo.path)]),
    );
    const worktrees = await prepareVerifyCheckouts(
      input.workspacePath,
      { key: current.item.key },
      candidates,
      generation,
      repoPaths,
    );

    // 候选集摘要快照（锁内自算——claim 谓词已保证候选非空）。
    const candidateDigest = candidatesDigest(candidates);
    const checkContexts = freezeCheckContexts(checks, candidates[0].repositoryId);

    await ensureRuntimeGitignore(input.workspacePath);
    writeClaim(itemPath, {
      attemptId,
      generation,
      role: "verifier",
      sessionId: input.sessionId,
      claimedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      requirementDigest,
      ownerTokenHash: hashOwnerToken(ownerToken),
      candidateDigest,
      worktrees,
      checkContexts,
      checkResults: [],
      lastRequest: { requestId, at: now.toISOString() },
    });

    // 状态后改：phase 不变（verification）、status=in_progress + revision+1。
    const next: WorkItemRecord = structuredClone(current.item);
    next.status = "in_progress";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.claimed", "agent", undefined, {
        phase: { from: current.item.phase, to: next.phase },
        generation,
        attemptId,
        worktrees,
        candidateDigest,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery claim ${input.key}`);
    return {
      grant: {
        attemptId,
        generation,
        ownerToken,
        key: input.key,
        item: await readWorkItem(input.workspacePath, input.key),
      },
      replayed: false,
    };
  });
}

/**
 * Verifier 提交：requireActiveClaim 三凭据 + role 门 + candidateDigest 复验
 * （候选在领取后被换——人 rework/重提交——→ 409 释放重领）+ 阶段守卫（人在
 * 窗口内推进 → 409）。证据只从 claim.checkResults 取（服务端执行器唯一注入
 * 口），按 claim.checkContexts（领取时冻结的配置快照）逐名完整性比对——
 * 缺名 → Validation；未知名证据 → Validation；unverified → Validation 零变化
 * （最终口径：submit 是终局动作，环境问题重跑 delivery_run_check 或
 * fail(blocked)，不静默 blocked）。之后按 M2 record-verification / rework 语义
 * 【同构内联】推进（不调 applyDeliveryAction——其自取 withWorkspaceWriteLock
 * 不可重入，designer design.md 直写同款先例）。
 */
export async function submitVerifierResult(input: VerifierSubmitInput): Promise<WorkItemDetail> {
  const notes = input.notes === undefined || input.notes === null
    ? undefined
    : requireText(input.notes, "notes");

  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
      { expectedRole: "verifier", expectedCandidateDigest: true },
    );
    if (current.item.phase !== "verification") {
      throw new WorkItemConflictError(
        `claim is stale — the item phase is now ${current.item.phase} (expected verification)`,
      );
    }
    const delivery = current.item.delivery;
    // 领取窗口内人清掉 designConfirmed（或 delivery 块整个消失）→ 输入已变，
    // 迟到提交不得覆写（developer submit 同款守卫；候选漂移已被上面的
    // candidateDigest 复验拦下）。
    if (delivery?.designConfirmed === undefined) {
      throw new WorkItemConflictError(
        "input changed since claim — release via fail and re-claim",
      );
    }

    // 完整性比对按冻结快照（配置变更不追溯）：每名恰有一条记录；LLM 不能凭空补。
    const contexts = claim.checkContexts ?? [];
    const results = claim.checkResults ?? [];
    for (const context of contexts) {
      if (!results.some((result) => result.name === context.name)) {
        throw new WorkItemValidationError(
          `check ${context.name} not run — run every configured check via delivery_run_check before submitting`,
        );
      }
    }
    for (const result of results) {
      if (!contexts.some((context) => context.name === result.name)) {
        throw new WorkItemValidationError(
          `check ${result.name} is not part of the claim's check contexts`,
        );
      }
    }
    // unverified = 执行环境不完整（超时/无法执行）——不是实现问题也不是判定，
    // 推进与 rework 都不适用：零变化拒绝，让会话重跑或 fail(blocked)。
    const unverified = results.find((result) => result.outcome === "unverified");
    if (unverified !== undefined) {
      throw new WorkItemValidationError(
        `check ${unverified.name} unverified — resolve environment and re-run via delivery_run_check before submitting`,
      );
    }

    const itemPath = current.path;
    const now = new Date();
    const byName = new Map(results.map((result) => [result.name, result]));

    const next: WorkItemRecord = structuredClone(current.item);
    let eventType: string;
    let eventData: Record<string, unknown>;
    let verificationOutcome: "verified" | "rework";

    const failed = results.filter((result) => result.outcome === "failed");
    if (failed.length > 0) {
      // 有 failed → M2 rework 同构：清全部下游证据（designConfirmed/candidates/
      // verification/releasePlan——须重新挣得）+ 回 ready_for_implementation 等
      // developer 再领；反馈事件携带失败条目与日志引用（开发返工的输入）。
      verificationOutcome = "rework";
      next.phase = "ready_for_implementation";
      next.status = "open";
      next.delivery = {
        ...delivery,
        designConfirmed: undefined,
        candidates: undefined,
        verification: undefined,
        releasePlan: undefined,
      };
      eventType = "delivery.rework_suggested";
      eventData = {
        reason: "verification-failed",
        checks: failed.map((result) => ({
          name: result.name,
          exitCode: result.exitCode,
          logRef: result.logRef,
        })),
      };
    } else {
      // 全 passed → delivery.verification（actor=agent + 服务端证据——命令取自
      // 冻结快照）+ phase→release_ready。
      verificationOutcome = "verified";
      next.phase = "release_ready";
      next.status = "open";
      next.delivery = {
        ...delivery,
        verification: {
          at: now.toISOString(),
          actor: "agent" as const,
          requirementDigest: contentDigest(current.content),
          candidateDigest: claim.candidateDigest ?? "",
          checks: contexts.map((context) => {
            const result = byName.get(context.name)!;
            return {
              name: context.name,
              outcome: "passed" as const,
              evidence: {
                command: context.command,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                logRef: result.logRef,
              },
            };
          }),
        },
      };
      eventType = "delivery.submitted";
      eventData = {
        outcome: "verified",
        checks: contexts.map((context) => {
          const result = byName.get(context.name)!;
          return {
            name: context.name,
            exitCode: result.exitCode,
            logRef: result.logRef,
          };
        }),
      };
    }

    next.revision += 1;
    next.updatedAt = now.toISOString();
    // 会话自链接（fix round 1，designer submit 同款）：带 conversationId 的
    // 提交把会话挂入 conversations。
    if (input.conversationId && !next.conversations.includes(input.conversationId)) {
      next.conversations = [...next.conversations, input.conversationId];
    }
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor(eventType, "agent", input.conversationId, {
        ...eventData,
        attemptId: claim.attemptId,
        generation: claim.generation,
        ...(notes !== undefined ? { notes } : {}),
        revision: next.revision,
      }),
    );

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "verifier",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "submitted",
      verificationOutcome,
      requirementDigest: claim.requirementDigest,
      worktrees: claim.worktrees,
      checkResults: claim.checkResults,
    });
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery submit ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

/**
 * Verifier 失败（环境/依赖问题 → blocked；designer/developer fail 同骨架）：
 * 清 claim → attempt failed（role verifier，checkout 与已累积证据随 claim 入
 * 审计）→ **phase 不动**（verifier claim 不改阶段，verification→verification
 * 零变化——回退守卫的 verifier 形态就是无阶段可归还）→ 失败预算（按 digest
 * 跨角色共享）。blocked 是给人看的环境/依赖标志（白名单内仍可领）。
 */
export async function failVerifierTask(input: VerifierFailInput): Promise<WorkItemDetail> {
  const reason = requireText(input.reason, "reason");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
      { expectedRole: "verifier" },
    );
    const itemPath = current.path;
    const now = new Date();

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "verifier",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "failed",
      reason,
      requirementDigest: claim.requirementDigest,
      worktrees: claim.worktrees,
      checkResults: claim.checkResults,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    // 失败即归还 status；phase 从不动（claim 本就不改阶段——人若中途推进/回退
    // 过阶段，更不得回滚）。
    next.status = input.blocked === true ? "blocked" : "open";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.attempt_failed", "agent", undefined, {
        reason,
        blocked: input.blocked === true,
        role: "verifier",
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );

    // 失败预算跨角色共享（spec §8——三角色同一预算，防互刷绕上限）。
    const maxAttemptsPerInput = await maxAttemptsFor(input.workspacePath);
    const failedCount = await countRecentFailures(itemPath, claim.requirementDigest);
    if (failedCount >= maxAttemptsPerInput) {
      writePaused(itemPath, {
        at: now.toISOString(),
        reason: `consecutive failures (${failedCount} since last resume)`,
        count: failedCount,
      });
      await appendEvent(
        itemPath,
        eventFor("delivery.automation_paused", "agent", undefined, {
          count: failedCount,
          maxAttemptsPerInput,
          attemptId: claim.attemptId,
          revision: next.revision,
        }),
      );
    }
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery fail ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

/**
 * run_check 工具路径的证据累积（无业务锁轻量——heartbeat 同习语）：claim
 * 存在 ∧ claim.sessionId 匹配 → 同名覆盖/新名追加进 claim.checkResults
 * （attemptId/generation 原样，原子写回）→ true；无 claim / 他人会话 → false。
 * 名字与 outcome 的配置面校验在调用侧（run_check 按 claim.checkContexts 找
 * 配置）；submit 侧还有完整性比对兜底。
 */
export async function recordCheckResult(
  workspacePath: string,
  key: string,
  sessionId: string,
  evidence: CheckEvidence,
): Promise<boolean> {
  const name = requireText(evidence?.name, "check name");
  if (
    evidence.outcome !== "passed" && evidence.outcome !== "failed" && evidence.outcome !== "unverified"
  ) {
    throw new WorkItemValidationError(
      `check outcome must be one of: passed, failed, unverified (got ${String(evidence.outcome)})`,
    );
  }
  const detail = await readWorkItem(workspacePath, key);
  const claim = readClaim(detail.path);
  if (claim === null || claim.sessionId !== sessionId) return false;
  const results = [...(claim.checkResults ?? [])];
  const index = results.findIndex((result) => result.name === name);
  if (index >= 0) results[index] = evidence;
  else results.push(evidence);
  writeClaim(detail.path, { ...claim, checkResults: results });
  return true;
}

// ------------------------------------------- release-preparer (Phase-5 T1)

export interface ReleasePreparerClaimInput {
  workspacePath: string;
  key: string;
  sessionId: string;
  requestId: string;
}

export interface ReleasePreparerSubmitInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  /** 发布说明（M2 prepare-release 形状：notes 必填）。 */
  releaseNotes: string;
  /** 回滚办法（可选——空白视同未提供，键省略）。 */
  rollbackNotes?: string;
  /** 会话自链接（designer 先例）：带 conversationId 的提交把会话挂入
   *  item.conversations，并随 delivery.submitted 事件携带。 */
  conversationId?: string;
}

export interface ReleasePreparerFailInput {
  workspacePath: string;
  key: string;
  attemptId: string;
  generation: number;
  ownerToken: string;
  reason: string;
  blocked?: boolean;
}

/**
 * Release-preparer 领取事务（verifier 同骨架去掉环境预建）：幂等重放 →
 * capability/配置/谓词双检（poolRecheck，release-preparer 角色）→ **无环境
 * 预建**（纯文档角色——零 git 操作，无 worktree/checkout 可失败）→ claim.json
 * （role release-preparer + candidateDigest 快照，同 verifier 先例）→
 * **phase 不变**（release_ready 就是准备材料的阶段）+ status=in_progress +
 * delivery.claimed 事件。
 */
export async function claimReleasePreparerTask(
  input: ReleasePreparerClaimInput,
): Promise<{ grant: ClaimGrant; replayed: boolean }> {
  const requestId = requireText(input.requestId, "requestId");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const current = await readWorkItem(input.workspacePath, input.key);
    const itemPath = current.path;

    // 幂等重放（同 designer/developer/verifier 契约）：claim.lastRequest 命中
    // 同 requestId → 现 grant（ownerToken 空串——明文无法重建；不 bump 不追加）。
    const existingClaim = readClaim(itemPath);
    if (existingClaim?.lastRequest?.requestId === requestId) {
      return {
        grant: {
          attemptId: existingClaim.attemptId,
          generation: existingClaim.generation,
          ownerToken: "",
          key: input.key,
          item: current,
        },
        replayed: true,
      };
    }
    if (existingClaim !== null) {
      throw new WorkItemConflictError(
        `item ${input.key} already has an active claim (attempt ${existingClaim.attemptId}, session ${existingClaim.sessionId})`,
      );
    }

    const manifest = await readWorkspaceManifest(input.workspacePath);
    assertAutomationCapable(manifest);
    const { entry, attempts, requirementDigest } = await poolRecheck(
      input.workspacePath, manifest, current,
    );
    // 角色由阶段决定（池子投影）：非 release_ready 的项按各自角色谓词投影——
    // 须同时 ready 且投影为 release-preparer。
    if (!entry.ready || entry.role !== "release-preparer") {
      const detail = entry.ready
        ? `item is ready for the ${entry.role} role, not release-preparer (phase ${current.item.phase})`
        : entry.reasons.join(", ");
      throw new WorkItemValidationError(
        `delivery claim preconditions failed: ${detail}`,
      );
    }

    const generation = attempts.reduce((max, attempt) => Math.max(max, attempt.generation), 0) + 1;
    const attemptId = createUlid();
    const ownerToken = randomUUID();
    const now = new Date();

    // 候选集摘要快照（锁内自算——claim 谓词已保证与 verification.candidateDigest
    // 一致；snapshot 后候选被换由 submit 侧复验拦下）。纯文档角色：无
    // prepareXxx——claim.json 之前没有可失败的环境步骤。
    const candidates = current.item.delivery?.candidates ?? [];
    const candidateDigest = candidatesDigest(candidates);

    await ensureRuntimeGitignore(input.workspacePath);
    writeClaim(itemPath, {
      attemptId,
      generation,
      role: "release-preparer",
      sessionId: input.sessionId,
      claimedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      requirementDigest,
      ownerTokenHash: hashOwnerToken(ownerToken),
      candidateDigest,
      lastRequest: { requestId, at: now.toISOString() },
    });

    // 状态后改：phase 不变（release_ready）、status=in_progress + revision+1。
    const next: WorkItemRecord = structuredClone(current.item);
    next.status = "in_progress";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.claimed", "agent", undefined, {
        phase: { from: current.item.phase, to: next.phase },
        generation,
        attemptId,
        candidateDigest,
        revision: next.revision,
      }),
    );
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery claim ${input.key}`);
    return {
      grant: {
        attemptId,
        generation,
        ownerToken,
        key: input.key,
        item: await readWorkItem(input.workspacePath, input.key),
      },
      replayed: false,
    };
  });
}

/**
 * Release-preparer 提交（M2 prepare-release 语义的 actor=agent 变体）：
 * requireActiveClaim 三凭据 + role 门 + candidateDigest 复验（候选在领取后被换
 * → 409 释放重领）+ 阶段守卫（人在窗口内 record-release → 409——released
 * 冻结基线不得被迟到会话覆写）+ verification 仍在场（块被清 → 材料失去验证
 * 依据 → 409）。之后写 delivery.releasePlan = {notes, rollback?}——**phase
 * 保持 release_ready 等人 record-release**（只准备材料：不写 release 块、不
 * 触发布执行——record-release 与实际发布永远是人做的）+ status→open。
 */
export async function submitReleasePreparerResult(
  input: ReleasePreparerSubmitInput,
): Promise<WorkItemDetail> {
  const releaseNotes = requireText(input.releaseNotes, "release_notes");
  const rollbackNotes = input.rollbackNotes !== undefined && input.rollbackNotes !== null
    ? input.rollbackNotes.trim()
    : "";

  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
      { expectedRole: "release-preparer", expectedCandidateDigest: true },
    );
    if (current.item.phase !== "release_ready") {
      throw new WorkItemConflictError(
        `claim is stale — the item phase is now ${current.item.phase} (expected release_ready)`,
      );
    }
    const delivery = current.item.delivery;
    // 领取窗口内 verification 被清（rework 四清式，候选恰好没动）→ 材料必须由
    // 验证证据支撑——迟到提交不得基于失效输入落材料（developer submit 同款
    // 守卫；候选漂移已被上面的 candidateDigest 复验拦下）。
    if (delivery?.verification === undefined) {
      throw new WorkItemConflictError(
        "input changed since claim — release via fail and re-claim",
      );
    }

    const itemPath = current.path;
    const now = new Date();
    const releasePlan: { notes: string; rollback?: string } = {
      notes: releaseNotes,
      ...(rollbackNotes ? { rollback: rollbackNotes } : {}),
    };

    const next: WorkItemRecord = structuredClone(current.item);
    next.delivery = { ...delivery, releasePlan };
    next.status = "open";
    // 会话自链接（服务层不变式，designer 先例）：带 conversationId 的提交把
    // 会话挂入 conversations。
    if (input.conversationId && !next.conversations.includes(input.conversationId)) {
      next.conversations = [...next.conversations, input.conversationId];
    }
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.submitted", "agent", input.conversationId, {
        outcome: "release-plan",
        notes: releaseNotes,
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "release-preparer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "submitted",
      requirementDigest: claim.requirementDigest,
      releasePlan,
    });
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery submit ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

/**
 * Release-preparer 失败（环境/依赖问题 → blocked；designer/developer/verifier
 * fail 同骨架）：清 claim → attempt failed（role release-preparer，纯文档角色
 * 无 worktrees/checkResults 可入审计）→ **phase 不动**（release-preparer claim
 * 不改阶段，release_ready→release_ready 零变化——无阶段可归还，verifier 同款）
 * → 失败预算（按 digest 跨角色共享）。blocked 是给人看的环境/依赖标志
 * （白名单内仍可领）。
 */
export async function failReleasePreparerTask(
  input: ReleasePreparerFailInput,
): Promise<WorkItemDetail> {
  const reason = requireText(input.reason, "reason");
  return withWorkspaceWriteLock(input.workspacePath, async () => {
    const { detail: current, claim } = await requireActiveClaim(
      input.workspacePath,
      input.key,
      input,
      { expectedRole: "release-preparer" },
    );
    const itemPath = current.path;
    const now = new Date();

    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      role: "release-preparer",
      sessionId: claim.sessionId,
      workspacePath: input.workspacePath,
      key: input.key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "failed",
      reason,
      requirementDigest: claim.requirementDigest,
    });

    const next: WorkItemRecord = structuredClone(current.item);
    // 失败即归还 status；phase 从不动（claim 本就不改阶段——人若中途推进/回退
    // 过阶段，更不得回滚）。
    next.status = input.blocked === true ? "blocked" : "open";
    next.revision += 1;
    next.updatedAt = now.toISOString();
    await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
    await appendEvent(
      itemPath,
      eventFor("delivery.attempt_failed", "agent", undefined, {
        reason,
        blocked: input.blocked === true,
        role: "release-preparer",
        attemptId: claim.attemptId,
        generation: claim.generation,
        revision: next.revision,
      }),
    );

    // 失败预算跨角色共享（spec §8——四角色同一预算，防互刷绕上限）。
    const maxAttemptsPerInput = await maxAttemptsFor(input.workspacePath);
    const failedCount = await countRecentFailures(itemPath, claim.requirementDigest);
    if (failedCount >= maxAttemptsPerInput) {
      writePaused(itemPath, {
        at: now.toISOString(),
        reason: `consecutive failures (${failedCount} since last resume)`,
        count: failedCount,
      });
      await appendEvent(
        itemPath,
        eventFor("delivery.automation_paused", "agent", undefined, {
          count: failedCount,
          maxAttemptsPerInput,
          attemptId: claim.attemptId,
          revision: next.revision,
        }),
      );
    }
    await commitWorkspaceChanges(input.workspacePath, `workspace: delivery fail ${input.key}`);
    return readWorkItem(input.workspacePath, input.key);
  });
}

// --------------------------------------------------------------- heartbeat

/** 轻量续约（无业务锁）：claim.sessionId 匹配 → 原子写回 lastSeenAt
 *  （attemptId/generation 原样）→ true；无 claim / 他人会话 → false。
 *  不 bump revision、不产生事件、不进 git（spec §5.2）。 */
export async function heartbeatActiveClaim(
  workspacePath: string,
  itemPath: string,
  sessionId: string,
): Promise<boolean> {
  void workspacePath; // 签名对称保留（brief 契约）；续约只动 claim.json
  const claim = readClaim(itemPath);
  if (claim === null || claim.sessionId !== sessionId) return false;
  writeClaim(itemPath, { ...claim, lastSeenAt: new Date().toISOString() });
  return true;
}

// ------------------------------------------------------------ interruption

/** 关停/停止路径的中断记录（锁内）：claim.sessionId 匹配才记——清 claim、
 *  写 needsAttention 的 interrupted attempt（5.1 的中断门禁据此挡住新领取，
 *  人经「重新检查并恢复」解除）、归还领取借走的状态、追加
 *  delivery.exec_interrupted 事件。claim 已清（幂等）或不匹配 → no-op。
 *  不进 workspace git：中断写发生在宿主关停序列（M1 先例——loop 中断记录
 *  纯文件写，不在关停路径上 spawn git）；events.jsonl 落盘即持久，下一次
 *  workspace 提交自然收编。
 *
 *  状态归还（Phase-3 final fix，runtime-proven）：claim 事务写下的
 *  status=in_progress 复位 open（池白名单 {open, blocked} 否则把恢复后的项
 *  永久排除）+ claim 推进的阶段退回可领阶段（designer design→intake /
 *  developer implementation→ready_for_implementation）——仅复位 status 不退
 *  阶段不够：design/implementation 停留照样 wrong-phase，recover 后 dispatcher
 *  仍永不重派。守卫与 fail 同款（人若在领取窗口内推进/回退过阶段或写过状态，
 *  人的状态不回滚）；终态（cancelled/done）人已接管一切——item.yaml 整个
 *  不动，只清 claim + 审计（「不复活终态」，7e50f529 哲学）。 */
export async function recordInterruption(
  workspacePath: string,
  key: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  await withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    const itemPath = current.path;
    const claim = readClaim(itemPath);
    if (claim === null || claim.sessionId !== sessionId) return;
    const now = new Date();
    clearClaim(itemPath);
    await writeAttempt({
      attemptId: claim.attemptId,
      generation: claim.generation,
      // role 随 ClaimState 流动（T3 泛化）：designer/developer 领取的中断
      // 按各自角色入审计。
      role: claim.role,
      sessionId: claim.sessionId,
      workspacePath,
      key,
      claimedAt: claim.claimedAt,
      endedAt: now.toISOString(),
      outcome: "interrupted",
      reason,
      requirementDigest: claim.requirementDigest,
      needsAttention: true,
    });
    // 状态归还（同一锁窗，见函数头）；item.yaml 有实际变化才写 + bump revision。
    let itemWrite: WorkItemRecord | null = null;
    const giveBack: {
      status?: { from: string; to: string };
      phase?: { from: string; to: string };
    } = {};
    if (current.item.status !== "cancelled" && current.item.status !== "done") {
      const next: WorkItemRecord = structuredClone(current.item);
      if (next.status === "in_progress") {
        giveBack.status = { from: "in_progress", to: "open" };
        next.status = "open";
      }
      const phaseBack: { from: WorkItemPhase; to: WorkItemPhase } | null =
        claim.role === "designer"
          ? { from: "design", to: "intake" }
          : claim.role === "developer"
            ? { from: "implementation", to: "ready_for_implementation" }
            // verifier（Phase-4）与 release-preparer（Phase-5 T1）：claim 不改
            // 阶段（verification/release_ready 各自 from=to 零变化）——无阶段可
            // 归还，只归还 status。
            : null;
      if (phaseBack !== null && next.phase === phaseBack.from) {
        giveBack.phase = phaseBack;
        next.phase = phaseBack.to;
      }
      if (giveBack.status !== undefined || giveBack.phase !== undefined) {
        next.revision += 1;
        next.updatedAt = now.toISOString();
        await writeAtomic(join(itemPath, "item.yaml"), serializeWorkItem(next));
        itemWrite = next;
      }
    }
    await appendEvent(
      itemPath,
      eventFor("delivery.exec_interrupted", "system", undefined, {
        reason,
        attemptId: claim.attemptId,
        generation: claim.generation,
        ...(itemWrite !== null ? { ...giveBack, revision: itemWrite.revision } : {}),
      }),
    );
  });
}

// ------------------------------------------------------------------ resume

/** 显式恢复自动领取（人处理完阻塞后，actor=user）：清 automation-paused +
 *  写失败预算窗口（since=now——fix-round 裁定 #1：resume 之后只数新的失败，
 *  旧连胜不再挡）+ delivery.resumed 事件。未暂停 → Validation（路由层映射
 *  400——plan T8）。 */
export async function resumeAutomation(
  workspacePath: string,
  key: string,
): Promise<WorkItemDetail> {
  return withWorkspaceWriteLock(workspacePath, async () => {
    const current = await readWorkItem(workspacePath, key);
    const paused = readPaused(current.path);
    if (paused === null) {
      throw new WorkItemValidationError(`automation is not paused for ${key}`);
    }
    const now = new Date().toISOString();
    clearPaused(current.path);
    writeFailureWindow(current.path, now);
    await appendEvent(
      current.path,
      eventFor("delivery.resumed", "user", undefined, {
        pausedSince: paused.at,
        pausedCount: paused.count,
      }),
    );
    await commitWorkspaceChanges(workspacePath, `workspace: delivery resume ${key}`);
    return readWorkItem(workspacePath, key);
  });
}
