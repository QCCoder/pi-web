import { listAllSessions } from "./session-reader";
import { isSubagentChildSession } from "./subagent-child";
import { liveSessions, runningStatus } from "./session-host/facade";
import type { SessionInfo } from "./types";

/** The sessions-list payload shared by `GET /api/sessions` and the SSR
 *  prefetch in `app/page.tsx` (方案二：首帧即真数据——SSR HTML 不再渲染
 *  「尚无工作区/加载中」假态，消除加载期的两次整体跳变；诊断记录见
 *  AGENTS.md 导航章 + docs/global-session-sidebar-design.md）。
 *
 *  Live merge is best-effort: disk list (persistent session index) is the
 *  source of truth; the in-process live merge only adds not-yet-flushed
 *  sessions and the running-id set — same process now, no transport to
 *  fail. */
export interface SessionsPayload {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  daemonDown: boolean;  // 保留字段（客户端兼容）；单进程下恒为 false
}

export async function buildSessionsPayload(): Promise<SessionsPayload> {
  const sessions = await listAllSessions();
  const presentIds = new Set(sessions.map((session) => session.id));
  const liveSynthesized: SessionInfo[] = [];
  for (const live of liveSessions()) {
    if (!live.id || presentIds.has(live.id)) continue;
    presentIds.add(live.id);
    liveSynthesized.push({
      path: live.sessionFile || "",
      id: live.id,
      cwd: live.cwd,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "(no messages)",
      projectRoot: live.cwd,
    });
  }
  const merged = liveSynthesized.length > 0 ? [...liveSynthesized, ...sessions] : sessions;
  const sessionsWithFlags = merged.map((session) =>
    isSubagentChildSession(session) ? { ...session, subagentChild: true } : session
  );
  return { sessions: sessionsWithFlags, runningSessionIds: runningStatus().ids, daemonDown: false };
}
