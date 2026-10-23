"use client";

import { useEffect, useMemo, useState } from "react";
import { legalActionBarActions } from "@/lib/work-items/legal-actions";
import type { DeliveryAction } from "@/lib/work-items/delivery-types";
import type { WorkItemRecord } from "@/lib/work-items/types";
import { runDeliveryAction, WorkItemRequestError } from "./work-item-api";

/** 标准交付流动作条（M2 T9，spec §7）：只渲染 legalActionBarActions(item)
 *  （= legalDeliveryActions + T2 carried ruling：released 项滤掉 cancel、保留
 *  block/unblock）。无字段动作（start-design / start-development / unblock）
 *  点击即执行；带字段动作展开最小表单。提交体 =
 *  { expectedRevision: item.revision, requestId: crypto.randomUUID(), payload }
 *  （幂等键见 work-item-api.runDeliveryAction）；成功 → onChanged()（宿主
 *  invalidate + 详情刷新），409 → 提示重取并触发 onChanged 拿新 revision。 */

const ACTION_LABELS: Record<DeliveryAction, string> = {
  "start-design": "开始设计",
  "confirm-design": "确认设计",
  "start-development": "开始开发",
  "submit-verification": "提交验证",
  "record-verification": "记录验证",
  "prepare-release": "准备发布",
  "record-release": "登记发布",
  rework: "返工",
  block: "阻塞",
  unblock: "解除阻塞",
  cancel: "取消",
};

/** 无必填字段的动作：点击即执行（无需展开表单）。 */
const FIELDLESS_ACTIONS: ReadonlySet<DeliveryAction> = new Set([
  "start-design",
  "start-development",
  "unblock",
]);

const ACTION_BUTTON_STYLE: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  minHeight: 28,
  padding: "0 11px",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  ...ACTION_BUTTON_STYLE,
  borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))",
  background: "color-mix(in srgb, var(--accent) 10%, var(--bg))",
  color: "var(--accent)",
};

const SECONDARY_BUTTON_STYLE: React.CSSProperties = ACTION_BUTTON_STYLE;

const fieldLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  color: "var(--text-muted)",
  fontSize: 11,
  minWidth: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "6px 9px",
  font: "inherit",
  fontSize: 12,
  outline: "none",
};

interface ActionFormProps {
  action: DeliveryAction;
  item: WorkItemRecord;
  workspaceId: string;
  busy: boolean;
  onSubmitPayload: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}

/** confirm-design 的设计证据面板：拉取 design.md 内容（验收条件清单本体），
 *  摘要展示 + 确认将绑定当前需求/设计版本的提示。无设计内容时禁用提交
 *  （服务端同样以 digest 缺失拒绝，spec §7.3）。 */
function ConfirmDesignForm({ item, workspaceId, busy, onSubmitPayload, onCancel }: ActionFormProps) {
  const [design, setDesign] = useState<{ content: string; digest: string; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDesign(null);
    void fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.key)}/design`,
    )
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          return { error: body.error ?? `HTTP ${response.status}` };
        }
        return (await response.json()) as { content: string; digest: string };
      })
      .then((result) => {
        if (!cancelled) setDesign(result as { content: string; digest: string; error?: string });
      })
      .catch(() => {
        if (!cancelled) setDesign({ error: "设计文档加载失败", content: "", digest: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [item.key, workspaceId, item.revision]);

  const acceptable = design != null && !design.error && design.content.trim() !== "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
        确认将绑定<strong>当前需求（README）与设计内容的版本摘要</strong>——之后任一变更都会撤销确认及下游证据并回到设计阶段。
        {design?.digest && (
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 6 }}>
            design {design.digest.slice(0, 12)}…
          </span>
        )}
      </div>
      {design == null && <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>加载设计文档…</div>}
      {design?.error && (
        <div style={{ color: "#dc2626", fontSize: 11.5 }}>
          {design.error}——先「开始设计」并填写方案与验收条件。
        </div>
      )}
      {acceptable && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            padding: 10,
            maxHeight: 220,
            overflowY: "auto",
            fontSize: 11.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {design.content}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={PRIMARY_BUTTON_STYLE}
          disabled={busy || !acceptable}
          onClick={() => onSubmitPayload({})}
        >
          {busy ? "提交中…" : "确认当前设计"}
        </button>
      </div>
    </div>
  );
}

interface CandidateDraft {
  repositoryId: string;
  commit: string;
}

function SubmitVerificationForm({ item, onSubmitPayload, busy, onCancel }: ActionFormProps) {
  const [candidates, setCandidates] = useState<CandidateDraft[]>([
    { repositoryId: item.repositories[0] ?? "", commit: "" },
  ]);
  const complete = candidates.length > 0
    && candidates.every((candidate) => candidate.repositoryId.trim() !== "" && candidate.commit.trim() !== "");
  const update = (index: number, patch: Partial<CandidateDraft>) => {
    setCandidates((current) => current.map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate)));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
        登记各关联仓库的候选提交（≥1 条）。提交后进入验证；新的提交会使旧验证记录失效。
      </div>
      {candidates.map((candidate, index) => (
        <div key={index} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input
            style={{ ...inputStyle, flex: "1 1 120px" }}
            list="delivery-candidate-repositories"
            value={candidate.repositoryId}
            placeholder="repositoryId"
            onChange={(event) => update(index, { repositoryId: event.target.value })}
          />
          <datalist id="delivery-candidate-repositories">
            {item.repositories.map((repositoryId) => (
              <option key={repositoryId} value={repositoryId} />
            ))}
          </datalist>
          <input
            style={{ ...inputStyle, flex: "1 1 160px", fontFamily: "var(--font-mono)" }}
            value={candidate.commit}
            placeholder="commit SHA"
            onChange={(event) => update(index, { commit: event.target.value })}
          />
          {candidates.length > 1 && (
            <button
              type="button"
              style={SECONDARY_BUTTON_STYLE}
              aria-label="移除此候选"
              onClick={() => setCandidates((current) => current.filter((_, i) => i !== index))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <div>
        <button
          type="button"
          style={SECONDARY_BUTTON_STYLE}
          onClick={() => setCandidates((current) => [...current, { repositoryId: item.repositories[0] ?? "", commit: "" }])}
        >
          + 候选
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={PRIMARY_BUTTON_STYLE}
          disabled={busy || !complete}
          onClick={() =>
            onSubmitPayload({
              candidates: candidates.map((candidate) => ({
                repositoryId: candidate.repositoryId.trim(),
                commit: candidate.commit.trim(),
              })),
            })
          }
        >
          {busy ? "提交中…" : "提交验证"}
        </button>
      </div>
    </div>
  );
}

interface CheckDraft {
  name: string;
  outcome: "passed" | "failed" | "unverified";
  note: string;
}

const OUTCOME_LABELS: Record<CheckDraft["outcome"], string> = {
  passed: "通过",
  failed: "未通过",
  unverified: "未验证",
};

function RecordVerificationForm({ onSubmitPayload, busy, onCancel }: ActionFormProps) {
  const [checks, setChecks] = useState<CheckDraft[]>([{ name: "", outcome: "passed", note: "" }]);
  const complete = checks.length > 0 && checks.every((check) => check.name.trim() !== "");
  const update = (index: number, patch: Partial<CheckDraft>) => {
    setChecks((current) => current.map((check, i) => (i === index ? { ...check, ...patch } : check)));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
        按验收条件逐条登记检查结果（人工登记的结构化记录，不等于程序已执行测试）。存在未通过/未验证项时不能通过——请走「返工」。
      </div>
      {checks.map((check, index) => (
        <div key={index} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input
            style={{ ...inputStyle, flex: "1 1 120px" }}
            value={check.name}
            placeholder="检查项（如验收条件）"
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <select
            style={{ ...inputStyle, flex: "0 0 96px" }}
            value={check.outcome}
            onChange={(event) => update(index, { outcome: event.target.value as CheckDraft["outcome"] })}
          >
            {(["passed", "failed", "unverified"] as const).map((outcome) => (
              <option key={outcome} value={outcome}>{OUTCOME_LABELS[outcome]}</option>
            ))}
          </select>
          <input
            style={{ ...inputStyle, flex: "1 1 140px" }}
            value={check.note}
            placeholder="备注（可选）"
            onChange={(event) => update(index, { note: event.target.value })}
          />
          {checks.length > 1 && (
            <button
              type="button"
              style={SECONDARY_BUTTON_STYLE}
              aria-label="移除此检查"
              onClick={() => setChecks((current) => current.filter((_, i) => i !== index))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <div>
        <button
          type="button"
          style={SECONDARY_BUTTON_STYLE}
          onClick={() => setChecks((current) => [...current, { name: "", outcome: "passed", note: "" }])}
        >
          + 检查项
        </button>
      </div>
      {checks.some((check) => check.outcome !== "passed") && (
        <div style={{ color: "#b45309", fontSize: 11 }}>
          存在未通过/未验证项——登记不会判定通过（服务端拒绝推进），请改走「返工」。
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={PRIMARY_BUTTON_STYLE}
          disabled={busy || !complete}
          onClick={() =>
            onSubmitPayload({
              checks: checks.map((check) => ({
                name: check.name.trim(),
                outcome: check.outcome,
                ...(check.note.trim() ? { note: check.note.trim() } : {}),
              })),
            })
          }
        >
          {busy ? "提交中…" : "登记验证结果"}
        </button>
      </div>
    </div>
  );
}

function ReleaseNotesFields({
  showVersion,
  busy,
  onSubmitPayload,
  onCancel,
  submitLabel,
}: {
  showVersion: boolean;
  busy: boolean;
  onSubmitPayload: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [rollback, setRollback] = useState("");
  const canSubmit = !busy && (!showVersion || version.trim() !== "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {showVersion && (
        <label style={fieldLabelStyle}>
          <span>版本号（必填）</span>
          <input
            style={inputStyle}
            value={version}
            placeholder="如 v1.4.2"
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
      )}
      <label style={fieldLabelStyle}>
        <span>发布说明（可选）</span>
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <label style={fieldLabelStyle}>
        <span>回滚方案（可选）</span>
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          value={rollback}
          onChange={(event) => setRollback(event.target.value)}
        />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={PRIMARY_BUTTON_STYLE}
          disabled={!canSubmit}
          onClick={() =>
            onSubmitPayload({
              ...(showVersion ? { version: version.trim() } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              ...(rollback.trim() ? { rollback: rollback.trim() } : {}),
            })
          }
        >
          {busy ? "提交中…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function ReworkForm({ onSubmitPayload, busy, onCancel }: ActionFormProps) {
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState<"implementation" | "design">("implementation");
  const canSubmit = !busy && reason.trim() !== "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
        返工撤销设计确认与下游证据（候选、验证、发布计划），回到所选阶段重新推进。
      </div>
      <label style={fieldLabelStyle}>
        <span>原因（必填）</span>
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          value={reason}
          placeholder="为什么需要返工"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div style={fieldLabelStyle}>
        <span>返工目标</span>
        <div style={{ display: "flex", gap: 12, color: "var(--text)", fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="radio"
              name="rework-target"
              checked={target === "implementation"}
              onChange={() => setTarget("implementation")}
            />
            实现问题 → 回开发
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="radio"
              name="rework-target"
              checked={target === "design"}
              onChange={() => setTarget("design")}
            />
            需求/方案问题 → 回设计
          </label>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={PRIMARY_BUTTON_STYLE}
          disabled={!canSubmit}
          onClick={() => onSubmitPayload({ reason: reason.trim(), target })}
        >
          {busy ? "提交中…" : "确认返工"}
        </button>
      </div>
    </div>
  );
}

function ReasonForm({
  submitLabel,
  busy,
  onSubmitPayload,
  onCancel,
}: {
  submitLabel: string;
  busy: boolean;
  onSubmitPayload: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const canSubmit = !busy && reason.trim() !== "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={fieldLabelStyle}>
        <span>原因（必填）</span>
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
          value={reason}
          placeholder="说明原因"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={onCancel}>取消</button>
        <button
          type="button"
          style={PRIMARY_BUTTON_STYLE}
          disabled={!canSubmit}
          onClick={() => onSubmitPayload({ reason: reason.trim() })}
        >
          {busy ? "提交中…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function ActionForm(props: ActionFormProps) {
  switch (props.action) {
    case "confirm-design":
      return <ConfirmDesignForm {...props} />;
    case "submit-verification":
      return <SubmitVerificationForm {...props} />;
    case "record-verification":
      return <RecordVerificationForm {...props} />;
    case "prepare-release":
      return (
        <ReleaseNotesFields
          showVersion={false}
          busy={props.busy}
          submitLabel="保存发布计划"
          onSubmitPayload={props.onSubmitPayload}
          onCancel={props.onCancel}
        />
      );
    case "record-release":
      return (
        <ReleaseNotesFields
          showVersion
          busy={props.busy}
          submitLabel="登记发布"
          onSubmitPayload={props.onSubmitPayload}
          onCancel={props.onCancel}
        />
      );
    case "rework":
      return <ReworkForm {...props} />;
    case "block":
    case "cancel":
      return (
        <ReasonForm
          submitLabel={props.action === "block" ? "确认阻塞" : "确认取消"}
          busy={props.busy}
          onSubmitPayload={props.onSubmitPayload}
          onCancel={props.onCancel}
        />
      );
    default:
      return null;
  }
}

export function WorkItemActionbar({
  workspaceId,
  item,
  onChanged,
  onError,
}: {
  workspaceId: string;
  item: WorkItemRecord;
  /** 动作成功 / 409 冲突后调用（宿主 invalidate() + 详情刷新）。 */
  onChanged?: () => void;
  /** 非冲突错误（400 校验 / 404 等）的展示通道。 */
  onError?: (message: string) => void;
}) {
  const [openAction, setOpenAction] = useState<DeliveryAction | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useMemo(() => legalActionBarActions(item), [item]);

  const submit = async (action: DeliveryAction, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      await runDeliveryAction(workspaceId, item.key, action, item.revision, payload);
      setOpenAction(null);
      onChanged?.();
    } catch (submitError) {
      if (submitError instanceof WorkItemRequestError && submitError.status === 409) {
        setOpenAction(null);
        // Revision 冲突：内容已被其他修改更新——重取列表拿新 revision 后重试。
        onError?.("内容已被其他修改更新（版本冲突），已重新获取最新状态，请重试。");
        onChanged?.();
      } else {
        onError?.(submitError instanceof Error ? submitError.message : String(submitError));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleActionClick = (action: DeliveryAction) => {
    if (FIELDLESS_ACTIONS.has(action)) {
      void submit(action, {});
      return;
    }
    setOpenAction((current) => (current === action ? null : action));
  };

  if (actions.length === 0) {
    if (item.delivery?.protocolVersion === 1) return null;
    return (
      <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>
        未启用标准交付流程（创建时勾选「启用标准交付流程」后，这里按门禁推进阶段）。
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            data-action={action}
            style={action === "cancel" ? SECONDARY_BUTTON_STYLE : PRIMARY_BUTTON_STYLE}
            disabled={busy}
            onClick={() => handleActionClick(action)}
          >
            {ACTION_LABELS[action]}
          </button>
        ))}
      </div>
      {openAction && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 9,
            background: "var(--bg)",
            padding: 12,
          }}
        >
          <ActionForm
            action={openAction}
            item={item}
            workspaceId={workspaceId}
            busy={busy}
            onSubmitPayload={(payload) => void submit(openAction, payload)}
            onCancel={() => setOpenAction(null)}
          />
        </div>
      )}
    </div>
  );
}
