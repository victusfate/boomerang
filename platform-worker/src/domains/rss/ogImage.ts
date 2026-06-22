const OG_REGEX =
  /property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image(?::secure_url)?["']/i;

const TWITTER_IMAGE_REGEX =
  /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*name=["']twitter:image(?::src)?["']/i;

const HTML_SCAN_MAX_BYTES = 512_000;
const LOOPBACK_OCTET = 127;
const RFC1918_CLASS_A_OCTET = 10;
const RFC1918_CLASS_B_OCTET = 172;
const RFC1918_CLASS_B_SECOND_OCTET_MIN = 16;
const RFC1918_CLASS_B_SECOND_OCTET_MAX = 31;
const RFC1918_CLASS_C_OCTET = 192;
const RFC1918_CLASS_C_SECOND_OCTET = 168;
const LINK_LOCAL_OCTET = 169;
const LINK_LOCAL_SECOND_OCTET = 254;
const RFC6598_CGN_OCTET = 100;
const RFC6598_CGN_SECOND_OCTET_MIN = 64;
const RFC6598_CGN_SECOND_OCTET_MAX = 127;

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
  const slice = html.length > HTML_SCAN_MAX_BYTES ? html.slice(0, HTML_SCAN_MAX_BYTES) : html;

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
    if (a === LOOPBACK_OCTET) return false;                                                              // 127.x.x.x  loopback
    if (a === RFC1918_CLASS_A_OCTET) return false;                                                       // 10.x.x.x   RFC-1918
    if (a === RFC1918_CLASS_B_OCTET && b >= RFC1918_CLASS_B_SECOND_OCTET_MIN && b <= RFC1918_CLASS_B_SECOND_OCTET_MAX) return false;  // RFC1918 private range class B
    if (a === RFC1918_CLASS_C_OCTET && b === RFC1918_CLASS_C_SECOND_OCTET) return false;                 // 192.168.x  RFC-1918
    if (a === LINK_LOCAL_OCTET && b === LINK_LOCAL_SECOND_OCTET) return false;                           // 169.254.x  link-local
    if (a === RFC6598_CGN_OCTET && b >= RFC6598_CGN_SECOND_OCTET_MIN && b <= RFC6598_CGN_SECOND_OCTET_MAX) return false;  // RFC6598 carrier-grade NAT
    if (a === 0) return false;                                                                           // 0.x.x.x    "this network"
    return true; // public IPv4 — allowed
  }

  return true;
}
