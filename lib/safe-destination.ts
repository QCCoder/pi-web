/**
 * 解析登录后跳转目标：仅接受站内路径。
 *
 * 单看前缀不够：URL 解析器会把 `/\evil.example` 和 `/<TAB>/evil.example`
 * 读成 `//evil.example`（协议相对、指向外部 host）。所以按 origin 解析后
 * 要求 origin 不变（upstream 3e1f4361 的 URL-resolve 语义），否则回到 `/`。
 */
export function safeDestination(search: string, origin = "http://localhost"): string {
  const destination = new URLSearchParams(search).get("next");
  if (!destination?.startsWith("/")) return "/";
  try {
    const url = new URL(destination, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}
