import { useState } from 'react';
import { X } from 'lucide-react';
import { COMMON_FPS } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * Project settings.
 *
 * Until now the frame rate and the resolution were adopted from the first clip
 * imported and then frozen: a project started from 30 fps footage could never
 * be finished at 60, and nothing could be resized. This is the panel.
 *
 * The frame rate control is the one with a real decision behind it. Frame
 * numbers mean nothing without the rate that reads them, so changing the rate
 * either re-times the whole edit or leaves every cut where it is - and those
 * are different things. "Keep timing" is on by default, because an editor
 * expects a cut authored at 4 seconds to stay at 4 seconds.
 */

const PRESETS: { label: string; width: number; height: number }[] = [
  { label: '3840 x 2160 (4K UHD)', width: 3840, height: 2160 },
  { label: '1920 x 1080 (1080p)', width: 1920, height: 1080 },
  { label: '1280 x 720 (720p)', width: 1280, height: 720 },
  { label: '1080 x 1920 (vertical)', width: 1080, height: 1920 },
  { label: '1080 x 1080 (square)', width: 1080, height: 1080 },
];

export interface ProjectSettingsProps {
  onClose(): void;
  /** Playing its exit animation; see usePresence. */
  closing?: boolean;
}

export function ProjectSettings({ onClose, closing = false }: ProjectSettingsProps): JSX.Element {
  const project = useProjectStore((state) => state.project);
  const setProjectSettings = useProjectStore((state) => state.setProjectSettings);
  const adoptedFrom = useProjectStore((state) => state.adoptedSettingsFrom);

  const [retime, setRetime] = useState(true);

  const durationSeconds = project.durationFrames / project.fps;
  const clipCount = Object.keys(project.clips).length;
  const presetMatch = PRESETS.find(
    (preset) => preset.width === project.width && preset.height === project.height,
  );

  return (
    <div data-closing={closing} className="scf-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-closing={closing} className="scf-dialog panel w-[460px] max-h-[86vh] shadow-2xl shadow-black/60">
        <header className="panel-header justify-between">
          <span>Project settings</span>
          <button type="button" className="tool-button" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <label className="flex flex-col gap-1">
            <span className="field-label">Frame rate</span>
            <select
              className="numeric-input"
              value={COMMON_FPS.includes(project.fps as (typeof COMMON_FPS)[number]) ? project.fps : 'custom'}
              onChange={(event) => {
                if (event.target.value === 'custom') return;
                setProjectSettings({ fps: Number(event.target.value) }, retime);
              }}
            >
              {COMMON_FPS.map((fps) => (
                <option key={fps} value={fps}>
                  {fps} fps
                </option>
              ))}
              {!COMMON_FPS.includes(project.fps as (typeof COMMON_FPS)[number]) && (
                <option value="custom">{project.fps} fps (custom)</option>
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="field-label">Custom frame rate</span>
            <input
              type="number"
              className="numeric-input"
              min={1}
              max={240}
              step={0.001}
              value={project.fps}
              onChange={(event) => {
                const fps = Number(event.target.value);
                if (fps > 0 && fps <= 240) setProjectSettings({ fps }, retime);
              }}
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              className="accent-blue-500"
              checked={retime}
              onChange={(event) => setRetime(event.target.checked)}
            />
            Keep the edit at the same times when the rate changes
          </label>
          <p className="pl-6 text-2xs leading-relaxed text-slate-500">
            {retime
              ? `On: every cut, trim, keyframe and marker is rescaled, so a cut at 4s stays at 4s${
                  clipCount > 0 ? ` (${clipCount} clips)` : ''
                }.`
              : 'Off: frame numbers are kept as they are, so the whole edit plays faster or slower. This is what you want when the timeline was authored against frame counts rather than times.'}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="field-label">Width</span>
              <input
                type="number"
                className="numeric-input"
                min={2}
                step={2}
                value={project.width}
                onChange={(event) => setProjectSettings({ width: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="field-label">Height</span>
              <input
                type="number"
                className="numeric-input"
                min={2}
                step={2}
                value={project.height}
                onChange={(event) => setProjectSettings({ height: Number(event.target.value) })}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="field-label">Preset</span>
            <select
              className="numeric-input"
              value={presetMatch?.label ?? 'custom'}
              onChange={(event) => {
                const preset = PRESETS.find((candidate) => candidate.label === event.target.value);
                if (preset) setProjectSettings({ width: preset.width, height: preset.height });
              }}
            >
              {!presetMatch && <option value="custom">Custom</option>}
              {PRESETS.map((preset) => (
                <option key={preset.label} value={preset.label}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="field-label">Duration (seconds)</span>
            <input
              type="number"
              className="numeric-input"
              min={1}
              step={1}
              value={Number(durationSeconds.toFixed(3))}
              onChange={(event) => {
                const seconds = Number(event.target.value);
                if (seconds > 0) {
                  setProjectSettings({
                    durationFrames: Math.max(1, Math.round(seconds * project.fps)),
                  });
                }
              }}
            />
            <span className="text-2xs text-slate-500">
              {project.durationFrames} frames - {framesToTimecode(project.durationFrames, project.fps)}
            </span>
          </label>

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              className="accent-blue-500"
              checked={project.hasAlphaBackground}
              onChange={(event) =>
                setProjectSettings({ hasAlphaBackground: event.target.checked })
              }
            />
            Transparent background (game sprites)
          </label>
          <p className="pl-6 text-2xs leading-relaxed text-slate-500">
            Leaves the scene empty instead of opaque black, so exports to PNG,
            ProRes 4444 or WebM carry a real alpha channel.
          </p>

          {adoptedFrom && (
            <p className="text-2xs text-slate-600">
              These were adopted from the first import, {adoptedFrom}. Changing
              them here is an undoable edit like any other.
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-panel-700 px-4 py-3">
          <button type="button" className="tool-button tool-button-active" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ProjectSettings;
