import type { ClipDrawn } from '@shared/types';
import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { buildAsset } from '@renderer/media/importMedia';
import { backgroundById } from './catalog';
import { frameById } from '@renderer/frames/catalog';
import { drawBackground } from './addBackground';
import { drawFrame } from '@renderer/frames/addFrame';
import { applyTint, tintSuffix } from './tint';

/**
 * Drawing a background or a frame again, in another colour, under the clip that
 * is already on the timeline.
 *
 * The clip keeps its place, its length, its track and anything done to it - a
 * drift, a trim, a move. Only the picture it points at changes. A background
 * added and then nudged into place must not jump back to the playhead because
 * its colour changed.
 *
 * The new picture is a new FILE, named after the tint, so the two colours are
 * two files rather than one overwriting the other - which matters because a
 * project saved yesterday may still point at the first one.
 */
export async function redrawClip(clipId: string, tint: ClipDrawn['tint']): Promise<boolean> {
  const store = useProjectStore.getState();
  const clip = store.project.clips[clipId];
  const drawn = clip?.drawn;
  const api = window.filmora;
  if (!clip || !drawn || !api?.saveSticker || !api.mediaUrl) return false;

  const { width, height } = store.project;
  const canvas = document.createElement('canvas');
  let label = '';
  if (drawn.kind === 'background') {
    const background = backgroundById(drawn.id);
    if (!background) return false;
    label = t(background.label);
    drawBackground(canvas, background, width, height, tint);
  } else {
    const frame = frameById(drawn.id);
    if (!frame) return false;
    label = t(frame.label);
    drawFrame(canvas, frame, width, height, tint);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return false;
  const prefix = drawn.kind === 'background' ? 'bg' : 'frame';
  const path = await api.saveSticker(`${prefix}-${drawn.id}-${width}x${height}${tintSuffix(tint)}`, await blob.arrayBuffer());

  let asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path);
  if (!asset) {
    const uri = await api.mediaUrl(path);
    asset = await buildAsset({ name: `${label}.png`, uri, sourcePath: path }, useProjectStore.getState().project.fps);
    useProjectStore.getState().addAssets([asset]);
    asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
  }

  // The source swapped under the clip, and the record kept in step with it.
  useProjectStore.getState().updateClip(clipId, {
    sourceUri: asset.uri,
    drawn: { ...drawn, ...(tint && tint.strength > 0 ? { tint } : { tint: undefined }) },
  });
  return true;
}

/** A tile of what a tint would look like, for the inspector's swatches. */
export function previewTint(canvas: HTMLCanvasElement, drawn: ClipDrawn, tint: ClipDrawn['tint'], width = 120, height = 68): void {
  const background = drawn.kind === 'background' ? backgroundById(drawn.id) : undefined;
  const frame = drawn.kind === 'frame' ? frameById(drawn.id) : undefined;
  if (!background && !frame) return;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (background) background.draw(context, width, height);
  else frame!.draw(context, width, height);
  if (tint) applyTint(context, width, height, tint);
  // A frame is mostly a hole, so the swatch needs something under it to read.
  if (frame) {
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#64748b';
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
  }
}
