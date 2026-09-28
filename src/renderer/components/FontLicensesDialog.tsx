import { Scale } from 'lucide-react';
import { Dialog } from '@renderer/components/Dialog/Dialog';
import { useT } from '@renderer/i18n';
import { BUNDLED_FONTS } from '@renderer/text/fonts';

/**
 * The licences of the fonts that ship with the app, reached from Help and
 * from About. The SIL Open Font License asks for its text to travel with the
 * fonts; here it is, word for word, for each family.
 */
export function FontLicensesDialog({ onClose }: { onClose(): void }): JSX.Element {
  const t = useT();
  return (
    <Dialog
      title={t('licenses.title')}
      icon={Scale}
      onClose={onClose}
      testId="font-licenses-dialog"
      widthClass="w-[640px]"
      initialFocus="dialog"
      footer={
        <button type="button" className="button-primary" onClick={onClose}>
          {t('dialog.close')}
        </button>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-slate-300">{t('licenses.intro')}</p>
      <div className="space-y-4">
        {BUNDLED_FONTS.map((font) => (
          <section key={font.family} className="space-y-1.5">
            <h3 className="section-title">{font.family}</h3>
            <pre
              tabIndex={0}
              aria-label={`${t('licenses.title')}: ${font.family}`}
              className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-control border border-panel-700 bg-panel-950 p-2 font-sans text-2xs leading-relaxed text-slate-300"
            >
              {font.licence.trim()}
            </pre>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
