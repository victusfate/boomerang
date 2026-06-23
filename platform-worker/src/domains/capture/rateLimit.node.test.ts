import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkCaptureRateLimit, CAPTURE_RATE_LIMIT_MAX, CAPTURE_RATE_WINDOW_MS } from './rateLimit.ts';

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
}

describe('checkCaptureRateLimit', () => {
  it('allows the first request', async () => {
    const kv = makeKv();
    const result = await checkCaptureRateLimit(kv as never, 'tok');
    assert.equal(result.limited, false);
  });

  it('limits the request that exceeds the max within the window', async () => {
    const kv = makeKv();
    for (let i = 0; i < CAPTURE_RATE_LIMIT_MAX; i++) {
      const r = await checkCaptureRateLimit(kv as never, 'tok');
      assert.equal(r.limited, false, `request ${i + 1} should pass`);
    }
    const over = await checkCaptureRateLimit(kv as never, 'tok');
    assert.equal(over.limited, true);
    if (over.limited) assert.ok(over.retryAfterSeconds > 0);
  });

  it('resets after the window elapses', async () => {
    const past = Date.now() - CAPTURE_RATE_WINDOW_MS - 1000;
    const kv = makeKv({
      'capture-rl:tok': JSON.stringify({ count: CAPTURE_RATE_LIMIT_MAX, windowStart: past }),
    });
    const result = await checkCaptureRateLimit(kv as never, 'tok');
    assert.equal(result.limited, false);
  });

  it('isolates counters per token', async () => {
    const kv = makeKv();
    for (let i = 0; i < CAPTURE_RATE_LIMIT_MAX; i++) await checkCaptureRateLimit(kv as never, 'a');
    const other = await checkCaptureRateLimit(kv as never, 'b');
    assert.equal(other.limited, false);
  });
});
