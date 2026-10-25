import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readWav } from '../src/main/tts/wav';
import { finishFilter, TTS_EFFECTS } from '../src/main/tts/finish';

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;
import { captionLines } from '../src/renderer/tts/speak';

describe('a generated voice made ready', () => {
  it('moves the pitch without changing the pace', () => {
    const filter = finishFilter(4, 22050, false);
    // 2^(4/12) = 1.2599: the rate up by that much, the tempo back down by it.
    expect(filter).toContain('asetrate=27781');
    expect(filter).toContain('aresample=22050');
    expect(filter).toContain('atempo=0.79370');
  });

  it('leaves the pitch alone at 0, and keeps the unprocessed voice off full scale', () => {
    const filter = finishFilter(0, 22050, false);
    expect(filter).not.toContain('asetrate');
    expect(filter).toContain('alimiter');
  });

  it('clear voice: rumble cut, presence, a gentle compressor, -16 LUFS with the true peak at -1.5', () => {
    const filter = finishFilter(0, 22050, true);
    expect(filter).toContain('highpass=f=70');
    expect(filter).toContain('acompressor');
    expect(filter).toContain('loudnorm=I=-16:TP=-1.5');
    expect(filter.endsWith('aresample=48000')).toBe(true);
  });

  it('holds the pitch to six semitones either way', () => {
    expect(finishFilter(20, 22050, false)).toBe(finishFilter(6, 22050, false));
  });
});

describe('captions of what a voice says', () => {
  it('a line a sentence, timed by its length, over the whole voice', () => {
    const lines = captionLines('Hola a todos. Hoy vamos a editar. Empecemos.', 10);
    expect(lines.map((line) => line.text)).toEqual(['Hola a todos.', 'Hoy vamos a editar.', 'Empecemos.']);
    expect(lines[0].start).toBe(0);
    expect(lines[2].end).toBeCloseTo(10, 5);
    expect(lines[1].end - lines[1].start).toBeGreaterThan(lines[2].end - lines[2].start);
  });

  it('a long sentence in pieces of a few words', () => {
    const long = 'Este es un ejemplo de una frase muy larga que no cabría en una sola línea de subtítulo y que por eso se parte en trozos';
    const lines = captionLines(long, 6);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.text.length <= 64)).toBe(true);
    expect(lines.map((line) => line.text).join(' ')).toBe(long);
  });
});

describe('characters for a generated voice', () => {
  it('leaves the ends alone - synth cut the silence piece by piece, and a pause written first must stay - and softens the s in clear voice', () => {
    const filter = finishFilter(0, 24000, true);
    expect(filter).not.toContain('silenceremove');
    expect(filter).not.toContain('areverse');
    expect(filter).toContain('deesser');
    expect(finishFilter(0, 24000, false)).not.toContain('deesser');
  });

  it('a second of silence before the voice is still a second after the finish, levelling and all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scf-tts-finish-'));
    try {
      const out = join(dir, 'out.wav');
      // One second of nothing, then a tone - the shape "[pausa 1s] Hola" leaves.
      const run = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=1:sample_rate=24000',
        '-filter_complex', `[0][1]concat=n=2:v=0:a=1,${finishFilter(0, 24000, true)}`, '-ar', '48000', '-c:a', 'pcm_s16le', out], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      const wav = await readWav(out);
      const first = wav.samples.findIndex((sample) => Math.abs(sample) > 300);
      expect(Math.abs(first / wav.sampleRate - 1)).toBeLessThan(0.03);
      expect(Math.abs(wav.samples.length / wav.sampleRate - 2)).toBeLessThan(0.05);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts the style after the pitch and before the levelling', () => {
    const filter = finishFilter(-6, 22050, true, 'robot');
    expect(filter.indexOf('afftfilt')).toBeGreaterThan(filter.indexOf('atempo'));
    expect(filter.indexOf('afftfilt')).toBeLessThan(filter.indexOf('loudnorm'));
    expect(finishFilter(0, 22050, true, 'phone')).toContain('lowpass=f=3200');
  });

  it('every style is a filter ffmpeg runs', () => {
    for (const effect of TTS_EFFECTS) {
      const run = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=1:sample_rate=22050', '-af', finishFilter(2, 22050, true, effect), '-f', 'null', '-'], { encoding: 'utf8' });
      expect(`${effect}: ${run.status} ${run.stderr.trim()}`).toBe(`${effect}: 0 `);
    }
  });
});
