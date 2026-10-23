import { useEffect, useRef, useState } from 'react';
import { CircleDot, History, Redo2 } from 'lucide-react';
import { useLanguageStore, useT } from '@renderer/i18n';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useExitGhost } from '@renderer/motion/ghost';
import { historyLabel } from './historyLabels';

/**
 * History, from the title bar: every step that can be taken back, oldest
 * first, the one the project is at marked, and the steps undone after it
 * dimmed below - as Photoshop's and Premiere's History panels show it. A
 * click goes to that step: as many undos or redos as it takes, each one as
 * Ctrl+Z and Ctrl+Y would make it, so nothing is lost by jumping about.
 */

export function HistoryButton(): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canUndo = useHistoryStore((state) => state.canUndo || state.canRedo);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={`tool-button relative w-7 px-0 ${open ? 'tool-button-active' : ''}`}
        aria-label={t('history.title')}
        data-tooltip={t('history.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="history-button"
        disabled={!canUndo && !open}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={14} />
      </button>
      {open && <HistoryList />}
    </div>
  );
}

function HistoryList(): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const done = useHistoryStore((state) => state.undoStack);
  const undone = useHistoryStore((state) => state.redoStack);
  const ref = useExitGhost<HTMLDivElement>('menu');
  const listRef = useRef<HTMLUListElement>(null);

  // The step the project is at, in view.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
  }, [done.length]);

  /** Go to the state after `index` of the done steps (-1: before all of them). */
  const goToDone = (index: number): void => {
    for (let steps = done.length - 1 - index; steps > 0; steps -= 1) useProjectStore.getState().undo();
  };
  /** Redo up to and including `index` of the undone steps (0: the next one). */
  const goToUndone = (index: number): void => {
    for (let steps = 0; steps <= index; steps += 1) useProjectStore.getState().redo();
  };
  // The redo stack's next step is its last.
  const ahead = [...undone].reverse();

  const row = (key: string, label: string, state: 'done' | 'current' | 'undone', onClick: () => void, testId: string): JSX.Element => (
    <li key={key}>
      <button
        type="button"
        data-testid={testId}
        aria-current={state === 'current' ? 'step' : undefined}
        className={`flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-xs transition-colors ${
          state === 'current'
            ? 'bg-accent/20 font-medium text-slate-100'
            : state === 'undone'
              ? 'text-slate-500 hover:bg-panel-700 hover:text-slate-300'
              : 'text-slate-300 hover:bg-panel-700 hover:text-slate-100'
        }`}
        onClick={onClick}
      >
        {state === 'undone' ? <Redo2 size={11} aria-hidden className="shrink-0" /> : <CircleDot size={11} aria-hidden className={`shrink-0 ${state === 'current' ? 'text-accent-hover' : ''}`} />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    </li>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('history.title')}
      data-testid="history-panel"
      className="scf-menu absolute right-0 top-full z-[95] mt-1 w-[300px] origin-top-right rounded-menu border border-panel-600 bg-panel-800 p-1 shadow-2xl shadow-black/60"
    >
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-xs font-semibold text-slate-200">{t('history.title')}</span>
        <span className="text-2xs text-slate-400">{t('history.count', { count: done.length })}</span>
      </div>
      <ul ref={listRef} className="max-h-80 space-y-px overflow-y-auto">
        {row('start', t('history.start'), done.length === 0 ? 'current' : 'done', () => goToDone(-1), 'history-start')}
        {done.map((command, index) =>
          row(command.id, historyLabel(command.label, language), index === done.length - 1 ? 'current' : 'done', () => goToDone(index), `history-step-${index}`),
        )}
        {ahead.map((command, index) => row(command.id, historyLabel(command.label, language), 'undone', () => goToUndone(index), `history-undone-${index}`))}
      </ul>
      <p className="px-2 pb-1 pt-1.5 text-2xs leading-relaxed text-slate-400">{t('history.hint')}</p>
    </div>
  );
}
