/**
 * Linked clips: several clips that behave as one.
 *
 * Premiere links a video clip to the sound that came in with it, and Resolve
 * lets any selection be linked with Ctrl+Alt+L. Here a video clip already
 * carries its own sound, so linking is for the pairs an editor makes by hand:
 * footage and the title over it, a shot and the music cue under it, the two
 * halves of a cutaway. Once linked, selecting one selects all of them, so
 * every edit that follows the selection - moving, deleting, copying - takes
 * the whole group, and a trim moves every edge by the same amount.
 *
 * A group is a shared id on the clips, not a list kept elsewhere: a clip that
 * is deleted, split or copied carries its membership with it and nothing has
 * to be kept in step. The cost is that a group can be left with one member,
 * which means nothing - `tidyLinkGroups` drops those.
 */
import type { Clip } from '@shared/types';

let counter = 0;

/** A fresh group id. Not a clip id, so it cannot be confused with one. */
export function newLinkGroup(): string {
  counter += 1;
  return `link-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Every clip in the same group as `clipId`, itself first.
 *
 * First because a drag takes its anchor from the head of the selection: the
 * clip under the pointer has to be the one the others follow.
 */
export function partnersOf(clips: Record<string, Clip>, clipId: string): string[] {
  const clip = clips[clipId];
  if (!clip?.linkGroup) return clip ? [clipId] : [];
  return [
    clipId,
    ...Object.values(clips)
      .filter((candidate) => candidate.id !== clipId && candidate.linkGroup === clip.linkGroup)
      .map((candidate) => candidate.id),
  ];
}

/**
 * The selection a click really means: every partner of everything picked.
 *
 * The order of what was picked is kept, so the clip the pointer is on stays
 * the anchor of a drag.
 */
export function expandSelection(clips: Record<string, Clip>, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const partner of partnersOf(clips, id)) {
      if (seen.has(partner)) continue;
      seen.add(partner);
      out.push(partner);
    }
  }
  return out;
}

/**
 * Link everything given into one group.
 *
 * Linking a clip that is already linked brings its whole group along, which is
 * what joining two groups has to mean: linking A to B, where B was linked to
 * C, cannot leave C behind and still be one unit.
 */
export function linkClips(
  clips: Record<string, Clip>,
  ids: readonly string[],
): Record<string, Clip> {
  const members = new Set(expandSelection(clips, ids.filter((id) => clips[id])));
  if (members.size < 2) return clips;

  const group = newLinkGroup();
  const next = { ...clips };
  for (const id of members) next[id] = { ...next[id], linkGroup: group };
  return next;
}

/** Take these clips (and their partners) out of whatever group they are in. */
export function unlinkClips(
  clips: Record<string, Clip>,
  ids: readonly string[],
): Record<string, Clip> {
  const members = expandSelection(clips, ids.filter((id) => clips[id]));
  const next = { ...clips };
  let changed = false;
  for (const id of members) {
    if (!next[id].linkGroup) continue;
    const { linkGroup: _dropped, ...rest } = next[id];
    next[id] = rest as Clip;
    changed = true;
  }
  return changed ? next : clips;
}

/** Whether these clips are all in one group already. */
export function isLinked(clips: Record<string, Clip>, ids: readonly string[]): boolean {
  const groups = new Set(ids.map((id) => clips[id]?.linkGroup));
  return ids.length > 1 && groups.size === 1 && !groups.has(undefined);
}

/**
 * Drop groups with nothing to be linked to.
 *
 * Deleting one half of a pair leaves the other wearing a group id that means
 * nothing, and a clip that says it is linked but moves alone is worse than one
 * that never claimed to be.
 */
export function tidyLinkGroups(clips: Record<string, Clip>): Record<string, Clip> {
  const counts = new Map<string, number>();
  for (const clip of Object.values(clips)) {
    if (clip.linkGroup) counts.set(clip.linkGroup, (counts.get(clip.linkGroup) ?? 0) + 1);
  }

  const lonely = [...counts.entries()].filter(([, count]) => count < 2).map(([group]) => group);
  if (lonely.length === 0) return clips;

  const drop = new Set(lonely);
  const next = { ...clips };
  for (const clip of Object.values(clips)) {
    if (clip.linkGroup && drop.has(clip.linkGroup)) {
      const { linkGroup: _dropped, ...rest } = clip;
      next[clip.id] = rest as Clip;
    }
  }
  return next;
}

/**
 * Give copies their own links.
 *
 * A copy carries the group id of what it was copied from, which would leave
 * the copy moving whenever the original did - paste a linked pair and the
 * paste is welded to the thing it came from. Copies of the same group are
 * linked to each other instead, and a copy that came over alone is not linked
 * to anything.
 *
 * Splitting uses this too: the halves on the right of the cut become a group
 * of their own, so a cut linked pair is two linked pairs, as in Premiere.
 */
export function regroupCopies<T extends { linkGroup?: string }>(copies: readonly T[]): T[] {
  const counts = new Map<string, number>();
  for (const copy of copies) {
    if (copy.linkGroup) counts.set(copy.linkGroup, (counts.get(copy.linkGroup) ?? 0) + 1);
  }
  if (counts.size === 0) return [...copies];

  const remap = new Map<string, string | undefined>();
  for (const [group, count] of counts) remap.set(group, count > 1 ? newLinkGroup() : undefined);

  return copies.map((copy) => {
    if (!copy.linkGroup) return copy;
    const group = remap.get(copy.linkGroup);
    if (group) return { ...copy, linkGroup: group };
    const { linkGroup: _alone, ...rest } = copy;
    return rest as T;
  });
}

/** How far a clip's edge may move, in frames, either way. Both are >= 0. */
export interface TrimRoom {
  left: number;
  right: number;
}

/**
 * The room one edge has: what the footage holds, what the clip itself needs to
 * stay at least one frame long, and the neighbour it must not grow over.
 *
 * `limitFrame` is the furthest the edge may go on the timeline (the neighbour
 * rule the single-clip trim already applies); `sourceFrames` is how much
 * footage the file has, left out for a still, which has no end.
 */
export function clipTrimRoom(
  clip: Clip,
  edge: 'start' | 'end',
  limitFrame: number,
  sourceFrames?: number,
): TrimRoom {
  const offset = clip.sourceOffsetFrames;
  if (edge === 'start') {
    // Left: back into footage before the in point, and never past frame 0.
    const footage = Math.max(0, offset);
    const left = Math.min(footage, Math.max(0, clip.startFrame), Math.max(0, clip.startFrame - limitFrame));
    // Right: eat into the clip, leaving it a frame.
    return { left, right: Math.max(0, clip.durationFrames - 1) };
  }

  const remaining =
    sourceFrames === undefined ? Number.POSITIVE_INFINITY : Math.max(0, sourceFrames - (offset + clip.durationFrames));
  return {
    left: Math.max(0, clip.durationFrames - 1),
    right: Math.min(remaining, Math.max(0, limitFrame - (clip.startFrame + clip.durationFrames))),
  };
}

/**
 * The move every clip in the group can make.
 *
 * Linked clips that came back from a trim at different lengths would no longer
 * be linked in any useful sense, so the one with the least room decides: the
 * trim stops where the tightest clip stops, rather than letting the others
 * drift past it.
 */
export function sharedTrimDelta(rooms: readonly TrimRoom[], wanted: number): number {
  if (rooms.length === 0) return wanted;
  if (wanted < 0) return -Math.min(-wanted, ...rooms.map((room) => room.left));
  if (wanted > 0) return Math.min(wanted, ...rooms.map((room) => room.right));
  return 0;
}
