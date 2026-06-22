const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_WEEK = 604_800;

/** Single relative-time formatter — replaces per-component copies. */
export function timeAgo(date: Date, style: 'short' | 'ago' = 'short'): string {
  const secs = (Date.now() - date.getTime()) / MS_PER_SECOND;
  const suffix = style === 'ago' ? ' ago' : '';
  if (secs < SECONDS_PER_MINUTE) return 'just now';
  if (secs < SECONDS_PER_HOUR) return `${Math.floor(secs / SECONDS_PER_MINUTE)}m${suffix}`;
  if (secs < SECONDS_PER_DAY) return `${Math.floor(secs / SECONDS_PER_HOUR)}h${suffix}`;
  if (secs < SECONDS_PER_WEEK) return `${Math.floor(secs / SECONDS_PER_DAY)}d${suffix}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
