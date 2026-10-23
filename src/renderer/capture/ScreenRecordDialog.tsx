import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Circle, Loader2, MonitorUp, Square } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { framesToTimecode } from '@shared/utils/timecode';

/**
 * Record the screen - a tutorial, a game, a demo - and the webcam with it:
 * the screen (or one window) and the microphone into one recording, the
 * camera into another; both kept as MP4 in the app's folder and put on the
 * timeline at the playhead - the screen on a track of its own, the camera on
 * one above it, small in the bottom-right corner, as a picture-in-picture.
 * While it records, the editor can be minimised and any app used; Stop here,
 * or Ctrl+Shift+F9 from anywhere, ends it.
 */

export const useScreenRecordDialog = create<{ open: boolean; show(): void; close(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

interface Source {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
}

type Phase = { kind: 'idle' } | { kind: 'counting'; left: number } | { kind: 'recording'; since: number } | { kind: 'saving' };

/** The camera's place on the frame: a quarter of its width, in the bottom-right corner. */
const PIP_SHARE = 0.25;

const mimeOf = (): string => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm';

export function ScreenRecordDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element {
  const t = useT();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [sourceId, setSourceId] = useState<string>('');
  const [withMic, setWithMic] = useState(true);
  const [withCamera, setWithCamera] = useState(false);
  const [minimise, setMinimise] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const recorders = useRef<Array<{ recorder: MediaRecorder; chunks: Blob[]; camera: boolean }>>([]);
  const startFrame = useRef(0);
  const fps = useProjectStore((state) => state.project.fps);

  useEffect(() => {
    void window.filmora
      .captureSources()
      .then((found) => {
        const ordered = [...found].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1));
        setSources(ordered);
        if (ordered[0]) setSourceId(ordered[0].id);
      })
      .catch((problem) => setError(String(problem)));
  }, []);

  useEffect(() => {
    if (phase.kind !== 'recording') return undefined;
    const timer = window.setInterval(() => setElapsed((performance.now() - phase.since) / 1000), 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  const release = (): void => {
    streams.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    streams.current = [];
    void window.filmora.captureStopShortcut(false);
  };
  // Nothing kept recording if the dialog goes away.
  useEffect(() => () => {
    recorders.current.forEach(({ recorder }) => recorder.state === 'recording' && recorder.stop());
    release();
  }, []);

  const finish = async (): Promise<void> => {
    if (recorders.current.length === 0) return;
    setPhase({ kind: 'saving' });
    await Promise.all(
      recorders.current.map(
        ({ recorder }) =>
          new Promise<void>((resolve) => {
            if (recorder.state === 'inactive') resolve();
            else {
              recorder.onstop = () => resolve();
              recorder.stop();
            }
          }),
      ),
    );
    release();
    try {
      const now = new Date();
      const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join('-');
      const mark = useHistoryStore.getState().undoStack.length;
      const placed: Array<{ clipId: string; camera: boolean }> = [];
      for (const { chunks, camera, recorder } of recorders.current) {
        const webm = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
        const name = `${t(camera ? 'capture.cameraName' : 'capture.screenName')} ${stamp}`;
        const path = await window.filmora.saveScreenRecording(name, webm);
        const asset = await buildAsset({ name: `${name}.mp4`, uri: await window.filmora.mediaUrl(path), sourcePath: path, hasAudio: !camera && withMic }, fps);
        useProjectStore.getState().addAssets([asset]);
        const added = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
        useProjectStore.getState().setCurrentFrame(startFrame.current);
        const clipId = useProjectStore.getState().addAssetOnNewTrack(added);
        if (clipId) placed.push({ clipId, camera });
      }
      // The camera: small, in the bottom-right corner, over the screen.
      const { project } = useProjectStore.getState();
      for (const { clipId, camera } of placed) {
        if (!camera) continue;
        const clip = useProjectStore.getState().project.clips[clipId];
        if (!clip) continue;
        const scale = PIP_SHARE;
        const margin = 0.03;
        useProjectStore.getState().updateClip(clipId, {
          transform: {
            ...clip.transform,
            scale: [{ id: `pip-${clipId}`, frame: clip.startFrame, value: { x: scale, y: scale }, easing: 'linear' }],
            position: [{ id: `pip-pos-${clipId}`, frame: clip.startFrame, value: { x: project.width * (0.5 - scale / 2 - margin), y: project.height * (0.5 - scale / 2 - margin) }, easing: 'linear' }],
          },
        });
      }
      useHistoryStore.getState().squash(mark, 'Screen recording');
      notify(t('capture.done', { seconds: Math.round(elapsed) }), 'success');
      recorders.current = [];
      setPhase({ kind: 'idle' });
      onClose();
    } catch (problem) {
      recorders.current = [];
      setPhase({ kind: 'idle' });
      setError(t('capture.failed', { detail: problem instanceof Error ? problem.message : String(problem) }));
    }
  };

  // Ctrl+Shift+F9 from anywhere stops it.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => window.filmora.onCaptureStop(() => void finishRef.current()), []);

  const begin = async (): Promise<void> => {
    if (!sourceId) return;
    setError(null);
    try {
      // Asked for before the count, so a refused microphone or camera says so at once.
      const screen = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30 } } as unknown as MediaTrackConstraints,
      });
      const mic = withMic ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }) : null;
      const camera = withCamera ? await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false }) : null;
      streams.current = [screen, ...(mic ? [mic] : []), ...(camera ? [camera] : [])];
      const combined = new MediaStream([...screen.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])]);
      recorders.current = [{ recorder: new MediaRecorder(combined, { mimeType: mimeOf(), videoBitsPerSecond: 8_000_000 }), chunks: [], camera: false }];
      if (camera) recorders.current.push({ recorder: new MediaRecorder(camera, { mimeType: mimeOf(), videoBitsPerSecond: 4_000_000 }), chunks: [], camera: true });
      for (const entry of recorders.current) {
        entry.recorder.ondataavailable = (event) => {
          if (event.data.size > 0) entry.chunks.push(event.data);
        };
      }
    } catch (problem) {
      release();
      setError(t('capture.noAccess', { detail: problem instanceof Error ? problem.message : String(problem) }));
      return;
    }
    let left = 3;
    setPhase({ kind: 'counting', left });
    const timer = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        setPhase({ kind: 'counting', left });
        return;
      }
      window.clearInterval(timer);
      startFrame.current = useProjectStore.getState().project.currentFrame;
      recorders.current.forEach(({ recorder }) => recorder.start(500));
      setElapsed(0);
      setPhase({ kind: 'recording', since: performance.now() });
      void window.filmora.captureStopShortcut(true);
      if (minimise) window.filmora.appMenuInvoke('minimize');
    }, 1000);
  };

  const busy = phase.kind !== 'idle';
  return (
    <Dialog
      title={t('capture.title')}
      icon={MonitorUp}
      onClose={() => {
        if (!busy) onClose();
      }}
      closing={closing}
      testId="capture-dialog"
      widthClass="w-[560px]"
      bodyClassName="space-y-3 p-4"
      footer={
        phase.kind === 'recording' ? (
          <button type="button" data-testid="capture-stop" className="button-primary bg-red-600 hover:bg-red-700" onClick={() => void finish()}>
            <Square size={13} />
            {t('capture.stop')}
          </button>
        ) : (
          <button type="button" data-testid="capture-record" className="button-primary" disabled={busy || !sourceId} onClick={() => void begin()}>
            <Circle size={13} className="fill-current text-red-400" />
            {t('capture.record')}
          </button>
        )
      }
    >
      <span className="field-label">{t('capture.what')}</span>
      {sources === null ? (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={12} className="animate-spin" />
          {t('capture.looking')}
        </p>
      ) : (
        <ul className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto" role="radiogroup" aria-label={t('capture.what')}>
          {sources.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                role="radio"
                aria-checked={sourceId === source.id}
                data-testid={`capture-source-${source.kind}`}
                disabled={busy}
                className={`press w-full rounded-md border p-1 text-left transition-colors ${sourceId === source.id ? 'border-accent bg-accent/15' : 'border-panel-700 bg-panel-900 hover:border-panel-600'}`}
                onClick={() => setSourceId(source.id)}
              >
                <img src={source.thumbnail} alt="" className="aspect-video w-full rounded-[3px] bg-panel-950 object-contain" />
                <span className="mt-1 block truncate text-2xs text-slate-300">{source.kind === 'screen' ? t('capture.screen', { name: source.name }) : source.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-1.5 text-xs text-slate-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" data-testid="capture-mic" checked={withMic} disabled={busy} onChange={(event) => setWithMic(event.target.checked)} />
          {t('capture.mic')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" data-testid="capture-camera" checked={withCamera} disabled={busy} onChange={(event) => setWithCamera(event.target.checked)} />
          {t('capture.camera')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" data-testid="capture-minimise" checked={minimise} disabled={busy} onChange={(event) => setMinimise(event.target.checked)} />
          {t('capture.minimise')}
        </label>
      </div>
      <div className="flex min-h-[44px] items-center justify-center rounded-lg border border-panel-700 bg-panel-950/60 px-3 py-2 text-center" aria-live="polite" data-testid="capture-status">
        {phase.kind === 'counting' ? (
          <span className="text-2xl font-semibold tabular-nums text-slate-100">{phase.left}</span>
        ) : phase.kind === 'recording' ? (
          <span className="flex items-center gap-2 text-sm font-medium text-red-400">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
            {t('capture.recording')} {framesToTimecode(Math.round(elapsed * fps), fps)}
          </span>
        ) : phase.kind === 'saving' ? (
          <span className="flex items-center gap-2 text-xs text-slate-300">
            <Loader2 size={12} className="animate-spin" />
            {t('capture.saving')}
          </span>
        ) : (
          <span className="text-2xs leading-relaxed text-slate-400">{error ?? t('capture.ready')}</span>
        )}
      </div>
    </Dialog>
  );
}
