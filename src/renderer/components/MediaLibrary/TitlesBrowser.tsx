import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LibraryFinder } from './LibraryFinder';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import {
  CATEGORY_NAME,
  TEMPLATE_CATEGORIES,
  TITLE_TEMPLATES,
  templateMatches,
  type TemplateCategory,
  type TitleTemplate,
} from '@renderer/text/templates';
import { LibraryItem, THUMB_HEIGHT, THUMB_WIDTH, type Draw } from './LibraryBrowsers';
import { drawTemplateThumb, titleThumbReady } from './titleThumbs';

/**
 * The Titles tab of the library panel: the title library (text/templates),
 * by category, with a search that ignores accents, a picture of each
 * template that plays its entrance and exit while pointed at, and the same
 * ways to use one as before - drag it onto a track, or press Enter (or
 * double-click) to add it at the playhead.
 *
 * Pictures are drawn only once their tile scrolls into view, so opening the
 * tab does not draw sixty titles at once.
 */

type Filter = TemplateCategory | 'all';

export function TitlesBrowser(): JSX.Element {
  const t = useT();
  const hintId = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const found = useMemo(
    () => TITLE_TEMPLATES.filter((template) => templateMatches([t(template.name), t(template.text), t(CATEGORY_NAME[template.category]), template.id], query)),
    [query, t],
  );
  const groups = useMemo(
    () =>
      TEMPLATE_CATEGORIES.filter((category) => filter === 'all' || category === filter)
        .map((category) => ({ category, templates: found.filter((template) => template.category === category) }))
        .filter((group) => group.templates.length > 0),
    [filter, found],
  );
  const options = [
    { id: 'all', label: t('titleLibrary.all'), count: found.length },
    ...TEMPLATE_CATEGORIES.map((category) => ({ id: category, label: t(CATEGORY_NAME[category]), count: found.filter((template) => template.category === category).length })),
  ];

  return (
    <div data-testid="library-titles" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
      <LibraryFinder
        query={query}
        onQuery={setQuery}
        placeholder={t('titleLibrary.search')}
        searchTestId="title-library-search"
        options={options}
        value={filter}
        onChange={(id) => setFilter(id as Filter)}
        filterTestId="title-category"
        hint={t('library.titlesHint')}
        hintId={hintId}
        categoriesLabel={t('titleLibrary.categories')}
      />
      {groups.length === 0 && (
        <p role="status" data-testid="title-library-empty" className="px-1 py-4 text-center text-xs text-slate-400">
          {t('titleLibrary.none', { query })}
        </p>
      )}
      {groups.map(({ category, templates }) => (
        <section key={category} className="mb-3" aria-label={t(CATEGORY_NAME[category])}>
          <h3 className="section-title mb-1.5 px-1">{t(CATEGORY_NAME[category])}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-x-2 gap-y-2.5" aria-label={t(CATEGORY_NAME[category])}>
            {templates.map((template) => (
              <TemplateItem key={template.id} template={template} hintId={hintId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TemplateItem({ template, hintId }: { template: TitleTemplate; hintId: string }): JSX.Element {
  const t = useT();
  const text = t(template.text);
  const holder = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = holder.current;
    if (!element || visible) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    // Drawn in the template's own faces, never in a fallback caught mid-load.
    void titleThumbReady(template, text).finally(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [template, text, visible]);

  const drawRef = useRef<{ key: string; draw: Draw } | null>(null);
  if (drawRef.current?.key !== text) {
    drawRef.current = { key: text, draw: (context, seconds) => drawTemplateThumb(context, THUMB_WIDTH, THUMB_HEIGHT, template, text, seconds) };
  }

  return (
    <LibraryItem
        label={t(template.name)}
        testId={`library-title-${template.id}`}
        dragKind="title"
        dragValue={template.id}
        hintId={hintId}
        draw={drawRef.current.draw}
        ready={ready}
        badge={template.vertical ? { text: t('titleLibrary.vertical'), hint: t('titleLibrary.verticalHint') } : undefined}
        itemRef={holder}
        onAdd={() => useProjectStore.getState().addTitle(template.id)}
      />
  );
}

