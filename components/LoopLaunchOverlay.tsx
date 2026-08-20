"use client";

import { useState } from "react";
import type { LoopRun } from "@/lib/loop/types";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "正在执行",
  waiting_for_gate: "等待你确认",
  succeeded: "已完成",
  failed: "失败",
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
const gateInput: React.CSSProperties = {
  flex: 1,
  minWidth: 120,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 12,
  background: "var(--bg)",
  color: "var(--text)",
  outline: "none",
};

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
 *  last `LOOP_GATE:` request and the free-text answer + independent abort
 *  controls, so the user never has to leave the conversation to advance a run. */
