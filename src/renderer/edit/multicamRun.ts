import { useProjectStore } from '@renderer/store/useProjectStore';
import { notify, dismissNotification } from '@renderer/notifications/notifications';
import { t } from '@renderer/i18n';
import { masterOf, timelineSync } from './multicam';

/**
 * Making a multicam clip: the angles lined up by their sound when they share
 * one (main/media/audioSync.ts) - any that do not, as they sat on the
 * timeline, and the user told which - then made one clip (edit/multicam.ts).
 */

/** Below this the best agreement is no better than chance: a camera that heard another room. */
const SURE = 6;

export async function makeMulticam(clipIds: readonly string[]): Promise<string | null> {
  const { project, assets } = useProjectStore.getState();
  const master = masterOf(project, clipIds);
  if (!master) return null;
  const ids = [master.id, ...clipIds.filter((id) => id !== master.id)];
  const assetOf = (id: string) => assets.find((asset) => asset.uri === project.clips[id]?.sourceUri);
  const names = new Map(ids.map((id, index) => [id, `${t('multicam.angle')} ${index + 1} · ${assetOf(id)?.name.replace(/\.[^.]+$/, '') ?? project.clips[id].name}`]));
  const sync = timelineSync(project, ids);
  const paths = ids.map((id) => assetOf(id)?.sourcePath);
  const unsynced: string[] = [];
  if (window.filmora?.alignBySound && paths.every(Boolean)) {
    const waiting = notify(t('multicam.syncing', { count: ids.length }), 'info', { persistent: true });
    try {
      const found = await window.filmora.alignBySound(paths as string[]);
      ids.forEach((id, index) => {
        if (index === 0) return;
        const match = found[index];
        if (match && match.confidence >= SURE) {
          // The master's first frame is heard `seconds` into this one: any moment is that much further into it.
          sync.set(id, Math.round(match.seconds * project.fps));
        } else {
          unsynced.push(assetOf(id)?.name ?? project.clips[id].name);
        }
      });
    } catch (error) {
      notify(t('multicam.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
      return null;
    } finally {
      dismissNotification(waiting);
    }
  }
  const clipId = useProjectStore.getState().makeMulticam(ids, sync, names);
  if (!clipId) return null;
  if (unsynced.length > 0) notify(t('multicam.unsynced', { names: unsynced.join(', ') }), 'warning');
  notify(t('multicam.made', { count: ids.length }), 'success');
  return clipId;
}
