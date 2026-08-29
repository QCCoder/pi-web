import { Suspense } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";

/**
 * First-paint shell guess from the User-Agent. The client corrects it against
 * the real viewport (matchMedia) right after hydration, so a wrong guess only
 * ever costs one immediate re-render — but without it every phone SSRs the
 * desktop three-column shell and only flips to the mobile shell once the
 * whole bundle has hydrated, which takes seconds on a slow device/network
 * (the "先显示 PC 样式、切手机很慢" symptom).
 */
const MOBILE_UA = /Android|iPhone|iPod|iPad|Mobile|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i;

export default async function Home() {
  const userAgent = (await headers()).get("user-agent") ?? "";
  return (
    <Suspense>
      <I18nProvider>
        <AppShell initialIsMobile={MOBILE_UA.test(userAgent)} />
      </I18nProvider>
    </Suspense>
  );
}
