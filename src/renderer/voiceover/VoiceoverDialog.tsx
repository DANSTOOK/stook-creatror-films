import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Circle, Mic, Square } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { getAudioEngine } from '@renderer/audio/AudioEngine';
import { buildAsset } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { framesToTimecode } from '@shared/utils/timecode';

/**
 * Voice-over: a narration recorded straight onto the timeline. The
 * microphone is chosen and its level shown; Record counts three, then the
 * edit plays from the playhead (its own sound off, so it does not end up in
 * the microphone - unless asked for) while the voice is recorded; Stop puts
 * the recording on a track of its own called Voice-over, on the dialogue
 * bus, where the playhead was - in sync with the picture it was spoken to.
 */

export const useVoiceoverDialog = create<{ open: boolean; show(): void; close(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

type Phase = { kind: 'idle' } | { kind: 'counting'; left: number } | { kind: 'recording'; since: number; startFrame: number } | { kind: 'saving' };

const COUNT_FROM = 3;

export function VoiceoverDialog({ closing, onClose }: { closing: boolean; onClose(): void }): JSX.Element {
  const t = useT();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [level, setLevel] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [playAlong, setPlayAlong] = useState(true);
  const [hearEdit, setHearEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const masterRef = useRef<number | null>(null);
  const fps = useProjectStore((state) => state.project.fps);

  // The microphone: opened for the meter as soon as the dialog is, and on each change of device.
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let context: AudioContext | null = null;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        setError(null);
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all.filter((device) => device.kind === 'audioinput'));
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const tick = (): void => {
          analyser.getFloatTimeDomainData(data);
          let peak = 0;
          for (const value of data) peak = Math.max(peak, Math.abs(value));
          setLevel(peak);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (problem) {
        if (!cancelled) setError(t('voiceover.noMic', { detail: problem instanceof Error ? problem.message : String(problem) }));
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void context?.close();
    };
  }, [deviceId, t]);

  // The microphone is let go when the dialog closes.
  useEffect(
    () => () => {
      recorderRef.current?.state === 'recording' && recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      restoreSound();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The clock while recording.
  useEffect(() => {
    if (phase.kind !== 'recording') return undefined;
    const timer = window.setInterval(() => setElapsed((performance.now() - phase.since) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [phase]);

  const muteSound = (): void => {
    const engine = getAudioEngine();
    if (!engine || hearEdit) return;
    masterRef.current = engine.master.gain.value;
    engine.master.gain.value = 0;
  };
  const restoreSound = (): void => {
    const engine = getAudioEngine();
    if (engine && masterRef.current !== null) engine.master.gain.value = masterRef.current;
    masterRef.current = null;
  };

  const begin = (): void => {
    if (!streamRef.current) return;
    setPhase({ kind: 'counting', left: COUNT_FROM });
    let left = COUNT_FROM;
    const timer = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        setPhase({ kind: 'counting', left });
        return;
      }
      window.clearInterval(timer);
      const stream = streamRef.current;
      if (!stream) return;
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorderRef.current = recorder;
      const startFrame = useProjectStore.getState().project.currentFrame;
      recorder.start(250);
      setElapsed(0);
      setPhase({ kind: 'recording', since: performance.now(), startFrame });
      if (playAlong) {
        muteSound();
        useProjectStore.getState().setPlaying(true);
      }
    }, 1000);
  };

  const finish = async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder || phase.kind !== 'recording') return;
    const startFrame = phase.startFrame;
    setPhase({ kind: 'saving' });
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    useProjectStore.getState().setPlaying(false);
    restoreSound();
    try {
      const webm = await new Blob(chunksRef.current, { type: recorder.mimeType }).arrayBuffer();
      const count = useProjectStore.getState().assets.filter((asset) => asset.name.startsWith(t('voiceover.trackName'))).length + 1;
      const name = `${t('voiceover.trackName')} ${count}`;
      const path = await window.filmora.saveRecording(name, webm);
      const asset = await buildAsset({ name: `${name}.m4a`, uri: await window.filmora.mediaUrl(path), sourcePath: path, hasAudio: true }, fps);
      const store = useProjectStore.getState();
      store.addAssets([asset]);
      const added = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === path) ?? asset;
      // Where the playhead was when the recording began: in sync with what was spoken to.
      useProjectStore.getState().setCurrentFrame(startFrame);
      const clipId = useProjectStore.getState().addAssetOnNewTrack(added);
      const trackId = clipId ? useProjectStore.getState().project.clips[clipId]?.trackId : undefined;
      if (trackId) useProjectStore.getState().updateTrack(trackId, { name: t('voiceover.trackName'), bus: 'dialogue' });
      notify(t('voiceover.done', { seconds: Math.round(asset.durationSeconds ?? 0) }), 'success');
      setPhase({ kind: 'idle' });
      onClose();
    } catch (problem) {
      setPhase({ kind: 'idle' });
      setError(t('voiceover.failed', { detail: problem instanceof Error ? problem.message : String(problem) }));
    }
  };

  const busy = phase.kind !== 'idle';
  const meter = Math.min(1, level * 1.4);
  return (
    <Dialog
      title={t('voiceover.title')}
      icon={Mic}
      onClose={() => {
        if (!busy) onClose();
      }}
      closing={closing}
      testId="voiceover-dialog"
      widthClass="w-[420px]"
      bodyClassName="space-y-3 p-4"
      footer={
        phase.kind === 'recording' ? (
          <button type="button" data-testid="voiceover-stop" className="button-primary bg-red-600 hover:bg-red-700" onClick={() => void finish()}>
            <Square size={13} />
            {t('voiceover.stop')}
          </button>
        ) : (
          <button type="button" data-testid="voiceover-record" className="button-primary" disabled={busy || !!error || !streamRef.current} onClick={begin}>
            <Circle size={13} className="fill-current text-red-400" />
            {t('voiceover.record')}
          </button>
        )
      }
    >
      <label className="flex flex-col gap-1">
        <span className="field-label">{t('voiceover.mic')}</span>
        <select className="numeric-input" data-testid="voiceover-device" value={deviceId} disabled={busy} onChange={(event) => setDeviceId(event.target.value)}>
          <option value="">{t('voiceover.defaultMic')}</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || device.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1">
        <span className="field-label">{t('voiceover.level')}</span>
        <div className="h-2 overflow-hidden rounded-full bg-panel-950" data-testid="voiceover-meter" data-level={level.toFixed(3)}>
          <div className={`h-full rounded-full ${meter > 0.9 ? 'bg-red-500' : meter > 0.6 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${meter * 100}%` }} />
        </div>
        <p className="text-2xs text-slate-400">{t('voiceover.levelHint')}</p>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" data-testid="voiceover-play-along" checked={playAlong} disabled={busy} onChange={(event) => setPlayAlong(event.target.checked)} />
        {t('voiceover.playAlong')}
      </label>
      {playAlong && (
        <label className="flex items-center gap-2 pl-5 text-xs text-slate-400">
          <input type="checkbox" checked={hearEdit} disabled={busy} onChange={(event) => setHearEdit(event.target.checked)} />
          {t('voiceover.hearEdit')}
        </label>
      )}
      <div className="flex min-h-[44px] items-center justify-center rounded-lg border border-panel-700 bg-panel-950/60 py-2 text-center" aria-live="polite" data-testid="voiceover-status">
        {phase.kind === 'counting' ? (
          <span className="text-2xl font-semibold tabular-nums text-slate-100">{phase.left}</span>
        ) : phase.kind === 'recording' ? (
          <span className="flex items-center gap-2 text-sm font-medium text-red-400">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden />
            {t('voiceover.recording')} {framesToTimecode(Math.round(elapsed * fps), fps)}
          </span>
        ) : phase.kind === 'saving' ? (
          <span className="text-xs text-slate-300">{t('voiceover.saving')}</span>
        ) : (
          <span className="text-2xs text-slate-400">{error ?? t('voiceover.ready')}</span>
        )}
      </div>
    </Dialog>
  );
}
