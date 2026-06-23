import { sha256Hex } from '../sync/auth.ts';

export const DEDUP_TTL_SECONDS = 300;
const DEDUP_PREFIX = 'capture-dedup:';

async function dedupeKey(tokenId: string, url: string): Promise<string> {
  return `${DEDUP_PREFIX}${tokenId}:${await sha256Hex(url)}`;
}

export async function isDuplicate(kv: KVNamespace, tokenId: string, url: string): Promise<boolean> {
  return (await kv.get(await dedupeKey(tokenId, url))) !== null;
}

export async function markSeen(kv: KVNamespace, tokenId: string, url: string): Promise<void> {
  await kv.put(await dedupeKey(tokenId, url), '', { expirationTtl: DEDUP_TTL_SECONDS });
}
