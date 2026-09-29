import type { Clip, ProjectState, TitleContent, TitlePreset } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { createId } from '@shared/utils/id';
import { createClip } from '@renderer/store/types';
import { isVisualTrack } from '@renderer/components/Timeline/trackRows';
import { presetStyle, TITLE_URI_PREFIX, titleName } from './titleStyle';
import { presetAnimation } from './animation';

/**
 * Making a title clip, and choosing where it goes.
 *
 * A title goes where Final Cut connects one: at the playhead, above the
 * picture there, so the picture shows through behind it. That is the first
 * unlocked picture track above every clip under the new title that is free
 * for the title's whole length; when there is none, a new track on top.
 */

/** Five seconds: long enough to read two lines twice, the length Resolve gives a generator. */
export const TITLE_SECONDS = 5;

/** The text each template starts with, in the language on screen when it is made. */
export const TITLE_TEXT: Record<TitlePreset, MessageKey> = {
  title: 'title.textTitle',
  lowerThird: 'title.textLowerThird',
  credits: 'title.textCredits',
};

/** What each template is called, and the name a title goes by while its text is empty. */
export const TITLE_NAME: Record<TitlePreset, MessageKey> = {
  title: 'title.presetTitle',
  lowerThird: 'title.presetLowerThird',
  credits: 'title.presetCredits',
};

export interface TitlePlacement {
  /** The track to put it on, or null for a new picture track on top. */
  trackId: string | null;
  startFrame: number;
  durationFrames: number;
}

export function planTitlePlacement(project: ProjectState, startFrame: number, durationFrames: number): TitlePlacement {
  const start = Math.max(0, Math.round(startFrame));
  const end = start + durationFrames;
  const overlaps = (clip: Clip): boolean => clip.startFrame < end && clip.startFrame + clip.durationFrames > start;
  const clips = Object.values(project.clips);
  const visual = project.tracks.filter(isVisualTrack).sort((a, b) => a.order - b.order);

  // The highest layer that has something under the title.
  let covered = -Infinity;
  for (const track of visual) {
    if (clips.some((clip) => clip.trackId === track.id && overlaps(clip))) covered = Math.max(covered, track.order);
  }

  const free = visual.find(
    (track) => track.order > covered && !track.locked && !clips.some((clip) => clip.trackId === track.id && overlaps(clip)),
  );
  return { trackId: free?.id ?? null, startFrame: start, durationFrames };
}

/** A new title clip on `trackId`, in the template's look, with its text. */
export function createTitleClip(
  preset: TitlePreset,
  text: string,
  trackId: string,
  startFrame: number,
  durationFrames: number,
  fallbackName: string,
): Clip {
  // A new title comes on and goes off as its template does, and scales and
  // turns about its own text.
  const title: TitleContent = { preset, text, style: presetStyle(preset), animation: presetAnimation(preset), origin: 'text' };
  const clip = createClip({
    trackId,
    name: titleName(text, fallbackName),
    sourceUri: `${TITLE_URI_PREFIX}${createId()}`,
    startFrame,
    durationFrames,
    // Everything around the letters is transparent: the picture below shows.
    hasAlphaChannel: true,
  });
  return { ...clip, title };
}

/**
 * Where a title dragged from the Titles panel lands: on the track it was
 * dropped on, from the drop frame, when that track takes pictures and is
 * free for the title's length; otherwise where Add title would put it at that
 * frame - above whatever is there, on a new track if need be.
 */
export function titleDropPlacement(project: ProjectState, trackId: string | null, startFrame: number, durationFrames: number): TitlePlacement {
  const start = Math.max(0, Math.round(startFrame));
  const end = start + durationFrames;
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  const free =
    track &&
    isVisualTrack(track) &&
    !track.locked &&
    !Object.values(project.clips).some(
      (clip) => clip.trackId === track.id && clip.startFrame < end && clip.startFrame + clip.durationFrames > start,
    );
  return free ? { trackId: track.id, startFrame: start, durationFrames } : planTitlePlacement(project, start, durationFrames);
}
