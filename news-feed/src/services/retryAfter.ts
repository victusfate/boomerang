/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (!raw) return undefined;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds * 1000));
  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, asDate - Date.now());
}
