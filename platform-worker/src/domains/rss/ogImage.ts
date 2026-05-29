const OG_REGEX =
  /property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image(?::secure_url)?["']/i;

const TWITTER_IMAGE_REGEX =
  /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*name=["']twitter:image(?::src)?["']/i;

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

  const jldImg =
    slice.match(/"image"\s*:\s*\[\s*"([^"]+)"/)
    ?? slice.match(/"image"\s*:\s*"([^"]+)"/);
  if (jldImg?.[1]) {
    const resolved = resolveArticleImageUrl(jldImg[1].trim(), pageUrl);
    if (resolved) return resolved;
  }

  return undefined;
}

export function isAllowedOgFetchUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const h = u.hostname.toLowerCase();

  if (h === 'localhost' || h === '0.0.0.0') return false;
  if (h.startsWith('[')) return false;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 127) return false;                              // 127.x.x.x  loopback
    if (a === 10) return false;                               // 10.x.x.x   RFC-1918
    if (a === 172 && b >= 16 && b <= 31) return false;        // 172.16-31  RFC-1918
    if (a === 192 && b === 168) return false;                 // 192.168.x  RFC-1918
    if (a === 169 && b === 254) return false;                 // 169.254.x  link-local
    if (a === 100 && b >= 64 && b <= 127) return false;       // 100.64-127 shared (RFC-6598)
    if (a === 0) return false;                                // 0.x.x.x    "this network"
    return true; // public IPv4 — allowed
  }

  return true;
}
