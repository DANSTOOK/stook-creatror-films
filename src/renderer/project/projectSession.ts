/**
 * The open project as a session: its name, and whether it has changed since
 * it was last saved.
 *
 * "Changed" is read from the undo history and the library rather than from a
 * full comparison of the document. The history already records every edit
 * with an id, so the newest step at save time says exactly what was saved -
 * undoing back to it is clean again, as in every editor - and comparing ids is
 * free where serialising an hour-long project on every drag is not. The media
 * library sits outside the history (imports are not undoable), so its filing
 * is compared by a short signature.
 *
 * Pure, so it is tested directly.
 */

export interface SavedMarker {
  /** Id of the newest undo step when the project was saved; null for none. */
  undoTopId: string | null;
  /** `librarySignature` at the time. */
  library: string;
}

export function projectNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(scf|fep|json)$/i, '') || base;
}

/** Which assets are in the library and where each is filed, plus the bins. */
export function librarySignature(
  assets: readonly { id: string; binId?: string }[],
  bins: readonly { id: string; name: string; parentId: string | null }[],
): string {
  const filing = assets.map((asset) => `${asset.id}:${asset.binId ?? ''}`).join('|');
  const tree = bins.map((bin) => `${bin.id}:${bin.parentId ?? ''}:${bin.name}`).join('|');
  return `${filing}#${tree}`;
}

/**
 * Whether there is anything a save would keep.
 *
 * Never saved: dirty once anything was edited or imported - an untouched
 * blank project is not worth asking about.
 */
export function isDirty(saved: SavedMarker | null, current: SavedMarker): boolean {
  if (!saved) return current.undoTopId !== null || current.library !== librarySignature([], []);
  return saved.undoTopId !== current.undoTopId || saved.library !== current.library;
}

/** "just now", "5 min ago", "yesterday", "3 days ago", then a date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then) || then <= 0) return 'a while ago';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(then);
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "4:05" or "1:02:03" for a length in frames. */
export function formatLength(frames: number, fps: number): string {
  if (!(fps > 0) || !(frames > 0)) return '0:00';
  const total = Math.round(frames / fps);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** "Untitled project", then "Untitled project 2", 3... skipping names already used. */
export function nextUntitledName(existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has('untitled project')) return 'Untitled project';
  let index = 2;
  while (taken.has(`untitled project ${index}`)) index += 1;
  return `Untitled project ${index}`;
}
