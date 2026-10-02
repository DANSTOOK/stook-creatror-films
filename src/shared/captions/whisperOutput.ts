import type { CaptionWord } from '../types';

/**
 * Reading what whisper.cpp's command line writes with `-ojf` (JSON with
 * every token) into words with times, and throwing away what Whisper is
 * known to make up.
 *
 * Times. Each token has `offsets` (ms) from the decoder's timestamp tokens,
 * which are coarse: measured against a recording with known word times, a
 * word's `offsets.from` was off by a median of 245 ms and a tenth of them by
 * more than 600. With `-dtw <model>` each token also gets `t_dtw`, the
 * moment (in hundredths of a second) cross-attention alignment puts it at -
 * which marks where the token ENDS. So a word starts where the token before
 * it ended: that measured a median of 35 ms off, and 99.5% within 200 ms
 * (small) / 94% (turbo). `offsets` stay as the fallback when there is no
 * alignment (`t_dtw` is -1).
 */

interface WhisperToken {
  text: string;
  offsets?: { from: number; to: number };
  t_dtw?: number;
  id?: number;
}

interface WhisperSegment {
  text: string;
  offsets?: { from: number; to: number };
  tokens?: WhisperToken[];
}

export interface WhisperJson {
  transcription?: WhisperSegment[];
  result?: { language?: string };
}

/** Special tokens: [_BEG_], [_TT_150], <|endoftext|> and the like. */
const isSpecial = (text: string): boolean => /^\[_.*\]$/.test(text.trim()) || /^<\|.*\|>$/.test(text.trim());

/** No letter or digit: punctuation, which belongs to the word it touches. */
const isPunctuation = (text: string): boolean => !/[\p{L}\p{N}]/u.test(text);

/** Lower case, no accents, letters and digits only: for comparing phrases. */
export const foldText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Phrases Whisper is known to write over silence and music because they
 * close so many subtitle files it learned from - the Spanish one this
 * feature was asked to catch is "Subtítulos realizados por la comunidad de
 * Amara.org". A segment that says one of these and nothing else is dropped.
 * Only whole segments, and only phrases nobody says on camera: "gracias por
 * ver el vídeo" is a known one too, but it is also something people say.
 */
const HALLUCINATIONS = [
  /amara\s*\.?\s*org/i,
  /^subt[ií]tulos? (realizados? |hechos? |creados? )?por /i,
  /^subtitulado por /i,
  /^subtitles by /i,
  /^transcri(bed|ption) by /i,
];

/** Sound described instead of spoken: [MÚSICA], (risas), *aplausos*, ♪. */
const isSoundTag = (text: string): boolean => /^\s*([[(（*♪♫].*[\])）*♪♫]|[♪♫\s]+)\s*$/u.test(text);

export function isHallucination(segmentText: string): boolean {
  const text = segmentText.trim();
  if (text === '') return true;
  if (isSoundTag(text)) return true;
  return HALLUCINATIONS.some((pattern) => pattern.test(text));
}

/** Seconds a letter takes when spoken briskly: about 16 letters a second. */
const SECONDS_PER_LETTER = 0.06;

/**
 * When a word starts. Normally where the token before it ended. After a
 * pause that is wrong: the token before (a full stop, say) is aligned to
 * where the speech stopped, or somewhere in the silence, and the caption
 * would come up before anyone speaks - measured 0.3 to 0.6 s early with the
 * turbo model. So after punctuation, or after a gap much longer than the
 * word itself, the word starts its own length before its own end - the
 * length guessed from its letters, on the short side, so a wrong guess is a
 * caption a little late rather than one up in the silence - unless the
 * token before ended later still. Without alignment, the decoder's own time.
 */
function wordStart(text: string, aligned: number | null, alignedEnd: number | null, afterPause: boolean, from: number): number {
  if (aligned === null) return from;
  const letters = [...text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const length = Math.min(0.5, Math.max(0.12, letters * SECONDS_PER_LETTER));
  const own = Math.max(0, aligned - length);
  if (alignedEnd === null) return own;
  return afterPause || aligned - alignedEnd > length + 0.2 ? Math.max(alignedEnd, own) : alignedEnd;
}

export interface ParsedTranscript {
  words: CaptionWord[];
  /** Segments dropped as made up, for the log and the tests. */
  dropped: string[];
}

/**
 * A stretch of speech the voice detector kept (`--vad`): where it is in the
 * sound that was given, and where in the shorter sound Whisper then heard,
 * in seconds.
 */
export interface VadSegment {
  origStart: number;
  origEnd: number;
  vadStart: number;
  vadEnd: number;
}

/**
 * The voice detector cuts the silences out before Whisper listens: the
 * stretches of speech are put one after another, a fifth of a second apart.
 * The program maps the times of its SEGMENTS back onto the sound it was
 * given, but not the times of the tokens inside them - `offsets` and `t_dtw`
 * come back in the shortened sound's time. Measured on a recording with
 * known word times, captions came up a median of 4.4 s early, and 34 s early
 * after a 30 s silence. The program does print the table as it works, one
 * line a stretch:
 *
 *   whisper_vad: vad_segment_info: orig_start: 2.11, orig_end: 5.66, vad_start: 1.51, vad_end: 5.06
 *
 * and this reads it, so the token times can be put back (vadTimeToOriginal).
 */
export function parseVadSegments(log: string): VadSegment[] {
  const segments: VadSegment[] = [];
  const line = /vad_segment_info:\s*orig_start:\s*([\d.]+),\s*orig_end:\s*([\d.]+),\s*vad_start:\s*([\d.]+),\s*vad_end:\s*([\d.]+)/g;
  for (const match of log.matchAll(line)) {
    const [origStart, origEnd, vadStart, vadEnd] = match.slice(1).map(Number);
    if ([origStart, origEnd, vadStart, vadEnd].every(Number.isFinite)) segments.push({ origStart, origEnd, vadStart, vadEnd });
  }
  return segments.sort((a, b) => a.vadStart - b.vadStart);
}

/**
 * A moment of the shortened sound, as a moment of the sound that was given.
 * Inside a stretch the samples are the same ones, so the time runs on from
 * where the stretch starts. Past its end come a tenth of a second more of
 * the same sound and a tenth of silence that stands for the whole pause: a
 * moment there is held at the start of the next stretch at the latest, so
 * times never go backwards.
 */
export function vadTimeToOriginal(segments: readonly VadSegment[], seconds: number): number {
  if (segments.length === 0) return seconds;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (segments[middle].vadStart <= seconds) low = middle;
    else high = middle - 1;
  }
  const segment = segments[low];
  const next = segments[low + 1];
  const original = segment.origStart + Math.max(0, seconds - segment.vadStart);
  return next ? Math.min(original, next.origStart) : original;
}

/**
 * The words of a transcript, in order, with start and end in seconds of the
 * audio that was transcribed. `vad` is the voice detector's table when it
 * ran (parseVadSegments): token times are put back through it first.
 */
export function parseWhisperJson(json: WhisperJson, vad: readonly VadSegment[] = []): ParsedTranscript {
  const words: CaptionWord[] = [];
  const dropped: string[] = [];
  const original = (seconds: number): number => vadTimeToOriginal(vad, seconds);

  // Where the token before ended, by the alignment - carried from one
  // segment into the next, which Whisper cuts wherever its window ends.
  let alignedEnd: number | null = null;
  // The token before was closing punctuation: a pause may follow it.
  let afterPunctuation = false;

  for (const segment of json.transcription ?? []) {
    if (isHallucination(segment.text)) {
      if (segment.text.trim() !== '') dropped.push(segment.text.trim());
      continue;
    }
    let current: { text: string; start: number; end: number } | null = null;

    const close = (): void => {
      if (!current) return;
      const text = current.text.trim();
      if (text !== '' && !isSoundTag(text)) words.push({ text, start: current.start, end: Math.max(current.start, current.end) });
      current = null;
    };

    for (const token of segment.tokens ?? []) {
      const aligned = typeof token.t_dtw === 'number' && token.t_dtw >= 0 ? original(token.t_dtw / 100) : null;
      if (isSpecial(token.text)) continue;
      const from = token.offsets ? original(token.offsets.from / 1000) : alignedEnd ?? 0;
      const to = token.offsets ? original(token.offsets.to / 1000) : from;
      const punctuation = isPunctuation(token.text);
      const opening = /^\s*[¿¡"«(]/.test(token.text);
      const startsWord = current === null || (/^\s/.test(token.text) && (!punctuation || opening));

      if (startsWord) {
        close();
        current = { text: token.text, start: wordStart(token.text, aligned, alignedEnd, afterPunctuation, from), end: aligned ?? to };
      } else if (current) {
        current.text += token.text;
        // Closing punctuation is aligned to the end of the pause after it,
        // not to the end of the word: it does not make the word longer.
        if (!punctuation) current.end = Math.max(current.end, aligned ?? to);
      }
      if (aligned !== null) alignedEnd = aligned;
      afterPunctuation = punctuation && !opening;
    }
    close();
  }

  // In order and never backwards: a word cannot start before the one before it.
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const floor = i > 0 ? words[i - 1].start : 0;
    word.start = Math.max(floor, word.start);
    word.end = Math.max(word.start, word.end);
    word.start = Math.round(word.start * 1000) / 1000;
    word.end = Math.round(word.end * 1000) / 1000;
  }
  return { words, dropped };
}

/** Progress lines whisper-cli prints with `-pp`: "progress =  42%". */
export function parseProgress(line: string): number | null {
  const match = /progress\s*=\s*(\d+)%/.exec(line);
  return match ? Math.min(100, Number(match[1])) / 100 : null;
}
