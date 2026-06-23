/**
 * Build a `mailto:` URL that opens the user's default mail client pre-filled
 * with one or more saved pages. Dependency-free client-side email sharing —
 * no server, no token, no transactional-email provider.
 * @module services/buildMailto
 * @category Capture
 */

export interface MailtoItem {
  title: string;
  url: string;
}

export function buildMailto(items: MailtoItem[]): string {
  const subject =
    items.length === 1
      ? items[0].title || items[0].url
      : `${items.length} saved pages from boomerang`;
  const body = items.map(item => `${item.title || item.url}\n${item.url}`).join('\n\n');
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
