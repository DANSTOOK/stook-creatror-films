import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT } from '@renderer/i18n';
import { useSessionStore } from '@renderer/store/useSessionStore';
import { notify } from '@renderer/notifications/notifications';
import { errorText } from '@renderer/errorText';

/**
 * The project's name in the middle of the title bar, as CapCut has it, and
 * renamed right there: a click makes it a field, Enter (or a click away)
 * keeps the new name, Escape keeps the old one. A project not saved yet just
 * takes the name - its file will be called that; a saved one is renamed on
 * disk, with its backups and its place on the start screen
 * (main: IPC.projectsRename).
 */
export function ProjectNameField({ active, path, dirty }: { active: boolean; path: string | null; dirty: boolean }): JSX.Element {
  const t = useT();
  const name = useSessionStore((state) => state.projectName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(name);
    window.setTimeout(() => inputRef.current?.select(), 0);
    // Only on entering the edit: the name is not to be reset while it is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = async (): Promise<void> => {
    setEditing(false);
    const wanted = draft.trim();
    if (!wanted || wanted === name) return;
    const session = useSessionStore.getState();
    if (!session.projectPath || !session.saved || !window.filmora?.projectsRename) {
      useSessionStore.setState({ projectName: wanted });
      return;
    }
    try {
      const renamed = await window.filmora.projectsRename(session.projectPath, wanted);
      session.markSaved(session.saved, renamed.path, renamed.name);
      notify(t('titlebar.renamed', { name: renamed.name }), 'success');
    } catch (error) {
      // The main process's words, without Electron's "Error invoking remote method…" in front.
      notify(errorText(error), 'error');
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-testid="project-name-input"
        aria-label={t('titlebar.rename')}
        className="app-no-drag h-7 w-[min(320px,32vw)] rounded-control border border-accent/70 bg-panel-900 px-2 text-center text-sm font-semibold text-slate-100 outline-none ring-2 ring-accent/25"
        value={draft}
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="press app-no-drag group flex h-7 min-w-0 max-w-[min(360px,34vw)] items-center gap-1.5 rounded-control px-2 transition-colors hover:bg-panel-800"
      title={path ?? t('toolbar.notSaved')}
      onClick={() => setEditing(true)}
      {...tip(t('titlebar.rename'), { hint: path ?? t('toolbar.notSaved'), named: false })}
    >
      <span data-testid="project-name" className={`truncate text-sm font-semibold transition-colors ${active ? 'text-slate-100' : 'text-slate-400'}`}>
        {name}
      </span>
      {dirty && (
        <span
          data-testid="unsaved-indicator"
          role="img"
          aria-label={t('toolbar.unsaved')}
          className="scf-dirty-dot h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
          title={t('toolbar.unsaved')}
        />
      )}
      <Pencil size={12} aria-hidden className="shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
