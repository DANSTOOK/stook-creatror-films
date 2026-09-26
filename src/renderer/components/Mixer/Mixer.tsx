import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Headphones, Volume2, VolumeX, X } from 'lucide-react';
import type { AudioBus, Track } from '@shared/types';
import { hasSoloedTrack, isTrackAudible } from '@renderer/audio/mixRouting';
import { dbLabel, panLabel } from '@renderer/audio/levels';
import { getAudioEngine, type MeterReading } from '@renderer/audio/AudioEngine';
import { SCALE_MARKS_DB, dbToPosition, gainToDb, gainToPosition, positionToGain } from '@renderer/audio/faderLaw';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { TRACK_TYPE_COLORS } from '@renderer/components/Timeline/TimelineCanvas';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { timelineRows } from '@renderer/components/Timeline/trackRows';

/**
 * The mixer, docked beside the timeline.
 *
 * It was a dialog: modal, over the picture, gone the moment you wanted to
 * watch what you were mixing. Resolve docks its mixer to the right of the
 * Edit page's timeline and Final Cut its meters there too, so that is where
 * this is: a channel strip per track, in timeline order, and the master on
 * the right - a vertical fader in dB on a console law (faderLaw.ts), pan,
 * mute and solo, and a stereo meter showing peak, with RMS as the solid body.
 *
 * Everything here writes to the project, so it is saved, undoable and - the
 * part that matters - applied identically by the offline render in
 * renderMix.ts. A clip's own level, pan and EQ are in the inspector's Audio
 * tab. Auto ducking, and which tracks are dialogue and which music (the two
 * buses it works with), are behind the Ducking button.
 *
 * The meters read the audio engine's analysers in one animation-frame loop,
 * writing straight to the bars (no React render), and only while playing:
 * stopped, the loop is not running and the bars are empty.
 */

/** A fader's travel, in keyboard steps. */
const FADER_STEPS = 200;

/** Peak hold: how long the line stays before it falls. */
const HOLD_MS = 1200;

interface MeterRefs {
  bars: HTMLElement[];
  bands: HTMLElement[];
  holds: HTMLElement[];
}

/** A stereo meter: two bars on the fader's scale, green to red, and a peak line each. */
function Meter({ register }: { register(refs: MeterRefs | null): void }): JSX.Element {
  const bars = useRef<HTMLElement[]>([]);
  const bands = useRef<HTMLElement[]>([]);
  const holds = useRef<HTMLElement[]>([]);
  useEffect(() => {
    register({ bars: bars.current, bands: bands.current, holds: holds.current });
    return () => register(null);
  }, [register]);
  return (
    <div aria-hidden className="flex h-full gap-px">
      {[0, 1].map((channel) => (
        <div key={channel} className="scf-meter relative h-full w-1.5 overflow-hidden rounded-[1px]">
          <span
            ref={(element) => {
              if (element) bars.current[channel] = element;
            }}
            className="scf-meter-cover absolute inset-x-0 top-0 h-full origin-top"
          />
          <span
            ref={(element) => {
              if (element) bands.current[channel] = element;
            }}
            className="scf-meter-band absolute inset-x-0 bottom-0 h-full origin-bottom"
          />
          <span
            ref={(element) => {
              if (element) holds.current[channel] = element;
            }}
            className="absolute inset-x-0 bottom-0 h-px bg-white/90 opacity-0"
          />
        </div>
      ))}
    </div>
  );
}

/** The dB marks beside a fader. */
function Scale(): JSX.Element {
  return (
    <div aria-hidden className="relative h-full w-5 text-2xs leading-none text-slate-400">
      {SCALE_MARKS_DB.map((db) => (
        <span
          key={db}
          className="absolute right-0 -translate-y-1/2 tabular-nums"
          style={{ top: `${(1 - dbToPosition(db)) * 100}%` }}
        >
          {db > 0 ? `+${db}` : db}
        </span>
      ))}
    </div>
  );
}

/** A vertical fader: the native range, turned upright, on the fader law. */
function Fader({
  label,
  gain,
  onChange,
  testId,
}: {
  label: string;
  gain: number;
  onChange(gain: number): void;
  testId?: string;
}): JSX.Element {
  const t = useT();
  const position = gainToPosition(gain);
  return (
    <input
      type="range"
      className="scf-fader"
      data-testid={testId}
      aria-label={label}
      aria-valuetext={dbLabel(gain)}
      // 200 steps of travel: an arrow key is a quarter of a dB near unity
      // and about half a dB lower down, as a console fader's detents.
      min={0}
      max={FADER_STEPS}
      step={1}
      value={Math.round(position * FADER_STEPS)}
      style={{ '--fill': `${position * 100}%` } as CSSProperties}
      onChange={(event) => onChange(positionToGain(Number(event.target.value) / FADER_STEPS))}
      // Unity is where a mix starts from; a double-click goes back there.
      onDoubleClick={() => onChange(1)}
      {...tip(label, { hint: t('mixer.resetFader'), named: false })}
    />
  );
}

function Strip({
  name,
  colour,
  children,
  master = false,
}: {
  name: string;
  colour?: string;
  children: React.ReactNode;
  master?: boolean;
}): JSX.Element {
  return (
    <div
      className={`flex h-full w-[70px] shrink-0 flex-col items-center gap-1.5 rounded-control px-1.5 py-1.5 ${
        master ? 'bg-panel-800' : 'bg-panel-950/60'
      }`}
    >
      <span className="flex w-full min-w-0 items-center gap-1">
        {colour && <span aria-hidden className="h-2.5 w-1 shrink-0 rounded-full" style={{ background: colour }} />}
        <span className={`min-w-0 flex-1 truncate text-2xs ${master ? 'font-semibold text-slate-100' : 'text-slate-300'}`} title={name}>
          {name}
        </span>
      </span>
      {children}
    </div>
  );
}

function TrackStrip({
  track,
  anySolo,
  ducked,
  registerMeter,
}: {
  track: Track;
  anySolo: boolean;
  ducked: boolean;
  registerMeter(refs: MeterRefs | null): void;
}): JSX.Element {
  const t = useT();
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const audible = isTrackAudible(track, anySolo);

  return (
    <Strip name={track.name} colour={TRACK_TYPE_COLORS[track.type]}>
      <input
        type="range"
        className="h-3 w-full"
        aria-label={t('mixer.trackPan', { name: track.name })}
        aria-valuetext={panLabel(track.pan)}
        min={-1}
        max={1}
        step={0.01}
        value={track.pan}
        onChange={(event) => updateTrack(track.id, { pan: Number(event.target.value) })}
        onDoubleClick={() => updateTrack(track.id, { pan: 0 })}
        {...tip(`${t('mixer.pan')} ${panLabel(track.pan)}`, { named: false })}
      />
      <div className={`flex min-h-0 w-full flex-1 items-stretch justify-center gap-1 ${audible ? '' : 'opacity-50'}`}>
        <Scale />
        <Fader label={t('mixer.trackLevel', { name: track.name })} gain={track.volume} onChange={(volume) => updateTrack(track.id, { volume })} />
        <Meter register={registerMeter} />
      </div>
      <span className="text-2xs tabular-nums text-slate-300" title={ducked ? t('mixer.ducked') : undefined}>
        {dbLabel(track.volume).replace(' dB', '')}
        {ducked && <span className="ml-0.5 text-sky-300">↓</span>}
      </span>
      <span className="flex gap-1">
        <button
          type="button"
          title={track.muted ? t('mixer.unmute') : t('mixer.mute')}
          aria-label={`${track.muted ? t('mixer.unmute') : t('mixer.mute')} ${track.name}`}
          aria-pressed={track.muted}
          className={`tool-button tool-button-dense w-6 px-0 ${track.muted ? 'bg-amber-400/15 text-amber-300' : ''}`}
          onClick={() => updateTrack(track.id, { muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
        <button
          type="button"
          title={t('mixer.solo')}
          aria-label={`${t('mixer.solo')} ${track.name}`}
          aria-pressed={track.solo}
          className={`tool-button tool-button-dense w-6 px-0 text-2xs font-semibold ${track.solo ? 'bg-yellow-300/20 text-yellow-200' : ''}`}
          onClick={() => updateTrack(track.id, { solo: !track.solo })}
        >
          S
        </button>
      </span>
    </Strip>
  );
}

/** Auto ducking and each track's role, in a popover under the Ducking button. */
function DuckingPopover({ tracks, onClose, anchor }: { tracks: Track[]; onClose(): void; anchor: DOMRect | null }): JSX.Element {
  const t = useT();
  const ducking = useProjectStore((state) => state.project.audio.ducking);
  const setDucking = useProjectStore((state) => state.setDucking);
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogueTracks = tracks.filter((track) => track.bus === 'dialogue');

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Element;
      if (!rootRef.current?.contains(target) && !target.closest?.('[data-ducking-button]')) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Fixed to the window, above the button (the mixer sits at the bottom).
  const width = 300;
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || !anchor) return;
    element.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, anchor.top - element.offsetHeight - 6)}px`;
    element.style.transformOrigin = 'bottom right';
  }, [anchor]);

  const slider = (
    label: string,
    readout: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
  ): JSX.Element => (
    <label className="flex flex-col gap-0.5">
      <span className="field-label flex items-center justify-between">
        <span>{label}</span>
        <span className="timecode text-slate-300">{readout}</span>
      </span>
      <input
        type="range"
        className="w-full"
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('mixer.ducking')}
      data-testid="ducking-popover"
      data-state="open"
      style={{ width }}
      className="scf-menu fixed z-[95] max-h-[70vh] space-y-2.5 overflow-y-auto rounded-menu border border-panel-600 bg-panel-800 p-3 shadow-2xl shadow-black/60"
    >
      <p className="text-xs font-semibold text-slate-100">{t('mixer.ducking')}</p>
      <label className="flex items-center gap-2 text-xs text-slate-200">
        <input type="checkbox" role="switch" checked={ducking.enabled} onChange={(event) => setDucking({ enabled: event.target.checked })} />
        {t('mixer.duckSwitch')}
      </label>
      {ducking.enabled && dialogueTracks.length === 0 && (
        <p role="alert" className="rounded-control bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
          {t('mixer.duckNothing')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {slider(t('mixer.threshold'), `${ducking.thresholdDb.toFixed(0)} dB`, ducking.thresholdDb, -60, 0, 1, (thresholdDb) => setDucking({ thresholdDb }))}
        {slider(t('mixer.range'), `-${ducking.rangeDb.toFixed(0)} dB`, ducking.rangeDb, 0, 40, 1, (rangeDb) => setDucking({ rangeDb }))}
        {slider(t('mixer.attack'), `${Math.round(ducking.attackSeconds * 1000)} ms`, ducking.attackSeconds, 0.005, 0.5, 0.005, (attackSeconds) => setDucking({ attackSeconds }))}
        {slider(t('mixer.release'), `${Math.round(ducking.releaseSeconds * 1000)} ms`, ducking.releaseSeconds, 0.05, 2, 0.05, (releaseSeconds) => setDucking({ releaseSeconds }))}
      </div>
      <div className="space-y-1 border-t border-panel-700 pt-2">
        <p className="text-2xs font-semibold text-slate-200">{t('mixer.roles')}</p>
        {tracks.map((track) => (
          <label key={track.id} className="flex items-center gap-2 text-2xs text-slate-300">
            <span className="min-w-0 flex-1 truncate">{track.name}</span>
            <select
              aria-label={t('mixer.roleOf', { name: track.name })}
              className="numeric-input h-control-dense w-28"
              value={track.bus}
              onChange={(event) => updateTrack(track.id, { bus: event.target.value as AudioBus })}
            >
              <option value="dialogue">{t('mixer.roleDialogue')}</option>
              <option value="music">{t('mixer.roleMusic')}</option>
            </select>
          </label>
        ))}
        <p className="text-2xs leading-relaxed text-slate-400">{t('mixer.rolesHint')}</p>
      </div>
      <p className="text-2xs leading-relaxed text-slate-400">{t('mixer.duckHint')}</p>
    </div>
  );
}

export interface MixerProps {
  onClose(): void;
}

export function Mixer({ onClose }: MixerProps): JSX.Element {
  const t = useT();
  const tracksRaw = useProjectStore((state) => state.project.tracks);
  const masterVolume = useProjectStore((state) => state.project.audio.masterVolume);
  const duckingOn = useProjectStore((state) => state.project.audio.ducking.enabled);
  const isPlaying = useProjectStore((state) => state.ui.isPlaying);
  const setMasterVolume = useProjectStore((state) => state.setMasterVolume);
  const project = useProjectStore((state) => state.project);
  const [duckingOpen, setDuckingOpen] = useState(false);
  const duckingButton = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const anySolo = hasSoloedTrack(project);
  // Same order as the timeline rows.
  const tracks = timelineRows(tracksRaw);

  /*
    The meters. Each strip registers its bars here; while playing, one loop
    reads the engine and writes transforms. Nothing re-renders.
  */
  const meters = useRef(new Map<string, MeterRefs>());
  const registerFor = useRef(new Map<string, (refs: MeterRefs | null) => void>());
  const register = (id: string): ((refs: MeterRefs | null) => void) => {
    let callback = registerFor.current.get(id);
    if (!callback) {
      callback = (refs) => {
        if (refs) meters.current.set(id, refs);
        else meters.current.delete(id);
      };
      registerFor.current.set(id, callback);
    }
    return callback;
  };

  useEffect(() => {
    const holds = new Map<string, { level: number[]; at: number[] }>();
    const draw = (id: string, reading: MeterReading | undefined, now: number): void => {
      const refs = meters.current.get(id);
      if (!refs) return;
      const hold = holds.get(id) ?? { level: [0, 0], at: [0, 0] };
      holds.set(id, hold);
      for (let channel = 0; channel < 2; channel += 1) {
        const peak = reading?.peak[channel] ?? 0;
        const rms = reading?.rms[channel] ?? 0;
        // The bar reaches the peak; the stretch between the RMS level and
        // the peak is dimmed, so the solid body is the loudness and the tip
        // the transients - how Resolve's and Pro Tools' meters read.
        const peakPosition = dbToPosition(gainToDb(peak));
        const rmsPosition = Math.min(peakPosition, dbToPosition(gainToDb(rms)));
        const cover = refs.bars[channel];
        if (cover) cover.style.transform = `scaleY(${1 - peakPosition})`;
        const band = refs.bands[channel];
        if (band) band.style.transform = `translateY(${-rmsPosition * 100}%) scaleY(${peakPosition - rmsPosition})`;
        if (peakPosition >= hold.level[channel] || now - hold.at[channel] > HOLD_MS) {
          hold.level[channel] = peakPosition;
          hold.at[channel] = now;
        }
        const line = refs.holds[channel];
        if (line) {
          line.style.transform = `translateY(${-hold.level[channel] * (line.parentElement?.clientHeight ?? 0)}px)`;
          line.style.opacity = hold.level[channel] > 0.02 ? '1' : '0';
          line.style.background = hold.level[channel] >= dbToPosition(0) ? '#f87171' : '';
        }
      }
    };
    const clear = (): void => {
      for (const id of meters.current.keys()) draw(id, undefined, performance.now() + HOLD_MS * 2);
    };

    if (!isPlaying) {
      clear();
      return undefined;
    }
    let frame = requestAnimationFrame(function tick(now) {
      const engine = getAudioEngine();
      if (engine) {
        const levels = engine.meterLevels();
        draw('master', levels.master, now);
        for (const id of meters.current.keys()) if (id !== 'master') draw(id, levels.tracks.get(id), now);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      clear();
    };
  }, [isPlaying]);

  return (
    <section data-testid="mixer-panel" aria-label={t('mixer.title')} className="panel h-full">
      <header className="panel-header gap-1.5">
        <Headphones size={14} className="shrink-0 text-slate-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('mixer.title')}</span>
        {anySolo && (
          <span className="rounded bg-yellow-300/15 px-1.5 text-2xs font-normal text-yellow-200" {...tip(t('mixer.soloWarning'), { named: false })}>
            {t('mixer.soloChip')}
          </span>
        )}
        <button
          ref={duckingButton}
          type="button"
          data-ducking-button
          data-testid="ducking-button"
          aria-haspopup="dialog"
          aria-expanded={duckingOpen}
          className={`tool-button tool-button-dense px-1.5 font-normal ${duckingOpen ? 'tool-button-active' : ''} ${duckingOn ? 'text-sky-300' : ''}`}
          onClick={() => {
            setAnchor(duckingButton.current?.getBoundingClientRect() ?? null);
            setDuckingOpen((open) => !open);
          }}
          {...tip(duckingOn ? t('mixer.duckingOn') : t('mixer.ducking'), { hint: t('mixer.duckingHint'), named: false })}
        >
          {t('mixer.duckingButton')}
        </button>
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0 font-normal"
          aria-label={t('mixer.hide')}
          onClick={onClose}
          {...tip(t('mixer.hide'), { named: false })}
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden p-1.5">
        {tracks.map((track) => (
          <TrackStrip
            key={track.id}
            track={track}
            anySolo={anySolo}
            ducked={duckingOn && track.bus === 'music'}
            registerMeter={register(track.id)}
          />
        ))}
        <span aria-hidden className="w-px shrink-0 bg-panel-700" />
        <Strip name={t('mixer.master')} master>
          <span className="h-3" aria-hidden />
          <label className="flex min-h-0 w-full flex-1 items-stretch justify-center gap-1">
            <span className="sr-only">{t('mixer.masterLevel')}</span>
            <Scale />
            <Fader label={t('mixer.masterLevel')} testId="master-fader" gain={masterVolume} onChange={setMasterVolume} />
            <Meter register={register('master')} />
          </label>
          <span className="text-2xs tabular-nums text-slate-300">{dbLabel(masterVolume).replace(' dB', '')}</span>
          <span className="h-6" aria-hidden />
        </Strip>
      </div>

      {duckingOpen && <DuckingPopover tracks={tracks} anchor={anchor} onClose={() => setDuckingOpen(false)} />}
    </section>
  );
}

export default Mixer;
