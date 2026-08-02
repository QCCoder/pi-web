"use client";

import { useEffect } from "react";
import { globalAgentEvents } from "@/lib/sse/global-agent-events";

/**
 * 在 AppShell 顶层挂一次。把 useSessionActivity 的 runningIds 同步给全局 SSE 管理器：
 * 新增 running session 连上 /api/agent/[id]/events，停止的断开。事件经 applyAgentEvent
 * 写 SessionRuntimeStore + SessionMessagesCache（按 sessionId 分片）——后台 session 事件不丢。
 */
export function useGlobalAgentEvents(runningIds: Set<string>): void {
  useEffect(() => {
    globalAgentEvents.syncRunningIds([...runningIds]);
  }, [runningIds]);
}
