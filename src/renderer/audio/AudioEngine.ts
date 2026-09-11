import type { AudioBus, Clip, EqSettings, ProjectState, Track } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { clipGain, hasSoloedTrack, panPosition, trackGain } from './mixRouting';

/**
 * Web Audio subsystem.
 *
 * One `AudioContext` drives every audio-bearing clip, through the signal path
 * the mixer draws:
 *
 *   clip: gain -> low -> mid -> high -> panner
 *   track: gain -> panner
 *   bus:   music | dialogue
 *   master
 *
 * The track strip is what makes a track fader mean anything, and the two buses
 * are what auto-ducking keys off: the dialogue bus is the sidechain, the music
 * bus is what gets pulled down.
 */

export type { EqSettings } from '@shared/types';
export { NEUTRAL_EQ } from '@shared/types';

interface ClipStrip {
  trackId: string;
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  panner: StereoPannerNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  buffer: AudioBuffer;
}

interface TrackStrip {
  gain: GainNode;
  panner: StereoPannerNode;
  bus: AudioBus;
}

export class AudioEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  /** Tapped by the ducking controller as the sidechain destination. */
  readonly musicBus: GainNode;
  readonly dialogueBus: GainNode;

  private readonly strips = new Map<string, ClipStrip>();
  private readonly trackStrips = new Map<string, TrackStrip>();
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

  /** The music or dialogue bus node, by name. */
  private busNode(bus: AudioBus): GainNode {
    return bus === 'dialogue' ? this.dialogueBus : this.musicBus;
  }

  /**
   * Build (or rebuild) the strip for a track.
   *
   * Rebuilt rather than re-pointed when the bus assignment changes: moving a
   * live node between buses means disconnecting mid-playback, and a fresh strip
   * is both simpler and click-free, since the old one is torn down with it.
   */
  private ensureTrackStrip(track: Track, anySolo: boolean): TrackStrip {
    const existing = this.trackStrips.get(track.id);
    if (existing && existing.bus === track.bus) {
      existing.gain.gain.value = trackGain(track, anySolo);
      existing.panner.pan.value = panPosition(track.pan);
      return existing;
    }

    if (existing) {
      existing.gain.disconnect();
      existing.panner.disconnect();
    }

    const gain = this.context.createGain();
    gain.gain.value = trackGain(track, anySolo);

    const panner = this.context.createStereoPanner();
    panner.pan.value = panPosition(track.pan);

    gain.connect(panner);
    panner.connect(this.busNode(track.bus));

    const strip: TrackStrip = { gain, panner, bus: track.bus };
    this.trackStrips.set(track.id, strip);
    return strip;
  }

  private createStrip(buffer: AudioBuffer, bus: AudioNode, trackId: string): ClipStrip {
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

    return { trackId, source: null, gain, panner, low, mid, high, buffer };
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
    const anySolo = hasSoloedTrack(project);

    this.master.gain.value = clamp(project.audio.masterVolume, 0, 2);

    const trackById = new Map(project.tracks.map((track) => [track.id, track]));

    for (const clip of Object.values(project.clips)) {
      const track = trackById.get(clip.trackId);
      // A muted or un-soloed track is still scheduled, at zero gain, so that
      // un-muting it mid-playback takes effect immediately instead of waiting
      // for the next seek.
      if (!track) continue;

      const buffer = this.buffers.get(clip.sourceUri);
      if (!buffer) continue;

      const clipStart = clip.startFrame / fps;
      const clipEnd = (clip.startFrame + clip.durationFrames) / fps;
      if (clipEnd <= startSeconds) continue;

      const trackStrip = this.ensureTrackStrip(track, anySolo);
      const strip = this.createStrip(buffer, trackStrip.gain, track.id);
      strip.gain.gain.value = clipGain(clip);
      strip.panner.pan.value = panPosition(clip.pan);
      strip.low.gain.value = clip.eq.low;
      strip.mid.gain.value = clip.eq.mid;
      strip.high.gain.value = clip.eq.high;

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

    for (const strip of this.trackStrips.values()) {
      strip.gain.disconnect();
      strip.panner.disconnect();
    }
    this.trackStrips.clear();

    if (this.playing) {
      this.startedAtSeconds = this.positionSeconds;
      this.playing = false;
    }
  }

  /**
   * Push the project's mixer values into the live graph.
   *
   * Nothing is rescheduled: a fader moved during playback has to be audible on
   * the next buffer, not after a seek. Ramps are short but not instant, because
   * stepping a gain discontinuously is a click.
   */
  applyMix(project: ProjectState): void {
    const now = this.context.currentTime;
    const anySolo = hasSoloedTrack(project);

    this.master.gain.setTargetAtTime(clamp(project.audio.masterVolume, 0, 2), now, 0.01);

    for (const track of project.tracks) {
      const strip = this.trackStrips.get(track.id);
      if (!strip) continue;
      strip.gain.gain.setTargetAtTime(trackGain(track, anySolo), now, 0.01);
      strip.panner.pan.setTargetAtTime(panPosition(track.pan), now, 0.01);
    }

    for (const clip of Object.values(project.clips)) {
      const strip = this.strips.get(clip.id);
      if (!strip) continue;
      strip.gain.gain.setTargetAtTime(clipGain(clip), now, 0.01);
      strip.panner.pan.setTargetAtTime(panPosition(clip.pan), now, 0.01);
      strip.low.gain.setTargetAtTime(clip.eq.low, now, 0.01);
      strip.mid.gain.setTargetAtTime(clip.eq.mid, now, 0.01);
      strip.high.gain.setTargetAtTime(clip.eq.high, now, 0.01);
    }
  }

  /**
   * True when a bus reassignment or a newly scheduled clip needs a full
   * rebuild rather than a parameter update.
   */
  needsRebuild(project: ProjectState): boolean {
    return project.tracks.some((track) => {
      const strip = this.trackStrips.get(track.id);
      return strip !== undefined && strip.bus !== track.bus;
    });
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
