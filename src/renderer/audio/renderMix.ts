import type { MediaAsset, ProjectState } from '@shared/types';
import { clamp } from '@shared/utils/math';
import { encodeWavFloat32 } from '@shared/utils/wav';

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
 * offset, per-clip volume, and muted tracks. It deliberately does NOT reuse the
 * live `AudioEngine` - that one is wired for playback against a realtime clock,
 * and export needs determinism.
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
          const bytes = await fetch(asset.uri).then((response) => response.arrayBuffer());
          decoded.set(asset.uri, await context.decodeAudioData(bytes));
        } catch {
          // A video with no audio track is the common case, not an error.
        }
      }),
  );

  return decoded;
}

/**
 * Render the audio under `[startFrame, endFrame)` and encode it as WAV.
 *
 * Returns `null` when the range contains no audible material, so the caller can
 * mux a video-only file rather than an file with a silent track.
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

  // Clips that overlap the export range at all, on tracks that are not muted.
  const audible = Object.values(project.clips).filter((clip) => {
    const track = trackById.get(clip.trackId);
    if (!track || track.muted) return false;
    return clip.startFrame < endFrame && clip.startFrame + clip.durationFrames > startFrame;
  });

  if (audible.length === 0) return null;

  const context = new OfflineAudioContext(channels, length, sampleRate);
  const buffers = await decodeSources(
    context,
    assets,
    new Set(audible.map((clip) => clip.sourceUri)),
  );

  if (buffers.size === 0) return null;

  const master = context.createGain();
  master.gain.value = 1;
  master.connect(context.destination);

  let clipsMixed = 0;

  for (const clip of audible) {
    const buffer = buffers.get(clip.sourceUri);
    if (!buffer) continue;

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
    gain.gain.value = clamp(clip.volume, 0, 2);

    source.connect(gain);
    gain.connect(master);

    source.start(when, offset, Math.min(playSeconds, buffer.duration - offset));
    clipsMixed += 1;
  }

  if (clipsMixed === 0) return null;

  const rendered = await context.startRendering();

  const planar: Float32Array[] = [];
  let peak = 0;
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    const data = rendered.getChannelData(channel);
    planar.push(data);
    for (let i = 0; i < data.length; i += 1) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }

  return {
    wav: encodeWavFloat32(planar, sampleRate),
    channels: rendered.numberOfChannels,
    sampleRate,
    durationSeconds: rendered.duration,
    clipsMixed,
    peak,
  };
}
