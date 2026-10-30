import type { AudioBus, Clip, EqSettings, ProjectState, Track } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { clipGain, clipSounds, hasSoloedTrack, panPosition, trackGain } from './mixRouting';
import { speedOf } from '@renderer/timing/clipSpeed';
import { applyFadeEnvelope } from './fadeEnvelope';
import { envelopeSignature, hasPanEnvelope, hasVolumeEnvelope, panPoints, scheduleEnvelope } from './audioEnvelope';
import { withAudioCrossfades } from '@renderer/timing/transitions';
import type { ScrubGrain } from './scrubAudio';
import type { AudioStream } from './AudioStream';
import {
  advanceScheduled,
  forgetPassed,
  placeSpan,
  planPlaybackSpans,
  type ScheduledSpan,
} from './playbackSchedule';
import { clearPlaybackHold, holdPlayback, releasePlayback } from '@renderer/timing/playbackHold';

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
 * The fade used wherever sound has to start or stop on a sample that is not
 * silent: four milliseconds, what a DAW's auto-fade does at a cut - too short
 * to hear as a fade, long enough that no step is left.
 */
const DECLICK_SECONDS = 0.004;

/**
 * The longest the start of play waits for its first streamed spans.
 *
 * Measured on v1.42.0-beta.1 with a CPU hog and a long file being imported,
 * the first span came 10 to 250 ms after play was pressed (about 10 ms on an
 * idle machine). Waiting is what Premiere and Resolve do; waiting without
 * bound would leave a stuck decoder holding the picture, so past this the
 * picture sets off and the late span fades in when it comes.
 */
const START_WAIT_MS = 300;

/**
 * Streamed spans that sound within this much of the start are waited for.
 * One sounding later has that long to be decoded once playing, which is ten
 * times what a span takes on an idle machine.
 */
const START_WAIT_REACH_SECONDS = 0.1;

/**
 * How far ahead of the audio clock a source is started, at the least (see
 * playbackSchedule `placeSpan`): two audio callbacks on Windows, so a stale
 * clock or a page held up for a moment cannot make a source start late.
 */
const SAFE_LEAD_SECONDS = 0.02;

/**
 * How long after a stop's fade the stopped strips are let go: the page's timers
 * are not on the audio clock, so a little room past the fade itself.
 */
const STOP_RELEASE_MS = 50;

/**
 * A stretch of the timeline played over and over, in timeline seconds:
 * `start` included, `end` not.
 */
export interface LoopWindow {
  start: number;
  end: number;
}

/**
 * The fade either side of a loop's join, in seconds.
 *
 * The end of the loop and its start are two unrelated points of the sound,
 * and butting one against the other is a step in the waveform - a click,
 * every time round. Four milliseconds down to the join and four back up is
 * what a DAW's auto-fade does at a cut: too short to hear as a dip, long
 * enough that no step is left. A clip that starts or ends exactly on the
 * loop's edge gets it too: the end of the edit butted against its start is
 * the same step.
 */
export const LOOP_DECLICK_SECONDS = DECLICK_SECONDS;

/** The wrapped timeline position of an unwrapped play time, for a loop. */
export function wrapLoopSeconds(seconds: number, loop: LoopWindow | null): number {
  if (!loop || seconds < loop.end) return seconds;
  const length = loop.end - loop.start;
  if (!(length > 0)) return loop.start;
  return loop.start + ((seconds - loop.start) % length);
}

/**
 * Which time round the loop an unwrapped play time is in: 0 until the first
 * wrap, then 1, 2... Each pass plays the same timeline seconds `pass *
 * length` later on the audio clock.
 */
export function loopPassAt(seconds: number, loop: LoopWindow | null): number {
  if (!loop || seconds < loop.end) return 0;
  const length = loop.end - loop.start;
  if (!(length > 0)) return 0;
  return 1 + Math.floor((seconds - loop.end) / length);
}

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
  /** The clip this strip plays. A looping clip has one strip per time round. */
  clipId: string;
  trackId: string;
  /**
   * Every source node feeding this strip.
   *
   * A whole-buffer clip has one. A streamed clip has a few seconds at a
   * time, so its strip outlives many of them and they come and go.
   */
  sources: AudioBufferSourceNode[];
  /**
   * What the sources play into first: at 1, except where the sound starts
   * mid-way after silence - the start of play part-way into a clip, a span
   * that came late - which it fades in, and at the end of what has been
   * handed over so far, which it fades out in case the next span is late
   * (see `placeStreamSpan`). Apart from `edge`, so these and the loop's
   * fades never have to be written onto one parameter.
   */
  guard: GainNode;
  /** Audio clock time the last span handed to this strip ends. */
  fedUntil: number;
  /**
   * When the fade-out at `fedUntil` begins, while one is written - taken
   * back when the next span carries on in time - or null.
   */
  guardOutAt: number | null;
  /**
   * What the guard feeds, ahead of the clip's gain: at 1, except for
   * the few milliseconds either side of a loop's join (LOOP_DECLICK_SECONDS),
   * which it fades through without touching the clip's own fade envelope.
   */
  edge: GainNode;
  gain: GainNode;
  panner: StereoPannerNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  buffer?: AudioBuffer;
  /**
   * The time round the loop a scheduled strip plays (0 the first). Absent on
   * the strips `play` lays out whole and on scrub grains, which are released
   * by `stop` alone.
   */
  pass?: number;
  /**
   * The animated gain and pan written onto this strip (envelopeSignature).
   * Ramps already scheduled cannot be bent, so when an edit changes this the
   * schedule is rebuilt rather than nudged.
   */
  envelope?: string;
}

interface TrackStrip {
  gain: GainNode;
  panner: StereoPannerNode;
  bus: AudioBus;
  /** Left and right, after the fader and the pan: what the mixer's meter shows. */
  meter: StereoMeter;
}

/**
 * A stereo tap for a meter: a splitter into two analysers, hanging off a
 * node without being in its path. An analyser nobody reads costs next to
 * nothing; the mixer reads them only while playing.
 */
interface StereoMeter {
  splitter: ChannelSplitterNode;
  left: AnalyserNode;
  right: AnalyserNode;
}

/** Peak and RMS, left and right, as linear levels (1 is full scale). */
export interface MeterReading {
  peak: [number, number];
  rms: [number, number];
}

const METER_WINDOW = 1024;

function createMeter(context: BaseAudioContext, source: AudioNode): StereoMeter {
  const splitter = context.createChannelSplitter(2);
  const left = context.createAnalyser();
  const right = context.createAnalyser();
  left.fftSize = METER_WINDOW;
  right.fftSize = METER_WINDOW;
  source.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  return { splitter, left, right };
}

function disconnectMeter(meter: StereoMeter): void {
  meter.splitter.disconnect();
}

/** The engine playback runs on, for the mixer's meters. */
let activeEngine: AudioEngine | null = null;
export const getAudioEngine = (): AudioEngine | null => activeEngine;
export const setActiveAudioEngine = (engine: AudioEngine | null): void => {
  activeEngine = engine;
};

export class AudioEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  /** Tapped by the ducking controller as the sidechain destination. */
  readonly musicBus: GainNode;
  readonly dialogueBus: GainNode;

  private readonly strips = new Map<string, ClipStrip>();
  private readonly trackStrips = new Map<string, TrackStrip>();
  private readonly buffers = new Map<string, AudioBuffer>();
  /** After the master fader: the meter on the mixer's master strip. */
  private readonly masterMeter: StereoMeter;
  private readonly meterBuffer = new Float32Array(METER_WINDOW);
  private startedAtContextTime = 0;
  private startedAtSeconds = 0;
  private playing = false;

  /* Streamed sources, and the scheduler that feeds them to the graph. */
  private readonly streams = new Map<string, AudioStream>();
  private scheduler: ReturnType<typeof setInterval> | null = null;
  /**
   * True from `play` until the sound begins, while the first streamed spans
   * are decoded (see START_WAIT_MS). The clock stands at the start meanwhile,
   * and so does the playhead (timing/playbackHold).
   */
  private waiting = false;
  /** Spans decoded while waiting, handed to the graph when the sound begins. */
  private held: Array<{ project: ProjectState; span: ScheduledSpan; pass: number; buffer: AudioBuffer; bufferFrom: number }> = [];
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The generation a scheduling pass is running for, or null: one pass at a time per play. */
  private feeding: number | null = null;
  /** Timeline seconds already handed to the graph, per clip, per time round the loop (0 without one). */
  private scheduledUntil = new Map<number, Map<string, number>>();
  /** Strips (by key) whose fade envelope and loop fades have already been written. */
  private fadedClips = new Set<string>();
  private playingProject: ProjectState | null = null;
  /** The stretch being looped, or null when playback runs on to the end. */
  private loop: LoopWindow | null = null;
  /**
   * Bumped by every stop. A span still being decoded when playback was
   * restarted belongs to the old schedule, and is dropped rather than
   * dropped into the new one at the wrong moment.
   */
  private generation = 0;

  constructor(context: AudioContext = new AudioContext()) {
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = 1;
    this.master.connect(context.destination);

    this.musicBus = context.createGain();
    this.musicBus.connect(this.master);

    this.dialogueBus = context.createGain();
    this.dialogueBus.connect(this.master);

    this.masterMeter = createMeter(context, this.master);
  }

  private read(meter: StereoMeter): MeterReading {
    const measure = (analyser: AnalyserNode): [number, number] => {
      analyser.getFloatTimeDomainData(this.meterBuffer);
      let peak = 0;
      let sum = 0;
      for (let index = 0; index < this.meterBuffer.length; index += 1) {
        const sample = this.meterBuffer[index];
        const size = sample < 0 ? -sample : sample;
        if (size > peak) peak = size;
        sum += sample * sample;
      }
      return [peak, Math.sqrt(sum / this.meterBuffer.length)];
    };
    const [leftPeak, leftRms] = measure(meter.left);
    const [rightPeak, rightRms] = measure(meter.right);
    return { peak: [leftPeak, rightPeak], rms: [leftRms, rightRms] };
  }

  /**
   * What the meters read now: the master and every track that is sounding.
   * A track with nothing scheduled has no strip and is not in the map - its
   * meter is empty. Read about 20 ms of sound per channel.
   */
  meterLevels(): { master: MeterReading; tracks: Map<string, MeterReading> } {
    const tracks = new Map<string, MeterReading>();
    for (const [id, strip] of this.trackStrips) tracks.set(id, this.read(strip.meter));
    return { master: this.read(this.masterMeter), tracks };
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Seconds of timeline position, derived from the audio clock during
   * playback - wrapped back into the loop while one plays.
   */
  get positionSeconds(): number {
    return wrapLoopSeconds(this.unwrappedSeconds, this.loop);
  }

  /** The loop playback is going round, if any. */
  get loopWindow(): LoopWindow | null {
    return this.loop;
  }

  /** Play time since the start, as if the loop were laid out end to end. */
  private get unwrappedSeconds(): number {
    // Waiting for the first spans, or in the moment before the sound begins,
    // it stands at the start - as the playhead does.
    if (!this.playing || this.waiting) return this.startedAtSeconds;
    return this.startedAtSeconds + Math.max(0, this.context.currentTime - this.startedAtContextTime);
  }

  /** The audio clock's time for a moment of unwrapped play time. */
  private contextTimeOf(unwrapped: number): number {
    return this.startedAtContextTime + (unwrapped - this.startedAtSeconds);
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
      disconnectMeter(existing.meter);
    }

    const gain = this.context.createGain();
    gain.gain.value = trackGain(track, anySolo);

    const panner = this.context.createStereoPanner();
    panner.pan.value = panPosition(track.pan);

    gain.connect(panner);
    panner.connect(this.busNode(track.bus));

    const strip: TrackStrip = { gain, panner, bus: track.bus, meter: createMeter(this.context, panner) };
    this.trackStrips.set(track.id, strip);
    return strip;
  }

  private createStrip(bus: AudioNode, trackId: string, clipId: string, buffer?: AudioBuffer): ClipStrip {
    const { context } = this;

    const guard = context.createGain();
    const edge = context.createGain();
    const gain = context.createGain();
    guard.connect(edge);
    edge.connect(gain);

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

    return { clipId, trackId, sources: [], guard, fedUntil: -Infinity, guardOutAt: null, edge, gain, panner, low, mid, high, buffer };
  }

  /**
   * Fade a strip in from silence over the first moments after a loop's join.
   *
   * Silent from now, not only from the join: the strip is this time round's
   * own, so nothing sounds through it before then, and a source and a
   * parameter given the same time do not always land on the same sample.
   * Measured at the start of play, the source came in one sample ahead of a
   * fade written for the same moment - one sample at full level, a click.
   */
  private declickIn(strip: ClipStrip, at: number): void {
    const edge = strip.edge.gain;
    edge.setValueAtTime(0, Math.min(this.context.currentTime, at));
    edge.setValueAtTime(0, at);
    edge.linearRampToValueAtTime(1, at + LOOP_DECLICK_SECONDS);
  }

  /** Fade a strip down to silence by the instant of a loop's join. */
  private declickOut(strip: ClipStrip, at: number): void {
    const edge = strip.edge.gain;
    edge.setValueAtTime(1, Math.max(this.context.currentTime, at - LOOP_DECLICK_SECONDS));
    edge.linearRampToValueAtTime(0, at);
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

  /**
   * The strip a scheduled clip keeps for as long as it is playing. One per
   * time round a loop: each pass has its own fade envelope and its own fades
   * at the join, written once, so a strip is never asked to be in two places.
   */
  private stripFor(clip: Clip, track: Track, anySolo: boolean, key = clip.id, pass = 0): ClipStrip {
    const existing = this.strips.get(key);
    if (existing) return existing;

    const trackStrip = this.ensureTrackStrip(track, anySolo);
    const strip = this.createStrip(trackStrip.gain, track.id, clip.id);
    strip.pass = pass;
    strip.gain.gain.value = clipGain(clip);
    strip.panner.pan.value = panPosition(clip.pan);
    strip.low.gain.value = clip.eq.low;
    strip.mid.gain.value = clip.eq.mid;
    strip.high.gain.value = clip.eq.high;
    this.strips.set(key, strip);
    return strip;
  }

  /**
   * Let go of the strips of passes the loop has gone past whose sources have
   * all ended. Only those: a source still sounding (a span laid just ahead
   * of a join) keeps its strip until it ends and the next tick comes round.
   */
  private releasePassedStrips(firstPass: number): void {
    for (const [key, strip] of this.strips) {
      if (strip.pass === undefined || strip.pass >= firstPass || strip.sources.length > 0) continue;
      strip.guard.disconnect();
      strip.edge.disconnect();
      strip.gain.disconnect();
      strip.low.disconnect();
      strip.mid.disconnect();
      strip.high.disconnect();
      strip.panner.disconnect();
      this.strips.delete(key);
      this.fadedClips.delete(key);
    }
  }

  /** How much later on the audio clock a pass round the loop plays the same timeline seconds. */
  private passOffset(pass: number): number {
    const loop = this.loop;
    return loop && pass > 0 ? pass * (loop.end - loop.start) : 0;
  }

  /**
   * Decode one planned span and hand it to the graph (`placeStreamSpan`).
   *
   * While the start of play is waiting for its first spans, a decoded span is
   * kept until the sound begins instead: its moment on the audio clock is not
   * known before then.
   *
   * `pass` is the time round the loop it belongs to (0 without a loop). A
   * source held whole is not decoded at all: the span is a window of its
   * buffer, started at the right offset for the right length.
   */
  private async scheduleSpan(project: ProjectState, span: ScheduledSpan, pass: number): Promise<void> {
    const stream = this.streams.get(span.sourceUri);
    const whole = stream ? undefined : this.buffers.get(span.sourceUri);
    if (!stream && !whole) return;
    const generation = this.generation;

    let buffer: AudioBuffer;
    let bufferFrom: number;
    if (stream) {
      // A retimed clip eats footage faster or slower than the timeline runs.
      const decoded = await stream.span(span.sourceFrom, span.seconds * span.rate);
      if (!this.playing || generation !== this.generation) return;
      buffer = this.context.createBuffer(decoded.channels, decoded.planes[0].length, decoded.sampleRate);
      for (let channel = 0; channel < decoded.channels; channel += 1) {
        buffer.getChannelData(channel).set(decoded.planes[channel]);
      }
      bufferFrom = 0;
    } else {
      buffer = whole as AudioBuffer;
      bufferFrom = span.sourceFrom;
    }

    if (this.waiting) this.held.push({ project, span, pass, buffer, bufferFrom });
    else this.placeStreamSpan(project, span, pass, buffer, bufferFrom);
  }

  /**
   * Hand one decoded span to the graph at its moment.
   *
   * A span whose moment has gone is started that far into itself, a little
   * ahead of the audio clock, rather than late in full - a slow decode costs
   * a little of that stretch instead of pushing everything after it out of
   * time - and fades in, since it starts mid-sound after a hole. The end of
   * what has been handed over is faded out, in case the next span is late
   * too, and that fade is taken back when the next one carries on in time;
   * so a decoder that cannot keep up leaves short silences, never a click.
   * See playbackSchedule `placeSpan`.
   */
  private placeStreamSpan(project: ProjectState, span: ScheduledSpan, pass: number, buffer: AudioBuffer, bufferFrom: number): void {
    const clip = project.clips[span.clipId];
    const track = project.tracks.find((candidate) => candidate.id === clip?.trackId);
    if (!clip || !track) return;

    const offset = this.passOffset(pass);
    const when = this.contextTimeOf(span.atTimeline + offset);
    const now = this.context.currentTime;
    const earliest = now + SAFE_LEAD_SECONDS;
    const key = pass === 0 ? clip.id : `${clip.id}@${pass}`;
    const loop = this.loop;
    const clipStart = clip.startFrame / project.fps;
    const clipEnd = (clip.startFrame + clip.durationFrames) / project.fps;

    const existing = this.strips.get(key);
    const followsOn =
      existing !== undefined &&
      Math.abs(existing.fedUntil - when) < 1e-6 &&
      (existing.guardOutAt === null || existing.guardOutAt > earliest);
    // A later time round starts at the loop's start, where `edge` fades it in already.
    const atJoin = pass > 0 && loop !== null && Math.abs(span.atTimeline - loop.start) < 1e-6;
    const placement = placeSpan({
      when,
      seconds: span.seconds,
      earliest,
      followsOn,
      startsMidSound: span.atTimeline > clipStart + 1e-6 && !atJoin,
      fadeSeconds: DECLICK_SECONDS,
    });
    if (!placement) return;

    const strip = this.stripFor(clip, track, hasSoloedTrack(project), key, pass);

    /*
      A streamed clip is fed to the graph a few seconds at a time, but its fade
      belongs to the whole clip, so the envelope is written onto the strip once
      - anchored to where the clip itself starts, however late the first span
      arrives. Round a loop, each pass is a strip of its own, anchored to where
      the clip starts in that pass.
    */
    if (!this.fadedClips.has(key)) {
      this.fadedClips.add(key);
      const clipStartsAt = this.contextTimeOf(clipStart + offset);
      applyFadeEnvelope(
        strip.gain.gain,
        clip,
        clipGain(clip),
        Math.max(now, clipStartsAt),
        Math.max(0, now - clipStartsAt),
        project.fps / span.rate,
      );
      this.schedulePan(strip, clip, Math.max(now, clipStartsAt), Math.max(0, now - clipStartsAt), project.fps / span.rate);
      if (loop) {
        // Sounding at the loop's start after a join: in from silence.
        if (pass > 0 && clipStart <= loop.start + 1e-6) this.declickIn(strip, this.contextTimeOf(loop.start + offset));
        // Sounding up to the loop's end: down to silence by the join.
        if (clipEnd >= loop.end - 1e-6) this.declickOut(strip, this.contextTimeOf(loop.end + offset));
      }
    }

    const guard = strip.guard.gain;
    // Carrying on in time: the fade-out written in case it would not is taken back.
    if (followsOn && strip.guardOutAt !== null) guard.cancelScheduledValues(strip.guardOutAt);
    if (placement.fadeIn) {
      // Silent ahead of the start - from the end of what it played before, if
      // anything, else from now - since a source and a fade given the same
      // moment can land a sample apart (see declickIn).
      guard.setValueAtTime(0, Math.min(placement.startAt, Math.max(now, strip.fedUntil)));
      guard.setValueAtTime(0, placement.startAt);
      guard.linearRampToValueAtTime(1, placement.startAt + DECLICK_SECONDS);
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = span.rate;
    source.connect(strip.guard);
    source.onended = () => {
      const at = strip.sources.indexOf(source);
      if (at >= 0) strip.sources.splice(at, 1);
      source.disconnect();
    };
    // Offsets and lengths are in the buffer's own time, which a retimed clip
    // spends `rate` times as fast as the timeline.
    source.start(placement.startAt, bufferFrom + placement.skip * span.rate, (span.seconds - placement.skip) * span.rate);
    strip.sources.push(source);

    // The clip sounds on past this span (not at its own end, nor the loop's,
    // which have theirs): down to silence by its end, unless the next span
    // carries on in time and takes this back.
    const endsAt = when + span.seconds;
    strip.fedUntil = endsAt;
    if (span.atTimeline + span.seconds < Math.min(clipEnd, loop?.end ?? Infinity) - 1e-6) {
      strip.guardOutAt = endsAt - DECLICK_SECONDS;
      guard.setValueAtTime(1, strip.guardOutAt);
      guard.linearRampToValueAtTime(0, endsAt);
    } else {
      strip.guardOutAt = null;
    }
  }

  /**
   * What to hand to the graph next, soonest first, marked as scheduled.
   *
   * Without a loop that is the streamed clips ahead of the playhead - the
   * whole buffers are laid out when the sound begins. Round a loop it is
   * also every later pass, streamed or whole: the next time round is
   * scheduled on the audio clock before the join is reached, so the loop's
   * start follows its end on the very next sample instead of after a
   * reschedule.
   */
  private plan(project: ProjectState): Array<{ span: ScheduledSpan; pass: number }> {
    const now = this.unwrappedSeconds;
    const horizon = now + LOOKAHEAD_SECONDS;
    const loop = this.loop;
    const firstPass = loopPassAt(now, loop);
    const lastPass = loop ? loopPassAt(horizon, loop) : 0;

    // Passes already played through are forgotten.
    for (const pass of [...this.scheduledUntil.keys()]) if (pass < firstPass) this.scheduledUntil.delete(pass);
    // And so are their strips, once nothing plays through them: a strip is
    // made every time round, and a loop left going for an hour would
    // otherwise keep thousands of silent nodes hanging off the track buses.
    if (loop) this.releasePassedStrips(firstPass);

    const planned: Array<{ span: ScheduledSpan; pass: number }> = [];
    for (let pass = firstPass; pass <= lastPass; pass += 1) {
      const offset = this.passOffset(pass);
      // Where this pass starts and ends, in unwrapped play time.
      const passStart = pass === 0 || !loop ? -Infinity : loop.end + (pass - 1) * (loop.end - loop.start);
      const from = Math.max(now, passStart);
      if (from >= horizon) break;

      const scheduled = forgetPassed(this.scheduledUntil.get(pass) ?? new Map<string, number>(), from - offset);
      const spans = planPlaybackSpans(project, {
        fromSeconds: from - offset,
        horizonSeconds: horizon - from,
        chunkSeconds: SPAN_SECONDS,
        scheduledUntil: scheduled,
        // The first pass's whole buffers are laid out when the sound begins.
        canStream: pass === 0 ? (uri) => this.streams.has(uri) : (uri) => this.hasAudio(uri),
        whole: (uri) => !this.streams.has(uri),
        endSeconds: loop?.end,
      });
      // Marked before decoding, so the next tick does not plan them again
      // while this one is still waiting on the decoder.
      this.scheduledUntil.set(pass, advanceScheduled(scheduled, spans));
      for (const span of spans) planned.push({ span, pass });
    }

    // Soonest first, whichever pass it belongs to.
    planned.sort((a, b) => a.span.atTimeline + this.passOffset(a.pass) - (b.span.atTimeline + this.passOffset(b.pass)));
    return planned;
  }

  /** Whether the start of play waits for this span: streamed, and sounding right away. */
  private startWaitsFor(span: ScheduledSpan, pass: number): boolean {
    return pass === 0 && this.streams.has(span.sourceUri) && span.atTimeline < this.startedAtSeconds + START_WAIT_REACH_SECONDS;
  }

  /**
   * Decode and hand over what `plan` chose, one span after another. The
   * sound begins as soon as every span the start waits for is decoded - they
   * come first, being soonest.
   */
  private async feed(project: ProjectState, planned: Array<{ span: ScheduledSpan; pass: number }>): Promise<void> {
    const generation = this.generation;
    this.feeding = generation;
    try {
      for (const { span, pass } of planned) {
        if (!this.playing || generation !== this.generation) break;
        if (this.waiting && !this.startWaitsFor(span, pass)) this.begin(SAFE_LEAD_SECONDS);
        await this.scheduleSpan(project, span, pass);
      }
    } catch {
      // A source that cannot be decoded goes quiet rather than stopping
      // playback; the rest of the mix carries on.
    } finally {
      if (generation === this.generation) {
        if (this.waiting) this.begin(SAFE_LEAD_SECONDS);
        this.feeding = null;
      }
    }
  }

  /** Keep the graph fed for the next few seconds. */
  private async tick(): Promise<void> {
    if (!this.playing || this.feeding === this.generation) return;
    const project = this.playingProject;
    if (!project) return;
    const planned = this.plan(project);
    if (planned.length > 0) await this.feed(project, planned);
  }

  /**
   * The sound begins: the audio clock is set going from the start `lead`
   * seconds from now, the whole buffers are laid out against it, the spans
   * decoded while waiting are handed over, and the playhead is let go on the
   * same moment.
   */
  private begin(lead: number): void {
    if (!this.waiting || !this.playing) return;
    this.waiting = false;
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const project = this.playingProject;
    if (!project) return;

    this.startedAtContextTime = this.context.currentTime + lead;
    this.layOutWholeClips(project, this.startedAtContextTime);
    const held = this.held;
    this.held = [];
    for (const item of held) this.placeStreamSpan(item.project, item.span, item.pass, item.buffer, item.bufferFrom);
    releasePlayback(performance.now() + lead * 1000);
  }

  /**
   * Schedule every audio clip that overlaps the playback window.
   *
   * Clips already past the playhead are started with an offset so a mid-clip
   * seek stays sample-accurate against the video clock, and faded in over a
   * few milliseconds: starting on a sample that is not silent is a click.
   *
   * Streamed sound has to be decoded first. When some sounds right at the
   * start, the sound - and the playhead with it - waits until it is ready (at
   * most START_WAIT_MS) and then both set off together, from its first
   * sample, rather than starting it part-way in. Measured with a CPU hog and
   * a long import, that click was at nearly every start of play.
   *
   * With a loop, the first pass runs to the loop's end - clips are cut there
   * - and the scheduler lays the later passes on the audio clock ahead of
   * time (see `plan`).
   */
  play(edited: ProjectState, fromFrame: number, loop: LoopWindow | null = null): void {
    void this.context.resume();
    this.stop();
    // Heard with its transitions' crossfades: the clips across a cut run on
    // into each other (see timing/transitions withAudioCrossfades).
    const project = withAudioCrossfades(edited, (clip) => {
      const seconds = this.streams.get(clip.sourceUri)?.duration ?? this.buffers.get(clip.sourceUri)?.duration;
      return seconds === undefined ? undefined : Math.floor(seconds * edited.fps);
    });

    const fps = project.fps;
    // A loop shorter than a frame is not a loop anyone asked for.
    this.loop = loop && loop.end - loop.start >= 1 / fps - 1e-9 ? { ...loop } : null;
    // Started past the loop's end, playback begins at its start.
    const startSeconds = this.loop && fromFrame / fps >= this.loop.end ? this.loop.start : fromFrame / fps;

    this.master.gain.value = clamp(project.audio.masterVolume, 0, 2);
    this.startedAtContextTime = this.context.currentTime;
    this.startedAtSeconds = startSeconds;
    this.playing = true;
    this.waiting = true;
    this.playingProject = project;
    this.scheduledUntil = new Map();

    const planned = this.plan(project);
    if (planned.some(({ span, pass }) => this.startWaitsFor(span, pass))) {
      holdPlayback();
      this.waitTimer = setTimeout(() => this.begin(SAFE_LEAD_SECONDS), START_WAIT_MS);
    } else {
      // Nothing to wait for: the sound begins now, as the playhead does.
      this.begin(0);
    }
    if (planned.length > 0) void this.feed(project, planned);
    this.scheduler = setInterval(() => void this.tick(), SCHEDULE_INTERVAL_MS);
  }

  /**
   * The first pass of every clip held whole, from the start: each one source
   * node to the clip's end or the loop's, started at `at` on the audio clock
   * or as far after it as the clip begins.
   */
  private layOutWholeClips(project: ProjectState, at: number): void {
    const fps = project.fps;
    const startSeconds = this.startedAtSeconds;
    const loopEnd = this.loop?.end ?? Infinity;
    const anySolo = hasSoloedTrack(project);
    const trackById = new Map(project.tracks.map((track) => [track.id, track]));

    for (const clip of Object.values(project.clips)) {
      const track = trackById.get(clip.trackId);
      // A muted or un-soloed track is still scheduled, at zero gain, so that
      // un-muting it mid-playback takes effect immediately instead of waiting
      // for the next seek.
      if (!track) continue;

      // A streamed source has no whole buffer to lay out: the scheduler
      // feeds it to the graph a few seconds at a time.
      if (this.streams.has(clip.sourceUri)) continue;

      const buffer = this.buffers.get(clip.sourceUri);
      if (!buffer) continue;
      // Backwards has no sound yet (see audioFollowsSpeed), and a picture
      // whose sound was separated leaves it to its sound clip.
      if (!clipSounds(clip)) continue;
      const rate = speedOf(clip);

      const clipStart = clip.startFrame / fps;
      const clipEnd = (clip.startFrame + clip.durationFrames) / fps;
      // Only up to the loop's end: the passes after it are the scheduler's.
      const until = Math.min(clipEnd, loopEnd);
      if (until <= startSeconds || clipStart >= loopEnd) continue;

      const trackStrip = this.ensureTrackStrip(track, anySolo);
      const strip = this.createStrip(trackStrip.gain, track.id, clip.id, buffer);
      strip.gain.gain.value = clipGain(clip);
      strip.panner.pan.value = panPosition(clip.pan);
      strip.low.gain.value = clip.eq.low;
      strip.mid.gain.value = clip.eq.mid;
      strip.high.gain.value = clip.eq.high;

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(strip.guard);
      strip.sources.push(source);

      const sourceOffset = clip.sourceOffsetFrames / fps;
      const whenSeconds = Math.max(0, clipStart - startSeconds);
      // Into the footage at the clip's own rate, and the stretch it needs
      // is that much longer or shorter than the time it fills.
      const offsetSeconds = sourceOffset + Math.max(0, startSeconds - clipStart) * rate;
      const durationSeconds = (until - Math.max(clipStart, startSeconds)) * rate;

      source.playbackRate.value = rate;
      // The fade rides on the clip's own gain, from wherever playback joins it.
      applyFadeEnvelope(
        strip.gain.gain,
        clip,
        clipGain(clip),
        at + whenSeconds,
        Math.max(0, startSeconds - clipStart),
        fps / rate,
      );
      this.schedulePan(strip, clip, at + whenSeconds, Math.max(0, startSeconds - clipStart), fps / rate);
      // Joined part-way through: in from silence rather than on whatever sample is there.
      if (clipStart < startSeconds - 1e-6) {
        // Silent from now, ahead of the start (see declickIn).
        strip.guard.gain.setValueAtTime(0, Math.min(this.context.currentTime, at));
        strip.guard.gain.setValueAtTime(0, at);
        strip.guard.gain.linearRampToValueAtTime(1, at + DECLICK_SECONDS);
      }
      // Sounding up to the loop's end: down to silence by the join.
      if (clipEnd >= loopEnd - 1e-6) this.declickOut(strip, at + (loopEnd - startSeconds));
      source.start(at + whenSeconds, offsetSeconds, durationSeconds);
      this.strips.set(clip.id, strip);
      this.fadedClips.add(clip.id);
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.scheduler !== null) {
      clearInterval(this.scheduler);
      this.scheduler = null;
    }
    // Where it stopped, wrapped into the loop, before the loop is forgotten.
    if (this.playing) {
      this.startedAtSeconds = this.positionSeconds;
      this.playing = false;
    }
    // A start still waiting for its sound waits no more, and holds the playhead no more.
    this.waiting = false;
    this.held = [];
    if (this.waitTimer !== null) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    clearPlaybackHold();
    this.loop = null;
    this.playingProject = null;
    this.scheduledUntil = new Map();
    this.fadedClips = new Set();

    /*
      Down to silence, then let go. Stopping a source on a sample that is not
      silent is the same step as starting on one: a click on every pause, and
      on every resync, which is a stop and a play. So each strip fades out
      from a moment ahead of the audio clock (SAFE_LEAD_SECONDS: a fade
      written at a time already gone would be a jump), its sources stop once
      it is silent, and the nodes are let go after that. The playback that
      follows builds strips of its own meanwhile.
    */
    const fadeFrom = this.context.currentTime + SAFE_LEAD_SECONDS;
    const silentAt = fadeFrom + 2 * DECLICK_SECONDS;
    const strips = [...this.strips.values()];
    const trackStrips = [...this.trackStrips.values()];
    for (const strip of strips) {
      // From wherever its own fades have it by then, down to nothing: a
      // target curve starts from the value the parameter has at its start,
      // and is under a thousandth by the time the sources stop. (Not
      // cancelAndHoldAtTime and a ramp: with no fade under way at that moment
      // Chromium held nothing, and the ramp ran on from the last fade written
      // - a second back - which dropped the sound to 2% at once: measured,
      // the same click as stopping dead.)
      strip.guard.gain.cancelScheduledValues(fadeFrom);
      strip.guard.gain.setTargetAtTime(0, fadeFrom, DECLICK_SECONDS / 4);
      for (const source of strip.sources) {
        try {
          // One due to start later than this never sounds at all.
          source.stop(silentAt);
        } catch {
          // A source that never started throws; nothing to clean up.
        }
      }
      strip.sources.length = 0;
    }
    this.strips.clear();
    this.trackStrips.clear();
    if (strips.length === 0 && trackStrips.length === 0) return;
    setTimeout(() => {
      for (const strip of strips) {
        strip.guard.disconnect();
        strip.edge.disconnect();
        strip.gain.disconnect();
        strip.low.disconnect();
        strip.mid.disconnect();
        strip.high.disconnect();
        strip.panner.disconnect();
      }
      for (const strip of trackStrips) {
        strip.gain.disconnect();
        strip.panner.disconnect();
        disconnectMeter(strip.meter);
      }
    }, (SAFE_LEAD_SECONDS + DECLICK_SECONDS) * 1000 + STOP_RELEASE_MS);
  }

  /**
   * Push the project's mixer values into the live graph.
   *
   * Nothing is rescheduled: a fader moved during playback has to be audible on
   * the next buffer, not after a seek. Ramps are short but not instant, because
   * stepping a gain discontinuously is a click. A clip whose sound was just
   * separated goes quiet here, the same way, while its sound clip comes in
   * with the next schedule.
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

    for (const strip of this.strips.values()) {
      const clip = project.clips[strip.clipId];
      if (!clip) continue;
      // An animated gain or pan is already written ahead of the playhead;
      // writing a single value over it would straighten the curve. Only
      // silencing it is still a live change, and an edit to the curve itself
      // comes back through needsRebuild.
      if (!clipSounds(clip)) strip.gain.gain.setTargetAtTime(0, now, 0.01);
      else if (!hasVolumeEnvelope(clip)) strip.gain.gain.setTargetAtTime(clipGain(clip), now, 0.01);
      if (!hasPanEnvelope(clip)) strip.panner.pan.setTargetAtTime(panPosition(clip.pan), now, 0.01);
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
    if (
      project.tracks.some((track) => {
        const strip = this.trackStrips.get(track.id);
        return strip !== undefined && strip.bus !== track.bus;
      })
    ) {
      return true;
    }
    // A gain or pan curve that was redrawn: see ClipStrip.envelope.
    for (const strip of this.strips.values()) {
      const clip = project.clips[strip.clipId];
      if (!clip || strip.envelope === undefined) continue;
      if (strip.envelope !== envelopeSignature(clip)) return true;
    }
    return false;
  }

  /**
   * The clip's stereo position over time, written onto its strip.
   *
   * The gain's curve goes on through applyFadeEnvelope, which has the fades to
   * combine with; pan has nothing riding on it, so it is written here. Both
   * leave their signature on the strip so an edit can be noticed.
   */
  private schedulePan(strip: ClipStrip, clip: Clip, when: number, offsetSeconds: number, framesPerSecond: number): void {
    strip.envelope = envelopeSignature(clip);
    const points = panPoints(clip);
    if (!points) return;
    scheduleEnvelope(strip.panner.pan, points, when, offsetSeconds, framesPerSecond);
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
      const strip = this.createStrip(trackStrip.gain, track.id, clip.id, buffer);
      // The grain's own frame, not the fader: on a clip whose sound is
      // animated those differ, and a scrub has to be heard as it will play.
      strip.panner.pan.value = panPosition(grain.pan);
      strip.low.gain.value = clip.eq.low;
      strip.mid.gain.value = clip.eq.mid;
      strip.high.gain.value = clip.eq.high;

      const level = clamp(grain.volume, 0, 2);
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
    const strip = this.createStrip(trackStrip.gain, track.id, clip.id, buffer);
    strip.panner.pan.value = panPosition(grain.pan);
    strip.low.gain.value = clip.eq.low;
    strip.mid.gain.value = clip.eq.mid;
    strip.high.gain.value = clip.eq.high;

    const level = clamp(grain.volume, 0, 2);
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
