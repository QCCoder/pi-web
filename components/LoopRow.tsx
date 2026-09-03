"use client";

import { summarizeCron } from "@/lib/loops/cron-summary";

/** pi-loop/status.ts LoopStatusEntry 的 UI 侧镜像（GET /api/workspaces/:id/loops 行）。 */
export interface LoopStatus {
  name: string;
  pattern: string;
  level: string;
  cron: string;
  timezone: string;
  maxMinutes: number;
  paused: boolean;
  running: boolean;
  lastRun?: string;
  nextDue?: string;
}

export interface LoopRowProps {
  loop: LoopStatus;
  busy: boolean;
  onConfigure: (name: string) => void;
  onAction: (name: string, action: "pause" | "resume" | "stop") => void;
}

/** loop 单行（总览 Loops 区块与中栏 LoopsPanel 共用，避免两处漂移）。 */
export function LoopRow({ loop, busy, onConfigure, onAction }: LoopRowProps) {
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8 }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{loop.name}</span>
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
        {summarizeCron(loop.cron) ?? loop.cron}
      </span>
      <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--bg-hover)" }}>{loop.level}</span>
      <span style={{ fontSize: 12, color: loop.running ? "#15803d" : loop.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
        {loop.running
          ? "● 运行中"
          : loop.paused
            ? "已暂停"
            : loop.nextDue
              ? (new Date(loop.nextDue).getTime() > Date.now()
                  ? `下次 ${formatLoopClock(loop.nextDue)}`
                  : "已到期 · 待心跳")
              : "空闲"}
      </span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
        <button disabled={busy} onClick={() => onConfigure(loop.name)} style={rowLinkButton}>
          配置
        </button>
        <button disabled={busy} onClick={() => onAction(loop.name, loop.paused ? "resume" : "pause")} style={rowLinkButton}>
          {loop.paused ? "恢复" : "暂停"}
        </button>
        {loop.running && (
          <button disabled={busy} onClick={() => onAction(loop.name, "stop")} style={rowLinkButton}>
            停止
          </button>
        )}
      </span>
    </div>
  );
}

const rowLinkButton: React.CSSProperties = { fontSize: 12, color: "var(--accent)", background: "none", border: "none", padding: 0, cursor: "pointer" };

/** loop 行的本地时间格式化（从 WorkspaceOverview 原样迁入）。 */
export function formatLoopClock(iso: string): string {
  const date = new Date(iso);
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
