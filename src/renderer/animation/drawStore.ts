import { create } from 'zustand';
import type { BrushKind } from '@shared/types';
import type { ShapeKind } from './shapes';

/**
 * What the hand is holding.
 *
 * Kept apart from the project because none of it belongs in a saved film: the
 * brush, its colour, which layer is being drawn into and whether drawing is on
 * at all are the state of a tool, not of the animation. The strokes
 * themselves go into the project, one undo step each.
 */

export interface DrawState {
  /** The animation clip being drawn into; null when the tool is put away. */
  clipId: string | null;
  /** The layer strokes land on. Null means the topmost one, which is the usual. */
  layerId: string | null;
  /**
   * What the hand is doing: drawing by feel, or dragging out a shape.
   * A shape becomes an ordinary stroke, so nothing downstream knows the
   * difference (animation/shapes).
   */
  /**
   * Drawing, or moving a whole layer about on the picture - OpenToonz calls
   * the second one the Animate tool. They are different jobs: one makes the
   * drawing, the other places it, and a pointer cannot do both at once.
   */
  mode: 'draw' | 'animate';
  tool: 'freehand' | ShapeKind;
  /** Sides of a polygon, 3 to 12. */
  sides: number;
  brush: BrushKind;
  /** #rrggbb. */
  color: string;
  /** Width as a fraction of the frame's shorter side, as a stroke stores it. */
  size: number;
  opacity: number;
  /** Recent colours, most recent first: a hand reaches for the same few. */
  recent: string[];
  start(clipId: string, layerId?: string | null): void;
  stop(): void;
  pick(patch: { mode?: 'draw' | 'animate'; tool?: 'freehand' | ShapeKind; sides?: number; brush?: BrushKind; color?: string; size?: number; opacity?: number; layerId?: string | null }): void;
}

/** Sensible for a 1080p frame: about 6 px, which draws like a pencil. */
export const DEFAULT_SIZE = 0.006;
export const MIN_SIZE = 0.0008;
export const MAX_SIZE = 0.08;

const RECENT = 8;

export const useDrawStore = create<DrawState>((set) => ({
  clipId: null,
  layerId: null,
  mode: 'draw',
  tool: 'freehand',
  sides: 5,
  brush: 'pencil',
  color: '#ffffff',
  size: DEFAULT_SIZE,
  opacity: 1,
  recent: [],
  start: (clipId, layerId = null) => set({ clipId, layerId }),
  stop: () => set({ clipId: null, layerId: null }),
  pick: (patch) =>
    set((state) => ({
      ...state,
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.tool !== undefined ? { tool: patch.tool } : {}),
      ...(patch.sides !== undefined ? { sides: Math.min(12, Math.max(3, Math.round(patch.sides))) } : {}),
      ...(patch.brush !== undefined ? { brush: patch.brush } : {}),
      ...(patch.layerId !== undefined ? { layerId: patch.layerId } : {}),
      ...(patch.size !== undefined ? { size: Math.min(MAX_SIZE, Math.max(MIN_SIZE, patch.size)) } : {}),
      ...(patch.opacity !== undefined ? { opacity: Math.min(1, Math.max(0.05, patch.opacity)) } : {}),
      ...(patch.color !== undefined
        ? { color: patch.color, recent: [patch.color, ...state.recent.filter((old) => old !== patch.color)].slice(0, RECENT) }
        : {}),
    })),
}));
