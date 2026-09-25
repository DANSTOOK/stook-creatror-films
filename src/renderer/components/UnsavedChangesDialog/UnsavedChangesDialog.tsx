import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { usePresence } from '@renderer/hooks/usePresence';
import { useT } from '@renderer/i18n';
import { useSessionStore } from '@renderer/store/useSessionStore';

/**
 * "Save changes to ...?" before a project on screen is replaced.
 *
 * Save is the default and answers Enter; Escape cancels. The name is kept
 * through the exit animation, after the question itself is gone. "Don't save"
 * stands apart on the left, as Windows and macOS put the answer that throws
 * work away.
 */
export function UnsavedChangesDialog(): JSX.Element | null {
  const t = useT();
  const prompt = useSessionStore((state) => state.unsavedPrompt);
  const answer = useSessionStore((state) => state.answerPrompt);
  const presence = usePresence(Boolean(prompt));
  const lastName = useRef('this project');
  if (prompt) lastName.current = prompt.name;

  if (!presence.mounted) return null;

  return (
    <Dialog
      role="alertdialog"
      title={t('unsaved.title', { name: lastName.current })}
      icon={AlertTriangle}
      onClose={() => {
        if (useSessionStore.getState().unsavedPrompt) answer('cancel');
      }}
      closing={presence.closing}
      showCloseButton={false}
      zClass="z-[95]"
      widthClass="w-[440px]"
      footerStart={
        <button type="button" className="tool-button" disabled={!prompt} onClick={() => answer('discard')}>
          {t('unsaved.discard')}
        </button>
      }
      footer={
        <>
          <button type="button" className="tool-button" disabled={!prompt} onClick={() => answer('cancel')}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            data-autofocus
            className="button-primary"
            disabled={!prompt}
            onClick={() => answer('save')}
          >
            {t('unsaved.save')}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-slate-300">{t('unsaved.body')}</p>
    </Dialog>
  );
}

export default UnsavedChangesDialog;
