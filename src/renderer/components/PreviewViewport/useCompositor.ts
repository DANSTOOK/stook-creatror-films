import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  FrameRenderer,
  setActiveFrameRenderer,
} from '@renderer/engine/FrameRenderer';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { scopesWanted, tickScopes } from '@renderer/scopes/scopeFeed';
import { cancelFrame, requestFrame } from '@renderer/timing/animationFrame';
import { useZoneEditStore } from '@renderer/fx/motion/zoneEdit';
import { withClipAtRest } from '@renderer/fx/motion/apply';
import { usePreviewQuality } from './previewQuality';

/**
 * Wires the WebGL compositor to the store.
 *
 * The draw happens at most once per animation frame off the store snapshot,
 * so a burst of updates during a drag still costs exactly one composite - and
 * only when there is something new to show (see SETTLE_MS).
 */

/**
 * When the viewer draws. It drew on every refresh of the screen: 179 times a
 * second on a 179 Hz laptop panel, paused or playing a 30 fps clip - and a
 * paused 4K edit is drawn at every one of its pixels - so the GPU spent
 * itself on copies of one picture (measured: 180 draws a second for every
 * format; a 4K 120 fps file had 293 of its frames dropped by the element in
 * five seconds). Now a frame is drawn when something it shows has changed:
 * the project (the playhead with it), the viewer's state, the zone being
 * aimed, the scopes opened or closed, or the picture itself
 * (FrameRenderer.pictureRevision: a video's new frame, a seek landed, an
 * image, a matte or a font loaded). Paused, every refresh for SETTLE_MS after
 * a change catches what lands soon after it, and a draw every KEEP_ALIVE_MS
 * is the net under anything that lands without a word.
 */
const SETTLE_MS = 400;
const KEEP_ALIVE_MS = 250;

export interface CompositorHandle {
  renderer: FrameRenderer | null;
  error: string | null;
}

export function useCompositor(canvasRef: RefObject<HTMLCanvasElement>): CompositorHandle {
  const [error, setError] = useState<string | null>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const rafRef = useRef<number | null>(null);

  const width = useProjectStore((state) => state.project.width);
  const height = useProjectStore((state) => state.project.height);
  const assets = useProjectStore((state) => state.assets);
  const pixelArtViewport = useProjectStore((state) => state.ui.pixelArtViewport);
  // The checkerboard shows what a transparent project exports: empty frame.
  // For every other project the empty frame is black, and so is the viewer.
  const showTransparencyGrid = useProjectStore((state) => state.project.hasAlphaBackground);

  // Create the GL objects once, bound to the canvas element.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const renderer = new FrameRenderer(canvas, canvas.width, canvas.height, {
        pixelArtViewport,
        showTransparencyGrid,
      });
      rendererRef.current = renderer;
      setActiveFrameRenderer(renderer);
      setError(null);
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : String(creationError));
    }

    return () => {
      if (rafRef.current !== null) cancelFrame(rafRef.current);
      rafRef.current = null;
      setActiveFrameRenderer(null);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // Bound to the canvas element for its whole lifetime; resolution and option
    // changes are applied by the effects below instead of recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);

  // Keep the framebuffers and the canvas backing store in step with the project.
  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer) return;
    renderer.resize(width, height);
  }, [canvasRef, width, height]);

  // How big the picture is on screen, in device pixels: playing, the viewer
  // draws no more than that (engine/previewSize.ts).
  const quality = usePreviewQuality((state) => state.quality);
  useEffect(() => {
    if (rendererRef.current) rendererRef.current.previewQuality = quality;
  }, [quality]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const box = canvas.getBoundingClientRect();
      const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
      // object-contain: the picture fills the box along one side.
      const fit = Math.min(box.width / width, box.height / height);
      renderer.displaySize = { width: width * fit * ratio, height: height * fit * ratio };
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    return () => observer.disconnect();
  }, [canvasRef, width, height]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.options = { pixelArtViewport, showTransparencyGrid };
    }
  }, [pixelArtViewport, showTransparencyGrid]);

  // Register newly imported assets so their elements start buffering.
  useEffect(() => {
    rendererRef.current?.registerAssets(assets);
  }, [assets]);

  // The render loop.
  useEffect(() => {
    let cancelled = false;
    // What the last draw was of, and when.
    let drawn: { project: unknown; ui: unknown; assets: unknown; zone: unknown; picture: number; scopes: boolean } | null = null;
    let drawnAt = -Infinity;
    let changedAt = -Infinity;
    // Since when a move of the playhead has waited for the video's frame (see below).
    let waitingSince: number | null = null;

    const draw = (now: number): void => {
      if (cancelled) return;
      rafRef.current = requestFrame(draw);

      const renderer = rendererRef.current;
      if (!renderer) return;

      const { project: edit, ui, assets: media } = useProjectStore.getState();
      const zone = useZoneEditStore.getState();
      const seen = { project: edit, ui, assets: media, zone, picture: renderer.pictureRevision, scopes: scopesWanted() };
      const changed =
        drawn === null ||
        seen.project !== drawn.project ||
        seen.ui !== drawn.ui ||
        seen.assets !== drawn.assets ||
        seen.zone !== drawn.zone ||
        seen.picture !== drawn.picture ||
        seen.scopes !== drawn.scopes;
      if (changed) changedAt = now;
      const settling = !ui.isPlaying && now - changedAt < SETTLE_MS;
      let due = changed || settling || now - drawnAt >= KEEP_ALIVE_MS;
      // Playing a video, the playhead moves a moment before the video presents
      // its next frame, and a draw for each drew every frame twice. A move of
      // the playhead alone waits for the frame, for most of a frame's time at
      // most - then it is drawn all the same (a still, a title, a decoder
      // running late). Up to 60 fps only: measured at 120, the element then
      // presented 102 frames a second instead of 112 - drawn on every change
      // it keeps up better.
      const playheadOnly =
        drawn !== null &&
        seen.project !== drawn.project &&
        seen.picture === drawn.picture &&
        seen.ui === drawn.ui &&
        seen.assets === drawn.assets &&
        seen.zone === drawn.zone &&
        seen.scopes === drawn.scopes;
      if (due && ui.isPlaying && playheadOnly && edit.fps <= 60 && renderer.media.anyPlaying) {
        waitingSince ??= now;
        if (now - waitingSince < 750 / Math.max(1, edit.fps)) due = false;
      }
      if (due) {
        waitingSince = null;
        drawn = seen;
        drawnAt = now;
      }

      // A zoom being aimed is drawn at rest, so its zone is drawn over the picture as it is.
      const aiming = zone.clipId;
      const project = aiming ? withClipAtRest(edit, media, aiming) : edit;

      try {
        if (due) {
          renderer.drawViewport(
            project,
            ui.isPlaying,
            ui.pixelArtViewport,
            { bypass: ui.gradeBypass, split: ui.compareSplit },
            ui.editingTitleId,
          );
        }
        // The video scopes read the last picture drawn, when they are open - on
        // every refresh, drawn or not: a reading is collected a frame or two
        // after it is asked for (Compositor.takeScopeCapture), and they judge
        // a late frame by the gap between refreshes. Called only on a draw,
        // every draw looked late to them and 4K playback gave 0.2 readings a
        // second instead of 10 to 15.
        tickScopes(renderer, project, ui.isPlaying, now);
      } catch (renderError) {
        cancelled = true;
        setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    };

    rafRef.current = requestFrame(draw);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  return { renderer: rendererRef.current, error };
}
