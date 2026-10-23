import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { soundById } from './catalog';
import { renderSound, wavOf } from './synth';

/**
 * A sound from the library onto the timeline: rendered (sounds/synth.ts) the
 * first time it is used and kept as a WAV in the app's folder, imported like
 * any sound, and put at the playhead on an audio track of its own - music on
 * the music bus, an effect on the dialogue side's neighbour. One undo step.
 */

/** The sound's file, made now or found from before: its path. */
async function soundFile(id: string): Promise<string | null> {
  const sound = soundById(id);
  const api = window.filmora;
  if (!sound || !api?.saveSound) return null;
  const known = await api.findSound(id).catch(() => null);
  if (known) return known;
  return api.saveSound(id, wavOf(await renderSound(sound)));
}

/** A URL to hear a sound before it is added: the same file. */
export async function soundPreviewUrl(id: string): Promise<string | null> {
  const path = await soundFile(id);
  return path ? window.filmora.mediaUrl(path) : null;
}

export async function addSound(id: string): Promise<string | null> {
  const sound = soundById(id);
  const path = await soundFile(id);
  if (!sound || !path) return null;
  const store = useProjectStore.getState();
  let asset = store.assets.find((candidate) => candidate.sourcePath === path);
  if (!asset) {
    asset = await buildAsset({ name: `${t(sound.label)}.wav`, uri: await window.filmora.mediaUrl(path), sourcePath: path, hasAudio: true }, store.project.fps);
    useProjectStore.getState().addAssets([asset]);
    asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
  }
  const mark = useHistoryStore.getState().undoStack.length;
  const clipId = useProjectStore.getState().addAssetOnNewTrack(asset);
  if (!clipId) return null;
  const trackId = useProjectStore.getState().project.clips[clipId]?.trackId;
  if (trackId) {
    useProjectStore.getState().updateTrack(trackId, {
      name: t(sound.category === 'music' ? 'sound.trackMusic' : 'sound.trackEffects'),
      bus: sound.category === 'music' ? 'music' : 'dialogue',
    });
  }
  useHistoryStore.getState().squash(mark, 'Add sound');
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: trackId ?? null });
  return clipId;
}
