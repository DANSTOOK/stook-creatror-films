import { useEffect, useRef } from 'react';
import type { MediaAsset } from '@shared/types';
import { AudioEngine } from '@renderer/audio/AudioEngine';
import { DynamicDucking } from '@renderer/audio/DynamicDucking';
import { mixSignature } from '@renderer/audio/mixRouting';
import { GRAIN_INTERVAL_MS, onScrub, planScrubGrains } from '@renderer/audio/scrubAudio';
import { AudioStream } from '@renderer/audio/AudioStream';
import {
  bucketsFor,
  PeakAccumulator,
  WaveformExtractor,
  type WaveformPeaks,
} from '@renderer/audio/WaveformExtractor';
import { useMediaStore } from '@renderer/store/useMediaStore';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Connects the audio subsystem to the transport.
 *
 * Video elements are kept muted - they exist to supply frames - so every
 * audible sample comes from here, scheduled against the `AudioContext` clock.
 *
 * Waveform peaks are computed off the same decoded bytes while we already have
 * them, rather than decoding a second time when the timeline wants to draw.
 */

/** Playhead divergence beyond this many seconds means the user scrubbed. */
const RESYNC_THRESHOLD_SECONDS = 0.35;

/** Seconds of audio read at a time while measuring a waveform. */
const PEAK_PASS_SECONDS = 4;

/**
 * Waveform peaks from a streamed source, without ever holding it whole.
 *
 * The peaks span the whole file, so they need every sample - but only one
 * pass of them. This walks the source forwards, folds each stretch into the
 * min/max pairs and lets it go, which is what keeps a 45-minute import from
 * costing a gigabyte just to draw a waveform.
 */
async function peaksFromStream(
  stream: AudioStream,
  uri: string,
  extractor: WaveformExtractor,
): Promise<WaveformPeaks> {
  const { duration, sampleRate } = stream;
  const accumulator = new PeakAccumulator(
    bucketsFor(duration),
    Math.max(1, Math.round(duration * sampleRate)),
    sampleRate,
  );

  for (let at = 0; at < duration; at += PEAK_PASS_SECONDS) {
    const seconds = Math.min(PEAK_PASS_SECONDS, duration - at);
    const span = await stream.span(at, seconds);
    accumulator.add(span.planes, Math.round(at * sampleRate));
  }

  const peaks = accumulator.finish();
  extractor.set(uri, peaks);
  return peaks;
}

export function useAudioPlayback(): void {
  const engineRef = useRef<AudioEngine | null>(null);
  const extractorRef = useRef<WaveformExtractor | null>(null);
  const duckingRef = useRef<DynamicDucking | null>(null);
  const registered = useRef(new Set<string>());
  const rafRef = useRef<number | null>(null);

  const assets = useProjectStore((state) => state.assets);
  const isPlaying = useProjectStore((state) => state.ui.isPlaying);
  // Shuttling with J and L is a search through the picture: the sound cannot
  // follow at 2x or backwards, and trying leaves the engine rescheduling on
  // every frame, which is worse than silence.
  const playbackRate = useProjectStore((state) => state.ui.playbackRate);
  // Only the mixer-relevant part of the project, as a comparable string: the
  // project object itself is replaced on every scrub, and rebuilding the audio
  // graph once per frame of playhead movement is not something to do.
  const mixKey = useProjectStore((state) => mixSignature(state.project));

  // The AudioContext starts suspended until a gesture resumes it, so creating
  // it up front costs nothing and keeps the decode path simple.
  useEffect(() => {
    engineRef.current = new AudioEngine();
    extractorRef.current = new WaveformExtractor();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      duckingRef.current?.dispose();
      duckingRef.current = null;
      void engineRef.current?.dispose();
      engineRef.current = null;
      extractorRef.current = null;
      registered.current.clear();
      useMediaStore.getState().clear();
    };
  }, []);

  /**
   * Push the mixer into the live graph.
   *
   * Auto-ducking is created and torn down here rather than living for the whole
   * session: it holds a `requestAnimationFrame` loop writing to the music bus,
   * and leaving that running with the feature switched off would keep the bus
   * gain under its control forever.
   */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const { project, ui } = useProjectStore.getState();

    // A track that changed bus cannot be re-pointed live, so the schedule is
    // rebuilt - but only then, since rebuilding restarts every source.
    if (ui.isPlaying && engine.needsRebuild(project)) {
      engine.play(project, project.currentFrame);
    }

    engine.applyMix(project);

    const ducking = project.audio.ducking;
    if (ducking.enabled) {
      if (!duckingRef.current) {
        duckingRef.current = new DynamicDucking(
          engine.context,
          engine.dialogueBus,
          engine.musicBus,
          ducking,
        );
        duckingRef.current.start();
      } else {
        duckingRef.current.params = ducking;
      }
    } else if (duckingRef.current) {
      duckingRef.current.dispose();
      duckingRef.current = null;
    }
  }, [mixKey]);

  // Decode newly imported assets once: samples for playback, peaks for drawing.
  useEffect(() => {
    const engine = engineRef.current;
    const extractor = extractorRef.current;
    if (!engine || !extractor) return;

    const audible = (asset: MediaAsset): boolean =>
      !asset.missing && (asset.kind === 'audio' || asset.kind === 'video');

    let cancelled = false;

    const decodeAll = async (): Promise<void> => {
      for (const asset of assets.filter(audible)) {
        if (cancelled || registered.current.has(asset.uri)) continue;
        registered.current.add(asset.uri);

        const media = useMediaStore.getState();
        media.beginAnalysis(asset.uri);

        try {
          // The extracted audio track when there is one: megabytes, where the
          // source file can be gigabytes of pictures. Everything stays keyed
          // by the asset's URI, which is what clips reference.
          const audioUrl = asset.audioUri ?? asset.uri;

          // Streamed when the file allows it (AAC in MP4, which is what the
          // extraction writes): playback then holds a window of about 11 MB
          // instead of the whole source, which for 45 minutes was a gigabyte.
          const stream = await AudioStream.open(audioUrl);

          if (stream) {
            engine.registerStream(asset.uri, stream);
            const peaks = await peaksFromStream(stream, asset.uri, extractor);
            if (!cancelled) useMediaStore.getState().setWaveform(asset.uri, peaks);
          } else {
            // Anything else - MP3, WAV, FLAC, a bare .aac - is decoded whole,
            // as it always was, and the waveform read off that same buffer.
            const bytes = await fetch(audioUrl).then((response) => response.arrayBuffer());
            const buffer = await engine.registerSource(asset.uri, bytes);
            const peaks = extractor.fromBuffer(asset.uri, buffer);
            if (!cancelled) useMediaStore.getState().setWaveform(asset.uri, peaks);
          }
        } catch {
          // A video with no audio track is the common case here, not an error.
        } finally {
          useMediaStore.getState().endAnalysis(asset.uri);
        }
      }
    };

    void decodeAll();
    return () => {
      cancelled = true;
    };
  }, [assets]);

  // Sound under a dragged playhead. At most one grain per GRAIN_INTERVAL_MS:
  // pointer events come faster than grains can be heard, so a burst only
  // moves where the next grain plays from - and the last position of a drag
  // always sounds, even if it arrived inside the interval.
  useEffect(() => {
    let lastGrainAt = -Infinity;
    let pendingFrame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const play = (frame: number): void => {
      const engine = engineRef.current;
      const { project, ui } = useProjectStore.getState();
      if (!engine || ui.isPlaying) return;
      lastGrainAt = performance.now();
      const grains = planScrubGrains(project, frame, (uri) => engine.hasAudio(uri));
      engine.scrub(project, grains);
      // Test instrumentation, off unless a test asks for it.
      const stats = (window as { __scfScrubStats?: { grains: number } }).__scfScrubStats;
      if (stats) stats.grains += grains.length;
    };

    const off = onScrub((frame) => {
      const wait = GRAIN_INTERVAL_MS - (performance.now() - lastGrainAt);
      if (wait <= 0) {
        play(frame);
        return;
      }
      pendingFrame = frame;
      timer ??= setTimeout(() => {
        timer = null;
        if (pendingFrame !== null) play(pendingFrame);
        pendingFrame = null;
      }, wait);
    });

    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Start and stop with the transport, and recover from scrubs.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    if (!isPlaying || playbackRate !== 1) {
      engine.stop();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }

    const { project } = useProjectStore.getState();
    engine.play(project, project.currentFrame);

    // The audio clock is authoritative for its own position; when the timeline
    // playhead diverges from it the user moved the playhead, so audio is
    // rescheduled from the new position rather than left drifting.
    const watch = (): void => {
      rafRef.current = requestAnimationFrame(watch);

      const current = useProjectStore.getState();
      if (!current.ui.isPlaying) return;

      const timelineSeconds = current.project.currentFrame / current.project.fps;
      if (Math.abs(timelineSeconds - engine.positionSeconds) > RESYNC_THRESHOLD_SECONDS) {
        engine.play(current.project, current.project.currentFrame);
      }
    };

    rafRef.current = requestAnimationFrame(watch);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, playbackRate]);
}
