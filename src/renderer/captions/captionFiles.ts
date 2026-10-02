import { useLanguageStore, t } from '@renderer/i18n';
import { errorText } from '@renderer/errorText';
import { notify } from '@renderer/notifications/notifications';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { captionCues } from './captionClips';
import { parseSubtitles, writeSrt, writeVtt } from './subtitleFiles';

/**
 * Timeline > Import captions and Export captions: subtitle files in and out
 * of the timeline, on their own - without transcribing and without rendering
 * a video.
 */

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Pick an .srt or .vtt and put its captions on a new captions track. */
export async function importCaptionsFromDialog(): Promise<number> {
  const api = window.filmora;
  if (!api.captionsOpenFile) return 0;
  try {
    const file = await api.captionsOpenFile();
    if (!file) return 0;
    const cues = parseSubtitles(file.contents);
    const name = baseName(file.path);
    if (cues.length === 0) {
      notify(t('captions.importEmpty', { name }), 'warning');
      return 0;
    }
    // The file does not say its language; the interface's is the likeliest,
    // and it only decides how a caption cut by the razor is laid out again.
    const language = useLanguageStore.getState().language === 'en' ? 'en' : 'es';
    const store = useProjectStore.getState();
    store.addCaptionTrack({ subtitles: cues }, { preset: 'classic', language });
    const last = cues[cues.length - 1];
    store.revealFrames(0, Math.round((last.endMs / 1000) * useProjectStore.getState().project.fps));
    notify(t('captions.imported', { count: cues.length, name }), 'success');
    return cues.length;
  } catch (error) {
    notify(t('captions.importFailed', { detail: errorText(error) }), 'error');
    return 0;
  }
}

/** Save the timeline's captions as an .srt or a .vtt, whichever is chosen in the dialog. */
export async function exportCaptionsToDialog(): Promise<string | null> {
  const api = window.filmora;
  if (!api.captionsSaveFile) return null;
  const { project } = useProjectStore.getState();
  const cues = captionCues(project);
  if (cues.length === 0) {
    notify(t('captions.noneToExport'), 'warning');
    return null;
  }
  try {
    const name = useSessionStore.getState().projectName || 'captions';
    const path = await api.captionsSaveFile(`${name}.srt`, writeSrt(cues), writeVtt(cues));
    if (path) notify(t('captions.exported', { count: cues.length, name: baseName(path) }), 'success');
    return path;
  } catch (error) {
    notify(t('captions.exportFailed', { detail: errorText(error) }), 'error');
    return null;
  }
}
