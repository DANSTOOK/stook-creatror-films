import { describe, expect, it } from 'vitest';
import { foldText, isHallucination, parseProgress, parseVadSegments, parseWhisperJson, vadTimeToOriginal, type WhisperJson } from '@shared/captions/whisperOutput';

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

/**
 * With the voice detector (`--vad`) Whisper hears the sound with its
 * silences cut out, and the token times come back in that shorter sound's
 * time. Real output again: the same recording with 30 s of silence put in
 * at 36.8 s, whisper-cli at 927cfce with ggml-silero-v6.2.0, the small model.
 */
describe('whisper.cpp output with the voice detector', () => {
  const LOG = [
    'whisper_vad_segments_from_probs: VAD segment 12: start = 34.72, end = 36.38 (duration: 1.66)',
    'whisper_vad: Including segment 12: 34.72 - 36.48 (duration: 1.76)',
    'whisper_vad: vad_segment_info: orig_start: 28.29, orig_end: 33.98, vad_start: 25.07, vad_end: 30.76',
    'whisper_vad: vad_segment_info: orig_start: 34.72, orig_end: 36.38, vad_start: 30.96, vad_end: 32.62',
    'whisper_vad: vad_segment_info: orig_start: 67.14, orig_end: 71.52, vad_start: 32.82, vad_end: 37.20',
    'whisper_vad: Created time mapping table with 71 points',
  ].join('\r\n');

  const ACROSS: WhisperJson = {
    transcription: [
      {
        text: ' Qué bonito quedó el atardecer. Las nubes naranjas y',
        // The segment's own times the program does map back: 33.78 to 70.44 s.
        offsets: { from: 33780, to: 70440 },
        tokens: [
          token(' Qué', 30620, 30780, 3106),
          token(' bonito', 30780, 31220, 3136),
          token(' qued', 31220, 31500, 3162),
          token('ó', 31510, 31580, 3178),
          token(' el', 31580, 31720, 3190),
          token(' at', 31720, 31750, 3204),
          token('arde', 32110, 32150, 3216),
          token('cer', 32150, 32370, 3244),
          token('.', 32370, 32550, 3282),
          token(' Las', 32610, 32810, 3302),
          token(' n', 32810, 32850, 3316),
          token('ub', 32950, 33020, 3320),
          token('es', 33020, 33160, 3332),
          token(' nar', 33160, 33380, 3350),
          token('an', 33380, 33500, 3362),
          token('jas', 33610, 33730, 3378),
          token(' y', 33810, 33810, 3398),
        ],
      },
    ],
  };

  /** When the voice began each word, with the 30 s of silence counted (ms). */
  const SPOKEN: Record<string, number> = { Qué: 34720, bonito: 34840, quedó: 35240, el: 35545, 'atardecer.': 35660, Las: 67155, nubes: 67375, naranjas: 67675, y: 68215 };

  it("reads the detector's table from what the program prints", () => {
    expect(parseVadSegments(LOG)).toEqual([
      { origStart: 28.29, origEnd: 33.98, vadStart: 25.07, vadEnd: 30.76 },
      { origStart: 34.72, origEnd: 36.38, vadStart: 30.96, vadEnd: 32.62 },
      { origStart: 67.14, origEnd: 71.52, vadStart: 32.82, vadEnd: 37.2 },
    ]);
    expect(parseVadSegments('whisper_full: VAD is enabled, processing speech segments only')).toEqual([]);
  });

  it('puts a moment of the shortened sound back where it was', () => {
    const table = parseVadSegments(LOG);
    // Inside a stretch: the same samples, so the time runs on from its start.
    expect(vadTimeToOriginal(table, 30.96)).toBeCloseTo(34.72, 5);
    expect(vadTimeToOriginal(table, 32)).toBeCloseTo(35.76, 5);
    expect(vadTimeToOriginal(table, 33.02)).toBeCloseTo(67.34, 5);
    // Just past its end: the tenth of a second of the same sound that follows.
    expect(vadTimeToOriginal(table, 32.7)).toBeCloseTo(36.46, 5);
    // Between two stretches a fifth of a second apart in both: never past the next one.
    expect(vadTimeToOriginal(table, 30.95)).toBeCloseTo(34.17, 5);
    expect(vadTimeToOriginal([{ origStart: 1, origEnd: 2, vadStart: 0, vadEnd: 1 }, { origStart: 2.15, origEnd: 3, vadStart: 1.2, vadEnd: 2.05 }], 1.19)).toBeCloseTo(2.15, 5);
    // Before the first stretch, and with no table at all.
    expect(vadTimeToOriginal(table, 0)).toBeCloseTo(28.29, 5);
    expect(vadTimeToOriginal([], 12.5)).toBe(12.5);
  });

  it('never maps backwards', () => {
    const table = parseVadSegments(LOG);
    let last = -Infinity;
    for (let t = 25; t < 37.5; t += 0.01) {
      const mapped = vadTimeToOriginal(table, t);
      expect(mapped).toBeGreaterThanOrEqual(last);
      last = mapped;
    }
  });

  it('starts each word within 200 ms of where it was spoken, across a long silence', () => {
    const { words } = parseWhisperJson(ACROSS, parseVadSegments(LOG));
    expect(words.map((word) => word.text)).toEqual(Object.keys(SPOKEN));
    for (const word of words) expect(Math.abs(word.start * 1000 - SPOKEN[word.text]), `${word.text} at ${word.start}`).toBeLessThanOrEqual(200);
    // No word runs through the silence: the one before it ends before it.
    const atardecer = words.find((word) => word.text === 'atardecer.');
    expect(atardecer?.end).toBeLessThan(36.6);
  });

  it('is seconds early without the table - what the table is for', () => {
    const las = parseWhisperJson(ACROSS).words.find((word) => word.text === 'Las');
    expect(las?.start).toBeLessThan(34);
  });
});
