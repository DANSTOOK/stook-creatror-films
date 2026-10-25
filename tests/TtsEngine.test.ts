import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampSpeed, commandLineText, engineIn, findEngine, kokoroCommand, MAX_SPEED, MIN_SPEED, piperCommand, splitLongSentence, splitText } from '@main/tts/engine';
import { STALE_JOB_MS, Synthesizer } from '@main/tts/synth';
import { readWav, silence, writeWav } from '@main/tts/wav';
import { ALL_VOICES, BUNDLED_VOICES, DOWNLOADABLE_VOICES, voiceById } from '@main/tts/catalog';

/**
 * The text-to-speech plumbing, without the engine: the command line, the
 * speed clamp, how long text is split, and the little WAV reader/writer that
 * joins Piper's pieces. The engine itself runs in tests/ui (the app).
 */

describe('piperCommand', () => {
  it('inverts speed into length_scale (larger is slower) and passes the speaker', () => {
    const args = piperCommand({ model: 'v.onnx', speakerId: 3, output: 'o.wav', speed: 2 });
    const lengthAt = args.indexOf('--length_scale');
    expect(lengthAt).toBeGreaterThanOrEqual(0);
    expect(Number(args[lengthAt + 1])).toBeCloseTo(0.5, 3);
    expect(args[args.indexOf('--speaker') + 1]).toBe('3');
    // The text is never on the command line; it is fed on stdin.
    expect(args).not.toContain('--text');
  });

  it('adds sentence silence only when asked', () => {
    expect(piperCommand({ model: 'v.onnx', speakerId: 0, output: 'o.wav', speed: 1 })).not.toContain('--sentence_silence');
    expect(piperCommand({ model: 'v.onnx', speakerId: 0, output: 'o.wav', speed: 1, sentenceSilence: 0.3 })).toContain('--sentence_silence');
  });
});

describe('clampSpeed', () => {
  it('holds speed to the intelligible range and never returns an unusable value', () => {
    expect(clampSpeed(5)).toBe(MAX_SPEED);
    expect(clampSpeed(0.01)).toBe(MIN_SPEED);
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(1.25)).toBe(1.25);
  });
});

describe('splitText', () => {
  it('returns nothing for empty text', () => {
    expect(splitText('   \n  ')).toEqual([]);
  });

  it('packs short sentences together, and cuts a very long one between words, never past the budget', () => {
    const chunks = splitText('Uno. Dos. Tres.', 100);
    expect(chunks).toEqual(['Uno. Dos. Tres.']);
    const long = `${'palabra '.repeat(80)}.`.trim();
    const mixed = splitText(`Corta. ${long} Otra.`, 120);
    // A run of 640 characters with no full stop went to the engine whole.
    expect(mixed.every((c) => c.length <= 120)).toBe(true);
    expect(mixed.join(' ').split(' ').filter((word) => word.startsWith('palabra')).length).toBe(80);
    expect(mixed[0].startsWith('Corta.')).toBe(true);
  });

  it('cuts a long sentence at its commas, semicolons and dashes first', () => {
    const sentence = 'La primera parte habla del viaje, la segunda de la llegada; la tercera - la más larga - del regreso a casa';
    const pieces = splitLongSentence(sentence, 40);
    expect(pieces.every((piece) => piece.length <= 40)).toBe(true);
    expect(pieces[0]).toBe('La primera parte habla del viaje,');
    expect(pieces.join(' ')).toBe(sentence);
  });

  it('a pasted paragraph of thousands of characters with no punctuation, and a giant "word", stay within the budget', () => {
    const words = Array.from({ length: 900 }, (_, index) => `palabra${index}`);
    const pieces = splitText(words.join(' '), 400);
    expect(pieces.length).toBeGreaterThan(20);
    expect(pieces.every((piece) => piece.length <= 400)).toBe(true);
    expect(pieces.join(' ').split(' ')).toEqual(words);
    const url = `https://example.com/${'x'.repeat(1000)}`;
    expect(splitText(`Mira ${url} ahora.`, 400).every((piece) => piece.length <= 400)).toBe(true);
  });
});

describe('the temp folder of the jobs', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scf-tts-sweep-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a new session sweeps only leftovers: a job another copy of the app is running keeps its folder', async () => {
    // A long text being spoken by another window: its folder was written to a moment ago.
    await mkdir(join(dir, 'tts_running'), { recursive: true });
    // A crashed session's job, untouched for longer than any piece takes.
    await mkdir(join(dir, 'tts_crashed'), { recursive: true });
    const old = (Date.now() - STALE_JOB_MS - 60_000) / 1000;
    await utimes(join(dir, 'tts_crashed'), old, old);
    await new Synthesizer({ tempRoot: dir, engine: () => null }).sweep();
    expect(await readdir(dir)).toEqual(['tts_running']);
  });

  it('a temp root that is not there yet is no trouble', async () => {
    await expect(new Synthesizer({ tempRoot: join(dir, 'missing'), engine: () => null }).sweep()).resolves.toBeUndefined();
  });
});

describe('engine discovery', () => {
  it('prefers SCF_TTS_DIR, and returns null when the program is nowhere', () => {
    expect(engineIn('C:/definitely/not/here')).toBeNull();
    expect(findEngine({ env: { SCF_TTS_DIR: 'C:/nope' } })).toBeNull();
  });
});

describe('WAV round-trip', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scf-tts-wav-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes joined pieces and reads them back at the same rate and length', async () => {
    const a = Int16Array.from([0, 100, -100, 32767, -32768]);
    const b = Int16Array.from([1, 2, 3]);
    const gap = silence(0.5, 1000); // 500 samples
    const path = join(dir, 'out.wav');
    const seconds = await writeWav(path, 1000, [a, gap, b]);
    expect(seconds).toBeCloseTo((a.length + gap.length + b.length) / 1000, 6);
    const read = await readWav(path);
    expect(read.sampleRate).toBe(1000);
    expect(read.samples.length).toBe(a.length + gap.length + b.length);
    expect(Array.from(read.samples.slice(0, 5))).toEqual([0, 100, -100, 32767, -32768]);
  });
});

describe('catalogue', () => {
  it('bundles Spanish (Spain and Mexico) and English voices, all with commercial licences', () => {
    const regions = new Set(BUNDLED_VOICES.map((v) => v.region));
    expect(regions.has('es-ES')).toBe(true);
    expect(regions.has('es-MX')).toBe(true);
    expect([...regions].some((r) => r.startsWith('en'))).toBe(true);
    // No bundled voice carries a non-commercial or research-only licence.
    for (const voice of BUNDLED_VOICES) {
      expect(voice.onnx).toBeNull(); // bundled => no download
      expect(voice.licence.toLowerCase()).not.toMatch(/non-commercial|nc|research/);
    }
  });

  it('gives downloadable voices a pinned size and checksum', () => {
    for (const voice of DOWNLOADABLE_VOICES) {
      expect(voice.onnx?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(voice.onnx?.bytes).toBeGreaterThan(0);
      expect(voice.json?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('finds a voice by id and nothing by a bad id', () => {
    expect(voiceById(BUNDLED_VOICES[0].id)?.id).toBe(BUNDLED_VOICES[0].id);
    expect(voiceById('no-such-voice')).toBeUndefined();
    expect(ALL_VOICES.length).toBe(BUNDLED_VOICES.length + DOWNLOADABLE_VOICES.length);
  });
});

describe('Kokoro', () => {
  it('reads Latin American Spanish, at the pace asked, the text last and never as an option', () => {
    const args = kokoroCommand({ modelDir: 'k', espeakData: 'e', speakerId: 28, phonemes: 'es-419', output: 'o.wav', speed: 2, threads: 3, text: '--help\nHola' });
    expect(args).toContain('--kokoro-lang=es-419');
    expect(args).toContain('--sid=28');
    expect(args).toContain('--kokoro-length-scale=0.5000');
    expect(args[args.length - 1]).toBe('help Hola');
  });

  it('offers Latin American voices of both sexes, each with a name', () => {
    const latin = BUNDLED_VOICES.filter((voice) => voice.language === 'es' && voice.region !== 'es-ES');
    expect(latin.length).toBeGreaterThanOrEqual(6);
    expect(latin.some((voice) => voice.sex === 'female')).toBe(true);
    expect(latin.some((voice) => voice.sex === 'male')).toBe(true);
    expect(latin.filter((voice) => voice.engine === 'kokoro').every((voice) => voice.phonemes === 'es-419')).toBe(true);
    for (const voice of BUNDLED_VOICES) expect(voice.name.length).toBeGreaterThan(1);
  });
});

describe('text on a Windows command line', () => {
  it('reaches the program as UTF-8 through the ANSI code page, every accent intact', () => {
    const text = 'Íñigo, ¿qué tal? Árbol, pingüino, canción.';
    const passed = commandLineText(text, 1252);
    // What Windows does with it: each character back to its byte in the code page.
    const bytes = Buffer.from([...passed].map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x100 && !(code >= 0x80 && code < 0xa0)) return code;
      return [...new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i))].indexOf(character) + 0x80;
    }));
    expect(bytes.toString('utf8')).toBe(text);
    expect(commandLineText(text, null)).toBe(text);
    expect(commandLineText('Ñandú', 932)).toBe('Nandu');
  });
});
