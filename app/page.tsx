import { Suspense } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { discoverWorkspaces } from "@/lib/workspaces/service";
import { buildSessionsPayload } from "@/lib/session-payload";
import { daemonClient } from "@/lib/daemon/client";
import type { WorkspaceSummary } from "@/lib/workspaces/types";
import type { SessionInfo } from "@/lib/types";

/**
 * First-paint shell guess from the User-Agent. The client corrects it against
 * the real viewport (matchMedia) right after hydration, so a wrong guess only
 * ever costs one immediate re-render — but without it every phone SSRs the
 * desktop three-column shell and only flips to the mobile shell once the
 * whole bundle has hydrated, which takes seconds on a slow device/network
 * (the "先显示 PC 样式、切手机很慢" symptom).
 */
const MOBILE_UA = /Android|iPhone|iPod|iPad|Mobile|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i;

/**
 * SSR data prefetch (方案二：首帧即真数据). Without it the server renders a
 * data-less shell —「尚无工作区」+「加载中」— which then jumps TWICE on the
 * client (workspaces → empty letter-ordered groups → activity-ordered filled
 * groups) while the cold /api/sessions walk (~400ms) holds the real content
 * hostage. Prefetching in-process seeds both lists, so the first paint is the
 * final layout and the post-hydration refresh is a silent same-data update.
 *
 * Failure semantics: EITHER prefetch may fail (best-effort `null`) — the
 * client then fetches as before, with skeleton gating in the sidebar instead
 * of lying empty states. The daemon merge here uses the DIRECT daemonClient
 * (fails fast); a render must never block on sidecar startup (≤15s) — that
 * wait stays on the API route, where callers already tolerate it.
 */
export default async function Home() {
  const userAgent = (await headers()).get("user-agent") ?? "";
  const [workspaces, sessionsPayload] = await Promise.all([
    discoverWorkspaces().catch(() => null),
    buildSessionsPayload(async () => daemonClient).catch(() => null),
  ]);
  const initialWorkspaces: WorkspaceSummary[] | null = workspaces ?? null;
  const initialSessions: SessionInfo[] | null = sessionsPayload?.sessions ?? null;
  const initialRunningIds: string[] | null = sessionsPayload?.runningSessionIds ?? null;
  return (
    <Suspense>
      <I18nProvider>
        <AppShell
          initialIsMobile={MOBILE_UA.test(userAgent)}
          initialWorkspaces={initialWorkspaces}
          initialSessions={initialSessions}
          initialRunningIds={initialRunningIds}
        />
      </I18nProvider>
    </Suspense>
  );
}
