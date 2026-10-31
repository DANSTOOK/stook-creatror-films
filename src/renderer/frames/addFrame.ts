import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { frameById, type Frame } from './catalog';

/**
 * A frame onto the timeline: drawn at the project's own size with everything
 * it does not paint left CLEAR, kept as a PNG, and put on a track of its own -
 * which a new track already is, above the rest, because a frame belongs over
 * the picture and not under it.
 *
 * The opposite of a background (renderer/backgrounds), which goes to the
 * bottom. Everything else about them is the same: drawn rather than decoded, so
 * a 4K project gets 4K and a vertical project gets a vertical frame rather than
 * a stretched wide one - which matters more here than anywhere, since a frame
 * stretched out of shape has visibly uneven edges.
 */

/** Draw a frame into `canvas` at `width` x `height`, over transparency. */
export function drawFrame(canvas: HTMLCanvasElement, frame: Frame, width: number, height: number): void {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  frame.draw(context, width, height);
}

export async function addFrame(frameId: string): Promise<string | null> {
  const frame = frameById(frameId);
  const api = window.filmora;
  if (!frame || !api?.saveSticker || !api.mediaUrl) return null;
  const { project } = useProjectStore.getState();
  const { width, height } = project;
  const canvas = document.createElement('canvas');
  drawFrame(canvas, frame, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const path = await api.saveSticker(`frame-${frame.id}-${width}x${height}`, await blob.arrayBuffer());

  const store = useProjectStore.getState();
  let asset = store.assets.find((candidate) => candidate.sourcePath === path);
  if (!asset) {
    const uri = await api.mediaUrl(path);
    asset = await buildAsset({ name: `${t(frame.label)}.png`, uri, sourcePath: path }, store.project.fps);
    useProjectStore.getState().addAssets([asset]);
    asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
  }

  const mark = useHistoryStore.getState().undoStack.length;
  const clipId = useProjectStore.getState().addAssetOnNewTrack(asset);
  if (!clipId) return null;
  useProjectStore.getState().updateClip(clipId, { name: t(frame.label) });
  useHistoryStore.getState().squash(mark, 'Add frame');
  const trackId = useProjectStore.getState().project.clips[clipId]?.trackId ?? null;
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: trackId });
  return clipId;
}
