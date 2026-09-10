import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  FrameRenderer,
  setActiveFrameRenderer,
} from '@renderer/engine/FrameRenderer';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Wires the WebGL compositor to the store.
 *
 * The draw happens once per animation frame off the store snapshot, so a burst
 * of updates during a drag still costs exactly one composite.
 */

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
  const showTransparencyGrid = useProjectStore((state) => state.ui.showTransparencyGrid);

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
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
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

    canvas.width = width;
    canvas.height = height;
    renderer.resize(width, height);
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

    const draw = (): void => {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(draw);

      const renderer = rendererRef.current;
      if (!renderer) return;

      const { project, ui } = useProjectStore.getState();

      try {
        renderer.drawViewport(project, ui.isPlaying, ui.pixelArtViewport);
      } catch (renderError) {
        cancelled = true;
        setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  return { renderer: rendererRef.current, error };
}
