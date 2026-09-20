/**
 * 解析登录后跳转目标：仅接受站内路径。
 * `//host` 与 `/\host`（浏览器把 `/\` 规范化为 `//`）都会变成协议相对跳转到外部
 * origin，必须一并拒绝，防止登录后的开放重定向钓鱼。
 */
export function safeDestination(search: string): string {
  const destination = new URLSearchParams(search).get("next");
  return destination?.startsWith("/")
    && !destination.startsWith("//")
    && !destination.startsWith("/\\") ? destination : "/";
}
