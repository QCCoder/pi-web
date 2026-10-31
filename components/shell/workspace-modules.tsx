"use client";

import type { ReactNode } from "react";
import type { WorkspaceSummary } from "@/lib/workspaces/types";

/**
 * 工作区模块入口的唯一合法出处（2026-10-26 手机导航统一，knowledge/reference/ui-shell.md
 * 「移动端导航」）：id / label / icon / capability 门控只在这里定义一份。消费方——
 * 手机壳聊天页 ⋯（chatMenuExtras）、工作区页 ⋯（MobileWorkspacePage）、平板壳
 * 头部模块条（MobileShell headerSlot）——一律经 workspaceModuleEntries 取，禁止再
 * 各自内联一份图标 + 门控（此前同一组内容抄了四份，加模块要改四处）。
 *
 * 桌面右坞 rail 是独立表面（36px 图标列规格不同，且多终端一项），暂不并入。
 */

export type WorkspaceModuleId =
  | "overview"
  | "files"
  | "work-items"
  | "knowledge"
  | "loops"
  | "ws-settings"
  | "archive";

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function WorkspaceModuleIcon({ kind, size = 16 }: { kind: WorkspaceModuleId; size?: number }) {
  switch (kind) {
    case "overview":
      return <svg width={size} height={size} {...ICON_PROPS}><path d="M3 9.5 12 3l9 6.5" /><path d="M5 8.5V21h14V8.5" /></svg>;
    case "files":
      return <svg width={size} height={size} {...ICON_PROPS}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;
    case "work-items":
      return <svg width={size} height={size} {...ICON_PROPS}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
    case "knowledge":
      return <svg width={size} height={size} {...ICON_PROPS}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>;
    case "loops":
      return <svg width={size} height={size} {...ICON_PROPS}><path d="M21 12a9 9 0 1 1-3.8-7.4" /><path d="M21 3v5h-5" /></svg>;
    case "ws-settings":
      return <svg width={size} height={size} {...ICON_PROPS}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>;
    case "archive":
      return <svg width={size} height={size} {...ICON_PROPS}><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><line x1="10" y1="12" x2="14" y2="12" /></svg>;
  }
}

export interface WorkspaceModuleEntry {
  id: WorkspaceModuleId;
  label: string;
  icon: ReactNode;
}

/** 基础序：文件 → 工作项 → 知识库 → Loops（work-items / knowledge 按 capability
 *  门控，不开则不出现）。`overview` 前插总览（平板壳模块条首项），`settings`
 *  追加工作区设置（手机两处 ⋯ 菜单的末项）。归档不在菜单里——它住工作区页
 *  「更多」卡片，图标仍从 WorkspaceModuleIcon 取。 */
export function workspaceModuleEntries(
  workspace: WorkspaceSummary | null,
  opts: { overview?: boolean; settings?: boolean } = {},
): WorkspaceModuleEntry[] {
  const entries: WorkspaceModuleEntry[] = [];
  if (opts.overview) entries.push({ id: "overview", label: "总览", icon: <WorkspaceModuleIcon kind="overview" /> });
  entries.push({ id: "files", label: "文件", icon: <WorkspaceModuleIcon kind="files" /> });
  if (workspace?.capabilities.includes("work-items")) {
    entries.push({ id: "work-items", label: "工作项", icon: <WorkspaceModuleIcon kind="work-items" /> });
  }
  if (workspace?.capabilities.includes("knowledge")) {
    entries.push({ id: "knowledge", label: "知识库", icon: <WorkspaceModuleIcon kind="knowledge" /> });
  }
  entries.push({ id: "loops", label: "Loops", icon: <WorkspaceModuleIcon kind="loops" /> });
  if (opts.settings) entries.push({ id: "ws-settings", label: "工作区设置", icon: <WorkspaceModuleIcon kind="ws-settings" /> });
  return entries;
}
