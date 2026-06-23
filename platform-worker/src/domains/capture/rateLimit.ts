export const CAPTURE_RATE_LIMIT_MAX = 60;
export const CAPTURE_RATE_WINDOW_MS = 60 * 60 * 1000;
const RL_PREFIX = 'capture-rl:';

interface RateRecord {
  count: number;
  windowStart: number;
}

type RateResult = { limited: false } | { limited: true; retryAfterSeconds: number };

export async function checkCaptureRateLimit(kv: KVNamespace, tokenId: string): Promise<RateResult> {
  const key = RL_PREFIX + tokenId;
  const now = Date.now();
  const existing = (await kv.get(key, 'json')) as RateRecord | null;

  if (!existing || now - existing.windowStart >= CAPTURE_RATE_WINDOW_MS) {
    await kv.put(key, JSON.stringify({ count: 1, windowStart: now }));
    return { limited: false };
  }

  if (existing.count >= CAPTURE_RATE_LIMIT_MAX) {
    // quality-ok: magic-number — milliseconds → seconds for the Retry-After header
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.windowStart + CAPTURE_RATE_WINDOW_MS - now) / 1000));
    return { limited: true, retryAfterSeconds };
  }

  await kv.put(key, JSON.stringify({ count: existing.count + 1, windowStart: existing.windowStart }));
  return { limited: false };
}
