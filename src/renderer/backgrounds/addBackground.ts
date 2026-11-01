import { t } from '@renderer/i18n';
import type { ClipDrawn } from '@shared/types';
import { applyTint, tintSuffix } from './tint';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { applyClipAnimation } from '@renderer/fx/motion/apply';
import type { ClipAnimationId } from '@renderer/fx/motion/animations';
import { backgroundById, type Background } from './catalog';
import { creditFor, photoDataUrl, type StockPhoto } from './photos';

/**
 * A background onto the timeline: drawn at the PROJECT's own size, kept as a
 * PNG in the app's folder, imported as a still, put on a track of its own at
 * the playhead - and then that track sent to the bottom, because a new track
 * is inserted above the rest and a background above the footage hides it.
 *
 * Drawn at the project's size rather than at some fixed one: a 4K project gets
 * 4K and a vertical project gets a vertical picture, so nothing is ever scaled
 * up or cropped. That is also why the file's name carries the size - the same
 * background in two projects is two different pictures.
 */

/** Draw a background into `canvas` at `width` x `height`. */
export function drawBackground(canvas: HTMLCanvasElement, background: Background, width: number, height: number, tint?: ClipDrawn['tint']): void {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  background.draw(context, width, height);
  if (tint) applyTint(context, width, height, tint);
}

/**
 * The loop a moving background gets. A still that drifts is not a video loop,
 * and the panel says so: what moves is the picture, slowly, by the same
 * machinery that makes a sticker sway (fx/motion). The slow loops take 14 to 20
 * seconds to come round, so the frame is never still and the movement is never
 * the thing you watch.
 */
export const BACKGROUND_LOOP: ClipAnimationId = 'driftSlow';

export async function addBackground(backgroundId: string, options: { motion?: boolean; tint?: ClipDrawn['tint'] } = {}): Promise<string | null> {
  const background = backgroundById(backgroundId);
  const api = window.filmora;
  if (!background || !api?.saveSticker || !api.mediaUrl) return null;
  const { project } = useProjectStore.getState();
  const { width, height } = project;
  const canvas = document.createElement('canvas');
  drawBackground(canvas, background, width, height, options.tint);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const path = await api.saveSticker(`bg-${background.id}-${width}x${height}${tintSuffix(options.tint)}`, await blob.arrayBuffer());

  const store = useProjectStore.getState();
  let asset = store.assets.find((candidate) => candidate.sourcePath === path);
  if (!asset) {
    const uri = await api.mediaUrl(path);
    asset = await buildAsset({ name: `${t(background.label)}.png`, uri, sourcePath: path }, store.project.fps);
    useProjectStore.getState().addAssets([asset]);
    asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
  }

  // Added and sent to the bottom: one step for Ctrl+Z.
  const mark = useHistoryStore.getState().undoStack.length;
  const clipId = useProjectStore.getState().addAssetOnNewTrack(asset);
  if (!clipId) return null;
  const trackId = useProjectStore.getState().project.clips[clipId]?.trackId ?? null;
  if (trackId) {
    // Down past every other picture track. One step at a time, because moveTrack
    // works in rows and stops of its own accord at the bottom.
    const rows = useProjectStore.getState().project.tracks.filter((track) => track.type !== 'audio').length;
    for (let step = 0; step < rows; step += 1) useProjectStore.getState().moveTrack(trackId, 1);
  }
  useProjectStore.getState().updateClip(clipId, {
    name: t(background.label),
    drawn: { kind: 'background', id: background.id, ...(options.tint ? { tint: options.tint } : {}) },
  });
  if (options.motion) applyClipAnimation(clipId, BACKGROUND_LOOP);
  useHistoryStore.getState().squash(mark, 'Add background');
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: trackId });
  return clipId;
}

/**
 * A real photograph onto the timeline, the same way a drawn background goes.
 *
 * The picture is fetched, drawn into a canvas at the PROJECT's size and saved
 * as a PNG beside the drawn ones, so from that point on nothing downstream
 * knows or cares that it came off the internet: same asset, same track, same
 * export. It is also why the photo is only ever fetched once.
 *
 * It is COVERED, not stretched: the picture keeps its shape and whatever does
 * not fit is cropped. Squashing somebody's photograph to fit a frame is the
 * one thing that always looks wrong.
 *
 * The credit is written into the clip's name, so a licence that asks for one
 * is satisfied by the project itself rather than by the user remembering.
 */
export async function addPhotoBackground(photo: StockPhoto): Promise<string | null> {
  const api = window.filmora;
  if (!api?.saveSticker || !api.mediaUrl) return null;
  const { project } = useProjectStore.getState();
  const { width, height } = project;

  // Through main: the page may not reach the host that holds the picture.
  const dataUrl = await photoDataUrl(photo.url);
  if (!dataUrl) return null;
  const image = await loadImage(dataUrl);
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  // Cover: fill the frame, keep the shape, crop the overflow evenly.
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const path = await api.saveSticker(`photo-${photo.id}-${width}x${height}`, await blob.arrayBuffer());

  const store = useProjectStore.getState();
  let asset = store.assets.find((candidate) => candidate.sourcePath === path);
  if (!asset) {
    const uri = await api.mediaUrl(path);
    asset = await buildAsset({ name: `${photo.title}.png`, uri, sourcePath: path }, store.project.fps);
    useProjectStore.getState().addAssets([asset]);
    asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
  }

  const mark = useHistoryStore.getState().undoStack.length;
  const clipId = useProjectStore.getState().addAssetOnNewTrack(asset);
  if (!clipId) return null;
  const trackId = useProjectStore.getState().project.clips[clipId]?.trackId ?? null;
  if (trackId) {
    const rows = useProjectStore.getState().project.tracks.filter((track) => track.type !== 'audio').length;
    for (let step = 0; step < rows; step += 1) useProjectStore.getState().moveTrack(trackId, 1);
  }
  // The credit rides on the clip, so the project itself carries it.
  useProjectStore.getState().updateClip(clipId, { name: creditFor(photo) });
  useHistoryStore.getState().squash(mark, 'Add photo');
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: trackId });
  return clipId;
}

/** The picture, or null if it cannot be had - a dead link, or no network. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
