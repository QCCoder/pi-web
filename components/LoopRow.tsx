"use client";

import { useState } from "react";
import { summarizeCron } from "@/lib/loops/cron-summary";

/** packages/pi-loop/status.ts LoopStatusEntry 的 UI 侧镜像（GET /api/workspaces/:id/loops 行）。 */
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
  /** 可选：名字点击回调（LoopsPanel 传入 → 跨视图 reveal 到工作台文件区；
   *  总览区块不传，名字保持纯展示 span）。 */
  onNameClick?: () => void;
  /** 可选：整行点击（LoopsPanel 传入 → 右栏 loopConfig 视图；总览不传，行为不变）。 */
  onRowClick?: () => void;
  /** 可选：「运行」按钮回调（手动起一轮；总览不传，不渲染该按钮）。 */
  onRun?: () => void;
  /** 「配置」按钮是否渲染（LoopsPanel 行点击已开配置，隐藏按钮；默认 true 供总览）。 */
  showConfigureButton?: boolean;
}

/** loop 单行（总览 Loops 区块与中栏 LoopsPanel 共用，避免两处漂移）。 */
export function LoopRow({
  loop,
  busy,
  onConfigure,
  onAction,
  onNameClick,
  onRowClick,
  onRun,
  showConfigureButton = true,
}: LoopRowProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onRowClick}
      onMouseEnter={onRowClick ? () => setHovered(true) : undefined}
      onMouseLeave={onRowClick ? () => setHovered(false) : undefined}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 10,
        alignItems: "center",
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        cursor: onRowClick ? "pointer" : undefined,
        background: hovered ? "var(--bg-hover)" : undefined,
        transition: "background 0.12s",
      }}
    >
      {onNameClick ? (
        <button
          type="button"
          onClick={(event) => {
            // 行点击=开配置（onRowClick）——名字按钮自己的 reveal 语义不能连带触发它。
            event.stopPropagation();
            onNameClick();
          }}
          title="在工作台文件区定位此 loop 的文件"
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "inherit",
            textAlign: "left",
            textDecorationLine: "underline dotted",
          }}
        >
          {loop.name}
        </button>
      ) : (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{loop.name}</span>
      )}
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
        {summarizeCron(loop.cron) ?? loop.cron}
      </span>
      <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--bg-hover)" }}>{loop.level}</span>
      <span style={{ fontSize: 12, color: loop.running ? "#15803d" : loop.paused ? "var(--text-dim)" : "var(--text-muted)" }}>
        {loop.running ? "● 运行中" : loop.paused ? "已暂停" : formatNextDueLabel(loop)}
      </span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
        {onRun && (
          <button
            disabled={busy || loop.running}
            onClick={(event) => {
              event.stopPropagation();
              onRun();
            }}
            style={{ ...rowLinkButton, ...(busy || loop.running ? disabledButtonStyle : undefined) }}
          >
            运行
          </button>
        )}
        {showConfigureButton && (
          <button
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onConfigure(loop.name);
            }}
            style={{ ...rowLinkButton, ...(busy ? disabledButtonStyle : undefined) }}
          >
            配置
          </button>
        )}
        <button
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onAction(loop.name, loop.paused ? "resume" : "pause");
          }}
          style={{ ...rowLinkButton, ...(busy ? disabledButtonStyle : undefined) }}
        >
          {loop.paused ? "恢复" : "暂停"}
        </button>
        {loop.running && (
          <button
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onAction(loop.name, "stop");
            }}
            style={{ ...rowLinkButton, ...(busy ? disabledButtonStyle : undefined) }}
          >
            停止
          </button>
        )}
      </span>
    </div>
  );
}

// fix(task1-review): 与 sectionHeaderLinkStyle 等价（原抽取丢失 fontWeight）
const rowLinkButton: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: "var(--accent)", background: "transparent", border: 0, padding: 0, cursor: "pointer" };

/** disabled 必须可见：rowLinkButton 原样式无禁用态视觉，disabled 按钮看起来
 * 仍可点（同色同 pointer 光标），点击被浏览器静默吞掉 —— 「能点但没反应」。
 * （幽灵锁场景实测：loop.running=true 时运行按钮 disabled 无视觉，用户
 * 反馈「点击运行没效果」。） */
const disabledButtonStyle: React.CSSProperties = { opacity: 0.45, cursor: "default" };

/** loop 行的本地时间格式化（从 WorkspaceOverview 原样迁入）。 */
export function formatLoopClock(iso: string): string {
  const date = new Date(iso);
  const hhmm = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString() ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

// fix(lint purity)：react-hooks/purity 禁渲染期直接调 Date.now()（useMemo 回调同样算渲染期）——
// 与 WorkspaceOverview/HomeLanding 的 formatRelativeTime 同款：抽模块级 helper，每次渲染现取时钟，
// 语义与原内联一致（“下次/已到期”标签只需分钟级精度，组件随列表数据刷新重新渲染）。
function formatNextDueLabel(loop: LoopStatus): string {
  if (!loop.nextDue) return "空闲";
  return new Date(loop.nextDue).getTime() > Date.now()
    ? `下次 ${formatLoopClock(loop.nextDue)}`
    : "已到期 · 待心跳";
}
