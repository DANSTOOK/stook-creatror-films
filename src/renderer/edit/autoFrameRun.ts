import type { Clip, MediaAsset } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { matteEntry, useMattes } from '@renderer/matting/mattes';
import { trackSubject } from './reframeRun';
import { applyFollow } from './trackApply';
import { DEFAULT_AUTO_FRAME, planAutoFrame, type AutoFrameOptions, type HeadSample } from './autoFrame';

/**
 * Making the camera follow the person in EVERY clip, in one go.
 *
 * The card in the inspector does one clip, which is right when a single shot
 * needs it and wrong for an interview cut from forty. This is the same work
 * across the whole timeline, and the saving is not the clicking: a people matte
 * is made per FILE, and three clips cut from one take share one. Analysing per
 * clip would run the model three times over the same footage.
 *
 * One undo step for the lot, because a follow that framed badly everywhere
 * wants one Ctrl+Z.
 *
 * A clip the follow cannot help - no matte to be had, nobody in it, or no room
 * to pan at the tightness asked - is left exactly as it was and counted, rather
 * than half-followed or quietly skipped.
 */

export interface AutoFrameRunProgress {
  /** Files analysed so far, and how many there are. */
  done: number;
  total: number;
  /** The file being analysed now. */
  name: string;
}

export interface AutoFrameRunResult {
  followed: number;
  /** Clips left alone, and why, for the dialog to say so. */
  skipped: { nobody: number; noRoom: number; noMatte: number };
}

/** The clips this can work on: pictures from a video file, not titles or sound. */
export function autoFrameableClips(): Array<{ clip: Clip; asset: MediaAsset }> {
  const { project, assets } = useProjectStore.getState();
  const visual = new Set(project.tracks.filter((track) => track.type === 'video').map((track) => track.id));
  const out: Array<{ clip: Clip; asset: MediaAsset }> = [];
  for (const clip of Object.values(project.clips)) {
    if (!visual.has(clip.trackId) || clip.title || clip.caption || clip.audioOnly) continue;
    const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
    if (!asset || asset.kind !== 'video' || !asset.sourcePath || !asset.width || !asset.height) continue;
    out.push({ clip, asset });
  }
  return out;
}

export async function runAutoFrame(
  options: Partial<AutoFrameOptions> = {},
  onProgress?: (progress: AutoFrameRunProgress) => void,
): Promise<AutoFrameRunResult> {
  const settings: AutoFrameOptions = { ...DEFAULT_AUTO_FRAME, ...options };
  const work = autoFrameableClips();
  const result: AutoFrameRunResult = { followed: 0, skipped: { nobody: 0, noRoom: 0, noMatte: 0 } };
  if (work.length === 0) return result;

  // Each file once, however many clips came out of it.
  const files = [...new Map(work.map(({ asset }) => [asset.sourcePath!, asset])).values()];
  const mattes = useMattes.getState();
  const urls = new Map<string, string>();
  for (const [index, asset] of files.entries()) {
    onProgress?.({ done: index, total: files.length, name: asset.name });
    const entry = matteEntry(asset.sourcePath!, 'fast');
    try {
      if (!(entry in useMattes.getState().urls)) await mattes.lookup(asset.sourcePath!, 'fast');
      if (!useMattes.getState().urls[entry]) await mattes.analyse(asset, 'fast');
    } catch {
      // Counted below, with the clips that came from this file.
    }
    const url = useMattes.getState().urls[entry];
    if (url) urls.set(asset.sourcePath!, url);
  }
  onProgress?.({ done: files.length, total: files.length, name: '' });

  // Read and applied clip by clip, after every file is analysed: the history
  // step covers the writing only, so a cancel while analysing leaves nothing
  // half-done on the timeline.
  const mark = useHistoryStore.getState().undoStack.length;
  for (const { clip, asset } of work) {
    const url = urls.get(asset.sourcePath!);
    if (!url) {
      result.skipped.noMatte += 1;
      continue;
    }
    const store = useProjectStore.getState();
    const current = store.project.clips[clip.id];
    if (!current) continue;
    const tracked = await trackSubject(url, current, store.project.fps);
    const samples: HeadSample[] = tracked.map((sample) => ({ t: sample.t, x: sample.headX, y: sample.headY }));
    if (!samples.some((sample) => sample.x !== null)) {
      result.skipped.nobody += 1;
      continue;
    }
    const plan = planAutoFrame(store.project, current, asset, samples, settings);
    if (!plan) {
      result.skipped.noRoom += 1;
      continue;
    }
    applyFollow(clip.id, plan.position, current.startFrame, plan.scale);
    result.followed += 1;
  }
  if (result.followed > 0) useHistoryStore.getState().squash(mark, 'Follow the face');
  return result;
}
