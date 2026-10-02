import { create } from 'zustand';
import type { CaptionLanguage, CaptionPreset, ProjectState } from '@shared/types';
import type { CaptionModelId, CaptionTranscribeResult } from '@shared/types/ipc';
import { streamTimelineAudio } from '@renderer/audio/renderMix';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { errorText } from '@renderer/errorText';
import { t } from '@renderer/i18n';
import { notify } from '@renderer/notifications/notifications';
import { rulesFor, wordsToCues } from './rules';
import { showLibraryTab } from '@renderer/components/MediaLibrary/libraryTabs';

/**
 * Generating captions: one job at a time, in the background.
 *
 * The dialog starts it and closes; the editor stays usable, and a small
 * card (CaptionProgress) shows how far along it is, with Cancel. Two steps:
 *
 *   1. the timeline's sound is mixed - the mix an export makes, of the whole
 *      timeline or of one track - and streamed to the main process, where
 *      ffmpeg turns it into what Whisper reads;
 *   2. whisper.cpp transcribes it, there, as a child process.
 *
 * The words come back with their times and are cut into captions by the
 * rules (rules.ts), on a new captions track, as one undo step. The project
 * is read when the job starts; edits made while it runs stay as they are,
 * and the captions land where the words were when it started.
 */

export interface CaptionJobOptions {
  language: CaptionLanguage;
  /** `mix` for everything audible, or the id of the one track to listen to. */
  source: 'mix' | string;
  model: CaptionModelId;
  preset: CaptionPreset;
}

/** How much of the bar the mix takes; the transcription takes the rest. */
const MIX_SHARE = 0.1;

export interface CaptionJobSummary {
  captions: number;
  words: number;
  result: CaptionTranscribeResult;
  /** Seconds from Generate to the captions being on the timeline. */
  totalSeconds: number;
}

interface JobState {
  phase: 'idle' | 'mixing' | 'transcribing';
  /** 0-1 across both steps. */
  fraction: number;
  /** The last job that finished, for the message and the tests. */
  last: CaptionJobSummary | null;
  start(options: CaptionJobOptions): Promise<CaptionJobSummary | null>;
  cancel(): void;
}

/** The project as the job hears it: everything, or one track alone. */
export function projectForSource(project: ProjectState, source: 'mix' | string): ProjectState {
  if (source === 'mix') return project;
  return {
    ...project,
    tracks: project.tracks.map((track) => (track.id === source ? { ...track, solo: true, muted: false } : { ...track, solo: false })),
  };
}

class Cancelled extends Error {}

let current: { jobId: string | null; cancelled: boolean } | null = null;
let listening = false;

export const useCaptionJob = create<JobState>((set, get) => ({
  phase: 'idle',
  fraction: 0,
  last: null,

  async start(options) {
    const api = window.filmora;
    if (get().phase !== 'idle' || !api.captionsAudioOpen || !api.captionsAudioAppend || !api.captionsAudioClose || !api.captionsTranscribe) {
      if (get().phase !== 'idle') notify(t('captions.busy'), 'warning');
      return null;
    }
    const startedAt = performance.now();
    const { project, assets } = useProjectStore.getState();
    const endFrame = projectContentLength(project);
    // To know, at the end, that the project on screen is still this one.
    const tracksAtStart = new Set(project.tracks.map((track) => track.id));
    const job = { jobId: null as string | null, cancelled: false };
    current = job;
    set({ phase: 'mixing', fraction: 0 });

    if (!listening && api.onCaptionProgress) {
      listening = true;
      api.onCaptionProgress(({ jobId, fraction }) => {
        if (current?.jobId === jobId && get().phase === 'transcribing') set({ fraction: MIX_SHARE + (1 - MIX_SHARE) * fraction });
      });
    }

    try {
      const jobId = await api.captionsAudioOpen();
      job.jobId = jobId;
      if (job.cancelled) throw new Cancelled();

      const mix = endFrame > 0
        ? await streamTimelineAudio(
            projectForSource(project, options.source),
            assets,
            0,
            endFrame,
            async (samples) => {
              if (job.cancelled) throw new Cancelled();
              await api.captionsAudioAppend?.(jobId, samples.buffer as ArrayBuffer);
            },
            { onProgress: (done, total) => set({ fraction: MIX_SHARE * (total > 0 ? done / total : 1) }) },
          )
        : null;
      if (job.cancelled) throw new Cancelled();
      if (!mix || mix.peak === 0) {
        await api.captionsCancel?.(jobId);
        notify(t('captions.nothingToTranscribe'), 'warning');
        return null;
      }
      await api.captionsAudioClose(jobId);
      if (job.cancelled) throw new Cancelled();

      set({ phase: 'transcribing', fraction: MIX_SHARE });
      const result = await api.captionsTranscribe(jobId, { model: options.model, language: options.language });
      if (result.cancelled || job.cancelled) throw new Cancelled();

      // On the project as it is now: its size and rate decide lines and frames.
      const now = useProjectStore.getState().project;
      // Another project was opened meanwhile: these captions are not its.
      if (!now.tracks.some((track) => tracksAtStart.has(track.id))) {
        notify(t('captions.otherProject'), 'warning');
        return null;
      }
      const cues = wordsToCues(result.words, rulesFor(options.preset, now), options.language, now.fps);
      if (cues.length === 0) {
        notify(t('captions.doneNone'), 'warning');
        return null;
      }
      // Heard on one track: tied to that track's clips. Heard in the mix: to whichever clip carries the speech.
      useProjectStore
        .getState()
        .addCaptionTrack({ cues, offsetFrame: 0, ...(options.source !== 'mix' ? { sourceTrackId: options.source } : {}) }, { preset: options.preset, language: options.language });
      // The list of what was just written comes forward.
      showLibraryTab('captions');
      const summary: CaptionJobSummary = { captions: cues.length, words: result.words.length, result, totalSeconds: (performance.now() - startedAt) / 1000 };
      set({ last: summary });
      notify(
        t(result.ran === 'gpu' ? 'captions.doneGpu' : 'captions.doneCpu', {
          count: cues.length,
          seconds: Math.max(1, Math.round(summary.totalSeconds)),
          gpu: result.gpu ?? 'GPU',
        }),
        'success',
      );
      return summary;
    } catch (error) {
      if (job.jobId) void api.captionsCancel?.(job.jobId);
      if (error instanceof Cancelled || job.cancelled) notify(t('captions.cancelled'), 'info');
      else notify(t('captions.failed', { detail: errorText(error) }), 'error');
      return null;
    } finally {
      if (current === job) current = null;
      set({ phase: 'idle', fraction: 0 });
    }
  },

  cancel() {
    if (!current) return;
    current.cancelled = true;
    if (current.jobId) void window.filmora.captionsCancel?.(current.jobId);
  },
}));
