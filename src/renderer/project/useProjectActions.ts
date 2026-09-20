import { useCallback, useMemo } from 'react';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge, rehydrateDocument } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import type { ProjectDocument } from '@renderer/store/types';
import { currentMarker, documentIsDirty, useSessionStore } from '@renderer/store/useSessionStore';
import { withViewTransition } from '@renderer/motion/viewTransition';
import { projectNameFromPath } from './projectSession';
import { savedAtLabel } from './autosave';

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
 * The file's own name, for a status line.
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
   * An automatic save: no thumbnail, and a quieter line in the status bar.
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

export function useProjectActions(setStatus: (message: string | null) => void): ProjectActions {
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
        setStatus(`Could not save: ${describe(error)}`);
        return false;
      }
      if (!path) return false;

      useSessionStore.getState().markSaved(marker, path, projectNameFromPath(path));
      setStatus(
        automatic
          ? `Autosaved to ${fileName(path)} at ${savedAtLabel(new Date())}`
          : `Saved to ${fileName(path)}`,
      );
      pendingRecord = recordRecent(path, !automatic).catch(() => undefined);
      return true;
    },
    [setStatus],
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
        setStatus(
          missing.length > 0
            ? `Opened ${fileName(opened.path)} - ${missing.length} media file(s) could not be found`
            : `Opened ${fileName(opened.path)}`,
        );
        void recordRecent(opened.path, false);
        return true;
      } catch (error) {
        setStatus(describe(error));
        return false;
      }
    },
    [setStatus],
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
        setStatus(message);
        return true;
      } catch (error) {
        setStatus(describe(error));
        return false;
      }
    },
    [setStatus],
  );

  const restoreContents = useCallback(
    async (contents: string, savedAt: string): Promise<boolean> => {
      if (!(await confirmLeave())) return false;
      const session = useSessionStore.getState();
      return loadDetached(
        contents,
        session.projectPath,
        session.projectName,
        `Restored the version from ${new Date(savedAt).toLocaleString()} - not saved yet`,
      );
    },
    [confirmLeave, loadDetached],
  );

  const recoverUnsaved = useCallback(async (): Promise<boolean> => {
    if (!hasNativeBridge() || !(await confirmLeave())) return false;
    const snapshot = await window.filmora.projectsRecoveryRead().catch(() => null);
    if (!snapshot) {
      setStatus('There is nothing left to recover');
      return false;
    }
    return loadDetached(
      snapshot.contents,
      snapshot.path,
      snapshot.name,
      `Recovered the work from ${new Date(snapshot.savedAt).toLocaleString()} - not saved yet`,
    );
  }, [confirmLeave, loadDetached, setStatus]);

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
        setStatus(`Could not open ${projectNameFromPath(path)}: ${describe(error)}`);
        return false;
      }
    },
    [confirmLeave, load, setStatus],
  );

  const newBlank = useCallback(async (): Promise<boolean> => {
    if (!(await confirmLeave())) return false;
    await pendingRecord;
    await withViewTransition(() => {
      useProjectStore.getState().newProject();
      useSessionStore.getState().startProject(null, 'Untitled project', currentMarker());
    });
    setStatus(null);
    return true;
  }, [confirmLeave, setStatus]);

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
        setStatus(`Created ${fileName(path)}`);
        void recordRecent(path, false);
        return true;
      } catch (error) {
        setStatus(`Could not create the project: ${describe(error)}`);
        return false;
      }
    },
    [confirmLeave, setStatus],
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
