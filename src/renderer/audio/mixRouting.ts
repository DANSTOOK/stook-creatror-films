import type { Clip, ProjectState, Track } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { audioFollowsSpeed } from '@renderer/timing/clipSpeed';

/**
 * Pure mixing rules.
 *
 * Playback (`AudioEngine`) and export (`renderMix`) are two entirely separate
 * audio graphs - one realtime, one offline - and they have to agree on what the
 * mix IS, or the exported file does not sound like what the editor plays. The
 * arithmetic that decides that lives here, once, and is unit tested without a
 * browser.
 */

export const hasSoloedTrack = (project: ProjectState): boolean =>
  project.tracks.some((track) => track.solo);

/**
 * Whether a track contributes to the mix at all.
 *
 * Mute and solo are separate states on purpose: while anything is soloed, the
 * non-soloed tracks are silent WITHOUT being muted, so clearing the solo
 * restores exactly the mute states the user set rather than a flattened
 * version of them.
 */
export function isTrackAudible(track: Track, anySolo: boolean): boolean {
  if (track.muted) return false;
  return anySolo ? track.solo : true;
}

/** Linear gain of a track strip, already accounting for mute and solo. */
export function trackGain(track: Track, anySolo: boolean): number {
  return isTrackAudible(track, anySolo) ? clamp(track.volume, 0, 2) : 0;
}

export const clipGain = (clip: Clip): number => clamp(clip.volume, 0, 2);

/**
 * Whether a clip's own sound is part of the mix at all.
 *
 * Not when it plays backwards (see audioFollowsSpeed), and not when its sound
 * was separated onto a clip of its own: that clip plays it, and the picture
 * clip playing it too would double it - 6 dB louder and, the moment either
 * is moved, an echo. Playback, scrubbing and the export all ask this one
 * question, so the three cannot disagree about how many times a sound plays.
 */
export const clipSounds = (clip: Pick<Clip, 'speed' | 'reversed' | 'audioDetached' | 'speedRamp'>): boolean =>
  clip.audioDetached !== true && audioFollowsSpeed(clip);

export const panPosition = (pan: number): number =>
  clamp(Number.isFinite(pan) ? pan : 0, -1, 1);

/**
 * Everything about the project that changes the sound, as a comparable string.
 *
 * The live engine has to reapply the mix when a fader moves, but the project
 * object is replaced on every scrub of the playhead too. Keying the update
 * effect on this means moving the playhead does not touch the audio graph,
 * while moving a fader does.
 */
export function mixSignature(project: ProjectState): string {
  const audio = project.audio;
  const ducking = audio.ducking;

  const tracks = [...project.tracks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => `${t.id}:${t.volume}:${t.pan}:${t.muted ? 1 : 0}:${t.solo ? 1 : 0}:${t.bus}`)
    .join(',');

  const clips = Object.values(project.clips)
    .sort((a, b) => a.id.localeCompare(b.id))
    // Whether a clip sounds at all is part of the mix: separating a clip's
    // sound has to silence it at once, not at the next seek.
    .map((c) => `${c.id}:${c.volume}:${c.pan}:${c.eq.low}/${c.eq.mid}/${c.eq.high}${c.audioDetached ? ':d' : ''}`)
    .join(',');

  return [
    `master:${audio.masterVolume}`,
    `duck:${ducking.enabled ? 1 : 0}:${ducking.thresholdDb}:${ducking.rangeDb}:${ducking.attackSeconds}:${ducking.releaseSeconds}`,
    `tracks:${tracks}`,
    `clips:${clips}`,
  ].join('|');
}
