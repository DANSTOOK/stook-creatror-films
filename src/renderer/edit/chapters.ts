import type { Marker } from '@shared/types';

/**
 * YouTube chapters from the timeline's markers: the lines YouTube reads in
 * a video's description ("00:00 Intro", "01:23 The build"), ready to paste.
 *
 * YouTube shows chapters only when the first starts at 00:00, there are at
 * least three, and each lasts ten seconds or more. So a first chapter is
 * added at the start when no marker is there; a marker closer than ten
 * seconds to the one before is left out (and counted, so the user is told);
 * and fewer than three is reported. Beat markers (edit/beats.ts) are not
 * chapters.
 */

export const MIN_CHAPTER_SECONDS = 10;
export const MIN_CHAPTERS = 3;
const BEAT_LABEL = '♪';

export interface Chapters {
  text: string;
  count: number;
  /** Markers left out for starting less than ten seconds after the chapter before. */
  skipped: number;
  /** Fewer than three: YouTube will not show them. */
  tooFew: boolean;
}

/** A time as YouTube writes it: M:SS... as 00:00 under an hour, H:MM:SS from one. */
export function chapterTime(seconds: number, withHours: boolean): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return withHours ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export function youtubeChapters(
  markers: readonly Marker[],
  fps: number,
  lengthFrames: number,
  names: { intro: string; numbered(index: number): string },
): Chapters {
  const rate = fps > 0 ? fps : 30;
  const withHours = lengthFrames / rate >= 3600;
  const sorted = markers
    .filter((marker) => marker.label !== BEAT_LABEL && marker.frame >= 0 && marker.frame < Math.max(1, lengthFrames))
    .sort((a, b) => a.frame - b.frame);
  const chapters: Array<{ seconds: number; title: string }> = [];
  if (sorted.length === 0 || sorted[0].frame / rate >= 1) chapters.push({ seconds: 0, title: names.intro });
  let skipped = 0;
  for (const marker of sorted) {
    const seconds = chapters.length === 0 ? 0 : marker.frame / rate;
    const previous = chapters[chapters.length - 1];
    if (previous && seconds - previous.seconds < MIN_CHAPTER_SECONDS) {
      skipped += 1;
      continue;
    }
    chapters.push({ seconds, title: marker.label.trim() || names.numbered(chapters.length + 1) });
  }
  // The last chapter needs its ten seconds too, to the end of the video.
  const end = lengthFrames / rate;
  while (chapters.length > 1 && end - chapters[chapters.length - 1].seconds < MIN_CHAPTER_SECONDS) {
    chapters.pop();
    skipped += 1;
  }
  return {
    text: chapters.map((chapter) => `${chapterTime(chapter.seconds, withHours)} ${chapter.title}`).join('\n'),
    count: chapters.length,
    skipped,
    tooFew: chapters.length < MIN_CHAPTERS,
  };
}
