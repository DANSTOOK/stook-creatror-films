import { useEffect, useRef } from 'react';
import type { MediaAsset } from '@shared/types';
import { AudioEngine } from '@renderer/audio/AudioEngine';
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
  const registered = useRef(new Set<string>());
  const rafRef = useRef<number | null>(null);

  const assets = useProjectStore((state) => state.assets);
  const isPlaying = useProjectStore((state) => state.ui.isPlaying);

  // The AudioContext starts suspended until a gesture resumes it, so creating
  // it up front costs nothing and keeps the decode path simple.
  useEffect(() => {
    engineRef.current = new AudioEngine();
    extractorRef.current = new WaveformExtractor();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      void engineRef.current?.dispose();
      engineRef.current = null;
      extractorRef.current = null;
      registered.current.clear();
      useMediaStore.getState().clear();
    };
  }, []);

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
          const bytes = await fetch(asset.uri).then((response) => response.arrayBuffer());

          // decodeAudioData detaches its input, so each consumer needs a copy.
          const [, peaks] = await Promise.all([
            engine.registerSource(asset.uri, bytes.slice(0)),
            extractor.extract(asset.uri, bytes),
          ]);

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
