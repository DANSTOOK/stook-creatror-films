import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, X } from 'lucide-react';
import type { ExportFormat, ExportProgress, HardwareEncoder } from '@shared/types';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { WebCodecsEncoder, detectCodecSupport } from '@renderer/engine/WebCodecsEncoder';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Export dialog, including the game-asset mode.
 *
 * The alpha toggle is the important control: only PNG sequence, ProRes 4444 and
 * WebM/VP9 keep a real alpha channel, so choosing an MP4 with alpha on is
 * flagged here rather than producing a sprite sheet with a black background.
 */

const FORMATS: { value: ExportFormat; label: string; alpha: boolean }[] = [
  { value: 'png-sequence', label: 'PNG sequence (sprite frames)', alpha: true },
  { value: 'prores4444', label: 'ProRes 4444 (.mov)', alpha: true },
  { value: 'webm-vp9', label: 'WebM / VP9', alpha: true },
  { value: 'mp4-h264', label: 'MP4 / H.264', alpha: false },
  { value: 'mp4-h265', label: 'MP4 / H.265', alpha: false },
];

const ENCODER_LABELS: Record<HardwareEncoder, string> = {
  none: 'Software',
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel QuickSync',
  videotoolbox: 'Apple VideoToolbox',
  amf: 'AMD AMF',
};

export interface ExportDialogProps {
  onClose(): void;
}

export function ExportDialog({ onClose }: ExportDialogProps): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const settings = useProjectStore((state) => state.exportSettings);
  const setExportSettings = useProjectStore((state) => state.setExportSettings);

  const [encoders, setEncoders] = useState<HardwareEncoder[]>(['none']);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const selectedFormat = FORMATS.find((format) => format.value === settings.format);
  const alphaUnsupported = settings.exportAlpha && selectedFormat?.alpha === false;

  useEffect(() => {
    // Seed the range from the project the first time the dialog opens.
    setExportSettings({
      width: project.width,
      height: project.height,
      fps: project.fps,
      endFrame: settings.endFrame || project.durationFrames,
      exportAlpha: settings.exportAlpha || project.hasAlphaBackground,
    });

    void window.filmora.detectEncoders().then(setEncoders);
    // Intentionally runs once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => window.filmora.onExportProgress(setProgress), []);

  const chooseOutput = useCallback(async () => {
    const path = await window.filmora.chooseExportPath(settings.format);
    if (path) setExportSettings({ outputPath: path });
  }, [settings.format, setExportSettings]);

  const startExport = useCallback(async () => {
    const renderer = getActiveFrameRenderer();
    if (!renderer) {
      setMessage('The compositor is not ready yet.');
      return;
    }
    if (!settings.outputPath) {
      setMessage('Choose an output location first.');
      return;
    }

    cancelRef.current = false;
    setRunning(true);
    setMessage(null);

    let jobId: string | null = null;
    let encoder: WebCodecsEncoder | null = null;

    try {
      await renderer.ensureLUTs(project);

      // Prefer GPU-side encoding when the format allows it: the frame never
      // leaves the GPU as raw pixels, so only compressed chunks cross IPC.
      const support = await detectCodecSupport(settings);
      const jobSettings = {
        ...settings,
        pipeMode: support ? support.pipeMode : ('rawvideo' as const),
      };

      const started = await window.filmora.exportStart(jobSettings);
      jobId = started.jobId;
      const activeJobId = jobId;

      if (support) {
        encoder = new WebCodecsEncoder(jobSettings, support, {
          onChunk: (bytes) =>
            window.filmora.exportFrame(activeJobId, bytes.buffer as ArrayBuffer),
          onError: (error) => setMessage(`Encoder error: ${error.message}`),
        });
      }

      for (let frame = settings.startFrame; frame < settings.endFrame; frame += 1) {
        if (cancelRef.current) {
          encoder?.close();
          await window.filmora.exportCancel(activeJobId);
          setMessage('Export cancelled.');
          return;
        }

        if (encoder) {
          await renderer.renderExactToCanvas(project, frame);
          await encoder.encodeCanvas(renderer.canvas);
        } else {
          const rgba = await renderer.renderExact(project, frame, settings.premultiplyAlpha);
          await window.filmora.exportFrame(activeJobId, rgba.buffer as ArrayBuffer);
        }
      }

      // Flush before closing stdin, or the tail of the stream is lost.
      await encoder?.finish();
      encoder = null;

      await window.filmora.exportFinish(activeJobId);
      setMessage(
        `Export finished (${support ? 'GPU encode' : 'software encode'}): ${settings.outputPath}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(`Export failed: ${detail}`);
      encoder?.close();
      if (jobId) await window.filmora.exportCancel(jobId).catch(() => undefined);
    } finally {
      setRunning(false);
    }
  }, [project, settings]);

  const totalFrames = Math.max(0, settings.endFrame - settings.startFrame);
  const percent =
    progress && progress.totalFrames > 0
      ? Math.round((progress.frame / progress.totalFrames) * 100)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="panel w-[520px] max-h-[86vh]">
        <header className="panel-header justify-between">
          <span>Export</span>
          <button type="button" className="tool-button" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <label className="flex flex-col gap-1">
            <span className="field-label">Format</span>
            <select
              className="numeric-input"
              value={settings.format}
              onChange={(event) =>
                setExportSettings({ format: event.target.value as ExportFormat, outputPath: '' })
              }
            >
              {FORMATS.map((format) => (
                <option key={format.value} value={format.value}>
                  {format.label}
                </option>
              ))}
            </select>
          </label>

          <div className="rounded border border-panel-700 bg-panel-950 p-3">
            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={settings.exportAlpha}
                onChange={(event) => setExportSettings({ exportAlpha: event.target.checked })}
              />
              Export alpha channel (PNG sequence / ProRes 4444 / WebM)
            </label>

            <label className="mt-2 flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={settings.premultiplyAlpha}
                onChange={(event) => setExportSettings({ premultiplyAlpha: event.target.checked })}
              />
              Premultiply alpha
            </label>
            <p className="mt-1 pl-6 text-2xs leading-relaxed text-slate-500">
              Leave this off for Godot. Godot imports straight alpha, and
              premultiplying here is what produces dark fringes around sprites.
            </p>

            <label className="mt-2 flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={settings.pixelArtScaling}
                onChange={(event) => setExportSettings({ pixelArtScaling: event.target.checked })}
              />
              Nearest-neighbour scaling (pixel art)
            </label>

            {alphaUnsupported && (
              <p className="mt-2 rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                {selectedFormat?.label} has no alpha channel. Choose PNG sequence,
                ProRes 4444 or WebM/VP9 to keep transparency.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="field-label">Width</span>
              <input
                type="number"
                className="numeric-input"
                value={settings.width}
                onChange={(event) => setExportSettings({ width: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="field-label">Height</span>
              <input
                type="number"
                className="numeric-input"
                value={settings.height}
                onChange={(event) => setExportSettings({ height: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="field-label">Start frame</span>
              <input
                type="number"
                className="numeric-input"
                value={settings.startFrame}
                onChange={(event) => setExportSettings({ startFrame: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="field-label">End frame</span>
              <input
                type="number"
                className="numeric-input"
                value={settings.endFrame}
                onChange={(event) => setExportSettings({ endFrame: Number(event.target.value) })}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="field-label">Hardware encoder</span>
            <select
              className="numeric-input"
              value={settings.hardwareEncoder}
              disabled={settings.exportAlpha}
              onChange={(event) =>
                setExportSettings({ hardwareEncoder: event.target.value as HardwareEncoder })
              }
            >
              {encoders.map((encoder) => (
                <option key={encoder} value={encoder}>
                  {ENCODER_LABELS[encoder]}
                </option>
              ))}
            </select>
            {settings.exportAlpha && (
              <span className="text-2xs text-slate-500">
                Hardware encoders cannot carry alpha, so this render uses a
                software encoder.
              </span>
            )}
          </label>

          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="field-label">
                Output {settings.format === 'png-sequence' ? 'folder' : 'file'}
              </span>
              <input
                readOnly
                className="numeric-input"
                value={settings.outputPath}
                placeholder="Not chosen"
              />
            </label>
            <button type="button" className="tool-button" onClick={() => void chooseOutput()}>
              <FolderOpen size={14} />
              Browse
            </button>
          </div>

          {(running || progress) && (
            <div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-panel-700">
                <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1 text-2xs text-slate-400">
                {progress?.frame ?? 0} / {progress?.totalFrames || totalFrames} frames
                {progress && progress.fps > 0 ? ` - ${progress.fps.toFixed(1)} fps` : ''}
              </p>
            </div>
          )}

          {message && <p className="text-2xs text-slate-300">{message}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-panel-700 px-4 py-3">
          {running ? (
            <button
              type="button"
              className="tool-button"
              onClick={() => {
                cancelRef.current = true;
              }}
            >
              Cancel render
            </button>
          ) : (
            <button type="button" className="tool-button" onClick={onClose}>
              Close
            </button>
          )}
          <button
            type="button"
            className="tool-button tool-button-active"
            disabled={running || totalFrames <= 0}
            onClick={() => void startExport()}
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {running ? 'Rendering...' : 'Start export'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ExportDialog;
