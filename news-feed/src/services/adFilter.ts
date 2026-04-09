import type { Article } from '../types';

// ── Strong signals — any match scores heavily ────────────────────────────────
const STRONG_KEYWORDS = [
  'coupon', 'coupons', 'promo code', 'promo codes', 'discount code',
  'voucher', 'sponsored', 'advertorial', 'partner content', 'paid post',
  'paid content', 'paid partnership', 'presented by', 'brought to you by',
  'affiliate', 'referral link', '% off', 'percent off',
  'save $', 'save up to', 'limited time offer', 'exclusive offer',
  'free shipping', 'buy one get one', 'bogo',
];

// ── Moderate signals — need 2+ to trigger ────────────────────────────────────
const MODERATE_KEYWORDS = [
  'deal', 'deals', 'sale', 'sales event', 'clearance',
  'shop now', 'buy now', 'order now', 'get yours',
  'best price', 'lowest price', 'price drop', 'markdown',
  'subscribe and save', 'members only', 'early access',
];

// ── URL path segments that reliably indicate ad/shopping content ─────────────
const AD_URL_PATHS = [
  '/deals/', '/deal/', '/coupons/', '/coupon/', '/shopping/',
  '/sponsored/', '/partner/', '/promo/', '/offer/', '/offers/',
  '/affiliate/', '/commerce/', '/commerce-content/',
];

// ── URL query params common in affiliate/tracking links ──────────────────────
const AD_URL_PARAMS = /[?&](utm_source|utm_medium|utm_campaign|affiliate|ref=asc|tag=|ascsubtag)/i;

// ── Source-specific URL patterns (editorial sites with ad sub-sections) ──────
const SOURCE_URL_PATTERNS: Record<string, RegExp> = {
  wired:    /wired\.com\/(story\/(best-|buying-guide|gift-guide)|deals?|coupons?)/i,
  verge:    /theverge\.com\/(deals?|buying-guide|best)/i,
  tc:       /techcrunch\.com\/(deals?|sponsored)/i,
  guardian: /theguardian\.com\/(sponsored|paid-content)/i,
  ars:      /arstechnica\.com\/(sponsored)/i,
};

// ── Title patterns typical of affiliate / listicle-ad content ────────────────
const AD_TITLE_PATTERNS = [
  /^(best|top|cheapest|affordable)\s+\d+/i,      // "Best 10 laptops under…"
  /\$\d+(\.\d{2})?\s*(off|savings?|discount)/i,  // "$50 off" in title
  /\b(gift guide|buying guide)\b/i,
  /\b(black friday|cyber monday|prime day)\b.*\b(deal|sale|discount)\b/i,
];

function countMatches(text: string, keywords: string[]): number {
  return keywords.filter(kw => text.includes(kw)).length;
}

/**
 * Returns an ad-confidence score (0 = clean, ≥10 = filter out).
 * Exported for testing and potential UI display.
 */
export function adScore(article: Article): number {
  const title = article.title.toLowerCase();
  const desc  = article.description.toLowerCase();
  const text  = `${title} ${desc}`;
  const url   = article.url.toLowerCase();

  let score = 0;

  // Strong keyword match → instant filter
  if (countMatches(text, STRONG_KEYWORDS) > 0) score += 10;

  // Two or more moderate keywords → filter
  const moderateHits = countMatches(text, MODERATE_KEYWORDS);
  if (moderateHits >= 2) score += 8;
  else if (moderateHits === 1) score += 2;

  // URL path signals
  if (AD_URL_PATHS.some(p => url.includes(p))) score += 9;

  // Tracking/affiliate query params
  if (AD_URL_PARAMS.test(article.url)) score += 6;

  // Source-specific URL patterns
  const sourcePattern = SOURCE_URL_PATTERNS[article.sourceId];
  if (sourcePattern?.test(article.url)) score += 10;

  // Title pattern signals
  if (AD_TITLE_PATTERNS.some(p => p.test(article.title))) score += 5;

  return score;
}

/** Returns true if the article should be hidden as promotional content. */
export function isAd(article: Article): boolean {
  return adScore(article) >= 10;
}

/** Filter a list of articles, removing promotional content. */
export function filterAds(articles: Article[]): Article[] {
  return articles.filter(a => !isAd(a));
}
