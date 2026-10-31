import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { backgroundById, type Background } from './catalog';

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
export function drawBackground(canvas: HTMLCanvasElement, background: Background, width: number, height: number): void {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  background.draw(context, width, height);
}

export async function addBackground(backgroundId: string): Promise<string | null> {
  const background = backgroundById(backgroundId);
  const api = window.filmora;
  if (!background || !api?.saveSticker || !api.mediaUrl) return null;
  const { project } = useProjectStore.getState();
  const { width, height } = project;
  const canvas = document.createElement('canvas');
  drawBackground(canvas, background, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const path = await api.saveSticker(`bg-${background.id}-${width}x${height}`, await blob.arrayBuffer());

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
  useProjectStore.getState().updateClip(clipId, { name: t(background.label) });
  useHistoryStore.getState().squash(mark, 'Add background');
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: trackId });
  return clipId;
}
