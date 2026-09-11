import { Headphones, Volume2, VolumeX, X } from 'lucide-react';
import type { AudioBus, Clip, Track } from '@shared/types';
import { NEUTRAL_EQ } from '@shared/types';
import { hasSoloedTrack, isTrackAudible } from '@renderer/audio/mixRouting';
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

const dbLabel = (linear: number): string => {
  if (linear <= 0.0001) return '-inf dB';
  const db = 20 * Math.log10(linear);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
};

const panLabel = (pan: number): string => {
  if (Math.abs(pan) < 0.005) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
};

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
        <span className="normal-case tracking-normal text-slate-400">{readout}</span>
      </span>
      <input
        type="range"
        className="w-full accent-blue-500"
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
    <section className="rounded border border-panel-700 bg-panel-950 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-2xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
        {right}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function TrackStrip({ track, anySolo }: { track: Track; anySolo: boolean }): JSX.Element {
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const audible = isTrackAudible(track, anySolo);

  return (
    <div className={`rounded border border-panel-700 p-2 ${audible ? '' : 'opacity-50'}`}>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{track.name}</span>
        <button
          type="button"
          title={track.muted ? 'Unmute' : 'Mute'}
          aria-pressed={track.muted}
          className={`tool-button h-6 px-1.5 ${track.muted ? 'tool-button-active' : ''}`}
          onClick={() => updateTrack(track.id, { muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <button
          type="button"
          title="Solo"
          aria-pressed={track.solo}
          className={`tool-button h-6 px-1.5 text-2xs ${track.solo ? 'tool-button-active' : ''}`}
          onClick={() => updateTrack(track.id, { solo: !track.solo })}
        >
          S
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Fader
          label="Level"
          readout={dbLabel(track.volume)}
          value={track.volume}
          onChange={(volume) => updateTrack(track.id, { volume })}
        />
        <Fader
          label="Pan"
          readout={panLabel(track.pan)}
          value={track.pan}
          min={-1}
          max={1}
          onChange={(pan) => updateTrack(track.id, { pan })}
        />
      </div>

      <label className="mt-2 flex items-center gap-2 text-2xs text-slate-500">
        <span className="uppercase tracking-wide">Bus</span>
        <select
          className="numeric-input h-6 flex-1"
          value={track.bus}
          onChange={(event) => updateTrack(track.id, { bus: event.target.value as AudioBus })}
        >
          <option value="music">Music (ducked)</option>
          <option value="dialogue">Dialogue (sidechain)</option>
        </select>
      </label>
    </div>
  );
}

function ClipStrip({ clip }: { clip: Clip }): JSX.Element {
  const updateClip = useProjectStore((state) => state.updateClip);
  const eq = clip.eq ?? NEUTRAL_EQ;

  const setEq = (patch: Partial<typeof eq>): void => {
    updateClip(clip.id, { eq: { ...eq, ...patch } }, `eq:${clip.id}`);
  };

  return (
    <Section
      title={`Clip - ${clip.name}`}
      right={
        <button
          type="button"
          className="text-2xs text-slate-500 hover:text-slate-300"
          onClick={() =>
            updateClip(clip.id, { volume: 1, pan: 0, eq: { ...NEUTRAL_EQ } }, `eq:${clip.id}`)
          }
        >
          Reset
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <Fader
          label="Level"
          readout={dbLabel(clip.volume)}
          value={clip.volume}
          onChange={(volume) => updateClip(clip.id, { volume }, `volume:${clip.id}`)}
        />
        <Fader
          label="Pan"
          readout={panLabel(clip.pan)}
          value={clip.pan}
          min={-1}
          max={1}
          onChange={(pan) => updateClip(clip.id, { pan }, `pan:${clip.id}`)}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Fader
          label="Low"
          readout={`${eq.low >= 0 ? '+' : ''}${eq.low.toFixed(1)}`}
          value={eq.low}
          min={-24}
          max={24}
          step={0.5}
          onChange={(low) => setEq({ low })}
        />
        <Fader
          label="Mid"
          readout={`${eq.mid >= 0 ? '+' : ''}${eq.mid.toFixed(1)}`}
          value={eq.mid}
          min={-24}
          max={24}
          step={0.5}
          onChange={(mid) => setEq({ mid })}
        />
        <Fader
          label="High"
          readout={`${eq.high >= 0 ? '+' : ''}${eq.high.toFixed(1)}`}
          value={eq.high}
          min={-24}
          max={24}
          step={0.5}
          onChange={(high) => setEq({ high })}
        />
      </div>

      <p className="text-2xs text-slate-600">
        Low shelf at 120 Hz, peak at 1 kHz, high shelf at 8 kHz - the same three
        filters the export renders through.
      </p>
    </Section>
  );
}

export interface MixerProps {
  onClose(): void;
}

export function Mixer({ onClose }: MixerProps): JSX.Element {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="panel w-[560px] max-h-[86vh]">
        <header className="panel-header justify-between">
          <span className="flex items-center gap-2">
            <Headphones size={13} />
            Mixer
          </span>
          <button type="button" className="tool-button" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <Section title="Master">
            <Fader
              label="Master level"
              readout={dbLabel(project.audio.masterVolume)}
              value={project.audio.masterVolume}
              onChange={setMasterVolume}
            />
            {anySolo && (
              <p className="rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                A track is soloed, so everything else is silent - in the render
                too, not only here.
              </p>
            )}
          </Section>

          <Section title="Tracks">
            <div className="flex flex-col gap-2">
              {tracks.map((track) => (
                <TrackStrip key={track.id} track={track} anySolo={anySolo} />
              ))}
            </div>
          </Section>

          {clip ? (
            <ClipStrip clip={clip} />
          ) : (
            <Section title="Clip">
              <p className="text-2xs text-slate-500">
                {selectedIds.length > 1
                  ? `${selectedIds.length} clips selected. Select one to edit its level, pan and EQ.`
                  : 'Select a clip on the timeline to edit its level, pan and EQ.'}
              </p>
            </Section>
          )}

          <Section title="Auto ducking">
            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={ducking.enabled}
                onChange={(event) => setDucking({ enabled: event.target.checked })}
              />
              Duck the music bus under dialogue
            </label>

            {ducking.enabled && dialogueTracks.length === 0 && (
              <p className="rounded bg-amber-950/50 px-2 py-1.5 text-2xs text-amber-300">
                No track is assigned to the dialogue bus, so there is nothing to
                duck against and this does nothing. Set a track's bus to
                Dialogue above.
              </p>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Fader
                label="Threshold"
                readout={`${ducking.thresholdDb.toFixed(0)} dB`}
                value={ducking.thresholdDb}
                min={-60}
                max={0}
                step={1}
                onChange={(thresholdDb) => setDucking({ thresholdDb })}
              />
              <Fader
                label="Range"
                readout={`-${ducking.rangeDb.toFixed(0)} dB`}
                value={ducking.rangeDb}
                min={0}
                max={40}
                step={1}
                onChange={(rangeDb) => setDucking({ rangeDb })}
              />
              <Fader
                label="Attack"
                readout={`${Math.round(ducking.attackSeconds * 1000)} ms`}
                value={ducking.attackSeconds}
                min={0.005}
                max={0.5}
                step={0.005}
                onChange={(attackSeconds) => setDucking({ attackSeconds })}
              />
              <Fader
                label="Release"
                readout={`${Math.round(ducking.releaseSeconds * 1000)} ms`}
                value={ducking.releaseSeconds}
                min={0.05}
                max={2}
                step={0.05}
                onChange={(releaseSeconds) => setDucking({ releaseSeconds })}
              />
            </div>

            <p className="text-2xs text-slate-600">
              Playback follows the dialogue bus live; the export bakes the same
              curve offline, so the rendered file ducks in the same places.
            </p>
          </Section>
        </div>

        <footer className="flex justify-end gap-2 border-t border-panel-700 px-4 py-3">
          <button type="button" className="tool-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

export default Mixer;
