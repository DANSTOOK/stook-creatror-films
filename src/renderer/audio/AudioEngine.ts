import type { AudioBus, Clip, EqSettings, ProjectState, Track } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { clipGain, hasSoloedTrack, panPosition, trackGain } from './mixRouting';
import type { ScrubGrain } from './scrubAudio';
import type { AudioStream } from './AudioStream';
import {
  advanceScheduled,
  forgetPassed,
  planPlaybackSpans,
  type ScheduledSpan,
} from './playbackSchedule';

/** How often the scheduler looks ahead while playing. */
const SCHEDULE_INTERVAL_MS = 200;

/**
 * How far ahead of the playhead to keep the graph fed.
 *
 * Long enough that a slow decode or a busy frame cannot leave a hole, short
 * enough that a 45-minute source costs no more than a short one.
 */
const LOOKAHEAD_SECONDS = 2;

/** Longest stretch handed over at once. */
const SPAN_SECONDS = 0.5;

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
  /**
   * Every source node feeding this strip.
   *
   * A whole-buffer clip has one. A streamed clip has a few seconds at a
   * time, so its strip outlives many of them and they come and go.
   */
  sources: AudioBufferSourceNode[];
  gain: GainNode;
  panner: StereoPannerNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  buffer?: AudioBuffer;
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

  /* Streamed sources, and the scheduler that feeds them to the graph. */
  private readonly streams = new Map<string, AudioStream>();
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private scheduledUntil = new Map<string, number>();
  private playingProject: ProjectState | null = null;
  private ticking = false;

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

  private createStrip(bus: AudioNode, trackId: string, buffer?: AudioBuffer): ClipStrip {
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

    return { trackId, sources: [], gain, panner, low, mid, high, buffer };
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
   * Hand a streamed source to the engine.
   *
   * Sources registered this way are decoded a few seconds at a time as the
   * playhead reaches them, instead of being held whole - which is the
   * difference between about 11 MB and a gigabyte for a long recording.
   */
  registerStream(uri: string, stream: AudioStream): void {
    this.streams.set(uri, stream);
  }

  /** Whether this source plays from a stream rather than a whole buffer. */
  hasStream(uri: string): boolean {
    return this.streams.has(uri);
  }

  /** Whether this source can be heard at all, streamed or whole. */
  hasAudio(uri: string): boolean {
    return this.streams.has(uri) || this.buffers.has(uri);
  }

  /** The strip a streamed clip keeps for as long as it is playing. */
  private stripFor(clip: Clip, track: Track, anySolo: boolean): ClipStrip {
    const existing = this.strips.get(clip.id);
    if (existing) return existing;

    const trackStrip = this.ensureTrackStrip(track, anySolo);
    const strip = this.createStrip(trackStrip.gain, track.id);
    strip.gain.gain.value = clipGain(clip);
    strip.panner.pan.value = panPosition(clip.pan);
    strip.low.gain.value = clip.eq.low;
    strip.mid.gain.value = clip.eq.mid;
    strip.high.gain.value = clip.eq.high;
    this.strips.set(clip.id, strip);
    return strip;
  }

  /**
   * Decode one planned span and hand it to the graph at its moment.
   *
   * A span that is already late is started with an offset into itself rather
   * than late in full, so a slow decode costs a little of that stretch
   * instead of pushing everything after it out of time.
   */
  private async scheduleSpan(project: ProjectState, span: ScheduledSpan): Promise<void> {
    const stream = this.streams.get(span.sourceUri);
    const clip = project.clips[span.clipId];
    const track = project.tracks.find((candidate) => candidate.id === clip?.trackId);
    if (!stream || !clip || !track) return;

    const decoded = await stream.span(span.sourceFrom, span.seconds);
    if (!this.playing) return;

    const when = this.startedAtContextTime + (span.atTimeline - this.startedAtSeconds);
    const now = this.context.currentTime;
    const lateBy = now - when;
    if (lateBy >= span.seconds) return;

    const buffer = this.context.createBuffer(
      decoded.channels,
      decoded.planes[0].length,
      decoded.sampleRate,
    );
    for (let channel = 0; channel < decoded.channels; channel += 1) {
      buffer.getChannelData(channel).set(decoded.planes[channel]);
    }

    const strip = this.stripFor(clip, track, hasSoloedTrack(project));
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(strip.gain);
    source.onended = () => {
      const at = strip.sources.indexOf(source);
      if (at >= 0) strip.sources.splice(at, 1);
      source.disconnect();
    };

    if (lateBy > 0) source.start(now, lateBy);
    else source.start(when);
    strip.sources.push(source);
  }

  /** Keep the graph fed for the next few seconds of streamed audio. */
  private async tick(): Promise<void> {
    if (this.ticking || !this.playing) return;
    const project = this.playingProject;
    if (!project) return;

    this.ticking = true;
    try {
      const now = this.positionSeconds;
      this.scheduledUntil = forgetPassed(this.scheduledUntil, now);

      const spans = planPlaybackSpans(project, {
        fromSeconds: now,
        horizonSeconds: LOOKAHEAD_SECONDS,
        chunkSeconds: SPAN_SECONDS,
        scheduledUntil: this.scheduledUntil,
        canStream: (uri) => this.streams.has(uri),
      });
      if (spans.length === 0) return;

      // Marked before decoding, so the next tick does not plan them again
      // while this one is still waiting on the decoder.
      this.scheduledUntil = advanceScheduled(this.scheduledUntil, spans);
      for (const span of spans) {
        if (!this.playing) break;
        await this.scheduleSpan(project, span);
      }
    } catch {
      // A source that cannot be decoded goes quiet rather than stopping
      // playback; the rest of the mix carries on.
    } finally {
      this.ticking = false;
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

      // A streamed source has no whole buffer to lay out: the scheduler
      // below feeds it to the graph a few seconds at a time.
      if (this.streams.has(clip.sourceUri)) continue;

      const buffer = this.buffers.get(clip.sourceUri);
      if (!buffer) continue;

      const clipStart = clip.startFrame / fps;
      const clipEnd = (clip.startFrame + clip.durationFrames) / fps;
      if (clipEnd <= startSeconds) continue;

      const trackStrip = this.ensureTrackStrip(track, anySolo);
      const strip = this.createStrip(trackStrip.gain, track.id, buffer);
      strip.gain.gain.value = clipGain(clip);
      strip.panner.pan.value = panPosition(clip.pan);
      strip.low.gain.value = clip.eq.low;
      strip.mid.gain.value = clip.eq.mid;
      strip.high.gain.value = clip.eq.high;

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(strip.gain);
      strip.sources.push(source);

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

    // Streamed clips are decoded and handed over as the playhead nears them.
    this.playingProject = project;
    this.scheduledUntil = new Map();
    void this.tick();
    this.scheduler = setInterval(() => void this.tick(), SCHEDULE_INTERVAL_MS);
  }

  stop(): void {
    if (this.scheduler !== null) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
    this.playingProject = null;
    this.scheduledUntil = new Map();

    for (const strip of this.strips.values()) {
      for (const source of strip.sources) {
        try {
          source.stop();
        } catch {
          // A source that never started throws; nothing to clean up.
        }
        source.disconnect();
      }
      strip.sources.length = 0;
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

    // The scheduler plans from this, so it has to be the project as it is now
    // and not the one playback started with.
    if (this.playing) this.playingProject = project;

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

  /** Grains still sounding from the last scrub, faded out by the next one. */
  private scrubVoices: { source: AudioBufferSourceNode; strip: ClipStrip }[] = [];

  /**
   * Play one grain per planned clip, through the same clip and track strips
   * as playback. Each grain ramps in and out over a few milliseconds - a
   * grain that starts or stops on a non-zero sample is a click, and a drag
   * would turn those into a buzz.
   */
  scrub(project: ProjectState, grains: readonly ScrubGrain[]): void {
    if (this.playing) return;
    void this.context.resume();

    const now = this.context.currentTime;
    const FADE = 0.006;

    for (const voice of this.scrubVoices) {
      voice.strip.gain.gain.cancelScheduledValues(now);
      voice.strip.gain.gain.setTargetAtTime(0, now, FADE / 3);
      try {
        voice.source.stop(now + FADE * 2);
      } catch {
        // Already stopped.
      }
    }
    this.scrubVoices = [];

    const anySolo = hasSoloedTrack(project);
    const tracks = new Map(project.tracks.map((track) => [track.id, track]));

    for (const grain of grains) {
      const track = tracks.get(grain.trackId);
      const clip = project.clips[grain.clipId];
      if (!track || !clip) continue;

      // A streamed source has no whole buffer to slice, so the grain is
      // fetched. It arrives a few milliseconds later, which a scrub does
      // not notice.
      if (this.streams.has(grain.sourceUri)) {
        void this.scrubFromStream(grain, clip, track, anySolo);
        continue;
      }

      const buffer = this.buffers.get(grain.sourceUri);
      if (!buffer || grain.offsetSeconds >= buffer.duration) continue;

      const trackStrip = this.ensureTrackStrip(track, anySolo);
      const strip = this.createStrip(trackStrip.gain, track.id, buffer);
      strip.panner.pan.value = panPosition(clip.pan);
      strip.low.gain.value = clip.eq.low;
      strip.mid.gain.value = clip.eq.mid;
      strip.high.gain.value = clip.eq.high;

      const level = clipGain(clip);
      const end = now + grain.durationSeconds;
      strip.gain.gain.setValueAtTime(0, now);
      strip.gain.gain.linearRampToValueAtTime(level, now + FADE);
      strip.gain.gain.setValueAtTime(level, Math.max(now + FADE, end - FADE));
      strip.gain.gain.linearRampToValueAtTime(0, end);

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(strip.gain);
      source.onended = () => {
        source.disconnect();
        strip.gain.disconnect();
        strip.low.disconnect();
        strip.mid.disconnect();
        strip.high.disconnect();
        strip.panner.disconnect();
      };
      source.start(now, grain.offsetSeconds, grain.durationSeconds + 0.01);
      this.scrubVoices.push({ source, strip });
    }
  }

  /**
   * One scrub grain from a streamed source.
   *
   * The window the forward decoder holds usually covers the playhead, so
   * this is a copy rather than a decode. Dragging far from it decodes on its
   * own, which is a moment rougher but immediate - see AudioStream.
   */
  private async scrubFromStream(
    grain: ScrubGrain,
    clip: Clip,
    track: Track,
    anySolo: boolean,
  ): Promise<void> {
    const stream = this.streams.get(grain.sourceUri);
    if (!stream || this.playing) return;

    const decoded = await stream.span(grain.offsetSeconds, grain.durationSeconds).catch(() => null);
    if (!decoded || this.playing) return;

    const buffer = this.context.createBuffer(
      decoded.channels,
      decoded.planes[0].length,
      decoded.sampleRate,
    );
    for (let channel = 0; channel < decoded.channels; channel += 1) {
      buffer.getChannelData(channel).set(decoded.planes[channel]);
    }

    const now = this.context.currentTime;
    const fade = 0.006;
    const trackStrip = this.ensureTrackStrip(track, anySolo);
    const strip = this.createStrip(trackStrip.gain, track.id, buffer);
    strip.panner.pan.value = panPosition(clip.pan);
    strip.low.gain.value = clip.eq.low;
    strip.mid.gain.value = clip.eq.mid;
    strip.high.gain.value = clip.eq.high;

    const level = clipGain(clip);
    const end = now + grain.durationSeconds;
    strip.gain.gain.setValueAtTime(0, now);
    strip.gain.gain.linearRampToValueAtTime(level, now + fade);
    strip.gain.gain.setValueAtTime(level, Math.max(now + fade, end - fade));
    strip.gain.gain.linearRampToValueAtTime(0, end);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(strip.gain);
    source.onended = () => {
      source.disconnect();
      strip.gain.disconnect();
      strip.low.disconnect();
      strip.mid.disconnect();
      strip.high.disconnect();
      strip.panner.disconnect();
    };
    source.start(now, 0, grain.durationSeconds + 0.01);
    this.scrubVoices.push({ source, strip });
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
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    this.buffers.clear();
    await this.context.close();
  }
}
