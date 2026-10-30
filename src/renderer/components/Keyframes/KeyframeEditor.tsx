import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Diamond, LineChart, Rows3, Timer, X } from 'lucide-react';
import type { Clip } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { framesToTimecode } from '@shared/utils/timecode';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { PanelEmptyState } from '@renderer/components/Layout/PanelEmptyState';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { createId } from '@shared/utils/id';
import { curveOf, easeProgress, type Easing } from '@renderer/keyframes/easing';
import { assetHasSound } from '@renderer/components/Timeline/detachAudio';
import {
  clipSpan,
  neighbourKeyframe,
  removeKeyframes,
  retime,
  rowsOf,
  setEasing,
  setKeyframeValue,
  toggleKeyframeAt,
  type Picked,
  type Row,
  type RowId,
} from '@renderer/keyframes/rows';

/**
 * The keyframe editor: a window of its own for the animation of the selected
 * clip, as After Effects' timeline and graph editor and Theatre.js's sequence
 * editor have it (the model is Theatre.js's - renderer/keyframes/easing).
 *
 * On the left, every property that animates: the transform's and each
 * effect's settings, each with a stopwatch (animate it or stop animating it)
 * and a diamond (a keyframe at the playhead, or that keyframe gone). On the
 * right, the clip's span in time with the playhead on it, and either the
 * keyframes as diamonds on their rows (Sheet) - picked, dragged in time
 * together, deleted - or the values as curves (Curves), with the keyframes on
 * them to drag. Below, the move out of the picked keyframes: a shape from the
 * list, or a curve of one's own with its two handles. Every drag is one undo
 * step; the viewer, the inspector and the export see the same clip.
 */

const ROW_HEIGHT = 26;
const RULER_HEIGHT = 22;
/** Room at each end of the time area, so a keyframe on the clip's first or last frame is whole and easy to pick. */
const EDGE = 12;

/** The shapes offered, in the order a motion designer reaches for them. */
const EASINGS: ReadonlyArray<{ id: Easing; label: MessageKey }> = [
  { id: 'linear', label: 'kf.easing.linear' },
  { id: 'easeInOut', label: 'kf.easing.easeInOut' },
  { id: 'easeIn', label: 'kf.easing.easeIn' },
  { id: 'easeOut', label: 'kf.easing.easeOut' },
  { id: 'hold', label: 'kf.easing.hold' },
  { id: 'back', label: 'kf.easing.back' },
  { id: 'elastic', label: 'kf.easing.elastic' },
  { id: 'bounce', label: 'kf.easing.bounce' },
  { id: 'bezier', label: 'kf.easing.bezier' },
];

const MODE_KEY = 'scf.keyframes.mode';
type Mode = 'sheet' | 'curves';

function loadMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'curves' ? 'curves' : 'sheet';
  } catch {
    return 'sheet';
  }
}

/**
 * The size of an element, kept up to date. A callback ref: the time area is
 * only there once a clip is, so the measuring starts when it appears (a ref
 * read once on mounting found nothing, and the sheet was never drawn).
 */
function useSize(): [(element: HTMLDivElement | null) => void, number, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return undefined;
    const view = element.ownerDocument.defaultView ?? window;
    const measure = (): void => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new view.ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size.width, size.height];
}

/** A short clock for a frame: seconds and frames past the second. */
const clock = (frame: number, fps: number): string => {
  const [, mm, ss, ff] = framesToTimecode(frame, fps).split(':');
  return `${Number(mm)}:${ss}.${ff}`;
};

/** The shape of a keyframe's diamond, by its move: After Effects' language of keyframe glyphs. */
function Glyph({ x, y, easing, picked }: { x: number; y: number; easing: Easing; picked: boolean }): JSX.Element {
  // Picked: white, ringed in the accent; otherwise the accent, edged dark so it reads on any row.
  const paint = picked ? 'fill-white stroke-accent' : 'fill-accent stroke-black/60';
  const diamond = `M ${x} ${y - 6} L ${x + 6} ${y} L ${x} ${y + 6} L ${x - 6} ${y} Z`;
  if (easing === 'hold') return <rect x={x - 4.5} y={y - 4.5} width={9} height={9} className={paint} strokeWidth={1} />;
  if (easing === 'linear') return <path d={diamond} className={paint} strokeWidth={1} />;
  if (easing === 'back' || easing === 'elastic' || easing === 'bounce') {
    return (
      <g>
        <path d={diamond} className={paint} strokeWidth={1} />
        <circle cx={x} cy={y} r={1.8} className={picked ? 'fill-accent' : 'fill-panel-950'} />
      </g>
    );
  }
  // Eased (in, out, both, a curve of one's own): round, as After Effects draws a bezier keyframe.
  return <circle cx={x} cy={y} r={5} className={paint} strokeWidth={1} />;
}

export function KeyframeEditor({ onClose }: { onClose?(): void }): JSX.Element {
  const t = useT();
  const clip = useProjectStore((state) => (state.ui.selectedClipIds.length === 1 ? state.project.clips[state.ui.selectedClipIds[0]] : undefined));
  const fps = useProjectStore((state) => state.project.fps);
  const currentFrame = useProjectStore((state) => state.project.currentFrame);
  const [mode, setModeState] = useState<Mode>(loadMode);
  const setMode = (next: Mode): void => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Remembered for this session only.
    }
  };
  const [picked, setPicked] = useState<Picked[]>([]);
  const [selectedRow, setSelectedRow] = useState<RowId | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; x1: number; y0: number; y1: number } | null>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const [areaRef, width, areaHeight] = useSize();
  /**
   * Whether this clip has sound to animate, by the same rule detach audio
   * uses: an audio clip, or a video whose file was found to carry a track. A
   * clip whose sound was separated leaves it to the sound clip, which is the
   * one with the rows.
   */
  const sound = useProjectStore((state) => {
    const picked = state.ui.selectedClipIds.length === 1 ? state.project.clips[state.ui.selectedClipIds[0]] : undefined;
    if (!picked || picked.audioDetached) return false;
    const asset = state.assets.find((candidate) => candidate.uri === picked.sourceUri);
    return picked.audioOnly === true || asset?.kind === 'audio' || assetHasSound(asset);
  });
  const rows = useMemo(() => (clip ? rowsOf(clip, sound) : []), [clip, sound]);

  // Picks of keyframes that are gone (deleted, the clip changed) are let go.
  useEffect(() => {
    setPicked((current) => current.filter((pick) => rows.some((row) => row.id === pick.row && row.keyframes.some((key) => key.id === pick.id))));
  }, [rows]);
  useEffect(() => {
    setPicked([]);
    setSelectedRow(null);
  }, [clip?.id]);

  if (!clip) {
    return (
      <section className="panel flex min-h-0 flex-1 flex-col" data-testid="keyframe-editor">
        <EditorHeader title={t('kf.title')} onClose={onClose} />
        <PanelEmptyState icon={Diamond} title={t('kf.noClip')} hint={t('kf.noClipHint')} />
      </section>
    );
  }

  const [first, last] = clipSpan(clip);
  const frames = last - first + 1;
  const span = Math.max(1, width - EDGE * 2);
  const xOf = (frame: number): number => EDGE + ((frame - first + 0.5) / frames) * span;
  const frameAt = (x: number): number => Math.min(last, Math.max(first, first + Math.floor(((x - EDGE) / span) * frames)));
  const update = (patch: Partial<Clip>, mergeKey?: string): void => {
    if (Object.keys(patch).length === 0) return;
    useProjectStore.getState().updateClip(clip.id, patch, mergeKey);
  };
  const isPicked = (row: RowId, id: string): boolean => picked.some((pick) => pick.row === row && pick.id === id);
  const graphRow = rows.find((row) => row.id === selectedRow) ?? rows.find((row) => row.keyframes.length > 1) ?? rows[0];
  const firstPicked = picked.length > 0 ? rows.find((row) => row.id === picked[0].row)?.keyframes.find((key) => key.id === picked[0].id) : undefined;

  const seek = (frame: number): void => useProjectStore.getState().setCurrentFrame(frame);

  /** A drag in the time area: the playhead (from the ruler), picked keyframes (from a diamond), or a box picking them. */
  const startDrag = (svg: SVGSVGElement, event: React.PointerEvent, kind: 'ruler' | 'keyframes' | 'box', start: { picks?: Picked[] } = {}): void => {
    const box = svg.getBoundingClientRect();
    const view = svg.ownerDocument.defaultView ?? window;
    const startX = event.clientX - box.left;
    const startY = event.clientY - box.top;
    const startFrame = frameAt(startX);
    const base = clip;
    const mergeKey = `keyframes:${createId('drag')}`;
    if (kind === 'ruler') seek(startFrame);
    const move = (moveEvent: PointerEvent): void => {
      const x = moveEvent.clientX - box.left;
      if (kind === 'ruler') seek(frameAt(x));
      else if (kind === 'keyframes' && start.picks) {
        const delta = frameAt(x) - startFrame;
        useProjectStore.getState().updateClip(base.id, retime(base, start.picks, delta), mergeKey);
      } else if (kind === 'box') {
        const y = moveEvent.clientY - box.top;
        setMarquee({ x0: Math.min(startX, x), x1: Math.max(startX, x), y0: Math.min(startY, y), y1: Math.max(startY, y) });
      }
    };
    const up = (upEvent: PointerEvent): void => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', up);
      if (kind === 'box') {
        const x = upEvent.clientX - box.left;
        const y = upEvent.clientY - box.top;
        const [x0, x1, y0, y1] = [Math.min(startX, x), Math.max(startX, x), Math.min(startY, y), Math.max(startY, y)];
        const inside: Picked[] = [];
        rows.forEach((row, index) => {
          const rowY = RULER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
          if (rowY < y0 || rowY > y1) return;
          for (const key of row.keyframes) if (xOf(key.frame) >= x0 && xOf(key.frame) <= x1) inside.push({ row: row.id, id: key.id });
        });
        setPicked(upEvent.shiftKey ? [...picked, ...inside] : inside);
        setMarquee(null);
        // A click, not a box: the playhead goes there.
        if (Math.abs(x - startX) < 3 && Math.abs(y - startY) < 3) seek(frameAt(x));
      }
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', up);
  };

  const easingMenu = (event: { preventDefault(): void; clientX: number; clientY: number }, picks: Picked[]): void => {
    event.preventDefault();
    const current = rows.find((row) => row.id === picks[0]?.row)?.keyframes.find((key) => key.id === picks[0]?.id)?.easing;
    const items: ContextMenuItem[] = [
      ...EASINGS.filter((entry) => entry.id !== 'bezier').map((entry) => ({
        label: t(entry.label),
        checked: current === entry.id,
        radio: true,
        onSelect: () => update(setEasing(clip, picks, entry.id)),
      })),
      { separator: true },
      { label: t('kf.delete'), danger: true, shortcut: 'Del', onSelect: () => update(removeKeyframes(clip, picks, currentFrame)) },
    ];
    openMenu(event, items, { label: t('kf.easing') });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && picked.length > 0) {
      event.preventDefault();
      update(removeKeyframes(clip, picked, currentFrame));
      setPicked([]);
    } else if (event.key === 'Escape' && picked.length > 0) {
      event.preventDefault();
      setPicked([]);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setPicked(rows.flatMap((row) => row.keyframes.map((key) => ({ row: row.id, id: key.id }))));
    }
  };

  const playheadX = currentFrame >= first && currentFrame <= last ? xOf(currentFrame) : null;
  const height = RULER_HEIGHT + rows.length * ROW_HEIGHT;
  const tick = rulerStep(frames, width, fps);

  return (
    <section className="panel flex min-h-0 flex-1 flex-col outline-none" data-testid="keyframe-editor" tabIndex={-1} onKeyDown={onKeyDown}>
      <EditorHeader title={t('kf.titleOf', { name: clip.name })} onClose={onClose}>
        <span className="timecode mr-1 text-2xs text-slate-300" data-testid="kf-time">
          {clock(currentFrame, fps)}
        </span>
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0"
          data-testid="kf-previous"
          aria-label={t('kf.previous')}
          onClick={() => {
            const frame = neighbourKeyframe(rows, currentFrame, -1);
            if (frame !== null) seek(frame);
          }}
          {...tip(t('kf.previous'), { named: false })}
        >
          <ChevronLeft size={13} />
        </button>
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0"
          data-testid="kf-toggle"
          aria-label={t('kf.toggle')}
          disabled={!graphRow}
          onClick={() => graphRow && update(toggleKeyframeAt(clip, graphRow.id, currentFrame))}
          {...tip(t('kf.toggle'), { hint: graphRow ? t(graphRow.label) : undefined, named: false })}
        >
          <Diamond size={12} />
        </button>
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0"
          data-testid="kf-next"
          aria-label={t('kf.next')}
          onClick={() => {
            const frame = neighbourKeyframe(rows, currentFrame, 1);
            if (frame !== null) seek(frame);
          }}
          {...tip(t('kf.next'), { named: false })}
        >
          <ChevronRight size={13} />
        </button>
        <span aria-hidden className="mx-1 h-4 w-px bg-panel-700" />
        <div role="radiogroup" aria-label={t('kf.view')} className="toolbar-group flex">
          <button type="button" role="radio" aria-checked={mode === 'sheet'} data-testid="kf-mode-sheet" className={`tool-button tool-button-dense gap-1 px-1.5 text-2xs ${mode === 'sheet' ? 'tool-button-active' : ''}`} onClick={() => setMode('sheet')}>
            <Rows3 size={12} aria-hidden />
            {t('kf.sheet')}
          </button>
          <button type="button" role="radio" aria-checked={mode === 'curves'} data-testid="kf-mode-curves" className={`tool-button tool-button-dense gap-1 px-1.5 text-2xs ${mode === 'curves' ? 'tool-button-active' : ''}`} onClick={() => setMode('curves')}>
            <LineChart size={12} aria-hidden />
            {t('kf.curves')}
          </button>
        </div>
      </EditorHeader>

      <div className="flex min-h-0 flex-1 overflow-auto">
        {/* The properties, a row each: stopwatch, name, value now, the playhead's diamond. */}
        <div className="w-[220px] shrink-0 border-r border-[color:var(--hairline)]" style={{ paddingTop: RULER_HEIGHT }} data-testid="kf-rows">
          {rows.map((row) => {
            const animated = row.keyframes.length > 1;
            const keyed = row.keyframes.some((key) => key.frame === currentFrame);
            return (
              <div key={row.id}>
                <div
                  data-testid={`kf-row-${row.id}`}
                  aria-selected={graphRow?.id === row.id}
                  className={`flex cursor-default items-center gap-1 px-1.5 text-xs ${graphRow?.id === row.id ? 'bg-accent/10 text-white' : 'text-slate-200'}`}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => setSelectedRow(row.id)}
                >
                  <button
                    type="button"
                    data-testid={`kf-stopwatch-${row.id}`}
                    aria-pressed={animated}
                    className={`tool-button tool-button-dense h-5 w-5 shrink-0 px-0 ${animated ? 'text-accent-hover' : 'text-slate-500'}`}
                    aria-label={t(animated ? 'kf.stopAnimating' : 'kf.animate')}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (animated) update(removeKeyframes(clip, row.keyframes.map((key) => ({ row: row.id, id: key.id })), currentFrame));
                      else update(toggleKeyframeAt(clip, row.id, currentFrame));
                    }}
                    {...tip(t(animated ? 'kf.stopAnimating' : 'kf.animate'), { named: false })}
                  >
                    <Timer size={12} />
                  </button>
                  <span className="min-w-0 flex-1 truncate" {...tip(row.groupLabel ? `${t(row.groupLabel)} · ${t(row.label)}` : t(row.label), { named: false })}>
                    {row.groupLabel ? <span className="text-slate-500">{t(row.groupLabel)} · </span> : null}
                    {t(row.label)}
                  </span>
                  <span className="timecode shrink-0 text-2xs text-slate-400" data-testid={`kf-value-${row.id}`}>
                    {formatValue(row, currentFrame)}
                  </span>
                  <button
                    type="button"
                    data-testid={`kf-diamond-${row.id}`}
                    aria-pressed={keyed}
                    className="tool-button tool-button-dense h-5 w-5 shrink-0 px-0"
                    aria-label={t(keyed ? 'kf.removeHere' : 'kf.addHere')}
                    onClick={(event) => {
                      event.stopPropagation();
                      update(toggleKeyframeAt(clip, row.id, currentFrame));
                    }}
                    {...tip(t(keyed ? 'kf.removeHere' : 'kf.addHere'), { named: false })}
                  >
                    <Diamond size={10} className={keyed ? 'fill-current text-accent-hover' : animated ? 'text-accent-hover' : 'text-slate-500'} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Time: the clip's span, the playhead, and the keyframes - as diamonds or as curves. */}
        <div ref={areaRef} className="relative min-w-0 flex-1" data-testid="kf-area">
          {width > 0 && mode === 'sheet' && (
            <svg
              width={width}
              height={height}
              className="block select-none"
              data-testid="kf-sheet"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const box = event.currentTarget.getBoundingClientRect();
                const y = event.clientY - box.top;
                startDrag(event.currentTarget, event, y < RULER_HEIGHT ? 'ruler' : 'box');
              }}
            >
              <Ruler width={width} first={first} last={last} step={tick} fps={fps} xOf={xOf} />
              {rows.map((row, index) => {
                const y = RULER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
                return (
                  <g key={row.id}>
                    <rect x={0} y={y - ROW_HEIGHT / 2} width={width} height={ROW_HEIGHT} fill={index % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent'} />
                    {/* The stretches between keyframes, faint: where the row moves. */}
                    {row.keyframes.slice(1).map((key, i) => (
                      <line key={key.id} x1={xOf(row.keyframes[i].frame)} x2={xOf(key.frame)} y1={y} y2={y} stroke="rgba(34,211,238,0.35)" strokeWidth={2} />
                    ))}
                    {row.keyframes.map((key) => (
                      <g
                        key={key.id}
                        data-testid={`kf-key-${row.id}-${key.frame}`}
                        data-picked={isPicked(row.id, key.id)}
                        className="cursor-ew-resize"
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.stopPropagation();
                          const pick = { row: row.id, id: key.id };
                          const already = isPicked(row.id, key.id);
                          const next = event.shiftKey ? (already ? picked.filter((p) => !(p.row === row.id && p.id === key.id)) : [...picked, pick]) : already ? picked : [pick];
                          setPicked(next);
                          setSelectedRow(row.id);
                          const svg = (event.currentTarget as SVGGElement).ownerSVGElement;
                          if (svg && next.some((p) => p.row === row.id && p.id === key.id)) startDrag(svg, event, 'keyframes', { picks: next });
                        }}
                        onContextMenu={(event) => {
                          const picks = isPicked(row.id, key.id) ? picked : [{ row: row.id, id: key.id }];
                          setPicked(picks);
                          easingMenu(event, picks);
                        }}
                        onDoubleClick={(event) => easingMenu(event, isPicked(row.id, key.id) ? picked : [{ row: row.id, id: key.id }])}
                      >
                        <title>{`${clock(key.frame, fps)} · ${t(EASINGS.find((entry) => entry.id === key.easing)?.label ?? 'kf.easing.linear')}`}</title>
                        <rect x={xOf(key.frame) - 8} y={y - 9} width={16} height={18} fill="transparent" />
                        <Glyph x={xOf(key.frame)} y={y} easing={key.easing} picked={isPicked(row.id, key.id)} />
                      </g>
                    ))}
                  </g>
                );
              })}
              {playheadX !== null && <Playhead x={playheadX} height={height} />}
              {marquee && <rect x={marquee.x0} y={marquee.y0} width={marquee.x1 - marquee.x0} height={marquee.y1 - marquee.y0} fill="rgba(34,211,238,0.12)" stroke="rgba(34,211,238,0.8)" strokeDasharray="3 2" />}
            </svg>
          )}
          {width > 0 && mode === 'curves' && graphRow && (
            <CurveGraph
              row={graphRow}
              width={width}
              first={first}
              last={last}
              fps={fps}
              tick={tick}
              xOf={xOf}
              frameAt={frameAt}
              playheadX={playheadX}
              height={Math.max(220, areaHeight)}
              picked={picked}
              onPick={(next) => setPicked(next)}
              onSeek={seek}
              clip={clip}
            />
          )}
        </div>
      </div>

      {/* The move out of the picked keyframes. */}
      <EasingBar
        disabled={picked.length === 0}
        current={firstPicked?.easing}
        curve={firstPicked ? curveOf(firstPicked.easing, firstPicked.bezierParams) : null}
        count={picked.length}
        onEasing={(easing) => update(setEasing(clip, picked, easing))}
        onCurve={(curve, mergeKey) => update(setEasing(clip, picked, 'bezier', curve), mergeKey)}
      />
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </section>
  );
}

/** The window's header: its title, whatever controls are passed, and the close button. */
function EditorHeader({ title, onClose, children }: { title: string; onClose?(): void; children?: React.ReactNode }): JSX.Element {
  const t = useT();
  return (
    <header className="panel-header gap-1">
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <div className="flex shrink-0 items-center gap-0.5 font-normal">
        {children}
        {onClose && (
          <button type="button" className="tool-button tool-button-dense ml-1 w-6 px-0" data-testid="kf-close" aria-label={t('kf.close')} onClick={onClose}>
            <X size={13} />
          </button>
        )}
      </div>
    </header>
  );
}

/** How far apart the ruler's marks are: a round number of frames or seconds at least 64 px apart. */
function rulerStep(frames: number, width: number, fps: number): number {
  const perPixel = frames / Math.max(1, width);
  const minimum = perPixel * 64;
  const rate = Math.max(1, Math.round(fps));
  const candidates = [1, 2, 5, 10, rate / 2, rate, rate * 2, rate * 5, rate * 10, rate * 30, rate * 60, rate * 300].filter((step) => step >= 1).sort((a, b) => a - b);
  return candidates.find((step) => step >= minimum) ?? candidates[candidates.length - 1];
}

function Ruler({ width, first, last, step, fps, xOf }: { width: number; first: number; last: number; step: number; fps: number; xOf(frame: number): number }): JSX.Element {
  const marks: number[] = [];
  for (let frame = Math.ceil(first / step) * step; frame <= last; frame += step) marks.push(frame);
  return (
    <g data-testid="kf-ruler">
      <rect x={0} y={0} width={width} height={RULER_HEIGHT} fill="rgba(255,255,255,0.03)" className="cursor-pointer" />
      {marks.map((frame) => (
        <g key={frame}>
          <line x1={xOf(frame)} x2={xOf(frame)} y1={RULER_HEIGHT - 6} y2={RULER_HEIGHT} stroke="rgba(148,163,184,0.6)" />
          <text x={xOf(frame) + 3} y={12} fontSize={10} fill="rgba(148,163,184,0.9)" className="pointer-events-none">
            {clock(frame, fps)}
          </text>
        </g>
      ))}
    </g>
  );
}

function Playhead({ x, height }: { x: number; height: number }): JSX.Element {
  return (
    <g className="pointer-events-none" data-testid="kf-playhead">
      <line x1={x} x2={x} y1={0} y2={height} stroke="#ffffff" strokeWidth={1.5} />
      <path d={`M ${x - 5} 0 L ${x + 5} 0 L ${x + 5} 6 L ${x} 11 L ${x - 5} 6 Z`} fill="#ffffff" />
    </g>
  );
}

/** A row's value at a frame, as the inspector writes it. */
function formatValue(row: Row, frame: number): string {
  const values = row.channels.map((channel) => channel.at(frame));
  switch (row.id) {
    case 'transform:position':
      return `${Math.round(values[0])}, ${Math.round(values[1])}`;
    case 'transform:scale':
      return values[0] === values[1] ? `${Math.round(values[0] * 100)}%` : `${Math.round(values[0] * 100)}×${Math.round(values[1] * 100)}%`;
    case 'transform:rotation':
      return `${Math.round(values[0])}°`;
    case 'transform:opacity':
      return `${Math.round(values[0] * 100)}%`;
    default:
      return Number(values[0].toFixed(2)).toString();
  }
}

const TONE: Record<'x' | 'y' | 'value', string> = { x: '#f87171', y: '#4ade80', value: 'rgb(34,211,238)' };

/**
 * The values of a row as curves over the clip's span, sampled through the
 * same evaluator the viewer uses, with its keyframes on them: drag one up or
 * down for its value, sideways for its time.
 */
function CurveGraph({
  row,
  width,
  first,
  last,
  fps,
  tick,
  xOf,
  frameAt,
  playheadX,
  height,
  picked,
  onPick,
  onSeek,
  clip,
}: {
  row: Row;
  width: number;
  first: number;
  last: number;
  fps: number;
  tick: number;
  xOf(frame: number): number;
  frameAt(x: number): number;
  playheadX: number | null;
  /** As tall as the time area: the curves have the window's room. */
  height: number;
  picked: Picked[];
  onPick(next: Picked[]): void;
  onSeek(frame: number): void;
  clip: Clip;
}): JSX.Element {
  const top = RULER_HEIGHT + 10;
  const bottom = height - 12;
  const samples = useMemo(() => {
    const step = Math.max(1, (last - first + 1) / Math.max(1, width / 2));
    const frames: number[] = [];
    for (let frame = first; frame <= last; frame += step) frames.push(frame);
    frames.push(last);
    return frames;
  }, [first, last, width]);
  const series = row.channels.map((channel) => ({ channel, points: samples.map((frame) => ({ frame, value: channel.at(frame) })) }));
  const values = series.flatMap((entry) => entry.points.map((point) => point.value));
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (row.channels[0]?.range && low >= row.channels[0].range[0] && high <= row.channels[0].range[1] && row.channels[0].range[1] - row.channels[0].range[0] <= Math.max(1e-6, (high - low) * 4)) {
    [low, high] = row.channels[0].range;
  }
  if (high - low < 1e-6) {
    low -= 1;
    high += 1;
  }
  const pad = (high - low) * 0.08;
  low -= pad;
  high += pad;
  const yOf = (value: number): number => bottom - ((value - low) / (high - low)) * (bottom - top);
  const valueAt = (y: number): number => low + ((bottom - y) / (bottom - top)) * (high - low);

  const drag = (event: React.PointerEvent, keyId: string, channel: 'x' | 'y' | 'value'): void => {
    event.stopPropagation();
    const svg = (event.currentTarget as SVGElement).ownerSVGElement;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const view = svg.ownerDocument.defaultView ?? window;
    const base = clip;
    const mergeKey = `keyframes:${createId('drag')}`;
    const startFrame = frameAt(event.clientX - box.left);
    const startY = event.clientY - box.top;
    onPick([{ row: row.id, id: keyId }]);
    // The keyframe's value as the drag began, on the channel grabbed. The row
    // handed in was built from this same clip, so it IS that row.
    const startRow = row;
    const startKey = startRow?.keyframes.find((candidate) => candidate.id === keyId);
    const from = startKey ? (startRow?.channels.find((candidate) => candidate.id === channel)?.at(startKey.frame) ?? 0) : 0;
    const move = (moveEvent: PointerEvent): void => {
      if (!startKey) return;
      const dy = moveEvent.clientY - box.top - startY;
      // Shift held: up and down only, the time kept.
      const dx = moveEvent.shiftKey ? 0 : frameAt(moveEvent.clientX - box.left) - startFrame;
      const moved = retime(base, [{ row: row.id, id: keyId }], dx);
      const valued = setKeyframeValue({ ...base, ...moved }, row.id, keyId, channel, valueAt(yOf(from) + dy));
      useProjectStore.getState().updateClip(base.id, { ...moved, ...valued }, mergeKey);
    };
    const up = (): void => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', up);
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', up);
  };

  return (
    <svg
      width={width}
      height={height}
      className="block select-none"
      data-testid="kf-curves"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const box = event.currentTarget.getBoundingClientRect();
        onSeek(frameAt(event.clientX - box.left));
        onPick([]);
      }}
    >
      <Ruler width={width} first={first} last={last} step={tick} fps={fps} xOf={xOf} />
      {[0.25, 0.5, 0.75].map((share) => (
        <line key={share} x1={0} x2={width} y1={top + (bottom - top) * share} y2={top + (bottom - top) * share} stroke="rgba(148,163,184,0.12)" />
      ))}
      {series.map(({ channel, points }) => (
        <polyline
          key={channel.id}
          data-testid={`kf-curve-${channel.id}`}
          points={points.map((point) => `${xOf(point.frame).toFixed(1)},${yOf(point.value).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={TONE[channel.tone]}
          strokeWidth={1.75}
        />
      ))}
      {series.map(({ channel }) =>
        row.keyframes.map((key) => {
          const isOn = picked.some((pick) => pick.row === row.id && pick.id === key.id);
          return (
            <circle
              key={`${channel.id}-${key.id}`}
              data-testid={`kf-point-${channel.id}-${key.frame}`}
              cx={xOf(key.frame)}
              cy={yOf(channel.at(key.frame))}
              r={isOn ? 5.5 : 4.5}
              fill={isOn ? '#ffffff' : TONE[channel.tone]}
              stroke="rgba(0,0,0,0.6)"
              className="cursor-move"
              onPointerDown={(event) => drag(event, key.id, channel.id)}
            />
          );
        }),
      )}
      {playheadX !== null && <Playhead x={playheadX} height={height} />}
      <text x={6} y={height - 3} fontSize={10} fill="rgba(148,163,184,0.8)" className="pointer-events-none">
        {Number(low.toFixed(2))} … {Number(high.toFixed(2))}
      </text>
    </svg>
  );
}

/**
 * The picked keyframes' move: the shapes as chips, and the curve of the
 * move with its two handles, as CSS cubic-bezier editors draw it (time
 * across, the share of the way up): a handle dragged makes it a curve of
 * one's own.
 */
function EasingBar({
  disabled,
  current,
  curve,
  count,
  onEasing,
  onCurve,
}: {
  disabled: boolean;
  current: Easing | undefined;
  curve: { cp1: { x: number; y: number }; cp2: { x: number; y: number } } | null;
  count: number;
  onEasing(easing: Easing): void;
  onCurve(curve: { cp1: { x: number; y: number }; cp2: { x: number; y: number } }, mergeKey: string): void;
}): JSX.Element {
  const t = useT();
  const size = 76;
  const inset = 8;
  const box = size - inset * 2;
  // The box shows 0-1 in time and -0.25-1.25 in progress, so an overshoot is seen.
  const px = (x: number): number => inset + x * box;
  const py = (y: number): number => inset + (1 - (y + 0.25) / 1.5) * box;
  const path = current
    ? Array.from({ length: 41 }, (_, i) => {
        const tx = i / 40;
        return `${px(tx).toFixed(1)},${py(easeProgress(tx, current, curve ?? undefined)).toFixed(1)}`;
      }).join(' ')
    : '';
  const dragHandle = (event: React.PointerEvent<SVGCircleElement>, which: 'cp1' | 'cp2'): void => {
    if (!curve) return;
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const view = svg.ownerDocument.defaultView ?? window;
    const mergeKey = `keyframes:${createId('curve')}`;
    const start = curve;
    const move = (moveEvent: PointerEvent): void => {
      const x = Math.min(1, Math.max(0, (moveEvent.clientX - rect.left - inset) / box));
      const y = (1 - (moveEvent.clientY - rect.top - inset) / box) * 1.5 - 0.25;
      onCurve({ ...start, [which]: { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) } }, mergeKey);
    };
    const up = (): void => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', up);
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', up);
  };
  return (
    <footer className={`flex shrink-0 items-center gap-2 border-t border-[color:var(--hairline)] px-2 py-1.5 ${disabled ? 'opacity-50' : ''}`} data-testid="kf-easing">
      <svg width={size} height={size} className="shrink-0 rounded bg-panel-950" aria-label={t('kf.easingCurve')} data-testid="kf-easing-curve">
        <rect x={px(0)} y={py(1)} width={box} height={py(0) - py(1)} fill="none" stroke="rgba(148,163,184,0.25)" />
        {path && <polyline points={path} fill="none" stroke="rgb(34,211,238)" strokeWidth={2} />}
        {curve && !disabled && (
          <>
            <line x1={px(0)} y1={py(0)} x2={px(curve.cp1.x)} y2={py(curve.cp1.y)} stroke="rgba(255,255,255,0.5)" />
            <line x1={px(1)} y1={py(1)} x2={px(curve.cp2.x)} y2={py(curve.cp2.y)} stroke="rgba(255,255,255,0.5)" />
            <circle data-testid="kf-handle-cp1" cx={px(curve.cp1.x)} cy={py(curve.cp1.y)} r={4.5} fill="#ffffff" className="cursor-move" onPointerDown={(event) => dragHandle(event, 'cp1')} />
            <circle data-testid="kf-handle-cp2" cx={px(curve.cp2.x)} cy={py(curve.cp2.y)} r={4.5} fill="#ffffff" className="cursor-move" onPointerDown={(event) => dragHandle(event, 'cp2')} />
          </>
        )}
      </svg>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-2xs text-slate-400">{disabled ? t('kf.pickHint') : t(count === 1 ? 'kf.pickedOne' : 'kf.pickedMany', { count })}</p>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('kf.easing')}>
          {EASINGS.filter((entry) => entry.id !== 'bezier').map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={current === entry.id}
              disabled={disabled}
              data-testid={`kf-easing-${entry.id}`}
              className={`tool-button tool-button-dense h-6 border px-1.5 text-2xs ${current === entry.id ? 'tool-button-active border-accent' : 'border-panel-700'}`}
              onClick={() => onEasing(entry.id)}
            >
              {t(entry.label)}
            </button>
          ))}
          {current === 'bezier' && <span className="self-center text-2xs text-accent-hover">{t('kf.easing.bezier')}</span>}
        </div>
      </div>
    </footer>
  );
}
