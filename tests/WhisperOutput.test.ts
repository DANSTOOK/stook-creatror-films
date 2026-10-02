import { describe, expect, it } from 'vitest';
import { foldText, isHallucination, parseProgress, parseWhisperJson, type WhisperJson } from '@shared/captions/whisperOutput';

/**
 * Reading whisper.cpp's JSON. The tokens below are real: what whisper-cli
 * b5130 wrote for the Spanish recording tests/bench/captions-tts.ps1 makes
 * (`-ojf -dtw ... -nfa`), with the voice's own word times beside them.
 */

const token = (text: string, from: number, to: number, dtw: number) => ({ text, offsets: { from, to }, t_dtw: dtw });

/** large-v3-turbo: one segment that runs across two sentences. */
const TURBO: WhisperJson = {
  transcription: [
    {
      text: ' Buenos días a todos. Hoy vamos a editar un vídeo corto',
      offsets: { from: 0, to: 5500 },
      tokens: [
        token('[_BEG_]', 0, 0, -1),
        token(' Buenos', 160, 380, 34),
        token(' días', 380, 630, 62),
        token(' a', 630, 650, 88),
        token(' todos', 740, 1000, 116),
        token('.', 1010, 1220, 172),
        token(' Hoy', 1220, 1290, 228),
        token(' vamos', 1900, 1900, 252),
        token(' a', 1900, 1980, 270),
        token(' ed', 2150, 2150, 288),
        token('itar', 2150, 2490, 306),
        token(' un', 2490, 2660, 324),
        token(' vídeo', 2660, 3090, 348),
        token(' cort', 3090, 3430, 378),
        token('o', 3430, 3510, 394),
        token('[_TT_275]', 5500, 5500, -1),
      ],
    },
    {
      text: ' catedral. ¿Alguna vez',
      offsets: { from: 5900, to: 11360 },
      tokens: [
        token(' c', 6850, 6900, 722),
        token('ated', 6910, 7150, 736),
        token('ral', 7150, 7190, 758),
        token('.', 7580, 7580, 842),
        token(' ¿', 7580, 7670, 854),
        token('Al', 7670, 7850, 868),
        token('g', 7940, 7940, 868),
        token('una', 8050, 8200, 886),
        token(' vez', 8240, 8450, 906),
      ],
    },
  ],
};

/** What the voice said, and when it began each word (ms). */
const TRUTH: Record<string, number> = { Buenos: 100, días: 445, a: 740, todos: 805, Hoy: 2155, vamos: 2300, editar: 2725, un: 3120, vídeo: 3255, corto: 3555, Alguna: 8495, vez: 8890 };

describe('whisper.cpp output', () => {
  it('builds words from tokens, with their punctuation', () => {
    const { words } = parseWhisperJson(TURBO);
    expect(words.map((word) => word.text)).toEqual(['Buenos', 'días', 'a', 'todos.', 'Hoy', 'vamos', 'a', 'editar', 'un', 'vídeo', 'corto', 'catedral.', '¿Alguna', 'vez']);
  });

  it('starts each word within 200 ms of where it was spoken', () => {
    const { words } = parseWhisperJson(TURBO);
    const seen = new Set<string>();
    for (const word of words) {
      const key = word.text.replace(/[¿?.,]/g, '');
      const truth = TRUTH[key];
      // "a" is said twice; only the first is in the table.
      if (truth === undefined || seen.has(key)) continue;
      seen.add(key);
      expect(Math.abs(word.start * 1000 - truth), `${key} at ${word.start}`).toBeLessThanOrEqual(200);
    }
    expect(seen.size).toBe(12);
  });

  it('does not start a sentence in the silence before it', () => {
    // The full stop is aligned at 1.72 s; "Hoy" was spoken at 2.155 s. The
    // decoder's own time for it (1.22 s) is a second early.
    const hoy = parseWhisperJson(TURBO).words.find((word) => word.text === 'Hoy');
    expect(hoy?.start).toBeGreaterThan(1.95);
    expect(hoy?.start).toBeLessThan(2.3);
  });

  it('ends a word where it ends, not after the pause its full stop is aligned to', () => {
    const todos = parseWhisperJson(TURBO).words.find((word) => word.text === 'todos.');
    expect(todos?.end).toBeCloseTo(1.16, 2);
  });

  it('never runs backwards', () => {
    const { words } = parseWhisperJson(TURBO);
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
      expect(words[i].end).toBeGreaterThanOrEqual(words[i].start);
    }
  });

  it('falls back to the decoder times when there is no alignment', () => {
    const plain: WhisperJson = {
      transcription: [{ text: ' Hola mundo.', offsets: { from: 500, to: 2000 }, tokens: [token(' Hola', 500, 900, -1), token(' mundo', 950, 1400, -1), token('.', 1400, 1500, -1)] }],
    };
    expect(parseWhisperJson(plain).words).toEqual([
      { text: 'Hola', start: 0.5, end: 0.9 },
      { text: 'mundo.', start: 0.95, end: 1.4 },
    ]);
  });

  it('drops what Whisper makes up over silence and music', () => {
    const made: WhisperJson = {
      transcription: [
        { text: ' Hola.', offsets: { from: 0, to: 800 }, tokens: [token(' Hola', 0, 500, -1), token('.', 500, 600, -1)] },
        { text: ' Subtítulos realizados por la comunidad de Amara.org', offsets: { from: 1000, to: 4000 }, tokens: [token(' Subtítulos', 1000, 2000, -1)] },
        { text: ' [MÚSICA]', offsets: { from: 4000, to: 9000 }, tokens: [token(' [', 4000, 4100, -1), token('MÚSICA', 4100, 5000, -1), token(']', 5000, 5100, -1)] },
      ],
    };
    const parsed = parseWhisperJson(made);
    expect(parsed.words.map((word) => word.text)).toEqual(['Hola.']);
    expect(parsed.dropped).toEqual(['Subtítulos realizados por la comunidad de Amara.org', '[MÚSICA]']);
  });

  it('knows the made-up credits in both languages, and leaves speech alone', () => {
    for (const text of [
      'Subtítulos realizados por la comunidad de Amara.org',
      'Subtítulos por la comunidad de Amara.org',
      'Subtitles by the Amara.org community',
      '[Música]',
      '(risas)',
      '♪♪',
      '',
    ]) {
      expect(isHallucination(text), text).toBe(true);
    }
    for (const text of ['Gracias por ver el vídeo.', 'Los subtítulos ayudan a entender la película.', 'Hoy hablamos de música (y de cine).']) {
      expect(isHallucination(text), text).toBe(false);
    }
  });

  it('reads the progress lines', () => {
    expect(parseProgress('whisper_print_progress_callback: progress =  32%')).toBeCloseTo(0.32);
    expect(parseProgress('whisper_print_progress_callback: progress = 100%')).toBe(1);
    expect(parseProgress('whisper_print_timings:     load time =   128.58 ms')).toBeNull();
  });

  it('folds text for comparing', () => {
    expect(foldText('¿Qué tal, Guadalajara?')).toBe('quetalguadalajara');
  });
});
