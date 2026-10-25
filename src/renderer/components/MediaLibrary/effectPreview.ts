import { useEffect, useState } from 'react';
import type { Clip, ProjectState } from '@shared/types';
import { ADJUSTMENT_URI } from '@renderer/edit/adjustment';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { motionQuiet } from '@renderer/motion/environment';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { setEffectSource } from './effectThumbs';

/**
 * What the Effects panel's tiles show the effects on: a frame of the clip an
 * effect would land on, as it looks now - so a tile is what that clip would
 * look like with it, CapCut's previews on one's own footage - or, asked for
 * or with no clip to land on, the sample scene.
 *
 * The frame is the clip on its own (no title or sticker of another track
 * over it), at the playhead when the playhead is on it, else at its middle.
 * It is taken half a second after the playhead and the selection settle,
 * and never while the preview plays or a render runs: the picture comes
 * first, the tiles can wait.
 */

export type PreviewMode = 'clip' | 'sample';

const MODE_KEY = 'scf.effectPreview';
/** How long the playhead and the selection rest before the frame is taken. */
const SETTLE_MS = 500;

export function loadPreviewMode(): PreviewMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'sample' ? 'sample' : 'clip';
  } catch {
    return 'clip';
  }
}

function savePreviewMode(mode: PreviewMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Remembered for this session only.
  }
}

/**
 * The clip an effect lands on: the selected one, or failing that the clip
 * under the playhead on the topmost visual track - the one the viewer draws.
 */
export function targetClip(state: { project: ProjectState; ui: { selectedClipIds: string[] } }): Clip | null {
  const { project, ui } = state;
  if (ui.selectedClipIds.length === 1) return project.clips[ui.selectedClipIds[0]] ?? null;
  const order = new Map(project.tracks.map((track) => [track.id, track]));
  const visual = (clip: Clip): boolean => {
    const type = order.get(clip.trackId)?.type;
    return type !== undefined && type !== 'audio' && type !== 'captions';
  };
  const under = Object.values(project.clips).filter(
    (clip) => visual(clip) && project.currentFrame >= clip.startFrame && project.currentFrame < clip.startFrame + clip.durationFrames,
  );
  if (under.length === 0) return null;
  // Topmost: the track drawn last sits on top (Compositor sorts by order).
  return under.sort((a, b) => (order.get(b.trackId)?.order ?? 0) - (order.get(a.trackId)?.order ?? 0))[0];
}

/** The frame of `clip` the tiles show: the playhead's when it is on the clip, else the clip's middle. */
export function previewFrame(project: ProjectState, clip: Clip): number {
  const inside = project.currentFrame >= clip.startFrame && project.currentFrame < clip.startFrame + clip.durationFrames;
  return inside ? project.currentFrame : clip.startFrame + Math.floor(clip.durationFrames / 2);
}

/** A number for each version of a clip: an edit makes a new object, and so a new frame to take. */
const revisions = new WeakMap<Clip, number>();
let nextRevision = 1;
const revisionOf = (clip: Clip): number => {
  let revision = revisions.get(clip);
  if (revision === undefined) {
    revision = nextRevision;
    nextRevision += 1;
    revisions.set(clip, revision);
  }
  return revision;
};

/**
 * `clip` at `frame`, as the export would draw it, on its own: its track alone,
 * with only it on it. An adjustment layer has no picture of its own, so for
 * one the whole frame is taken - what its effects would be put on.
 */
async function takeFrame(project: ProjectState, clip: Clip, frame: number): Promise<HTMLCanvasElement | null> {
  const renderer = getActiveFrameRenderer();
  if (!renderer || renderer.isExclusive) return null;
  const alone = clip.sourceUri === ADJUSTMENT_URI
    ? project
    : { ...project, tracks: project.tracks.filter((track) => track.id === clip.trackId), clips: { [clip.id]: clip }, transitions: {} };
  renderer.beginExclusive();
  try {
    // The first exact render of a file can arrive before its seek has landed; the second is the picture.
    await renderer.renderExact(alone, frame, false);
    const rgba = await renderer.renderExact(alone, frame, false);
    const canvas = document.createElement('canvas');
    canvas.width = project.width;
    canvas.height = project.height;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), project.width, project.height), 0, 0);
    return canvas;
  } catch {
    return null;
  } finally {
    renderer.endExclusive();
  }
}

export interface EffectPreview {
  mode: PreviewMode;
  setMode(mode: PreviewMode): void;
  /** The clip the tiles show, and when in it, once its frame is in: null while they show the sample. */
  shown: { name: string; seconds: number } | null;
  /** What the tiles show now, for the tests: "sample", or the clip, its frame and its version. */
  key: string;
}

/** Keeps the tiles' picture on the clip an effect would land on, while the Effects panel is open. */
export function useEffectPreview(): EffectPreview {
  const [mode, setModeState] = useState<PreviewMode>(loadPreviewMode);
  const [shown, setShown] = useState<EffectPreview['shown']>(null);
  const [key, setKey] = useState('sample');

  useEffect(() => {
    if (mode === 'sample') {
      setEffectSource(null, 0, 0, 'sample');
      setShown(null);
      setKey('sample');
      return undefined;
    }
    let alive = true;
    let timer = 0;
    let wanted = '';
    let taking = false;
    const take = async (): Promise<void> => {
      timer = 0;
      const state = useProjectStore.getState();
      // Playing or rendering: the picture comes first. Tried again once that stops.
      if (state.ui.isPlaying || motionQuiet()) return;
      const clip = targetClip(state);
      if (!clip) {
        setEffectSource(null, 0, 0, 'sample');
        setShown(null);
        setKey('sample');
        return;
      }
      const { project } = state;
      const frame = previewFrame(project, clip);
      const next = `${clip.id}@${frame}#${revisionOf(clip)}:${project.width}x${project.height}`;
      if (next === wanted) return;
      // One frame at a time: a change while one is being taken is looked at once it is in.
      if (taking) {
        schedule();
        return;
      }
      taking = true;
      const picture = await takeFrame(project, clip, frame);
      taking = false;
      if (!alive) return;
      if (!picture) {
        // The renderer is busy (a render) or the frame would not draw: try again when things settle.
        schedule();
        return;
      }
      wanted = next;
      setEffectSource(picture, picture.width, picture.height, next);
      setShown({ name: clip.name, seconds: frame / project.fps });
      setKey(next);
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void take(), SETTLE_MS);
    };
    schedule();
    const unsubscribe = useProjectStore.subscribe((state, previous) => {
      if (
        state.project.currentFrame !== previous.project.currentFrame ||
        state.project.clips !== previous.project.clips ||
        state.ui.selectedClipIds !== previous.ui.selectedClipIds ||
        state.ui.isPlaying !== previous.ui.isPlaying
      ) {
        schedule();
      }
    });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [mode]);

  const setMode = (next: PreviewMode): void => {
    savePreviewMode(next);
    setModeState(next);
  };
  return { mode, setMode, shown: mode === 'clip' ? shown : null, key };
}
