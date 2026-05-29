/** Maps a 0-based rank index to a normalized score in [0, 1]: top-ranked → 1, bottom-ranked → 0. */
export function rankScore01(i: number, len: number): number {
  return 1 - (i / Math.max(len - 1, 1));
}
