import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { create } from 'zustand';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useT, type MessageKey } from '@renderer/i18n';

/**
 * The welcome tour: the first time the editor opens, six stops round it -
 * the library, the viewer, the timeline, the inspector, the workspaces and
 * Export - each one lit up with the rest dimmed, a line on what it is for
 * and how to start. Skipped or finished, it does not come back on its own;
 * Help > Welcome tour shows it again. Not in automated runs (the bridge
 * says), unless a test asks for it.
 */

interface Stop {
  /** What is lit: the first of these that is on screen. */
  target: string;
  title: MessageKey;
  body: MessageKey;
}

const STOPS: readonly Stop[] = [
  { target: '[data-panel="media"]', title: 'tour.libraryTitle', body: 'tour.library' },
  { target: '[data-testid="preview-panel"]', title: 'tour.viewerTitle', body: 'tour.viewer' },
  { target: '[data-panel="timeline"]', title: 'tour.timelineTitle', body: 'tour.timeline' },
  { target: '[data-panel="inspector"]', title: 'tour.inspectorTitle', body: 'tour.inspector' },
  { target: '[data-testid="workspace-picker"]', title: 'tour.workspacesTitle', body: 'tour.workspaces' },
  { target: '[data-testid="titlebar-export"]', title: 'tour.exportTitle', body: 'tour.export' },
];

const DONE_KEY = 'scf.tourDone';

export const useTour = create<{ step: number | null; start(): void; finish(): void; go(step: number): void }>((set) => ({
  step: null,
  start: () => set({ step: 0 }),
  finish: () => {
    try {
      window.localStorage.setItem(DONE_KEY, '1');
    } catch {
      // Shown again next time, then.
    }
    set({ step: null });
  },
  go: (step) => set({ step }),
}));

/** Show the tour once, the first time the editor opens. */
export function useFirstTour(inEditor: boolean): void {
  useEffect(() => {
    if (!inEditor) return;
    let done = false;
    try {
      done = window.localStorage.getItem(DONE_KEY) === '1';
    } catch {
      done = false;
    }
    if (done || window.filmora?.automated) return;
    // A moment after the editor appears, so the panels are where they will be.
    const timer = setTimeout(() => useTour.getState().start(), 600);
    return () => clearTimeout(timer);
  }, [inEditor]);
}

const PAD = 6;

export function WelcomeTour(): JSX.Element | null {
  const t = useT();
  const step = useTour((state) => state.step);
  const { finish, go } = useTour.getState();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  const stop = step === null ? null : STOPS[step];
  const measure = useCallback(() => {
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    const element = stop ? (document.querySelector(stop.target) as HTMLElement | null) : null;
    setRect(element && element.offsetParent !== null ? element.getBoundingClientRect() : null);
  }, [stop]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    if (step === null) return undefined;
    window.addEventListener('resize', measure);
    const timer = setInterval(measure, 500);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish();
      else if (event.key === 'ArrowRight' || event.key === 'Enter') step < STOPS.length - 1 ? go(step + 1) : finish();
      else if (event.key === 'ArrowLeft' && step > 0) go(step - 1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(timer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [step, measure, finish, go]);

  if (step === null || !stop) return null;
  const last = step === STOPS.length - 1;
  // The card beside what is lit: under it when there is room, else above, else in the middle.
  const cardWidth = 320;
  const lit = rect ? { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 } : null;
  let left = viewport.width / 2 - cardWidth / 2;
  let top = viewport.height / 2 - 90;
  if (lit) {
    left = Math.min(viewport.width - cardWidth - 12, Math.max(12, lit.left + lit.width / 2 - cardWidth / 2));
    if (lit.top + lit.height + 200 < viewport.height) top = lit.top + lit.height + 10;
    else if (lit.top > 210) top = lit.top - 200;
    else {
      // A tall panel: beside it.
      top = Math.max(12, lit.top + 20);
      left = lit.left + lit.width + cardWidth + 24 < viewport.width ? lit.left + lit.width + 12 : Math.max(12, lit.left - cardWidth - 12);
    }
  }

  return (
    <div className="fixed inset-0 z-[80]" data-testid="welcome-tour" role="dialog" aria-modal="true" aria-labelledby="welcome-tour-title">
      {/* The dimming, with a hole where the stop is. */}
      {lit ? (
        <div
          aria-hidden
          data-testid="welcome-tour-spotlight"
          className="pointer-events-none absolute rounded-lg ring-2 ring-accent transition-all duration-300"
          style={{ ...lit, boxShadow: '0 0 0 9999px rgba(5, 7, 12, 0.62)' }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-[rgba(5,7,12,0.62)]" />
      )}
      <div
        className="scf-rise absolute rounded-xl bg-panel-800 p-4 shadow-2xl shadow-black/40 ring-1 ring-panel-600 transition-all duration-300"
        style={{ left, top, width: cardWidth }}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-2xs font-medium tabular-nums text-slate-400" data-testid="welcome-tour-count">
            {t('tour.count', { step: step + 1, count: STOPS.length })}
          </span>
          <button type="button" data-testid="welcome-tour-skip" className="tool-button tool-button-dense h-6 gap-1 px-1.5 text-2xs text-slate-400" onClick={finish}>
            <X size={12} aria-hidden />
            {t('tour.skip')}
          </button>
        </div>
        <h2 id="welcome-tour-title" className="text-sm font-semibold text-slate-100" data-testid="welcome-tour-title">
          {t(stop.title)}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-300">{t(stop.body)}</p>
        <div className="mt-3 flex items-center gap-1.5">
          <div className="flex flex-1 gap-1" aria-hidden>
            {STOPS.map((entry, index) => (
              <span key={entry.title} className={`h-1.5 rounded-full transition-all ${index === step ? 'w-4 bg-accent' : 'w-1.5 bg-panel-600'}`} />
            ))}
          </div>
          {step > 0 && (
            <button type="button" data-testid="welcome-tour-back" className="tool-button tool-button-dense h-7 gap-1 px-2 text-2xs" onClick={() => go(step - 1)}>
              <ArrowLeft size={12} aria-hidden />
              {t('tour.back')}
            </button>
          )}
          <button
            type="button"
            data-testid="welcome-tour-next"
            autoFocus
            className="button-primary h-7 gap-1 px-3 text-2xs"
            onClick={() => (last ? finish() : go(step + 1))}
          >
            {last ? t('tour.done') : t('tour.next')}
            {!last && <ArrowRight size={12} aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  );
}
