import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, Loader2, X } from 'lucide-react';
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
import { renderTimelineAudio } from '@renderer/audio/renderMix';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { matchPreset, resolutionPresets } from '@shared/utils/resolution';
import { WebCodecsEncoder, detectCodecSupport } from '@renderer/engine/WebCodecsEncoder';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { describeExportProgress, formatClock } from './exportProgress';

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

const PREFERENCE_LABELS: Record<GpuPreference, string> = {
  auto: 'Automatic (let Windows decide)',
  'high-performance': 'Dedicated GPU',
  'low-power': 'Integrated GPU',
};

/** Containers that can carry a cover image. */
const COVER_ART_FORMATS = new Set<ExportFormat>(['mp4-h264', 'mp4-h265', 'prores4444']);

/** The first video's name without its extension, else "export". */
function defaultFileName(assets: readonly MediaAsset[]): string {
  const first = assets.find((asset) => asset.kind === 'video') ?? assets[0];
  return first ? first.name.replace(/\.[^.]+$/, '') : 'export';
}

export interface ExportDialogProps {
  onClose(): void;
}

export function ExportDialog({ onClose }: ExportDialogProps): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const assets = useProjectStore((state) => state.assets);
  const settings = useProjectStore((state) => state.exportSettings);
  const setExportSettings = useProjectStore((state) => state.setExportSettings);

  const [gpu, setGpu] = useState<GpuReport | null>(null);
  const [webCodecs, setWebCodecs] = useState<CodecSupport | null>(null);
  const [savedPreference, setSavedPreference] = useState<GpuPreference | null>(null);
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
      // Seeded every time the dialog opens, not just the first time. With
      // `settings.endFrame ||` here, the first range ever seeded stuck for
      // the whole session: adding 40 minutes to a 5-minute timeline still
      // exported 5 minutes, silently, with the dialog showing that number.
      endFrame: project.durationFrames,
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

      if (settings.format !== 'png-sequence') {
        setMessage('Rendering audio...');
        const mix = await renderTimelineAudio(
          project,
          assets,
          settings.startFrame,
          settings.endFrame,
        ).catch((error: unknown) => {
          setMessage(`Audio mix failed, exporting without sound: ${String(error)}`);
          return null;
        });

        if (mix) {
          audioPath = await window.filmora.writeExportAudio(mix.wav);
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
        ...(audioPath ? { audioPath, audioBitrateKbps } : {}),
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

  return (
    // The editor behind is blurred, so the dialog is the only thing in focus.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="panel w-[560px] max-h-[90vh]">
        <header className="panel-header justify-between">
          <span>Export</span>
          <button type="button" className="tool-button" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* Where the file goes comes first: nothing can start without it. */}
          <Section title="Output">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">File name</span>
              <div className="flex items-center gap-1">
                <input
                  className="numeric-input"
                  value={fileName}
                  spellCheck={false}
                  onChange={(event) => setFileName(event.target.value)}
                />
                <span className="shrink-0 text-2xs text-slate-500">{extension}</span>
              </div>
            </label>

            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-2xs text-slate-400">Save in</span>
                <input readOnly className="numeric-input" value={folder ?? ''} placeholder="Not chosen" />
              </label>
              <button type="button" className="tool-button" onClick={() => void chooseFolder()}>
                <FolderOpen size={14} />
                Browse
              </button>
            </div>

            {folder && settings.outputPath && (
              <p className={`break-all text-2xs ${targetExists ? 'text-amber-300' : 'text-slate-500'}`}>
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

          <Section title="Format and size">
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
            <p className="text-2xs text-slate-500">
              Target bitrate {(settings.bitrateKbps / 1000).toFixed(1)} Mbps, sized from{' '}
              {settings.width}x{settings.height} @ {settings.fps} fps.
            </p>
          </Section>

          <Section title="Range">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-2xs text-slate-400">
                  Start frame <span className="text-slate-500">({formatClock(settings.startFrame / renderFps)})</span>
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
                  End frame <span className="text-slate-500">({formatClock(settings.endFrame / renderFps)})</span>
                </span>
                <input
                  type="number"
                  className="numeric-input"
                  value={settings.endFrame}
                  onChange={(event) => setExportSettings({ endFrame: Number(event.target.value) })}
                />
              </label>
            </div>
            <p className="text-xs text-slate-300">
              Renders <span className="font-medium text-slate-100">{formatClock(totalFrames / renderFps)}</span> of
              video <span className="text-slate-500">({totalFrames.toLocaleString()} frames at {renderFps} fps)</span>
            </p>
          </Section>

          {coverArt && (
            <Section title="Thumbnail">
              <div className="flex items-center gap-3">
                <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded border border-panel-700 bg-panel-900">
                  {thumbnailPreview ? (
                    <img src={thumbnailPreview} alt="Thumbnail" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-2xs text-slate-600">None</span>
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
                      className="tool-button h-7 justify-start text-slate-500"
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
              <p className="text-2xs text-slate-600">
                Embedded as the file&apos;s cover - what Explorer and video players show.
              </p>
            </Section>
          )}

          <Section title="Hardware">
            {gpu === null ? (
              <p className="flex items-center gap-2 text-2xs text-slate-500">
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
                  <span className="text-2xs text-slate-500">
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

                <p className="text-2xs text-slate-300">
                  This render: <span className="text-slate-100">{plan.label}</span>
                </p>
                {plan.note && <p className="text-2xs text-amber-300">{plan.note}</p>}
                {gpu.encoders.length === 0 && (
                  <p className="text-2xs text-slate-500">
                    No hardware encoder produced frames on this machine, so only the CPU is offered.
                  </p>
                )}
              </>
            )}
          </Section>

          {/* Only game-asset exports need these, so they stay folded unless in use. */}
          <details
            className="rounded border border-panel-700 bg-panel-950 p-3"
            open={settings.exportAlpha || settings.premultiplyAlpha || settings.pixelArtScaling || alphaUnsupported}
          >
            <summary className="field-label cursor-pointer select-none">Transparency and pixel art</summary>
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-200">
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
              Leave this off for Godot. Godot imports straight alpha, and premultiplying here is what
              produces dark fringes around sprites.
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
                {selectedFormat?.label} has no alpha channel. Choose PNG sequence, ProRes 4444 or
                WebM/VP9 to keep transparency.
              </p>
            )}
          </details>
        </div>

        {/*
          Progress lives outside the scrolling area, so it stays in view for the
          whole render - and it speaks in minutes of video and time left, not in
          a frame count nobody can turn into a coffee break.
        */}
        {(running || progress || message) && (
          <div className="space-y-2 border-t border-panel-700 bg-panel-950 px-4 py-3">
            {(running || progress) && (
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
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${finished ? 'bg-emerald-500' : 'bg-accent'}`}
                    style={{ width: `${view.percent}%` }}
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
            )}
            {message && <p className="text-2xs leading-relaxed text-slate-300">{message}</p>}
          </div>
        )}

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
            disabled={running || totalFrames <= 0 || targetInUse}
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
