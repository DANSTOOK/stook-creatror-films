import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Clock, Film, FolderOpen, FolderPlus, LifeBuoy, Plus, Search, Sparkles, X } from 'lucide-react';
import type { ProjectRecovery, RecentProject } from '@shared/types/ipc';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { useFlip } from '@renderer/motion/useFlip';
import { formatLength, nextUntitledName, relativeTime } from '@renderer/project/projectSession';
import type { NewProjectOptions } from '@renderer/project/useProjectActions';
import { useLanguageStore, useT } from '@renderer/i18n';

/**
 * The start screen: a new project, or one to carry on with.
 *
 * Modelled on DaVinci Resolve's Project Manager and Premiere's Home: recent
 * projects as thumbnails, newest first, one click away; a new project named and
 * placed up front rather than an "Untitled" that has to be renamed later; and
 * a blank project for trying something without keeping it.
 *
 * The recent projects take the whole width beside the new-project column, and
 * their search sits beside their title, where the eye already is - it used to
 * be at the far edge of a page capped at 1360px, with a lone card on the left
 * and an empty band on the right.
 */

const LOGO_URL = new URL('../../assets/logo.png', import.meta.url).href;

const PRESETS = [
  { id: '1080p', label: '1920 x 1080 (1080p)', width: 1920, height: 1080 },
  { id: '4k', label: '3840 x 2160 (4K UHD)', width: 3840, height: 2160 },
  { id: '720p', label: '1280 x 720 (720p)', width: 1280, height: 720 },
  { id: 'vertical', label: '1080 x 1920 (vertical)', width: 1080, height: 1920 },
  { id: 'square', label: '1080 x 1080 (square)', width: 1080, height: 1080 },
];
const RATES = [24, 25, 30, 50, 60];

/** Entrance stagger, capped so a long list does not keep arriving. */
const stagger = (index: number): CSSProperties => ({ ['--delay' as string]: `${Math.min(index, 11) * 35}ms` });

export interface HomeProps {
  onBlank(): void;
  onCreate(options: NewProjectOptions): Promise<boolean>;
  onOpenDialog(): void;
  onOpenRecent(path: string): void;
  /** Take back up work a previous session never saved. */
  onRecover(): void;
}

export function Home({ onBlank, onCreate, onOpenDialog, onOpenRecent, onRecover }: HomeProps): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const native = hasNativeBridge();
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [fps, setFps] = useState(30);
  const [folder, setFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!native) {
      setRecent([]);
      return;
    }
    setRecent(await window.filmora.projectsList().catch(() => []));
  }, [native]);

  useEffect(() => {
    void refresh();
    if (native) void window.filmora.projectsDefaultFolder().then(setFolder).catch(() => undefined);
  }, [native, refresh]);

  // Work a previous session was in the middle of and never saved. Offered
  // here rather than in a dialog on top of everything: it is a thing to
  // open, and this is the screen for opening things.
  const [recovery, setRecovery] = useState<ProjectRecovery | null>(null);
  useEffect(() => {
    if (!native) return;
    void window.filmora.projectsRecoveryRead().then(setRecovery).catch(() => undefined);
  }, [native]);

  // A sensible name ready to accept, not one the user must invent first.
  useEffect(() => {
    if (recent && !name) setName(nextUntitledName(recent.map((project) => project.name)));
    // Only when the list first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (recent ?? []).filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle));
  }, [recent, query]);

  // Searching, or removing a project, moves every card after it: FLIP slides
  // them to their new places so the eye can follow which is which.
  const cardsRef = useRef<HTMLUListElement>(null);
  useFlip(cardsRef, shown.map((project) => project.path).join('|'));

  const chosenPreset = PRESETS.find((candidate) => candidate.id === preset) ?? PRESETS[0];

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      await onCreate({ name: name.trim() || t('home.untitled'), folder, width: chosenPreset.width, height: chosenPreset.height, fps });
    } finally {
      setCreating(false);
    }
  };

  const forget = async (path: string): Promise<void> => {
    await window.filmora.projectsForget(path).catch(() => undefined);
    await refresh();
  };

  return (
    <main aria-label="Start screen" className="scf-home relative flex h-full overflow-hidden bg-panel-950">
      {/* Slow light behind everything; still under reduced motion. */}
      <div aria-hidden className="scf-glow scf-glow-a pointer-events-none absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full" />
      <div aria-hidden className="scf-glow scf-glow-b pointer-events-none absolute -bottom-48 right-[-120px] h-[600px] w-[600px] rounded-full" />

      <div className="relative flex h-full w-full gap-8 px-10 py-9">
        {/* Start something */}
        <section className="flex w-[340px] shrink-0 flex-col gap-5">
          <header className="scf-rise flex items-center gap-3" style={stagger(0)}>
            <img src={LOGO_URL} alt="" className="h-11 w-11 rounded-panel shadow-lg shadow-black/40" draggable={false} />
            <div>
              <h1 className="font-display text-lg font-semibold tracking-wide text-slate-100">STOOK CREATOR FILMS</h1>
              <p className="text-xs text-slate-400">{t('home.tagline')}</p>
            </div>
          </header>

          <div className="scf-rise scf-surface space-y-3 rounded-panel p-4" style={stagger(1)}>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Sparkles size={15} className="text-accent-hover" />
              {t('home.newProject')}
            </h2>

            <label className="flex flex-col gap-1">
              <span className="field-label">{t('home.projectName')}</span>
              <input
                className="numeric-input text-sm"
                value={name}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && native && !creating) void create();
                }}
              />
            </label>

            <div className="grid grid-cols-[1fr_96px] gap-2">
              <label className="flex flex-col gap-1">
                <span className="field-label">{t('home.resolution')}</span>
                <select className="numeric-input" value={preset} onChange={(event) => setPreset(event.target.value)}>
                  {PRESETS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">{t('home.frameRate')}</span>
                <select className="numeric-input" value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                  {RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} fps
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="field-label">{t('home.location')}</span>
                <input readOnly className="numeric-input truncate" value={folder ?? ''} placeholder="Documents" title={folder ?? ''} />
              </label>
              <button
                type="button"
                className="tool-button"
                disabled={!native}
                title={t('home.changeHint')}
                onClick={() => void window.filmora.projectsChooseFolder().then((picked) => picked && setFolder(picked))}
              >
                <FolderPlus size={14} />
                {t('home.change')}
              </button>
            </div>

            <button
              type="button"
              className="button-primary w-full"
              disabled={!native || creating}
              onClick={() => void create()}
            >
              <Plus size={15} />
              {creating ? t('home.creating') : t('home.create')}
            </button>
          </div>

          <div className="scf-rise grid grid-cols-2 gap-2" style={stagger(2)}>
            <button type="button" className="scf-surface scf-lift flex h-control items-center justify-center gap-2 rounded-control text-xs text-slate-200" onClick={onBlank}>
              <Film size={14} />
              {t('home.blank')}
            </button>
            <button
              type="button"
              className="scf-surface scf-lift flex h-control items-center justify-center gap-2 rounded-control text-xs text-slate-200"
              disabled={!native}
              onClick={onOpenDialog}
            >
              <FolderOpen size={14} />
              {t('home.open')}
            </button>
          </div>

        </section>

        {/* Carry on */}
        <section className="flex min-w-0 flex-1 flex-col">
          {recovery && (
            <div
              data-testid="recovery-card"
              className="scf-rise scf-surface mb-4 flex items-center gap-3 rounded-panel border border-amber-500/30 bg-amber-500/5 px-4 py-3"
            >
              <LifeBuoy size={18} className="shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-100">{t('home.recoveryTitle', { name: recovery.name })}</p>
                <p className="text-2xs text-slate-400">
                  {t('home.recoveryBody', { when: relativeTime(recovery.savedAt, Date.now(), language) })}
                </p>
              </div>
              <button
                type="button"
                className="tool-button shrink-0"
                title={t('home.discardHint')}
                onClick={() => {
                  setRecovery(null);
                  void window.filmora.projectsRecoveryClear().catch(() => undefined);
                }}
              >
                {t('home.discard')}
              </button>
              <button type="button" className="button-primary shrink-0" onClick={onRecover}>
                {t('home.recover')}
              </button>
            </div>
          )}
          <div className="scf-rise mb-4 flex h-11 items-center gap-4" style={stagger(1)}>
            <h2 className="flex shrink-0 items-center gap-2 text-sm font-semibold text-slate-100">
              <Clock size={15} className="text-slate-400" />
              {t('home.recent')}
              {recent && recent.length > 0 && <span className="rounded-full bg-panel-800 px-2 py-0.5 text-2xs text-slate-400">{recent.length}</span>}
            </h2>
            {/* Beside the title it filters, not at the far edge of the page. */}
            {recent && recent.length > 0 && (
              <label className="relative w-72">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  className="numeric-input pl-8"
                  placeholder={t('home.search')}
                  aria-label={t('home.search')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {recent === null ? null : recent.length === 0 ? (
              <div className="scf-rise scf-surface flex h-64 flex-col items-center justify-center gap-2 rounded-panel text-center" style={stagger(2)}>
                <Film size={28} className="text-slate-400" />
                <p className="text-sm text-slate-300">{t('home.noRecent')}</p>
                <p className="max-w-sm text-2xs leading-relaxed text-slate-400">{t('home.noRecentHint')}</p>
              </div>
            ) : shown.length === 0 ? (
              <p className="px-1 py-8 text-center text-xs text-slate-400">{t('home.noMatch', { query })}</p>
            ) : (
              // Columns of at least 220px across the whole width, as many as fit.
              <ul ref={cardsRef} className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 pb-4">
                {shown.map((project, index) => (
                  <li key={project.path} data-flip-key={project.path} className="scf-rise group relative" style={stagger(index + 2)}>
                    <button
                      type="button"
                      aria-label={t('home.openCard', { name: project.name })}
                      title={project.exists ? project.path : t('home.notFoundPath', { path: project.path })}
                      disabled={!project.exists}
                      onClick={() => onOpenRecent(project.path)}
                      className="scf-card flex w-full flex-col overflow-hidden rounded-menu text-left disabled:cursor-not-allowed"
                    >
                      <div className="relative aspect-video w-full overflow-hidden bg-panel-950">
                        {project.thumbnailUrl ? (
                          <img
                            src={project.thumbnailUrl}
                            alt=""
                            className="scf-thumb h-full w-full object-cover"
                            draggable={false}
                            // Faded in when it actually decodes, so a card does
                            // not flash from empty to picture. The ref covers an
                            // image that was already in cache, whose load event
                            // fired before React ever saw it.
                            ref={(image) => {
                              if (image?.complete && image.naturalWidth > 0) image.setAttribute('data-loaded', 'true');
                            }}
                            onLoad={(event) => event.currentTarget.setAttribute('data-loaded', 'true')}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Film size={26} className="text-slate-700" />
                          </div>
                        )}
                        {!project.exists && (
                          <span className="absolute inset-x-0 bottom-0 bg-red-950/85 px-2 py-1 text-center text-2xs text-red-200">{t('home.fileNotFound')}</span>
                        )}
                      </div>
                      <div className="space-y-0.5 px-3 py-2.5">
                        <p className="truncate text-sm font-medium text-slate-100">{project.name}</p>
                        <p className="truncate text-2xs text-slate-400">
                          {project.width > 0 ? `${project.width}×${project.height}` : t('home.empty')}
                          {project.fps > 0 ? ` · ${project.fps} fps` : ''} · {formatLength(project.durationFrames, project.fps)}
                          {project.clipCount > 0
                            ? ` · ${t(project.clipCount === 1 ? 'home.oneClip' : 'home.clips', { count: project.clipCount })}`
                            : ''}
                        </p>
                        <p className="text-2xs text-slate-400">{relativeTime(project.lastOpened, Date.now(), language)}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={t('home.removeCard', { name: project.name })}
                      title={t('home.removeHint')}
                      className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-slate-300 opacity-0 backdrop-blur transition-opacity duration-150 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => void forget(project.path)}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

export default Home;
