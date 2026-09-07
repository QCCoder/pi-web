/** Compact Chinese relative time for session lists ("刚刚" / "3 小时前" / …).
 *  搬自 HomeLanding —— 首页分组列表与中栏共用。 */
export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString();
}
