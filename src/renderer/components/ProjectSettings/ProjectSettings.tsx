import { useEffect, useState, type ReactNode } from 'react';
import { useReframeDialog } from '@renderer/components/Reframe/ReframeDialog';
import { Clock, Crop, History, Image as ImageIcon } from 'lucide-react';
import { COMMON_FPS } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { BackupSettings } from './BackupSettings';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { refitForFrame } from '@renderer/edit/frameShape';

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
 *
 * Laid out in three groups, as Resolve's and Premiere's project settings are:
 * the picture, the timing, and saving. The field for a rate of one's own only
 * appears once "Custom" is chosen - before, it sat under the list showing the
 * same number the list already showed.
 */

const PRESETS: { label: string; width: number; height: number }[] = [
  { label: '3840 x 2160 (4K UHD)', width: 3840, height: 2160 },
  { label: '1920 x 1080 (1080p)', width: 1920, height: 1080 },
  { label: '1280 x 720 (720p)', width: 1280, height: 720 },
  { label: '1080 x 1920 (vertical)', width: 1080, height: 1920 },
  { label: '1080 x 1080 (square)', width: 1080, height: 1080 },
];

const isCommonRate = (fps: number): boolean => COMMON_FPS.includes(fps as (typeof COMMON_FPS)[number]);

/**
 * The project at a new size with every picture fitted to it, not stretched:
 * a 16:9 clip in a frame made vertical keeps its shape, with bars, and a
 * picture in picture stays where it was as the frame grows to 4K
 * (edit/frameShape.ts). Plain setProjectSettings kept the old scales, which
 * squeezed every clip to the new shape.
 */
function resizeProject(size: { width: number; height: number }): void {
  const state = useProjectStore.getState();
  if (size.width === state.project.width && size.height === state.project.height) return;
  state.setFrameShape(size, refitForFrame(state.project, size), 'Project settings');
}

/**
 * A side of the frame, applied when the field is left or Enter pressed - not
 * at every key, which would fit every picture to a frame 1 or 10 px wide on
 * the way to 1080. Anything under 2 px is put back.
 */
function SizeField({ label, value, onCommit }: { label: string; value: number; onCommit(value: number): void }): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const next = Math.round(Number(draft));
    if (Number.isFinite(next) && next >= 2) {
      if (next !== value) onCommit(next);
    } else setDraft(String(value));
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      <input
        type="number"
        className="numeric-input timecode"
        min={2}
        step={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

function Group({ title, icon: Icon, children }: { title: string; icon: typeof Clock; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-3 rounded-menu border border-panel-700 bg-panel-950/60 p-3">
      <h3 className="section-title">
        <Icon size={13} className="text-slate-400" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface ProjectSettingsProps {
  onClose(): void;
  /** Put an earlier version of this project on screen, unsaved. */
  onRestore(contents: string, savedAt: string): Promise<void> | void;
  /** Playing its exit animation; see usePresence. */
  closing?: boolean;
}

export function ProjectSettings({ onClose, onRestore, closing = false }: ProjectSettingsProps): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const setProjectSettings = useProjectStore((state) => state.setProjectSettings);
  const adoptedFrom = useProjectStore((state) => state.adoptedSettingsFrom);

  const [retime, setRetime] = useState(true);
  // Custom stays chosen once chosen, even when the number typed happens to be
  // a common rate: the field must not vanish under the cursor.
  const [customRate, setCustomRate] = useState(() => !isCommonRate(project.fps));

  const durationSeconds = project.durationFrames / project.fps;
  const clipCount = Object.keys(project.clips).length;
  const presetMatch = PRESETS.find(
    (preset) => preset.width === project.width && preset.height === project.height,
  );

  return (
    <Dialog
      title={t('settings.title')}
      onClose={onClose}
      closing={closing}
      widthClass="w-[500px]"
      bodyClassName="space-y-3 p-4"
      footer={
        // Every change applies as it is made, and is undoable: nothing to cancel.
        <button type="button" className="button-primary" onClick={onClose}>
          {t('settings.done')}
        </button>
      }
    >
      {adoptedFrom && <p className="text-2xs text-slate-400">{t('settings.adopted', { name: adoptedFrom })}</p>}

      <Group title={t('settings.picture')} icon={ImageIcon}>
        <label className="flex flex-col gap-1">
          <span className="field-label">{t('settings.preset')}</span>
          <select
            className="numeric-input"
            value={presetMatch?.label ?? 'custom'}
            onChange={(event) => {
              const preset = PRESETS.find((candidate) => candidate.label === event.target.value);
              if (preset) resizeProject({ width: preset.width, height: preset.height });
            }}
          >
            {!presetMatch && <option value="custom">{t('settings.customSize')}</option>}
            {PRESETS.map((preset) => (
              <option key={preset.label} value={preset.label}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        {/* A new shape with the clips filled into it and following the person, rather than letterboxed (Reframe). */}
        <button
          type="button"
          data-testid="settings-reframe"
          className="tool-button h-control w-full justify-center border border-panel-600"
          onClick={() => {
            // One dialog at a time: this one gives way to the reframe.
            onClose();
            useReframeDialog.getState().show();
          }}
        >
          <Crop size={13} />
          {t('reframe.open')}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <SizeField label={t('settings.width')} value={project.width} onCommit={(width) => resizeProject({ width, height: project.height })} />
          <SizeField label={t('settings.height')} value={project.height} onCommit={(height) => resizeProject({ width: project.width, height })} />
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="accent-accent"
            checked={project.hasAlphaBackground}
            onChange={(event) => setProjectSettings({ hasAlphaBackground: event.target.checked })}
          />
          {t('settings.transparent')}
        </label>
        <p className="pl-6 text-2xs leading-relaxed text-slate-400">{t('settings.transparentHint')}</p>
      </Group>

      <Group title={t('settings.timing')} icon={Clock}>
        <label className="flex flex-col gap-1">
          <span className="field-label">{t('settings.frameRate')}</span>
          <select
            className="numeric-input"
            value={customRate ? 'custom' : project.fps}
            onChange={(event) => {
              if (event.target.value === 'custom') {
                setCustomRate(true);
                return;
              }
              setCustomRate(false);
              setProjectSettings({ fps: Number(event.target.value) }, retime);
            }}
          >
            {COMMON_FPS.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
            <option value="custom">{t('settings.customRateOption')}</option>
          </select>
        </label>

        {customRate && (
          <label className="flex flex-col gap-1">
            <span className="field-label">{t('settings.customRate')}</span>
            <span className="relative block">
              <input
                type="number"
                className="numeric-input timecode pr-9"
                min={1}
                max={240}
                step={0.001}
                value={project.fps}
                onChange={(event) => {
                  const fps = Number(event.target.value);
                  if (fps > 0 && fps <= 240) setProjectSettings({ fps }, retime);
                }}
              />
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-slate-400">
                fps
              </span>
            </span>
          </label>
        )}

        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            className="accent-accent"
            checked={retime}
            onChange={(event) => setRetime(event.target.checked)}
          />
          {t('settings.keepTiming')}
        </label>
        <p className="pl-6 text-2xs leading-relaxed text-slate-400">
          {retime
            ? clipCount > 0
              ? t('settings.keepTimingOnClips', { count: clipCount })
              : t('settings.keepTimingOn')
            : t('settings.keepTimingOff')}
        </p>

        <label className="flex flex-col gap-1">
          <span className="field-label">{t('settings.duration')}</span>
          <span className="relative block">
            <input
              type="number"
              className="numeric-input timecode pr-6"
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
            <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-2xs text-slate-400">
              s
            </span>
          </span>
          <span className="timecode text-2xs text-slate-400">
            {framesToTimecode(project.durationFrames, project.fps)} · {t('settings.frames', { count: project.durationFrames })}
          </span>
        </label>
      </Group>

      <Group title={t('settings.saving')} icon={History}>
        <BackupSettings onRestore={onRestore} />
      </Group>
    </Dialog>
  );
}

export default ProjectSettings;
