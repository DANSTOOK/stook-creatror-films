import { useRef } from 'react';
import { Link2 } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { usePresence } from '@renderer/hooks/usePresence';
import { useT } from '@renderer/i18n';
import { useRelinkPrompt } from '@renderer/media/relink';

/**
 * "Relink the others too?" - after one missing file has been found, the
 * others that are in the same folder, by name.
 *
 * Relinking them all is the default (Enter), as Premiere's "Relink others
 * automatically" is ticked by default; "Only this one" relinks the file that
 * was chosen and leaves the rest missing, and so does Escape.
 */
export function RelinkDialog(): JSX.Element | null {
  const t = useT();
  const prompt = useRelinkPrompt((state) => state.prompt);
  const answer = useRelinkPrompt((state) => state.answer);
  const presence = usePresence(Boolean(prompt));
  const last = useRef<{ folder: string; names: string[] }>({ folder: '', names: [] });
  if (prompt) last.current = prompt;

  if (!presence.mounted) return null;
  const { folder, names } = last.current;

  return (
    <Dialog
      title={t('relink.title')}
      icon={Link2}
      testId="relink-dialog"
      onClose={() => {
        if (useRelinkPrompt.getState().prompt) answer('one');
      }}
      closing={presence.closing}
      widthClass="w-[460px]"
      footer={
        <>
          <button type="button" className="tool-button" disabled={!prompt} onClick={() => answer('one')}>
            {t('relink.onlyThis')}
          </button>
          <button type="button" data-autofocus className="button-primary" disabled={!prompt} onClick={() => answer('all')}>
            {t('relink.all', { count: names.length })}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-slate-300">
        {t('relink.body', { count: names.length, folder })}
      </p>
      <ul className="mt-2 max-h-40 overflow-y-auto rounded-control border border-panel-700 bg-panel-950 px-3 py-2 text-xs text-slate-200">
        {names.map((name) => (
          <li key={name} className="truncate py-0.5">
            {name}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export default RelinkDialog;
