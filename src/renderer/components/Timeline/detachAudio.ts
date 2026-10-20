/**
 * Detach audio: a video clip's sound, as a clip of its own.
 *
 * Here a video clip carries its own sound - it plays from the clip, and the
 * clip sits on a picture track. Every editor lets that sound be pulled out
 * when it has to be edited apart from the picture (a J or L cut, a slip, a
 * level on one stretch only):
 *
 * - Final Cut: Clip > Detach Audio (Control-Shift-S) turns the sound into a
 *   connected audio clip under the video, and the video keeps none.
 * - Filmora and CapCut: right-click > Detach / Separate audio; the sound lands
 *   on an audio track and the video is muted.
 * - Premiere and Resolve keep picture and sound as linked parts from the
 *   start; Unlink (Ctrl+Shift+L / Ctrl+Alt+L) is what frees them, and the
 *   parts stay where they are.
 *
 * So: the sound goes to an audio track at exactly the same time, reading the
 * same stretch of the file at the same speed, with the clip's fades, level,
 * pan and EQ; the picture clip's own sound goes quiet (`audioDetached`), so
 * the sound is heard once, in playback and in the export. The two stay linked,
 * as Premiere's parts are, until unlinked - so they still move, trim and are
 * deleted together.
 *
 * What users ask for in the forums once picture and sound are apart is to see
 * when they have drifted and to get them back: Premiere marks a linked pair
 * that is out of step with the offset in red on both parts, and offers Move
 * into Sync and Slip into Sync on it. `syncOffsets` is that mark, and
 * `bringIntoSync` the two fixes. `rejoinAudio` puts the sound back in the
 * picture clip when nothing about it has been changed apart from the level -
 * the step Final Cut has no way back from but Undo.
 */
import type { Clip, MediaAsset, ProjectState, Track } from '@shared/types';
import { createClip, createTrack } from '@renderer/store/types';
import { speedOf } from '@renderer/timing/clipSpeed';
import { newLinkGroup, tidyLinkGroups } from './linkGroups';
import { moveClip } from './timelineOps';
import { insertionRow, nextTrackName, timelineRows, withRowOrders } from './trackRows';

type KindOf = (uri: string) => MediaAsset['kind'] | undefined;

const endOf = (clip: Pick<Clip, 'startFrame' | 'durationFrames'>): number => clip.startFrame + clip.durationFrames;

/**
 * Whether a video file has sound to detach, as far as is known. A file that
 * came in from disk had its sound pulled out on import (`audioUri`), so one
 * without it has none - a screen recording, a drone shot. A file with no
 * path (dropped into a browser) was never asked, and is given the benefit of
 * the doubt.
 */
export function assetHasSound(asset: Pick<MediaAsset, 'kind' | 'audioUri' | 'sourcePath' | 'hasAudio'> | undefined): boolean {
  if (!asset || asset.kind !== 'video') return false;
  // Sound already pulled out, or the probe found an audio track; a file not
  // probed gets the benefit of the doubt (an old project, a browser drop),
  // and only a probe that found no audio hides detach for good.
  return Boolean(asset.audioUri) || asset.hasAudio === true || (asset.hasAudio === undefined && !asset.sourcePath);
}

/** Whether a clip's sound can be detached: a picture clip of a video file, still carrying it. */
export function canDetachAudio(clip: Clip | undefined, track: Pick<Track, 'type'> | undefined, kindOf: KindOf): boolean {
  if (!clip || !track) return false;
  if (track.type === 'audio' || track.type === 'captions') return false;
  if (clip.title || clip.caption || clip.audioDetached || clip.audioOnly) return false;
  return kindOf(clip.sourceUri) === 'video';
}

export interface DetachResult {
  project: ProjectState;
  /** The new sound clips, in the order of the picture clips they came from. */
  soundIds: string[];
  /** The picture clips whose sound was detached. */
  pictureIds: string[];
}

/**
 * Detach the sound of every clip in `ids` that has one to detach.
 *
 * Each sound goes on the first audio track, top to bottom, with room for it
 * at exactly that time - unlocked, nothing in the way - so the sound of
 * clips that follow one another lands on one track, back to back, and a
 * transition's crossfade between them carries over to the sound. Where no
 * track has room, a new one is made under the others (one, shared by every
 * sound that needs it, unless two of those overlap each other).
 */
export function detachAudio(
  project: ProjectState,
  ids: readonly string[],
  kindOf: KindOf,
  hasSound: (uri: string) => boolean = () => true,
): DetachResult {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const pictures = [...new Set(ids)]
    .map((id) => project.clips[id])
    .filter((clip): clip is Clip => canDetachAudio(clip, tracks.get(clip?.trackId ?? ''), kindOf) && hasSound(clip.sourceUri))
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  if (pictures.length === 0) return { project, soundIds: [], pictureIds: [] };

  let rows = timelineRows(project.tracks);
  let tracksChanged = false;
  const clips = { ...project.clips };
  const soundIds: string[] = [];

  /** Sounds given a track so far, before they are made. */
  const placed: Array<Pick<Clip, 'trackId' | 'startFrame' | 'durationFrames'>> = [];
  /** Is [start, end) clear on this track, counting the sounds placed so far? */
  const free = (trackId: string, start: number, end: number): boolean =>
    ![...Object.values(project.clips), ...placed].some((other) => other.trackId === trackId && other.startFrame < end && endOf(other) > start);

  /*
    Sounds that do not overlap each other go on one track together - the
    pictures of a cut sequence keep their sound back to back, which is what
    lets a transition's crossfade carry over to it. So the pictures are laid
    in layers first (each layer a run that never overlaps itself), and each
    layer goes whole onto the first audio track with room for all of it, or
    onto a new track of its own.
  */
  const layers: Clip[][] = [];
  for (const picture of pictures) {
    const layer = layers.find((candidate) => endOf(candidate[candidate.length - 1]) <= picture.startFrame);
    if (layer) layer.push(picture);
    else layers.push([picture]);
  }
  const placement = new Map<string, Track>();
  for (const layer of layers) {
    let target = rows.find((track) => track.type === 'audio' && !track.locked && layer.every((picture) => free(track.id, picture.startFrame, endOf(picture))));
    if (!target) {
      // Where a new audio track goes: under the last one.
      target = createTrack('audio', 0, nextTrackName(rows, 'audio'));
      rows = [...rows];
      rows.splice(insertionRow(rows, 'audio'), 0, target);
      tracksChanged = true;
    }
    for (const picture of layer) {
      placement.set(picture.id, target);
      placed.push({ trackId: target.id, startFrame: picture.startFrame, durationFrames: picture.durationFrames });
    }
  }

  for (const picture of pictures) {
    const start = picture.startFrame;
    const target = placement.get(picture.id) as Track;

    const group = picture.linkGroup ?? newLinkGroup();
    const base = createClip({
      trackId: target.id,
      name: picture.name,
      sourceUri: picture.sourceUri,
      startFrame: start,
      durationFrames: picture.durationFrames,
      sourceOffsetFrames: picture.sourceOffsetFrames,
    });
    // The same stretch of the same file, at the same speed, with the fades,
    // level, pan and EQ the sound had on the picture clip.
    const sound: Clip = {
      ...base,
      volume: picture.volume,
      pan: picture.pan,
      eq: { ...picture.eq },
      ...(picture.speed !== undefined ? { speed: picture.speed } : {}),
      ...(picture.reversed !== undefined ? { reversed: picture.reversed } : {}),
      ...(picture.fadeInFrames !== undefined ? { fadeInFrames: picture.fadeInFrames } : {}),
      ...(picture.fadeOutFrames !== undefined ? { fadeOutFrames: picture.fadeOutFrames } : {}),
      linkGroup: group,
      audioOnly: true,
    };
    clips[sound.id] = sound;
    clips[picture.id] = { ...picture, linkGroup: group, audioDetached: true };
    soundIds.push(sound.id);
  }

  return {
    project: { ...project, clips, ...(tracksChanged ? { tracks: withRowOrders(rows) } : {}) },
    soundIds,
    pictureIds: pictures.map((clip) => clip.id),
  };
}

/* Pairs ------------------------------------------------------------------- */

/** The overlap of two clips on the timeline, in frames (0 when they do not meet). */
const overlap = (a: Clip, b: Clip): number => Math.max(0, Math.min(endOf(a), endOf(b)) - Math.max(a.startFrame, b.startFrame));

/**
 * The other half of a detached pair: the sound of a picture clip, or the
 * picture of a sound clip - linked to it, of the same file. Where a group
 * holds more than one (a sound under two pictures of one take), the one it
 * overlaps most, then the nearest.
 */
export function pairedClip(clips: Record<string, Clip>, clipId: string): Clip | undefined {
  const clip = clips[clipId];
  if (!clip?.linkGroup || !(clip.audioDetached || clip.audioOnly)) return undefined;
  const wantSound = clip.audioDetached === true;
  let best: Clip | undefined;
  for (const other of Object.values(clips)) {
    if (other.id === clip.id || other.linkGroup !== clip.linkGroup || other.sourceUri !== clip.sourceUri) continue;
    if (wantSound ? !other.audioOnly : !other.audioDetached) continue;
    if (
      !best ||
      overlap(clip, other) > overlap(clip, best) ||
      (overlap(clip, other) === overlap(clip, best) && Math.abs(other.startFrame - clip.startFrame) < Math.abs(best.startFrame - clip.startFrame))
    ) {
      best = other;
    }
  }
  return best;
}

/**
 * How far a sound is from its picture, in timeline frames: positive when the
 * sound plays late, negative when early, 0 in step. Two clips are in step
 * when the same moment of the file plays at the same moment of the timeline:
 * `start - offset / speed` is where the file's first frame would sit, and
 * the difference between the two of those is the drift.
 *
 * Null when the two run at different speeds, where there is no one number.
 */
export function syncOffset(picture: Clip, sound: Clip): number | null {
  const speed = speedOf(picture);
  if (Math.abs(speedOf(sound) - speed) > 1e-9 || Boolean(picture.reversed) !== Boolean(sound.reversed)) return null;
  const zeroOf = (clip: Clip): number => clip.startFrame - clip.sourceOffsetFrames / speed;
  const offset = zeroOf(sound) - zeroOf(picture);
  return Math.abs(offset) < 0.5 ? 0 : offset;
}

/**
 * Every part of a detached pair that is out of step, with what to show on
 * it: on the sound, how late it is; on the picture, the same the other way
 * round - Premiere's red numbers, one on each part.
 */
export function syncOffsets(clips: Record<string, Clip>): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const clip of Object.values(clips)) {
    if (!clip.audioOnly) continue;
    const picture = pairedClip(clips, clip.id);
    if (!picture) continue;
    const offset = syncOffset(picture, clip);
    if (offset === null || offset === 0) continue;
    const frames = Math.round(offset);
    offsets.set(clip.id, frames);
    // A picture under two drifting sounds shows the larger drift.
    if (Math.abs(frames) >= Math.abs(offsets.get(picture.id) ?? 0)) offsets.set(picture.id, -frames);
  }
  return offsets;
}

/** "+12", "-3", "+1:05" - a drift as the timeline marks it, in frames up to a second. */
export function syncOffsetLabel(frames: number, fps: number): string {
  const sign = frames < 0 ? '-' : '+';
  const size = Math.abs(Math.round(frames));
  const perSecond = Math.max(1, Math.round(fps));
  if (size < perSecond) return `${sign}${size}`;
  const seconds = Math.floor(size / perSecond);
  const rest = size % perSecond;
  return `${sign}${seconds}:${String(rest).padStart(2, '0')}`;
}

/**
 * Put one part of a drifted pair back in step with the other, Premiere's two
 * ways: `move` shifts the clip along the timeline, `slip` keeps it where it is
 * and changes which stretch of the file it plays. Either way only the clip
 * asked about changes; its partner is the reference.
 *
 * Returns the clips unchanged when there is nothing to do, or when the fix
 * cannot be made: a move onto another clip, or a slip past either end of the
 * file (`sourceFrames`, in frames of the file, when it is known).
 */
export function bringIntoSync(
  clips: Record<string, Clip>,
  clipId: string,
  mode: 'move' | 'slip',
  sourceFrames?: number,
): Record<string, Clip> {
  const clip = clips[clipId];
  const partner = pairedClip(clips, clipId);
  if (!clip || !partner) return clips;
  const picture = clip.audioDetached ? clip : partner;
  const sound = clip.audioDetached ? partner : clip;
  const offset = syncOffset(picture, sound);
  if (offset === null || offset === 0) return clips;
  // How far this clip has to go: the sound back by the drift, the picture on by it.
  const delta = clip.id === sound.id ? -offset : offset;

  if (mode === 'move') {
    const start = Math.round(clip.startFrame + delta);
    if (start < 0) return clips;
    const end = start + clip.durationFrames;
    const blocked = Object.values(clips).some(
      (other) => other.id !== clip.id && other.trackId === clip.trackId && other.startFrame < end && endOf(other) > start,
    );
    if (blocked) return clips;
    // moveClip, not a bare write: keyframes travel with their clip.
    return { ...clips, [clip.id]: moveClip(clip, start) };
  }

  // Slip: the same place on the timeline, the file moved under it.
  const sourceOffsetFrames = Math.round(clip.sourceOffsetFrames - delta * speedOf(clip));
  if (sourceOffsetFrames < 0) return clips;
  if (sourceFrames !== undefined && sourceOffsetFrames + Math.round(clip.durationFrames * speedOf(clip)) > sourceFrames) return clips;
  return { ...clips, [clip.id]: { ...clip, sourceOffsetFrames } };
}

/* Rejoining ---------------------------------------------------------------- */

/** What rejoining a picture clip's sound would do. */
export type RejoinState =
  /** Its sound clip is gone (deleted): the picture's own sound simply comes back. */
  | 'restore'
  /** Its sound clip lines up with it exactly: the sound goes back in, its level, pan and EQ with it. */
  | 'join'
  /** The sound clip was moved, trimmed or retimed apart from the picture: nothing to rejoin safely. */
  | 'apart'
  /** Not a picture clip whose sound was detached. */
  | 'none';

export function rejoinState(clips: Record<string, Clip>, clipId: string): RejoinState {
  const clip = clips[clipId];
  const picture = clip?.audioDetached ? clip : clip?.audioOnly ? pairedClip(clips, clipId) : undefined;
  if (!picture) return 'none';
  const sound = pairedClip(clips, picture.id);
  if (!sound) return 'restore';
  const lined =
    sound.startFrame === picture.startFrame &&
    sound.durationFrames === picture.durationFrames &&
    sound.sourceOffsetFrames === picture.sourceOffsetFrames &&
    speedOf(sound) === speedOf(picture) &&
    Boolean(sound.reversed) === Boolean(picture.reversed);
  return lined ? 'join' : 'apart';
}

/**
 * Put detached sound back in its picture clips.
 *
 * A sound that still lines up with its picture is removed and the picture
 * plays its own sound again, at the sound clip's level, pan and EQ. A picture
 * whose sound clip was deleted gets its own sound back. A sound that was moved
 * or trimmed apart is left alone - joining it would undo that edit without
 * saying so - and counted in `apart`.
 *
 * The fades are the picture's: a clip's fades take its picture and its sound
 * together, so a fade changed on the sound alone gives way to the picture's.
 */
export function rejoinAudio(
  clips: Record<string, Clip>,
  ids: readonly string[],
): { clips: Record<string, Clip>; joined: string[]; apart: number } {
  const next = { ...clips };
  const joined: string[] = [];
  let apart = 0;
  const seen = new Set<string>();

  for (const id of ids) {
    const clip = next[id];
    const picture = clip?.audioDetached ? clip : clip?.audioOnly ? pairedClip(next, id) : undefined;
    if (!picture || seen.has(picture.id)) continue;
    seen.add(picture.id);
    const state = rejoinState(next, picture.id);
    if (state === 'apart') {
      apart += 1;
      continue;
    }
    const sound = state === 'join' ? pairedClip(next, picture.id) : undefined;
    const { audioDetached: _quiet, ...rest } = picture;
    void _quiet;
    next[picture.id] = sound ? { ...rest, volume: sound.volume, pan: sound.pan, eq: { ...sound.eq } } : rest;
    if (sound) delete next[sound.id];
    joined.push(picture.id);
  }

  return { clips: joined.length > 0 ? tidyLinkGroups(next) : clips, joined, apart };
}
