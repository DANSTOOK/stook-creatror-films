import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ExportProgress,
  ExportSettings,
  GpuReport,
  HardwareEncoder,
} from '@shared/types';
import {
  IPC,
  type FilmoraApi,
  type MediaProbe,
  type PickedFile,
  type ProjectBackup,
  type ProjectRecovery,
  type RecentProject,
} from '@shared/types/ipc';

/**
 * The only bridge between the renderer and Node.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer can only
 * reach the file system through the handlers enumerated here.
 */
const api: FilmoraApi = {
  openMedia: () => ipcRenderer.invoke(IPC.openMedia) as Promise<PickedFile[]>,
  openMediaFolder: () => ipcRenderer.invoke(IPC.openMediaFolder) as Promise<PickedFile[]>,
  // Paths are derived HERE, from the File objects themselves: getPathForFile
  // only knows the path of a file the OS handed over and returns '' for one
  // constructed in JavaScript, so page code cannot talk its way into a path.
  mediaUrl: (path) => ipcRenderer.invoke(IPC.mediaUrl, path) as Promise<string>,
  extractAudio: (path) => ipcRenderer.invoke(IPC.extractAudio, path) as Promise<string | null>,
  registerDroppedFiles: (files) =>
    ipcRenderer.invoke(
      IPC.registerDroppedFiles,
      files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== ''),
    ) as Promise<PickedFile[]>,
  // A dropped folder is a File too, and getPathForFile gives its path the
  // same way - only for one the OS handed over.
  registerDroppedFolders: (folders) =>
    ipcRenderer.invoke(
      IPC.registerDroppedFolders,
      folders.map((folder) => webUtils.getPathForFile(folder)).filter((path) => path !== ''),
    ) as Promise<PickedFile[]>,
  projectsList: () => ipcRenderer.invoke(IPC.projectsList) as Promise<RecentProject[]>,
  projectsOpenRecent: (path) =>
    ipcRenderer.invoke(IPC.projectsOpenRecent, path) as Promise<{ path: string; contents: string } | null>,
  projectsForget: (path) => ipcRenderer.invoke(IPC.projectsForget, path) as Promise<void>,
  projectsDefaultFolder: () => ipcRenderer.invoke(IPC.projectsDefaultFolder) as Promise<string>,
  projectsChooseFolder: () => ipcRenderer.invoke(IPC.projectsChooseFolder) as Promise<string | null>,
  projectsCreate: (folder, name, contents) =>
    ipcRenderer.invoke(IPC.projectsCreate, folder, name, contents) as Promise<string>,
  projectsSave: (path, contents) => ipcRenderer.invoke(IPC.projectsSave, path, contents) as Promise<string>,
  projectsRecord: (project, thumbnail) => ipcRenderer.invoke(IPC.projectsRecord, project, thumbnail) as Promise<void>,
  documentState: (state) => ipcRenderer.send(IPC.documentState, state),
  onSaveBeforeClose(listener) {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.saveBeforeClose, handler);
    return () => {
      ipcRenderer.off(IPC.saveBeforeClose, handler);
    };
  },
  closeAfterSave: () => ipcRenderer.invoke(IPC.closeAfterSave) as Promise<void>,
  openProject: () =>
    ipcRenderer.invoke(IPC.openProject) as Promise<{ path: string; contents: string } | null>,
  openLut: () =>
    ipcRenderer.invoke(IPC.openLut) as Promise<{ path: string; contents: string } | null>,
  saveProjectAs: (contents, suggestedName) =>
    ipcRenderer.invoke(IPC.saveProjectAs, contents, suggestedName) as Promise<string | null>,
  projectsBackups: (path) => ipcRenderer.invoke(IPC.projectsBackups, path) as Promise<ProjectBackup[]>,
  projectsBackupRead: (file) => ipcRenderer.invoke(IPC.projectsBackupRead, file) as Promise<string | null>,
  projectsRecoveryWrite: (snapshot) => ipcRenderer.invoke(IPC.projectsRecoveryWrite, snapshot) as Promise<void>,
  projectsRecoveryRead: () => ipcRenderer.invoke(IPC.projectsRecoveryRead) as Promise<ProjectRecovery | null>,
  projectsRecoveryClear: () => ipcRenderer.invoke(IPC.projectsRecoveryClear) as Promise<void>,
  chooseExportFolder: () => ipcRenderer.invoke(IPC.chooseExportFolder) as Promise<string | null>,
  resolveExportTarget: (folder, name, format) =>
    ipcRenderer.invoke(IPC.resolveExportTarget, folder, name, format) as Promise<{ path: string; exists: boolean; inUse: boolean }>,
  defaultExportFolder: () => ipcRenderer.invoke(IPC.defaultExportFolder) as Promise<string>,
  chooseThumbnail: () => ipcRenderer.invoke(IPC.chooseThumbnail) as Promise<string | null>,
  writeThumbnail: (png) => ipcRenderer.invoke(IPC.writeThumbnail, png) as Promise<string>,
  chooseExportPath: (format) =>
    ipcRenderer.invoke(IPC.chooseExportPath, format) as Promise<string | null>,

  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path) as Promise<ArrayBuffer>,
  readTextFile: (path) => ipcRenderer.invoke(IPC.readTextFile, path) as Promise<string>,
  writeTextFile: (path, contents) =>
    ipcRenderer.invoke(IPC.writeTextFile, path, contents) as Promise<void>,

  probeMedia: (path) => ipcRenderer.invoke(IPC.probeMedia, path) as Promise<MediaProbe>,
  detectEncoders: () => ipcRenderer.invoke(IPC.detectEncoders) as Promise<HardwareEncoder[]>,
  gpuReport: () => ipcRenderer.invoke(IPC.gpuReport) as Promise<GpuReport>,
  setGpuPreference: (preference) => ipcRenderer.invoke(IPC.setGpuPreference, preference),
  relaunch: () => ipcRenderer.invoke(IPC.relaunch),

  writeExportAudio: (wav) => ipcRenderer.invoke(IPC.writeExportAudio, wav) as Promise<string>,
  exportAudioOpen: () => ipcRenderer.invoke(IPC.exportAudioOpen) as Promise<string>,
  exportAudioAppend: (path, samples) => ipcRenderer.invoke(IPC.exportAudioAppend, path, samples) as Promise<void>,
  exportAudioClose: (path, discard) => ipcRenderer.invoke(IPC.exportAudioClose, path, discard) as Promise<void>,
  exportStart: (settings: ExportSettings) => ipcRenderer.invoke(IPC.exportStart, settings),
  exportFrame: (jobId, rgba) => ipcRenderer.invoke(IPC.exportFrame, jobId, rgba),
  exportFinish: (jobId) => ipcRenderer.invoke(IPC.exportFinish, jobId),
  exportCancel: (jobId) => ipcRenderer.invoke(IPC.exportCancel, jobId),

  onExportProgress(listener) {
    const handler = (_event: unknown, progress: ExportProgress): void => listener(progress);
    ipcRenderer.on(IPC.exportProgress, handler);
    return () => {
      ipcRenderer.off(IPC.exportProgress, handler);
    };
  },
};

contextBridge.exposeInMainWorld('filmora', api);
