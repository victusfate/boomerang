const OG_REGEX =
  /property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image(?::secure_url)?["']/i;

const TWITTER_IMAGE_REGEX =
  /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*name=["']twitter:image(?::src)?["']/i;

/** Max HTML bytes to scan for og:image (meta is almost always in head). */
const HTML_SCAN_MAX = 512_000;

export function resolveArticleImageUrl(raw: string, articlePageUrl: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith('?') || t.startsWith('&')) return undefined;
  try {
    const u = new URL(t, articlePageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export function extractOgImageFromHtml(html: string, pageUrl: string): string | undefined {
  const slice = html.length > HTML_SCAN_MAX ? html.slice(0, HTML_SCAN_MAX) : html;

  const tryMeta = (re: RegExp): string | undefined => {
    const m = slice.match(re);
    const raw = m?.[1] ?? m?.[2];
    if (!raw) return undefined;
    return resolveArticleImageUrl(raw.trim(), pageUrl);
  };

  const fromOg = tryMeta(OG_REGEX);
  if (fromOg) return fromOg;

  const fromTw = tryMeta(TWITTER_IMAGE_REGEX);
  if (fromTw) return fromTw;

  // JSON-LD (Next.js / many news sites)
  const jldImg =
    slice.match(/"image"\s*:\s*\[\s*"([^"]+)"/)
    ?? slice.match(/"image"\s*:\s*"([^"]+)"/);
  if (jldImg?.[1]) {
    const resolved = resolveArticleImageUrl(jldImg[1].trim(), pageUrl);
    if (resolved) return resolved;
  }

  return undefined;
}

/** Basic SSRF guard — public http(s) only, no loopback. */
export function isAllowedOgFetchUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]') return false;
  return true;
}
