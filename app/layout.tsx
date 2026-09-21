import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    // 沉浸式状态栏（本批 #12）：内容延伸到状态栏下，配合 viewport.viewportFit
    // cover + shell 根容器的 safe-area padding（DesktopShell/MobileShell 根）。
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  // viewport-fit=cover（本批 #12）：black-translucent 状态栏下内容铺满全屏，
  // 安全区由 shell 根容器的 env(safe-area-inset-*) padding 让出。
  viewportFit: "cover",
  // 不设 interactive-widget（默认 resizes-visual）：键盘适配统一走
  // useVisualViewportKeyboard 的 --app-height/--app-vh 机制（--app-vh 见 globals.css：
  // @supports 分层，老内核回落 100%，避免 var(…,100dvh) 在不支持 dvh 的内核里
  // 计算值阶段整体失效），避免 Android 上布局视口与 dvh 是否跟随键盘收缩的各版本
  // 差异（两条路径行为不一致）。
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "var(--app-vh)", display: "flex", flexDirection: "column" }}>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
