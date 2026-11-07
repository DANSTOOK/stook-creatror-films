import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampSpeed, MAX_SPEED, MIN_SPEED, splitLongSentence, splitText } from '@main/tts/split';
import { STALE_JOB_MS, Synthesizer } from '@main/tts/synth';
import { readWav, silence, writeWav } from '@main/tts/wav';

/**
 * The text-to-speech plumbing that is not the service: the speed clamp, how
 * long text is cut into pieces one request can speak, the temp folder of the
 * jobs, and the little WAV reader/writer that joins the pieces. What goes out
 * to Azure is checked in AzureVoice.test.ts; what the app does with it, in
 * tests/ui/azure-voice.mjs.
 *
 * This was TtsEngine.test.ts, which also checked two command lines - Piper's
 * and sherpa-onnx's. Those engines are gone, and so are those checks; nothing
 * here was weakened to make that true.
 */

describe('clampSpeed', () => {
  it('holds speed to the range Azure accepts and never returns an unusable value', () => {
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

  it('keeps every piece well inside what one request may carry', () => {
    // A piece becomes an SSML document, and the client refuses one over
    // MAX_SSML_CHARS (8000). The default budget is 400 characters of text, so
    // the document around it has room it will never need.
    const pieces = splitText('Hola. '.repeat(2000));
    expect(pieces.every((piece) => piece.length <= 400)).toBe(true);
  });
});

describe('the temp folder of the jobs', () => {
  let dir = '';
  const noFetch = () => {
    throw new Error('not called');
  };
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
    await new Synthesizer({ tempRoot: dir, azureFetch: noFetch }).sweep();
    expect(await readdir(dir)).toEqual(['tts_running']);
  });

  it('a temp root that is not there yet is no trouble', async () => {
    await expect(new Synthesizer({ tempRoot: join(dir, 'missing'), azureFetch: noFetch }).sweep()).resolves.toBeUndefined();
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
