import { envelope, hat, hiss, kick, midi, noise, panned, room, seeded, tone, type Graph } from './primitives';

/**
 * The third set of sound effects: a tape stopping and a record braking, a
 * toggle and an unlock, a cork and a cuckoo, a clap and a shaker, a door and
 * torn paper, birds and crickets and waves and a fire.
 *
 * Made here by synthesis, like the first two sets (sounds/synth,
 * sounds/effects), so every one is free to use anywhere with nothing
 * downloaded and no licence to read. The dispatch is a chain: synth tries its
 * own, then effects, then these, so a new set is a new file and nothing moves.
 */

/** A pitch sliding over `length` while it dies: a tape stopping, a record braking. */
function slide(context: Graph, to: AudioNode, at: number, from: number, toFrequency: number, length: number, peak = 0.5): void {
  tone(context, to, at, from, { type: 'sawtooth', glideTo: toFrequency, peak, attack: 0.005, release: length });
  // The hiss of the medium goes down with it, which is what says "tape" and not "synth".
  hiss(context, to, at, length, { type: 'bandpass', from: from * 2, toFrequency: toFrequency * 2, q: 1.2, peak: peak * 0.25, attack: 0.01 });
}

/** A short band of noise: a hand, a shaker, a step on gravel. */
function smack(context: Graph, to: AudioNode, at: number, centre: number, length: number, peak: number): void {
  hiss(context, to, at, length, { type: 'bandpass', from: centre, q: 1.4, peak, attack: 0.001 });
}

/** Many small bursts spread over `length`, each its own place and brightness: rain on a fire, crickets, a crowd. */
function scatter(
  context: Graph,
  to: AudioNode,
  length: number,
  count: number,
  seed: number,
  each: (at: number, pan: AudioNode, random: () => number) => void,
): void {
  const random = seeded(seed);
  for (let index = 0; index < count; index += 1) each(random() * length, panned(context, to, random() * 1.6 - 0.8), random);
}

/** Plays effect `id` into `to` from the start; false when it is not one of these. */
export function playExtraEffect(context: Graph, to: AudioNode, id: string): boolean {
  switch (id) {
    /* Transitions ------------------------------------------------------------ */
    case 'tapeStop':
      // The reel losing its grip: a fast fall, then the last of it dragging.
      slide(context, to, 0, 440, 60, 0.7, 0.55);
      return true;
    case 'vinylBrake':
      slide(context, to, 0, 220, 30, 1.1, 0.5);
      hiss(context, to, 0, 1.1, { type: 'lowpass', from: 1800, toFrequency: 300, q: 0.7, peak: 0.2, attack: 0.02 });
      return true;
    case 'reverseWhoosh': {
      // A whoosh played backwards: it arrives out of nothing and cuts off.
      const source = context.createBufferSource();
      source.buffer = noise(context, 1.3);
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.9;
      filter.frequency.setValueAtTime(600, 0);
      filter.frequency.exponentialRampToValueAtTime(5000, 1.15);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, 0);
      gain.gain.exponentialRampToValueAtTime(0.75, 1.12);
      gain.gain.linearRampToValueAtTime(0, 1.2);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(to);
      source.start(0);
      source.stop(1.25);
      return true;
    }
    case 'riserTight':
      // A short riser for a cut on the beat: a rising tone and a rising hiss together.
      tone(context, to, 0, 220, { type: 'sawtooth', glideTo: 1760, peak: 0.35, attack: 0.02, release: 1.4 });
      hiss(context, to, 0, 1.4, { type: 'highpass', from: 800, toFrequency: 7000, q: 0.8, peak: 0.45, attack: 0.05 });
      return true;
    case 'glitchRise':
      // Stuttered noise that climbs: the digital cousin of a riser.
      for (let index = 0; index < 26; index += 1) {
        const at = index * 0.055;
        smack(context, to, at, 700 + index * 260, 0.03, 0.2 + index * 0.016);
      }
      tone(context, to, 1.3, 1200, { peak: 0.3, release: 0.2 });
      return true;

    /* The interface ---------------------------------------------------------- */
    case 'toggle':
      // Two tiny taps, the second brighter: a switch going over.
      tone(context, to, 0, 900, { peak: 0.4, attack: 0.001, release: 0.03 });
      tone(context, to, 0.055, 1400, { peak: 0.35, attack: 0.001, release: 0.04 });
      return true;
    case 'unlock':
      tone(context, to, 0, 660, { peak: 0.35, release: 0.08 });
      tone(context, to, 0.09, 880, { peak: 0.35, release: 0.1 });
      tone(context, to, 0.18, 1320, { peak: 0.4, release: 0.3 });
      return true;
    case 'levelUp':
      // A major arpeggio up, each note a little louder: the reward sound.
      [60, 64, 67, 72, 76].forEach((note, index) => tone(context, room(context, to, 0.8, 0.25), index * 0.09, midi(note), { type: 'triangle', peak: 0.26 + index * 0.03, release: 0.3 }));
      return true;
    case 'keyTap':
      // One key of a soft keyboard, not the typewriter's whole line.
      smack(context, to, 0, 2600, 0.018, 0.5);
      tone(context, to, 0.004, 320, { peak: 0.22, attack: 0.001, release: 0.04 });
      return true;
    case 'swipeUp':
      hiss(context, to, 0, 0.26, { type: 'bandpass', from: 900, toFrequency: 4800, q: 1.8, peak: 0.55, attack: 0.02 });
      return true;

    /* The cartoon ------------------------------------------------------------ */
    case 'squeak':
      // A rubber squeak: a high tone bent up and down fast.
      tone(context, to, 0, 1100, { type: 'square', glideTo: 2300, peak: 0.22, attack: 0.01, release: 0.12 });
      tone(context, to, 0.13, 2300, { type: 'square', glideTo: 1200, peak: 0.2, attack: 0.01, release: 0.14 });
      return true;
    case 'popCork':
      // The pop, then the air behind it.
      tone(context, to, 0, 180, { glideTo: 900, peak: 0.85, attack: 0.001, release: 0.06 });
      hiss(context, to, 0.05, 0.25, { type: 'highpass', from: 2000, peak: 0.18, attack: 0.01 });
      return true;
    case 'cuckoo':
      // Two notes a third apart, twice: the clock.
      [0, 0.75].forEach((at) => {
        tone(context, room(context, to, 1.2, 0.3), at, midi(79), { type: 'triangle', peak: 0.3, release: 0.22 });
        tone(context, room(context, to, 1.2, 0.3), at + 0.26, midi(75), { type: 'triangle', peak: 0.28, release: 0.3 });
      });
      return true;
    case 'springWobble':
      // A spring let go: the pitch wobbles while the whole thing dies away.
      for (let index = 0; index < 14; index += 1) {
        const at = index * 0.07;
        const bend = index % 2 === 0 ? 1 : 0.6;
        tone(context, to, at, 300 * bend + index * 20, { type: 'square', peak: 0.3 * (1 - index / 15), attack: 0.002, release: 0.06 });
      }
      return true;

    /* Drums ------------------------------------------------------------------ */
    case 'clap':
      // Four hands a hair apart, then the room: one hand alone sounds like a click.
      [0, 0.012, 0.026, 0.045].forEach((at, index) => smack(context, room(context, to, 0.5, 0.35), at, 1500, 0.02, 0.6 - index * 0.1));
      return true;
    case 'shaker':
      for (let index = 0; index < 8; index += 1) smack(context, to, index * 0.125, 6000, 0.035, index % 2 === 0 ? 0.3 : 0.16);
      return true;
    case 'hiHatRun':
      for (let index = 0; index < 16; index += 1) hat(context, to, index * 0.0625, index % 4 === 0 ? 0.2 : 0.09);
      return true;
    case 'kickDrop':
      // A kick with the floor falling out from under it.
      kick(context, to, 0, 1);
      tone(context, to, 0.05, 90, { glideTo: 28, peak: 0.8, attack: 0.01, release: 1.3 });
      return true;

    /* Every day -------------------------------------------------------------- */
    case 'doorClose':
      smack(context, room(context, to, 0.7, 0.3), 0, 160, 0.09, 0.8);
      tone(context, to, 0.02, 70, { glideTo: 45, peak: 0.5, release: 0.3 });
      // The latch, after the slam.
      tone(context, to, 0.18, 1800, { peak: 0.2, attack: 0.001, release: 0.05 });
      return true;
    case 'paperRip':
      // Noise torn in bursts that get faster: one long hiss sounds like steam.
      for (let index = 0; index < 22; index += 1) smack(context, to, index * index * 0.0022, 3200 + (index % 3) * 900, 0.02, 0.34 - index * 0.008);
      return true;
    case 'glassClink':
      [1850, 2770].forEach((frequency, index) => tone(context, room(context, to, 1.4, 0.4), index * 0.008, frequency, { peak: 0.3 - index * 0.08, attack: 0.001, release: 1.1 }));
      return true;
    case 'elevatorDing':
      tone(context, room(context, to, 1.6, 0.35), 0, midi(84), { type: 'triangle', peak: 0.45, attack: 0.002, release: 1.4 });
      return true;

    /* Nature ----------------------------------------------------------------- */
    case 'birds':
      // Each call is two or three chirps, bent up, somewhere in the stereo.
      scatter(context, room(context, to, 1.2, 0.25), 3.6, 14, 23, (at, pan, random) => {
        const chirps = 2 + Math.round(random());
        for (let index = 0; index < chirps; index += 1) {
          const base = 2600 + random() * 1800;
          tone(context, pan, at + index * 0.07, base, { glideTo: base * 1.5, peak: 0.1 + random() * 0.12, attack: 0.004, release: 0.05 });
        }
      });
      return true;
    case 'crickets':
      // A cricket is a burst of fast clicks, and they answer each other.
      scatter(context, to, 3.8, 40, 31, (at, pan, random) => {
        for (let index = 0; index < 4; index += 1) smack(context, pan, at + index * 0.014, 4400 + random() * 1200, 0.008, 0.06 + random() * 0.07);
      });
      return true;
    case 'waves':
      // Three swells, each noise rising and falling with the water going out after it.
      for (let index = 0; index < 3; index += 1) {
        const at = index * 1.6;
        const source = context.createBufferSource();
        source.buffer = noise(context, 1.7);
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(500, at);
        filter.frequency.linearRampToValueAtTime(2200, at + 0.6);
        filter.frequency.linearRampToValueAtTime(700, at + 1.6);
        const gain = envelope(context, at, 0.55, 0.6, 1, to);
        source.connect(filter);
        filter.connect(gain);
        source.start(at);
        source.stop(at + 1.7);
      }
      return true;
    case 'fireCrackle': {
      // The bed of the fire, and the crackles over it.
      hiss(context, to, 0, 4, { type: 'lowpass', from: 900, q: 0.6, peak: 0.22, attack: 0.1 });
      scatter(context, to, 3.9, 90, 41, (at, pan, random) => smack(context, pan, at, 1800 + random() * 2600, 0.012, 0.08 + random() * 0.16));
      return true;
    }

    default:
      return false;
  }
}
