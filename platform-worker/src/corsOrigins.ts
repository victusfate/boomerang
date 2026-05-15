/** Production browser origins — mirrored in `wrangler.jsonc` → `vars.EXTRA_CORS_ORIGINS`. */
export const BOOMERANG_PRODUCTION_CORS_ORIGINS = [
  'https://victusfate.github.io',
  'https://boomerang-news.com',
  'https://www.boomerang-news.com',
] as const;

export const BOOMERANG_DEV_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
] as const;

/** All built-in origins (dev + production). */
export const BOOMERANG_ALLOWED_CORS_ORIGINS: readonly string[] = [
  ...BOOMERANG_PRODUCTION_CORS_ORIGINS,
  ...BOOMERANG_DEV_CORS_ORIGINS,
];

/** Comma-separated production origins for Wrangler `EXTRA_CORS_ORIGINS` / ricochet integrators. */
export const BOOMERANG_EXTRA_CORS_ORIGINS = BOOMERANG_PRODUCTION_CORS_ORIGINS.join(',');
