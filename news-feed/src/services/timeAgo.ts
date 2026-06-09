/** Single relative-time formatter — replaces per-component copies. */
export function timeAgo(date: Date, style: 'short' | 'ago' = 'short'): string {
  const secs = (Date.now() - date.getTime()) / 1000;
  const suffix = style === 'ago' ? ' ago' : '';
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m${suffix}`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h${suffix}`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d${suffix}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
