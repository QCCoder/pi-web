"use client";

import { useState } from "react";
import type { DeliveryClarification } from "@/lib/work-items/delivery-types";
import type { WorkItemRecord } from "@/lib/work-items/types";
import { formatRelativeTime } from "@/lib/format-time";
import { runDeliveryAction, WorkItemRequestError } from "./work-item-api";

/**
 * 人工答复面板（final-arch step-2 Task 6，spec §5.4——ask-a-human 轮次的人在
 * 回路侧）：列出 item.delivery.clarifications（新→旧）。已答 = 只读 Q/A +
 * 角色徽标 + 问答时间；未答 = 问题原文 + options 单选（recommended 预选、
 * 标「推荐」）或无 options 时的自由文本（recommended 预填），「回答」→
 * runDeliveryAction("answer-clarification")（body = { expectedRevision,
 * requestId, payload: { clarificationId, answer } }，requestId 幂等键由共享
 * 封装生成）。2xx → onChanged()（宿主 invalidate，池谓词 awaiting-answer 随
 * 新快照解除）；409（已被他人作答或 revision 已变）→ 内联提示 + onChanged()
 * 重取；400 → 服务端文案。posting 期间禁用提交（防双击）。没有 clarifications
 * 就什么都不渲染——挂 DetailView 动作条旁；answer-clarification 永不进动作条
 * （legalActionBarActions 滤掉：问题全文在动作条无处展示）。文本硬编码中文
 * （组件族同款）。
 */

const CONFLICT_HINT = "已被他人回答或版本已变，请刷新";

const badgeStyle: React.CSSProperties = {
  padding: "0 7px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  fontSize: 10.5,
  color: "var(--text-muted)",
  flexShrink: 0,
};

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "color-mix(in srgb, var(--accent) 10%, var(--bg))",
  borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))",
  color: "var(--accent)",
  cursor: "pointer",
  minHeight: 26,
  padding: "0 12px",
  font: "inherit",
  fontSize: 11.5,
  fontWeight: 600,
  whiteSpace: "nowrap",
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

function ClarificationCard({
  clarification,
  posting,
  anyPosting,
  draft,
  error,
  onDraftChange,
  onSubmit,
}: {
  clarification: DeliveryClarification;
  /** 本条正在提交（按钮文案 + 自身控件禁用）。 */
  posting: boolean;
  /** 任一条在提交（全部控件禁用——同一 revision 只受理一个答复）。 */
  anyPosting: boolean;
  draft: string;
  error: string | null;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const disabled = anyPosting;
  return (
    <div
      data-clarification-id={clarification.id}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: "var(--bg)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={badgeStyle}>{clarification.role}</span>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          问于 {formatRelativeTime(clarification.askedAt)}
        </span>
        {clarification.answer !== undefined && (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            已答 {formatRelativeTime(clarification.answeredAt ?? clarification.askedAt)}
          </span>
        )}
      </div>
      <div style={{ color: "var(--text)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {clarification.question}
      </div>
      {clarification.answer !== undefined ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>
          答：{clarification.answer}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {clarification.options ? (
            <div role="radiogroup" aria-label={clarification.question} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
              {clarification.options.map((option) => (
                <label key={option} style={{ display: "flex", alignItems: "center", gap: 6, cursor: disabled ? "default" : "pointer", color: "var(--text)" }}>
                  <input
                    type="radio"
                    name={`clarification-${clarification.id}`}
                    value={option}
                    checked={draft === option}
                    disabled={disabled}
                    onChange={() => onDraftChange(option)}
                  />
                  <span style={{ overflowWrap: "anywhere" }}>{option}</span>
                  {option === clarification.recommended && (
                    <span style={{ color: "var(--accent)", fontSize: 10.5, fontWeight: 600 }}>推荐</span>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <textarea
              style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
              value={draft}
              placeholder="输入答复"
              disabled={disabled}
              onChange={(event) => onDraftChange(event.target.value)}
            />
          )}
          {error && (
            <div role="alert" style={{ color: "#dc2626", fontSize: 11.5 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" style={buttonStyle} disabled={disabled || !draft.trim()} onClick={onSubmit}>
              {posting ? "提交中…" : "回答"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ClarificationPanel({
  workspaceId,
  item,
  onChanged,
}: {
  workspaceId: string;
  /** 快照里的选中记录——clarifications 住 delivery 块（managed 项专属产物）。 */
  item: WorkItemRecord;
  /** 答复受理 / 409 冲突后调用（宿主 invalidate() → 快照新 revision/状态）。 */
  onChanged?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [postingId, setPostingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const clarifications = item.delivery?.clarifications ?? [];
  if (clarifications.length === 0) return null;
  // 新→旧（askedAt 降序——最近的问题排在最上面）。
  const sorted = [...clarifications].sort((left, right) => right.askedAt.localeCompare(left.askedAt));

  const draftFor = (clarification: DeliveryClarification) =>
    drafts[clarification.id] ?? clarification.recommended ?? "";

  const submit = async (clarification: DeliveryClarification) => {
    const answer = draftFor(clarification).trim();
    if (!answer || postingId !== null) return;
    setPostingId(clarification.id);
    try {
      await runDeliveryAction(
        workspaceId,
        item.key,
        "answer-clarification",
        item.revision,
        { clarificationId: clarification.id, answer },
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[clarification.id];
        return next;
      });
      setErrors((current) => {
        const next = { ...current };
        delete next[clarification.id];
        return next;
      });
      onChanged?.();
    } catch (submitError) {
      if (submitError instanceof WorkItemRequestError && submitError.status === 409) {
        // 已被他人作答或 revision 已变：内联提示 + 重取（拿到新状态/新 revision）。
        setErrors((current) => ({ ...current, [clarification.id]: CONFLICT_HINT }));
        onChanged?.();
      } else {
        setErrors((current) => ({
          ...current,
          [clarification.id]:
            submitError instanceof Error ? submitError.message : String(submitError),
        }));
      }
    } finally {
      setPostingId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em" }}>
          澄清问答
        </h3>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>agent 的提问等你在下方答复</span>
      </div>
      {sorted.map((clarification) => (
        <ClarificationCard
          key={clarification.id}
          clarification={clarification}
          posting={postingId === clarification.id}
          anyPosting={postingId !== null}
          draft={draftFor(clarification)}
          error={errors[clarification.id] ?? null}
          onDraftChange={(value) =>
            setDrafts((current) => ({ ...current, [clarification.id]: value }))
          }
          onSubmit={() => void submit(clarification)}
        />
      ))}
    </div>
  );
}
