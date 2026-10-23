import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { REMAPPABLE, clashes, comboOf, effectiveCombo, setCapturing, useRemapStore } from './remap';

/**
 * Choosing one's own keys (keys/remap.ts), in the keyboard list: each action
 * with the key it answers to now; Change, then press the key. A key another
 * action already answers to is said, and taken from it. Each can go back to
 * the editor's key, or all of them at once.
 */
export function CustomizeKeys(): JSX.Element {
  const t = useT();
  const custom = useRemapStore((state) => state.custom);
  const assign = useRemapStore((state) => state.assign);
  const reset = useRemapStore((state) => state.reset);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!choosing) return undefined;
    setCapturing(true);
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setChoosing(null);
        return;
      }
      const combo = comboOf(event);
      if (!combo) return;
      const taken = clashes(choosing, combo, custom);
      assign(choosing, combo);
      setWarning(taken.length > 0 ? { id: choosing, text: t('remap.taken', { names: taken.map((action) => t(action.label)).join(', ') }) } : null);
      setChoosing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setCapturing(false);
    };
  }, [choosing, custom, assign, t]);

  const changed = Object.keys(custom).length;
  return (
    <div className="space-y-2 p-4" data-testid="keys-customize">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs leading-relaxed text-slate-400">{t('remap.hint')}</p>
        <button type="button" data-testid="keys-reset-all" className="tool-button h-control shrink-0 border border-panel-600 text-2xs" disabled={changed === 0} onClick={() => reset()}>
          <RotateCcw size={12} />
          {t('remap.resetAll')}
        </button>
      </div>
      <ul className="space-y-0.5">
        {REMAPPABLE.map((action) => {
          const combo = effectiveCombo(action, custom);
          const own = custom[action.id] !== undefined;
          const listening = choosing === action.id;
          return (
            <li key={action.id} className="rounded-control px-1.5 py-1 hover:bg-panel-800">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{t(action.label)}</span>
                <button
                  type="button"
                  data-testid={`keys-change-${action.id}`}
                  aria-pressed={listening}
                  className={`min-w-[96px] rounded-control border px-2 py-0.5 text-center font-sans text-2xs ${
                    listening ? 'border-accent bg-accent/15 text-accent-hover' : own ? 'border-accent/50 bg-panel-950 text-slate-100' : 'border-panel-600 bg-panel-950 text-slate-200'
                  }`}
                  onClick={() => setChoosing(listening ? null : action.id)}
                >
                  {listening ? t('remap.pressKey') : combo === 'Space' ? t('keys.space') : combo}
                </button>
                <button
                  type="button"
                  className={`tool-button tool-button-dense w-6 px-0 ${own ? '' : 'invisible'}`}
                  aria-label={t('remap.reset')}
                  title={t('remap.resetTo', { key: action.combo })}
                  onClick={() => reset(action.id)}
                >
                  <RotateCcw size={11} />
                </button>
              </div>
              {warning?.id === action.id && <p className="pl-1 pt-0.5 text-2xs text-amber-300">{warning.text}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
