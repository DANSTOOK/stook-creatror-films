import type { Clip, ProjectState } from '@shared/types';
import { clamp } from '@shared/utils/math';

/**
 * Web Audio subsystem.
 *
 * One `AudioContext` drives every audio-bearing clip. Each clip gets its own
 * strip - gain -> 3-band EQ -> panner - feeding a master bus, which mirrors the
 * mixer layout the inspector exposes.
 */

export interface EqSettings {
  low: number; // dB at 120 Hz (low shelf)
  mid: number; // dB at 1 kHz (peaking)
  high: number; // dB at 8 kHz (high shelf)
}

export const NEUTRAL_EQ: EqSettings = { low: 0, mid: 0, high: 0 };

interface ClipStrip {
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  panner: StereoPannerNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  buffer: AudioBuffer;
}

export class AudioEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  /** Tapped by the ducking controller as the sidechain destination. */
  readonly musicBus: GainNode;
  readonly dialogueBus: GainNode;

  private readonly strips = new Map<string, ClipStrip>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private startedAtContextTime = 0;
  private startedAtSeconds = 0;
  private playing = false;

  constructor(context: AudioContext = new AudioContext()) {
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = 1;
    this.master.connect(context.destination);

    this.musicBus = context.createGain();
    this.musicBus.connect(this.master);

    this.dialogueBus = context.createGain();
    this.dialogueBus.connect(this.master);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Seconds of timeline position, derived from the audio clock during playback. */
  get positionSeconds(): number {
    if (!this.playing) return this.startedAtSeconds;
    return this.startedAtSeconds + (this.context.currentTime - this.startedAtContextTime);
  }

  setMasterVolume(value: number): void {
    this.master.gain.setTargetAtTime(clamp(value, 0, 2), this.context.currentTime, 0.01);
  }

  /** Decode and retain a source so clips referencing it can be scheduled. */
  async registerSource(uri: string, data: ArrayBuffer): Promise<AudioBuffer> {
    const cached = this.buffers.get(uri);
    if (cached) return cached;

    const buffer = await this.context.decodeAudioData(data);
    this.buffers.set(uri, buffer);
    return buffer;
  }

  getBuffer(uri: string): AudioBuffer | undefined {
    return this.buffers.get(uri);
  }

  private createStrip(buffer: AudioBuffer, bus: GainNode): ClipStrip {
    const { context } = this;

    const gain = context.createGain();

    const low = context.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 120;

    const mid = context.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.9;

    const high = context.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 8000;

    const panner = context.createStereoPanner();

    gain.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(panner);
    panner.connect(bus);

    return { source: null, gain, panner, low, mid, high, buffer };
  }

  setClipEq(clipId: string, eq: EqSettings): void {
    const strip = this.strips.get(clipId);
    if (!strip) return;
    strip.low.gain.value = eq.low;
    strip.mid.gain.value = eq.mid;
    strip.high.gain.value = eq.high;
  }

  setClipPan(clipId: string, pan: number): void {
    const strip = this.strips.get(clipId);
    if (strip) strip.panner.pan.value = clamp(pan, -1, 1);
  }

  setClipVolume(clipId: string, volume: number): void {
    const strip = this.strips.get(clipId);
    if (strip) {
      strip.gain.gain.setTargetAtTime(clamp(volume, 0, 2), this.context.currentTime, 0.01);
    }
  }

  /**
   * Schedule every audio clip that overlaps the playback window.
   *
   * Clips already past the playhead are started with an offset so a mid-clip
   * seek stays sample-accurate against the video clock.
   */
  play(project: ProjectState, fromFrame: number): void {
    void this.context.resume();
    this.stop();

    const fps = project.fps;
    const startSeconds = fromFrame / fps;

    const trackById = new Map(project.tracks.map((track) => [track.id, track]));

    for (const clip of Object.values(project.clips)) {
      const track = trackById.get(clip.trackId);
      if (!track || track.muted) continue;

      const buffer = this.buffers.get(clip.sourceUri);
      if (!buffer) continue;

      const clipStart = clip.startFrame / fps;
      const clipEnd = (clip.startFrame + clip.durationFrames) / fps;
      if (clipEnd <= startSeconds) continue;

      const bus = track.name.toLowerCase().includes('dialog') ? this.dialogueBus : this.musicBus;
      const strip = this.createStrip(buffer, bus);
      strip.gain.gain.value = clamp(clip.volume, 0, 2);

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(strip.gain);
      strip.source = source;

      const sourceOffset = clip.sourceOffsetFrames / fps;
      const whenSeconds = Math.max(0, clipStart - startSeconds);
      const offsetSeconds = sourceOffset + Math.max(0, startSeconds - clipStart);
      const durationSeconds = clipEnd - Math.max(clipStart, startSeconds);

      source.start(this.context.currentTime + whenSeconds, offsetSeconds, durationSeconds);
      this.strips.set(clip.id, strip);
    }

    this.startedAtContextTime = this.context.currentTime;
    this.startedAtSeconds = startSeconds;
    this.playing = true;
  }

  stop(): void {
    for (const strip of this.strips.values()) {
      if (strip.source) {
        try {
          strip.source.stop();
        } catch {
          // A source that never started throws; nothing to clean up.
        }
        strip.source.disconnect();
      }
      strip.gain.disconnect();
      strip.low.disconnect();
      strip.mid.disconnect();
      strip.high.disconnect();
      strip.panner.disconnect();
    }
    this.strips.clear();

    if (this.playing) {
      this.startedAtSeconds = this.positionSeconds;
      this.playing = false;
    }
  }

  seek(frame: number, fps: number): void {
    this.startedAtSeconds = frame / fps;
    this.startedAtContextTime = this.context.currentTime;
  }

  /** Audio-bearing clips, i.e. everything on a track the mixer feeds. */
  static audioClips(project: ProjectState): Clip[] {
    const audioTracks = new Set(
      project.tracks.filter((track) => track.type === 'audio').map((track) => track.id),
    );
    return Object.values(project.clips).filter((clip) => audioTracks.has(clip.trackId));
  }

  async dispose(): Promise<void> {
    this.stop();
    this.buffers.clear();
    await this.context.close();
  }
}
