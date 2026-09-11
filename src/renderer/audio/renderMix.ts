import type { Clip, MediaAsset, ProjectState, Track } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { encodeWavFloat32 } from '@shared/utils/wav';
import { clipGain, hasSoloedTrack, isTrackAudible, panPosition, trackGain } from './mixRouting';
import { duckOffline } from './DynamicDucking';

/**
 * Offline render of the timeline's audio for export.
 *
 * `OfflineAudioContext` renders as fast as it can rather than in real time, and
 * resolves with the finished `AudioBuffer` - so the whole mix is produced in one
 * pass instead of being captured live.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext
 *
 * The mix honours exactly what the timeline shows: clip trims via the source
 * offset, the mixer (clip volume/pan/EQ, track volume/pan, mute, solo, master)
 * and auto-ducking. It deliberately does NOT reuse the live `AudioEngine` -
 * that one is wired for playback against a realtime clock, and export needs
 * determinism - but both read their numbers from `mixRouting`, which is what
 * keeps the render and the monitor in agreement.
 */

/** 48 kHz is what YouTube asks for and what AAC encoders prefer. */
export const EXPORT_SAMPLE_RATE = 48_000;
export const EXPORT_CHANNELS = 2;

export interface RenderedMix {
  wav: ArrayBuffer;
  channels: number;
  sampleRate: number;
  durationSeconds: number;
  /** Clips that actually contributed, for reporting. */
  clipsMixed: number;
  /** Peak absolute sample, so a silent result is detectable. */
  peak: number;
  /**
   * Lowest gain auto-ducking applied to the music bus, or 1 when ducking was
   * off or had no dialogue to key off. "Enabled" and "audible" are separate
   * claims, and this is the one that can be reported honestly.
   */
  duckFloor: number;
}

/** Decode every distinct audio-bearing source once. */
async function decodeSources(
  context: BaseAudioContext,
  assets: readonly MediaAsset[],
  uris: ReadonlySet<string>,
): Promise<Map<string, AudioBuffer>> {
  const decoded = new Map<string, AudioBuffer>();

  await Promise.all(
    assets
      .filter((asset) => uris.has(asset.uri) && !asset.missing && asset.kind !== 'image')
      .map(async (asset) => {
        try {
          // The extracted audio track, not the (possibly multi-gigabyte) video.
          const bytes = await fetch(asset.audioUri ?? asset.uri).then((response) =>
            response.arrayBuffer(),
          );
          decoded.set(asset.uri, await context.decodeAudioData(bytes));
        } catch {
          // A video with no audio track is the common case, not an error.
        }
      }),
  );

  return decoded;
}

interface MixGeometry {
  fps: number;
  startFrame: number;
  durationSeconds: number;
  length: number;
  sampleRate: number;
  channels: number;
}

interface BusRender {
  planar: Float32Array[];
  clipsMixed: number;
}

/**
 * Render one set of clips into its own buffer.
 *
 * Called once for the whole timeline normally, and twice when ducking is on:
 * music and dialogue have to exist as separate signals before one of them can
 * be used to push the other down.
 */
async function renderClips(
  clips: readonly Clip[],
  trackById: ReadonlyMap<string, Track>,
  buffers: ReadonlyMap<string, AudioBuffer>,
  anySolo: boolean,
  geometry: MixGeometry,
): Promise<BusRender> {
  const { fps, startFrame, durationSeconds, length, sampleRate, channels } = geometry;
  const context = new OfflineAudioContext(channels, length, sampleRate);

  // One strip per track, built lazily, so a track fader applies once to the sum
  // of its clips rather than once per clip.
  const trackStrips = new Map<string, GainNode>();
  const stripFor = (track: Track): GainNode => {
    const existing = trackStrips.get(track.id);
    if (existing) return existing;

    const gain = context.createGain();
    gain.gain.value = trackGain(track, anySolo);

    const panner = context.createStereoPanner();
    panner.pan.value = panPosition(track.pan);

    gain.connect(panner);
    panner.connect(context.destination);
    trackStrips.set(track.id, gain);
    return gain;
  };

  let clipsMixed = 0;

  for (const clip of clips) {
    const track = trackById.get(clip.trackId);
    const buffer = buffers.get(clip.sourceUri);
    if (!track || !buffer) continue;

    // Clip position expressed relative to the start of the export range.
    const clipStartSeconds = (clip.startFrame - startFrame) / fps;
    const clipEndSeconds = (clip.startFrame + clip.durationFrames - startFrame) / fps;

    // Trimmed-off head: skip that much further into the source instead.
    const skippedSeconds = Math.max(0, -clipStartSeconds);
    const when = Math.max(0, clipStartSeconds);
    const offset = clip.sourceOffsetFrames / fps + skippedSeconds;

    const playSeconds = Math.min(clipEndSeconds, durationSeconds) - when;
    if (playSeconds <= 0 || offset >= buffer.duration) continue;

    const source = context.createBufferSource();
    source.buffer = buffer;

    const gain = context.createGain();
    gain.gain.value = clipGain(clip);

    // Same node order as the live engine: gain, three EQ bands, pan.
    const low = context.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 120;
    low.gain.value = clip.eq.low;

    const mid = context.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.9;
    mid.gain.value = clip.eq.mid;

    const high = context.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 8000;
    high.gain.value = clip.eq.high;

    const panner = context.createStereoPanner();
    panner.pan.value = panPosition(clip.pan);

    source.connect(gain);
    gain.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(panner);
    panner.connect(stripFor(track));

    source.start(when, offset, Math.min(playSeconds, buffer.duration - offset));
    clipsMixed += 1;
  }

  const rendered = await context.startRendering();

  const planar: Float32Array[] = [];
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    planar.push(rendered.getChannelData(channel));
  }

  return { planar, clipsMixed };
}

/**
 * Render the audio under `[startFrame, endFrame)` and encode it as WAV.
 *
 * Returns `null` when the range contains no audible material, so the caller can
 * mux a video-only file rather than a file with a silent track.
 */
export async function renderTimelineAudio(
  project: ProjectState,
  assets: readonly MediaAsset[],
  startFrame: number,
  endFrame: number,
  options: { sampleRate?: number; channels?: number; padFrames?: number } = {},
): Promise<RenderedMix | null> {
  const sampleRate = options.sampleRate ?? EXPORT_SAMPLE_RATE;
  const channels = options.channels ?? EXPORT_CHANNELS;

  const { fps } = project;
  const rangeFrames = Math.max(0, endFrame - startFrame);
  if (rangeFrames === 0) return null;

  // Exactly the picture duration, no padding. The muxer cannot use `-shortest`
  // to trim a tail, because an Annex-B video stream reaches it with no
  // timestamps - so the two inputs have to line up here instead.
  const padFrames = options.padFrames ?? 0;
  const durationSeconds = (rangeFrames + padFrames) / fps;
  const length = Math.ceil(durationSeconds * sampleRate);

  const trackById = new Map(project.tracks.map((track) => [track.id, track]));
  const anySolo = hasSoloedTrack(project);

  // Clips that overlap the export range at all, on tracks that are audible.
  const audible = Object.values(project.clips).filter((clip) => {
    const track = trackById.get(clip.trackId);
    if (!track || !isTrackAudible(track, anySolo)) return false;
    return clip.startFrame < endFrame && clip.startFrame + clip.durationFrames > startFrame;
  });

  if (audible.length === 0) return null;

  const decodeContext = new OfflineAudioContext(channels, Math.max(1, length), sampleRate);
  const buffers = await decodeSources(
    decodeContext,
    assets,
    new Set(audible.map((clip) => clip.sourceUri)),
  );

  if (buffers.size === 0) return null;

  const geometry: MixGeometry = {
    fps,
    startFrame,
    durationSeconds,
    length,
    sampleRate,
    channels,
  };

  const onBus = (bus: Track['bus']): Clip[] =>
    audible.filter((clip) => trackById.get(clip.trackId)?.bus === bus);

  const dialogue = onBus('dialogue');
  const ducking = project.audio.ducking;
  // Ducking with nothing on the dialogue bus is a second render that can only
  // ever produce a gain of exactly 1, so it is skipped rather than paid for.
  const duckingApplies = ducking.enabled && dialogue.length > 0;

  let planar: Float32Array[];
  let clipsMixed: number;
  let duckFloor = 1;

  if (duckingApplies) {
    const [musicMix, dialogueMix] = await Promise.all([
      renderClips(onBus('music'), trackById, buffers, anySolo, geometry),
      renderClips(dialogue, trackById, buffers, anySolo, geometry),
    ]);

    duckFloor = duckOffline(musicMix.planar, dialogueMix.planar, sampleRate, ducking);

    // Sum the two buses back together once the music has been pulled down.
    planar = musicMix.planar;
    for (let channel = 0; channel < planar.length; channel += 1) {
      const music = planar[channel];
      const speech = dialogueMix.planar[channel];
      for (let i = 0; i < music.length; i += 1) music[i] += speech[i];
    }

    clipsMixed = musicMix.clipsMixed + dialogueMix.clipsMixed;
  } else {
    const mix = await renderClips(audible, trackById, buffers, anySolo, geometry);
    planar = mix.planar;
    clipsMixed = mix.clipsMixed;
  }

  if (clipsMixed === 0) return null;

  // Master gain is arithmetic here rather than a node, so both paths share one
  // line of it instead of two graphs that could drift apart.
  const master = clamp(project.audio.masterVolume, 0, 2);
  let peak = 0;
  for (const channel of planar) {
    for (let i = 0; i < channel.length; i += 1) {
      if (master !== 1) channel[i] *= master;
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }

  return {
    wav: encodeWavFloat32(planar, sampleRate),
    channels: planar.length,
    sampleRate,
    durationSeconds: length / sampleRate,
    clipsMixed,
    peak,
    duckFloor,
  };
}
