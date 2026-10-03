import type { CaptionTrackSettings, Clip, ProjectState, TitleContent, TitleStyle } from '@shared/types';
import { REFERENCE_HEIGHT, TITLE_SAFE } from '@renderer/text/titleStyle';
import { captionSettingsOf, isCaptionTrack } from './captionClips';
import { rulesFor } from './rules';
import { lookOf } from './look';
import { captionTokens, wordAnimationFor } from './animation';
import { setWordAnimation } from '@renderer/text/wordAnimation';
import { speedOf } from '@renderer/timing/clipSpeed';

/**
 * Captions drawn by the titles' text renderer (renderer/text).
 *
 * The compositor draws titles; a caption is handed to it as a title of its
 * own - its text, in the captions look, pinned to the bottom of the
 * title-safe area - so it is laid out, rasterised, cached and exported
 * exactly as titles are, and the viewer and the export cannot differ.
 *
 * The look is the track's (captions/look.ts): white Inter with a dark
 * outline and a soft shadow until it is changed, readable on any picture
 * without a box hiding it. Left on automatic, the size is the one at which
 * a full line of the preset fits across the title-safe width: 46 px of a
 * 1080-line frame for 42 characters on a wide frame; on a tall one larger
 * letters than 42 would allow, for the 32 the rules give it. A size chosen
 * by hand is used as it is; a line too wide for it wraps.
 */

/** Average advance of a character of Inter at these weights, as a share of the size. */
const AVERAGE_ADVANCE = 0.56;

/**
 * A few words at a time are drawn large: up to 96 px of a 1080-line frame,
 * less where sixteen letters would not fit across - on a tall frame that is
 * still more than half again a caption's size.
 */
const PAGE_SIZE = 96;
const PAGE_LETTERS = 16;

export function captionStyle(settings: CaptionTrackSettings, frame: { width: number; height: number }): TitleStyle {
  const rules = rulesFor(settings.preset, frame);
  const unit = frame.height / REFERENCE_HEIGHT;
  const social = settings.preset === 'social';
  const look = lookOf(settings);
  const paged = settings.animation?.kind === 'words';
  const wanted = paged ? PAGE_SIZE : social ? 64 : 46;
  // The largest size at which a full line fits the safe width.
  const fitting = (frame.width * TITLE_SAFE) / ((paged ? PAGE_LETTERS : rules.maxCharsPerLine) * AVERAGE_ADVANCE) / unit;
  const fontSize = look.fontSize ?? Math.max(12, Math.min(wanted, Math.floor(fitting)));
  return {
    fontFamily: look.fontFamily,
    fontWeight: look.fontWeight,
    fontSize,
    color: look.color,
    align: 'center',
    lineHeight: 1.2,
    letterSpacing: 0,
    secondaryScale: 1,
    maxWidth: 1,
    anchor: look.position === 'top' ? 'top' : 'bottom',
    stroke: { enabled: look.outline.enabled, color: look.outline.color, width: look.outline.width },
    // A soft shadow under letters that stand on the picture; a band needs none.
    shadow: { enabled: !look.box.enabled, color: '#000000', opacity: 0.45, distance: 2, angle: 90, blur: 6 },
    box: { enabled: look.box.enabled, color: look.box.color, opacity: look.box.opacity, padding: 12, radius: 4 },
  };
}

/** The title a caption is drawn as. */
export function captionTitle(text: string, style: TitleStyle): TitleContent {
  return { preset: 'title', text, style, origin: 'text' };
}

/**
 * The same caption clip gives the same title object for as long as nothing
 * about it changes, so the title cache (engine/TitleLayers) keys it once
 * rather than once a frame.
 */
const drawnAs = new WeakMap<Clip, { key: string; clip: Clip }>();

/** The stretch of a caption's content seconds it is on screen for. */
export function captionSpan(clip: Clip, fps: number): { from: number; to: number } {
  const from = clip.sourceOffsetFrames / fps;
  return { from, to: from + (clip.durationFrames * speedOf(clip)) / fps };
}

/** The second of a caption's content shown at a timeline frame. */
export const captionSecondsAt = (clip: Clip, frame: number, fps: number): number => (clip.sourceOffsetFrames + (frame - clip.startFrame) * speedOf(clip)) / fps;

function asTitleClip(clip: Clip, settings: CaptionTrackSettings, frame: { width: number; height: number }, fps: number): Clip {
  const key = `${settings.preset}|${frame.width}x${frame.height}@${fps}|${settings.look ? JSON.stringify(settings.look) : ''}|${settings.animation ? JSON.stringify(settings.animation) : ''}`;
  const known = drawnAs.get(clip);
  if (known && known.key === key) return known.clip;
  const text = clip.caption?.text ?? '';
  const title = captionTitle(text, captionStyle(settings, frame));
  // Moving word by word: when each word is said goes beside the title, for
  // the compositor to draw each frame from (text/words).
  if (settings.animation && captionTokens(text).length > 0) {
    setWordAnimation(title, wordAnimationFor(settings.animation, text, clip.caption?.words, captionSpan(clip, fps)));
  }
  const drawn: Clip = { ...clip, title };
  drawnAs.set(clip, { key, clip: drawn });
  return drawn;
}

const projects = new WeakMap<ProjectState, ProjectState>();

/**
 * The project as the compositor draws it: every caption on a captions track
 * turned into a title. Anything else passes through untouched, and a project
 * with no captions is returned as it is.
 */
export function withCaptionTitles(project: ProjectState): ProjectState {
  const cached = projects.get(project);
  if (cached) return cached;
  const captionTracks = new Map(project.tracks.filter(isCaptionTrack).map((track) => [track.id, captionSettingsOf(track)]));
  if (captionTracks.size === 0) {
    projects.set(project, project);
    return project;
  }
  const frame = { width: project.width, height: project.height };
  let changed = false;
  const clips: Record<string, Clip> = {};
  for (const [id, clip] of Object.entries(project.clips)) {
    const settings = captionTracks.get(clip.trackId);
    if (settings && clip.caption) {
      clips[id] = asTitleClip(clip, settings, frame, project.fps);
      changed = true;
    } else clips[id] = clip;
  }
  const drawn = changed ? { ...project, clips } : project;
  projects.set(project, drawn);
  return drawn;
}

/** The project with its captions left out: an export that does not burn them in. */
export function withoutCaptions(project: ProjectState): ProjectState {
  if (!project.tracks.some(isCaptionTrack)) return project;
  return { ...project, tracks: project.tracks.map((track) => (isCaptionTrack(track) ? { ...track, visible: false } : track)) };
}
