import { describe, expect, it } from 'vitest';
import { MAX_GAIN, gainFromText, numberFromText, panFromText } from '@renderer/components/Mixer/values';
import { dbLabel, panLabel } from '@renderer/audio/levels';

/**
 * Typing values into the mixer, which until now only had faders.
 *
 * What the readout prints has to be accepted back: a level that reads
 * "-6.0 dB" and is typed in again must land on the same gain.
 */

describe('levels', () => {
  it('reads what the readout shows', () => {
    expect(gainFromText('-6.0 dB')).toBeCloseTo(0.5012, 4);
    expect(gainFromText('+3.0 dB')).toBeCloseTo(1.4125, 4);
    expect(gainFromText('0.0 dB')).toBeCloseTo(1, 6);
  });

  it('reads what a person types', () => {
    expect(gainFromText('-6')).toBeCloseTo(0.5012, 4);
    expect(gainFromText(' 3 ')).toBeCloseTo(1.4125, 4);
    expect(gainFromText('-6,0')).toBeCloseTo(0.5012, 4);
  });

  it('round-trips through the label the mixer prints', () => {
    for (const gain of [0.1, 0.5, 1, 1.5, 2]) {
      const typed = gainFromText(dbLabel(gain));
      expect(typed).not.toBeNull();
      expect(typed as number).toBeCloseTo(gain, 2);
    }
  });

  it('takes silence, however it is written', () => {
    expect(gainFromText('-inf')).toBe(0);
    expect(gainFromText('-inf dB')).toBe(0);
    expect(gainFromText('-∞')).toBe(0);
    expect(gainFromText('-80')).toBe(0);
  });

  it('stops at the top of the fader instead of refusing', () => {
    expect(gainFromText('+12')).toBe(MAX_GAIN);
    expect(gainFromText('6.1')).toBe(MAX_GAIN);
  });

  it('refuses what is not a level, so the field can put back what was there', () => {
    expect(gainFromText('')).toBeNull();
    expect(gainFromText('loud')).toBeNull();
    expect(gainFromText('--3')).toBeNull();
  });
});

describe('pan', () => {
  it('reads what the readout shows', () => {
    expect(panFromText('C')).toBe(0);
    expect(panFromText('L30')).toBeCloseTo(-0.3, 6);
    expect(panFromText('R100')).toBe(1);
    expect(panFromText('r 50')).toBeCloseTo(0.5, 6);
  });

  it('round-trips through the label the mixer prints', () => {
    for (const pan of [-1, -0.3, 0, 0.25, 1]) {
      expect(panFromText(panLabel(pan)) as number).toBeCloseTo(pan, 2);
    }
  });

  it('takes both ways of writing a number', () => {
    expect(panFromText('-50')).toBeCloseTo(-0.5, 6);
    expect(panFromText('0.5')).toBeCloseTo(0.5, 6);
  });

  it('never leaves the stereo field', () => {
    expect(panFromText('R300')).toBe(1);
    expect(panFromText('-400')).toBe(-1);
  });

  it('refuses nonsense', () => {
    expect(panFromText('')).toBeNull();
    expect(panFromText('left')).toBeNull();
  });
});

describe('plain numbers', () => {
  it('clamps to the control range', () => {
    expect(numberFromText('-18', -60, 0)).toBe(-18);
    expect(numberFromText('-90', -60, 0)).toBe(-60);
    expect(numberFromText('5', -60, 0)).toBe(0);
  });

  it('takes a comma as a decimal point', () => {
    expect(numberFromText('0,25', 0, 1)).toBeCloseTo(0.25, 6);
  });

  it('refuses what is not a number', () => {
    expect(numberFromText('x', 0, 1)).toBeNull();
    expect(numberFromText('   ', 0, 1)).toBeNull();
  });
});
