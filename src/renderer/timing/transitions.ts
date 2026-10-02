import type { Clip, ProjectState, Track, Transition, TransitionAlignment, TransitionDirection, TransitionKind } from '@shared/types';
import { createId } from '@shared/utils/id';
import { isReversed, sourceFramesUsed, speedOf } from './clipSpeed';
import { moveClip } from '@renderer/components/Timeline/timelineOps';
import { partnersOf } from '@renderer/components/Timeline/linkGroups';

/**
 * Transitions, the arithmetic: where one sits on its cut, what footage it
 * needs, what it has, and what happens when that is not enough.
 *
 * A transition lives on a cut between two clips that touch on one track;
 * the clips never overlap in the project. Across it the outgoing clip (A)
 * is drawn past its end, and the incoming one (B) before its start, from the
 * footage beyond them - their handles, in Final Cut's and Premiere's word.
 * A one-second dissolve centred on the cut needs half a second past A's end
 * and half a second before B's start.
 *
 * When a clip has less than that, the editor is asked (the way Final Cut
 * and Resolve ask) and chooses between overlapping - both clips shortened
 * by what is missing and the track closed up, so the timeline gets that
 * much shorter - and holding the last or first frame for the missing part,
 * which keeps every clip where it is (Premiere's "repeated frames").
 *
 * All lengths are timeline frames; handles are counted at each clip's own
 * speed, and a reversed clip's footage beyond its end is before its source
 * offset, not after.
 */

/** One second, as Final Cut, Premiere and Resolve default to. */
export const DEFAULT_TRANSITION_SECONDS = 1;
/** Shortest a transition can be dragged to. */
export const MIN_TRANSITION_FRAMES = 2;

export const DIP_BLACK = '#000000';
export const DIP_WHITE = '#ffffff';

/** The three a menu offers: a dissolve, and a dip to black or white. */
export type TransitionPreset = 'crossDissolve' | 'dipToBlack' | 'dipToWhite' | 'wipe' | 'slide' | 'push';

export const TRANSITION_PRESETS: readonly TransitionPreset[] = ['crossDissolve', 'dipToBlack', 'dipToWhite', 'wipe', 'slide', 'push'];
export const TRANSITION_DIRECTIONS: readonly TransitionDirection[] = ['left', 'right', 'up', 'down'];

/** A wipe's edge by default: soft enough not to look like a cut, 10% of the frame. */
export const DEFAULT_SOFTNESS = 0.5;

export function presetKind(preset: TransitionPreset): { kind: TransitionKind; color: string; direction: TransitionDirection } {
  switch (preset) {
    case 'dipToBlack':
      return { kind: 'dip', color: DIP_BLACK, direction: 'left' };
    case 'dipToWhite':
      return { kind: 'dip', color: DIP_WHITE, direction: 'left' };
    // A wipe reads left to right, as text does; a slide or push comes in
    // from the right and travels left, the way a page turns.
    case 'wipe':
      return { kind: 'wipe', color: DIP_BLACK, direction: 'right' };
    case 'slide':
      return { kind: 'slide', color: DIP_BLACK, direction: 'left' };
    case 'push':
      return { kind: 'push', color: DIP_BLACK, direction: 'left' };
    case 'crossDissolve':
    default:
      return { kind: 'crossDissolve', color: DIP_BLACK, direction: 'left' };
  }
}

/** The preset a transition is, for menus and the panel. */
export function presetOf(transition: Pick<Transition, 'kind' | 'color'>): TransitionPreset {
  if (transition.kind === 'dip') return transition.color === DIP_WHITE ? 'dipToWhite' : 'dipToBlack';
  return transition.kind;
}

export const transitionsOf = (project: Pick<ProjectState, 'transitions'>): Transition[] => Object.values(project.transitions ?? {});

/* Handles --------------------------------------------------------------------- */

/**
 * Timeline frames of footage past a clip's end. `sourceLength` is the file's
 * length in frames; undefined for a still or a title, which never run out.
 */
export function tailHandle(clip: Pick<Clip, 'sourceOffsetFrames' | 'durationFrames' | 'speed' | 'reversed'>, sourceLength: number | undefined): number {
  if (sourceLength === undefined) return Number.POSITIVE_INFINITY;
  const available = isReversed(clip) ? clip.sourceOffsetFrames : sourceLength - clip.sourceOffsetFrames - sourceFramesUsed(clip);
  return Math.max(0, Math.floor(available / speedOf(clip)));
}

/** Timeline frames of footage before a clip's start. */
export function headHandle(clip: Pick<Clip, 'sourceOffsetFrames' | 'durationFrames' | 'speed' | 'reversed'>, sourceLength: number | undefined): number {
  if (sourceLength === undefined) return Number.POSITIVE_INFINITY;
  const available = isReversed(clip) ? sourceLength - clip.sourceOffsetFrames - sourceFramesUsed(clip) : clip.sourceOffsetFrames;
  return Math.max(0, Math.floor(available / speedOf(clip)));
}

/** How a transition's frames fall either side of its cut. */
export function sides(durationFrames: number, alignment: TransitionAlignment): { before: number; after: number } {
  const duration = Math.max(0, Math.round(durationFrames));
  const before = alignment === 'center' ? Math.floor(duration / 2) : alignment === 'end' ? duration : 0;
  return { before, after: duration - before };
}

/** The frames a transition covers on the timeline: [start, end), and its cut. */
export function transitionWindow(transition: Pick<Transition, 'durationFrames' | 'alignment'>, from: Pick<Clip, 'startFrame' | 'durationFrames'>): {
  start: number;
  end: number;
  cut: number;
} {
  const cut = from.startFrame + from.durationFrames;
  const { before, after } = sides(transition.durationFrames, transition.alignment);
  return { start: cut - before, end: cut + after, cut };
}

/** What a transition needs: frames past A's end and before B's start. */
export const neededHandles = (durationFrames: number, alignment: TransitionAlignment): { tail: number; head: number } => {
  const { before, after } = sides(durationFrames, alignment);
  return { tail: after, head: before };
};

export interface TransitionPlan {
  alignment: TransitionAlignment;
  /** Frames each side is short by, 0 when there is enough. */
  shortTail: number;
  shortHead: number;
}

/**
 * Where a new transition goes on a cut: across it when both clips have the
 * footage; wholly after it when only the outgoing clip does, wholly before
 * it when only the incoming one does; and across it, short, when neither
 * has enough - which is when the editor is asked.
 */
export function planTransition(tail: number, head: number, durationFrames: number): TransitionPlan {
  const centred = neededHandles(durationFrames, 'center');
  if (tail >= centred.tail && head >= centred.head) return { alignment: 'center', shortTail: 0, shortHead: 0 };
  if (tail >= durationFrames) return { alignment: 'start', shortTail: 0, shortHead: 0 };
  if (head >= durationFrames) return { alignment: 'end', shortTail: 0, shortHead: 0 };
  return {
    alignment: 'center',
    shortTail: Math.max(0, centred.tail - tail),
    shortHead: Math.max(0, centred.head - head),
  };
}

/** What an existing transition is short of, now, after whatever trims came since. */
export function shortfall(
  transition: Pick<Transition, 'durationFrames' | 'alignment'>,
  from: Clip,
  to: Clip,
  sourceLength: (clip: Clip) => number | undefined,
): { tail: number; head: number } {
  const needed = neededHandles(transition.durationFrames, transition.alignment);
  return {
    tail: Math.max(0, needed.tail - tailHandle(from, sourceLength(from))),
    head: Math.max(0, needed.head - headHandle(to, sourceLength(to))),
  };
}

/* Frames ------------------------------------------------------------------------ */

/**
 * The frame of footage a clip shows at a timeline frame, past its ends too:
 * a transition's outgoing clip runs on after its end, its incoming clip
 * starts before its start. Where the file runs out, its last (or first)
 * frame is held - which is what "freeze frames" is.
 */
export function extendedSourceFrame(
  clip: Pick<Clip, 'startFrame' | 'durationFrames' | 'sourceOffsetFrames' | 'speed' | 'reversed'>,
  frame: number,
  sourceLength: number | undefined,
): number {
  const elapsed = frame - clip.startFrame;
  const speed = speedOf(clip);
  const wanted = isReversed(clip)
    ? clip.sourceOffsetFrames + sourceFramesUsed(clip) - 1 - Math.round(elapsed * speed)
    : clip.sourceOffsetFrames + Math.round(elapsed * speed);
  const last = sourceLength === undefined ? Number.POSITIVE_INFINITY : Math.max(0, sourceLength - 1);
  return Math.min(Math.max(0, wanted), last);
}

/** How far through its window a transition is, 0 on its first frame, 0.5 on a centred cut. */
export const transitionProgress = (frame: number, window: { start: number; end: number }): number =>
  Math.min(1, Math.max(0, (frame - window.start) / Math.max(1, window.end - window.start)));

export interface ActiveTransition {
  transition: Transition;
  from: Clip;
  to: Clip;
  progress: number;
  window: { start: number; end: number; cut: number };
}

/** The transitions on screen at a frame, on visible tracks. */
export function activeTransitionsAt(project: Pick<ProjectState, 'clips' | 'tracks' | 'transitions'>, frame: number): ActiveTransition[] {
  if (!project.transitions) return [];
  const active: ActiveTransition[] = [];
  const tracks = new Map<string, Track>(project.tracks.map((track) => [track.id, track]));
  for (const transition of Object.values(project.transitions)) {
    const from = project.clips[transition.fromClipId];
    const to = project.clips[transition.toClipId];
    if (!from || !to) continue;
    const track = tracks.get(from.trackId);
    if (!track || !track.visible || track.type === 'audio' || track.type === 'captions') continue;
    const window = transitionWindow(transition, from);
    if (frame < window.start || frame >= window.end) continue;
    active.push({ transition, from, to, progress: transitionProgress(frame, window), window });
  }
  return active;
}

/* Keeping transitions honest ---------------------------------------------------- */

/**
 * Transitions whose cut is still there. A transition belongs to the cut at
 * its incoming clip's start: if another clip now ends there (the outgoing
 * one was split, or replaced), it moves to that clip; if nothing touches it
 * any more (a clip was moved away or deleted), it goes. Its length is kept
 * inside the two clips. Returns the same object when nothing changed.
 */
export function tidyTransitions(project: ProjectState): ProjectState {
  const transitions = project.transitions;
  if (!transitions || Object.keys(transitions).length === 0) return project;

  let changed = false;
  const kept: Record<string, Transition> = {};
  const endsAt = new Map<string, Clip>();
  for (const clip of Object.values(project.clips)) endsAt.set(`${clip.trackId}@${clip.startFrame + clip.durationFrames}`, clip);
  const cutsTaken = new Set<string>();

  for (const transition of Object.values(transitions)) {
    const to = project.clips[transition.toClipId];
    const from = to ? endsAt.get(`${to.trackId}@${to.startFrame}`) : undefined;
    if (!to || !from || from.id === to.id || cutsTaken.has(`${from.id}>${to.id}`)) {
      changed = true;
      continue;
    }
    cutsTaken.add(`${from.id}>${to.id}`);
    // Never longer than the two clips it joins can show between them.
    const longest = Math.max(MIN_TRANSITION_FRAMES, from.durationFrames + to.durationFrames);
    const durationFrames = Math.min(Math.max(MIN_TRANSITION_FRAMES, Math.round(transition.durationFrames)), longest);
    const next = from.id === transition.fromClipId && durationFrames === transition.durationFrames
      ? transition
      : { ...transition, fromClipId: from.id, durationFrames };
    if (next !== transition) changed = true;
    kept[next.id] = next;
  }
  return changed ? { ...project, transitions: kept } : project;
}

const HEX = /^#[0-9a-f]{6}$/i;
const KINDS: readonly TransitionKind[] = ['crossDissolve', 'dip', 'wipe', 'slide', 'push'];
const ALIGNMENTS: readonly TransitionAlignment[] = ['center', 'start', 'end'];

/** Transitions read from a file: every field present and valid, anything broken dropped. */
export function normalizeTransitions(raw: unknown): Record<string, Transition> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, Transition> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const source = (value ?? {}) as Partial<Record<keyof Transition, unknown>>;
    if (typeof source.fromClipId !== 'string' || typeof source.toClipId !== 'string') continue;
    const id = typeof source.id === 'string' && source.id ? source.id : createId('transition');
    const duration = typeof source.durationFrames === 'number' && Number.isFinite(source.durationFrames) ? source.durationFrames : 30;
    result[id] = {
      id,
      fromClipId: source.fromClipId,
      toClipId: source.toClipId,
      kind: KINDS.includes(source.kind as TransitionKind) ? (source.kind as TransitionKind) : 'crossDissolve',
      durationFrames: Math.max(MIN_TRANSITION_FRAMES, Math.round(duration)),
      alignment: ALIGNMENTS.includes(source.alignment as TransitionAlignment) ? (source.alignment as TransitionAlignment) : 'center',
      color: typeof source.color === 'string' && HEX.test(source.color) ? source.color.toLowerCase() : DIP_BLACK,
      direction: TRANSITION_DIRECTIONS.includes(source.direction as TransitionDirection) ? (source.direction as TransitionDirection) : 'left',
      softness: typeof source.softness === 'number' && Number.isFinite(source.softness) ? Math.min(1, Math.max(0, source.softness)) : DEFAULT_SOFTNESS,
      // Transitions made before the crossfade had it, as every new one does.
      audioCrossfade: source.audioCrossfade !== false,
    };
  }
  return result;
}

/* Overlapping -------------------------------------------------------------------- */

/** A clip with its last `frames` taken off, keeping the footage it still shows. */
export function trimTail(clip: Clip, frames: number): Clip {
  const cut = Math.min(Math.max(0, Math.round(frames)), clip.durationFrames - 1);
  if (cut === 0) return clip;
  // Reversed, the end of the clip is the start of its footage.
  const offset = isReversed(clip) ? clip.sourceOffsetFrames + Math.round(cut * speedOf(clip)) : clip.sourceOffsetFrames;
  return { ...clip, durationFrames: clip.durationFrames - cut, sourceOffsetFrames: offset };
}

/** A clip with its first `frames` taken off: it starts that much later. */
export function trimHead(clip: Clip, frames: number): Clip {
  const cut = Math.min(Math.max(0, Math.round(frames)), clip.durationFrames - 1);
  if (cut === 0) return clip;
  const offset = isReversed(clip) ? clip.sourceOffsetFrames : clip.sourceOffsetFrames + Math.round(cut * speedOf(clip));
  return { ...clip, startFrame: clip.startFrame + cut, durationFrames: clip.durationFrames - cut, sourceOffsetFrames: offset };
}

/** Everything that moves to close an overlap, and what stays behind out of step. */
export interface OverlapPlan {
  clips: Record<string, Clip>;
  /** How much shorter the track gets. */
  shift: number;
  /** Clips on other tracks after the cut that do not move with it (music, titles). */
  leftBehind: Clip[];
}

/**
 * Overlap: take what is missing off the end of A and the start of B (with
 * whatever is linked to them), and close the gap by moving B and everything
 * after it on the track - with their linked partners - that much earlier.
 * The track, and the timeline if it is the longest, gets `tail + head`
 * frames shorter.
 */
export function overlapClips(
  clips: Record<string, Clip>,
  from: Clip,
  to: Clip,
  tail: number,
  head: number,
): OverlapPlan {
  const partners = (clipId: string): string[] => partnersOf(clips, clipId);
  const cut = from.startFrame + from.durationFrames;
  const shift = tail + head;
  const next = { ...clips };
  if (shift === 0) return { clips: next, shift, leftBehind: [] };

  for (const id of partners(from.id)) if (next[id]) next[id] = trimTail(next[id], tail);
  for (const id of partners(to.id)) if (next[id]) next[id] = trimHead(next[id], head);

  // B and everything after it on this track, and what is linked to them.
  const moving = new Set<string>();
  for (const clip of Object.values(clips)) {
    if (clip.trackId === from.trackId && clip.startFrame >= cut) for (const id of partners(clip.id)) moving.add(id);
  }
  for (const id of moving) {
    const clip = next[id];
    if (!clip) continue;
    next[id] = moveClip(clip, Math.max(0, clip.startFrame - shift));
  }

  const leftBehind = Object.values(clips).filter(
    (clip) => clip.trackId !== from.trackId && clip.startFrame >= cut - tail && !moving.has(clip.id) && !partners(from.id).includes(clip.id),
  );
  return { clips: next, shift, leftBehind };
}

/** A new transition on the cut from `from` to `to`. */
export function createTransition(from: Clip, to: Clip, preset: TransitionPreset, durationFrames: number, alignment: TransitionAlignment): Transition {
  return {
    id: createId('transition'),
    fromClipId: from.id,
    toClipId: to.id,
    ...presetKind(preset),
    softness: DEFAULT_SOFTNESS,
    audioCrossfade: true,
    durationFrames: Math.max(MIN_TRANSITION_FRAMES, Math.round(durationFrames)),
    alignment,
  };
}

/* The sound ---------------------------------------------------------------------- */

/**
 * The project as the sound paths hear it: where a transition crossfades its
 * sound, the two clips across its cut - their own sound, and their linked
 * sound clips that meet at the same cut on one track - run on into each
 * other (as far as their footage goes) and carry an equal-power crossfade
 * over the transition's window, which the fade envelope writes onto their
 * gain (audio/fadeEnvelope). Final Cut does the same with Command-T.
 *
 * Equal power: the outgoing side at cos, the incoming at sin, so at the
 * midpoint each is at 0.707 (-3 dB) and the loudness holds steady through
 * the cut. The picture is untouched; this is only ever handed to the audio
 * engine and the export mix. Returns the same object when nothing changes.
 */
export function withAudioCrossfades(project: ProjectState, sourceLength: (clip: Clip) => number | undefined): ProjectState {
  const crossfading = transitionsOf(project).filter((transition) => transition.audioCrossfade !== false);
  if (crossfading.length === 0) return project;
  const clips = { ...project.clips };
  let changed = false;

  for (const transition of crossfading) {
    const from = project.clips[transition.fromClipId];
    const to = project.clips[transition.toClipId];
    if (!from || !to || from.title || to.title) continue;
    const cut = from.startFrame + from.durationFrames;
    const { before, after } = sides(transition.durationFrames, transition.alignment);

    // The picture clips, and linked sound meeting at the same cut.
    const pairs: Array<[Clip, Clip]> = [[from, to]];
    const incoming = partnersOf(project.clips, to.id).map((id) => project.clips[id]).filter(Boolean);
    for (const id of partnersOf(project.clips, from.id)) {
      const outgoing = project.clips[id];
      if (!outgoing || outgoing.id === from.id || outgoing.startFrame + outgoing.durationFrames !== cut) continue;
      const partner = incoming.find((clip) => clip.id !== to.id && clip.trackId === outgoing.trackId && clip.startFrame === cut);
      if (partner) pairs.push([outgoing, partner]);
    }

    for (const [out, into] of pairs) {
      if (isReversed(out) || isReversed(into)) continue;
      const tail = tailHandle(out, sourceLength(out));
      const head = headHandle(into, sourceLength(into));
      const runOn = Math.min(after, Number.isFinite(tail) ? tail : after);
      const runIn = Math.min(before, Number.isFinite(head) ? head : before);
      const current = clips[out.id];
      clips[out.id] = { ...current, durationFrames: current.durationFrames + runOn, crossfadeOutFrames: before + runOn };
      const incomingNow = clips[into.id];
      clips[into.id] = {
        ...incomingNow,
        startFrame: incomingNow.startFrame - runIn,
        durationFrames: incomingNow.durationFrames + runIn,
        sourceOffsetFrames: Math.max(0, incomingNow.sourceOffsetFrames - Math.round(runIn * speedOf(incomingNow))),
        crossfadeInFrames: runIn + after,
      };
      changed = true;
    }
  }
  return changed ? { ...project, clips } : project;
}

/** Equal-power gains across a crossfade: out at cos, in at sin. */
export const crossfadeOut = (progress: number): number => Math.cos((Math.min(1, Math.max(0, progress)) * Math.PI) / 2);
export const crossfadeIn = (progress: number): number => Math.sin((Math.min(1, Math.max(0, progress)) * Math.PI) / 2);

/** A cut a transition can go on: two clips touching on a picture track. */
export interface TimelineCut {
  fromId: string;
  toId: string;
  trackId: string;
  /** Where they touch. */
  frame: number;
  /** The transition already on it, if any. */
  transitionId: string | null;
}

/** Every cut on the picture tracks, for showing where a dragged transition can land. */
export function cutsOf(project: Pick<ProjectState, 'clips' | 'tracks' | 'transitions'>): TimelineCut[] {
  const visual = new Set(project.tracks.filter((track) => track.type !== 'audio' && track.type !== 'captions').map((track) => track.id));
  const onCut = new Map(transitionsOf(project).map((transition) => [`${transition.fromClipId}>${transition.toClipId}`, transition.id]));
  const byStart = new Map<string, Clip>();
  for (const clip of Object.values(project.clips)) if (visual.has(clip.trackId)) byStart.set(`${clip.trackId}@${clip.startFrame}`, clip);
  const cuts: TimelineCut[] = [];
  for (const from of Object.values(project.clips)) {
    if (!visual.has(from.trackId)) continue;
    const frame = from.startFrame + from.durationFrames;
    const to = byStart.get(`${from.trackId}@${frame}`);
    if (!to || to.id === from.id) continue;
    cuts.push({ fromId: from.id, toId: to.id, trackId: from.trackId, frame, transitionId: onCut.get(`${from.id}>${to.id}`) ?? null });
  }
  return cuts;
}

/**
 * The cut a transition dropped at `frame` on `trackId` goes on: the nearest
 * one on that track, as long as the pointer is over one of the two clips it
 * joins - over a clip, the nearer of its two ends.
 */
export function cutNear(
  project: Pick<ProjectState, 'clips'>,
  cuts: readonly TimelineCut[],
  trackId: string | null,
  frame: number,
): TimelineCut | null {
  let best: TimelineCut | null = null;
  for (const cut of cuts) {
    if (cut.trackId !== trackId) continue;
    const from = project.clips[cut.fromId];
    const to = project.clips[cut.toId];
    if (!from || !to || frame < from.startFrame || frame > to.startFrame + to.durationFrames) continue;
    if (!best || Math.abs(cut.frame - frame) < Math.abs(best.frame - frame)) best = cut;
  }
  return best;
}
