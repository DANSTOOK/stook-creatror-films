import type { ReactNode } from 'react';
import { Crosshair, LogIn, LogOut, Move, Repeat, Sparkles, Trash2 } from 'lucide-react';
import type { Clip, ClipMotionFx } from '@shared/types';
import { useT } from '@renderer/i18n';
import { effectLabel } from '@renderer/fx/effects/catalog';
import {
  MOTION_AMOUNT_MAX,
  MOTION_AMOUNT_MIN,
  PAN_AMOUNT_MAX,
  MOTION_PRESETS,
  isMotionPreset,
  motionHasFocus,
  motionPeakScale,
  motionPresetLabel,
  type MotionPresetId,
} from '@renderer/fx/motion/presets';
import {
  ANIMATION_SECONDS_MAX,
  ANIMATION_SECONDS_MIN,
  animationLabel,
  animationSeconds,
  animationsOf,
  isClipAnimation,
  type ClipAnimationId,
  type ClipAnimationPhase,
} from '@renderer/fx/motion/animations';
import { setClipFx } from '@renderer/fx/motion/apply';
import { useZoneEditStore } from '@renderer/fx/motion/zoneEdit';
import { SliderRow } from './rows';
import { FollowCard } from './FollowCard';

/**
 * The top of the inspector's Effects tab: everything put on the clip from
 * the Effects panel, in one place, each with its settings and a way off.
 *
 *   - A line of chips naming all of it, so what is on the clip reads at a
 *     glance - the move, each animation, each effect.
 *   - A card for the move: which one, how strong, and for a zoom the zone it
 *     closes in on, picked by dragging a frame over the picture in the
 *     viewer (as CapCut and Filmora let a zoom be aimed).
 *   - A card each for the In, the Out and the Loop: which one, and how long.
 *
 * Every change goes through setClipFx: the old keyframes out, the new in,
 * one undo step (a slider's drag is one step).
 */

const CENTRE = { x: 0.5, y: 0.5 };

function Card({ icon: Icon, title, testId, onRemove, children }: { icon: typeof Move; title: string; testId: string; onRemove?(): void; children: ReactNode }): JSX.Element {
  const t = useT();
  return (
    <section data-testid={testId} className="mx-2 mb-2 rounded-lg border border-panel-700 bg-panel-900/70 p-2.5">
      <header className="mb-2 flex items-center gap-2">
        <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent-hover">
          <Icon size={13} />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">{title}</h3>
        {onRemove && (
          <button type="button" data-testid={`${testId}-remove`} className="tool-button tool-button-dense gap-1 text-2xs text-slate-400 hover:text-red-400" onClick={onRemove}>
            <Trash2 size={11} />
            {t('fxp.remove')}
          </button>
        )}
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Choice({ label, value, options, testId, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; testId: string; onChange(value: string): void }): JSX.Element {
  return (
    <label className="grid grid-cols-[76px_1fr] items-center gap-2">
      <span className="field-label truncate">{label}</span>
      <select data-testid={testId} className="numeric-input h-control-dense min-w-0" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const PHASE_ICON: Record<ClipAnimationPhase, typeof Move> = { in: LogIn, out: LogOut, loop: Repeat };
const PHASE_TITLE: Record<ClipAnimationPhase, 'fxa.group.in' | 'fxa.group.out' | 'fxa.group.loop'> = { in: 'fxa.group.in', out: 'fxa.group.out', loop: 'fxa.group.loop' };

export function ClipFxPanel({ clip }: { clip: Clip }): JSX.Element {
  const t = useT();
  const zoneFor = useZoneEditStore((state) => state.clipId);
  const setZoneFor = useZoneEditStore((state) => state.setClipId);
  const fx: ClipMotionFx = clip.fx ?? {};
  const change = (next: ClipMotionFx, mergeKey?: string): void => setClipFx(clip.id, next, mergeKey);
  const without = (key: keyof ClipMotionFx): ClipMotionFx => {
    const next = { ...fx };
    delete next[key];
    return next;
  };

  const motion = fx.motion && isMotionPreset(fx.motion.preset) ? fx.motion : undefined;
  const picking = zoneFor === clip.id;
  const chips = [
    ...(motion ? [{ key: 'motion', label: t(motionPresetLabel(motion.preset as MotionPresetId)) }] : []),
    ...(['in', 'out', 'loop'] as const).flatMap((phase) => {
      const chosen = fx[phase];
      return chosen && isClipAnimation(chosen.id) ? [{ key: phase, label: t(animationLabel(chosen.id)) }] : [];
    }),
    ...(clip.effects ?? []).map((effect) => ({ key: effect.id, label: t(effectLabel(effect.type)) })),
    ...(clip.tracking ? [{ key: 'tracking', label: t('track.title') }] : []),
  ];

  const presetOptions = MOTION_PRESETS.map((preset) => ({ value: preset, label: t(motionPresetLabel(preset)) }));
  const animationOptions = (phase: ClipAnimationPhase) => [
    { value: '', label: t('fxp.none') },
    ...animationsOf(phase).map((id) => ({ value: id, label: t(animationLabel(id)) })),
  ];

  return (
    <div data-testid="clip-fx" className="pt-2">
      {/* What is on the clip, at a glance. */}
      <div className="mx-2 mb-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5" data-testid="clip-fx-summary">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-100">
          <Sparkles size={13} className="text-accent-hover" aria-hidden />
          {t('fxp.applied', { count: chips.length })}
        </p>
        {chips.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <li key={chip.key} className="scf-rise rounded-full bg-panel-800 px-2 py-0.5 text-2xs text-slate-200 ring-1 ring-panel-600">
                {chip.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-2xs leading-relaxed text-slate-400">{t('fxp.nothingApplied')}</p>
        )}
      </div>

      {/* The move. */}
      <Card icon={Move} title={t('fx.effectCategory.motion')} testId="clip-fx-motion" onRemove={motion ? () => { setZoneFor(null); change(without('motion')); } : undefined}>
        <Choice
          label={t('fxp.kind')}
          testId="clip-fx-motion-preset"
          value={motion?.preset ?? ''}
          options={[{ value: '', label: t('fxp.none') }, ...presetOptions]}
          onChange={(value) => {
            if (!value) {
              setZoneFor(null);
              change(without('motion'));
              return;
            }
            change({ ...fx, motion: { preset: value, amount: motion?.amount ?? 1, focus: motion?.focus ?? CENTRE } });
          }}
        />
        {motion && (
          <>
            <SliderRow
              label={motionHasFocus(motion.preset as MotionPresetId) ? t('fxp.zoom') : t('fxp.strength')}
              value={motion.amount}
              min={MOTION_AMOUNT_MIN}
              max={motionHasFocus(motion.preset as MotionPresetId) ? MOTION_AMOUNT_MAX : PAN_AMOUNT_MAX}
              step={0.05}
              format={(amount) =>
                motionHasFocus(motion.preset as MotionPresetId)
                  ? `${Math.round(motionPeakScale(motion.preset as MotionPresetId, amount) * 100)} %`
                  : `${Math.round(amount * 100)} %`
              }
              onChange={(amount) => change({ ...fx, motion: { ...motion, amount } }, `fx-motion:${clip.id}`)}
            />
            {motionHasFocus(motion.preset as MotionPresetId) && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="clip-fx-pick-zone"
                  aria-pressed={picking}
                  className={`tool-button h-control border ${picking ? 'tool-button-active border-accent/60' : 'border-panel-600'}`}
                  onClick={() => setZoneFor(picking ? null : clip.id)}
                >
                  <Crosshair size={13} />
                  {picking ? t('fxp.zoneDone') : t('fxp.pickZone')}
                </button>
                {(motion.focus.x !== 0.5 || motion.focus.y !== 0.5) && (
                  <button type="button" className="tool-button h-control text-2xs text-slate-400" onClick={() => change({ ...fx, motion: { ...motion, focus: CENTRE } })}>
                    {t('fxp.zoneCentre')}
                  </button>
                )}
                <p className="w-full text-2xs leading-relaxed text-slate-400">{picking ? t('fxp.zonePicking') : t('fxp.zoneHint')}</p>
              </div>
            )}
          </>
        )}
      </Card>

      {/* The animations. */}
      {(['in', 'out', 'loop'] as const).map((phase) => {
        const chosen = fx[phase];
        const id = chosen && isClipAnimation(chosen.id) ? chosen.id : undefined;
        return (
          <Card key={phase} icon={PHASE_ICON[phase]} title={t(PHASE_TITLE[phase])} testId={`clip-fx-${phase}`} onRemove={id ? () => change(without(phase)) : undefined}>
            <Choice
              label={t('fxp.kind')}
              testId={`clip-fx-${phase}-choice`}
              value={id ?? ''}
              options={animationOptions(phase)}
              onChange={(value) => {
                if (!value || !isClipAnimation(value)) {
                  change(without(phase));
                  return;
                }
                const seconds = chosen && 'seconds' in chosen ? chosen.seconds : animationSeconds(value as ClipAnimationId);
                change({ ...fx, [phase]: phase === 'loop' ? { id: value } : { id: value, seconds } });
              }}
            />
            {id && phase !== 'loop' && chosen && 'seconds' in chosen && (
              <SliderRow
                label={t('fxp.duration')}
                value={chosen.seconds}
                min={ANIMATION_SECONDS_MIN}
                max={ANIMATION_SECONDS_MAX}
                step={0.05}
                format={(seconds) => `${seconds.toFixed(2)} s`}
                onChange={(seconds) => change({ ...fx, [phase]: { id, seconds } }, `fx-${phase}:${clip.id}`)}
              />
            )}
          </Card>
        );
      })}

      {/* Following a thing in the video under it. */}
      {!clip.caption && <FollowCard clip={clip} />}
    </div>
  );
}
