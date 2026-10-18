import { useT } from '@renderer/i18n';
import { EFFECT_CREDITS, GLFX_MIT, GL_TRANSITIONS_MIT, PAGE_CURL_BSD, TRANSITION_CREDITS } from '@renderer/fx/licenses';
import { shaderTransitionLabel } from '@renderer/fx/transitions/catalog';
import { effectLabel } from '@renderer/fx/effects/catalog';

/**
 * The transitions' and effects' credits, in the Licenses dialog under the
 * fonts: each by name, author and licence, then the licence texts the MIT
 * and BSD licences ask to be reproduced.
 */
const PRE =
  'max-h-48 overflow-y-auto whitespace-pre-wrap rounded-control border border-panel-700 bg-panel-950 p-2 font-sans text-2xs leading-relaxed text-slate-300';

export function ThirdPartyLicenses(): JSX.Element {
  const t = useT();
  return (
    <div className="mt-4 space-y-4" data-testid="third-party-licenses">
      <section className="space-y-1.5">
        <h3 className="section-title">{t('fx.licenses.transitions')}</h3>
        <p className="text-xs leading-relaxed text-slate-300">{t('fx.licenses.transitionsIntro')}</p>
        <ul className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-2xs text-slate-300">
          {TRANSITION_CREDITS.map((credit) => (
            <li key={credit.id} className="contents">
              <span className="truncate" title={credit.url}>
                {t(shaderTransitionLabel(credit.id))} — {credit.author}
              </span>
              <span className="text-slate-400">{credit.licence}</span>
            </li>
          ))}
        </ul>
        <pre tabIndex={0} aria-label="gl-transitions MIT" className={PRE}>{GL_TRANSITIONS_MIT}</pre>
        <pre tabIndex={0} aria-label="Page curl BSD" className={PRE}>{PAGE_CURL_BSD}</pre>
      </section>
      <section className="space-y-1.5">
        <h3 className="section-title">{t('fx.licenses.effects')}</h3>
        <p className="text-xs leading-relaxed text-slate-300">{t('fx.licenses.effectsIntro')}</p>
        <ul className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-2xs text-slate-300">
          {EFFECT_CREDITS.map((credit) => (
            <li key={credit.id} className="contents">
              <span className="truncate">
                {t(effectLabel(credit.id))} — {credit.author || t('fx.licenses.ownWork')}
              </span>
              <span className="text-slate-400">{credit.licence}</span>
            </li>
          ))}
        </ul>
        <pre tabIndex={0} aria-label="glfx.js MIT" className={PRE}>{GLFX_MIT}</pre>
      </section>
    </div>
  );
}
