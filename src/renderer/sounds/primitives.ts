/**
 * What every sound of the library is made of (sounds/synth, sounds/effects):
 * oscillators, filtered noise and envelopes in an offline audio graph, as a
 * synthesiser makes them - and a room to ring in, a place in the stereo, a
 * held note, a wobble, a brass voice and a drum kit.
 *
 * Nothing here is random from one render to the next: noise and scatter come
 * from fixed seeds, so a sound is the same every time it is made.
 */

export type Graph = OfflineAudioContext;

/** A sequence of numbers from 0 to 1, the same for the same seed. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** White noise, `seconds` long, as a buffer to play. */
export function noise(context: Graph, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.max(1, Math.round(seconds * context.sampleRate)), context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    data[i] = (seed / 2147483648) * 2 - 1;
  }
  return buffer;
}

/** A gain that rises over `attack` then falls away over `release` from `at`. */
export function envelope(context: Graph, at: number, peak: number, attack: number, release: number, to: AudioNode): GainNode {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + release);
  gain.connect(to);
  return gain;
}

/** A gain that rises over `attack`, holds `hold`, then falls away over `release`: a note held down. */
export function held(context: Graph, at: number, peak: number, attack: number, hold: number, release: number, to: AudioNode): GainNode {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + attack);
  gain.gain.setValueAtTime(Math.max(0.0001, peak), at + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  gain.connect(to);
  return gain;
}

export function tone(context: Graph, to: AudioNode, at: number, frequency: number, options: { type?: OscillatorType; peak?: number; attack?: number; release?: number; glideTo?: number; detune?: number } = {}): void {
  const oscillator = context.createOscillator();
  oscillator.type = options.type ?? 'sine';
  oscillator.frequency.setValueAtTime(frequency, at);
  if (options.detune) oscillator.detune.value = options.detune;
  const release = options.release ?? 0.4;
  if (options.glideTo) oscillator.frequency.exponentialRampToValueAtTime(options.glideTo, at + (options.attack ?? 0.005) + release);
  oscillator.connect(envelope(context, at, options.peak ?? 0.5, options.attack ?? 0.005, release, to));
  oscillator.start(at);
  oscillator.stop(at + (options.attack ?? 0.005) + release + 0.05);
}

/** A burst of filtered noise. */
export function hiss(context: Graph, to: AudioNode, at: number, length: number, options: { type?: BiquadFilterType; from: number; toFrequency?: number; q?: number; peak?: number; attack?: number }): void {
  const source = context.createBufferSource();
  source.buffer = noise(context, length + 0.1);
  const filter = context.createBiquadFilter();
  filter.type = options.type ?? 'bandpass';
  filter.Q.value = options.q ?? 1;
  filter.frequency.setValueAtTime(options.from, at);
  if (options.toFrequency) filter.frequency.exponentialRampToValueAtTime(options.toFrequency, at + length);
  source.connect(filter);
  filter.connect(envelope(context, at, options.peak ?? 0.5, options.attack ?? 0.01, Math.max(0.02, length - (options.attack ?? 0.01)), to));
  source.start(at);
  source.stop(at + length + 0.1);
}

export const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);

/** The drum kit of the music: kick, snare and hat, each a moment of synthesis. */
export const kick = (context: Graph, to: AudioNode, at: number, peak = 0.9): void => tone(context, to, at, 150, { glideTo: 45, peak, release: 0.35 });
export const snare = (context: Graph, to: AudioNode, at: number, peak = 0.35): void => {
  hiss(context, to, at, 0.18, { type: 'highpass', from: 1500, peak });
  tone(context, to, at, 190, { peak: peak * 0.6, release: 0.1 });
};
export const hat = (context: Graph, to: AudioNode, at: number, peak = 0.12): void => hiss(context, to, at, 0.05, { type: 'highpass', from: 7000, peak });
/** A tom: a drum with a pitch, falling. */
export const tom = (context: Graph, to: AudioNode, at: number, frequency: number, peak = 0.7): void => tone(context, to, at, frequency, { glideTo: frequency * 0.6, peak, release: 0.28 });

/** A crash: bright noise ringing away over metal partials that do not sit in a key. */
export function crash(context: Graph, to: AudioNode, at: number, peak = 0.5, length = 1.8): void {
  hiss(context, to, at, length, { type: 'highpass', from: 5000, peak, attack: 0.003 });
  hiss(context, to, at, length * 0.6, { type: 'bandpass', from: 3200, q: 0.7, peak: peak * 0.5, attack: 0.003 });
  const metal = context.createBiquadFilter();
  metal.type = 'highpass';
  metal.frequency.value = 2500;
  metal.connect(to);
  for (const frequency of [541, 803, 1249, 1687, 2213]) tone(context, metal, at, frequency, { type: 'square', peak: peak * 0.05, attack: 0.002, release: length * 0.7 });
}

/** A chord of saws through a low-pass: a pad or a stab. */
export function chord(context: Graph, to: AudioNode, at: number, notes: number[], length: number, options: { peak?: number; attack?: number; cutoff?: number; type?: OscillatorType } = {}): void {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = options.cutoff ?? 1600;
  filter.connect(to);
  for (const note of notes) {
    for (const detune of [-7, 7]) {
      tone(context, filter, at, midi(note), { type: options.type ?? 'sawtooth', peak: (options.peak ?? 0.12) / notes.length, attack: options.attack ?? 0.02, release: length, detune });
    }
  }
}

/**
 * A room to ring in: the sound goes out as it is, and again through a
 * convolver whose impulse is noise dying away over `seconds` - a reverb.
 * Returns where to send the sound.
 */
export function room(context: Graph, to: AudioNode, seconds: number, wet = 0.3): AudioNode {
  const length = Math.max(1, Math.round(seconds * context.sampleRate));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const next = seeded(9001 + channel * 7919);
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) data[i] = (next() * 2 - 1) * (1 - i / length) ** 3;
  }
  const convolver = context.createConvolver();
  convolver.buffer = impulse;
  const input = context.createGain();
  const wetGain = context.createGain();
  wetGain.gain.value = wet;
  input.connect(to);
  input.connect(convolver);
  convolver.connect(wetGain);
  wetGain.connect(to);
  return input;
}

/** A place in the stereo, -1 left to 1 right: where to send a sound to have it there. */
export function panned(context: Graph, to: AudioNode, pan: number): AudioNode {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(to);
  return panner;
}

/** A tone with a wobble in its pitch: `rate` times a second, `depth` Hz either way. */
export function wobble(
  context: Graph,
  to: AudioNode,
  at: number,
  frequency: number,
  options: { type?: OscillatorType; peak?: number; attack?: number; hold?: number; release?: number; rate: number; depth: number; glideTo?: number },
): void {
  const oscillator = context.createOscillator();
  oscillator.type = options.type ?? 'sine';
  const attack = options.attack ?? 0.01;
  const hold = options.hold ?? 0;
  const release = options.release ?? 0.4;
  const end = at + attack + hold + release;
  oscillator.frequency.setValueAtTime(frequency, at);
  if (options.glideTo) oscillator.frequency.exponentialRampToValueAtTime(options.glideTo, end);
  const lfo = context.createOscillator();
  lfo.frequency.value = options.rate;
  const depth = context.createGain();
  depth.gain.value = options.depth;
  lfo.connect(depth);
  depth.connect(oscillator.frequency);
  oscillator.connect(held(context, at, options.peak ?? 0.4, attack, hold, release, to));
  oscillator.start(at);
  lfo.start(at);
  oscillator.stop(end + 0.05);
  lfo.stop(end + 0.05);
}

/** A brass note: two saws through a low-pass that opens as it speaks, then settles. */
export function brass(context: Graph, to: AudioNode, at: number, note: number, length: number, peak = 0.3): void {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.5;
  filter.frequency.setValueAtTime(500, at);
  filter.frequency.linearRampToValueAtTime(3200, at + 0.06);
  filter.frequency.exponentialRampToValueAtTime(1400, at + Math.max(0.1, length));
  filter.connect(to);
  for (const detune of [-6, 6]) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = midi(note);
    oscillator.detune.value = detune;
    oscillator.connect(held(context, at, peak / 2, 0.03, Math.max(0, length - 0.15), 0.12, filter));
    oscillator.start(at);
    oscillator.stop(at + length + 0.1);
  }
}
