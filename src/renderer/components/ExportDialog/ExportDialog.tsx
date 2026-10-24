import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronRight,
  CircleCheck,
  Clapperboard,
  Crop,
  Film,
  FolderOpen,
  Loader2,
  Play,
  Sparkles,
  Youtube,
  ImagePlay,
  Music2,
  ListPlus,
} from 'lucide-react';
import { ExportQueueList } from './ExportQueueList';
import { useExportQueue, type ExportSource, type QueuedExport } from '@renderer/export/queue';
import type {
  ExportFormat,
  ExportProgress,
  ExportSettings,
  GpuPreference,
  GpuReport,
  HardwareEncoder,
  SubtitleStream,
} from '@shared/types';
import { describeEncoder, resolveEncoderPlan } from '@renderer/engine/encoderPlan';
import type { CodecSupport } from '@renderer/engine/WebCodecsEncoder';
import { recommendedAudioBitrateKbps, recommendedBitrateKbps } from '@shared/utils/bitrate';
import { SOCIAL_PLATFORMS, socialFit, socialSettings, socialSize, type SocialPlatformId } from './socialPresets';
import { useReframeDialog } from '@renderer/components/Reframe/ReframeDialog';
import { streamTimelineAudio } from '@renderer/audio/renderMix';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { matchPreset, resolutionPresets } from '@shared/utils/resolution';
import { WebCodecsEncoder, detectCodecSupport, measureStreamColour } from '@renderer/engine/WebCodecsEncoder';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { currentLocale, useT, type MessageKey } from '@renderer/i18n';
import { errorText } from '@renderer/errorText';
import { notify } from '@renderer/notifications/notifications';
import { describeExportProgress, formatClock } from './exportProgress';
import { exportEndFrame } from './exportRange';
import { defaultFileName } from './exportName';
import { YouTubePanel } from './YouTubePanel';
import { setExporting } from '@renderer/motion/environment';
import { isFamilyMissing, missingFamilies } from '@renderer/text/fonts';
import { useLocalFamilies } from '@renderer/text/useLocalFamilies';
import { FALLBACK_FAMILY } from '@renderer/text/titleStyle';
import { captionCues, captionSettingsOf, captionTracksToDeliver, sidecarTags } from '@renderer/captions/captionClips';
import { subtitleCodecFor, subtitleLanguageCode } from '@shared/utils/subtitleStream';
import { writeSrt } from '@renderer/captions/subtitleFiles';
import { lookOf } from '@renderer/captions/look';
import { withoutCaptions } from '@renderer/captions/captionRender';
import { writeSubtitles, type SubtitleFormat } from '@renderer/captions/subtitleFiles';

/**
 * Export dialog, including the game-asset mode.
 *
 * Laid out the way DaVinci Resolve's Deliver page is: the actions and the
 * render's progress at the top, where they stay in view; quick presets next;
 * then the settings in groups that belong together - the picture (format with
 * its transparency, size and range) on one side, the file (name, folder,
 * cover) and the hardware on the other.
 *
 * Three states, and each reads as what it is. Ready: the settings are the
 * job, all open. Rendering: they are locked, because the render already took
 * its copy. Finished: the result replaces them at the top - what was made,
 * where, and the next steps - and the settings fold into a read-only record,
 * the way Resolve's render queue keeps a completed job and Final Cut's Share
 * inspector keeps a shared item. "New export" brings them back for the next
 * one; until then nothing on screen invites re-submitting the same form.
 *
 * The alpha toggle is the important control: only PNG sequence, ProRes 4444 and
 * WebM/VP9 keep a real alpha channel, so choosing an MP4 with alpha on is
 * flagged here rather than producing a sprite sheet with a black background.
 */

/** Codec names are the same in every language; the PNG sequence's is translated where shown (formatLabel). */
const FORMATS: { value: ExportFormat; label: string; alpha: boolean }[] = [
  { value: 'png-sequence', label: 'PNG sequence (sprite frames)', alpha: true },
  { value: 'prores4444', label: 'ProRes 4444 (.mov)', alpha: true },
  { value: 'webm-vp9', label: 'WebM / VP9', alpha: true },
  { value: 'mp4-h264', label: 'MP4 / H.264', alpha: false },
  { value: 'mp4-h265', label: 'MP4 / H.265', alpha: false },
];

const PREFERENCE_LABELS: Record<GpuPreference, MessageKey> = {
  auto: 'export.gpuAuto',
  'high-performance': 'export.gpuDedicated',
  'low-power': 'export.gpuIntegrated',
};

/** A template with one piece of markup in it: the words either side of {name}. */
function around(template: string, name: string): [string, string] {
  const at = template.indexOf(`{${name}}`);
  return at < 0 ? [template, ''] : [template.slice(0, at), template.slice(at + name.length + 2)];
}

/** Containers that can carry a cover image. */
const COVER_ART_FORMATS = new Set<ExportFormat>(['mp4-h264', 'mp4-h265', 'prores4444']);

/**
 * One-click starting points, like the preset strip at the top of Resolve's
 * render settings. Each sets format, size and transparency together - the
 * three that have to agree - and everything below stays editable.
 */
interface QuickPreset {
  id: string;
  label: MessageKey;
  hint: MessageKey;
  icon: typeof Film;
  format: ExportFormat;
  alpha: boolean;
  /** Height to look for among the resolution presets; null keeps the project size. */
  height: number | null;
}

const QUICK_PRESETS: QuickPreset[] = [
  { id: 'project', label: 'export.presetProject', hint: 'export.presetProjectHint', icon: Film, format: 'mp4-h264', alpha: false, height: null },
  { id: 'youtube', label: 'export.presetYouTube', hint: 'export.presetYouTubeHint', icon: Youtube, format: 'mp4-h264', alpha: false, height: 1080 },
  { id: 'sprites', label: 'export.presetSprites', hint: 'export.presetSpritesHint', icon: Sparkles, format: 'png-sequence', alpha: true, height: null },
  { id: 'master', label: 'export.presetMaster', hint: 'export.presetMasterHint', icon: Clapperboard, format: 'prores4444', alpha: true, height: null },
];

/** What a finished export made, kept as it was when it finished. */
interface FinishedExport {
  path: string;
  /** The file (or, for a PNG sequence, folder) name, and where it is. */
  name: string;
  folder: string;
  /** A video file the system player can open; a PNG sequence is a folder. */
  playable: boolean;
  videoSeconds: number;
  /** Wall clock from Start export to the file being closed, audio mix included. */
  renderSeconds: number;
  encoder: string;
  fps: number;
  /** The subtitle file written beside it, when one was asked for. */
  captionsFile?: string;
  /** The language of the subtitle track put inside it, when one was. */
  captionsEmbedded?: string;
}

/** Where the More settings fold is remembered. */
const MORE_OPEN_KEY = 'scf.exportMoreOpen';
/** The preview's width at most, in pixels: the picture is shown smaller than that. */
const PREVIEW_WIDTH = 640;
/** How often the render's frame is copied into the preview. */
const PREVIEW_EVERY_MS = 400;

/** Split a path at its last separator, either kind. */
function splitPath(path: string): { folder: string; name: string } {
  const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return at < 0 ? { folder: '', name: path } : { folder: path.slice(0, at), name: path.slice(at + 1) };
}


export interface ExportDialogProps {
  onClose(): void;
  /** Playing its exit animation; see usePresence. */
  closing?: boolean;
}

export function ExportDialog({ onClose, closing = false }: ExportDialogProps): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  // Titles whose font this computer lacks are drawn in the fallback: said
  // before the render, not discovered in the file afterwards.
  useLocalFamilies();
  const fontsMissing = missingFamilies(Object.values(project.clips).flatMap((clip) => (clip.title ? [clip.title] : [])));
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
  // While it renders, nothing decorative moves and nothing is blurred
  // (index.css, "Motion"): the render has the machine.
  useEffect(() => {
    setExporting(running);
    return () => setExporting(false);
  }, [running]);
  /** YouTube's upload form is open under the result. */
  const [uploadOpen, setUploadOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** What the last export finished writing: the dialog's finished state. */
  const [result, setResult] = useState<FinishedExport | null>(null);
  /** The finished state's folded record of the settings, opened by hand. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** More settings, open or folded: remembered, as somebody who wants them wants them every time. */
  const [moreOpen, setMoreOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(MORE_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setMoreOpen = (open: boolean): void => {
    setMoreOpenState(open);
    try {
      window.localStorage.setItem(MORE_OPEN_KEY, open ? '1' : '0');
    } catch {
      // Kept for this session only.
    }
  };

  /*
    The picture at the top: the frame at the playhead as the render will draw
    it, when the dialog opens; then, while it renders, the frame just made,
    every PREVIEW_EVERY_MS - a copy of the render canvas, made before the next
    frame is drawn into it. An export waits for the first one, so the two
    never draw at once.
  */
  const previewRef = useRef<HTMLCanvasElement>(null);
  const previewJob = useRef<Promise<void>>(Promise.resolve());
  /** Whether the opening picture is drawn yet: a file just opened takes a second or so to seek to it. */
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'failed'>(() => (getActiveFrameRenderer() ? 'loading' : 'failed'));
  const showPreview = useCallback((source: CanvasImageSource, width: number, height: number): void => {
    const canvas = previewRef.current;
    if (!canvas || !(width > 0) || !(height > 0)) return;
    const scale = Math.min(1, PREVIEW_WIDTH / width);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.getContext('2d')?.drawImage(source, 0, 0, w, h);
    setPreviewState('ready');
  }, []);
  useEffect(() => {
    const renderer = getActiveFrameRenderer();
    if (!renderer) return undefined;
    let alive = true;
    previewJob.current = (async () => {
      const { project: now } = useProjectStore.getState();
      renderer.beginExclusive();
      try {
        // The first exact render of a file can arrive before its seek has landed - black;
        // the second is the picture.
        await renderer.renderExact(now, now.currentFrame, false);
        if (!alive) return;
        const rgba = await renderer.renderExact(now, now.currentFrame, false);
        if (!alive) return;
        const full = document.createElement('canvas');
        full.width = now.width;
        full.height = now.height;
        full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), now.width, now.height), 0, 0);
        showPreview(full, now.width, now.height);
      } catch {
        // A frame the export would refuse (a background not removed yet): said under the picture.
        if (alive) setPreviewState('failed');
      } finally {
        renderer.endExclusive();
      }
    })();
    return () => {
      alive = false;
    };
  }, [showPreview]);
  /** Show in folder or Play failing - no player for the format, say. */
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const fileNameRef = useRef<HTMLInputElement>(null);

  const selectedFormat = FORMATS.find((format) => format.value === settings.format);
  const formatLabel = (format: ExportFormat | undefined): string =>
    format === 'png-sequence' ? t('export.formatPng') : (FORMATS.find((entry) => entry.value === format)?.label ?? '');
  /** A failure is said as an alert, so a screen reader hears it too. */
  const [failed, setFailed] = useState(false);
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
  const [fileName, setFileName] = useState(() => defaultFileName(useSessionStore.getState().projectName));
  const [targetExists, setTargetExists] = useState(false);
  /** The destination is footage this project reads from. Exporting would destroy it. */
  const [targetInUse, setTargetInUse] = useState(false);
  /**
   * Bumped when an export finishes. The name and folder have not changed, but
   * the file now exists, and the next export has to say it will replace it.
   */
  const [targetCheck, setTargetCheck] = useState(0);

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
  }, [folder, fileName, settings.format, setExportSettings, targetCheck]);

  /* Thumbnail --------------------------------------------------------------- */

  // Captions: drawn into the picture (what the viewer shows), and/or written
  // as a file beside the video, which is what YouTube and players take.
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [captionFile, setCaptionFile] = useState<SubtitleFormat | 'none'>('none');
  // And as a track inside the file, which the viewer switches on in the player.
  const [embedCaptions, setEmbedCaptions] = useState(false);
  // The captions tracks that have captions, top first: each can be burnt in
  // or not, and each is its own stream inside the file and its own file
  // beside it, tagged with its language.
  const deliverTracks = useMemo(() => captionTracksToDeliver(project), [project]);
  const captionCount = deliverTracks.reduce((sum, track) => sum + track.count, 0);
  // Burnt in: what the viewer shows - the tracks on show - until changed here.
  const [burnOff, setBurnOff] = useState<ReadonlySet<string>>(() => new Set(deliverTracks.filter((track) => !track.visible).map((track) => track.id)));
  const burnTrackIds = useMemo(() => new Set(deliverTracks.filter((track) => !burnOff.has(track.id)).map((track) => track.id)), [deliverTracks, burnOff]);
  const several = deliverTracks.length > 1;
  const canEmbed = subtitleCodecFor(settings.format) !== null;
  // A captions font this computer lacks is drawn in the fallback, as a title's is: said before the render.
  const captionFontsMissing = [...new Set(project.tracks.filter((track) => burnTrackIds.has(track.id)).map((track) => lookOf(captionSettingsOf(track)).fontFamily))].filter(isFamilyMissing);
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
    } catch (error) {
      // A frame the export would refuse (a background not yet removed) says why.
      notify(errorText(error), 'error');
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
    setChosenPreset(preset.id);
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

  /** The preset last clicked, so two that happen to match cannot both look chosen. */
  const [chosenPreset, setChosenPreset] = useState<string | null>(null);

  const isQuickPresetActive = (preset: QuickPreset): boolean => {
    const size = presetSize(preset);
    return (
      settings.format === preset.format &&
      settings.exportAlpha === preset.alpha &&
      settings.width === size.width &&
      settings.height === size.height
    );
  };

  const matchingPresets = QUICK_PRESETS.filter(isQuickPresetActive);
  const pressedPreset =
    matchingPresets.find((preset) => preset.id === chosenPreset)?.id ?? matchingPresets[0]?.id ?? null;

  /**
   * Render and encode the range. `override` changes settings for this run
   * only - a network's size, its own file name - so an export for several
   * networks runs this once each (exportForNetworks). True once the file is
   * written; false when it could not start, was cancelled or failed.
   */
  const dialogSettings = settings;
  const startExport = useCallback(async (override?: Partial<ExportSettings>, job?: QueuedExport): Promise<boolean> => {
    const settings: ExportSettings = { ...(job?.settings ?? dialogSettings), ...override };
    // What is rendered: a queued job's timeline as it was queued, or the one on screen.
    const run: ExportSource = job ?? {
      project,
      assets,
      burnTrackIds: burnCaptions ? burnTrackIds : new Set(),
      captionFile,
      embedCaptions,
      deliverTracks,
      thumbnailPath: COVER_ART_FORMATS.has(settings.format) ? thumbnailPath : null,
    };
    const renderer = getActiveFrameRenderer();
    if (!renderer) {
      setMessage(t('export.notReady'));
      return false;
    }
    if (!folder || !settings.outputPath) {
      setMessage(t('export.chooseFolderFirst'));
      return false;
    }

    // The opening picture renders on the same canvas: done before this starts.
    await previewJob.current.catch(() => undefined);
    cancelRef.current = false;
    setRunning(true);
    setMessage(null);
    setFailed(false);
    setResult(null);
    setActionError(null);
    const startedAt = performance.now();

    let jobId: string | null = null;
    let encoder: WebCodecsEncoder | null = null;

    // The viewport shares this renderer's video elements and canvas. Left
    // drawing, it seeks them to the playhead mid-export, and the playhead's
    // picture lands in the render as a flash. It stands still until the end.
    renderer.beginExclusive();
    // Decode each clip forwards once instead of seeking per frame. The flag
    // forces the old seek path, for comparing the two in tests.
    if (!(window as { __scfSeekExport?: boolean }).__scfSeekExport) renderer.startSequentialDecode();

    // Captions not burnt in are simply not drawn; everything else is.
    const drawn = withoutCaptions(run.project, run.burnTrackIds);
    // Whether the file will hold the frame's transparency; when not, it is flattened over black.
    const keepsAlpha = settings.exportAlpha && FORMATS.find((format) => format.value === settings.format)?.alpha === true;

    try {
      await renderer.ensureLUTs(run.project);

      // Render the audio mix first: ffmpeg needs it as a file input, so it has
      // to exist before the encoder is spawned.
      let audioPath: string | undefined;
      let audioBitrateKbps: number | undefined;
      let audioRawFormat: { sampleRate: number; channels: number } | undefined;

      if (settings.format !== 'png-sequence') {
        setMessage(t('export.renderingAudio'));
        // A minute at a time, straight to a file: the whole mix never exists
        // in memory at once. See streamTimelineAudio.
        const mixPath = await window.filmora.exportAudioOpen();
        let mix: Awaited<ReturnType<typeof streamTimelineAudio>> = null;
        try {
          mix = await streamTimelineAudio(
            run.project,
            run.assets,
            settings.startFrame,
            settings.endFrame,
            (samples) => window.filmora.exportAudioAppend(mixPath, samples.buffer as ArrayBuffer),
            {
              onProgress: (done, total) =>
                setMessage(t('export.renderingAudioProgress', { done: formatClock(done), total: formatClock(total) })),
            },
          );
        } catch (error) {
          setMessage(t('export.audioFailed', { detail: errorText(error) }));
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
      // Which YUV matrix the platform encoder uses, so the file is tagged to
      // match (measured once per size per session; see measureStreamColour).
      const streamColour = support ? await measureStreamColour(settings, support) : null;
      // The audio is done by now; leaving "Rendering audio..." up for the whole
      // picture render made a slow export look stuck on the sound.
      setMessage(t('export.renderingWith', { encoder: jobPlan.label }));
      // The track inside the file: the captions of the range, as an .srt
      // ffmpeg reads beside the picture and the sound.
      // One stream a captions track, in order, named after it.
      const subtitleStreams: SubtitleStream[] = [];
      if (run.embedCaptions && subtitleCodecFor(settings.format) !== null && window.filmora.captionsWriteTemp) {
        try {
          for (const track of run.deliverTracks) {
            const cues = captionCues(run.project, { trackId: track.id, fromFrame: settings.startFrame, toFrame: settings.endFrame });
            if (cues.length === 0) continue;
            subtitleStreams.push({ path: await window.filmora.captionsWriteTemp(writeSrt(cues)), language: subtitleLanguageCode(track.language), title: track.name });
          }
        } catch (error) {
          notify(t('export.captionsEmbedFailed', { detail: errorText(error) }), 'error');
        }
      }
      const jobSettings = {
        ...settings,
        pipeMode: jobPlan.pipeMode,
        hardwareEncoder: jobPlan.hardwareEncoder,
        ...(streamColour ? { streamColour } : {}),
        ...(audioPath ? { audioPath, audioBitrateKbps, audioRawFormat } : {}),
        ...(run.thumbnailPath ? { thumbnailPath: run.thumbnailPath } : {}),
        ...(subtitleStreams.length === 1 ? { subtitles: { path: subtitleStreams[0].path, language: subtitleStreams[0].language } } : {}),
        ...(subtitleStreams.length > 1 ? { subtitleStreams } : {}),
      };

      const started = await window.filmora.exportStart(jobSettings);
      jobId = started.jobId;
      const activeJobId = jobId;

      if (support) {
        encoder = new WebCodecsEncoder(jobSettings, support, {
          onChunk: (bytes) =>
            window.filmora.exportFrame(activeJobId, bytes.buffer as ArrayBuffer),
          onError: (error) => {
            setFailed(true);
            setMessage(t('export.encoderError', { detail: error.message }));
          },
        });
      }

      // Where an export's time goes, for the benchmarks (tests/ui/fx-bench.mjs).
      const stats = { setupMs: performance.now() - startedAt, frames: 0, renderMs: 0, encodeMs: 0 };
      (window as { __scfExportStats?: typeof stats }).__scfExportStats = stats;
      let previewAt = 0;
      for (let frame = settings.startFrame; frame < settings.endFrame; frame += 1) {
        if (cancelRef.current) {
          encoder?.close();
          await window.filmora.exportCancel(activeJobId);
          setMessage(t('export.cancelled'));
          return false;
        }

        // Say so when a source fell back to seeking: that path is more than an
        // order of magnitude slower, and a silent crawl looks like a bug.
        const done = frame - settings.startFrame;
        if (done === 1 || (done > 0 && done % 600 === 0)) {
          const slow = renderer.slowSources();
          if (slow.length > 0) {
            setMessage(t('export.slowPath', { encoder: jobPlan.label, files: slow.join(', ') }));
          }
        }

        const renderStart = performance.now();
        if (encoder) {
          await renderer.renderExactToCanvas(drawn, frame);
          // The frame just drawn, into the picture at the top, now and then: before the next one replaces it.
          if (renderStart - previewAt >= PREVIEW_EVERY_MS) {
            previewAt = renderStart;
            showPreview(renderer.canvas, settings.width, settings.height);
          }
          const encodeStart = performance.now();
          stats.renderMs += encodeStart - renderStart;
          await encoder.encodeCanvas(renderer.canvas);
          stats.encodeMs += performance.now() - encodeStart;
          stats.frames += 1;
          continue;
        }
        {
          // A file with no alpha channel shows the frame over black, as the viewer
          // does: ffmpeg drops alpha without blending, so a fade, an opacity
          // keyframe or a Fade in left straight would come out at full strength.
          const rgba = await renderer.renderExact(drawn, frame, settings.premultiplyAlpha || !keepsAlpha);
          if (renderStart - previewAt >= PREVIEW_EVERY_MS) {
            previewAt = renderStart;
            showPreview(renderer.canvas, settings.width, settings.height);
          }
          const encodeStart = performance.now();
          stats.renderMs += encodeStart - renderStart;
          await window.filmora.exportFrame(activeJobId, rgba.buffer as ArrayBuffer);
          stats.encodeMs += performance.now() - encodeStart;
          stats.frames += 1;
        }
      }

      // Flush before closing stdin, or the tail of the stream is lost.
      await encoder?.finish();
      encoder = null;

      await window.filmora.exportFinish(activeJobId);
      const fps = settings.fps || run.project.fps;
      // The subtitle file: the captions in the range rendered, counted from its start.
      // One file a track; with several, each named with its language (name.es.srt).
      let captionsFile: string | undefined;
      if (run.captionFile !== 'none' && window.filmora.captionsWriteSidecar) {
        const written: string[] = [];
        const tags = sidecarTags(run.deliverTracks);
        try {
          for (const track of run.deliverTracks) {
            const cues = captionCues(run.project, { trackId: track.id, fromFrame: settings.startFrame, toFrame: settings.endFrame });
            if (cues.length === 0) continue;
            const path = await window.filmora.captionsWriteSidecar(settings.outputPath, run.captionFile, writeSubtitles(run.captionFile, cues), run.deliverTracks.length > 1 ? tags.get(track.id) : undefined);
            written.push(splitPath(path).name);
          }
        } catch (error) {
          notify(t('export.captionsFailed', { detail: errorText(error) }), 'error');
        }
        if (written.length > 0) captionsFile = written.join(', ');
      }
      setResult({
        path: settings.outputPath,
        ...splitPath(settings.outputPath),
        playable: settings.format !== 'png-sequence',
        videoSeconds: (settings.endFrame - settings.startFrame) / fps,
        renderSeconds: (performance.now() - startedAt) / 1000,
        encoder: jobPlan.label,
        fps,
        ...(captionsFile ? { captionsFile } : {}),
        ...(subtitleStreams.length > 0 ? { captionsEmbedded: subtitleStreams.map((stream) => stream.language).join(', ') } : {}),
      });
      // The result card says all of it; a status line repeating it is noise.
      setMessage(null);
      setSettingsOpen(false);
      setTargetCheck((count) => count + 1);
      return true;
    } catch (error) {
      setFailed(true);
      setMessage(t('export.failed', { detail: errorText(error) }));
      encoder?.close();
      if (jobId) await window.filmora.exportCancel(jobId).catch(() => undefined);
      return false;
    } finally {
      renderer.stopSequentialDecode();
      renderer.endExclusive();
      setRunning(false);
    }
  }, [project, assets, dialogSettings, gpu, activeGpu, folder, thumbnailPath, burnCaptions, captionFile, embedCaptions, deliverTracks, burnTrackIds, t]);

  const totalFrames = Math.max(0, settings.endFrame - settings.startFrame);
  const renderFps = settings.fps || project.fps;

  /*
    For social networks: tick the ones wanted, and one click renders a file
    for each - its size and bitrate, the project's own shape, named after the
    network ("My video - TikTok.mp4") - one after another (socialPresets.ts).
  */
  const [networks, setNetworks] = useState<ReadonlySet<SocialPlatformId>>(() => new Set());
  const [batch, setBatch] = useState<{ index: number; total: number; name: string } | null>(null);
  const toggleNetwork = (id: SocialPlatformId): void =>
    setNetworks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /**
   * A GIF of the edit: rendered as an MP4 at twice the GIF's width (no wider
   * than the project), then made a GIF from - its own 256 colours - beside the
   * other exports, the MP4 thrown away (main/exporter/deliverables.ts).
   */
  const [gifWidth, setGifWidth] = useState(480);
  const [gifFps, setGifFps] = useState(15);
  const [audioKind, setAudioKind] = useState<'mp3' | 'wav'>('mp3');
  const exportGif = async (): Promise<void> => {
    if (!folder) {
      setMessage(t('export.chooseFolderFirst'));
      return;
    }
    const temp = await window.filmora.exportTempVideo();
    const width = Math.min(project.width, Math.round((gifWidth * 2) / 2) * 2);
    const height = Math.max(2, Math.round((width * project.height) / project.width / 2) * 2);
    const ok = await startExport({ format: 'mp4-h264', exportAlpha: false, width, height, outputPath: temp });
    if (!ok) return;
    try {
      setRunning(true);
      setMessage(t('export.makingGif'));
      const path = await window.filmora.exportDeliver(folder, fileName, 'gif', temp, { fps: gifFps, width: gifWidth });
      setResult((done) => (done ? { ...done, path, ...splitPath(path), playable: true, encoder: `GIF ${gifWidth} px · ${gifFps} fps` } : done));
      setMessage(null);
    } catch (error) {
      setFailed(true);
      setMessage(t('export.failed', { detail: errorText(error) }));
    } finally {
      setRunning(false);
    }
  };

  /** The sound alone: the mix the video export renders, written as MP3 or WAV - no picture rendered at all. */
  const exportAudioOnly = async (): Promise<void> => {
    if (!folder) {
      setMessage(t('export.chooseFolderFirst'));
      return;
    }
    const startedAt = performance.now();
    setRunning(true);
    setFailed(false);
    setResult(null);
    setMessage(t('export.renderingAudio'));
    const mixPath = await window.filmora.exportAudioOpen();
    let mix: Awaited<ReturnType<typeof streamTimelineAudio>> = null;
    try {
      mix = await streamTimelineAudio(project, assets, dialogSettings.startFrame, dialogSettings.endFrame, (samples) => window.filmora.exportAudioAppend(mixPath, samples.buffer as ArrayBuffer), {
        onProgress: (done, total) => setMessage(t('export.renderingAudioProgress', { done: formatClock(done), total: formatClock(total) })),
      });
      await window.filmora.exportAudioClose(mixPath, mix === null);
      if (!mix) throw new Error(t('export.noSound'));
      const path = await window.filmora.exportDeliver(folder, fileName, audioKind, mixPath, { sampleRate: mix.sampleRate, channels: mix.channels });
      const fps = dialogSettings.fps || project.fps;
      setResult({
        path,
        ...splitPath(path),
        playable: true,
        videoSeconds: (dialogSettings.endFrame - dialogSettings.startFrame) / fps,
        renderSeconds: (performance.now() - startedAt) / 1000,
        encoder: audioKind === 'mp3' ? 'MP3 192 kbps' : 'WAV 16-bit',
        fps,
      });
      setMessage(null);
    } catch (error) {
      await window.filmora.exportAudioClose(mixPath, true).catch(() => undefined);
      setFailed(true);
      setMessage(t('export.failed', { detail: errorText(error) }));
    } finally {
      setRunning(false);
    }
  };

  const exportForNetworks = async (): Promise<void> => {
    if (!folder) {
      setMessage(t('export.chooseFolderFirst'));
      return;
    }
    const chosen = SOCIAL_PLATFORMS.filter((platform) => networks.has(platform.id));
    const written: string[] = [];
    for (const [index, platform] of chosen.entries()) {
      setBatch({ index: index + 1, total: chosen.length, name: platform.name });
      // Its own name; never over a file already there.
      let target = await window.filmora.resolveExportTarget(folder, `${fileName} - ${platform.suffix}`, 'mp4-h264');
      for (let n = 2; (target.exists || target.inUse) && n < 100; n += 1) {
        target = await window.filmora.resolveExportTarget(folder, `${fileName} - ${platform.suffix} (${n})`, 'mp4-h264');
      }
      const ok = await startExport({ ...socialSettings(platform, project.width, project.height, renderFps), outputPath: target.path });
      if (!ok) break;
      written.push(splitPath(target.path).name);
    }
    setBatch(null);
    if (written.length > 0) notify(t('export.networksDone', { count: written.length, names: written.join(', ') }), 'success');
  };
  /* Render queue ------------------------------------------------------------ */

  const queue = useExportQueue((state) => state.jobs);
  const [queueAt, setQueueAt] = useState<{ index: number; total: number; name: string } | null>(null);
  const waiting = queue.filter((job) => job.status === 'waiting');

  /** This export, as set now and of the timeline as it is now, kept to render later. */
  const addToQueue = async (): Promise<void> => {
    if (!folder || !settings.outputPath) {
      setMessage(t('export.chooseFolderFirst'));
      return;
    }
    // Its own file: a second job of the same name is "name (2)", not written over the first.
    const taken = waiting.map((job) => job.settings.outputPath);
    let target = await window.filmora.resolveExportTarget(folder, fileName, settings.format);
    for (let n = 2; taken.includes(target.path) && n < 100; n += 1) {
      target = await window.filmora.resolveExportTarget(folder, `${fileName} (${n})`, settings.format);
    }
    const outputPath = target.path;
    const name = splitPath(outputPath).name;
    useExportQueue.getState().add({
      name,
      settings: { ...settings, outputPath },
      project,
      assets,
      burnTrackIds: burnCaptions ? burnTrackIds : new Set(),
      captionFile,
      embedCaptions,
      deliverTracks,
      thumbnailPath: coverArt ? thumbnailPath : null,
    });
    notify(t('queue.added', { name }), 'success');
  };

  /** Every waiting job, one after another; a cancel stops the queue there. */
  const renderQueue = async (): Promise<void> => {
    const jobs = useExportQueue.getState().jobs.filter((job) => job.status === 'waiting');
    let made = 0;
    for (const [index, job] of jobs.entries()) {
      setQueueAt({ index: index + 1, total: jobs.length, name: job.name });
      useExportQueue.getState().update(job.id, { status: 'rendering' });
      const ok = await startExport(undefined, job);
      const cancelled = !ok && cancelRef.current;
      useExportQueue.getState().update(job.id, { status: ok ? 'done' : cancelled ? 'cancelled' : 'failed' });
      if (ok) made += 1;
      if (cancelled) break;
    }
    setQueueAt(null);
    if (made > 0) notify(t('queue.done', { count: made }), 'success');
  };

  const view = describeExportProgress({
    frame: progress?.frame ?? 0,
    totalFrames: progress?.totalFrames || totalFrames,
    renderFps: progress?.fps ?? 0,
    projectFps: renderFps,
  });
  /** The finished state: what was made replaces the form. */
  const done = !running && result !== null;
  const extension =
    settings.format === 'png-sequence'
      ? t('export.folderSuffix')
      : `.${settings.format === 'prores4444' ? 'mov' : settings.format === 'webm-vp9' ? 'webm' : 'mp4'}`;
  const canStart = !running && totalFrames > 0 && !targetInUse;

  /** Back to ready, keeping every setting: the next export usually differs by one. */
  const newExport = (): void => {
    setResult(null);
    setProgress(null);
    setMessage(null);
    setFailed(false);
    setActionError(null);
    // The name is what most often changes - and left alone, the next render
    // replaces this one, which the File section now says in amber.
    requestAnimationFrame(() => {
      fileNameRef.current?.focus();
      fileNameRef.current?.select();
    });
  };

  const runAction = (action: () => Promise<void>): void => {
    setActionError(null);
    action().catch((error: unknown) => {
      setActionError(errorText(error));
    });
  };

  return (
    // The editor behind is blurred, so the dialog is the only thing in focus.
    // Escape closes it like any dialog - except mid-render, when there is no
    // Close button either: a render is stopped with Cancel render, on purpose.
    <Dialog
      title={t('export.title')}
      onClose={onClose}
      closing={closing}
      dismissible={!running}
      showCloseButton={false}
      initialFocus="dialog"
      widthClass="w-[min(980px,95vw)]"
      className="max-h-[92vh]"
      bodyClassName="flex flex-col !overflow-hidden"
      /*
        The actions live at the top, beside the title, as on Resolve's Deliver
        page: what everything below is for, always in reach without scrolling.
        Same order as every other dialog's footer: the way out, then the
        primary action on the right.
      */
      headerActions={
          <div className="flex items-center gap-2 font-normal">
            {running ? (
              <button
                type="button"
                className="tool-button"
                onClick={() => {
                  cancelRef.current = true;
                }}
              >
                {t('export.cancelRender')}
              </button>
            ) : (
              <button type="button" className="tool-button" onClick={onClose} title={t('dialog.close')}>
                {t('dialog.close')}
              </button>
            )}
            {done ? (
              // Not the primary here: the result's own actions are. Keyed apart
              // from Start export, so a double click cannot turn "New export"
              // into a second render over the file just made.
              <button
                key="new-export"
                type="button"
                className="tool-button border border-panel-600 px-4"
                onClick={newExport}
                title={t('export.newExportHint')}
              >
                {t('export.newExport')}
              </button>
            ) : (
              <>
              {!running && (
                <button
                  type="button"
                  data-testid="export-queue-add"
                  className="tool-button border border-panel-600"
                  disabled={!canStart}
                  onClick={() => void addToQueue()}
                  title={t('queue.addHint')}
                >
                  <ListPlus size={14} aria-hidden />
                  {t('queue.add')}
                </button>
              )}
              <button
                key="start-export"
                type="button"
                className="button-primary"
                disabled={!canStart}
                onClick={() => void startExport()}
              >
                {running && <Loader2 size={14} className="animate-spin" />}
                {running ? t('export.rendering') : t('export.start')}
              </button>
              </>
            )}
          </div>
      }
    >

        {/*
          What will be rendered, then - once started - how far it has got. It
          sits above the scrolling settings, so it stays in view for the whole
          render, and it speaks in minutes of video and time left, not in a
          frame count nobody can turn into a coffee break. Once finished, the
          result card below takes its place.
        */}
        {!done && (
          <div className="shrink-0 space-y-2 border-b border-panel-700 bg-panel-950 px-4 py-3">
            {queueAt && (
              <p data-testid="export-queue-progress" className="text-2xs font-semibold uppercase tracking-wide text-accent-hover">
                {t('queue.progress', { index: queueAt.index, total: queueAt.total, name: queueAt.name })}
              </p>
            )}
            {batch && (
              <p data-testid="export-networks-progress" className="text-2xs font-semibold uppercase tracking-wide text-accent-hover">
                {t('export.networksProgress', { index: batch.index, total: batch.total, name: batch.name })}
              </p>
            )}
            {running || progress ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-100">
                    {running ? t('export.progressRendering') : t('export.progressStopped')}{' '}
                    <span className="tabular-nums">{view.percent.toFixed(1)}%</span>
                  </span>
                  <span className="text-xs tabular-nums text-slate-300">
                    <span className="text-slate-100">{view.videoDone}</span> / {view.videoTotal} {t('export.ofVideo')}
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
                    className="scf-progress-bar h-full w-full rounded-full bg-accent"
                    style={{ transform: `scaleX(${Math.max(0, Math.min(100, view.percent)) / 100})` }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 text-2xs tabular-nums text-slate-400">
                  <span>
                    {t('export.elapsed')} <span className="text-slate-200">{view.elapsed}</span>
                  </span>
                  <span className="text-center">
                    {t('export.remaining')}{' '}
                    <span className="text-slate-200">
                      {running ? (view.remaining ?? t('export.estimating')) : '-'}
                    </span>
                  </span>
                  <span className="text-right">
                    {view.speed !== null ? (
                      <>
                        <span className="text-slate-200">{view.speed.toFixed(1)}x</span>{' '}
                        {t('export.realtime', { fps: (progress?.fps ?? 0).toFixed(0) })}
                      </>
                    ) : (
                      t('export.starting')
                    )}
                  </span>
                </div>
              </>
            ) : (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
                <span className="font-medium text-slate-100">{formatLabel(selectedFormat?.value)}</span>
                <span>
                  {settings.width}x{settings.height} @ {renderFps} fps
                </span>
                <span>{t('export.lengthOfVideo', { length: formatClock(totalFrames / renderFps) })}</span>
                {settings.exportAlpha && !alphaUnsupported && <span className="text-emerald-300">{t('export.withAlpha')}</span>}
                <span className="text-slate-400">{plan.label}</span>
              </p>
            )}
            {message && (
              <p role={failed ? 'alert' : undefined} className={`text-2xs leading-relaxed ${failed ? 'text-red-300' : 'text-slate-300'}`}>
                {message}
              </p>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {queue.length > 0 && (
            <ExportQueueList
              jobs={queue}
              running={running}
              onRender={() => void renderQueue()}
            />
          )}

          {/*
            What will be made, as CapCut's export opens: a large picture of it -
            the frame at the playhead, as the render will draw it; the render
            itself while it runs; a tick when it is done - and beside it what
            most exports need: the name and the place, the format and the size,
            and the stretch of the timeline. The rest waits under More settings.
          */}
          <section data-testid="export-hero" className="mb-4 grid gap-4 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <div className="space-y-1.5">
              <div
                className="relative mx-auto max-h-[46vh] max-w-full overflow-hidden rounded-lg border border-panel-700 bg-black"
                style={{ aspectRatio: `${settings.width} / ${settings.height}` }}
              >
                <canvas ref={previewRef} data-testid="export-preview" data-state={previewState} aria-label={t('export.preview')} className="block h-full w-full object-contain" />
                {previewState === 'loading' && !running && !done && (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400">
                    <Loader2 size={20} className="animate-spin" aria-hidden />
                    <span className="text-2xs">{t('export.previewLoading')}</span>
                  </div>
                )}
                {running && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-10">
                    <span data-testid="export-preview-percent" className="text-2xl font-semibold tabular-nums text-white">
                      {view.percent.toFixed(0)}%
                    </span>
                    <span className="text-2xs tabular-nums text-slate-300">
                      {view.videoDone} / {view.videoTotal}
                    </span>
                  </div>
                )}
                {done && (
                  <div data-testid="export-preview-done" className="scf-export-done pointer-events-none absolute inset-0 grid place-items-center bg-black/40">
                    <span className="grid h-20 w-20 place-items-center rounded-full bg-success shadow-2xl shadow-black/50">
                      <Check size={44} strokeWidth={3} className="text-panel-950" />
                    </span>
                  </div>
                )}
              </div>
              <p className="text-center text-2xs text-slate-400">
                {t(running ? 'export.previewRendering' : done ? 'export.previewDone' : previewState === 'failed' ? 'export.previewFailed' : 'export.previewHint')}
              </p>
            </div>
            <div className="min-w-0 space-y-3">
              {done && result ? (
                <ExportResult
                  result={result}
                  error={actionError}
                  onShowInFolder={() => runAction(() => window.filmora.showExportInFolder(result.path))}
                  onPlay={() => runAction(() => window.filmora.playExport(result.path))}
                />
              ) : (
                <fieldset disabled={running} className="min-w-0 space-y-3 disabled:opacity-70">
                  {/* The name and the place first, accent-bordered: the fields to fill in
                      before Export, the way Resolve's Custom Export leads with File name and Location. */}
                  <section className="space-y-2 rounded-lg border border-accent/40 bg-accent/[0.05] p-3">
                    <h3 className="field-label text-slate-200">{t('export.stepSave')}</h3>
                    <label className="flex flex-col gap-1">
                      <span className="text-2xs text-slate-400">{t('export.fileName')}</span>
                      <div className="flex items-center gap-1">
                        <input
                          ref={fileNameRef}
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
                        <span className="text-2xs text-slate-400">{t('export.saveIn')}</span>
                        <input readOnly className="numeric-input" value={folder ?? ''} placeholder={t('export.notChosen')} />
                      </label>
                      <button type="button" className="tool-button" onClick={() => void chooseFolder()}>
                        <FolderOpen size={14} />
                        {t('export.browse')}
                      </button>
                    </div>
                    {folder && settings.outputPath && (
                      <p className={`break-all text-2xs ${targetExists ? 'text-amber-300' : 'text-slate-400'}`}>
                        {targetExists ? t('export.willReplace') : t('export.willSave')}{' '}
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
                        {t('export.sourceFootage')}
                      </p>
                    )}
                  </section>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-2xs text-slate-400">{t('export.format')}</span>
                      <select
                        className="numeric-input"
                        value={settings.format}
                        onChange={(event) =>
                          setExportSettings({ format: event.target.value as ExportFormat, outputPath: '' })
                        }
                      >
                        {FORMATS.map((format) => (
                          <option key={format.value} value={format.value}>
                            {formatLabel(format.value)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-2xs text-slate-400">{t('export.resolution')}</span>
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
                            {preset.id === 'project' ? t('export.projectSize', { width: preset.width, height: preset.height }) : preset.label}
                          </option>
                        ))}
                        {!activePreset && <option value="custom">{t('export.customSize', { width: settings.width, height: settings.height })}</option>}
                      </select>
                    </label>
                  </div>
                  <p className="text-2xs text-slate-400">
                    {t('export.bitrate', { mbps: (settings.bitrateKbps / 1000).toFixed(1), width: settings.width, height: settings.height, fps: settings.fps })}
                  </p>
                  {fontsMissing.length > 0 && (
                    <p role="status" data-testid="export-fonts-missing" className="text-2xs text-amber-300">
                      {t('export.missingFonts', { fonts: fontsMissing.join(', '), fallback: FALLBACK_FAMILY })}
                    </p>
                  )}
                  {/* Which stretch of the timeline: the whole edit, the part marked on the ruler, or frames typed. */}
                  <Section title={t('export.sectionRange')}>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-2xs text-slate-400">
                          {t('export.startFrame')} <span className="text-slate-400">({formatClock(settings.startFrame / renderFps)})</span>
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
                          {t('export.endFrame')} <span className="text-slate-400">({formatClock(settings.endFrame / renderFps)})</span>
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
                        {around(t('export.renders'), 'length')[0]}
                        <span className="font-medium text-slate-100">{formatClock(totalFrames / renderFps)}</span>
                        {around(t('export.renders'), 'length')[1]}{' '}
                        <span className="text-slate-400">
                          {t('export.rendersFrames', { frames: totalFrames.toLocaleString(currentLocale()), fps: renderFps })}
                        </span>
                      </p>
                      <button
                        type="button"
                        className="tool-button h-7 shrink-0"
                        title={t('export.wholeTimelineHint')}
                        onClick={() => setExportSettings({ startFrame: 0, endFrame: exportEndFrame(project) })}
                      >
                        {t('export.wholeTimeline')}
                      </button>
                      {marked && (
                        <button
                          type="button"
                          className="tool-button h-7 shrink-0"
                          title={t('export.inToOutHint')}
                          onClick={() => setExportSettings({ startFrame: marked.start, endFrame: marked.end })}
                        >
                          {t('export.inToOut')}
                        </button>
                      )}
                    </div>
                  </Section>
                </fieldset>
              )}
            </div>
          </section>

          {/* A finished video YouTube takes: offer to send it there, under the result. */}
          {done && result && /\.(mp4|mov|webm)$/i.test(result.path) && (
            <div className={uploadOpen ? 'mb-3' : 'mb-3 md:max-w-md'}>
              <YouTubePanel path={result.path} defaultTitle={fileName} onExpandedChange={setUploadOpen} />
            </div>
          )}

          {/* Captions, when the edit has any: in the picture, in the file, beside it. */}
          {!done && captionCount > 0 && (
            <fieldset disabled={running} className="mb-4 min-w-0 disabled:opacity-70">
              <Section title={t('export.captions')}>
                {/* Three ways out, each said for what it is: in the picture, in
                    the file as a track, or beside it as a file. Any or all. */}
                <p className="text-2xs text-slate-400" data-testid="export-captions-intro">
                  {t('export.captionsCount', { count: captionCount })} {t('export.captionsIntro')}
                </p>
                <label className="flex items-start gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    data-testid="export-captions-burn"
                    checked={burnCaptions}
                    onChange={(event) => setBurnCaptions(event.target.checked)}
                  />
                  <span>
                    {t('export.captionsBurn')}
                    <span className="block text-2xs leading-relaxed text-slate-400">{t('export.captionsBurnHint2')}</span>
                  </span>
                </label>
                {several && burnCaptions && (
                  <fieldset className="ml-6 flex flex-col gap-1" data-testid="export-captions-burn-tracks" aria-label={t('export.captionsBurn')}>
                    {deliverTracks.map((track) => (
                      <label key={track.id} className="flex items-center gap-2 text-xs text-slate-200">
                        <input
                          type="checkbox"
                          data-testid="export-captions-burn-track"
                          data-track={track.id}
                          checked={burnTrackIds.has(track.id)}
                          onChange={(event) =>
                            setBurnOff((off) => {
                              const next = new Set(off);
                              if (event.target.checked) next.delete(track.id);
                              else next.add(track.id);
                              return next;
                            })
                          }
                        />
                        {t('export.captionsTrackLabel', { name: track.name, language: t(track.language === 'en' ? 'captions.languageNameEn' : 'captions.languageNameEs') })}
                      </label>
                    ))}
                    <span className="text-2xs leading-relaxed text-slate-400">{t('export.captionsBurnTracks')}</span>
                  </fieldset>
                )}
                <label className={`flex items-start gap-2 text-xs ${canEmbed ? 'text-slate-200' : 'text-slate-400'}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    data-testid="export-captions-embed"
                    disabled={!canEmbed}
                    checked={embedCaptions && canEmbed}
                    onChange={(event) => setEmbedCaptions(event.target.checked)}
                  />
                  <span>
                    {t('export.captionsEmbed')}
                    <span className="block text-2xs leading-relaxed text-slate-400">
                      {canEmbed ? t(several ? 'export.captionsEmbedHintMany' : 'export.captionsEmbedHint') : t('export.captionsEmbedUnsupported', { format: formatLabel(selectedFormat?.value) })}
                    </span>
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-200">{t('export.captionsFile')}</span>
                  <select
                    className="numeric-input"
                    data-testid="export-captions-file"
                    value={captionFile}
                    onChange={(event) => setCaptionFile(event.target.value === 'srt' || event.target.value === 'vtt' ? event.target.value : 'none')}
                  >
                    <option value="none">{t('export.captionsFileNone')}</option>
                    <option value="srt">{t('export.captionsFileSrt')}</option>
                    <option value="vtt">{t('export.captionsFileVtt')}</option>
                  </select>
                  <span className="text-2xs leading-relaxed text-slate-400">{several ? t('export.captionsFileHintMany', { name: fileName || 'video' }) : t('export.captionsFileHint')}</span>
                </label>
                {burnCaptions && burnTrackIds.size > 0 && embedCaptions && canEmbed && (
                  <p role="status" className="text-2xs leading-relaxed text-amber-200" data-testid="export-captions-twice">
                    {t('export.captionsTwice')}
                  </p>
                )}
                {captionFontsMissing.length > 0 && burnCaptions && burnTrackIds.size > 0 && (
                  <p role="status" data-testid="export-caption-fonts-missing" className="text-2xs text-amber-300">
                    {t('export.missingFonts', { fonts: captionFontsMissing.join(', '), fallback: FALLBACK_FAMILY })}
                  </p>
                )}
              </Section>
            </fieldset>
          )}

          {/* Everything else, folded until wanted: presets, networks, a GIF or the sound alone, and the details. */}
          {!done && (
            <button
              type="button"
              data-testid="export-more"
              aria-expanded={moreOpen}
              aria-controls="export-settings"
              className="mb-3 flex w-full items-center gap-2 rounded-lg border border-panel-700 bg-panel-950 px-3 py-2 text-left hover:border-panel-600"
              onClick={() => setMoreOpen(!moreOpen)}
            >
              <ChevronRight size={14} className={`shrink-0 text-slate-400 transition-transform ${moreOpen ? 'rotate-90' : ''}`} />
              <span className="field-label shrink-0">{t('export.moreSettings')}</span>
              <span className="truncate text-2xs text-slate-500">{t('export.moreSettingsHint')}</span>
            </button>
          )}

          {/*
            Finished, the settings are a record of what made the file: folded to
            one line that still says what they were, and locked if opened. They
            are also locked while rendering - the render took its copy at the
            start, so a field changed now would show something it is not doing.
          */}
          {done && (
            <button
              type="button"
              aria-expanded={settingsOpen}
              aria-controls="export-settings"
              className="mb-3 flex w-full items-center justify-between gap-3 rounded-lg border border-panel-700 bg-panel-950 px-3 py-2 text-left hover:border-panel-600"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <span className="flex shrink-0 items-center gap-1.5">
                <ChevronRight
                  size={14}
                  className={`text-slate-400 transition-transform ${settingsOpen ? 'rotate-90' : ''}`}
                />
                <span className="field-label">{t('export.settingsUsed')}</span>
              </span>
              <span className="truncate text-2xs text-slate-300">
                {formatLabel(selectedFormat?.value)} &middot; {settings.width}x{settings.height} @ {renderFps} fps &middot;{' '}
                {formatClock(settings.startFrame / renderFps)}-{formatClock(settings.endFrame / renderFps)}
              </span>
            </button>
          )}

          <fieldset
            id="export-settings"
            disabled={running || done}
            hidden={done ? !settingsOpen : !moreOpen}
            className="min-w-0 disabled:opacity-70"
          >
            {done && (
              <p className="mb-3 text-2xs text-slate-400">
                {t('export.settingsRecord')}
              </p>
            )}

            {/* Step 1: a quick preset sets format, size and transparency together. */}
            <div className="mb-4 space-y-1.5">
              <h3 className="field-label">{t('export.stepPreset')}</h3>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('export.presets')}>
              {QUICK_PRESETS.map((preset) => {
                const Icon = preset.icon;
                // At most one is pressed. "Project" and "YouTube 1080p" are the
                // same settings for a 1080p project, and both used to light up;
                // the one that was clicked wins, else the first that matches.
                const active = preset.id === pressedPreset;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    title={t(preset.hint)}
                    disabled={running}
                    className={`tool-button h-auto flex-col items-start gap-0.5 border px-3 py-2 text-left ${
                      active ? 'tool-button-active border-transparent' : 'border-panel-700 bg-panel-950'
                    }`}
                    onClick={() => applyQuickPreset(preset)}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <Icon size={13} />
                      {t(preset.label)}
                    </span>
                    <span className="text-2xs text-slate-400">{t(preset.hint)}</span>
                  </button>
                );
              })}
              </div>
            </div>

            {/* For social networks: one file each, in one go. */}
            <section className="mb-4 space-y-2 rounded-lg border border-panel-700 bg-panel-950/60 p-3" data-testid="export-networks">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="field-label text-slate-200">{t('export.stepNetworks')}</h3>
                <span className="text-2xs text-slate-400">{t('export.networksHint')}</span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
                {SOCIAL_PLATFORMS.map((platform) => {
                  const size = socialSize(platform, project.width, project.height);
                  const fit = socialFit(platform, project.width, project.height);
                  const on = networks.has(platform.id);
                  return (
                    <label
                      key={platform.id}
                      data-testid={`export-network-${platform.id}`}
                      className={`press flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                        on ? 'border-accent/60 bg-accent/15' : 'border-panel-700 bg-panel-900 hover:border-panel-600'
                      }`}
                    >
                      <input type="checkbox" className="mt-0.5" checked={on} disabled={running} onChange={() => toggleNetwork(platform.id)} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-slate-100">{platform.name}</span>
                        {/* The file's own size; the network's screen shape goes with how it shows there. */}
                        <span className="block text-2xs tabular-nums text-slate-400">{t('export.networkFile', { width: size.width, height: size.height })}</span>
                        <span className={`block text-2xs ${fit === 'fills' ? 'text-emerald-300' : 'text-amber-300'}`}>
                          {t(fit === 'fills' ? 'export.networkFills' : fit === 'pillarbox' ? 'export.networkBarsSides' : 'export.networkBarsTopBottom', {
                            aspect: `${platform.aspect.w}:${platform.aspect.h}`,
                          })}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {SOCIAL_PLATFORMS.some((platform) => networks.has(platform.id) && socialFit(platform, project.width, project.height) !== 'fills') && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 text-2xs leading-relaxed text-amber-200/90">{t('export.networkShapeHint')}</p>
                  <button
                    type="button"
                    data-testid="export-reframe"
                    className="tool-button h-control shrink-0 border border-amber-300/50 text-amber-100"
                    disabled={running}
                    onClick={() => useReframeDialog.getState().show()}
                  >
                    <Crop size={13} />
                    {t('reframe.open')}
                  </button>
                </div>
              )}
              <button
                type="button"
                data-testid="export-networks-start"
                className="tool-button h-control w-full justify-center border border-accent/50 bg-accent/10 text-accent-hover hover:bg-accent/20"
                disabled={running || networks.size === 0 || !folder}
                onClick={() => void exportForNetworks()}
              >
                {networks.size === 0 ? t('export.networksNone') : t('export.networksStart', { count: networks.size })}
              </button>
            </section>

            {/* A GIF of it, or its sound alone: files made from a render, beside the others. */}
            <section className="mb-4 grid gap-2 sm:grid-cols-2" data-testid="export-extras">
              <div className="space-y-2 rounded-lg border border-panel-700 bg-panel-950/60 p-3">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <ImagePlay size={13} className="text-accent-hover" aria-hidden />
                  {t('export.gifTitle')}
                </h3>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-2xs text-slate-400">{t('export.gifWidth')}</span>
                    <select data-testid="export-gif-width" className="numeric-input h-control-dense" value={gifWidth} disabled={running} onChange={(event) => setGifWidth(Number(event.target.value))}>
                      {[320, 480, 640, 960].map((width) => (
                        <option key={width} value={width}>
                          {width} px
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-2xs text-slate-400">{t('export.gifFps')}</span>
                    <select data-testid="export-gif-fps" className="numeric-input h-control-dense" value={gifFps} disabled={running} onChange={(event) => setGifFps(Number(event.target.value))}>
                      {[10, 15, 24].map((fps) => (
                        <option key={fps} value={fps}>
                          {fps} fps
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="text-2xs leading-relaxed text-slate-400">{t('export.gifHint')}</p>
                <button type="button" data-testid="export-gif" className="tool-button h-control w-full justify-center border border-panel-600" disabled={running || !folder} onClick={() => void exportGif()}>
                  {t('export.gifStart')}
                </button>
              </div>
              <div className="space-y-2 rounded-lg border border-panel-700 bg-panel-950/60 p-3">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <Music2 size={13} className="text-accent-hover" aria-hidden />
                  {t('export.audioTitle')}
                </h3>
                <div role="radiogroup" aria-label={t('export.audioTitle')} className="flex rounded-control bg-panel-900 p-0.5">
                  {(['mp3', 'wav'] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={audioKind === kind}
                      data-testid={`export-audio-${kind}`}
                      disabled={running}
                      className={`flex-1 rounded-[4px] py-1 text-2xs font-medium ${audioKind === kind ? 'bg-panel-600 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}
                      onClick={() => setAudioKind(kind)}
                    >
                      {kind.toUpperCase()}
                    </button>
                  ))}
                </div>
                <p className="text-2xs leading-relaxed text-slate-400">{t(audioKind === 'mp3' ? 'export.audioHintMp3' : 'export.audioHintWav')}</p>
                <button type="button" data-testid="export-audio" className="tool-button h-control w-full justify-center border border-panel-600" disabled={running || !folder} onClick={() => void exportAudioOnly()}>
                  {t('export.audioStart', { kind: audioKind.toUpperCase() })}
                </button>
              </div>
            </section>

            <div className="grid gap-3 md:grid-cols-2">
              {/* The picture: what it is and how big. */}
              <div className="space-y-3">
                <Section title={t('export.sectionVideo')}>
                  {/* Transparency belongs with the format: the format decides whether it can exist. */}
                  <div className="space-y-1.5 rounded border border-panel-700 bg-panel-900 p-2">
                    <label className="flex items-center gap-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={settings.exportAlpha}
                        onChange={(event) => setExportSettings({ exportAlpha: event.target.checked })}
                      />
                      {t('export.alpha')}
                      <span className="text-2xs text-slate-400">{t('export.alphaFormats')}</span>
                    </label>
                    {alphaUnsupported && (
                      <p className="rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                        {t('export.alphaUnsupported', { format: formatLabel(selectedFormat?.value) })}
                      </p>
                    )}
                    {(settings.exportAlpha || settings.premultiplyAlpha) && (
                      <>
                        <label className="flex items-center gap-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            className="accent-accent"
                            checked={settings.premultiplyAlpha}
                            onChange={(event) => setExportSettings({ premultiplyAlpha: event.target.checked })}
                          />
                          {t('export.premultiply')}
                        </label>
                        <p className="pl-6 text-2xs leading-relaxed text-slate-400">{t('export.premultiplyHint')}</p>
                      </>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-2xs text-slate-400">{t('export.width')}</span>
                      <input
                        type="number"
                        className="numeric-input"
                        value={settings.width}
                        onChange={(event) => resize(Number(event.target.value), settings.height)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-2xs text-slate-400">{t('export.height')}</span>
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
                      {t('export.upscaled', { width: project.width, height: project.height })}
                    </p>
                  )}

                  {/* Rarely wanted, and wrong for filmed footage, so it is folded away -
                      but opens by itself when it is on, so a setting in force is
                      never hidden. */}
                  <details className="rounded border border-panel-700 bg-panel-900 p-2" open={settings.pixelArtScaling || undefined}>
                    <summary className="cursor-pointer select-none text-xs text-slate-300">{t('export.advanced')}</summary>
                    <div className="mt-2 space-y-1">
                      <label className="flex items-center gap-2 text-xs text-slate-300">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          checked={settings.pixelArtScaling}
                          onChange={(event) => setExportSettings({ pixelArtScaling: event.target.checked })}
                        />
                        {t('export.nearest')}
                      </label>
                      <p className="pl-6 text-2xs leading-relaxed text-slate-400">{t('export.nearestHint')}</p>
                    </div>
                  </details>
                </Section>
              </div>

              {/* The range, cover image, captions and hardware. */}
              <div className="space-y-3">
                <Section title={t('export.sectionThumbnail')}>
                  {coverArt ? (
                    <>
                      <div className="flex items-center gap-3">
                        <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded border border-panel-700 bg-panel-900">
                          {thumbnailPreview ? (
                            <img src={thumbnailPreview} alt={t('export.thumbnailAlt')} className="h-full w-full object-cover" />
                          ) : (
                            <span className="text-2xs text-slate-400">{t('export.thumbnailNone')}</span>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <button type="button" className="tool-button h-7 justify-start" onClick={() => void captureCurrentFrame()}>
                            {t('export.thumbnailPlayhead')}
                          </button>
                          <button type="button" className="tool-button h-7 justify-start" onClick={() => void chooseThumbnail()}>
                            {t('export.thumbnailChoose')}
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
                              {t('export.thumbnailRemove')}
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="text-2xs text-slate-400">
                        {t('export.thumbnailHint')}
                      </p>
                    </>
                  ) : (
                    <p className="text-2xs text-slate-400">
                      {t('export.thumbnailUnsupported', { format: formatLabel(selectedFormat?.value) })}
                    </p>
                  )}
                </Section>

                {/* Rarely changed, so it stays folded; the summary still says what will render. */}
                <details className="rounded border border-panel-700 bg-panel-950 p-3" open={restartPending || undefined}>
                  {/* What will render stays readable with the section folded. */}
                  <summary className="flex cursor-pointer select-none items-center justify-between gap-2">
                    <span className="field-label">{t('export.sectionHardware')}</span>
                    <span className="truncate text-2xs text-slate-300">
                      {t('export.thisRender')} <span className="text-slate-100">{gpu === null ? t('export.testing') : plan.label}</span>
                    </span>
                  </summary>

                  <div className="mt-3 space-y-2">
                    {gpu === null ? (
                      <p className="flex items-center gap-2 text-2xs text-slate-400">
                        <Loader2 size={12} className="animate-spin" />
                        {t('export.testingGpus')}
                      </p>
                    ) : (
                      <>
                        <label className="flex flex-col gap-1">
                          <span className="text-2xs text-slate-400">{t('export.renderWith')}</span>
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
                                  {t(PREFERENCE_LABELS[preference])}
                                  {preference !== 'auto' ? ` - ${device?.name ?? t('export.gpuMissing')}` : ''}
                                </option>
                              );
                            })}
                          </select>
                          <span className="text-2xs text-slate-400">
                            {t('export.runningOn', { gpu: activeGpu?.name ?? t('export.unknownGpu') })}
                          </span>
                        </label>

                        {restartPending && (
                          <div className="flex items-center justify-between gap-2 rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                            <span>{t('export.restartNeeded')}</span>
                            <button
                              type="button"
                              className="tool-button h-6 shrink-0"
                              onClick={() => void window.filmora.relaunch()}
                            >
                              {t('export.restartNow')}
                            </button>
                          </div>
                        )}

                        <label className="flex flex-col gap-1">
                          <span className="text-2xs text-slate-400">{t('export.encoder')}</span>
                          <select
                            className="numeric-input"
                            value={settings.hardwareEncoder}
                            onChange={(event) =>
                              setExportSettings({ hardwareEncoder: event.target.value as HardwareEncoder })
                            }
                          >
                            <option value="auto">{t('export.encoderAuto')}</option>
                            {gpu.encoders.map((option) => (
                              <option key={option.encoder} value={option.encoder}>
                                {describeEncoder(option)}
                              </option>
                            ))}
                            <option value="none">{t('export.encoderCpu')}</option>
                          </select>
                        </label>

                        {plan.note && <p className="text-2xs text-amber-300">{plan.note}</p>}
                        {gpu.encoders.length === 0 && (
                          <p className="text-2xs text-slate-400">
                            {t('export.noHardware')}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </details>
              </div>
            </div>
          </fieldset>
        </div>
    </Dialog>
  );
}

/**
 * The finished state's headline: that it worked, what was made, and what to
 * do with it next. Final Cut's "Share successful" notice has its Show button
 * and Resolve's completed job its Open File Location; Premiere users keep
 * asking for the same on its export notice. The numbers are only ones this
 * dialog measured - nothing estimated.
 */
function ExportResult({
  result,
  error,
  onShowInFolder,
  onPlay,
}: {
  result: FinishedExport;
  error: string | null;
  onShowInFolder(): void;
  onPlay(): void;
}): JSX.Element {
  const t = useT();
  const stats: { label: string; value: string; wide?: boolean }[] = [
    { label: t('export.statLength'), value: formatClock(result.videoSeconds) },
    { label: t('export.statRenderTime'), value: formatClock(result.renderSeconds) },
    { label: t('export.statFrameRate'), value: `${Number(result.fps.toFixed(3))} fps` },
    { label: t('export.statEncoder'), value: result.encoder, wide: true },
    ...(result.captionsFile || result.captionsEmbedded
      ? [
          {
            label: t('export.statCaptions'),
            value: [result.captionsEmbedded ? t('export.captionsEmbedded', { language: result.captionsEmbedded }) : '', result.captionsFile ?? ''].filter(Boolean).join(' · '),
            wide: true,
          },
        ]
      : []),
  ];
  return (
    <section
      data-testid="export-result"
      aria-labelledby="export-result-title"
      className="space-y-3 rounded-lg border border-success/35 bg-success/[0.06] p-4"
    >
      <div className="flex items-start gap-3">
        <CircleCheck size={28} className="scf-check mt-0.5 shrink-0 text-success" aria-hidden />
        <div className="min-w-0">
          <h2 id="export-result-title" className="text-base font-semibold text-slate-100">
            {t('export.finished')}
          </h2>
          <p className="truncate text-sm text-slate-200" title={result.path}>
            {result.name}
          </p>
          <p className="break-all text-2xs text-slate-400">{t('export.inFolder', { folder: result.folder })}</p>
        </div>
      </div>

      {/* The render bar, arrived: the same bar that ran now reads as done. */}
      <div
        className="h-1.5 w-full rounded-full bg-success"
        role="progressbar"
        aria-label={t('export.title')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={100}
      />

      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {stats.map((stat) => (
          <div key={stat.label} className={stat.wide ? 'min-w-0 flex-1 basis-48' : 'shrink-0'}>
            <dt className="field-label">{stat.label}</dt>
            <dd className="truncate text-xs tabular-nums text-slate-100" title={stat.value}>
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="tool-button bg-success px-4 font-semibold text-panel-950 hover:bg-success-hover hover:text-panel-950"
          onClick={onShowInFolder}
        >
          <FolderOpen size={14} />
          {t('export.showInFolder')}
        </button>
        {result.playable && (
          <button type="button" className="tool-button border border-panel-600 px-4" onClick={onPlay}>
            <Play size={14} />
            {t('export.play')}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded bg-red-500/10 px-2 py-1.5 text-2xs text-red-300">
          {error}
        </p>
      )}
    </section>
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
