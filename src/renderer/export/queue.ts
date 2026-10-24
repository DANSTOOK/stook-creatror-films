import { create } from 'zustand';
import type { ExportSettings, MediaAsset, ProjectState } from '@shared/types';
import type { DeliveredTrack } from '@renderer/captions/captionClips';
import type { SubtitleFormat } from '@renderer/captions/subtitleFiles';
import { createId } from '@shared/utils/id';

/**
 * Exports to render later, one after another: the render queue of
 * DaVinci's Deliver page and Media Encoder's queue. A job keeps the
 * timeline as it was when it was queued, with the settings of that moment -
 * the 16:9 master, then the vertical cut, then a shorter one - so the
 * editing can go on and the queue still renders what was asked for.
 */

export type QueuedStatus = 'waiting' | 'rendering' | 'done' | 'failed' | 'cancelled';

/** What a render reads besides its settings: the timeline and the captions, as they were. */
export interface ExportSource {
  project: ProjectState;
  assets: MediaAsset[];
  /** The captions tracks drawn into the picture. */
  burnTrackIds: ReadonlySet<string>;
  captionFile: SubtitleFormat | 'none';
  embedCaptions: boolean;
  deliverTracks: DeliveredTrack[];
  thumbnailPath: string | null;
}

export interface QueuedExport extends ExportSource {
  id: string;
  /** The file's name, without its folder. */
  name: string;
  settings: ExportSettings;
  status: QueuedStatus;
  /** Why it failed, when it did. */
  detail?: string;
}

interface QueueState {
  jobs: QueuedExport[];
  add(job: Omit<QueuedExport, 'id' | 'status'>): QueuedExport;
  update(id: string, patch: Partial<Pick<QueuedExport, 'status' | 'detail'>>): void;
  remove(id: string): void;
  /** Forget the finished ones. */
  clearFinished(): void;
}

export const useExportQueue = create<QueueState>((set) => ({
  jobs: [],
  add: (job) => {
    const queued: QueuedExport = { ...job, id: createId('export'), status: 'waiting' };
    set((state) => ({ jobs: [...state.jobs, queued] }));
    return queued;
  },
  update: (id, patch) => set((state) => ({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)) })),
  remove: (id) => set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) })),
  clearFinished: () => set((state) => ({ jobs: state.jobs.filter((job) => job.status === 'waiting' || job.status === 'rendering') })),
}));

