import type { Clip } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { buildAsset } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { t } from '@renderer/i18n';
import { freezeSourceAt } from './freeze';

/**
 * Freeze frame, run: the clip's picture at the playhead drawn exactly as the
 * export would draw it - its colour, effects, size and place - saved as a
 * still in the app's folder, and held there for two seconds with what follows
 * moved along (edit/freeze.ts). One undo step for all of it.
 */

export const FREEZE_SECONDS = 2;

const isPicture = (clip: Clip): boolean => {
  const asset = useProjectStore.getState().assets.find((candidate) => candidate.uri === clip.sourceUri);
  return asset?.kind === 'video' && !clip.audioOnly && !clip.title && !clip.caption;
};

/** Whether there is a clip to freeze at the playhead (the selected one, or the topmost picture). */
export function canFreezeAtPlayhead(clipId?: string): boolean {
  const { project, ui } = useProjectStore.getState();
  return Boolean(freezeSourceAt(project, clipId ? [clipId] : ui.selectedClipIds, project.currentFrame, isPicture));
}

export async function freezeFrame(clipId?: string): Promise<string | null> {
  const { project, ui } = useProjectStore.getState();
  const frame = project.currentFrame;
  const source = freezeSourceAt(project, clipId ? [clipId] : ui.selectedClipIds, frame, isPicture);
  const renderer = getActiveFrameRenderer();
  if (!source || !renderer || typeof window === 'undefined' || !window.filmora?.saveStill) {
    notify(t('freeze.none'), 'info');
    return null;
  }
  try {
    renderer.beginExclusive();
    let rgba: Uint8Array;
    try {
      rgba = await renderer.renderExact({ ...project, clips: { [source.id]: source } }, frame);
    } finally {
      renderer.endExclusive();
    }
    const canvas = new OffscreenCanvas(project.width, project.height);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), project.width, project.height), 0, 0);
    const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    const path = await window.filmora.saveStill(`${source.id}-${frame}-${Date.now().toString(36)}`, png);
    const name = `${source.name} · ${t('freeze.name')}`;
    const asset = await buildAsset({ name: `${name}.png`, uri: await window.filmora.mediaUrl(path), sourcePath: path }, project.fps);

    // The still into the library and onto the timeline: one step for Ctrl+Z.
    const mark = useHistoryStore.getState().undoStack.length;
    useProjectStore.getState().addAssets([asset]);
    const added = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
    const id = useProjectStore.getState().insertFreeze(source.id, frame, {
      trackId: source.trackId,
      name,
      sourceUri: added.uri,
      startFrame: frame,
      durationFrames: Math.max(1, Math.round(FREEZE_SECONDS * project.fps)),
      hasAlphaChannel: added.hasAlphaChannel,
    });
    useHistoryStore.getState().squash(mark, 'Freeze frame');
    if (id) notify(t('freeze.done', { seconds: FREEZE_SECONDS }), 'success');
    return id;
  } catch (error) {
    notify(t('freeze.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    return null;
  }
}
