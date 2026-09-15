import { listAllSessions } from "./session-reader";
import { isSubagentChildSession } from "./subagent-child";
import { daemonClient } from "./daemon/client";
import type { SessionInfo } from "./types";

/** The sessions-list payload shared by `GET /api/sessions` and the SSR
 *  prefetch in `app/page.tsx` (方案二：首帧即真数据——SSR HTML 不再渲染
 *  「尚无工作区/加载中」假态，消除加载期的两次整体跳变；诊断记录见
 *  AGENTS.md 导航章 + docs/global-session-sidebar-design.md）。
 *
 *  Daemon merge is best-effort: disk list (persistent session index) is the
 *  source of truth; the live merge only adds not-yet-flushed sessions and the
 *  running-id set. `getClient` owns the acquisition semantics — the API route
 *  passes `daemonProxy()` (may wait for a sidecar spawn, ≤15s), the SSR path
 *  passes the direct `daemonClient` (fails fast — a render must never block
 *  on sidecar startup). */
export interface SessionsPayload {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  daemonDown: boolean;
}

export async function buildSessionsPayload(
  getClient: () => Promise<typeof daemonClient>,
): Promise<SessionsPayload> {
  const sessions = await listAllSessions();
  let merged = sessions;
  let runningIds: string[] = [];
  let daemonDown = false;
  try {
    const client = await getClient();
    const [liveMetas, running] = await Promise.all([
      client.liveSessions(),
      client.runningSessionIds(),
    ]);
    const presentIds = new Set(sessions.map((session) => session.id));
    const liveSynthesized: SessionInfo[] = [];
    for (const live of liveMetas.sessions) {
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
    merged = liveSynthesized.length > 0 ? [...liveSynthesized, ...sessions] : sessions;
    runningIds = running.ids;
  } catch {
    daemonDown = true;
  }

  // Tag subagent worker sessions so the sidebar hides them (they stay in the
  // payload so the parent's "open child" action can still resolve by id).
  const sessionsWithFlags = merged.map((session) =>
    isSubagentChildSession(session)
      ? { ...session, subagentChild: true }
      : session
  );
  return { sessions: sessionsWithFlags, runningSessionIds: runningIds, daemonDown };
}
