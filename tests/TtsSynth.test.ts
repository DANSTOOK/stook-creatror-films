import { describe, expect, it } from 'vitest';
import { joinSteps, scriptSteps, workerPlan } from '@main/tts/synth';
import { trimSilence } from '@main/tts/wav';

/**
 * How a text-to-speech job is put together (main/tts/synth), without the
 * engines: the script as steps, the pieces joined with the gaps and the
 * pauses asked for, each piece's own silence trimmed, and how many engine
 * processes a machine runs at once. The engines themselves run in tests/ui.
 */

const RATE = 1000;
const tone = (seconds: number, level = 8000): Int16Array => Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => (i % 2 === 0 ? level : -level));

describe('scriptSteps', () => {
  it('speech in engine-sized pieces, the pauses between them where they were written', () => {
    const steps = scriptSteps('Hola a todos. [pausa 2s] Empezamos ya.');
    expect(steps).toEqual([
      { kind: 'speech', text: 'Hola a todos.' },
      { kind: 'pause', seconds: 2 },
      { kind: 'speech', text: 'Empezamos ya.' },
    ]);
    const long = `${'Una frase de prueba. '.repeat(60)}[pause 1s] Fin.`;
    const pieces = scriptSteps(long);
    expect(pieces.filter((step) => step.kind === 'speech').length).toBeGreaterThan(2);
    expect(pieces[pieces.length - 2]).toEqual({ kind: 'pause', seconds: 1 });
  });
});

describe('joinSteps', () => {
  it('a gap between two pieces of speech, exactly the pause at a pause and no gap beside it', () => {
    const steps = scriptSteps('Uno. [pausa 1,5s] Dos.');
    const made = new Map([[0, tone(0.4)], [2, tone(0.6)]]);
    const { parts, segments } = joinSteps(steps, made, RATE, 0.3);
    expect(parts.map((part) => part.length)).toEqual([400, 1500, 600]);
    expect(segments).toEqual([
      { start: 0, end: 0.4, text: 'Uno.' },
      { start: 1.9, end: 2.5, text: 'Dos.' },
    ]);
  });

  it('pieces side by side get the gap; a pause first is kept as the clip’s start', () => {
    const steps = [{ kind: 'pause' as const, seconds: 1 }, { kind: 'speech' as const, text: 'a' }, { kind: 'speech' as const, text: 'b' }];
    const { parts, segments } = joinSteps(steps, new Map([[1, tone(0.2)], [2, tone(0.2)]]), RATE, 0.5);
    expect(parts.map((part) => part.length)).toEqual([1000, 200, 500, 200]);
    expect(segments.map((segment) => [segment.start, segment.end])).toEqual([[1, 1.2], [1.7, 1.9]]);
  });
});

describe('trimSilence', () => {
  it('cuts the engine’s silence at both ends, keeps a little around the speech, and fades the cut', () => {
    const piece = Int16Array.from([...new Int16Array(300), ...tone(0.5), ...new Int16Array(400)]);
    const kept = trimSilence(piece, RATE, { lead: 0.02, trail: 0.06, fade: 0.004 });
    // 20 ms before, the 500 ms of speech, 60 ms after.
    expect(kept.length).toBe(20 + 500 + 60);
    expect(kept[0]).toBe(0);
    expect(Math.abs(kept[21])).toBe(8000);
  });

  it('a piece with no sound in it comes back empty; one with no silence comes back whole', () => {
    expect(trimSilence(new Int16Array(500), RATE).length).toBe(0);
    expect(trimSilence(tone(0.3), RATE, { fade: 0 })).toEqual(tone(0.3));
  });
});

describe('workerPlan', () => {
  const GB = 1024 * 1024 * 1024;
  it('up to six engines of two threads on a big machine, one on a small one, half the cores left over', () => {
    expect(workerPlan(24)).toEqual({ workers: 6, threads: 2 });
    expect(workerPlan(12)).toEqual({ workers: 3, threads: 2 });
    expect(workerPlan(8)).toEqual({ workers: 2, threads: 2 });
    expect(workerPlan(4)).toEqual({ workers: 1, threads: 2 });
    expect(workerPlan(1)).toEqual({ workers: 1, threads: 1 });
  });

  it('free memory caps them: each holds the model, and 2 GB stay spare', () => {
    expect(workerPlan(24, 3 * GB)).toEqual({ workers: 2, threads: 4 });
    expect(workerPlan(24, 1 * GB)).toEqual({ workers: 1, threads: 4 });
    expect(workerPlan(24, 20 * GB)).toEqual({ workers: 6, threads: 2 });
  });
});
