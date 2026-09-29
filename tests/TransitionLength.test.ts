import { describe, expect, it } from 'vitest';
import {
  cleanTransitionSeconds,
  newTransitionFrames,
  useTransitionLengthStore,
} from '../src/renderer/timing/transitionLength';

describe('the default transition length (Preferences)', () => {
  it('takes numbers and numeric text, clamps to a tenth of a second .. ten seconds', () => {
    expect(cleanTransitionSeconds(1.5)).toBe(1.5);
    expect(cleanTransitionSeconds('0.75')).toBe(0.75);
    expect(cleanTransitionSeconds(0)).toBe(0.1);
    expect(cleanTransitionSeconds(60)).toBe(10);
    expect(cleanTransitionSeconds(0.123)).toBe(0.12);
    expect(cleanTransitionSeconds('soon')).toBeUndefined();
    expect(cleanTransitionSeconds(Number.NaN)).toBeUndefined();
  });

  it('is one second until changed, and a new transition gets the chosen length in frames', () => {
    expect(useTransitionLengthStore.getState().seconds).toBe(1);
    expect(newTransitionFrames(30, 2)).toBe(30);
    useTransitionLengthStore.getState().setSeconds(0.5);
    expect(newTransitionFrames(30, 2)).toBe(15);
    expect(newTransitionFrames(24, 2)).toBe(12);
    useTransitionLengthStore.getState().setSeconds(0.1);
    // Never shorter than a transition can be dragged to.
    expect(newTransitionFrames(10, 2)).toBe(2);
    useTransitionLengthStore.getState().setSeconds(1);
  });
});
