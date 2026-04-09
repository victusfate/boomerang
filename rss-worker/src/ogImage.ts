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

/**
 * SSRF guard — rejects non-http(s), raw IP addresses, and RFC-1918 / link-local ranges.
 * News article URLs should always be public domain names.
 */
export function isAllowedOgFetchUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const h = u.hostname.toLowerCase();

  // Block named loopback / unspecified
  if (h === 'localhost' || h === '0.0.0.0') return false;

  // Block all raw IPv6 addresses (bracketed form e.g. [::1]) — news sites use domain names
  if (h.startsWith('[')) return false;

  // Block raw IPv4 addresses — private/reserved ranges and raw IPs in general
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 127) return false;                          // 127.0.0.0/8  loopback
    if (a === 10) return false;                           // 10.0.0.0/8   private
    if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12 private
    if (a === 192 && b === 168) return false;             // 192.168.0.0/16 private
    if (a === 169 && b === 254) return false;             // 169.254.0.0/16 link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false;  // 100.64.0.0/10 shared address space
    if (a === 0) return false;                            // 0.0.0.0/8
    // Block all remaining raw IPv4 — legitimate news URLs use domain names
    return false;
  }

  return true;
}
