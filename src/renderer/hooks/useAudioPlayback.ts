import { useEffect, useRef } from 'react';
import type { MediaAsset } from '@shared/types';
import { AudioEngine } from '@renderer/audio/AudioEngine';
import { DynamicDucking } from '@renderer/audio/DynamicDucking';
import { mixSignature } from '@renderer/audio/mixRouting';
import { WaveformExtractor } from '@renderer/audio/WaveformExtractor';
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

export function useAudioPlayback(): void {
  const engineRef = useRef<AudioEngine | null>(null);
  const extractorRef = useRef<WaveformExtractor | null>(null);
  const duckingRef = useRef<DynamicDucking | null>(null);
  const registered = useRef(new Set<string>());
  const rafRef = useRef<number | null>(null);

  const assets = useProjectStore((state) => state.assets);
  const isPlaying = useProjectStore((state) => state.ui.isPlaying);
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
          // source file can be gigabytes of pictures. Buffers stay keyed by the
          // asset's URI, which is what clips reference.
          const bytes = await fetch(asset.audioUri ?? asset.uri).then((response) =>
            response.arrayBuffer(),
          );

          // Decoded once, and the waveform is read off that same buffer.
          const buffer = await engine.registerSource(asset.uri, bytes);
          const peaks = extractor.fromBuffer(asset.uri, buffer);

          if (!cancelled) useMediaStore.getState().setWaveform(asset.uri, peaks);
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

  // Start and stop with the transport, and recover from scrubs.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    if (!isPlaying) {
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
  }, [isPlaying]);
}
