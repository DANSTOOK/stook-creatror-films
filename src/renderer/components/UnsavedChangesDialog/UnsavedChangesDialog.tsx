import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { usePresence } from '@renderer/hooks/usePresence';
import { useSessionStore } from '@renderer/store/useSessionStore';

/**
 * "Save changes to ...?" before a project on screen is replaced.
 *
 * Save is the default and answers Enter; Escape cancels. The name is kept
 * through the exit animation, after the question itself is gone.
 */
export function UnsavedChangesDialog(): JSX.Element | null {
  const prompt = useSessionStore((state) => state.unsavedPrompt);
  const answer = useSessionStore((state) => state.answerPrompt);
  const presence = usePresence(Boolean(prompt));
  const lastName = useRef('this project');
  if (prompt) lastName.current = prompt.name;

  useEffect(() => {
    if (!prompt) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        answer('cancel');
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [prompt, answer]);

  if (!presence.mounted) return null;

  return (
    <div data-closing={presence.closing} className="scf-overlay fixed inset-0 z-[90] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        data-closing={presence.closing}
        className="scf-dialog panel w-[420px] shadow-2xl shadow-black/60"
      >
        <div className="flex gap-3 p-5">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <h2 id="unsaved-title" className="text-sm font-medium text-slate-100">
              Save changes to &ldquo;{lastName.current}&rdquo;?
            </h2>
            <p className="text-xs leading-relaxed text-slate-400">Your changes will be lost if you don&apos;t save them.</p>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-panel-700 px-4 py-3">
          <button type="button" className="tool-button mr-auto" disabled={!prompt} onClick={() => answer('discard')}>
            Don&apos;t save
          </button>
          <button type="button" className="tool-button" disabled={!prompt} onClick={() => answer('cancel')}>
            Cancel
          </button>
          <button
            type="button"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="tool-button tool-button-active px-4"
            disabled={!prompt}
            onClick={() => answer('save')}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

export default UnsavedChangesDialog;
