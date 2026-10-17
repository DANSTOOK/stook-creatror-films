import type { BlendMode, Clip, MediaAsset, ProjectState } from '@shared/types';
import { createId } from '@shared/utils/id';

/**
 * What the inspector can say about several clips at once, and the edits it
 * makes to all of them. Kept apart from the component so the rules - which
 * clips a setting reaches, when a value is "mixed" - can be tested without
 * drawing anything.
 *
 * The model is Premiere's Properties panel (25.0 and later): a setting the
 * selected clips share shows its value and changes all of them; a setting
 * they differ on shows as mixed rather than as the value of whichever clip
 * happened to be first, and setting it gives every clip the new value.
 */

/** One value the clips agree on, or the fact that they do not. */
export type Shared<T> = { mixed: false; value: T } | { mixed: true };

/**
 * The value every item has, or mixed. An empty list has no value to show;
 * it reads as not mixed with the fallback, which a caller only reaches for a
 * setting that applies to none of the clips and is therefore not drawn.
 */
export function shared<T>(values: readonly T[], fallback: T, same: (a: T, b: T) => boolean = Object.is): Shared<T> {
  if (values.length === 0) return { mixed: false, value: fallback };
  const [first, ...rest] = values;
  return rest.every((value) => same(first, value)) ? { mixed: false, value: first } : { mixed: true };
}

/** Numbers stored by a slider differ in the last bits for the same position. */
export const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/* Which clips a setting reaches -------------------------------------------- */

/** A clip whose source is audio only, by its track or by its media. */
function isAudioOnly(clip: Clip, project: ProjectState, assets: readonly MediaAsset[]): boolean {
  // A video's sound detached onto a clip of its own (Detach audio).
  if (clip.audioOnly) return true;
  if (project.tracks.find((track) => track.id === clip.trackId)?.type === 'audio') return true;
  return assets.find((asset) => asset.uri === clip.sourceUri)?.kind === 'audio';
}

/**
 * The selected clips, sorted by what can be set on them - the same split the
 * single-clip inspector makes with its tabs. A caption's look belongs to its
 * track and a title's colours to its Title tab, so neither is graded; a still
 * and a title have no sound.
 */
export interface SelectionGroups {
  /** Everything selected that still exists. */
  all: Clip[];
  /** Has a picture that is composited: opacity and blend mode. */
  visual: Clip[];
  /** Has a picture that is graded: the LUT. */
  gradeable: Clip[];
  /** Has a sound: volume. */
  audible: Clip[];
}

export function groupSelection(ids: readonly string[], project: ProjectState, assets: readonly MediaAsset[]): SelectionGroups {
  const all = ids.map((id) => project.clips[id]).filter((clip): clip is Clip => Boolean(clip));
  const visual: Clip[] = [];
  const gradeable: Clip[] = [];
  const audible: Clip[] = [];
  for (const clip of all) {
    if (clip.caption) continue;
    if (isAudioOnly(clip, project, assets)) {
      audible.push(clip);
      continue;
    }
    visual.push(clip);
    if (clip.title) continue;
    gradeable.push(clip);
    // A picture whose sound was detached has none of its own: its level is
    // set on the sound clip, as the single-clip inspector says. Counted here,
    // a group change would report it as changed while nothing is heard.
    if (clip.audioDetached) continue;
    if (assets.find((asset) => asset.uri === clip.sourceUri)?.kind !== 'image') audible.push(clip);
  }
  return { all, visual, gradeable, audible };
}

/* Opacity ------------------------------------------------------------------ */

/**
 * A clip's opacity when it is one value for the whole clip, or null when it
 * is animated. With no keyframe a clip is fully opaque; with one, that
 * keyframe's value holds everywhere.
 */
export function staticOpacity(clip: Clip): number | null {
  const track = clip.transform.opacity;
  if (track.length === 0) return 1;
  return track.length === 1 ? track[0].value : null;
}

/**
 * The clip with one opacity throughout, or null for an animated one.
 *
 * An animated opacity is left alone: one number cannot stand for a fade, and
 * flattening it would throw away work nobody asked to lose. The inspector
 * says how many clips it left.
 */
export function withOpacity(clip: Clip, value: number): Partial<Clip> | null {
  const track = clip.transform.opacity;
  if (track.length > 1) return null;
  const keyframe = track[0] ? { ...track[0], value } : { id: createId('kf'), frame: clip.startFrame, value, easing: 'linear' as const };
  return { transform: { ...clip.transform, opacity: [keyframe] } };
}

/* Blend mode --------------------------------------------------------------- */

export const blendOf = (clip: Clip): BlendMode => clip.blendMode ?? 'normal';

/** 'normal' is stored as no blend mode, as the single-clip inspector stores it. */
export const withBlend = (mode: BlendMode): Partial<Clip> => ({ blendMode: mode === 'normal' ? undefined : mode });

/* LUT ---------------------------------------------------------------------- */

export interface LutChoice {
  uri: string;
  name: string;
  /** Absent for a file that came in without a path; it then lasts this session only. */
  sourcePath?: string;
}

/**
 * The clip with a look applied. Applying one turns the grade on, as it does
 * for one clip: a look that changes nothing on screen reads as broken. The
 * path is replaced too, never kept from the previous look - an old path would
 * bring the old look back the next time the project opens.
 */
export const withLut = (clip: Clip, lut: LutChoice): Partial<Clip> => ({
  colorGrading: { ...clip.colorGrading, enabled: true, lutUri: lut.uri, lutName: lut.name, lutSourcePath: lut.sourcePath },
});

export const withoutLut = (clip: Clip): Partial<Clip> | null =>
  clip.colorGrading.lutUri
    ? { colorGrading: { ...clip.colorGrading, lutUri: undefined, lutName: undefined, lutSourcePath: undefined } }
    : null;

/** Only a clip that has a look has an intensity worth setting. */
export const withLutIntensity = (clip: Clip, lutIntensity: number): Partial<Clip> | null =>
  clip.colorGrading.lutUri ? { colorGrading: { ...clip.colorGrading, lutIntensity } } : null;

/** The same look: the same file when there is one, otherwise the same loaded copy. */
export function sameLook(a: Clip, b: Clip): boolean {
  const left = a.colorGrading;
  const right = b.colorGrading;
  if (!left.lutUri || !right.lutUri) return !left.lutUri && !right.lutUri;
  if (left.lutSourcePath && right.lutSourcePath) return left.lutSourcePath === right.lutSourcePath;
  return left.lutUri === right.lutUri;
}

/** Windows paths differ only in case or slash and are the same file, as the LUT list treats them. */
export const samePath = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
