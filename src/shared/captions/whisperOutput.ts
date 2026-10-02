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

export interface ParsedTranscript {
  words: CaptionWord[];
  /** Segments dropped as made up, for the log and the tests. */
  dropped: string[];
}

/**
 * The words of a transcript, in order, with start and end in seconds of the
 * audio that was transcribed.
 */
export function parseWhisperJson(json: WhisperJson): ParsedTranscript {
  const words: CaptionWord[] = [];
  const dropped: string[] = [];

  for (const segment of json.transcription ?? []) {
    if (isHallucination(segment.text)) {
      if (segment.text.trim() !== '') dropped.push(segment.text.trim());
      continue;
    }
    const tokens = segment.tokens ?? [];
    // The end of the token before, from the alignment: where the next word starts.
    let previousEnd: number | null = segment.offsets ? segment.offsets.from / 1000 : null;
    let current: { text: string; start: number; end: number } | null = null;

    const close = (): void => {
      if (!current) return;
      const text = current.text.trim();
      if (text !== '' && !isSoundTag(text)) words.push({ text, start: current.start, end: current.end });
      current = null;
    };

    for (const token of tokens) {
      const aligned = typeof token.t_dtw === 'number' && token.t_dtw >= 0 ? token.t_dtw / 100 : null;
      if (isSpecial(token.text)) {
        if (aligned !== null) previousEnd = aligned;
        continue;
      }
      const from = token.offsets ? token.offsets.from / 1000 : previousEnd ?? 0;
      const to = token.offsets ? token.offsets.to / 1000 : from;
      const end = aligned ?? to;
      const startsWord = /^\s/.test(token.text) || current === null;

      if (startsWord && !(current !== null && isPunctuation(token.text) && !/^\s*[¿¡"«(]/.test(token.text))) {
        close();
        const start = previousEnd !== null && aligned !== null ? previousEnd : from;
        current = { text: token.text, start, end };
      } else if (current) {
        current.text += token.text;
        current.end = Math.max(current.end, end);
      }
      if (aligned !== null) previousEnd = aligned;
      else previousEnd = to;
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
