import { brass, crash, envelope, held, hiss, midi, noise, panned, room, seeded, snare, tom, tone, wobble, type Graph } from './primitives';
import { playExtraEffect } from './extraEffects';

/**
 * The sound effects added beside the first fourteen (block 7b): applause and
 * a drum roll, a record scratch and a glitch, coins and bubbles, thunder,
 * wind and rain, a siren and a ringing phone, the cartoon's boing and slide
 * whistle, a game's power-up and its game over - each made here by
 * synthesis, as the first ones are (sounds/synth), and as free to use.
 */

/** Noise through a band-pass whose centre follows `curve` (Hz) over `length`: wind, a scratch. */
function sweptNoise(context: Graph, to: AudioNode, at: number, length: number, curve: number[], options: { q?: number; gain: number[] }): void {
  const source = context.createBufferSource();
  source.buffer = noise(context, length + 0.1);
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = options.q ?? 1;
  filter.frequency.setValueCurveAtTime(Float32Array.from(curve), at, length);
  const gain = context.createGain();
  gain.gain.setValueCurveAtTime(Float32Array.from(options.gain), at, length);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(to);
  source.start(at);
  source.stop(at + length + 0.05);
}

/** Two notes at once, `rate` bursts a second: a telephone's ring. */
function ring(context: Graph, to: AudioNode, at: number, length: number): void {
  for (let t = 0; t < length; t += 0.05) {
    for (const frequency of [440, 480]) tone(context, to, at + t, frequency, { peak: 0.22, attack: 0.004, release: 0.026 });
  }
}

/** Plays effect `id` into `to` from the start; false when it is not one of these. */
export function playMoreEffect(context: Graph, to: AudioNode, id: string): boolean {
  switch (id) {
    /* Transitions ------------------------------------------------------------ */
    case 'swipe':
      hiss(context, to, 0, 0.3, { from: 1200, toFrequency: 6000, q: 1.6, peak: 0.6, attack: 0.03 });
      return true;
    case 'reverseCymbal': {
      // A crash played backwards: it swells out of nothing and stops dead.
      const source = context.createBufferSource();
      source.buffer = noise(context, 2.1);
      const filter = context.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(2500, 0);
      filter.frequency.exponentialRampToValueAtTime(6000, 1.95);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, 0);
      gain.gain.exponentialRampToValueAtTime(0.8, 1.92);
      gain.gain.linearRampToValueAtTime(0, 1.97);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(to);
      source.start(0);
      source.stop(2.05);
      return true;
    }
    case 'impact': {
      const hall = room(context, to, 1.4, 0.45);
      tone(context, hall, 0, 85, { glideTo: 30, peak: 1, attack: 0.003, release: 1.2 });
      hiss(context, hall, 0, 0.45, { type: 'lowpass', from: 2400, toFrequency: 200, peak: 0.7, attack: 0.002 });
      hiss(context, hall, 0, 0.08, { type: 'highpass', from: 3000, peak: 0.5, attack: 0.001 });
      return true;
    }
    case 'subDrop':
      tone(context, to, 0, 110, { glideTo: 28, peak: 1, attack: 0.01, release: 1.85 });
      return true;

    /* Interface and alerts ------------------------------------------------------ */
    case 'notification': {
      const space = room(context, to, 0.7, 0.25);
      tone(context, space, 0, midi(81), { peak: 0.45, release: 0.45 });
      tone(context, space, 0, midi(93), { type: 'triangle', peak: 0.08, release: 0.3 });
      tone(context, space, 0.14, midi(88), { peak: 0.45, release: 0.6 });
      tone(context, space, 0.14, midi(100), { type: 'triangle', peak: 0.08, release: 0.4 });
      return true;
    }
    case 'bubble':
      tone(context, to, 0, 280, { glideTo: 1150, peak: 0.5, attack: 0.004, release: 0.12 });
      tone(context, to, 0.2, 420, { glideTo: 1600, peak: 0.35, attack: 0.004, release: 0.1 });
      return true;
    case 'coin':
      tone(context, to, 0, 987.77, { type: 'square', peak: 0.2, attack: 0.002, release: 0.07 });
      tone(context, to, 0.075, 1318.51, { type: 'square', peak: 0.2, attack: 0.002, release: 0.45 });
      return true;
    case 'countdown':
      for (const at of [0, 1, 2]) tone(context, to, at, 880, { type: 'triangle', peak: 0.5, attack: 0.004, release: 0.16 });
      wobble(context, to, 3, 1760, { type: 'triangle', peak: 0.5, attack: 0.004, hold: 0.45, release: 0.2, rate: 0, depth: 0 });
      return true;
    case 'alarm':
      for (let index = 0; index < 10; index += 1) {
        const oscillator = context.createOscillator();
        oscillator.type = 'square';
        oscillator.frequency.value = 1000;
        oscillator.connect(held(context, index * 0.2, 0.22, 0.004, 0.11, 0.01, to));
        oscillator.start(index * 0.2);
        oscillator.stop(index * 0.2 + 0.15);
      }
      return true;

    /* Cartoon and games ------------------------------------------------------------ */
    case 'boing': {
      // A spring let go: a wobble that fades as the pitch climbs.
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(150, 0);
      oscillator.frequency.exponentialRampToValueAtTime(330, 0.6);
      const lfo = context.createOscillator();
      lfo.frequency.value = 14;
      const depth = context.createGain();
      depth.gain.setValueAtTime(90, 0);
      depth.gain.exponentialRampToValueAtTime(2, 0.7);
      lfo.connect(depth);
      depth.connect(oscillator.frequency);
      oscillator.connect(envelope(context, 0, 0.6, 0.005, 0.7, to));
      oscillator.start(0);
      lfo.start(0);
      oscillator.stop(0.78);
      lfo.stop(0.78);
      return true;
    }
    case 'slideWhistle': {
      const oscillator = context.createOscillator();
      oscillator.frequency.setValueAtTime(600, 0);
      oscillator.frequency.exponentialRampToValueAtTime(2200, 0.5);
      oscillator.frequency.exponentialRampToValueAtTime(900, 1.1);
      const lfo = context.createOscillator();
      lfo.frequency.value = 6;
      const depth = context.createGain();
      depth.gain.value = 18;
      lfo.connect(depth);
      depth.connect(oscillator.frequency);
      oscillator.connect(held(context, 0, 0.45, 0.04, 0.95, 0.12, to));
      oscillator.start(0);
      lfo.start(0);
      oscillator.stop(1.2);
      lfo.stop(1.2);
      return true;
    }
    case 'powerUp':
      [60, 64, 67, 72, 76, 79, 84].forEach((note, index) => tone(context, to, index * 0.06, midi(note), { type: 'square', peak: 0.16, attack: 0.002, release: index === 6 ? 0.5 : 0.08 }));
      return true;
    case 'gameOver':
      [67, 66, 65, 64].forEach((note, index) => tone(context, to, index * 0.24, midi(note), { type: 'square', peak: 0.18, attack: 0.004, release: 0.2 }));
      wobble(context, to, 0.96, midi(60), { type: 'square', peak: 0.18, attack: 0.004, hold: 0.45, release: 0.3, rate: 5, depth: 6 });
      return true;
    case 'jump':
      tone(context, to, 0, 220, { type: 'square', glideTo: 880, peak: 0.2, attack: 0.003, release: 0.22 });
      return true;
    case 'magic': {
      const sparkle = room(context, to, 1.1, 0.5);
      const random = seeded(31);
      const scale = [84, 86, 88, 91, 93, 96, 98];
      for (let index = 0; index < 24; index += 1) {
        const at = index * 0.05 + random() * 0.03;
        tone(context, panned(context, sparkle, random() * 1.6 - 0.8), at, midi(scale[Math.floor(random() * scale.length)]), { peak: 0.12, attack: 0.003, release: 0.28 });
      }
      hiss(context, sparkle, 0, 1.3, { type: 'highpass', from: 6000, toFrequency: 10000, peak: 0.12, attack: 0.6 });
      return true;
    }
    case 'sadTrombone': {
      // Wah, wah, wah, waaah: four steps down, the last held and shaking.
      const space = room(context, to, 0.6, 0.2);
      [62, 61, 60].forEach((note, index) => brass(context, space, index * 0.42, note - 12, 0.36, 0.4));
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1300;
      filter.connect(space);
      wobble(context, filter, 1.26, midi(47), { type: 'sawtooth', peak: 0.3, attack: 0.04, hold: 0.6, release: 0.3, rate: 5.5, depth: 5 });
      return true;
    }

    /* Drums and party -------------------------------------------------------------- */
    case 'drumroll':
      for (let at = 0; at < 2.1; at += 0.055) snare(context, to, at, 0.05 + 0.2 * (at / 2.1));
      crash(context, room(context, to, 1, 0.25), 2.12, 0.5, 1.4);
      return true;
    case 'cymbal':
      crash(context, room(context, to, 1.2, 0.3), 0, 0.6, 2.2);
      return true;
    case 'rimshot':
      tom(context, to, 0, 210, 0.7);
      tom(context, to, 0.17, 160, 0.7);
      snare(context, to, 0.42, 0.35);
      hiss(context, to, 0.42, 1.1, { type: 'highpass', from: 6500, peak: 0.45, attack: 0.002 });
      return true;
    case 'scratch':
      sweptNoise(context, to, 0, 0.75, [500, 2600, 400, 3000, 600, 2200, 350, 1800], { q: 4, gain: [0, 0.9, 0.3, 0.9, 0.2, 0.8, 0.3, 0] });
      return true;
    case 'fanfare': {
      const hall = room(context, to, 1.3, 0.35);
      [[67, 0, 0.14], [72, 0.15, 0.14], [76, 0.3, 0.14], [79, 0.45, 0.3]].forEach(([note, at, length]) => brass(context, hall, at, note, length, 0.32));
      for (const note of [72, 76, 79, 84]) brass(context, hall, 0.8, note, 1.4, 0.22);
      return true;
    }
    case 'applause': {
      // Hundreds of claps across the stereo, swelling in and dying away.
      const hall = room(context, to, 0.8, 0.3);
      const random = seeded(42);
      for (let index = 0; index < 280; index += 1) {
        const at = random() * 2.8;
        const swell = at < 0.4 ? at / 0.4 : at > 2.2 ? (2.8 - at) / 0.6 : 1;
        hiss(context, panned(context, hall, random() * 1.6 - 0.8), at, 0.035, { type: 'bandpass', from: 1100 + random() * 1600, q: 1.3, peak: 0.25 * swell * (0.6 + random() * 0.4), attack: 0.002 });
      }
      return true;
    }
    case 'glitch': {
      const random = seeded(7);
      for (let index = 0; index < 14; index += 1) {
        const at = index * 0.05 + (random() < 0.3 ? 0.02 : 0);
        tone(context, to, at, 200 + random() * 2200, { type: 'square', peak: 0.2, attack: 0.001, release: 0.025 + random() * 0.03 });
        if (random() < 0.4) hiss(context, to, at, 0.03, { type: 'highpass', from: 4000, peak: 0.3, attack: 0.001 });
      }
      return true;
    }

    /* Everyday ----------------------------------------------------------------------- */
    case 'cashRegister': {
      const shop = room(context, to, 0.5, 0.2);
      hiss(context, shop, 0, 0.12, { type: 'lowpass', from: 900, peak: 0.7, attack: 0.002 });
      hiss(context, shop, 0.08, 0.05, { type: 'highpass', from: 2500, peak: 0.6, attack: 0.001 });
      for (const [frequency, peak] of [[2637, 0.4], [3520, 0.25], [4186, 0.15], [1318.5, 0.2]] as const) tone(context, shop, 0.22, frequency, { peak, release: 1.0 });
      return true;
    }
    case 'knock': {
      const door = room(context, to, 0.4, 0.25);
      for (const at of [0, 0.22, 0.44]) {
        tone(context, door, at, 130, { glideTo: 80, peak: 0.8, attack: 0.002, release: 0.12 });
        hiss(context, door, at, 0.05, { type: 'lowpass', from: 1100, peak: 0.5, attack: 0.001 });
      }
      return true;
    }
    case 'tick':
      [0, 0.5, 1, 1.5].forEach((at, index) => {
        const high = index % 2 === 0;
        hiss(context, to, at, 0.02, { type: 'bandpass', from: high ? 3200 : 2100, q: 3, peak: 0.6, attack: 0.001 });
        tone(context, to, at, high ? 2400 : 1600, { peak: 0.2, attack: 0.001, release: 0.03 });
      });
      return true;
    case 'phoneRing':
      ring(context, to, 0, 1);
      ring(context, to, 1.4, 1);
      return true;
    case 'siren': {
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 900;
      const lfo = context.createOscillator();
      lfo.frequency.value = 0.7;
      const depth = context.createGain();
      depth.gain.value = 320;
      lfo.connect(depth);
      depth.connect(oscillator.frequency);
      oscillator.connect(held(context, 0, 0.4, 0.2, 2.5, 0.25, room(context, to, 0.9, 0.3)));
      oscillator.start(0);
      lfo.start(0);
      oscillator.stop(3);
      lfo.stop(3);
      return true;
    }

    /* Nature ------------------------------------------------------------------------- */
    case 'thunder': {
      const sky = room(context, to, 2, 0.4);
      hiss(context, sky, 0, 0.3, { type: 'highpass', from: 1400, peak: 0.6, attack: 0.004 });
      const random = seeded(5);
      for (let index = 0; index < 7; index += 1) {
        const at = 0.1 + index * 0.35 + random() * 0.2;
        hiss(context, sky, at, 1.4, { type: 'lowpass', from: 180 + random() * 160, peak: 0.9 * (1 - index / 9), attack: 0.08 });
      }
      return true;
    }
    case 'wind':
      sweptNoise(context, to, 0, 4, [320, 700, 450, 950, 420, 650, 380], { q: 0.8, gain: [0, 0.6, 0.8, 0.55, 0.75, 0.5, 0] });
      return true;
    case 'rain': {
      sweptNoise(context, to, 0, 4, [2400, 2600, 2300, 2500], { q: 0.4, gain: [0, 0.3, 0.32, 0.3, 0] });
      const random = seeded(11);
      for (let index = 0; index < 320; index += 1) {
        const at = random() * 3.8;
        hiss(context, panned(context, to, random() * 1.8 - 0.9), at, 0.012, { type: 'highpass', from: 3000 + random() * 3000, peak: 0.05 + random() * 0.12, attack: 0.001 });
      }
      return true;
    }
    case 'waterDrop':
      tone(context, room(context, to, 0.5, 0.3), 0, 600, { glideTo: 1900, peak: 0.6, attack: 0.002, release: 0.14 });
      return true;
    default:
      // The third set (sounds/extraEffects): the chain carries on there.
      return playExtraEffect(context, to, id);
  }
}
