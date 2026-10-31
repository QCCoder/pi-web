"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { grillReplyText, type GrillQuestion } from "@/lib/grill-card";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  grill: GrillQuestion;
  before: string;
  after: string;
  /** assistant 消息时间戳（ms）——倒计时锚点；缺省则不显示倒计时 */
  messageTimestamp?: number;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  /** 点击选项/发送自由输入时回调（ChatWindow 的 handleSend） */
  onSend?: (text: string) => void;
}

/**
 * grill 交互确认卡：dev-loop 执行会话在 assistant 消息里嵌 ```grill 块（lib/grill-card.ts
 * 解析），本组件渲染为选项按钮 + 倒计时 + 自由输入。点击把答复作为普通用户消息
 * 经既有发送路径送回会话——会话侧合同零改动。带 autoApprove 的卡在倒计时走完的
 * 瞬间按推荐项自动代答（本组件执行，答复带「超时自动按推荐」尾标，落档据此誊为
 * timeout-default 来源）；仅在挂载期间亲眼看到到点才代答——挂载时已过期的卡
 * （历史消息 / 页面中途才打开）只显示过期，绝不补发，防滚动旧会话误发陈旧答复。
 * 迟到的手动作答仍有效（走插话语义）。
 */
export function GrillMessageContent({ grill, before, after, messageTimestamp, cwd, onOpenFile, onSend }: Props) {
  const { t } = useI18n();
  const [answered, setAnswered] = useState<{ value: string; auto: boolean } | null>(null);
  const [custom, setCustom] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // 是否在挂载期间见过「未到期」——自动代答只发生在挂载中的到点跃迁，
  // 挂载即过期的卡（历史/迟到打开）不代答（防旧卡补发陈旧答复）。
  const sawAlive = useRef(false);

  const autoValue = grill.autoApprove && grill.recommended ? grill.recommended : undefined;
  const deadline = useMemo(
    () => (typeof messageTimestamp === "number" ? messageTimestamp + (grill.deadlineMin ?? 2) * 60_000 : null),
    [messageTimestamp, grill.deadlineMin],
  );
  const remainingMs = deadline !== null ? deadline - now : null;

  useEffect(() => {
    if (deadline === null || answered) return;
    const timer = setInterval(() => {
      const remaining = deadline - Date.now();
      if (remaining > 0) sawAlive.current = true;
      setNow(Date.now());
      // 自动代答：亲眼见证的到点跃迁 + 有发送路径 + 有推荐可代 + 没在打字 + 还没答。
      if (
        remaining <= 0
        && sawAlive.current
        && onSend !== undefined
        && autoValue !== undefined
        && custom.trim() === ""
      ) {
        setAnswered({ value: autoValue, auto: true });
        onSend?.(grillReplyText(grill.question, autoValue, { auto: true }));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline, answered, autoValue, custom, grill.question, onSend]);

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || answered) return;
    setAnswered({ value: trimmed, auto: false });
    onSend?.(grillReplyText(grill.question, trimmed));
  };

  const expired = remainingMs !== null && remainingMs <= 0;
  const countdownSec = remainingMs !== null ? Math.max(0, Math.ceil(remainingMs / 1000)) : null;

  return (
    <div>
      {before && <MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{before}</MarkdownBody>}
      <div
        className="grill-card"
        style={{
          margin: "8px 0",
          padding: "12px 14px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--bg-secondary, rgba(127,127,127,0.08))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: "var(--accent)" }}>
            {grill.stage ? `${t("grill.title")} · ${grill.stage}` : t("grill.title")}
          </span>
          {grill.n !== undefined && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {grill.n}{grill.total !== undefined ? ` / ${grill.total}` : ""}
            </span>
          )}
          {!answered && countdownSec !== null && !expired && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
              {t(autoValue !== undefined ? "grill.countdown" : "grill.countdownPlain", { sec: countdownSec })}
            </span>
          )}
          {!answered && expired && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--warning, #f9c22e)" }}>
              {t(autoValue !== undefined ? "grill.expiredAuto" : "grill.expiredPlain")}
            </span>
          )}
        </div>

        <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 10 }}>{grill.question}</div>

        {answered ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-dim)" }}>
              {answered.auto ? t("grill.autoAnswered") : t("grill.answered")}
            </span>
            <span
              style={{
                padding: "2px 10px",
                borderRadius: 999,
                background: answered.auto
                  ? "color-mix(in srgb, var(--warning, #f9c22e) 16%, transparent)"
                  : "color-mix(in srgb, var(--accent) 18%, transparent)",
                color: answered.auto ? "var(--warning, #f9c22e)" : "var(--accent)",
                fontSize: 12,
              }}
            >
              {answered.value}
            </span>
          </div>
        ) : onSend !== undefined ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              {(grill.options ?? []).map((option) => {
                const isRecommended = option === grill.recommended;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => send(option)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 8,
                      border: isRecommended ? "1px solid var(--accent)" : "1px solid var(--border)",
                      background: isRecommended ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                      color: "var(--text)",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {option}
                    {isRecommended && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>
                        {t("grill.recommended")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {onSend !== undefined && (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) send(custom);
                  }}
                  placeholder={t("grill.placeholder")}
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text)",
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  onClick={() => send(custom)}
                  disabled={!custom.trim()}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: custom.trim() ? "var(--text)" : "var(--text-dim)",
                    fontSize: 13,
                    cursor: custom.trim() ? "pointer" : "default",
                  }}
                >
                  {t("grill.send")}
                </button>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(grill.options ?? []).map((option) => (
              <span
                key={option}
                style={{
                  padding: "4px 12px",
                  borderRadius: 8,
                  border: `1px solid ${option === grill.recommended ? "var(--accent)" : "var(--border)"}`,
                  color: option === grill.recommended ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
              >
                {option}
                {option === grill.recommended ? ` · ${t("grill.recommended")}` : ""}
              </span>
            ))}
          </div>
        )}
      </div>
      {after && <MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{after}</MarkdownBody>}
    </div>
  );
}
