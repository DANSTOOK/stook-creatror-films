import type { MessageKey } from '@shared/i18n';
import { t, useLanguageStore } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { fitScale } from '@renderer/media/fitToFrame';
import { applyClipAnimation } from '@renderer/fx/motion/apply';
import { SHOW_CLIP_FX_EVENT } from '@renderer/fx/motion/zoneEdit';
import { stickerById, type Sticker } from './catalog';

/**
 * A sticker onto the timeline: drawn as a transparent PNG at 768 px, kept in
 * the app's folder (one file a sticker and language), imported as a still,
 * put on a track of its own at the playhead a third of the frame tall, and
 * given its pop and its loop - then brought forward in the inspector, on its
 * Effects tab, where those can be changed.
 */

const SIZE = 768;

/** Draw a sticker into `canvas`, `size` px square. */
export function drawSticker(canvas: HTMLCanvasElement, sticker: Sticker, size: number): void {
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, size, size);
  sticker.draw(context, size, (key: MessageKey) => t(key));
}

export async function addSticker(stickerId: string): Promise<string | null> {
  const sticker = stickerById(stickerId);
  const api = window.filmora;
  if (!sticker || !api?.saveSticker || !api.mediaUrl) return null;
  // The lettering's face, loaded before it is drawn rather than a fallback caught mid-load.
  await document.fonts?.load('900 100px Outfit').catch(() => undefined);
  const canvas = document.createElement('canvas');
  drawSticker(canvas, sticker, SIZE);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const words = sticker.category === 'words' ? `-${useLanguageStore.getState().language}` : '';
  const path = await api.saveSticker(`${sticker.id}${words}`, await blob.arrayBuffer());

  const store = useProjectStore.getState();
  let asset = store.assets.find((candidate) => candidate.sourcePath === path);
  if (!asset) {
    const uri = await api.mediaUrl(path);
    asset = await buildAsset({ name: `${t(sticker.label)}.png`, uri, sourcePath: path }, store.project.fps);
    useProjectStore.getState().addAssets([asset]);
    asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
  }
  // Added, sized and animated: one step for Ctrl+Z.
  const mark = useHistoryStore.getState().undoStack.length;
  const clipId = useProjectStore.getState().addAssetOnNewTrack(asset);
  if (!clipId) return null;

  // A third of the frame tall, its own shape kept.
  const { project } = useProjectStore.getState();
  const clip = project.clips[clipId];
  const fit = fitScale(asset, project) ?? { x: 1, y: 1 };
  const share = 0.34;
  useProjectStore.getState().updateClip(clipId, {
    name: t(sticker.label),
    transform: { ...clip.transform, scale: [{ id: `kf-sticker-${clipId}`, frame: clip.startFrame, value: { x: fit.x * share, y: fit.y * share }, easing: 'linear' }] },
  });
  applyClipAnimation(clipId, 'popIn');
  applyClipAnimation(clipId, sticker.loop);
  useHistoryStore.getState().squash(mark, 'Add sticker');
  // The playhead to where the pop has finished: at its first frame the sticker is still too small to see,
  // and a viewer showing nothing after a click reads as a click that did nothing.
  const added = useProjectStore.getState().project.clips[clipId];
  const popped = added?.fx?.in ? Math.round(added.fx.in.seconds * useProjectStore.getState().project.fps) : 0;
  if (added && popped > 0) useProjectStore.getState().setCurrentFrame(Math.min(added.startFrame + popped, added.startFrame + added.durationFrames - 1));
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: useProjectStore.getState().project.clips[clipId]?.trackId ?? null });
  window.dispatchEvent(new Event(SHOW_CLIP_FX_EVENT));
  return clipId;
}
