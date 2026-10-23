import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Spline } from 'lucide-react';
import type { BezierCurve, Clip, ClipTransform, Easing, Keyframe, KeyframeValue } from '@shared/types';
import { useT, type MessageKey } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';

/**
 * How a move gets from one keyframe to the next: a curve, as Premiere's and
 * After Effects' speed graphs and CapCut's "curves" shape it - slow out and
 * in, a fast start, an overshoot that settles. Presets in one click, and the
 * curve itself to drag by its two handles (a CSS-style cubic bezier, the
 * evaluator's own: engine/KeyframeEvaluator). The curve belongs to the
 * keyframe a stretch starts from, as in every editor; "All" puts it on every
 * stretch of the property.
 */

type Property = 'position' | 'scale' | 'rotation' | 'opacity';
const PROPERTIES: readonly Property[] = ['position', 'scale', 'rotation', 'opacity'];

const PRESETS: ReadonlyArray<{ id: string; label: MessageKey; easing: Easing; curve?: BezierCurve }> = [
  { id: 'linear', label: 'easing.linear', easing: 'linear' },
  { id: 'smooth', label: 'easing.smooth', easing: 'bezier', curve: { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } } },
  { id: 'in', label: 'easing.in', easing: 'easeIn' },
  { id: 'out', label: 'easing.out', easing: 'easeOut' },
  { id: 'fast', label: 'easing.fast', easing: 'bezier', curve: { cp1: { x: 0.16, y: 1 }, cp2: { x: 0.3, y: 1 } } },
  { id: 'back', label: 'easing.back', easing: 'bezier', curve: { cp1: { x: 0.34, y: 1.56 }, cp2: { x: 0.64, y: 1 } } },
];

/** The curve a keyframe's easing draws, as a bezier (linear and the named ones in their own terms). */
function curveOf(key: Keyframe<KeyframeValue>): BezierCurve {
  if (key.easing === 'bezier' && key.bezierParams) return key.bezierParams;
  if (key.easing === 'easeIn') return { cp1: { x: 0.42, y: 0 }, cp2: { x: 1, y: 1 } };
  if (key.easing === 'easeOut') return { cp1: { x: 0, y: 0 }, cp2: { x: 0.58, y: 1 } };
  return { cp1: { x: 1 / 3, y: 1 / 3 }, cp2: { x: 2 / 3, y: 2 / 3 } };
}

const W = 168;
const H = 112;
const PAD = 12;
// y runs from -0.4 to 1.4: room for an overshoot either way.
const toX = (x: number): number => PAD + x * (W - PAD * 2);
const toY = (y: number): number => H - PAD - ((y + 0.4) / 1.8) * (H - PAD * 2);

export function EasingCard({ clip }: { clip: Clip }): JSX.Element | null {
  const t = useT();
  const frame = useProjectStore((state) => state.project.currentFrame);
  const updateClip = useProjectStore((state) => state.updateClip);
  const animated = PROPERTIES.filter((property) => clip.transform[property].length >= 2);
  const [chosen, setChosen] = useState<Property | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (animated.length === 0) return null;
  const property = chosen && animated.includes(chosen) ? chosen : animated[0];
  const keys = [...(clip.transform[property] as Keyframe<KeyframeValue>[])].sort((a, b) => a.frame - b.frame);
  // The stretch under the playhead, unless one was picked with the arrows.
  const found = keys.findIndex((_, index) => index < keys.length - 1 && frame < keys[index + 1].frame);
  const under = found < 0 ? keys.length - 2 : found;
  const segment = pick !== null && pick < keys.length - 1 ? pick : under;
  const from = keys[segment];
  const to = keys[segment + 1];
  const curve = curveOf(from);

  const write = (change: (key: Keyframe<KeyframeValue>, index: number) => Keyframe<KeyframeValue>, merge?: string): void => {
    const next = keys.map((key, index) => change(key, index));
    updateClip(clip.id, { transform: { ...clip.transform, [property]: next } as ClipTransform }, merge);
  };
  const setCurve = (easing: Easing, bezier?: BezierCurve, all = false, merge?: string): void =>
    write((key, index) => {
      if (!all && index !== segment) return key;
      if (index === keys.length - 1) return key;
      const { bezierParams: _old, ...rest } = key;
      void _old;
      return { ...rest, easing, ...(easing === 'bezier' && bezier ? { bezierParams: bezier } : {}) };
    }, merge);

  const drag = (handle: 'cp1' | 'cp2') => (event: React.PointerEvent<SVGCircleElement>): void => {
    const svg = svgRef.current;
    if (!svg) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const box = svg.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, ((moveEvent.clientX - box.left) / box.width * W - PAD) / (W - PAD * 2)));
      const y = Math.min(1.4, Math.max(-0.4, ((H - PAD - (moveEvent.clientY - box.top) / box.height * H) / (H - PAD * 2)) * 1.8 - 0.4));
      const next = { ...curveOf(keys[segment]), [handle]: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 } };
      setCurve('bezier', next, false, `easing:${clip.id}:${from.id}`);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const path = `M ${toX(0)} ${toY(0)} C ${toX(curve.cp1.x)} ${toY(curve.cp1.y)}, ${toX(curve.cp2.x)} ${toY(curve.cp2.y)}, ${toX(1)} ${toY(1)}`;
  const active = PRESETS.find((preset) =>
    preset.easing === from.easing && (preset.easing !== 'bezier' || (from.bezierParams && JSON.stringify(preset.curve) === JSON.stringify(from.bezierParams))),
  )?.id;

  return (
    <div className="mx-2 mb-2 space-y-2 rounded-lg border border-panel-700 bg-panel-900/60 p-2.5" data-testid="inspector-easing">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-100">
        <Spline size={13} className="text-accent-hover" aria-hidden />
        {t('easing.title')}
        <select
          className="numeric-input ml-auto h-6 px-1 text-2xs"
          data-testid="inspector-easing-property"
          value={property}
          onChange={(event) => {
            setChosen(event.target.value as Property);
            setPick(null);
          }}
        >
          {animated.map((name) => (
            <option key={name} value={name}>
              {t(`easing.property.${name}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1 text-2xs text-slate-400">
        <button type="button" className="tool-button tool-button-dense w-5 px-0" disabled={segment === 0} onClick={() => setPick(segment - 1)} aria-label={t('easing.previous')}>
          <ChevronLeft size={12} />
        </button>
        <span className="flex-1 text-center tabular-nums" data-testid="inspector-easing-segment">
          {t('easing.segment', { from: from.frame, to: to.frame, index: segment + 1, count: keys.length - 1 })}
        </span>
        <button type="button" className="tool-button tool-button-dense w-5 px-0" disabled={segment >= keys.length - 2} onClick={() => setPick(segment + 1)} aria-label={t('easing.next')}>
          <ChevronRight size={12} />
        </button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block w-full touch-none rounded-md bg-panel-950" data-testid="inspector-easing-graph">
        <line x1={toX(0)} y1={toY(0)} x2={toX(1)} y2={toY(0)} className="stroke-panel-700" strokeWidth={1} />
        <line x1={toX(0)} y1={toY(1)} x2={toX(1)} y2={toY(1)} className="stroke-panel-700" strokeWidth={1} strokeDasharray="3 3" />
        <line x1={toX(0)} y1={toY(0)} x2={toX(curve.cp1.x)} y2={toY(curve.cp1.y)} className="stroke-slate-500" strokeWidth={1} />
        <line x1={toX(1)} y1={toY(1)} x2={toX(curve.cp2.x)} y2={toY(curve.cp2.y)} className="stroke-slate-500" strokeWidth={1} />
        <path d={path} fill="none" className="stroke-accent" strokeWidth={2} />
        {(['cp1', 'cp2'] as const).map((handle) => (
          <circle
            key={handle}
            data-testid={`inspector-easing-${handle}`}
            cx={toX(curve[handle].x)}
            cy={toY(curve[handle].y)}
            r={5}
            className="cursor-grab fill-accent-hover stroke-white"
            strokeWidth={1.5}
            onPointerDown={drag(handle)}
          />
        ))}
      </svg>
      <div className="grid grid-cols-3 gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`inspector-easing-${preset.id}`}
            aria-pressed={active === preset.id}
            className={`tool-button tool-button-dense h-6 justify-center px-1 text-2xs ${active === preset.id ? 'tool-button-active' : ''}`}
            onClick={() => setCurve(preset.easing, preset.curve)}
          >
            {t(preset.label)}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-testid="inspector-easing-all"
        className="tool-button tool-button-dense h-6 w-full justify-center text-2xs"
        onClick={() => setCurve(from.easing, from.bezierParams, true)}
      >
        {t('easing.all')}
      </button>
    </div>
  );
}
