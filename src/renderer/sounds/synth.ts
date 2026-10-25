import type { Sound } from './catalog';
import { playMoreEffect } from './effects';
import { hasTrack, playTrack, trackSeconds } from './music';
import { chord, hat, hiss, kick, midi, snare, tone, type Graph } from './primitives';

/**
 * The sound library's sounds, made: each one played into an offline audio
 * graph - oscillators, filtered noise and envelopes, as a synthesiser makes
 * them (sounds/primitives) - and written out as a 16-bit stereo WAV. The
 * music is a few bars of drums, bass and chords that loop seamlessly (their
 * length is a whole number of bars), so a clip of it can be stretched under
 * any edit.
 */

export const SOUND_RATE = 44100;

interface Song {
  bpm: number;
  progression: number[][];
  bass: boolean;
  drums: 'four' | 'lofi' | 'none' | 'soft';
  pad: { attack: number; cutoff: number; peak: number; type?: OscillatorType };
  arp?: boolean;
}

const SONGS: Record<string, Song> = {
  upbeat: { bpm: 120, progression: [[60, 64, 67], [57, 60, 64], [65, 69, 72], [67, 71, 74]], bass: true, drums: 'four', pad: { attack: 0.01, cutoff: 2400, peak: 0.16 } },
  lofi: { bpm: 80, progression: [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71], [57, 60, 64, 67]], bass: true, drums: 'lofi', pad: { attack: 0.08, cutoff: 900, peak: 0.18, type: 'triangle' } },
  cinematic: { bpm: 60, progression: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass: true, drums: 'none', pad: { attack: 1.2, cutoff: 1200, peak: 0.22 } },
  corporate: { bpm: 110, progression: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], bass: true, drums: 'soft', pad: { attack: 0.02, cutoff: 3000, peak: 0.1, type: 'triangle' }, arp: true },
  chill: { bpm: 90, progression: [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]], bass: true, drums: 'soft', pad: { attack: 0.4, cutoff: 1100, peak: 0.18, type: 'triangle' } },
};

/** How many bars of a song make about `seconds`: whole phrases of four, so the loop ends where it began. */
function barsOf(song: Song, seconds: number): number {
  return Math.max(4, Math.round(seconds / ((60 / song.bpm) * 4) / 4) * 4);
}

/** How long a sound really is: a song is a whole number of bars. */
export function soundSeconds(sound: Sound): number {
  const song = sound.category === 'music' ? SONGS[sound.id] : undefined;
  if (song) return barsOf(song, sound.seconds) * (60 / song.bpm) * 4;
  return (sound.category === 'music' ? trackSeconds(sound.id, sound.seconds) : null) ?? sound.seconds;
}

/** The last `frames` of a buffer, as a buffer of its own: a track's second pass. */
function secondPass(buffer: AudioBuffer, frames: number): AudioBuffer {
  const pass = new AudioBuffer({ length: frames, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    pass.getChannelData(channel).set(buffer.getChannelData(channel).subarray(buffer.length - frames));
  }
  return pass;
}

/** Whole bars of a song filling about `seconds`: a loop that ends where it began. */
function playSong(context: Graph, to: AudioNode, song: Song, seconds: number): void {
  const beat = 60 / song.bpm;
  const bar = beat * 4;
  const bars = barsOf(song, seconds);
  for (let index = 0; index < bars; index += 1) {
    const at = index * bar;
    const notes = song.progression[index % song.progression.length];
    chord(context, to, at, notes, bar * 0.95, song.pad);
    if (song.bass) {
      const root = notes[0] - 24;
      for (let b = 0; b < 4; b += song.drums === 'none' ? 4 : 2) tone(context, to, at + b * beat, midi(root), { type: 'triangle', peak: 0.35, release: beat * (song.drums === 'none' ? 3.8 : 1.6) });
    }
    if (song.arp) for (let step = 0; step < 8; step += 1) tone(context, to, at + step * beat * 0.5, midi(notes[step % notes.length] + 12), { type: 'sine', peak: 0.08, release: 0.25 });
    for (let b = 0; b < 4; b += 1) {
      const time = at + b * beat;
      if (song.drums === 'four') {
        kick(context, to, time);
        hat(context, to, time + beat / 2);
        if (b % 2 === 1) snare(context, to, time);
      } else if (song.drums === 'lofi') {
        if (b === 0) kick(context, to, time, 0.7);
        if (b === 2) kick(context, to, time + beat / 2, 0.6);
        if (b % 2 === 1) snare(context, to, time, 0.22);
        hat(context, to, time, 0.06);
        hat(context, to, time + beat * 0.55, 0.05);
      } else if (song.drums === 'soft') {
        if (b % 2 === 0) kick(context, to, time, 0.5);
        hat(context, to, time + beat / 2, 0.06);
        if (b === 3) snare(context, to, time, 0.12);
      }
    }
  }
}

/** One effect, played from the start of the graph into `to`. */
function playEffect(context: Graph, to: AudioNode, id: string): void {
  switch (id) {
    case 'whoosh':
      hiss(context, to, 0, 1.1, { from: 300, toFrequency: 4000, q: 2, peak: 0.7, attack: 0.5 });
      break;
    case 'swoosh':
      hiss(context, to, 0, 0.5, { from: 2500, toFrequency: 500, q: 3, peak: 0.6, attack: 0.08 });
      break;
    case 'pop':
      tone(context, to, 0, 900, { glideTo: 250, peak: 0.7, release: 0.12 });
      break;
    case 'click':
      hiss(context, to, 0, 0.03, { type: 'highpass', from: 3000, peak: 0.8, attack: 0.001 });
      tone(context, to, 0, 2000, { peak: 0.3, release: 0.03 });
      break;
    case 'ding':
      for (const [frequency, peak] of [[1318.5, 0.5], [2637, 0.15], [3955.5, 0.08]] as const) tone(context, to, 0, frequency, { peak, release: 1.8 });
      break;
    case 'chime':
      [76, 79, 83, 88].forEach((note, index) => tone(context, to, index * 0.12, midi(note), { peak: 0.35, release: 1.2 }));
      break;
    case 'success':
      [72, 76, 79, 84].forEach((note, index) => tone(context, to, index * 0.1, midi(note), { type: 'triangle', peak: 0.4, release: 0.8 }));
      break;
    case 'error':
      tone(context, to, 0, 180, { type: 'square', peak: 0.25, release: 0.25 });
      tone(context, to, 0.3, 140, { type: 'square', peak: 0.25, release: 0.3 });
      break;
    case 'boom':
      tone(context, to, 0, 90, { glideTo: 30, peak: 1, release: 2.2 });
      hiss(context, to, 0, 1.5, { type: 'lowpass', from: 600, toFrequency: 80, peak: 0.6 });
      break;
    case 'riser':
      hiss(context, to, 0, 2.9, { from: 200, toFrequency: 6000, q: 1.5, peak: 0.5, attack: 2.6 });
      tone(context, to, 0, 110, { type: 'sawtooth', glideTo: 880, peak: 0.18, attack: 2.6, release: 0.2 });
      break;
    case 'laser':
      tone(context, to, 0, 2400, { type: 'sawtooth', glideTo: 200, peak: 0.3, release: 0.5 });
      break;
    case 'shutter':
      hiss(context, to, 0, 0.06, { type: 'highpass', from: 2000, peak: 0.8, attack: 0.002 });
      hiss(context, to, 0.12, 0.08, { type: 'highpass', from: 1500, peak: 0.6, attack: 0.002 });
      break;
    case 'typewriter':
      for (let i = 0; i < 12; i += 1) hiss(context, to, i * 0.14 + (i % 3) * 0.02, 0.03, { type: 'bandpass', from: 2500 + (i % 4) * 300, q: 2, peak: 0.6, attack: 0.001 });
      tone(context, to, 1.75, 1760, { peak: 0.3, release: 0.25 });
      break;
    case 'heartbeat':
      for (const at of [0, 0.25, 1, 1.25]) tone(context, to, at, 70, { glideTo: 45, peak: at % 1 === 0 ? 0.9 : 0.6, release: 0.2 });
      break;
    default:
      // The rest of the effects, block 7b's (sounds/effects).
      playMoreEffect(context, to, id);
      break;
  }
}

/** A sound rendered: its samples, stereo at SOUND_RATE. */
export async function renderSound(sound: Sound): Promise<AudioBuffer> {
  const seconds = soundSeconds(sound);
  // A track of sounds/music is played twice over and its second pass kept:
  // its loop, with the room's ring from its end carried into its start.
  const twice = sound.category === 'music' && hasTrack(sound.id);
  const frames = Math.round(seconds * SOUND_RATE);
  const context = new OfflineAudioContext(2, twice ? frames * 2 : frames, SOUND_RATE);
  const master = context.createGain();
  // A little headroom, and a gentle limiter so nothing clips.
  master.gain.value = sound.category === 'music' ? 0.7 : 0.85;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 12;
  master.connect(limiter);
  limiter.connect(context.destination);
  if (sound.category === 'music') {
    const song = SONGS[sound.id];
    if (song) playSong(context, master, song, sound.seconds);
    else playTrack(context, master, sound.id, seconds);
  } else {
    playEffect(context, master, sound.id);
  }
  const whole = await context.startRendering();
  const rendered = twice ? secondPass(whole, frames) : whole;
  // Every sound to the same peak, -3 dBFS: a laser and a boom side by side in the list should be as loud.
  let peak = 0;
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    for (const value of rendered.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
  }
  const gain = peak > 0 ? Math.min(20, 10 ** (-3 / 20) / peak) : 1;
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    const data = rendered.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) data[i] *= gain;
  }
  return rendered;
}

/** 16-bit PCM WAV of a buffer. */
export function wavOf(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const out = new DataView(new ArrayBuffer(bytes));
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) out.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  out.setUint32(4, bytes - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, data[channel][i]));
      out.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out.buffer;
}
