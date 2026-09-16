import { useCallback, useMemo } from 'react';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { hasNativeBridge, rehydrateDocument } from '@renderer/media/importMedia';
import { useProjectStore } from '@renderer/store/useProjectStore';
import type { ProjectDocument } from '@renderer/store/types';
import { currentMarker, documentIsDirty, useSessionStore } from '@renderer/store/useSessionStore';
import { projectNameFromPath } from './projectSession';

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

export interface ProjectActions {
  save(saveAs?: boolean): Promise<boolean>;
  openFromDialog(): Promise<boolean>;
  openRecent(path: string): Promise<boolean>;
  newBlank(): Promise<boolean>;
  createProject(options: NewProjectOptions): Promise<boolean>;
  goHome(): Promise<boolean>;
}

export function useProjectActions(setStatus: (message: string | null) => void): ProjectActions {
  const save = useCallback(
    async (saveAs = false): Promise<boolean> => {
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
      setStatus(`Saved to ${path}`);
      pendingRecord = recordRecent(path, true).catch(() => undefined);
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
        useProjectStore.getState().loadDocument({ ...document, assets, project });
        useSessionStore.getState().startProject(opened.path, projectNameFromPath(opened.path), currentMarker());

        const missing = assets.filter((asset) => asset.missing);
        setStatus(
          missing.length > 0
            ? `Opened ${opened.path} - ${missing.length} media file(s) could not be found`
            : `Opened ${opened.path}`,
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
    useProjectStore.getState().newProject();
    useSessionStore.getState().startProject(null, 'Untitled project', currentMarker());
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
        useSessionStore.getState().startProject(path, projectNameFromPath(path), currentMarker());
        setStatus(`Created ${path}`);
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
    useProjectStore.getState().newProject();
    useSessionStore.getState().closeProject();
    return true;
  }, [confirmLeave]);

  return useMemo(
    () => ({ save, openFromDialog, openRecent, newBlank, createProject, goHome }),
    [save, openFromDialog, openRecent, newBlank, createProject, goHome],
  );
}
