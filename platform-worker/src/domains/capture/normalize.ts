import { randomBase64Url } from '../sync/room.ts';
import type { CaptureRecord } from './types.ts';

export const NOTE_MAX_BYTES = 8192;
const ID_BYTES = 16;
const DEFAULT_SOURCE = 'bookmarklet';

function capByBytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeBody(raw: string): CaptureRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const body = parsed as Record<string, unknown>;
  if (!isHttpUrl(body.url)) return null;

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const rawNote = typeof body.note === 'string' ? body.note.trim() : '';
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : DEFAULT_SOURCE;

  return {
    id: randomBase64Url(ID_BYTES),
    url: body.url,
    title,
    note: capByBytes(rawNote, NOTE_MAX_BYTES),
    ts: new Date().toISOString(),
    source,
  };
}
