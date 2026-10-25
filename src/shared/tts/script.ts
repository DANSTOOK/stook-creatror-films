/**
 * A text-to-speech script: what is said, and the pauses written into it.
 *
 * A pause is written in square brackets, the way the Voice tab's Pause button
 * puts it - `[pausa 1s]`, `[pause 1.5s]`, `[pausa 0,5 s]`, `[pausa 500ms]` -
 * or as SSML's `<break time="2s"/>`, for a script pasted from a tool that
 * writes those (ElevenLabs, Azure, Google). Each is silence of exactly that
 * length in the voice; everything else is spoken as written. The words are
 * never sent with the marks in them: the engines would read them aloud.
 *
 * Pure text handling, shared by the engine's side (main/tts/synth) and the
 * page's (the Voice tab, the captions of what was said).
 */

export type ScriptPart = { kind: 'speech'; text: string } | { kind: 'pause'; seconds: number };

/** The shortest and longest pause one mark asks for; longer ones are several marks, or a gap on the timeline. */
export const MIN_PAUSE = 0.1;
export const MAX_PAUSE = 10;

/** The lengths the Pause button offers, seconds. */
export const PAUSE_CHOICES = [0.5, 1, 1.5, 2, 3, 5] as const;

const BRACKET = String.raw`\[\s*(?:pausa|pause|break)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(ms|s|seg|segs|segundos?|sec|secs|seconds?)?\s*\]`;
const SSML = String.raw`<break\s+time\s*=\s*["']\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*["']\s*\/?>`;
const MARK = new RegExp(`${BRACKET}|${SSML}`, 'gi');

const clampPause = (seconds: number): number => Math.min(MAX_PAUSE, Math.max(MIN_PAUSE, seconds));

/** The seconds a mark's number and unit come to: "500ms" is half a second, a bare number is seconds. */
function seconds(value: string, unit: string | undefined): number {
  const amount = Number(value.replace(',', '.'));
  return clampPause(unit?.toLowerCase() === 'ms' ? amount / 1000 : amount);
}

/**
 * The script in order: stretches of speech, and pauses between them. Pauses
 * side by side are one pause of their total (each mark held to its range);
 * speech is trimmed and an empty stretch dropped.
 */
export function parseScript(text: string): ScriptPart[] {
  const parts: ScriptPart[] = [];
  const speech = (words: string): void => {
    const clean = words.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (clean) parts.push({ kind: 'speech', text: clean });
  };
  let last = 0;
  for (const match of text.matchAll(MARK)) {
    speech(text.slice(last, match.index));
    const length = match[1] !== undefined ? seconds(match[1], match[2]) : seconds(match[3], match[4]);
    const previous = parts[parts.length - 1];
    if (previous?.kind === 'pause') previous.seconds = Math.round((previous.seconds + length) * 1000) / 1000;
    else parts.push({ kind: 'pause', seconds: length });
    last = (match.index ?? 0) + match[0].length;
  }
  speech(text.slice(last));
  return parts;
}

/** Just the words: the marks taken out - for captions, a clip's name, the character count. */
export function scriptWords(text: string): string {
  return parseScript(text)
    .filter((part): part is Extract<ScriptPart, { kind: 'speech' }> => part.kind === 'speech')
    .map((part) => part.text)
    .join(' ');
}

/** The total of the pauses written into `text`, seconds. */
export function pauseSeconds(text: string): number {
  return parseScript(text).reduce((sum, part) => sum + (part.kind === 'pause' ? part.seconds : 0), 0);
}

/** "1,5" in Spanish, "1.5" in English: a pause's length as the mark writes it. */
export function pauseLabel(seconds: number, language: string): string {
  const text = String(Math.round(seconds * 100) / 100);
  return language === 'es' ? text.replace('.', ',') : text;
}

/** The mark the Pause button writes: "[pausa 1,5s]" in Spanish, "[pause 1.5s]" otherwise. */
export function pauseMark(seconds: number, language: string): string {
  return `[${language === 'es' ? 'pausa' : 'pause'} ${pauseLabel(clampPause(seconds), language)}s]`;
}

/** Where each mark is in `text`, for drawing it as a chip: [start, end) offsets. */
export function pauseMarks(text: string): Array<{ start: number; end: number; seconds: number }> {
  return [...text.matchAll(MARK)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    seconds: match[1] !== undefined ? seconds(match[1], match[2]) : seconds(match[3], match[4]),
  }));
}

/**
 * `mark` put into `text` where the caret is (over the selection, if any),
 * with a space before it where a word would otherwise touch it and always one
 * after. Returns the new text and where the caret goes: past that space, so
 * the next words can be typed straight on.
 */
export function insertMark(text: string, selectionStart: number, selectionEnd: number, mark: string): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const spaced = /^\s/.test(after);
  const inserted = `${lead}${mark}${spaced ? '' : ' '}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + lead.length + mark.length + 1 };
}

/**
 * The start of a script, for a quick listen: its words up to about
 * `maxChars`, cut between words, with the pauses written among them (each at
 * most two seconds, none before the first word or after the last, so a
 * preview is not mostly silence).
 */
export function previewScript(text: string, maxChars: number): string {
  const out: Array<string | number> = [];
  let used = 0;
  for (const part of parseScript(text)) {
    if (used >= maxChars) break;
    if (part.kind === 'pause') {
      if (out.length > 0) out.push(Math.min(part.seconds, 2));
      continue;
    }
    let words = part.text;
    if (words.length > maxChars - used) {
      const cut = words.slice(0, maxChars - used);
      const space = cut.lastIndexOf(' ');
      words = space > 0 ? cut.slice(0, space) : cut;
    }
    out.push(words);
    used += words.length;
  }
  while (typeof out[out.length - 1] === 'number') out.pop();
  return out.map((item) => (typeof item === 'number' ? pauseMark(item, 'en') : item)).join(' ').trim();
}
