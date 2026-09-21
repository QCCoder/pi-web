/** Compact Chinese relative time for session lists ("刚刚" / "3小时" / …).
 *  极紧凑格式：数字与单位间无空格、不带「前」（2026-09 反馈：侧栏行宽宝贵，
 *  「3 小时前」→「3小时」）；>7 天回落本地日期。首页分组列表与侧栏会话行共用。 */
export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天`;
  return new Date(dateStr).toLocaleDateString();
}
