import type { Clip, ProjectState, Track } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { addStackEffect } from '@renderer/components/Inspector/EffectStack';
import { EFFECTS } from '@renderer/fx/effects/catalog';
import { MOTION_PRESETS, type MotionPresetId } from '@renderer/fx/motion/presets';
import { applyClipAnimation, applyMotionPreset } from '@renderer/fx/motion/apply';
import { isClipAnimation, type ClipAnimationId } from '@renderer/fx/motion/animations';

/**
 * An item of the Effects panel - a shader effect, a screen move or a clip
 * animation - put on a clip, whether by a click on its tile or by dropping
 * it on the clip in the timeline. Both say what they carry the same way:
 * `effect:<type>`, `motion:<preset>` or `anim:<animation>`.
 */

export type LibraryEffectItem = `effect:${string}` | `motion:${MotionPresetId}` | `anim:${ClipAnimationId}`;

export function isLibraryEffectItem(value: string): value is LibraryEffectItem {
  const [kind, id] = value.split(':');
  if (kind === 'effect') return EFFECTS.some((effect) => effect.type === id);
  if (kind === 'motion') return (MOTION_PRESETS as readonly string[]).includes(id);
  if (kind === 'anim') return isClipAnimation(id ?? '');
  return false;
}

/** Whether an effect can go on clips of this track: anything drawn - not sound, not captions. */
export const takesEffects = (track: Track | undefined): boolean => track !== undefined && track.type !== 'audio' && track.type !== 'captions';

/** The clip on `trackId` at `frame` that an effect dropped there would go on. */
export function effectClipAt(project: ProjectState, trackId: string | null, frame: number): Clip | null {
  if (!trackId || !takesEffects(project.tracks.find((track) => track.id === trackId))) return null;
  return (
    Object.values(project.clips).find((clip) => clip.trackId === trackId && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames) ?? null
  );
}

/** Put `item` on the clip, and bring the clip forward so it shows in the inspector. */
export function applyLibraryItem(clip: Clip, item: LibraryEffectItem): void {
  const [kind, id] = item.split(':');
  if (kind === 'effect') addStackEffect(clip, id);
  else if (kind === 'anim') applyClipAnimation(clip.id, id as ClipAnimationId);
  else applyMotionPreset(clip.id, id as MotionPresetId);
  useProjectStore.getState().setUi({ selectedClipIds: [clip.id], selectedTrackId: clip.trackId });
}
