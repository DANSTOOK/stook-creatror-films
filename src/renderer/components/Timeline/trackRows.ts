import type { MediaAsset, Track, TrackType } from '@shared/types';

/**
 * How tracks are laid out on the timeline, and what may go on each.
 *
 * Every editor stacks picture tracks with the top row on top: a clip on a
 * higher row covers what is below it, and a new video track appears above
 * the others. Audio tracks sit underneath, the first one nearest the picture.
 *
 * `Track.order` is the compositing order - higher covers lower - and it is
 * what gets saved. This module maps it to rows and back, so that a project
 * made before this layout looks exactly as it did in the export: only the
 * rows of its video tracks are shown the other way up.
 */

/** Tracks that draw a picture: everything but audio. */
export const isVisualTrack = (track: Pick<Track, 'type'>): boolean => track.type !== 'audio';

/** Top to bottom: picture tracks, topmost layer first; then audio, first first. */
export function timelineRows(tracks: readonly Track[]): Track[] {
  const visual = tracks.filter(isVisualTrack).sort((a, b) => b.order - a.order);
  const audio = tracks.filter((track) => !isVisualTrack(track)).sort((a, b) => a.order - b.order);
  return [...visual, ...audio];
}

/**
 * Give every track the `order` that puts it on the given row.
 *
 * Rows must already be grouped (picture first); the bottom picture row gets
 * 0, so the top row covers everything, and audio continues the numbering.
 */
export function withRowOrders(rows: readonly Track[]): Track[] {
  const visual = rows.filter(isVisualTrack);
  const audio = rows.filter((track) => !isVisualTrack(track));
  const orders = new Map<string, number>();
  visual.forEach((track, index) => orders.set(track.id, visual.length - 1 - index));
  audio.forEach((track, index) => orders.set(track.id, visual.length + index));
  return rows.map((track) => ({ ...track, order: orders.get(track.id) ?? track.order }));
}

/** First and last row a track of this kind may occupy. */
function groupBounds(rows: readonly Track[], visual: boolean): { first: number; last: number } {
  const visualCount = rows.filter(isVisualTrack).length;
  return visual ? { first: 0, last: visualCount - 1 } : { first: visualCount, last: rows.length - 1 };
}

/** Whether a track can move one row up (-1) or down (+1) without leaving its group. */
export function canMoveTrack(rows: readonly Track[], trackId: string, delta: -1 | 1): boolean {
  const index = rows.findIndex((track) => track.id === trackId);
  if (index === -1) return false;
  const { first, last } = groupBounds(rows, isVisualTrack(rows[index]));
  const target = index + delta;
  return target >= first && target <= last;
}

/** The rows after moving a track one row, or null when it cannot move. */
export function moveTrackRow(rows: readonly Track[], trackId: string, delta: -1 | 1): Track[] | null {
  if (!canMoveTrack(rows, trackId, delta)) return null;
  const next = [...rows];
  const index = next.findIndex((track) => track.id === trackId);
  const [moved] = next.splice(index, 1);
  next.splice(index + delta, 0, moved);
  return next;
}

/**
 * Where a new track of `type` goes: at `row` when given (clamped into its
 * group), otherwise at the top of the picture tracks or the bottom of audio.
 */
export function insertionRow(rows: readonly Track[], type: TrackType, row?: number): number {
  const visual = type !== 'audio';
  const { first, last } = groupBounds(rows, visual);
  if (row === undefined) return visual ? 0 : rows.length;
  // An empty group has first > last; any position in it is `first`.
  return Math.min(Math.max(row, first), Math.max(first, last + 1));
}

/** "Video 3", "Audio 2": one more than the highest number already used. */
export function nextTrackName(tracks: readonly Track[], type: TrackType): string {
  const label = `${type[0].toUpperCase()}${type.slice(1)}`;
  const pattern = new RegExp(`^${label} (\\d+)$`);
  let highest = tracks.filter((track) => track.type === type).length;
  for (const track of tracks) {
    const match = pattern.exec(track.name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${label} ${highest + 1}`;
}

/**
 * Whether a clip of this media kind may sit on this track: sound on audio
 * tracks, pictures (video, stills) on picture tracks. A video's own sound
 * plays from its video clip. Unknown kinds (text) follow their track.
 */
export function trackAccepts(track: Pick<Track, 'type'>, kind: MediaAsset['kind'] | undefined): boolean {
  if (kind === undefined) return true;
  return kind === 'audio' ? track.type === 'audio' : isVisualTrack(track);
}
