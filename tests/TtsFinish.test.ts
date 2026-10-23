import { describe, expect, it } from 'vitest';
import { finishFilter } from '../src/main/tts/finish';
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
