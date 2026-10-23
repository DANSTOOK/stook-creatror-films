import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { t } from '@renderer/i18n';

/**
 * Adjustment layer, added: an empty clip on a new track over everything, five
 * seconds from the playhead, whose grade and effects then fall on all that is
 * under it (engine/Compositor drawAdjustment) - Premiere's and Resolve's
 * adjustment clip. Selected, so its Color and Effects tabs are where the eye
 * goes next. One undo step.
 */

/** What an adjustment clip points at in place of a file. */
export const ADJUSTMENT_URI = 'scf-adjustment:';

export const ADJUSTMENT_SECONDS = 5;

export function addAdjustmentLayer(): string | null {
  const store = useProjectStore.getState();
  const mark = useHistoryStore.getState().undoStack.length;
  const before = new Set(store.project.tracks.map((track) => track.id));
  store.addTrack('video', t('adjustment.track'));
  const track = useProjectStore.getState().project.tracks.find((candidate) => !before.has(candidate.id));
  if (!track) return null;
  const { project } = useProjectStore.getState();
  const clipId = useProjectStore.getState().addClip({
    trackId: track.id,
    name: t('adjustment.name'),
    sourceUri: ADJUSTMENT_URI,
    startFrame: project.currentFrame,
    durationFrames: Math.round(ADJUSTMENT_SECONDS * project.fps),
    hasAlphaChannel: true,
  });
  useProjectStore.getState().updateClip(clipId, { adjustment: true });
  useHistoryStore.getState().squash(mark, 'Add adjustment layer');
  useProjectStore.getState().setUi({ selectedClipIds: [clipId], selectedTrackId: track.id });
  return clipId;
}
