"use client";

import { formatRelativeTime } from "@/lib/format-time";
import { useHydrated } from "@/hooks/useHydrated";

/**
 * 水合安全的会话相对时间标签（"刚刚"/"3小时"/本地日期）。formatRelativeTime
 * 每次渲染现取时钟（>7 天还回落 toLocaleDateString，locale 服务端/客户端可能
 * 不同），直接渲染进 SSR 树必然在桶跨界时触发 hydration mismatch——侧栏
 * 整树被客户端重建（"1 Issue"）的根因。这里水合首帧渲染空占位，挂载后再
 * 显示真实值；宿主：SSR 预取了会话数据的表面（ProjectSidebar 的 SessionRow）。
 * 客户端拉数后才挂载的列表（WorkspaceSessionList/SearchPalette）无此风险，
 * 可继续直接调 formatRelativeTime。
 */
export function RelativeTime({ dateStr, style }: { dateStr: string; style?: React.CSSProperties }) {
  const hydrated = useHydrated();
  return (
    <span title={dateStr} style={style}>
      {hydrated ? formatRelativeTime(dateStr) : ""}
    </span>
  );
}
