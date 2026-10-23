import { useProjectStore } from '@renderer/store/useProjectStore';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';
import { notify } from '@renderer/notifications/notifications';
import { t } from '@renderer/i18n';
import { youtubeChapters, type Chapters } from './chapters';

/** The project's markers as YouTube chapters (edit/chapters.ts), in the interface's language. */
export function projectChapters(): Chapters {
  const { project } = useProjectStore.getState();
  return youtubeChapters(project.markers, project.fps, projectContentLength(project), {
    intro: t('chapters.intro'),
    numbered: (index) => t('chapters.numbered', { index }),
  });
}

/** What the user is told about a set of chapters: how many, and what YouTube will make of them. */
export function chaptersNote(chapters: Chapters): { message: string; tone: 'success' | 'warning' } {
  if (chapters.tooFew) return { message: t('chapters.tooFew', { count: chapters.count }), tone: 'warning' };
  const message = t('chapters.copied', { count: chapters.count });
  return chapters.skipped > 0 ? { message: `${message} ${t('chapters.skipped', { count: chapters.skipped })}`, tone: 'warning' } : { message, tone: 'success' };
}

/** The chapters on the clipboard, ready for a video's description. */
export async function copyChapters(): Promise<Chapters> {
  const chapters = projectChapters();
  if (window.filmora?.clipboardWrite) await window.filmora.clipboardWrite(chapters.text);
  else await navigator.clipboard?.writeText(chapters.text);
  const { message, tone } = chaptersNote(chapters);
  notify(message, tone);
  return chapters;
}
