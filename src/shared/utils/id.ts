/**
 * Collision-resistant ids for clips, tracks and keyframes.
 *
 * `crypto.randomUUID` exists in both Electron processes and in Node 20+, so the
 * fallback only matters for exotic embedders.
 */
export function createId(prefix = ''): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}
