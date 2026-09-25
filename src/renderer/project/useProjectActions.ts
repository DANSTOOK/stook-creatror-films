import { useCallback, useMemo } from 'react';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge, rehydrateDocument } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import type { ProjectDocument } from '@renderer/store/types';
import { currentMarker, documentIsDirty, useSessionStore } from '@renderer/store/useSessionStore';
import { withViewTransition } from '@renderer/motion/viewTransition';
import { projectNameFromPath } from './projectSession';
import { savedAtLabel } from './autosave';
import { notify } from '@renderer/notifications/notifications';
import { currentLocale, t } from '@renderer/i18n';

/**
 * Everything that starts, opens or keeps a project.
 *
 * Every path that would replace the project on screen - a new one, an opened
 * one, the start screen - asks first when there are unsaved changes, and
 * "Save" there really saves before going on. Saving into a project that
 * already has a file writes it straight back, like every editor's Save; only a
 * project that was never saved, or Save as, asks where.
 */

export interface NewProjectOptions {
  name: string;
  /** Where to create it; null for the default projects folder. */
  folder: string | null;
  width: number;
  height: number;
  fps: number;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The file's own name, for a message.
 *
 * A full path is most of a toolbar wide and tells the user nothing they did
 * not just choose; where the project lives is on its card on the start screen
 * and under the project name in the toolbar.
 */
const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;

/**
 * A small JPEG of the frame under the playhead, for the start screen.
 *
 * Rendered the way an export renders it, so it is the real picture rather
 * than whatever the preview last managed to draw.
 */
async function captureThumbnail(): Promise<ArrayBuffer | undefined> {
  const renderer = getActiveFrameRenderer();
  const { project } = useProjectStore.getState();
  // Never alongside an export: both would seek the same decoders.
  if (!renderer || renderer.isExclusive || Object.keys(project.clips).length === 0) return undefined;

  renderer.beginExclusive();
  try {
    const frame = Math.min(project.currentFrame, Math.max(0, project.durationFrames - 1));
    const rgba = await renderer.renderExact(project, frame, false);
    const full = document.createElement('canvas');
    full.width = project.width;
    full.height = project.height;
    full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), project.width, project.height), 0, 0);

    const width = 320;
    const height = Math.max(1, Math.round((project.height / Math.max(1, project.width)) * width));
    const small = document.createElement('canvas');
    small.width = width;
    small.height = height;
    const context = small.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = '#0d0f14';
    context.fillRect(0, 0, width, height);
    context.drawImage(full, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => small.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? await blob.arrayBuffer() : undefined;
  } catch {
    return undefined;
  } finally {
    renderer.endExclusive();
  }
}

/**
 * The latest save's thumbnail and list update, still running.
 *
 * A save returns as soon as the file is written; the picture follows. Anything
 * that replaces the project waits for it first, so the thumbnail is never
 * rendered from a project half-swapped for the next one.
 */
let pendingRecord: Promise<void> = Promise.resolve();

/** Put the project at the top of the start screen's list. Best effort: never blocks a save. */
async function recordRecent(path: string, withThumbnail: boolean): Promise<void> {
  if (!hasNativeBridge()) return;
  const { project } = useProjectStore.getState();
  const thumbnail = withThumbnail ? await captureThumbnail() : undefined;
  await window.filmora
    .projectsRecord(
      {
        path,
        name: projectNameFromPath(path),
        width: project.width,
        height: project.height,
        fps: project.fps,
        durationFrames: project.durationFrames,
        clipCount: Object.keys(project.clips).length,
      },
      thumbnail,
    )
    .catch(() => undefined);
}

/** What a save is for: the user asked, or the clock did. */
export interface SaveOptions {
  /**
   * An automatic save: no thumbnail, and a quieter message.
   *
   * The thumbnail is rendered by taking the renderer exclusively, which is
   * fine when somebody pressed Ctrl+S and is waiting, and not fine at all
   * five minutes into an afternoon somebody else is having.
   */
  automatic?: boolean;
}

export interface ProjectActions {
  save(saveAs?: boolean, options?: SaveOptions): Promise<boolean>;
  openFromDialog(): Promise<boolean>;
  openRecent(path: string): Promise<boolean>;
  newBlank(): Promise<boolean>;
  /**
   * Put an earlier version of the open project on screen, unsaved.
   *
   * The project file is left exactly as it is: looking at how things were
   * an hour ago must not cost the last hour. Saving afterwards is an
   * ordinary save, which keeps the current version as a backup in turn.
   */
  restoreContents(contents: string, savedAt: string): Promise<boolean>;
  /** Take back up the work a previous session never saved. */
  recoverUnsaved(): Promise<boolean>;
  createProject(options: NewProjectOptions): Promise<boolean>;
  goHome(): Promise<boolean>;
}

/** A date and time in the interface language, for "restored the version from ...". */
const whenLabel = (iso: string): string => new Date(iso).toLocaleString(currentLocale());

export function useProjectActions(): ProjectActions {
  const save = useCallback(
    async (saveAs = false, { automatic = false }: SaveOptions = {}): Promise<boolean> => {
      if (!hasNativeBridge()) return false;
      const session = useSessionStore.getState();
      // Taken before writing: an edit made while the file is being written
      // must still count as unsaved afterwards.
      const marker = currentMarker();
      const json = JSON.stringify(useProjectStore.getState().toDocument(), null, 2);

      let path: string | null;
      try {
        path =
          session.projectPath && !saveAs
            ? await window.filmora.projectsSave(session.projectPath, json)
            : await window.filmora.saveProjectAs(json, `${session.projectName}.scf`);
      } catch (error) {
        notify(t('notify.saveFailed', { error: describe(error) }), 'error');
        return false;
      }
      if (!path) return false;

      useSessionStore.getState().markSaved(marker, path, projectNameFromPath(path));
      notify(
        automatic
          ? t('notify.autosaved', { file: fileName(path), time: savedAtLabel(new Date(), currentLocale()) })
          : t('notify.saved', { file: fileName(path) }),
        automatic ? 'info' : 'success',
      );
      pendingRecord = recordRecent(path, !automatic).catch(() => undefined);
      return true;
    },
    [],
  );

  /** True when it is fine to replace the project on screen. */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (!documentIsDirty()) return true;
    const choice = await useSessionStore.getState().askToSave();
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    return save(false);
  }, [save]);

  const load = useCallback(
    async (opened: { path: string; contents: string }): Promise<boolean> => {
      try {
        await pendingRecord;
        const document = JSON.parse(opened.contents) as ProjectDocument;
        // Media and LUTs are re-read from disk and every clip is remapped onto
        // the fresh URLs: the ones the project was authored with died with that
        // session.
        const { assets, project } = await rehydrateDocument(document.assets ?? [], document.project);
        // One transition for the whole swap: the document and the screen it is
        // shown on change together, so they cross-fade as one thing.
        await withViewTransition(() => {
          useProjectStore.getState().loadDocument({ ...document, assets, project });
          useSessionStore.getState().startProject(opened.path, projectNameFromPath(opened.path), currentMarker());
        });

        const missing = assets.filter((asset) => asset.missing);
        if (missing.length > 0) {
          notify(t('notify.openedMissing', { file: fileName(opened.path), count: missing.length }), 'warning');
        } else {
          notify(t('notify.opened', { file: fileName(opened.path) }), 'success');
        }
        void recordRecent(opened.path, false);
        return true;
      } catch (error) {
        notify(describe(error), 'error');
        return false;
      }
    },
    [],
  );

  /**
   * A document that came from somewhere other than a project file.
   *
   * It counts as unsaved on purpose, so the dot in the toolbar is on and
   * closing the window asks: what is on screen is not what is in the file.
   * The marker cannot be mistaken for a real one - a library signature is
   * never this word - so it is dirty however the history looks.
   */
  const loadDetached = useCallback(
    async (contents: string, path: string | null, name: string, message: string): Promise<boolean> => {
      try {
        await pendingRecord;
        const document = JSON.parse(contents) as ProjectDocument;
        const { assets, project } = await rehydrateDocument(document.assets ?? [], document.project);
        await withViewTransition(() => {
          useProjectStore.getState().loadDocument({ ...document, assets, project });
          useSessionStore.getState().startProject(path, name, { undoTopId: 'restored', library: 'restored' });
        });
        notify(message, 'info');
        return true;
      } catch (error) {
        notify(describe(error), 'error');
        return false;
      }
    },
    [],
  );

  const restoreContents = useCallback(
    async (contents: string, savedAt: string): Promise<boolean> => {
      if (!(await confirmLeave())) return false;
      const session = useSessionStore.getState();
      return loadDetached(
        contents,
        session.projectPath,
        session.projectName,
        t('notify.restored', { date: whenLabel(savedAt) }),
      );
    },
    [confirmLeave, loadDetached],
  );

  const recoverUnsaved = useCallback(async (): Promise<boolean> => {
    if (!hasNativeBridge() || !(await confirmLeave())) return false;
    const snapshot = await window.filmora.projectsRecoveryRead().catch(() => null);
    if (!snapshot) {
      notify(t('notify.nothingToRecover'), 'info');
      return false;
    }
    return loadDetached(
      snapshot.contents,
      snapshot.path,
      snapshot.name,
      t('notify.recovered', { date: whenLabel(snapshot.savedAt) }),
    );
  }, [confirmLeave, loadDetached]);

  const openFromDialog = useCallback(async (): Promise<boolean> => {
    if (!hasNativeBridge() || !(await confirmLeave())) return false;
    const opened = await window.filmora.openProject();
    return opened ? load(opened) : false;
  }, [confirmLeave, load]);

  const openRecent = useCallback(
    async (path: string): Promise<boolean> => {
      if (!hasNativeBridge() || !(await confirmLeave())) return false;
      try {
        const opened = await window.filmora.projectsOpenRecent(path);
        return opened ? load(opened) : false;
      } catch (error) {
        notify(t('notify.openFailed', { name: projectNameFromPath(path), error: describe(error) }), 'error');
        return false;
      }
    },
    [confirmLeave, load],
  );

  const newBlank = useCallback(async (): Promise<boolean> => {
    if (!(await confirmLeave())) return false;
    await pendingRecord;
    await withViewTransition(() => {
      useProjectStore.getState().newProject();
      useSessionStore.getState().startProject(null, 'Untitled project', currentMarker());
    });
    return true;
  }, [confirmLeave]);

  const createProject = useCallback(
    async (options: NewProjectOptions): Promise<boolean> => {
      if (!hasNativeBridge() || !(await confirmLeave())) return false;
      await pendingRecord;
      useProjectStore.getState().newProject(options.width, options.height, options.fps);
      try {
        const folder = options.folder ?? (await window.filmora.projectsDefaultFolder());
        const json = JSON.stringify(useProjectStore.getState().toDocument(), null, 2);
        const path = await window.filmora.projectsCreate(folder, options.name, json);
        await withViewTransition(() => {
          useSessionStore.getState().startProject(path, projectNameFromPath(path), currentMarker());
        });
        notify(t('notify.created', { file: fileName(path) }), 'success');
        void recordRecent(path, false);
        return true;
      } catch (error) {
        notify(t('notify.createFailed', { error: describe(error) }), 'error');
        return false;
      }
    },
    [confirmLeave],
  );

  const goHome = useCallback(async (): Promise<boolean> => {
    if (!(await confirmLeave())) return false;
    // The project is closed, not kept behind the start screen: whatever was in
    // it has been saved or deliberately let go, and a change let go must not
    // come back as a second "save changes?" when the next project opens. It also
    // hands the decoders and their memory back.
    useProjectStore.getState().setPlaying(false);
    await pendingRecord;
    await withViewTransition(() => {
      useProjectStore.getState().newProject();
      useSessionStore.getState().closeProject();
    });
    return true;
  }, [confirmLeave]);

  return useMemo(
    () => ({ save, openFromDialog, openRecent, newBlank, createProject, goHome, restoreContents, recoverUnsaved }),
    [save, openFromDialog, openRecent, newBlank, createProject, goHome, restoreContents, recoverUnsaved],
  );
}
