import { brass, chord, hat, hiss, kick, midi, panned, room, snare, tom, tone, wobble, type Graph } from './primitives';

/**
 * The music added beside the first five tracks (block 7c): reggaeton, trap,
 * house, synthwave, an ambient piano, an epic trailer, funk and a happy
 * acoustic strum - with a melody, a place in the stereo and a room to ring
 * in, which the first five do not have. Made here by synthesis, as they are
 * (sounds/synth), and as free to use.
 *
 * Each is a loop of whole phrases of four bars. It is played twice over and
 * the second pass kept (renderSound): the room's ring from its last bar
 * then carries on into its first, and the join cannot be heard.
 */

interface Track {
  bpm: number;
  /** How much of it rings in the room. */
  wet: number;
  /** One bar of it into `out`, from `at`: bar `index` of the loop, `beat` seconds a beat. */
  bar(context: Graph, out: AudioNode, at: number, index: number, beat: number): void;
}

/* The voices ------------------------------------------------------------------------ */

/** A plucked string: a saw through a low-pass that closes quickly. */
function pluck(context: Graph, to: AudioNode, at: number, note: number, peak = 0.25, length = 0.4, bright = 3000): void {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(bright, at);
  filter.frequency.exponentialRampToValueAtTime(300, at + length);
  filter.connect(to);
  tone(context, filter, at, midi(note), { type: 'sawtooth', peak, attack: 0.003, release: length });
}

/** Keys: a triangle and a soft octave above it, struck and dying away. */
function keys(context: Graph, to: AudioNode, at: number, note: number, peak = 0.2, length = 1): void {
  tone(context, to, at, midi(note), { type: 'triangle', peak, attack: 0.004, release: length });
  tone(context, to, at, midi(note + 12), { peak: peak * 0.3, attack: 0.004, release: length * 0.6 });
}

/** A bell, or a mallet: a sine and two partials off the harmonics. */
function bell(context: Graph, to: AudioNode, at: number, note: number, peak = 0.2): void {
  const frequency = midi(note);
  tone(context, to, at, frequency, { peak, attack: 0.002, release: 1.2 });
  tone(context, to, at, frequency * 2.76, { peak: peak * 0.35, attack: 0.002, release: 0.5 });
  tone(context, to, at, frequency * 5.4, { peak: peak * 0.15, attack: 0.002, release: 0.25 });
}

/** A clavinet's stab: squares through a band-pass, short. */
function clav(context: Graph, to: AudioNode, at: number, notes: readonly number[], peak = 0.15): void {
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1200;
  filter.Q.value = 2;
  filter.connect(to);
  for (const note of notes) tone(context, filter, at, midi(note), { type: 'square', peak: peak / notes.length, attack: 0.002, release: 0.12 });
}

/** An 808: a long sine bass, sliding to `glideTo` when asked. */
function sub(context: Graph, to: AudioNode, at: number, note: number, length: number, glideTo?: number, peak = 0.6): void {
  tone(context, to, at, midi(note), { peak, attack: 0.005, release: length, glideTo: glideTo === undefined ? undefined : midi(glideTo) });
  tone(context, to, at, midi(note + 12), { type: 'triangle', peak: peak * 0.15, attack: 0.005, release: length * 0.5 });
}

/** A lead through a low-pass: the edge off a square, the way the synth leads of the eighties had it. */
function soft(context: Graph, to: AudioNode, cutoff: number): AudioNode {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.connect(to);
  return filter;
}

const clap = (context: Graph, to: AudioNode, at: number, peak = 0.3): void => {
  for (const offset of [0, 0.011, 0.023]) hiss(context, to, at + offset, offset === 0.023 ? 0.18 : 0.02, { type: 'bandpass', from: 1500, q: 1.2, peak, attack: 0.001 });
};
const openHat = (context: Graph, to: AudioNode, at: number, peak = 0.1): void => hiss(context, to, at, 0.22, { type: 'highpass', from: 7500, peak, attack: 0.002 });
const shaker = (context: Graph, to: AudioNode, at: number, peak = 0.06): void => hiss(context, to, at, 0.06, { type: 'highpass', from: 6000, peak, attack: 0.01 });
/** A strum: the chord's strings one after another, a hair apart. */
const strum = (context: Graph, to: AudioNode, at: number, notes: readonly number[], peak = 0.16, length = 0.5): void =>
  notes.forEach((note, index) => pluck(context, to, at + index * 0.012, note, peak, length, 2600));

/* The tracks ---------------------------------------------------------------------------------- */

type Line = ReadonlyArray<readonly [number, number, number]>;

const AM_F_C_G = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]];
const CM_AB_FM_G = [[60, 63, 67], [56, 60, 63], [53, 56, 60], [55, 59, 62]];
const DM_BB_F_C = [[62, 65, 69], [58, 62, 65], [65, 69, 72], [60, 64, 67]];
const C_G_AM_F = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]];
const DM_BB_GM_A = [[62, 65, 69], [58, 62, 65], [55, 58, 62], [57, 61, 64]];
const EM7_A7 = [[64, 67, 71, 74], [57, 61, 64, 67]];
const G_D_EM_C = [[67, 71, 74], [62, 66, 69], [64, 67, 71], [60, 64, 67]];

const TRACKS: Record<string, Track> = {
  reggaeton: {
    bpm: 95,
    wet: 0.22,
    bar(c, out, at, index, beat) {
      const notes = AM_F_C_G[index % 4];
      chord(c, out, at, notes, beat * 3.9, { type: 'triangle', peak: 0.1, attack: 0.05, cutoff: 1400 });
      // The dembow: a kick on every beat, the snare a beat and a half apart.
      for (const b of [0, 1, 2, 3]) kick(c, out, at + b * beat, 0.85);
      for (const b of [0.75, 1.5, 2.75, 3.5]) snare(c, out, at + b * beat, 0.22);
      for (let b = 0; b < 4; b += 0.5) hat(c, panned(c, out, 0.3), at + b * beat, 0.05);
      for (const b of [0, 0.75, 1.5, 2, 2.75, 3.5]) sub(c, out, at + b * beat, notes[0] - 24, beat * 0.45, undefined, 0.45);
      const motif: Line = index % 2 === 0
        ? [[0, 76, 0.5], [0.75, 74, 0.25], [1, 72, 0.5], [1.5, 69, 0.5], [2.5, 72, 0.5], [3, 74, 0.75]]
        : [[0, 72, 0.5], [0.75, 71, 0.25], [1, 69, 0.75], [2, 67, 0.5], [2.5, 69, 0.5], [3, 72, 1]];
      for (const [b, note, length] of motif) pluck(c, panned(c, out, -0.2), at + b * beat, note, 0.18, length * beat + 0.15);
    },
  },
  trap: {
    bpm: 140,
    wet: 0.28,
    bar(c, out, at, index, beat) {
      const notes = CM_AB_FM_G[index % 4];
      chord(c, out, at, notes, beat * 3.9, { type: 'sawtooth', peak: 0.07, attack: 0.2, cutoff: 900 });
      kick(c, out, at, 0.9);
      kick(c, out, at + 2.5 * beat, 0.8);
      if (index % 2 === 1) kick(c, out, at + 3.25 * beat, 0.6);
      clap(c, out, at + 2 * beat, 0.32);
      snare(c, out, at + 2 * beat, 0.18);
      // Eighths on the hat, and a roll of sixteenth triplets to close every other bar.
      const roll = index % 2 === 1;
      for (let b = 0; b < (roll ? 3 : 4); b += 0.5) hat(c, panned(c, out, 0.25), at + b * beat, 0.06);
      if (roll) for (let k = 0; k < 6; k += 1) hat(c, panned(c, out, 0.25), at + (3 + k / 6) * beat, 0.04 + k * 0.006);
      sub(c, out, at, notes[0] - 24, beat * 2.2, undefined, 0.6);
      sub(c, out, at + 2.5 * beat, notes[0] - 24, beat * 1.4, notes[0] - 17, 0.5);
      const melody: Line = [[0, 79, 0.5], [0.5, 75, 0.5], [1, 77, 1], [2.5, 75, 0.5], [3, 72, 1]];
      if (index % 2 === 0) for (const [b, note] of melody) bell(c, panned(c, out, -0.25), at + b * beat, note, 0.12);
    },
  },
  house: {
    bpm: 124,
    wet: 0.2,
    bar(c, out, at, index, beat) {
      const notes = DM_BB_F_C[index % 4];
      for (let b = 0; b < 4; b += 1) kick(c, out, at + b * beat, 0.85);
      for (const b of [1, 3]) clap(c, out, at + b * beat, 0.25);
      for (const b of [0.5, 1.5, 2.5, 3.5]) openHat(c, panned(c, out, 0.3), at + b * beat, 0.08);
      for (const b of [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]) hat(c, panned(c, out, -0.3), at + b * beat, 0.03);
      for (const b of [0.5, 1.5, 2.5, 3.5]) tone(c, out, at + b * beat, midi(notes[0] - 24), { type: 'triangle', peak: 0.4, attack: 0.004, release: beat * 0.4 });
      // Piano stabs, off the beat.
      for (const b of [0, 0.75, 1.5, 2.5, 3.25]) for (const note of notes) keys(c, out, at + b * beat, note, 0.07, beat * 0.5);
    },
  },
  synthwave: {
    bpm: 100,
    wet: 0.35,
    bar(c, out, at, index, beat) {
      const notes = AM_F_C_G[index % 4];
      chord(c, out, at, notes, beat * 3.9, { type: 'sawtooth', peak: 0.12, attack: 0.15, cutoff: 1800 });
      // The bass in eighths, the octave in between.
      for (let step = 0; step < 8; step += 1) pluck(c, out, at + step * beat * 0.5, notes[0] - 24 + (step % 2 === 1 ? 12 : 0), 0.22, beat * 0.45, 1400);
      kick(c, out, at, 0.85);
      kick(c, out, at + 2 * beat, 0.85);
      for (const b of [1, 3]) {
        snare(c, out, at + b * beat, 0.3);
        hiss(c, out, at + b * beat, 0.3, { type: 'bandpass', from: 2000, q: 0.6, peak: 0.18, attack: 0.002 });
      }
      for (let b = 0; b < 4; b += 0.5) hat(c, panned(c, out, 0.3), at + b * beat, 0.05);
      const lead = soft(c, panned(c, out, -0.2), 2400);
      const lines: Line[] = [
        [[0, 76, 1], [1, 79, 0.5], [1.5, 76, 0.5], [2, 74, 1.5], [3.5, 72, 0.5]],
        [[0, 72, 1], [1, 74, 0.5], [1.5, 72, 0.5], [2, 69, 2]],
      ];
      for (const [b, note, length] of lines[index % 2]) wobble(c, lead, at + b * beat, midi(note), { type: 'square', peak: 0.09, attack: 0.01, hold: Math.max(0, length * beat - 0.1), release: 0.12, rate: 5, depth: 4 });
    },
  },
  piano: {
    bpm: 70,
    wet: 0.45,
    bar(c, out, at, index, beat) {
      const [low, middle, high] = C_G_AM_F[index % 4];
      const pattern = [low - 12, high - 12, low, middle, high, middle, low, high - 12];
      pattern.forEach((note, step) => keys(c, out, at + step * beat * 0.5, note, 0.13, beat * 1.6));
      tone(c, out, at, midi(low - 24), { peak: 0.25, attack: 0.05, release: beat * 3.8 });
      chord(c, out, at, [low, middle, high], beat * 3.9, { type: 'sine', peak: 0.06, attack: 0.6, cutoff: 1200 });
      if (index % 4 >= 2) keys(c, out, at, index % 4 === 2 ? 76 : 74, 0.12, beat * 3);
    },
  },
  epic: {
    bpm: 80,
    wet: 0.4,
    bar(c, out, at, index, beat) {
      const notes = DM_BB_GM_A[index % 4];
      // Low strings, doubled an octave down.
      chord(c, out, at, notes.map((note) => note - 12), beat * 3.9, { type: 'sawtooth', peak: 0.16, attack: 0.35, cutoff: 1100 });
      chord(c, out, at, notes, beat * 3.9, { type: 'sawtooth', peak: 0.08, attack: 0.5, cutoff: 1600 });
      // The taikos.
      for (const [b, frequency, peak] of [[0, 70, 0.9], [0.75, 80, 0.5], [1.5, 70, 0.7], [2, 60, 0.9], [3, 80, 0.6], [3.5, 70, 0.7]] as const) {
        tom(c, out, at + b * beat, frequency, peak);
        hiss(c, out, at + b * beat, 0.25, { type: 'lowpass', from: 500, peak: peak * 0.35, attack: 0.002 });
      }
      if (index % 2 === 0) for (const note of notes) brass(c, out, at, note, beat * 0.8, 0.16);
    },
  },
  funk: {
    bpm: 105,
    wet: 0.15,
    bar(c, out, at, index, beat) {
      const notes = EM7_A7[index % 2];
      for (const b of [0, 0.75, 2.5]) kick(c, out, at + b * beat, 0.8);
      for (const b of [1, 3]) snare(c, out, at + b * beat, 0.32);
      for (const b of [1.75, 3.25]) snare(c, out, at + b * beat, 0.08);
      for (let b = 0; b < 4; b += 0.25) hat(c, panned(c, out, 0.25), at + b * beat, b % 0.5 === 0 ? 0.06 : 0.03);
      // The bass line, slapped: the root, its octave, the seventh and the fifth.
      const root = notes[0] - 24;
      for (const [b, step] of [[0, 0], [0.75, 0], [1, 12], [1.5, 10], [2, 0], [2.5, 7], [3, 12], [3.5, 10]] as const) pluck(c, out, at + b * beat, root + step, 0.3, beat * 0.3, 1800);
      for (const b of [0.5, 1.25, 2.5, 3.25]) clav(c, panned(c, out, -0.3), at + b * beat, notes, 0.16);
    },
  },
  acoustic: {
    bpm: 115,
    wet: 0.2,
    bar(c, out, at, index, beat) {
      const notes = G_D_EM_C[index % 4];
      // Down, down-up, up-down-up: a strum on the beat goes down the strings, off it up.
      for (const b of [0, 1, 1.5, 2.5, 3, 3.5]) strum(c, panned(c, out, -0.15), at + b * beat, b % 1 === 0 ? notes : [...notes].reverse(), 0.12, beat * 0.7);
      kick(c, out, at, 0.5);
      kick(c, out, at + 2 * beat, 0.5);
      for (const b of [1, 3]) clap(c, out, at + b * beat, 0.18);
      for (let b = 0; b < 4; b += 0.5) shaker(c, panned(c, out, 0.35), at + b * beat, 0.05);
      tone(c, out, at, midi(notes[0] - 24), { type: 'triangle', peak: 0.3, attack: 0.01, release: beat * 1.6 });
      tone(c, out, at + 2 * beat, midi(notes[0] - 17), { type: 'triangle', peak: 0.25, attack: 0.01, release: beat * 1.6 });
      // A whistled tune over four bars.
      const whistle: Line[] = [
        [[0, 79, 1], [1, 81, 0.5], [1.5, 79, 0.5], [2, 76, 1], [3, 74, 1]],
        [[0, 74, 1], [1, 76, 0.5], [1.5, 74, 0.5], [2, 71, 2]],
        [[0, 79, 1], [1, 81, 0.5], [1.5, 79, 0.5], [2, 76, 1], [3, 74, 1]],
        [[0, 76, 1], [1, 74, 1], [2, 71, 1], [3, 67, 1]],
      ];
      for (const [b, note, length] of whistle[index % 4]) wobble(c, panned(c, out, 0.15), at + b * beat, midi(note), { peak: 0.1, attack: 0.03, hold: Math.max(0, length * beat - 0.12), release: 0.1, rate: 5.5, depth: 5 });
    },
  },
};

export const hasTrack = (id: string): boolean => id in TRACKS;

/** How long a track is: the whole phrases of four bars nearest `seconds`. Null for an id not here. */
export function trackSeconds(id: string, seconds: number): number | null {
  const track = TRACKS[id];
  if (!track) return null;
  const bar = (60 / track.bpm) * 4;
  return Math.max(4, Math.round(seconds / bar / 4) * 4) * bar;
}

/** Plays track `id` into `to` twice over, the second time from `loopSeconds`: false when it is not one of these. */
export function playTrack(context: Graph, to: AudioNode, id: string, loopSeconds: number): boolean {
  const track = TRACKS[id];
  if (!track) return false;
  const beat = 60 / track.bpm;
  const bars = Math.round(loopSeconds / (beat * 4));
  const out = room(context, to, 1.6, track.wet);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < bars; index += 1) track.bar(context, out, pass * loopSeconds + index * beat * 4, index, beat);
  }
  return true;
}
