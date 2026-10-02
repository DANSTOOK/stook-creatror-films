import type { CaptionLink, Clip, ProjectState, Track } from '@shared/types';
import { isReversed, speedOf } from '@renderer/timing/clipSpeed';

/**
 * Captions that follow the edit.
 *
 * A caption is the words somebody says, and those words are in a clip's
 * footage. So a caption is tied to that footage - `caption.link`: which clip,
 * and which seconds of its source - the way Final Cut connects captions to a
 * clip rather than to a place on the timeline. (Premiere keeps captions on
 * the sequence and moves them only with a ripple across every track; cut a
 * clip out and move the rest by hand, and its captions stay behind. That was
 * this editor's known problem after phase 1.)
 *
 * After every edit, `followCaptions` puts each linked caption where its
 * footage now is:
 *
 * - the clip moved, or was carried along by a ripple: the caption moves;
 * - the clip was trimmed: a caption whose words are still in the edit stays
 *   on them; one the trim cuts into is shortened to what is left; one whose
 *   words are gone is PARKED - taken off the timeline and out of every
 *   render, but kept (`project.parkedCaptions`), so trimming back, or undo,
 *   brings it back exactly as it was;
 * - the clip was deleted: its captions are parked the same way, and return
 *   if the same footage comes back;
 * - the clip was cut in two: nothing moves, and each caption then follows
 *   the half its words are in - a caption that straddles the cut follows
 *   the half with more of it once the halves part;
 * - the speed changed: the caption takes the clip's new pace. Played
 *   backwards, a clip is silent, and its captions are parked.
 *
 * A caption moved, trimmed or cut BY HAND is tied again from where it was
 * put - to the footage under it, or to nothing if there is none. An
 * unlinked caption (one read from a file, or unlinked on purpose) stays
 * where it is, as in phase 1.
 *
 * Times in a link are seconds of the footage, so none of this depends on
 * the project's frame rate. Pure: the project in, the project out.
 */

/** How sure it is that a clip carries sound: 0 none (a still, a title), 1 perhaps, 2 yes. */
export type SoundOf = (clip: Clip) => 0 | 1 | 2;

const EPSILON = 1e-6;

/** The seconds of footage a clip shows, in the order it shows them. */
function footageOf(clip: Clip, fps: number): { from: number; to: number } {
  const from = clip.sourceOffsetFrames / fps;
  return { from, to: from + (clip.durationFrames * speedOf(clip)) / fps };
}

/** The timeline frame (not rounded) at which a clip shows second `seconds` of its footage. */
const frameOf = (clip: Clip, seconds: number, fps: number): number =>
  clip.startFrame + (seconds * fps - clip.sourceOffsetFrames) / speedOf(clip);

/** The second of footage a clip shows at a timeline frame, also past its ends. */
const footageAt = (clip: Clip, frame: number, fps: number): number =>
  (clip.sourceOffsetFrames + (frame - clip.startFrame) * speedOf(clip)) / fps;

const isCaption = (clip: Clip): boolean => Boolean(clip.caption);

/**
 * Tie a caption to the footage under it, or null when there is none.
 *
 * Which clip: one that carries sound and is under the caption's middle (or
 * its start). When several are - a video with a song under it - the track
 * asked for wins, then a clip known to have sound, then a dialogue track
 * over a music one, then the upper track.
 *
 * What is tied is the stretch its words cover (the whole caption when it
 * has none). How long it leads in before them and holds after them is kept
 * apart (`lead`, `hold`), so a caption that stays up half a second after
 * the last word keeps doing so when its clip moves, without being taken
 * for words that reach past the clip.
 */
export function tieCaption(project: ProjectState, source: Clip, soundOf: SoundOf, preferTrackId?: string | null): Clip | null {
  if (!source.caption) return null;
  const { fps } = project;
  const start = source.startFrame;
  const end = source.startFrame + source.durationFrames;
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const covering = (frame: number): Clip[] =>
    Object.values(project.clips).filter(
      (clip) => !isCaption(clip) && !clip.title && !isReversed(clip) && soundOf(clip) > 0 && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames,
    );
  let candidates = covering(start + (end - start) / 2);
  if (candidates.length === 0) candidates = covering(start);
  if (candidates.length === 0) return null;

  const rank = (clip: Clip): number[] => {
    const track = tracks.get(clip.trackId) as Track | undefined;
    return [clip.trackId === preferTrackId ? 0 : 1, 2 - soundOf(clip), track?.bus === 'dialogue' ? 0 : 1, -(track?.order ?? 0)];
  };
  const [anchor] = candidates.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.id.localeCompare(b.id);
  });

  // From here on the caption runs at its clip's pace: its words are counted in
  // seconds of footage, so those of a caption made at another pace are rescaled.
  const speed = speedOf(anchor);
  const scale = speed / speedOf(source);
  const words = (source.caption.words ?? []).map((word) => (scale === 1 ? word : { ...word, start: word.start * scale, end: word.end * scale }));
  const { speed: _speed, ...unpaced } = source;
  void _speed;
  const caption: Clip = { ...unpaced, sourceOffsetFrames: Math.round(source.sourceOffsetFrames * scale), ...(speed !== 1 ? { speed } : {}) };
  // Where its words start and end on the timeline, kept inside the caption itself.
  const wordFrame = (seconds: number): number => caption.startFrame + (seconds * fps - caption.sourceOffsetFrames) / speed;
  const spokenStart = words.length > 0 ? Math.min(end, Math.max(start, wordFrame(words[0].start))) : start;
  const spokenEnd = words.length > 0 ? Math.max(spokenStart, Math.min(end, wordFrame(words[words.length - 1].end))) : end;

  // And inside the footage the clip shows: what reaches past it is lead or hold.
  const shown = footageOf(anchor, fps);
  const from = Math.min(shown.to, Math.max(shown.from, footageAt(anchor, spokenStart, fps)));
  const to = Math.max(from, Math.min(shown.to, footageAt(anchor, spokenEnd, fps)));
  const lead = Math.max(0, (frameOf(anchor, from, fps) - start) / fps);
  const hold = Math.max(0, (end - frameOf(anchor, to, fps)) / fps);
  // The moment of footage its own content second 0 falls on.
  const origin = footageAt(anchor, start, fps) - caption.sourceOffsetFrames / fps;
  const link: CaptionLink = { clipId: anchor.id, sourceUri: anchor.sourceUri, from, to, origin, ...(lead > EPSILON ? { lead } : {}), ...(hold > EPSILON ? { hold } : {}) };
  const { link: _old, words: _words, ...content } = source.caption;
  void _old;
  void _words;
  return { ...caption, caption: { ...content, ...(words.length > 0 ? { words } : {}), link } };
}

const timingOf = (clip: Clip | undefined): string =>
  clip ? `${clip.trackId}|${clip.startFrame}|${clip.durationFrames}|${clip.sourceOffsetFrames}|${speedOf(clip)}|${isReversed(clip)}` : '';

interface Piece {
  clip: Clip;
  /** Seconds of footage. */
  a: number;
  b: number;
  /** Timeline frames, not rounded. */
  start: number;
  end: number;
}

/**
 * Where a linked caption's footage is now: the stretches of timeline that
 * show any of it, stretches that run on into each other without a break (a
 * clip cut in two and left in place) joined into one.
 */
function piecesOf(link: CaptionLink, media: readonly Clip[], fps: number): Piece[] {
  const pieces: Piece[] = [];
  for (const clip of media) {
    const shown = footageOf(clip, fps);
    const a = Math.max(link.from, shown.from);
    const b = Math.min(link.to, shown.to);
    // A caption with no length of words (from === to) is at a single moment.
    const inside = link.to - link.from < EPSILON ? link.from >= shown.from - EPSILON && link.from < shown.to : b - a > EPSILON;
    if (!inside) continue;
    pieces.push({ clip, a, b: Math.max(a, b), start: frameOf(clip, a, fps), end: frameOf(clip, Math.max(a, b), fps) });
  }
  pieces.sort((x, y) => x.start - y.start);
  const joined: Piece[] = [];
  for (const piece of pieces) {
    const last = joined[joined.length - 1];
    const runsOn = last && Math.abs(piece.start - last.end) < 0.5 && Math.abs(piece.a - last.b) < 0.5 / fps && speedOf(piece.clip) === speedOf(last.clip) && piece.clip.trackId === last.clip.trackId;
    if (runsOn) {
      // The joined stretch belongs to whichever clip the caption names, else the first.
      joined[joined.length - 1] = { ...last, b: piece.b, end: piece.end, clip: piece.clip.id === link.clipId ? piece.clip : last.clip };
    } else joined.push({ ...piece });
  }
  return joined;
}

/** The caption as it sits when it follows `link`, or null when none of its footage is in the edit. */
function placed(caption: Clip, link: CaptionLink, media: readonly Clip[], fps: number): Clip | null {
  const pieces = piecesOf(link, media, fps);
  if (pieces.length === 0) return null;
  const longest = pieces.reduce((best, piece) => (piece.b - piece.a > best.b - best.a + EPSILON ? piece : best));
  const named = pieces.find((piece) => piece.clip.id === link.clipId);
  // The clip it names keeps it while it shows at least half as much of it as any other.
  const piece = named && named.b - named.a >= (longest.b - longest.a) / 2 - EPSILON ? named : longest;

  const speed = speedOf(piece.clip);
  // Lead and hold only where the words' own ends are in the edit: a caption
  // cut into by a trim ends on the cut.
  const lead = Math.abs(piece.a - link.from) < EPSILON ? link.lead ?? 0 : 0;
  const hold = Math.abs(piece.b - link.to) < EPSILON ? link.hold ?? 0 : 0;
  const startFrame = Math.max(0, Math.round(piece.start - lead * fps));
  const endFrame = Math.max(startFrame + 1, Math.round(piece.end + hold * fps));
  // Its content's zero is at `origin`; the footage at its first frame says how far in it starts.
  const firstSecond = footageAt(piece.clip, startFrame, fps);
  const sourceOffsetFrames = Math.max(0, Math.round((firstSecond - link.origin) * fps));

  const same =
    caption.startFrame === startFrame &&
    caption.durationFrames === endFrame - startFrame &&
    caption.sourceOffsetFrames === sourceOffsetFrames &&
    speedOf(caption) === speed &&
    link.clipId === piece.clip.id;
  if (same) return caption;
  const { speed: _speed, ...rest } = caption;
  void _speed;
  return {
    ...rest,
    startFrame,
    durationFrames: endFrame - startFrame,
    sourceOffsetFrames,
    ...(speed !== 1 ? { speed } : {}),
    caption: { ...(caption.caption as NonNullable<Clip['caption']>), link: link.clipId === piece.clip.id ? link : { ...link, clipId: piece.clip.id } },
  };
}

/** Two captions never share a frame: the earlier one gives way. */
function withoutOverlaps(clips: Record<string, Clip>, trackIds: ReadonlySet<string>): Record<string, Clip> {
  let out = clips;
  for (const trackId of trackIds) {
    const row = Object.values(out)
      .filter((clip) => clip.trackId === trackId && isCaption(clip))
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    for (let i = 0; i + 1 < row.length; i += 1) {
      const current = row[i];
      const next = row[i + 1];
      if (next.startFrame >= current.startFrame + current.durationFrames) continue;
      const durationFrames = Math.max(1, next.startFrame - current.startFrame);
      if (durationFrames === current.durationFrames) continue;
      if (out === clips) out = { ...clips };
      out[current.id] = { ...current, durationFrames };
      row[i] = out[current.id];
    }
  }
  return out;
}

/**
 * The project with every linked caption on its footage. `before` is the
 * project the edit started from: it is what tells an edit of the clip (the
 * caption follows) from an edit of the caption itself (the caption is tied
 * again from where it now is). Returns `after` itself when nothing moves.
 */
export function followCaptions(before: ProjectState | null, after: ProjectState, soundOf: SoundOf): ProjectState {
  const parked = after.parkedCaptions ?? {};
  const captionTracks = new Map(after.tracks.filter((track) => track.type === 'captions').map((track) => [track.id, track]));
  const hasParked = Object.keys(parked).length > 0;
  if (captionTracks.size === 0 && !hasParked) return after;

  const linked = Object.values(after.clips).filter((clip) => clip.caption?.link);
  if (linked.length === 0 && !hasParked) return after;

  const { fps } = after;
  const mediaBySource = new Map<string, Clip[]>();
  for (const clip of Object.values(after.clips)) {
    if (isCaption(clip) || clip.title || isReversed(clip) || soundOf(clip) === 0) continue;
    const list = mediaBySource.get(clip.sourceUri);
    if (list) list.push(clip);
    else mediaBySource.set(clip.sourceUri, [clip]);
  }

  let clips = after.clips;
  let nextParked = parked;
  let changed = false;
  const touched = new Set<string>();
  const setClip = (clip: Clip): void => {
    if (clips === after.clips) clips = { ...after.clips };
    clips[clip.id] = clip;
    touched.add(clip.trackId);
    changed = true;
  };
  const park = (clip: Clip): void => {
    if (clips === after.clips) clips = { ...after.clips };
    delete clips[clip.id];
    if (nextParked === parked) nextParked = { ...parked };
    nextParked[clip.id] = clip;
    changed = true;
  };
  const unpark = (clip: Clip): void => {
    if (nextParked === parked) nextParked = { ...parked };
    delete nextParked[clip.id];
    setClip(clip);
  };

  for (const caption of linked) {
    const track = captionTracks.get(caption.trackId);
    // A locked track is left exactly as it is.
    if (!track || track.locked) continue;
    const link = caption.caption?.link as CaptionLink;
    const earlier = before?.clips[caption.id];
    const ownChanged = !earlier || timingOf(earlier) !== timingOf(caption);
    const anchorSame = before ? timingOf(before.clips[link.clipId]) === timingOf(after.clips[link.clipId]) : true;

    if (before && ownChanged && anchorSame) {
      // Edited by hand: tied again from where it now is, to the track it was on if it can be.
      const anchorTrack = after.clips[link.clipId]?.trackId;
      const again = tieCaption(after, caption, soundOf, anchorTrack);
      const { link: _old, ...content } = caption.caption as NonNullable<Clip['caption']>;
      void _old;
      setClip(again ?? { ...caption, caption: content });
      continue;
    }

    const now = placed(caption, link, mediaBySource.get(link.sourceUri) ?? [], fps);
    if (now === null) park(caption);
    else if (now !== caption) setClip(now);
  }

  for (const caption of Object.values(parked)) {
    const track = captionTracks.get(caption.trackId);
    if (!track) {
      // Its track is gone, and with it the place it would come back to.
      if (nextParked === parked) nextParked = { ...parked };
      delete nextParked[caption.id];
      changed = true;
      continue;
    }
    if (track.locked) continue;
    const link = caption.caption?.link;
    if (!link) continue;
    const now = placed(caption, link, mediaBySource.get(link.sourceUri) ?? [], fps);
    if (now !== null) unpark(now);
  }

  if (!changed) return after;
  clips = withoutOverlaps(clips, touched);
  const { parkedCaptions: _dropped, ...rest } = after;
  void _dropped;
  return { ...rest, clips, ...(Object.keys(nextParked).length > 0 ? { parkedCaptions: nextParked } : {}) };
}

/** Captions tied to the footage under them, where there is any; the others are left as they are. */
export function linkCaptions(project: ProjectState, ids: readonly string[], soundOf: SoundOf, preferTrackId?: string | null): ProjectState {
  let clips = project.clips;
  for (const id of ids) {
    const clip = clips[id];
    if (!clip?.caption) continue;
    const tied = tieCaption({ ...project, clips }, clip, soundOf, preferTrackId);
    if (!tied) continue;
    if (clips === project.clips) clips = { ...project.clips };
    clips[id] = tied;
  }
  return clips === project.clips ? project : { ...project, clips };
}

/** Captions set free: they stay where they are, whatever happens to the clips. */
export function unlinkCaptions(project: ProjectState, ids: readonly string[]): ProjectState {
  let clips = project.clips;
  for (const id of ids) {
    const clip = clips[id];
    if (!clip?.caption?.link) continue;
    const { link: _link, ...content } = clip.caption;
    void _link;
    if (clips === project.clips) clips = { ...project.clips };
    clips[id] = { ...clip, caption: content };
  }
  return clips === project.clips ? project : { ...project, clips };
}
