"use client";

import type { LoopRun } from "@/lib/loop/types";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  inferring: "正在分析任务",
  waiting_for_confirmation: "等待你确认计划",
  running: "正在执行",
  waiting_for_gate: "等待你确认",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const btnBase: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "3px 10px",
  fontSize: 12,
  cursor: "pointer",
  background: "var(--bg)",
  color: "var(--text)",
};
const btnPrimary: React.CSSProperties = { ...btnBase, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" };

/** Full-area placeholder shown the instant a Loop is triggered, before the
 *  orchestrator session even exists. Replaced by the live ChatWindow as soon as
 *  the session id arrives. */
export function LoopLaunchingPlaceholder({ name, status, error }: { name: string; status?: string; error?: string }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, color: "var(--text-muted)" }}>
      {!error && (
        <div style={{ width: 38, height: 38, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "pi-loop-spin 0.9s linear infinite" }} />
      )}
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
          {error ? "Loop 启动失败" : `Loop「${name}」正在启动`}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          {error ? error : `${STATUS_LABEL[status ?? "queued"] ?? status ?? "初始化中"} · 正在创建编排会话，马上就能看到它思考`}
        </div>
      </div>
      <style>{`@keyframes pi-loop-spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

/** Compact bar pinned above the chat while a Loop run is in flight. Carries the
 *  plan summary and the human-gate approve/reject controls so the user never has
 *  to leave the conversation to advance an L2 run. */
export function LoopStatusBar({ run, onDecide, onClose }: {
  run: LoopRun;
  onDecide: (decision: "approve" | "reject") => void;
  onClose: () => void;
}) {
  const waiting = run.status === "waiting_for_confirmation" || run.status === "waiting_for_gate";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 14px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", fontSize: 13, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: waiting ? "var(--accent)" : run.status === "failed" ? "#e5484d" : "var(--text-dim)", flexShrink: 0 }} />
      <span style={{ color: "var(--text-dim)" }}>Loop</span>
      <span style={{ fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap" }}>{STATUS_LABEL[run.status] ?? run.status}</span>
      {run.plan?.summary && (
        <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{run.plan.summary}</span>
      )}
      {run.gateRequest && !waiting && (
        <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{run.gateRequest}</span>
      )}
      {waiting && (
        <span style={{ display: "flex", gap: 6 }}>
          <button type="button" style={btnPrimary} onClick={() => onDecide("approve")}>确认继续</button>
          <button type="button" style={btnBase} onClick={() => onDecide("reject")}>拒绝</button>
        </span>
      )}
      <button type="button" style={{ ...btnBase, padding: "3px 8px" }} onClick={onClose} aria-label="关闭状态条">×</button>
    </div>
  );
}
