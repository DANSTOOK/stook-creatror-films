import { Headphones, Volume2, VolumeX } from 'lucide-react';
import type { AudioBus, Clip, Track } from '@shared/types';
import { NEUTRAL_EQ } from '@shared/types';
import { hasSoloedTrack, isTrackAudible } from '@renderer/audio/mixRouting';
import { dbLabel, panLabel, signedDb } from '@renderer/audio/levels';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { timelineRows } from '@renderer/components/Timeline/trackRows';

/**
 * The mixer.
 *
 * The engine has had gain, a three-band EQ, panning, two buses and a sidechain
 * compressor since the beginning; nothing in the interface reached any of it,
 * which meant that in practice none of it existed. This panel is the interface.
 *
 * Everything here writes to the project, so it is saved, undoable, and - the
 * part that matters - applied identically by the offline render in
 * `renderMix.ts`. A fader that only moves the monitor would be worse than no
 * fader at all.
 */

interface FaderProps {
  label: string;
  readout: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
}

function Fader({ label, readout, value, min = 0, max = 2, step = 0.01, onChange }: FaderProps): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label flex items-center justify-between">
        <span>{label}</span>
        <span className="timecode text-slate-300">{readout}</span>
      </span>
      <input
        type="range"
        className="w-full accent-accent"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-menu border border-panel-700 bg-panel-950 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-200">{title}</h3>
        {right}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function TrackStrip({ track, anySolo }: { track: Track; anySolo: boolean }): JSX.Element {
  const t = useT();
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const audible = isTrackAudible(track, anySolo);

  return (
    <div className={`rounded-menu border border-panel-700 p-2 ${audible ? '' : 'opacity-50'}`}>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{track.name}</span>
        <button
          type="button"
          title={track.muted ? t('mixer.unmute') : t('mixer.mute')}
          aria-pressed={track.muted}
          className={`tool-button tool-button-dense ${track.muted ? 'tool-button-active' : ''}`}
          onClick={() => updateTrack(track.id, { muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <button
          type="button"
          title={t('mixer.solo')}
          aria-pressed={track.solo}
          className={`tool-button tool-button-dense w-6 px-0 text-2xs font-semibold ${track.solo ? 'tool-button-active' : ''}`}
          onClick={() => updateTrack(track.id, { solo: !track.solo })}
        >
          S
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Fader
          label={t('mixer.level')}
          readout={dbLabel(track.volume)}
          value={track.volume}
          onChange={(volume) => updateTrack(track.id, { volume })}
        />
        <Fader
          label={t('mixer.pan')}
          readout={panLabel(track.pan)}
          value={track.pan}
          min={-1}
          max={1}
          onChange={(pan) => updateTrack(track.id, { pan })}
        />
      </div>

      <label className="mt-2 flex items-center gap-2 text-2xs text-slate-400">
        <span>{t('mixer.bus')}</span>
        <select
          className="numeric-input h-control-dense flex-1"
          value={track.bus}
          onChange={(event) => updateTrack(track.id, { bus: event.target.value as AudioBus })}
        >
          <option value="music">{t('mixer.busMusic')}</option>
          <option value="dialogue">{t('mixer.busDialogue')}</option>
        </select>
      </label>
    </div>
  );
}

function ClipStrip({ clip }: { clip: Clip }): JSX.Element {
  const t = useT();
  const updateClip = useProjectStore((state) => state.updateClip);
  const eq = clip.eq ?? NEUTRAL_EQ;

  const setEq = (patch: Partial<typeof eq>): void => {
    updateClip(clip.id, { eq: { ...eq, ...patch } }, `eq:${clip.id}`);
  };

  return (
    <Section
      title={t('mixer.clipTitle', { name: clip.name })}
      right={
        <button
          type="button"
          className="text-2xs text-slate-400 hover:text-slate-300"
          onClick={() =>
            updateClip(clip.id, { volume: 1, pan: 0, eq: { ...NEUTRAL_EQ } }, `eq:${clip.id}`)
          }
        >
          {t('mixer.reset')}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <Fader
          label={t('mixer.level')}
          readout={dbLabel(clip.volume)}
          value={clip.volume}
          onChange={(volume) => updateClip(clip.id, { volume }, `volume:${clip.id}`)}
        />
        <Fader
          label={t('mixer.pan')}
          readout={panLabel(clip.pan)}
          value={clip.pan}
          min={-1}
          max={1}
          onChange={(pan) => updateClip(clip.id, { pan }, `pan:${clip.id}`)}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Fader
          label={t('mixer.low')}
          readout={signedDb(eq.low)}
          value={eq.low}
          min={-24}
          max={24}
          step={0.5}
          onChange={(low) => setEq({ low })}
        />
        <Fader
          label={t('mixer.mid')}
          readout={signedDb(eq.mid)}
          value={eq.mid}
          min={-24}
          max={24}
          step={0.5}
          onChange={(mid) => setEq({ mid })}
        />
        <Fader
          label={t('mixer.high')}
          readout={signedDb(eq.high)}
          value={eq.high}
          min={-24}
          max={24}
          step={0.5}
          onChange={(high) => setEq({ high })}
        />
      </div>

      <p className="text-2xs text-slate-400">{t('mixer.eqHint')}</p>
    </Section>
  );
}

export interface MixerProps {
  onClose(): void;
  /** Playing its exit animation; see usePresence. */
  closing?: boolean;
}

export function Mixer({ onClose, closing = false }: MixerProps): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const selectedIds = useProjectStore((state) => state.ui.selectedClipIds);
  const setMasterVolume = useProjectStore((state) => state.setMasterVolume);
  const setDucking = useProjectStore((state) => state.setDucking);

  const anySolo = hasSoloedTrack(project);
  // Same order as the timeline rows.
  const tracks = timelineRows(project.tracks);
  const clip = selectedIds.length === 1 ? project.clips[selectedIds[0]] : undefined;
  const ducking = project.audio.ducking;

  // Ducking with nothing on the dialogue bus cannot do anything, and saying so
  // is better than leaving a switch that appears to work.
  const dialogueTracks = tracks.filter((track) => track.bus === 'dialogue');

  return (
    <Dialog
      title={t('mixer.title')}
      icon={Headphones}
      onClose={onClose}
      closing={closing}
      widthClass="w-[560px]"
      // The first control is the master fader: an arrow key must not move it
      // just because the mixer opened.
      initialFocus="dialog"
      bodyClassName="space-y-3 p-4"
      footer={
        // Everything here applies as it moves, so there is nothing to cancel:
        // one button, and it is the way out.
        <button type="button" className="button-primary" onClick={onClose}>
          {t('dialog.close')}
        </button>
      }
    >
      <Section title={t('mixer.master')}>
        <Fader
          label={t('mixer.masterLevel')}
          readout={dbLabel(project.audio.masterVolume)}
          value={project.audio.masterVolume}
          onChange={setMasterVolume}
        />
        {anySolo && (
          <p className="rounded-control bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">{t('mixer.soloWarning')}</p>
        )}
      </Section>

      <Section title={t('mixer.tracks')}>
        <div className="flex flex-col gap-2">
          {tracks.map((track) => (
            <TrackStrip key={track.id} track={track} anySolo={anySolo} />
          ))}
        </div>
      </Section>

      {clip ? (
        <ClipStrip clip={clip} />
      ) : (
        <Section title={t('mixer.clip')}>
          <p className="text-2xs text-slate-400">
            {selectedIds.length > 1
              ? t('mixer.manySelected', { count: selectedIds.length })
              : t('mixer.noneSelected')}
          </p>
        </Section>
      )}

      <Section title={t('mixer.ducking')}>
        <label className="flex items-center gap-2 text-xs text-slate-200">
          <input
            type="checkbox"
            className="accent-accent"
            checked={ducking.enabled}
            onChange={(event) => setDucking({ enabled: event.target.checked })}
          />
          {t('mixer.duckSwitch')}
        </label>

        {ducking.enabled && dialogueTracks.length === 0 && (
          <p role="alert" className="rounded-control bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
            {t('mixer.duckNothing')}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Fader
            label={t('mixer.threshold')}
            readout={`${ducking.thresholdDb.toFixed(0)} dB`}
            value={ducking.thresholdDb}
            min={-60}
            max={0}
            step={1}
            onChange={(thresholdDb) => setDucking({ thresholdDb })}
          />
          <Fader
            label={t('mixer.range')}
            readout={`-${ducking.rangeDb.toFixed(0)} dB`}
            value={ducking.rangeDb}
            min={0}
            max={40}
            step={1}
            onChange={(rangeDb) => setDucking({ rangeDb })}
          />
          <Fader
            label={t('mixer.attack')}
            readout={`${Math.round(ducking.attackSeconds * 1000)} ms`}
            value={ducking.attackSeconds}
            min={0.005}
            max={0.5}
            step={0.005}
            onChange={(attackSeconds) => setDucking({ attackSeconds })}
          />
          <Fader
            label={t('mixer.release')}
            readout={`${Math.round(ducking.releaseSeconds * 1000)} ms`}
            value={ducking.releaseSeconds}
            min={0.05}
            max={2}
            step={0.05}
            onChange={(releaseSeconds) => setDucking({ releaseSeconds })}
          />
        </div>

        <p className="text-2xs text-slate-400">{t('mixer.duckHint')}</p>
      </Section>
    </Dialog>
  );
}

export default Mixer;
