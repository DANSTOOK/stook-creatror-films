import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ExportProgress,
  ExportSettings,
  GpuReport,
  HardwareEncoder,
} from '@shared/types';
import { IPC, type FilmoraApi, type MediaProbe, type PickedFile } from '@shared/types/ipc';

/**
 * The only bridge between the renderer and Node.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer can only
 * reach the file system through the handlers enumerated here.
 */
const api: FilmoraApi = {
  openMedia: () => ipcRenderer.invoke(IPC.openMedia) as Promise<PickedFile[]>,
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
  openProject: () =>
    ipcRenderer.invoke(IPC.openProject) as Promise<{ path: string; contents: string } | null>,
  openLut: () =>
    ipcRenderer.invoke(IPC.openLut) as Promise<{ path: string; contents: string } | null>,
  saveProjectAs: (contents, suggestedName) =>
    ipcRenderer.invoke(IPC.saveProjectAs, contents, suggestedName) as Promise<string | null>,
  chooseExportFolder: () => ipcRenderer.invoke(IPC.chooseExportFolder) as Promise<string | null>,
  resolveExportTarget: (folder, name, format) =>
    ipcRenderer.invoke(IPC.resolveExportTarget, folder, name, format) as Promise<{ path: string; exists: boolean }>,
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
