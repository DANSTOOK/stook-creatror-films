import { beforeEach, describe, expect, it } from 'vitest';
import type { Track } from '@shared/types';
import {
  ENVELOPE_BLOCK,
  applyGainCurve,
  blockRms,
  computeDuckingEnvelope,
  dbToLinear,
  duckOffline,
} from '@renderer/audio/DynamicDucking';
import {
  clipGain,
  hasSoloedTrack,
  isTrackAudible,
  mixSignature,
  panPosition,
  trackGain,
} from '@renderer/audio/mixRouting';
import { createClip, createEmptyProject, createTrack, defaultBusForName } from '@renderer/store/types';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * The mixer.
 *
 * Playback and export are two separate audio graphs - one realtime, one
 * offline - so the only way they can agree on what the mix IS is by reading the
 * same arithmetic. That arithmetic is `mixRouting`, and this is where it is
 * pinned down. The ducking half covers the offline path, which is what makes an
 * exported file duck in the same places the monitor does.
 */

const track = (overrides: Partial<Track> = {}): Track => ({
  ...createTrack('audio', 0, 'Audio 1'),
  ...overrides,
});

const state = () => useProjectStore.getState();

describe('mute and solo', () => {
  it('silences a muted track', () => {
    expect(isTrackAudible(track({ muted: true }), false)).toBe(false);
  });

  it('silences everything that is not soloed, while anything is soloed', () => {
    expect(isTrackAudible(track({ solo: false }), true)).toBe(false);
    expect(isTrackAudible(track({ solo: true }), true)).toBe(true);
  });

  it('keeps mute winning over solo on the same track', () => {
    // Soloing a muted track is a contradiction the user can reach by clicking
    // two buttons, and silence is the less surprising resolution.
    expect(isTrackAudible(track({ solo: true, muted: true }), true)).toBe(false);
  });

  it('restores the original mute states when the solo is cleared', () => {
    const muted = track({ muted: true });
    const plain = track({ name: 'Audio 2' });

    expect(isTrackAudible(muted, false)).toBe(false);
    expect(isTrackAudible(plain, false)).toBe(true);
  });

  it('reports whether anything is soloed at all', () => {
    const project = createEmptyProject();
    expect(hasSoloedTrack(project)).toBe(false);

    const soloed = {
      ...project,
      tracks: project.tracks.map((t, index) => ({ ...t, solo: index === 1 })),
    };
    expect(hasSoloedTrack(soloed)).toBe(true);
  });
});

describe('gain and pan', () => {
  it('drops a silenced track to zero rather than to its fader value', () => {
    expect(trackGain(track({ volume: 1.5, muted: true }), false)).toBe(0);
    expect(trackGain(track({ volume: 1.5 }), false)).toBe(1.5);
  });

  it('clamps gain into the range the engine accepts', () => {
    expect(trackGain(track({ volume: 9 }), false)).toBe(2);
    expect(trackGain(track({ volume: -3 }), false)).toBe(0);
  });

  it('clamps clip gain the same way', () => {
    const clip = createClip({
      trackId: 't',
      name: 'c',
      sourceUri: 'blob:c',
      startFrame: 0,
      durationFrames: 10,
    });

    expect(clipGain({ ...clip, volume: 5 })).toBe(2);
    expect(clipGain({ ...clip, volume: -1 })).toBe(0);
  });

  it('clamps pan and survives a corrupted value', () => {
    expect(panPosition(-4)).toBe(-1);
    expect(panPosition(4)).toBe(1);
    expect(panPosition(Number.NaN)).toBe(0);
  });
});

describe('bus assignment', () => {
  it('routes obviously-spoken track names to the dialogue bus', () => {
    expect(defaultBusForName('Dialogue 1')).toBe('dialogue');
    expect(defaultBusForName('VO')).toBe('dialogue');
    expect(defaultBusForName('Narration')).toBe('dialogue');
  });

  it('routes everything else to the music bus', () => {
    expect(defaultBusForName('Audio 1')).toBe('music');
    expect(defaultBusForName('Score')).toBe('music');
  });

  it('is decided once, at creation, not re-sniffed on every rename', () => {
    const created = createTrack('audio', 0, 'Dialogue 1');
    // Renaming must not re-route a track the user has already assigned.
    expect({ ...created, name: 'Music' }.bus).toBe('dialogue');
  });
});

describe('mixSignature', () => {
  it('ignores playhead movement, which happens on every animation frame', () => {
    const project = createEmptyProject();
    expect(mixSignature({ ...project, currentFrame: 500 })).toBe(mixSignature(project));
  });

  it('changes when a fader moves', () => {
    const project = createEmptyProject();
    const louder = {
      ...project,
      tracks: project.tracks.map((t, index) => (index === 0 ? { ...t, volume: 0.5 } : t)),
    };

    expect(mixSignature(louder)).not.toBe(mixSignature(project));
  });

  it('changes when the master or the ducking parameters move', () => {
    const project = createEmptyProject();

    expect(
      mixSignature({ ...project, audio: { ...project.audio, masterVolume: 0.5 } }),
    ).not.toBe(mixSignature(project));

    expect(
      mixSignature({
        ...project,
        audio: { ...project.audio, ducking: { ...project.audio.ducking, enabled: true } },
      }),
    ).not.toBe(mixSignature(project));
  });

  it('does not depend on the order tracks or clips happen to be stored in', () => {
    const project = createEmptyProject();
    const reversed = { ...project, tracks: [...project.tracks].reverse() };

    expect(mixSignature(reversed)).toBe(mixSignature(project));
  });
});

describe('ducking envelope', () => {
  const sampleRate = 375; // One envelope sample per block at 48 kHz.

  it('holds unity gain while the sidechain is silent', () => {
    const gains = computeDuckingEnvelope(new Float32Array(50), sampleRate);
    expect(gains[49]).toBeCloseTo(1, 3);
  });

  it('pulls the gain down towards the range floor once speech is present', () => {
    const loud = new Float32Array(200).fill(0.5);
    const gains = computeDuckingEnvelope(loud, sampleRate, {
      thresholdDb: -32,
      rangeDb: 12,
      attackSeconds: 0.08,
      releaseSeconds: 0.45,
    });

    expect(gains.at(-1)).toBeCloseTo(dbToLinear(-12), 2);
  });

  it('never ducks further than the range asks for', () => {
    const loud = new Float32Array(500).fill(1);
    const floor = dbToLinear(-6);
    const gains = computeDuckingEnvelope(loud, sampleRate, {
      thresholdDb: -40,
      rangeDb: 6,
      attackSeconds: 0.01,
      releaseSeconds: 0.1,
    });

    for (const gain of gains) expect(gain).toBeGreaterThanOrEqual(floor - 1e-6);
  });

  it('recovers after the speech stops', () => {
    const envelope = new Float32Array(600);
    envelope.fill(0.5, 0, 200);

    const gains = computeDuckingEnvelope(envelope, sampleRate);
    expect(gains[199]).toBeLessThan(0.5);
    expect(gains.at(-1)).toBeGreaterThan(0.9);
  });
});

describe('offline ducking', () => {
  const blocks = (count: number, value: number): Float32Array => {
    const data = new Float32Array(count * ENVELOPE_BLOCK);
    data.fill(value);
    return data;
  };

  it('measures a signal block by block', () => {
    const envelope = blockRms([blocks(3, 0.5)]);
    expect(envelope).toHaveLength(3);
    for (const value of envelope) expect(value).toBeCloseTo(0.5, 5);
  });

  it('reads silence as silence', () => {
    expect(Array.from(blockRms([blocks(2, 0)]))).toEqual([0, 0]);
  });

  it('interpolates a gain curve instead of stepping it', () => {
    const signal = new Float32Array(ENVELOPE_BLOCK * 2).fill(1);
    applyGainCurve([signal], [1, 0]);

    // Halfway through the first block the gain should be halfway between the
    // two values - a step here is an audible buzz at the block rate.
    expect(signal[ENVELOPE_BLOCK / 2]).toBeCloseTo(0.5, 2);
  });

  it('pulls the music down where the dialogue is, and leaves it alone elsewhere', () => {
    const music = new Float32Array(ENVELOPE_BLOCK * 400).fill(1);
    const dialogue = new Float32Array(music.length);
    dialogue.fill(0.5, ENVELOPE_BLOCK * 100, ENVELOPE_BLOCK * 200);

    const floor = duckOffline([music], [dialogue], 48_000, {
      thresholdDb: -32,
      rangeDb: 12,
      attackSeconds: 0.02,
      releaseSeconds: 0.1,
    });

    expect(floor).toBeLessThan(0.3);
    expect(music[0]).toBeCloseTo(1, 3);
    expect(music[ENVELOPE_BLOCK * 190]).toBeLessThan(0.4);
    expect(music.at(-1)).toBeCloseTo(1, 2);
  });

  it('reports a gain of exactly 1 when there is no dialogue to duck against', () => {
    const music = new Float32Array(ENVELOPE_BLOCK * 10).fill(1);
    const floor = duckOffline([music], [new Float32Array(music.length)], 48_000);

    // "Enabled" and "audible" are separate claims, and this is the honest one.
    expect(floor).toBeCloseTo(1, 5);
    expect(music[0]).toBeCloseTo(1, 5);
  });
});

describe('mixer state through the store', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject();
    useHistoryStore.getState().clear();
  });

  it('clamps the master fader and makes the change undoable', () => {
    state().setMasterVolume(9);
    expect(state().project.audio.masterVolume).toBe(2);

    state().undo();
    expect(state().project.audio.masterVolume).toBe(1);
  });

  it('stores ducking parameters on the project, so they are saved', () => {
    state().setDucking({ enabled: true, rangeDb: 18 });

    const document = JSON.parse(JSON.stringify(state().toDocument()));
    expect(document.project.audio.ducking).toMatchObject({ enabled: true, rangeDb: 18 });
  });

  it('keeps track faders in the project document too', () => {
    const trackId = state().project.tracks[0].id;
    state().updateTrack(trackId, { volume: 0.25, pan: -0.5, solo: true, bus: 'dialogue' });

    const document = JSON.parse(JSON.stringify(state().toDocument()));
    const saved = document.project.tracks.find((t: Track) => t.id === trackId);
    expect(saved).toMatchObject({ volume: 0.25, pan: -0.5, solo: true, bus: 'dialogue' });
  });
});
