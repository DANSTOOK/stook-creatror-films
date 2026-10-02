import type { CaptionLanguage, CaptionPreset, CaptionTrackSettings, CaptionWord, Clip, ProjectState, Track } from '@shared/types';
import { createId } from '@shared/utils/id';
import { createClip } from '@renderer/store/types';
import { linesForWords, rulesFor, type Cue } from './rules';
import type { SubtitleCue } from './subtitleFiles';

/**
 * Captions as clips on a captions track.
 *
 * A caption is an ordinary clip - it moves, trims, cuts and undoes like any
 * other - with `caption` in place of footage, on a track of type `captions`
 * that holds nothing else. Its words keep their times in the caption's own
 * content seconds (see CaptionWord), which is what lets the razor put each
 * word on the side of the cut it was spoken on.
 */

/** A caption has no file; like a title's, its URI names it with a scheme no file has. */
export const CAPTION_URI_PREFIX = 'scf-caption:';

export const DEFAULT_CAPTION_SETTINGS: CaptionTrackSettings = { preset: 'classic', language: 'es' };

export const isCaptionTrack = (track: Pick<Track, 'type'> | undefined): boolean => track?.type === 'captions';

/** A track's caption settings, filled in for one saved without them. */
export function captionSettingsOf(track: Track | undefined): CaptionTrackSettings {
  const saved = track?.captions;
  return {
    preset: saved?.preset === 'social' ? 'social' : 'classic',
    language: saved?.language === 'en' ? 'en' : 'es',
  };
}

/** The name a caption goes by on the timeline: its text on one line. */
export const captionName = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim().slice(0, 80) || '…';

/** A caption clip. `start` and `end` are timeline frames; `words` are content seconds. */
export function createCaptionClip(trackId: string, startFrame: number, endFrame: number, text: string, words?: CaptionWord[]): Clip {
  const clip = createClip({
    trackId,
    name: captionName(text),
    sourceUri: `${CAPTION_URI_PREFIX}${createId()}`,
    startFrame,
    durationFrames: Math.max(1, endFrame - startFrame),
    hasAlphaChannel: true,
  });
  return { ...clip, caption: { text, ...(words && words.length > 0 ? { words } : {}) } };
}

/**
 * Timed cues (seconds of the timeline, from `offsetFrame`) into caption
 * clips on `trackId`. A caption's words are kept relative to its own start.
 * Frames are rounded; two captions never share a frame.
 */
export function cuesToClips(cues: readonly Cue[], trackId: string, fps: number, offsetFrame = 0): Clip[] {
  const clips: Clip[] = [];
  let floor = 0;
  for (const cue of cues) {
    const start = Math.max(floor, offsetFrame + Math.round(cue.start * fps));
    const end = Math.max(start + 1, offsetFrame + Math.round(cue.end * fps));
    const origin = (start - offsetFrame) / fps;
    const words = cue.words.map((word) => ({
      text: word.text,
      start: round3(word.start - origin),
      end: round3(word.end - origin),
    }));
    clips.push(createCaptionClip(trackId, start, end, cue.lines.join('\n'), words));
    floor = end;
  }
  return clips;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Cues read from a subtitle file into caption clips; they keep no words. */
export function subtitleCuesToClips(cues: readonly SubtitleCue[], trackId: string, fps: number): Clip[] {
  const clips: Clip[] = [];
  let floor = 0;
  for (const cue of cues) {
    const start = Math.max(floor, Math.round((cue.startMs / 1000) * fps));
    const end = Math.max(start + 1, Math.round((cue.endMs / 1000) * fps));
    clips.push(createCaptionClip(trackId, start, end, cue.text));
    floor = end;
  }
  return clips;
}

/** A project's captions as subtitle cues, in milliseconds, for writing a file. */
export function captionCues(project: ProjectState, options: { trackId?: string; fromFrame?: number; toFrame?: number } = {}): SubtitleCue[] {
  const tracks = new Map(project.tracks.filter((track) => isCaptionTrack(track) && (options.trackId ? track.id === options.trackId : track.visible)).map((track) => [track.id, track]));
  const from = options.fromFrame ?? 0;
  const to = options.toFrame ?? Infinity;
  return Object.values(project.clips)
    .filter((clip) => clip.caption && tracks.has(clip.trackId))
    .filter((clip) => clip.startFrame < to && clip.startFrame + clip.durationFrames > from)
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
    .map((clip) => {
      // Relative to the start of the range exported, as the video is.
      const start = Math.max(clip.startFrame, from) - from;
      const end = Math.min(clip.startFrame + clip.durationFrames, to) - from;
      return {
        startMs: Math.round((start / project.fps) * 1000),
        endMs: Math.round((end / project.fps) * 1000),
        text: clip.caption?.text ?? '',
      };
    })
    .filter((cue) => cue.text.trim() !== '' && cue.endMs > cue.startMs);
}

/** A new captions track's settings. */
export function captionTrack(base: Track, preset: CaptionPreset, language: CaptionLanguage): Track {
  return { ...base, type: 'captions', captions: { preset, language } };
}

const tokens = (text: string): string[] => text.split(/\s+/).filter((token) => token !== '');

/** Whether a caption's text is still what its words say, i.e. untouched by hand. */
export function textMatchesWords(text: string, words: readonly CaptionWord[]): boolean {
  return tokens(text).join(' ') === words.map((word) => word.text).join(' ');
}

/**
 * The two halves of a caption cut at `frame` by the razor, from the two
 * copies `splitClip` made. Each word goes to the side where the middle of
 * it was spoken; the text is laid out again for each half. A caption whose
 * text was edited by hand keeps the edit: its words are shared out in the
 * same proportion as the timed ones. Words the halves cannot tell apart
 * (no timing at all) are shared out by the length of each half.
 */
export function splitCaption(left: Clip, right: Clip, frame: number, fps: number, settings: CaptionTrackSettings, frameSize: { width: number; height: number }): [Clip, Clip] {
  const caption = left.caption;
  if (!caption) return [left, right];
  const rules = rulesFor(settings.preset, frameSize);
  // The cut, in the caption's content seconds (both halves count the same way).
  const cut = (left.sourceOffsetFrames + frame - left.startFrame) / fps;
  const words = caption.words ?? [];
  const leftWords = words.filter((word) => (word.start + word.end) / 2 < cut);
  const rightWords = words.filter((word) => (word.start + word.end) / 2 >= cut);

  const typed = tokens(caption.text);
  let leftTokens: string[];
  let rightTokens: string[];
  if (words.length > 0 && textMatchesWords(caption.text, words)) {
    leftTokens = leftWords.map((word) => word.text);
    rightTokens = rightWords.map((word) => word.text);
  } else {
    const share = words.length > 0 ? leftWords.length / words.length : (frame - left.startFrame) / Math.max(1, left.durationFrames + right.durationFrames);
    const count = Math.min(typed.length, Math.max(0, Math.round(typed.length * share)));
    leftTokens = typed.slice(0, count);
    rightTokens = typed.slice(count);
  }

  const layout = (list: string[]): string => linesForWords(list, rules, settings.language).join('\n');
  const leftText = layout(leftTokens);
  const rightText = layout(rightTokens);
  return [
    { ...left, name: captionName(leftText), caption: { text: leftText, ...(leftWords.length > 0 ? { words: leftWords } : {}) } },
    { ...right, name: captionName(rightText), caption: { text: rightText, ...(rightWords.length > 0 ? { words: rightWords } : {}) } },
  ];
}
