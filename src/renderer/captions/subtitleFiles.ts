/**
 * SubRip (.srt) and WebVTT (.vtt): writing captions out and reading them in.
 *
 * Written the way players and YouTube read them most reliably: SRT numbered
 * from 1 with `HH:MM:SS,mmm`, CRLF line ends (SubRip is a Windows format)
 * and UTF-8; VTT with its `WEBVTT` header, `HH:MM:SS.mmm` and LF.
 *
 * Read leniently, since these files come from everywhere: a byte-order mark,
 * CRLF or LF, missing or wrong numbers, a dot where SRT has a comma (and the
 * reverse), hours left off, VTT cue identifiers, settings, NOTE and STYLE
 * blocks, and markup (<i>, <c.yellow>, {\an8}) - the text is kept, the
 * markup is not.
 *
 * Times are milliseconds. What the app writes and reads back is identical,
 * byte for byte: see tests/SubtitleFiles.test.ts.
 */

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  /** Lines separated by `\n`. */
  text: string;
}

export type SubtitleFormat = 'srt' | 'vtt';

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`;
}

/** Text safe for a cue: no blank lines inside it (they would end the cue). */
const cueText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');

export function writeSrt(cues: readonly SubtitleCue[]): string {
  const blocks = cues.map(
    (cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${cueText(cue.text)}\n`,
  );
  return blocks.join('\n').replace(/\n/g, '\r\n');
}

export function writeVtt(cues: readonly SubtitleCue[]): string {
  const blocks = cues.map((cue) => `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}\n${cueText(cue.text)}\n`);
  return ['WEBVTT\n', ...blocks].join('\n');
}

export const writeSubtitles = (format: SubtitleFormat, cues: readonly SubtitleCue[]): string =>
  format === 'srt' ? writeSrt(cues) : writeVtt(cues);

/** `00:01:02,345`, `01:02.345`, `1:02:03.4` - hours optional, comma or dot. */
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;
const TIMING = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}`);

function toMs(hours: string | undefined, minutes: string, seconds: string, fraction: string | undefined): number {
  const millis = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  return ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + millis;
}

/** Markup players style text with; the words stay. */
const stripMarkup = (text: string): string =>
  text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

/**
 * Cues from an .srt or .vtt, whichever it is: both are blocks separated by
 * blank lines, each with a `start --> end` line and text after it. Blocks
 * without a timing line (VTT's header, NOTE, STYLE, REGION) are skipped.
 * Sorted by start; cues that end before they start are dropped.
 */
export function parseSubtitles(contents: string): SubtitleCue[] {
  const text = contents.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex === -1) continue;
    const match = TIMING.exec(lines[timingIndex]);
    if (!match) continue;
    const startMs = toMs(match[1], match[2], match[3], match[4]);
    const endMs = toMs(match[5], match[6], match[7], match[8]);
    if (!(endMs > startMs)) continue;
    const body = stripMarkup(lines.slice(timingIndex + 1).join('\n'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n');
    if (body === '') continue;
    cues.push({ startMs, endMs, text: body });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** The format a file name says it is, or null. */
export function subtitleFormatOf(path: string): SubtitleFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.srt')) return 'srt';
  if (lower.endsWith('.vtt')) return 'vtt';
  return null;
}
