/**
 * Match worker `normalizeHttpUrl` — fixes `&amp;` in stored URLs and
 * canonicalizes for href / window.open. Returns '' for invalid or
 * non-http(s) URLs; callers must guard the empty string.
 */
export function normalizeArticleNavUrl(raw: string): string {
  let s = raw.trim();
  if (s.includes('&amp;')) s = s.replace(/&amp;/g, '&');
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}
