"use client";

import { useState } from "react";
import { formatRelativeTime } from "@/lib/format-time";

/** 交付自动执行区（Phase-2 Task 9，spec §5.3/§6.2 详情活动执行区）。
 *  四态呈现：活动 claim（角色会话链接 + 停止执行）/ 自动领取暂停横幅
 *  （原因 + 连续失败计数 + 恢复自动领取）/ 未确认执行中断横幅（重新检查并
 *  恢复）/ 最近 attempts 列表（末 5 条新→旧，outcome 徽章 + needsAttention
 *  待处理标记）。Phase-3 T5：claim/attempts 带 role 徽标（designer/developer）；
 *  developer 的 claim 展示 worktree 集（alias ?? repositoryId · 分支——alias 由
 *  GET 路由读取时 manifest 联表富化，完整路径进 title），submit 的 attempt
 *  展示候选摘要（repo@commit 前 8 位）。Phase-4 T5：verifier 徽标；claim 的
 *  checkResults 证据仓逐条展示（outcome 徽章/退出码/耗时/日志名，命令来源与
 *  完整日志路径进 title）；attempt 的 verificationOutcome 判定徽章（已验证/
 *  需返工）+ checkResults 紧凑 chips（rework 路径的失败证据）。
 *
 *  本组件是纯展示 + 动作转发：执行状态（GET delivery-execution）与三个动作
 *  （POST stop / recover / delivery-resume）都由 WorkItemsPage 持有并经
 *  props 注入；动作结果走 `{ok:true} | {ok:false,error}` 出参——409 pids 等
 *  服务端冲突在这里降级为内联提示（M2 conflict 提示同款 role=alert 习语），
 *  不弹全局错误。busy 期间全部按钮禁用（防双击，Actionbar 同款习语）。 */

// —— UI 侧结构类型（delivery-runner/attempts.ts 的客户端镜像：该模块 import
//    node:fs，不能进浏览器 bundle——WorkspaceManager 的 kitLoops 同款手法）。 ——

export type ExecutionRole = "designer" | "developer" | "verifier";

/** RoleWorktree（delivery-runner/worktrees.ts）的客户端镜像：developer 领取
 *  时预建的 worktree——repoPath 是登记仓主路径，path 是 worktree 检出路径。
 *  alias 不在落盘事实里：GET delivery-execution 读取时用 manifest 联表富化
 *  （fix round 1——展示元数据可改名，读取时联表永远新鲜）。 */
export interface ExecutionWorktree {
  repositoryId: string;
  repoPath: string;
  path: string;
  branch: string;
  /** manifest 联表富化的展示别名；无 alias/未登记 → 字段缺省，回退 repositoryId。 */
  alias?: string;
}

/** CheckEvidence（delivery-runner/checks.ts）的客户端镜像：服务端执行器产出、
 *  delivery_run_check 后累积进 claim.checkResults（submit/fail 终局整体拷入
 *  attempt 审计——rework 路径的失败证据只在 attempt 里留痕）。exitCode null =
 *  进程未跑完（超时/启动失败），真实退出码不存在。 */
export interface ExecutionCheckResult {
  name: string;
  exitCode: number | null;
  durationMs: number;
  /** 相对工作项根的 POSIX 日志路径（basename 铺正文，全路径进 title）。 */
  logRef: string;
  outcome: "passed" | "failed" | "unverified";
}

/** ClaimCheckContext 的客户端镜像：verifier 领取时冻结的检查配置快照
 *  （repositoryId 已解析——缺省值在 claim 事务内落为候选首仓）。 */
export interface ExecutionCheckContext {
  name: string;
  repositoryId: string;
  command: string;
  timeout_seconds?: number;
}

export interface ExecutionClaimSummary {
  attemptId: string;
  generation: number;
  role: ExecutionRole;
  sessionId: string;
  claimedAt: string;
  lastSeenAt: string;
  requirementDigest: string;
  /** developer 领取时预建的 worktree 集（designer claim 无此字段）；verifier
   *  领取时为候选 detached checkout 集。 */
  worktrees?: ExecutionWorktree[];
  /** verifier 领取时冻结的检查配置快照（Phase-4）。 */
  checkContexts?: ExecutionCheckContext[];
  /** verifier 的检查证据仓（Phase-4）——服务端执行器累积，LLM 无其他注入口。 */
  checkResults?: ExecutionCheckResult[];
  lastRequest?: { requestId: string; at: string };
}

export interface ExecutionAttemptSummary {
  attemptId: string;
  generation: number;
  role: ExecutionRole;
  sessionId: string;
  claimedAt: string;
  endedAt?: string;
  outcome?: "submitted" | "failed" | "interrupted";
  /** verifier 提交的验证判定（Phase-4）：verified = 全过推进待发布；rework =
   *  有失败走返工——是验证器完成任务后的合法判定，不是执行失败。 */
  verificationOutcome?: "verified" | "rework";
  reason?: string;
  requirementDigest: string;
  needsAttention?: boolean;
  /** developer submit 的候选集（designer attempt 无此字段）。 */
  candidates?: Array<{ repositoryId: string; commit: string }>;
  worktrees?: ExecutionWorktree[];
  /** verifier 终局拷贝的全量检查证据（Phase-4）——claim 已清，rework 路径的
   *  证据（含 passed 条目）只在这里留痕。 */
  checkResults?: ExecutionCheckResult[];
}

export interface DeliveryExecutionState {
  claim: ExecutionClaimSummary | null;
  recentAttempts: ExecutionAttemptSummary[];
  paused: { at: string; reason: string; count: number } | null;
  pendingInterruption: boolean;
}

/** 动作出参：{ok:true} = 已受理（宿主已刷新状态）；{ok:false,error} = 服务端
 *  拒绝（409 pids / 400 / 404 …），error 为可直接展示的中文提示。 */
export type ExecutionActionResult = { ok: true } | { ok: false; error: string };

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  minHeight: 26,
  padding: "0 10px",
  font: "inherit",
  fontSize: 11.5,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  color: "#dc2626",
  borderColor: "color-mix(in srgb, #dc2626 40%, var(--border))",
};

/** 横幅（暂停 / 中断）共用的告示样式。 */
function bannerStyle(tone: "warn" | "danger"): React.CSSProperties {
  const color = tone === "danger" ? "#dc2626" : "#b45309";
  return {
    border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
    borderRadius: 8,
    background: `color-mix(in srgb, ${color} 7%, var(--bg))`,
    color: "var(--text-muted)",
    padding: "8px 10px",
    fontSize: 11.5,
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  };
}

const OUTCOME_LABELS: Record<NonNullable<ExecutionAttemptSummary["outcome"]>, string> = {
  submitted: "已提交",
  failed: "失败",
  interrupted: "中断",
};

const OUTCOME_TONES: Record<NonNullable<ExecutionAttemptSummary["outcome"]>, string> = {
  submitted: "#16a34a",
  failed: "#dc2626",
  interrupted: "#b45309",
};

function OutcomeBadge({ outcome }: { outcome: ExecutionAttemptSummary["outcome"] }) {
  if (!outcome) {
    return (
      <span
        style={{
          padding: "1px 6px",
          borderRadius: 5,
          fontSize: 10.5,
          fontWeight: 700,
          color: "var(--text-dim)",
          background: "var(--bg-hover)",
        }}
      >
        进行中
      </span>
    );
  }
  const tone = OUTCOME_TONES[outcome];
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, var(--bg))`,
      }}
    >
      {OUTCOME_LABELS[outcome]}
    </span>
  );
}

// —— 检查证据（Phase-4 verifier）：详情页 verification 块与本执行区共用同一组
//    标签/配色/格式化（DeliveryEvidence 既有中文标签对齐）。 ——

/** 检查耗时：<1s 毫秒直陈，≥1s 秒一位小数（审计行短小，两种粒度足够）。 */
export function formatCheckDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

/** 日志文件名：logRef 是相对工作项根的 POSIX 路径，正文只铺 basename，全路径进 title。 */
function logFileName(logRef: string): string {
  return logRef.split("/").pop() ?? logRef;
}

const CHECK_OUTCOME_LABELS: Record<ExecutionCheckResult["outcome"], string> = {
  passed: "通过",
  failed: "未通过",
  unverified: "未验证",
};

const CHECK_OUTCOME_TONES: Record<ExecutionCheckResult["outcome"], string> = {
  passed: "#16a34a",
  failed: "#dc2626",
  unverified: "#b45309",
};

function CheckOutcomeBadge({ outcome }: { outcome: ExecutionCheckResult["outcome"] }) {
  const tone = CHECK_OUTCOME_TONES[outcome];
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, var(--bg))`,
        whiteSpace: "nowrap",
      }}
    >
      {CHECK_OUTCOME_LABELS[outcome]}
    </span>
  );
}

const VERIFICATION_OUTCOME_LABELS: Record<NonNullable<ExecutionAttemptSummary["verificationOutcome"]>, string> = {
  verified: "已验证",
  rework: "需返工",
};

const VERIFICATION_OUTCOME_TONES: Record<NonNullable<ExecutionAttemptSummary["verificationOutcome"]>, string> = {
  verified: "#16a34a",
  rework: "#b45309",
};

/** verifier 提交的验证判定徽章：verified 绿 / rework 橙（rework 是合法判定，
 *  与执行失败的红色 outcome 徽章语义区分）。 */
function VerificationOutcomeBadge({ outcome }: { outcome: NonNullable<ExecutionAttemptSummary["verificationOutcome"]> }) {
  const tone = VERIFICATION_OUTCOME_TONES[outcome];
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, var(--bg))`,
        whiteSpace: "nowrap",
      }}
    >
      {VERIFICATION_OUTCOME_LABELS[outcome]}
    </span>
  );
}

/** exitCode 文案：null = 进程未跑完（超时/启动失败），显式占位符——raw null
 *  永不漏出。 */
function exitCodeText(exitCode: number | null): string {
  return `退出码 ${exitCode ?? "—"}`;
}

/** 领取角色徽标（Phase-3 T5：developer 角色上岗后需要一眼分辨谁在跑）。
 *  原文 designer/developer/verifier——与 .pi/delivery.yaml 的角色键一致，不翻译。 */
function RoleBadge({ role }: { role: ExecutionRole }) {
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 5,
        fontSize: 10.5,
        fontWeight: 700,
        color: "var(--text-dim)",
        background: "var(--bg-hover)",
        whiteSpace: "nowrap",
      }}
    >
      {role}
    </span>
  );
}

export function WorkItemExecution({
  execution,
  busy,
  onStop,
  onRecover,
  onResumeAutomation,
  onOpenConversation,
}: {
  /** null = 拉取中（managed 项才会被宿主拉取）。 */
  execution: DeliveryExecutionState | null;
  busy: boolean;
  onStop: () => Promise<ExecutionActionResult>;
  onRecover: () => Promise<ExecutionActionResult>;
  onResumeAutomation: () => Promise<ExecutionActionResult>;
  onOpenConversation: (sessionId: string) => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"stop" | "recover" | "resume" | null>(null);

  const run = async (
    kind: "stop" | "recover" | "resume",
    action: () => Promise<ExecutionActionResult>,
  ) => {
    if (busy || busyAction) return;
    setActionError(null);
    setBusyAction(kind);
    let result: ExecutionActionResult;
    try {
      result = await action();
    } catch (runError) {
      result = { ok: false, error: runError instanceof Error ? runError.message : String(runError) };
    } finally {
      setBusyAction(null);
    }
    // {ok:false}（409 pids / 400 校验 / 404 …）→ 内联提示，不清横幅——
    // 状态未变，重试入口仍在。
    if (result.ok === false) setActionError(result.error);
  };

  const anyBusy = busy || busyAction !== null;

  if (!execution) {
    return <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>加载执行状态…</div>;
  }

  const { claim, recentAttempts, paused, pendingInterruption } = execution;
  const idle = claim === null && paused === null && !pendingInterruption && recentAttempts.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 活动领取：角色会话链接 + 停止执行（人工停止 = 定向杀会话 + 记中断）。 */}
      {claim && (
        <div
          style={{
            border: "1px solid color-mix(in srgb, #16a34a 35%, var(--border))",
            borderRadius: 9,
            background: "color-mix(in srgb, #16a34a 6%, var(--bg))",
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 11.5,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 11, color: "var(--text-dim)" }}>执行中</strong>
            <RoleBadge role={claim.role} />
            <span style={{ color: "var(--text-dim)" }}>第 {claim.generation} 代</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={dangerButtonStyle}
              disabled={anyBusy}
              title="停止将终止该角色会话并记一次执行中断，需人工恢复后才会继续自动领取"
              onClick={() => void run("stop", onStop)}
            >
              {busyAction === "stop" ? "停止中…" : "停止执行"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "var(--text-muted)" }}>
            <span>领取于 {formatRelativeTime(claim.claimedAt)} · 最近心跳 {formatRelativeTime(claim.lastSeenAt)}</span>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => onOpenConversation(claim.sessionId)}
              title={claim.sessionId}
            >
              查看会话
            </button>
          </div>
          {/* developer 领取的 worktree 集（designer claim 无）：每仓一条执行
              分支。alias 优先（GET 路由读取时 manifest 联表富化）、无 alias
              回退 repositoryId；path 太长不铺正文，完整检出路径进 title。 */}
          {claim.worktrees && claim.worktrees.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {claim.worktrees.map((worktree) => (
                <span
                  key={`${worktree.repositoryId}:${worktree.branch}`}
                  title={worktree.path}
                  style={{
                    padding: "1px 6px",
                    borderRadius: 5,
                    fontSize: 10.5,
                    color: "var(--text-dim)",
                    background: "var(--bg-hover)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {worktree.alias ?? worktree.repositoryId} · {worktree.branch}
                </span>
              ))}
            </div>
          )}
          {/* verifier 的检查证据仓（Phase-4）：claim.checkResults——服务端执行器
              （delivery_run_check）累积，LLM 无其他注入口。每条 = outcome 徽章 +
              名称 + 退出码 + 耗时 + 日志文件名；命令来源（checkContexts 按名联表
              的冻结快照）进名称 title，完整日志路径进日志名 title。 */}
          {claim.checkResults && claim.checkResults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {claim.checkResults.map((check) => {
                const context = (claim.checkContexts ?? []).find((entry) => entry.name === check.name);
                const contextTitle = context
                  ? [context.command, `仓库 ${context.repositoryId}`, context.timeout_seconds !== undefined ? `超时 ${context.timeout_seconds}s` : null]
                    .filter(Boolean)
                    .join(" · ")
                  : undefined;
                return (
                  <div
                    key={check.name}
                    style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                  >
                    <CheckOutcomeBadge outcome={check.outcome} />
                    <span title={contextTitle}>{check.name}</span>
                    <span style={{ color: "var(--text-dim)" }}>{exitCodeText(check.exitCode)}</span>
                    <span style={{ color: "var(--text-dim)" }}>{formatCheckDuration(check.durationMs)}</span>
                    <span
                      title={check.logRef}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10.5,
                        color: "var(--text-dim)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {logFileName(check.logRef)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 自动领取暂停：连续失败触发（budget.maxAttemptsPerInput 窗口）。 */}
      {paused && (
        <div style={bannerStyle("warn")} role="status">
          <span>
            自动领取已暂停：{paused.reason}（连续 {paused.count} 次，{formatRelativeTime(paused.at)}）
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={buttonStyle}
            disabled={anyBusy}
            title="清除暂停标记并重置失败窗口，恢复自动领取"
            onClick={() => void run("resume", onResumeAutomation)}
          >
            {busyAction === "resume" ? "恢复中…" : "恢复自动领取"}
          </button>
        </div>
      )}

      {/* 未确认执行中断：宿主关停/人工停止留下的待处理记录——恢复门禁挡住
          自动重领，重新检查（残留进程探测）通过后 resolve。 */}
      {pendingInterruption && (
        <div style={bannerStyle("danger")}>
          <span>存在未确认的执行中断——恢复前不会自动重领。重新检查将探测残留命令进程。</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={buttonStyle}
            disabled={anyBusy}
            onClick={() => void run("recover", onRecover)}
          >
            {busyAction === "recover" ? "检查中…" : "重新检查并恢复"}
          </button>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          style={{
            border: "1px solid color-mix(in srgb, #ef4444 40%, var(--border))",
            borderRadius: 8,
            background: "color-mix(in srgb, #ef4444 7%, var(--bg))",
            color: "#dc2626",
            padding: "8px 10px",
            fontSize: 11.5,
            overflowWrap: "anywhere",
          }}
        >
          {actionError}
        </div>
      )}

      {/* 最近 attempts（服务端已按新→旧给出末 5 条）：outcome 徽章 + 待处理
          标记 + 会话链接 + 原因。 */}
      {recentAttempts.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <strong style={{ fontSize: 11, color: "var(--text-dim)" }}>最近执行</strong>
          {recentAttempts.map((entry) => (
            <div
              key={entry.attemptId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                fontSize: 11.5,
                color: "var(--text-muted)",
                borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                paddingBottom: 4,
              }}
            >
              <OutcomeBadge outcome={entry.outcome} />
              <RoleBadge role={entry.role} />
              {/* verifier 提交的验证判定（Phase-4）：与 outcome（执行成败）正交。 */}
              {entry.verificationOutcome && <VerificationOutcomeBadge outcome={entry.verificationOutcome} />}
              {entry.needsAttention && (
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: 5,
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: "#b45309",
                    background: "color-mix(in srgb, #b45309 12%, var(--bg))",
                  }}
                >
                  待处理
                </span>
              )}
              <span>第 {entry.generation} 代 · {formatRelativeTime(entry.claimedAt)}</span>
              {/* developer submit 的候选摘要（Phase-3 T5）：`repo@commit 前 8 位`
                  内联串——完整 sha 不铺正文（审计细节在 attempts 文件里）。 */}
              {entry.candidates && entry.candidates.length > 0 && (
                <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                  候选 {entry.candidates.map((candidate) => `${candidate.repositoryId}@${candidate.commit.slice(0, 8)}`).join(" · ")}
                </span>
              )}
              {/* verifier 终局的检查证据（Phase-4，rework 路径的失败证据就在这里）：
                  紧凑 chips（名称 + outcome），退出码/耗时/日志路径进 title——
                  行内已有判定徽章与候选串，铺全量字段会挤爆。 */}
              {entry.checkResults && entry.checkResults.length > 0 && (
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 5 }}>
                  {entry.checkResults.map((check) => (
                    <span
                      key={check.name}
                      title={`${check.name} · ${exitCodeText(check.exitCode)} · ${formatCheckDuration(check.durationMs)} · ${check.logRef}`}
                      style={{
                        padding: "1px 6px",
                        borderRadius: 5,
                        fontSize: 10.5,
                        color: CHECK_OUTCOME_TONES[check.outcome],
                        background: `color-mix(in srgb, ${CHECK_OUTCOME_TONES[check.outcome]} 12%, var(--bg))`,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {check.name} {CHECK_OUTCOME_LABELS[check.outcome]}
                    </span>
                  ))}
                </span>
              )}
              {entry.reason && (
                <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{entry.reason}</span>
              )}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={buttonStyle}
                onClick={() => onOpenConversation(entry.sessionId)}
                title={entry.sessionId}
              >
                查看会话
              </button>
            </div>
          ))}
        </div>
      ) : idle ? (
        <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>
          暂无自动执行活动——满足领取条件的设计阶段工作项会被自动领取执行。
        </div>
      ) : null}
    </div>
  );
}
