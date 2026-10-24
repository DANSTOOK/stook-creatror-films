import { useMemo } from 'react';
import { Settings2 } from 'lucide-react';
import { COMMON_FPS } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';
import { refitForFrame } from '@renderer/edit/frameShape';
import { ASPECTS, SHORT_SIDES, aspectOf, frameAtShortSide, frameForAspect, isAspectId, sharpnessName } from '@renderer/components/PreviewViewport/aspect';
import { SwitchRow } from './rows';

/**
 * The inspector with nothing selected: the project's own settings, as
 * CapCut's shows the draft's - its shape, its sharpness, its frame rate, its
 * background - rather than a panel that only says to select something. A
 * click on a clip or a transition brings their settings back.
 *
 * A new shape or size fits the pictures to the frame instead of stretching
 * them (edit/frameShape.ts), the way the viewer's shape menu does; Project
 * settings holds the rest - a size of one's own, keeping the timing when the
 * rate changes, saving.
 */
export function ProjectPanel(): JSX.Element {
  const t = useT();
  const project = useProjectStore((state) => state.project);
  const setProjectSettings = useProjectStore((state) => state.setProjectSettings);
  const length = useMemo(() => projectContentLength(project), [project]);
  const aspect = aspectOf(project.width, project.height);
  const short = Math.min(project.width, project.height);

  const resize = (size: { width: number; height: number }, label: string): void => {
    const state = useProjectStore.getState();
    if (size.width === state.project.width && size.height === state.project.height) return;
    state.setFrameShape(size, refitForFrame(state.project, size), label);
  };

  const row = 'grid grid-cols-[104px_1fr] items-center gap-2';
  return (
    <div data-testid="inspector-project" className="scf-tab-enter flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="space-y-1">
        <p className="section-title">
          <Settings2 size={13} className="text-slate-400" aria-hidden />
          {t('settings.title')}
        </p>
        <p className="text-2xs leading-relaxed text-slate-400">{t('inspector.projectHint')}</p>
      </div>

      <div className="space-y-2 rounded-menu border border-panel-700 bg-panel-950/60 p-3">
        <label className={row}>
          <span className="field-label truncate">{t('viewer.aspect')}</span>
          <select
            data-testid="inspector-project-aspect"
            className="numeric-input h-control-dense"
            value={aspect ?? 'custom'}
            onChange={(event) => {
              const chosen = event.target.value;
              if (isAspectId(chosen)) resize(frameForAspect(project.width, project.height, chosen), 'Aspect ratio');
            }}
          >
            {!aspect && <option value="custom">{`${project.width}×${project.height}`}</option>}
            {ASPECTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
        </label>

        <label className={row}>
          <span className="field-label truncate">{t('inspector.projectSize')}</span>
          <select
            data-testid="inspector-project-size"
            className="numeric-input h-control-dense"
            value={aspect && (SHORT_SIDES as readonly number[]).includes(short) ? String(short) : 'custom'}
            disabled={!aspect}
            onChange={(event) => {
              if (aspect) resize(frameAtShortSide(aspect, Number(event.target.value)), 'Project settings');
            }}
          >
            {(!aspect || !(SHORT_SIDES as readonly number[]).includes(short)) && <option value="custom">{`${project.width}×${project.height}`}</option>}
            {aspect &&
              SHORT_SIDES.map((side) => {
                const size = frameAtShortSide(aspect, side);
                return (
                  <option key={side} value={String(side)}>
                    {`${sharpnessName(side)} · ${size.width}×${size.height}`}
                  </option>
                );
              })}
          </select>
        </label>

        <label className={row}>
          <span className="field-label truncate">{t('inspector.projectFps')}</span>
          <select
            data-testid="inspector-project-fps"
            className="numeric-input h-control-dense"
            value={String(project.fps)}
            onChange={(event) => setProjectSettings({ fps: Number(event.target.value) })}
          >
            {!(COMMON_FPS as readonly number[]).includes(project.fps) && <option value={String(project.fps)}>{`${project.fps} fps`}</option>}
            {COMMON_FPS.map((fps) => (
              <option key={fps} value={String(fps)}>
                {`${fps} fps`}
              </option>
            ))}
          </select>
        </label>

        <div className={row}>
          <span className="field-label truncate">{t('settings.duration')}</span>
          <span data-testid="inspector-project-length" className="timecode text-xs text-slate-200">
            {framesToTimecode(length, project.fps)}
          </span>
        </div>

        <SwitchRow label={t('inspector.projectTransparent')} checked={project.hasAlphaBackground} testId="inspector-project-alpha" onChange={(on) => setProjectSettings({ hasAlphaBackground: on })} />
      </div>

      {hasNativeBridge() && (
        <button
          type="button"
          data-testid="inspector-project-more"
          className="tool-button h-control w-full justify-center border border-panel-600"
          onClick={() => window.filmora.appMenuInvoke('projectSettings')}
        >
          <Settings2 size={13} />
          {t('inspector.projectMore')}
        </button>
      )}
    </div>
  );
}
