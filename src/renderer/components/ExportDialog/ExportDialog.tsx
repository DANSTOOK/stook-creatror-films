import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Clapperboard, Film, FolderOpen, Loader2, Sparkles, Youtube } from 'lucide-react';
import type {
  ExportFormat,
  ExportProgress,
  GpuPreference,
  GpuReport,
  HardwareEncoder,
  MediaAsset,
} from '@shared/types';
import { describeEncoder, resolveEncoderPlan } from '@renderer/engine/encoderPlan';
import type { CodecSupport } from '@renderer/engine/WebCodecsEncoder';
import { recommendedAudioBitrateKbps, recommendedBitrateKbps } from '@shared/utils/bitrate';
import { streamTimelineAudio } from '@renderer/audio/renderMix';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { matchPreset, resolutionPresets } from '@shared/utils/resolution';
import { WebCodecsEncoder, detectCodecSupport } from '@renderer/engine/WebCodecsEncoder';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { describeExportProgress, formatClock } from './exportProgress';
import { exportEndFrame } from './exportRange';
import { YouTubePanel } from './YouTubePanel';

/**
 * Export dialog, including the game-asset mode.
 *
 * Laid out the way DaVinci Resolve's Deliver page is: the actions and the
 * render's progress at the top, where they stay in view; quick presets next;
 * then the settings in groups that belong together - the picture (format with
 * its transparency, size and range) on one side, the file (name, folder,
 * cover) and the hardware on the other.
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

const PREFERENCE_LABELS: Record<GpuPreference, string> = {
  auto: 'Automatic (let Windows decide)',
  'high-performance': 'Dedicated GPU',
  'low-power': 'Integrated GPU',
};

/** Containers that can carry a cover image. */
const COVER_ART_FORMATS = new Set<ExportFormat>(['mp4-h264', 'mp4-h265', 'prores4444']);

/**
 * One-click starting points, like the preset strip at the top of Resolve's
 * render settings. Each sets format, size and transparency together - the
 * three that have to agree - and everything below stays editable.
 */
interface QuickPreset {
  id: string;
  label: string;
  hint: string;
  icon: typeof Film;
  format: ExportFormat;
  alpha: boolean;
  /** Height to look for among the resolution presets; null keeps the project size. */
  height: number | null;
}

const QUICK_PRESETS: QuickPreset[] = [
  { id: 'project', label: 'Project', hint: 'MP4 at the project size', icon: Film, format: 'mp4-h264', alpha: false, height: null },
  { id: 'youtube', label: 'YouTube 1080p', hint: 'MP4 / H.264, 1080 lines', icon: Youtube, format: 'mp4-h264', alpha: false, height: 1080 },
  { id: 'sprites', label: 'Sprite frames', hint: 'PNG sequence with alpha, for game engines', icon: Sparkles, format: 'png-sequence', alpha: true, height: null },
  { id: 'master', label: 'Transparent master', hint: 'ProRes 4444 with alpha', icon: Clapperboard, format: 'prores4444', alpha: true, height: null },
];

/** The first video's name without its extension, else "export". */
function defaultFileName(assets: readonly MediaAsset[]): string {
  const first = assets.find((asset) => asset.kind === 'video') ?? assets[0];
  return first ? first.name.replace(/\.[^.]+$/, '') : 'export';
}

export interface ExportDialogProps {
  onClose(): void;
  /** Playing its exit animation; see usePresence. */
  closing?: boolean;
}

export function ExportDialog({ onClose, closing = false }: ExportDialogProps): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const settings = useProjectStore((state) => state.exportSettings);
  const setExportSettings = useProjectStore((state) => state.setExportSettings);
  // What the ruler has marked, when both ends are: the range this can render.
  const marked = useProjectStore((state) =>
    state.ui.inFrame !== null && state.ui.outFrame !== null
      ? { start: state.ui.inFrame, end: state.ui.outFrame }
      : null);

  const [gpu, setGpu] = useState<GpuReport | null>(null);
  const [webCodecs, setWebCodecs] = useState<CodecSupport | null>(null);
  const [savedPreference, setSavedPreference] = useState<GpuPreference | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The file the last export finished writing, for sharing it. */
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const selectedFormat = FORMATS.find((format) => format.value === settings.format);
  const alphaUnsupported = settings.exportAlpha && selectedFormat?.alpha === false;

  useEffect(() => {
    // Seed the range from the project the first time the dialog opens.
    setExportSettings({
      width: project.width,
      height: project.height,
      fps: project.fps,
      // Seeded every time the dialog opens, not just the first time. With
      // `settings.endFrame ||` here, the first range ever seeded stuck for
      // the whole session: adding 40 minutes to a 5-minute timeline still
      // exported 5 minutes, silently, with the dialog showing that number.
      endFrame: exportEndFrame(project),
      exportAlpha: settings.exportAlpha || project.hasAlphaBackground,
      bitrateKbps: recommendedBitrateKbps(project.width, project.height, project.fps),
    });

    // Probing encodes a few frames per candidate, so it runs once per session
    // in the main process and is cached there.
    void window.filmora.gpuReport().then((report) => {
      setGpu(report);
      setSavedPreference(report.preference);
    });
    // Intentionally runs once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What WebCodecs would take for the current settings, for the plan preview.
  useEffect(() => {
    let cancelled = false;
    void detectCodecSupport(settings).then((support) => {
      if (!cancelled) setWebCodecs(support);
    });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  const activeGpu = gpu?.devices.find((device) => device.active) ?? null;
  const plan = resolveEncoderPlan({
    settings,
    webCodecs,
    encoders: gpu?.encoders ?? [],
    activeGpu,
  });
  const restartPending =
    gpu !== null && savedPreference !== null && savedPreference !== gpu.appliedPreference;

  const chooseGpu = useCallback(async (preference: GpuPreference) => {
    await window.filmora.setGpuPreference(preference);
    setSavedPreference(preference);
  }, []);

  useEffect(() => window.filmora.onExportProgress(setProgress), []);

  /** Resolution and bitrate move together; one without the other is a trap. */
  const resize = useCallback(
    (width: number, height: number) => {
      setExportSettings({
        width,
        height,
        bitrateKbps: recommendedBitrateKbps(width, height, settings.fps),
      });
    },
    [setExportSettings, settings.fps],
  );

  /* Where the file goes, and what it is called ----------------------------- */

  // Folder and name are separate, the way other editors do it: the name is
  // typed here instead of being buried in a save dialog.
  const [folder, setFolder] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() => defaultFileName(assets));
  const [targetExists, setTargetExists] = useState(false);
  /** The destination is footage this project reads from. Exporting would destroy it. */
  const [targetInUse, setTargetInUse] = useState(false);

  const chooseFolder = useCallback(async () => {
    const picked = await window.filmora.chooseExportFolder();
    if (picked) setFolder(picked);
  }, []);

  // Documents\VIDEOS EXPORTADOS unless the user picks somewhere else - never
  // the footage folder by default, which is how a render once replaced its
  // own source.
  useEffect(() => {
    if (folder) return;
    let cancelled = false;
    void window.filmora
      .defaultExportFolder()
      .then((path) => {
        if (!cancelled) setFolder((current) => current ?? path);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [folder]);

  // Every change of folder, name or format resolves the real target path in
  // the main process, which cleans the name and applies the extension.
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    void window.filmora.resolveExportTarget(folder, fileName, settings.format).then((target) => {
      if (cancelled) return;
      setExportSettings({ outputPath: target.path });
      setTargetExists(target.exists);
      setTargetInUse(target.inUse);
    });
    return () => {
      cancelled = true;
    };
  }, [folder, fileName, settings.format, setExportSettings]);

  /* Thumbnail --------------------------------------------------------------- */

  const [thumbnailPath, setThumbnailPath] = useState<string | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
  const coverArt = COVER_ART_FORMATS.has(settings.format);

  /** The frame under the playhead, rendered exactly as the export will be. */
  const captureCurrentFrame = useCallback(async () => {
    const renderer = getActiveFrameRenderer();
    if (!renderer) return;

    renderer.beginExclusive();
    try {
      const rgba = await renderer.renderExact(project, project.currentFrame, false);
      const canvas = document.createElement('canvas');
      canvas.width = project.width;
      canvas.height = project.height;
      canvas.getContext('2d')?.putImageData(
        new ImageData(new Uint8ClampedArray(rgba), project.width, project.height),
        0,
        0,
      );
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      setThumbnailPath(await window.filmora.writeThumbnail(await blob.arrayBuffer()));
      setThumbnailPreview(canvas.toDataURL('image/jpeg', 0.7));
    } finally {
      renderer.endExclusive();
    }
  }, [project]);

  const chooseThumbnail = useCallback(async () => {
    const path = await window.filmora.chooseThumbnail();
    if (!path) return;
    setThumbnailPath(path);
    setThumbnailPreview(await window.filmora.mediaUrl(path));
  }, []);

  const presets = resolutionPresets(project.width, project.height);
  const activePreset = matchPreset(presets, settings.width, settings.height);

  /* Quick presets ----------------------------------------------------------- */

  const presetSize = (preset: QuickPreset): { width: number; height: number } => {
    if (preset.height === null) return { width: project.width, height: project.height };
    const match = presets.find((candidate) => candidate.height === preset.height);
    return match ? { width: match.width, height: match.height } : { width: 1920, height: 1080 };
  };

  const applyQuickPreset = (preset: QuickPreset): void => {
    const size = presetSize(preset);
    setExportSettings({
      format: preset.format,
      outputPath: '',
      exportAlpha: preset.alpha,
      width: size.width,
      height: size.height,
      bitrateKbps: recommendedBitrateKbps(size.width, size.height, settings.fps),
    });
  };

  const isQuickPresetActive = (preset: QuickPreset): boolean => {
    const size = presetSize(preset);
    return (
      settings.format === preset.format &&
      settings.exportAlpha === preset.alpha &&
      settings.width === size.width &&
      settings.height === size.height
    );
  };

  const startExport = useCallback(async () => {
    const renderer = getActiveFrameRenderer();
    if (!renderer) {
      setMessage('The compositor is not ready yet.');
      return;
    }
    if (!folder || !settings.outputPath) {
      setMessage('Choose the folder to save into first.');
      return;
    }

    cancelRef.current = false;
    setRunning(true);
    setMessage(null);
    setExportedPath(null);

    let jobId: string | null = null;
    let encoder: WebCodecsEncoder | null = null;

    // The viewport shares this renderer's video elements and canvas. Left
    // drawing, it seeks them to the playhead mid-export, and the playhead's
    // picture lands in the render as a flash. It stands still until the end.
    renderer.beginExclusive();
    // Decode each clip forwards once instead of seeking per frame. The flag
    // forces the old seek path, for comparing the two in tests.
    if (!(window as { __scfSeekExport?: boolean }).__scfSeekExport) renderer.startSequentialDecode();

    try {
      await renderer.ensureLUTs(project);

      // Render the audio mix first: ffmpeg needs it as a file input, so it has
      // to exist before the encoder is spawned.
      let audioPath: string | undefined;
      let audioBitrateKbps: number | undefined;
      let audioRawFormat: { sampleRate: number; channels: number } | undefined;

      if (settings.format !== 'png-sequence') {
        setMessage('Rendering audio...');
        // A minute at a time, straight to a file: the whole mix never exists
        // in memory at once. See streamTimelineAudio.
        const mixPath = await window.filmora.exportAudioOpen();
        let mix: Awaited<ReturnType<typeof streamTimelineAudio>> = null;
        try {
          mix = await streamTimelineAudio(
            project,
            assets,
            settings.startFrame,
            settings.endFrame,
            (samples) => window.filmora.exportAudioAppend(mixPath, samples.buffer as ArrayBuffer),
            {
              onProgress: (done, total) =>
                setMessage(`Rendering audio... ${formatClock(done)} of ${formatClock(total)}`),
            },
          );
        } catch (error) {
          setMessage(`Audio mix failed, exporting without sound: ${String(error)}`);
          mix = null;
        } finally {
          await window.filmora.exportAudioClose(mixPath, mix === null);
        }

        if (mix) {
          audioPath = mixPath;
          audioRawFormat = { sampleRate: mix.sampleRate, channels: mix.channels };
          audioBitrateKbps = recommendedAudioBitrateKbps(mix.channels);
        }
      }

      // Resolve the encoder the same way the preview did, but against a fresh
      // WebCodecs probe: the settings may have changed since it last ran.
      const probed = await detectCodecSupport(settings);
      const jobPlan = resolveEncoderPlan({
        settings,
        webCodecs: probed,
        encoders: gpu?.encoders ?? [],
        activeGpu,
      });
      const support = jobPlan.pipeMode === 'rawvideo' ? null : probed;
      // The audio is done by now; leaving "Rendering audio..." up for the whole
      // picture render made a slow export look stuck on the sound.
      setMessage(`Rendering with ${jobPlan.label}...`);
      const jobSettings = {
        ...settings,
        pipeMode: jobPlan.pipeMode,
        hardwareEncoder: jobPlan.hardwareEncoder,
        ...(audioPath ? { audioPath, audioBitrateKbps, audioRawFormat } : {}),
        ...(thumbnailPath && coverArt ? { thumbnailPath } : {}),
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

        // Say so when a source fell back to seeking: that path is more than an
        // order of magnitude slower, and a silent crawl looks like a bug.
        const done = frame - settings.startFrame;
        if (done === 1 || (done > 0 && done % 600 === 0)) {
          const slow = renderer.slowSources();
          if (slow.length > 0) {
            setMessage(
              `Rendering with ${jobPlan.label} - slow path: ${slow.join(', ')} cannot be decoded forwards, so each frame is sought separately.`,
            );
          }
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
      setExportedPath(settings.outputPath);
      setMessage(
        `Export finished with ${jobPlan.label}: ${settings.outputPath}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(`Export failed: ${detail}`);
      encoder?.close();
      if (jobId) await window.filmora.exportCancel(jobId).catch(() => undefined);
    } finally {
      renderer.stopSequentialDecode();
      renderer.endExclusive();
      setRunning(false);
    }
  }, [project, assets, settings, gpu, activeGpu, folder, thumbnailPath, coverArt]);

  const totalFrames = Math.max(0, settings.endFrame - settings.startFrame);
  const renderFps = settings.fps || project.fps;
  const view = describeExportProgress({
    frame: progress?.frame ?? 0,
    totalFrames: progress?.totalFrames || totalFrames,
    renderFps: progress?.fps ?? 0,
    projectFps: renderFps,
  });
  const finished = !running && progress?.done === true && !progress.error;
  const extension =
    settings.format === 'png-sequence'
      ? '/ (folder)'
      : `.${settings.format === 'prores4444' ? 'mov' : settings.format === 'webm-vp9' ? 'webm' : 'mp4'}`;
  const canStart = !running && totalFrames > 0 && !targetInUse;

  return (
    // The editor behind is blurred, so the dialog is the only thing in focus.
    <div data-closing={closing} className="scf-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label="Export" data-closing={closing} className="scf-dialog panel w-[min(980px,95vw)] max-h-[92vh] shadow-2xl shadow-black/60">
        {/*
          The actions live at the top, beside the title: what everything below
          is for, always in reach without scrolling.
        */}
        <header className="panel-header h-11 justify-between">
          <span>Export</span>
          <div className="flex items-center gap-2 normal-case tracking-normal">
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
              <button type="button" className="tool-button" onClick={onClose} title="Close">
                Close
              </button>
            )}
            <button
              type="button"
              className="tool-button tool-button-active px-4"
              disabled={!canStart}
              onClick={() => void startExport()}
            >
              {running && <Loader2 size={14} className="animate-spin" />}
              {running ? 'Rendering...' : 'Start export'}
            </button>
          </div>
        </header>

        {/*
          What will be rendered, then - once started - how far it has got. It
          sits above the scrolling settings, so it stays in view for the whole
          render, and it speaks in minutes of video and time left, not in a
          frame count nobody can turn into a coffee break.
        */}
        <div className="shrink-0 space-y-2 border-b border-panel-700 bg-panel-950 px-4 py-3">
          {running || progress ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-slate-100">
                  {finished ? 'Finished' : running ? 'Rendering' : 'Stopped'}{' '}
                  <span className="tabular-nums">{view.percent.toFixed(1)}%</span>
                </span>
                <span className="text-xs tabular-nums text-slate-300">
                  <span className="text-slate-100">{view.videoDone}</span> / {view.videoTotal} of video
                </span>
              </div>
              <div
                className="h-3 w-full overflow-hidden rounded-full bg-panel-700"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={view.percent}
              >
                {/* Scaled, not resized: an export updates this many times a
                    second, and animating width would lay the dialog out again
                    on every one of them. */}
                <div
                  className={`scf-progress-bar h-full w-full rounded-full ${finished ? 'bg-emerald-500' : 'bg-accent'}`}
                  style={{ transform: `scaleX(${Math.max(0, Math.min(100, view.percent)) / 100})` }}
                />
              </div>
              <div className="grid grid-cols-3 gap-2 text-2xs tabular-nums text-slate-400">
                <span>
                  Elapsed <span className="text-slate-200">{view.elapsed}</span>
                </span>
                <span className="text-center">
                  Remaining{' '}
                  <span className="text-slate-200">
                    {finished ? '0:00' : running ? (view.remaining ?? 'estimating...') : '-'}
                  </span>
                </span>
                <span className="text-right">
                  {view.speed !== null ? (
                    <>
                      <span className="text-slate-200">{view.speed.toFixed(1)}x</span> realtime (
                      {(progress?.fps ?? 0).toFixed(0)} fps)
                    </>
                  ) : (
                    'starting...'
                  )}
                </span>
              </div>
            </>
          ) : (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
              <span className="font-medium text-slate-100">{selectedFormat?.label}</span>
              <span>
                {settings.width}x{settings.height} @ {renderFps} fps
              </span>
              <span>{formatClock(totalFrames / renderFps)} of video</span>
              {settings.exportAlpha && !alphaUnsupported && <span className="text-emerald-300">with alpha</span>}
              <span className="text-slate-400">{plan.label}</span>
            </p>
          )}
          {message && <p className="text-2xs leading-relaxed text-slate-300">{message}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* A finished video YouTube takes: offer to send it there. */}
          {!running && exportedPath && /.(mp4|mov|webm)$/i.test(exportedPath) && (
            <YouTubePanel path={exportedPath} defaultTitle={fileName} />
          )}

          {/* Quick presets: format, size and transparency set together. */}
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Quick presets">
            {QUICK_PRESETS.map((preset) => {
              const Icon = preset.icon;
              const active = isQuickPresetActive(preset);
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  title={preset.hint}
                  disabled={running}
                  className={`tool-button h-auto flex-col items-start gap-0.5 border px-3 py-2 text-left ${
                    active ? 'tool-button-active border-transparent' : 'border-panel-700 bg-panel-950'
                  }`}
                  onClick={() => applyQuickPreset(preset)}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <Icon size={13} />
                    {preset.label}
                  </span>
                  <span className="text-2xs text-slate-400">{preset.hint}</span>
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {/* The picture: what it is, how big, and which stretch of the timeline. */}
            <div className="space-y-3">
              <Section title="Video">
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-slate-400">Format</span>
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

                {/* Transparency belongs with the format: the format decides whether it can exist. */}
                <div className="space-y-1.5 rounded border border-panel-700 bg-panel-900 p-2">
                  <label className="flex items-center gap-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      className="accent-blue-500"
                      checked={settings.exportAlpha}
                      onChange={(event) => setExportSettings({ exportAlpha: event.target.checked })}
                    />
                    Export alpha channel
                    <span className="text-2xs text-slate-400">(PNG / ProRes 4444 / WebM)</span>
                  </label>
                  {alphaUnsupported && (
                    <p className="rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                      {selectedFormat?.label} has no alpha channel. Choose PNG sequence, ProRes 4444 or
                      WebM/VP9 to keep transparency.
                    </p>
                  )}
                  {(settings.exportAlpha || settings.premultiplyAlpha) && (
                    <>
                      <label className="flex items-center gap-2 text-xs text-slate-300">
                        <input
                          type="checkbox"
                          className="accent-blue-500"
                          checked={settings.premultiplyAlpha}
                          onChange={(event) => setExportSettings({ premultiplyAlpha: event.target.checked })}
                        />
                        Premultiply alpha
                      </label>
                      <p className="pl-6 text-2xs leading-relaxed text-slate-400">
                        Leave this off for Godot. Godot imports straight alpha, and premultiplying here is what
                        produces dark fringes around sprites.
                      </p>
                    </>
                  )}
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      className="accent-blue-500"
                      checked={settings.pixelArtScaling}
                      onChange={(event) => setExportSettings({ pixelArtScaling: event.target.checked })}
                    />
                    Nearest-neighbour scaling (pixel art)
                  </label>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-slate-400">Resolution</span>
                  <select
                    className="numeric-input"
                    value={activePreset?.id ?? 'custom'}
                    onChange={(event) => {
                      const preset = presets.find((candidate) => candidate.id === event.target.value);
                      if (preset) resize(preset.width, preset.height);
                    }}
                  >
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    {!activePreset && <option value="custom">Custom ({settings.width}x{settings.height})</option>}
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-slate-400">Width</span>
                    <input
                      type="number"
                      className="numeric-input"
                      value={settings.width}
                      onChange={(event) => resize(Number(event.target.value), settings.height)}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-slate-400">Height</span>
                    <input
                      type="number"
                      className="numeric-input"
                      value={settings.height}
                      onChange={(event) => resize(settings.width, Number(event.target.value))}
                    />
                  </label>
                </div>

                {settings.width * settings.height > project.width * project.height * 1.01 && (
                  <p className="text-2xs text-amber-300">
                    Larger than the project ({project.width}x{project.height}): the picture is scaled
                    up, which adds pixels but not detail.
                  </p>
                )}
                <p className="text-2xs text-slate-400">
                  Target bitrate {(settings.bitrateKbps / 1000).toFixed(1)} Mbps, sized from{' '}
                  {settings.width}x{settings.height} @ {settings.fps} fps.
                </p>
              </Section>

              <Section title="Range">
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-slate-400">
                      Start frame <span className="text-slate-400">({formatClock(settings.startFrame / renderFps)})</span>
                    </span>
                    <input
                      type="number"
                      className="numeric-input"
                      value={settings.startFrame}
                      onChange={(event) => setExportSettings({ startFrame: Number(event.target.value) })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-2xs text-slate-400">
                      End frame <span className="text-slate-400">({formatClock(settings.endFrame / renderFps)})</span>
                    </span>
                    <input
                      type="number"
                      className="numeric-input"
                      value={settings.endFrame}
                      onChange={(event) => setExportSettings({ endFrame: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-300">
                    Renders <span className="font-medium text-slate-100">{formatClock(totalFrames / renderFps)}</span> of
                    video <span className="text-slate-400">({totalFrames.toLocaleString()} frames at {renderFps} fps)</span>
                  </p>
                  <button
                    type="button"
                    className="tool-button h-7 shrink-0"
                    title="Export the whole timeline, from the start to the end of the last clip"
                    onClick={() => setExportSettings({ startFrame: 0, endFrame: exportEndFrame(project) })}
                  >
                    Whole timeline
                  </button>
                  {marked && (
                    <button
                      type="button"
                      className="tool-button h-7 shrink-0"
                      title="Export only what is marked on the ruler, between the in and out points"
                      onClick={() => setExportSettings({ startFrame: marked.start, endFrame: marked.end })}
                    >
                      In to out
                    </button>
                  )}
                </div>
              </Section>
            </div>

            {/* The file: where it goes, what it is called, and its cover. */}
            <div className="space-y-3">
              <Section title="File">
                <label className="flex flex-col gap-1">
                  <span className="text-2xs text-slate-400">File name</span>
                  <div className="flex items-center gap-1">
                    <input
                      className="numeric-input"
                      value={fileName}
                      spellCheck={false}
                      onChange={(event) => setFileName(event.target.value)}
                    />
                    <span className="shrink-0 text-2xs text-slate-400">{extension}</span>
                  </div>
                </label>

                <div className="flex items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-2xs text-slate-400">Save in</span>
                    <input readOnly className="numeric-input" value={folder ?? ''} placeholder="Not chosen" />
                  </label>
                  <button type="button" className="tool-button" onClick={() => void chooseFolder()}>
                    <FolderOpen size={14} />
                    Browse
                  </button>
                </div>

                {folder && settings.outputPath && (
                  <p className={`break-all text-2xs ${targetExists ? 'text-amber-300' : 'text-slate-400'}`}>
                    {targetExists ? 'Will replace the existing ' : 'Will save as '}
                    <span className="text-slate-300">{settings.outputPath}</span>
                  </p>
                )}
                {/*
                  The export name defaults to the first video's name, so a folder the
                  footage came from aims the render at the footage itself. That is
                  not a replace, it is a loss - said plainly, and the button is off.
                */}
                {targetInUse && (
                  <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-2xs text-red-300">
                    That file is source footage in this project. Exporting onto it would destroy the
                    original - change the name or the folder.
                  </p>
                )}
              </Section>

              <Section title="Thumbnail">
                {coverArt ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded border border-panel-700 bg-panel-900">
                        {thumbnailPreview ? (
                          <img src={thumbnailPreview} alt="Thumbnail" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-2xs text-slate-400">None</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1">
                        <button type="button" className="tool-button h-7 justify-start" onClick={() => void captureCurrentFrame()}>
                          Use the frame at the playhead
                        </button>
                        <button type="button" className="tool-button h-7 justify-start" onClick={() => void chooseThumbnail()}>
                          Choose an image...
                        </button>
                        {thumbnailPath && (
                          <button
                            type="button"
                            className="tool-button h-7 justify-start text-slate-400"
                            onClick={() => {
                              setThumbnailPath(null);
                              setThumbnailPreview(null);
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-2xs text-slate-400">
                      Embedded as the file&apos;s cover - what Explorer and video players show.
                    </p>
                  </>
                ) : (
                  <p className="text-2xs text-slate-400">
                    {selectedFormat?.label} has no place for a cover image. MP4 and ProRes do.
                  </p>
                )}
              </Section>

              {/* Rarely changed, so it stays folded; the summary still says what will render. */}
              <details className="rounded border border-panel-700 bg-panel-950 p-3" open={restartPending || undefined}>
                {/* What will render stays readable with the section folded. */}
                <summary className="flex cursor-pointer select-none items-center justify-between gap-2">
                  <span className="field-label">Hardware</span>
                  <span className="truncate text-2xs text-slate-300">
                    This render: <span className="text-slate-100">{gpu === null ? 'testing...' : plan.label}</span>
                  </span>
                </summary>

                <div className="mt-3 space-y-2">
                  {gpu === null ? (
                    <p className="flex items-center gap-2 text-2xs text-slate-400">
                      <Loader2 size={12} className="animate-spin" />
                      Testing which GPUs and encoders work on this machine...
                    </p>
                  ) : (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className="text-2xs text-slate-400">Render with (compositor GPU)</span>
                        <select
                          className="numeric-input"
                          value={savedPreference ?? gpu.preference}
                          onChange={(event) => void chooseGpu(event.target.value as GpuPreference)}
                        >
                          {(['auto', 'high-performance', 'low-power'] as const).map((preference) => {
                            const device = gpu.devices.find(
                              (candidate) =>
                                candidate.kind ===
                                (preference === 'high-performance' ? 'dedicated' : 'integrated'),
                            );
                            const available = preference === 'auto' || device !== undefined;
                            return (
                              <option key={preference} value={preference} disabled={!available}>
                                {PREFERENCE_LABELS[preference]}
                                {preference !== 'auto' ? ` - ${device?.name ?? 'not present'}` : ''}
                              </option>
                            );
                          })}
                        </select>
                        <span className="text-2xs text-slate-400">
                          Running on: {activeGpu?.name ?? 'unknown GPU'}
                        </span>
                      </label>

                      {restartPending && (
                        <div className="flex items-center justify-between gap-2 rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                          <span>
                            The GPU is chosen when the app starts. Restart to render on the new one; save
                            your project first.
                          </span>
                          <button
                            type="button"
                            className="tool-button h-6 shrink-0"
                            onClick={() => void window.filmora.relaunch()}
                          >
                            Restart now
                          </button>
                        </div>
                      )}

                      <label className="flex flex-col gap-1">
                        <span className="text-2xs text-slate-400">Encoder</span>
                        <select
                          className="numeric-input"
                          value={settings.hardwareEncoder}
                          onChange={(event) =>
                            setExportSettings({ hardwareEncoder: event.target.value as HardwareEncoder })
                          }
                        >
                          <option value="auto">Automatic</option>
                          {gpu.encoders.map((option) => (
                            <option key={option.encoder} value={option.encoder}>
                              {describeEncoder(option)}
                            </option>
                          ))}
                          <option value="none">CPU (software)</option>
                        </select>
                      </label>

                      {plan.note && <p className="text-2xs text-amber-300">{plan.note}</p>}
                      {gpu.encoders.length === 0 && (
                        <p className="text-2xs text-slate-400">
                          No hardware encoder produced frames on this machine, so only the CPU is offered.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A titled group of related settings. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2 rounded border border-panel-700 bg-panel-950 p-3">
      <h3 className="field-label">{title}</h3>
      {children}
    </section>
  );
}

export default ExportDialog;
