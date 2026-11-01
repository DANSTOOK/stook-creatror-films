import { useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Numbered steps, for a panel where the order matters.
 *
 * Both the voice panel and the animation panel had the same fault: everything
 * on screen at once, all of it the same weight, so there was no telling what
 * to do first. A number, a title, and a line saying what this step is for
 * answers that without a tutorial.
 *
 * A step that is done says so with a tick and a short summary of what was
 * chosen, so the panel reads back as a sentence once it is filled in - and a
 * done step folds away, which is what keeps the panel short.
 */

export interface StepProps {
  /** 1, 2, 3 - shown in the circle. */
  number: number;
  title: string;
  /** One line saying what this step is for. Shown while the step is open. */
  hint?: string;
  /** What was chosen, shown when the step is folded: "Carmen, español". */
  summary?: string;
  /** A step is done when what it asks for has been given. */
  done?: boolean;
  /**
   * Open regardless. Left out, a step opens when it is not done and folds
   * when it is - which walks the eye down the panel on its own.
   */
  open?: boolean;
  /** Steps that cannot be used yet are dimmed and cannot be unfolded. */
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}

export function Step({ number, title, hint, summary, done = false, open, disabled = false, testId, children }: StepProps): JSX.Element {
  // Opened by hand beats the automatic rule, so a done step can be gone back to.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const shown = disabled ? false : (toggled ?? open ?? !done);

  return (
    <section
      data-testid={testId}
      data-step={number}
      data-done={done ? 'true' : 'false'}
      data-open={shown ? 'true' : 'false'}
      className={`rounded-lg ring-1 transition-colors ${disabled ? 'opacity-45 ring-panel-800' : shown ? 'bg-panel-900/60 ring-panel-700' : 'ring-panel-800'}`}
    >
      <button
        type="button"
        data-testid={testId ? `${testId}-header` : undefined}
        disabled={disabled}
        aria-expanded={shown}
        onClick={() => setToggled(!shown)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ring-1 ${
            done ? 'bg-accent text-accent-contrast ring-accent' : 'bg-panel-800 text-slate-300 ring-panel-600'
          }`}
        >
          {done ? <Check size={11} strokeWidth={3} /> : number}
        </span>
        <span className="min-w-0 flex-1">
          {/* Wraps rather than truncates: the panel can be narrow, and half a
              step's name is no use at all. */}
          <span className="block text-xs leading-snug text-slate-100">{title}</span>
          {/* The summary when folded, the hint when open: one line either way, so the panel does not jump. */}
          {!shown && summary ? (
            <span className="block truncate text-2xs text-slate-400">{summary}</span>
          ) : shown && hint ? (
            <span className="block text-2xs leading-snug text-slate-400">{hint}</span>
          ) : null}
        </span>
        {!disabled && <ChevronDown size={13} aria-hidden className={`shrink-0 text-slate-500 transition-transform ${shown ? '' : '-rotate-90'}`} />}
      </button>
      {shown && <div className="space-y-2 px-2 pb-2">{children}</div>}
    </section>
  );
}

/** The steps of one panel, spaced as a list. */
export function Steps({ children }: { children: ReactNode }): JSX.Element {
  return <div className="space-y-1.5">{children}</div>;
}
