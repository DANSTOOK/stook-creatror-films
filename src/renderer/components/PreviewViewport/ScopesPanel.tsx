import { useCallback, useEffect, useRef, useState } from 'react';
import { Rows2, Square } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { SCOPE_KINDS, type ScopeData, type ScopeKind } from '@renderer/scopes/scopeMath';
import { latestScopeCapture, noteScopeDraw, noteScopePost, subscribeScopes } from '@renderer/scopes/scopeFeed';
import type { ScopeWorkerMessage, ScopeWorkerReply } from '@renderer/scopes/scopeWorker';
import ScopeWorker from '@renderer/scopes/scopeWorker?worker&inline';
import type { ScopeCapture } from '@renderer/engine/Compositor';

/**
 * The video scopes, beside the picture.
 *
 * Final Cut shows its scopes in the viewer, next to the image, with one or
 * more at a time and a menu on each to pick which; Resolve and Premiere have
 * the same four: waveform, RGB parade, vectorscope, histogram. This is that,
 * at the size of a panel: one scope, or two stacked, each with its own menu.
 *
 * What is measured is the finished frame, all tracks composited, exactly as
 * it will be exported (the compositor's output, read back small - see
 * scopeFeed.ts for when). The measuring and drawing happen in a worker, on
 * canvases handed to it (scopeWorker.ts), so the page's thread - the one
 * that draws the picture - only passes the frame along. While this panel is
 * not mounted nothing is measured at all, and the worker sits idle.
 */

const SETTINGS_KEY = 'scf.scopes';

interface ScopeSettings {
  count: 1 | 2;
  kinds: [ScopeKind, ScopeKind];
}

const DEFAULT_SETTINGS: ScopeSettings = { count: 1, kinds: ['waveform', 'vectorscope'] };

function readSettings(): ScopeSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<ScopeSettings> | null;
    if (!stored) return DEFAULT_SETTINGS;
    const valid = (kind: unknown): kind is ScopeKind => SCOPE_KINDS.includes(kind as ScopeKind);
    return {
      count: stored.count === 2 ? 2 : 1,
      kinds: [
        valid(stored.kinds?.[0]) ? stored.kinds[0] : DEFAULT_SETTINGS.kinds[0],
        valid(stored.kinds?.[1]) ? stored.kinds[1] : DEFAULT_SETTINGS.kinds[1],
      ],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const KIND_LABEL: Record<ScopeKind, 'scopes.waveform' | 'scopes.parade' | 'scopes.vectorscope' | 'scopes.histogram'> = {
  waveform: 'scopes.waveform',
  parade: 'scopes.parade',
  vectorscope: 'scopes.vectorscope',
  histogram: 'scopes.histogram',
};

/**
 * One worker for the session, started the first time the scopes open.
 *
 * Kept rather than ended when they close: a canvas handed to a worker
 * belongs to it for good, and React mounts, unmounts and mounts again in
 * development, which would leave a canvas stranded in a worker that was
 * ended. An idle worker costs nothing - no message, no work.
 */
let sharedWorker: Worker | null = null;
const scopeWorker = (): Worker => (sharedWorker ??= new ScopeWorker());

/*
  A canvas can be handed over only once, so each element gets an id the
  worker knows it by. When an element goes, its canvas is released a moment
  later - unless it comes straight back, which is what React's development
  mode does to every component on mount.
*/
const canvasIds = new WeakMap<HTMLCanvasElement, number>();
let nextCanvasId = 1;
const releases = new Map<number, number>();
const RELEASE_DELAY_MS = 1000;

/** Test hook: set before opening the scopes to have what they draw echoed back. */
const debugWanted = (): boolean => (window as { __scfScopeDebug?: boolean }).__scfScopeDebug === true;

export function ScopesPanel(): JSX.Element {
  const t = useT();
  const [settings, setSettingsState] = useState<ScopeSettings>(readSettings);
  const setSettings = (next: ScopeSettings): void => {
    setSettingsState(next);
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Kept for this session only.
    }
  };

  /** The frame the worker is busy with, and the newest one waiting behind it. */
  const busy = useRef(false);
  const waiting = useRef<ScopeCapture | null>(null);

  const post = useCallback((message: ScopeWorkerMessage, transfer: Transferable[] = []) => {
    scopeWorker().postMessage(message, transfer);
  }, []);

  const sendFrame = useCallback(
    (capture: ScopeCapture) => {
      if (busy.current) {
        waiting.current = capture;
        return;
      }
      busy.current = true;
      const started = performance.now();
      // A copy travels; the page keeps the reading for a later redraw.
      post({ type: 'frame', rgba: capture.rgba, width: capture.width, height: capture.height });
      noteScopePost(performance.now() - started);
    },
    [post],
  );

  // Listen to the worker, and feed it, while the panel is open.
  useEffect(() => {
    const worker = scopeWorker();
    worker.onmessage = (event: MessageEvent<ScopeWorkerReply>) => {
      const reply = event.data;
      if (reply.type !== 'drawn') return;
      noteScopeDraw(reply.ms);
      if (reply.data) (window as { __scfScopeData?: ScopeData }).__scfScopeData = reply.data;
      busy.current = false;
      const next = waiting.current;
      waiting.current = null;
      if (next) sendFrame(next);
    };
    const unsubscribe = subscribeScopes(sendFrame);
    return () => {
      unsubscribe();
      worker.onmessage = null;
      worker.postMessage({ type: 'clear' } satisfies ScopeWorkerMessage);
      busy.current = false;
      waiting.current = null;
    };
  }, [sendFrame]);

  // What to draw, in which language, at which display scale.
  const skinLabel = t('scopes.skin');
  const shownKinds = settings.kinds.slice(0, settings.count);
  const shownKey = shownKinds.join(',');
  useEffect(() => {
    post({
      type: 'settings',
      kinds: shownKey.split(',') as ScopeKind[],
      scale: window.devicePixelRatio || 1,
      labels: { skin: skinLabel },
      debug: debugWanted(),
    });
  }, [shownKey, skinLabel, post]);

  /*
    Each canvas is handed to the worker once, as it mounts; from then on only
    the worker can size or draw it. Its box is watched here and the size sent
    over, in device pixels, so the traces stay sharp at any display scaling.
  */
  const observers = useRef(new Map<number, ResizeObserver>());
  const slotIds = useRef(new Map<number, number>());
  const attachCanvas = useCallback(
    (slot: number, element: HTMLCanvasElement | null) => {
      observers.current.get(slot)?.disconnect();
      observers.current.delete(slot);
      if (!element) {
        const id = slotIds.current.get(slot);
        slotIds.current.delete(slot);
        post({ type: 'assign', slot, id: null });
        if (id !== undefined) {
          releases.set(id, window.setTimeout(() => {
            releases.delete(id);
            post({ type: 'release', id });
          }, RELEASE_DELAY_MS));
        }
        return;
      }
      let id = canvasIds.get(element);
      if (id === undefined) {
        id = nextCanvasId;
        nextCanvasId += 1;
        canvasIds.set(element, id);
        const offscreen = element.transferControlToOffscreen();
        post({ type: 'canvas', id, canvas: offscreen }, [offscreen]);
      }
      window.clearTimeout(releases.get(id));
      releases.delete(id);
      slotIds.current.set(slot, id);
      post({ type: 'assign', slot, id });
      const observer = new ResizeObserver(() => {
        const scale = window.devicePixelRatio || 1;
        post({
          type: 'resize',
          slot,
          width: Math.round(element.clientWidth * scale),
          height: Math.round(element.clientHeight * scale),
        });
      });
      observer.observe(element);
      observers.current.set(slot, observer);
    },
    [post],
  );

  // A panel opened on a still picture shows it at once: the last reading.
  useEffect(() => {
    const latest = latestScopeCapture();
    if (latest) sendFrame(latest);
  }, [sendFrame]);

  return (
    <div data-testid="scopes-panel" data-count={settings.count} className="flex min-h-0 w-full flex-col gap-2 p-2">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="scopes-one"
          aria-pressed={settings.count === 1}
          className={`tool-button tool-button-dense w-6 px-0 ${settings.count === 1 ? 'tool-button-active' : ''}`}
          onClick={() => setSettings({ ...settings, count: 1 })}
          {...tip(t('scopes.one'))}
        >
          <Square size={13} />
        </button>
        <button
          type="button"
          data-testid="scopes-two"
          aria-pressed={settings.count === 2}
          className={`tool-button tool-button-dense w-6 px-0 ${settings.count === 2 ? 'tool-button-active' : ''}`}
          onClick={() => setSettings({ ...settings, count: 2 })}
          {...tip(t('scopes.two'))}
        >
          <Rows2 size={13} />
        </button>
      </div>
      {shownKinds.map((kind, slot) => (
        <figure key={slot} className="m-0 flex min-h-0 flex-1 flex-col gap-1">
          <label className="sr-only" htmlFor={`scope-kind-${slot}`}>
            {t('scopes.choose', { n: slot + 1 })}
          </label>
          <select
            id={`scope-kind-${slot}`}
            data-testid={`scope-kind-${slot}`}
            className="numeric-input h-control-dense w-full shrink-0 text-2xs"
            value={kind}
            onChange={(event) => {
              const kinds: [ScopeKind, ScopeKind] = [...settings.kinds];
              kinds[slot] = event.target.value as ScopeKind;
              setSettings({ ...settings, kinds });
            }}
          >
            {SCOPE_KINDS.map((option) => (
              <option key={option} value={option}>
                {t(KIND_LABEL[option])}
              </option>
            ))}
          </select>
          <SlotCanvas slot={slot} kind={kind} label={t(KIND_LABEL[kind])} attach={attachCanvas} />
        </figure>
      ))}
    </div>
  );
}

/** One scope's canvas, handed to the worker when it mounts. */
function SlotCanvas({
  slot,
  kind,
  label,
  attach,
}: {
  slot: number;
  kind: ScopeKind;
  label: string;
  attach: (slot: number, element: HTMLCanvasElement | null) => void;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    attach(slot, ref.current);
    return () => attach(slot, null);
  }, [slot, attach]);
  return (
    <canvas
      ref={ref}
      data-testid={`scope-${kind}`}
      role="img"
      aria-label={label}
      className="block min-h-0 w-full flex-1 rounded-control bg-panel-950"
    />
  );
}

export default ScopesPanel;
