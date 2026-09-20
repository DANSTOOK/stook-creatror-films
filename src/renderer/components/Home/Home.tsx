import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Clock, Film, FolderOpen, FolderPlus, LifeBuoy, Plus, Search, Sparkles, X } from 'lucide-react';
import type { ProjectRecovery, RecentProject } from '@shared/types/ipc';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { useFlip } from '@renderer/motion/useFlip';
import { formatLength, nextUntitledName, relativeTime } from '@renderer/project/projectSession';
import type { NewProjectOptions } from '@renderer/project/useProjectActions';

/**
 * The start screen: a new project, or one to carry on with.
 *
 * Modelled on DaVinci Resolve's Project Manager and Premiere's Home: recent
 * projects as thumbnails, newest first, one click away; a new project named and
 * placed up front rather than an "Untitled" that has to be renamed later; and
 * a blank project for trying something without keeping it.
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
  status: string | null;
  onBlank(): void;
  onCreate(options: NewProjectOptions): Promise<boolean>;
  onOpenDialog(): void;
  onOpenRecent(path: string): void;
  /** Take back up work a previous session never saved. */
  onRecover(): void;
}

export function Home({ status, onBlank, onCreate, onOpenDialog, onOpenRecent, onRecover }: HomeProps): JSX.Element {
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
      await onCreate({ name: name.trim() || 'Untitled project', folder, width: chosenPreset.width, height: chosenPreset.height, fps });
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

      <div className="relative mx-auto flex h-full w-full max-w-[1360px] gap-8 px-10 py-9">
        {/* Start something */}
        <section className="flex w-[360px] shrink-0 flex-col gap-5">
          <header className="scf-rise flex items-center gap-3" style={stagger(0)}>
            <img src={LOGO_URL} alt="" className="h-11 w-11 rounded-xl shadow-lg shadow-black/40" draggable={false} />
            <div>
              <h1 className="text-lg font-semibold tracking-wide text-slate-100">STOOK CREATOR FILMS</h1>
              <p className="text-xs text-slate-500">Start a new edit, or pick up where you left off.</p>
            </div>
          </header>

          <div className="scf-rise scf-surface space-y-3 rounded-xl p-4" style={stagger(1)}>
            <h2 className="flex items-center gap-2 text-sm font-medium text-slate-100">
              <Sparkles size={15} className="text-accent-hover" />
              New project
            </h2>

            <label className="flex flex-col gap-1">
              <span className="field-label">Project name</span>
              <input
                className="numeric-input h-9 text-sm"
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
                <span className="field-label">Resolution</span>
                <select className="numeric-input h-9" value={preset} onChange={(event) => setPreset(event.target.value)}>
                  {PRESETS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="field-label">Frame rate</span>
                <select className="numeric-input h-9" value={fps} onChange={(event) => setFps(Number(event.target.value))}>
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
                <span className="field-label">Location</span>
                <input readOnly className="numeric-input h-9 truncate" value={folder ?? ''} placeholder="Documents" title={folder ?? ''} />
              </label>
              <button
                type="button"
                className="tool-button h-9"
                disabled={!native}
                title="Choose the folder for the project file"
                onClick={() => void window.filmora.projectsChooseFolder().then((picked) => picked && setFolder(picked))}
              >
                <FolderPlus size={14} />
                Change
              </button>
            </div>

            <button
              type="button"
              className="scf-primary flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium"
              disabled={!native || creating}
              onClick={() => void create()}
            >
              <Plus size={16} />
              {creating ? 'Creating...' : 'Create project'}
            </button>
          </div>

          <div className="scf-rise grid grid-cols-2 gap-2" style={stagger(2)}>
            <button type="button" className="scf-surface scf-lift flex h-11 items-center justify-center gap-2 rounded-lg text-xs text-slate-200" onClick={onBlank}>
              <Film size={14} />
              Blank project
            </button>
            <button
              type="button"
              className="scf-surface scf-lift flex h-11 items-center justify-center gap-2 rounded-lg text-xs text-slate-200"
              disabled={!native}
              onClick={onOpenDialog}
            >
              <FolderOpen size={14} />
              Open project...
            </button>
          </div>

          {status && (
            <p
              role="status"
              className={`scf-rise break-all rounded-lg border px-3 py-2 text-2xs ${
                /could not|not found|error/i.test(status)
                  ? 'border-amber-500/30 bg-amber-950/30 text-amber-200'
                  : 'border-panel-700/80 bg-panel-900/70 text-slate-400'
              }`}
            >
              {status}
            </p>
          )}
        </section>

        {/* Carry on */}
        <section className="flex min-w-0 flex-1 flex-col">
          {recovery && (
            <div
              data-testid="recovery-card"
              className="scf-rise scf-surface mb-4 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3"
            >
              <LifeBuoy size={18} className="shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-100">
                  Unsaved work from {recovery.name}
                </p>
                <p className="text-2xs text-slate-400">
                  Kept automatically {relativeTime(recovery.savedAt)}, when the app closed before it was saved.
                </p>
              </div>
              <button type="button" className="tool-button tool-button-active shrink-0" onClick={onRecover}>
                Recover
              </button>
              <button
                type="button"
                className="tool-button shrink-0"
                title="Throw this away"
                onClick={() => {
                  setRecovery(null);
                  void window.filmora.projectsRecoveryClear().catch(() => undefined);
                }}
              >
                Discard
              </button>
            </div>
          )}
          <div className="scf-rise mb-4 flex items-center gap-3" style={stagger(1)}>
            <h2 className="flex items-center gap-2 text-sm font-medium text-slate-100">
              <Clock size={15} className="text-slate-400" />
              Recent projects
              {recent && recent.length > 0 && <span className="rounded-full bg-panel-800 px-2 py-0.5 text-2xs text-slate-400">{recent.length}</span>}
            </h2>
            <div className="flex-1" />
            {recent && recent.length > 0 && (
              <label className="relative w-64">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  className="numeric-input h-8 pl-8"
                  placeholder="Search projects"
                  aria-label="Search projects"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {recent === null ? null : recent.length === 0 ? (
              <div className="scf-rise scf-surface flex h-64 flex-col items-center justify-center gap-2 rounded-xl text-center" style={stagger(2)}>
                <Film size={28} className="text-slate-600" />
                <p className="text-sm text-slate-300">No recent projects yet</p>
                <p className="max-w-sm text-2xs leading-relaxed text-slate-500">
                  Projects you create, open or save show up here, with a picture of where you left them.
                </p>
              </div>
            ) : shown.length === 0 ? (
              <p className="px-1 py-8 text-center text-xs text-slate-500">No project matches &ldquo;{query}&rdquo;.</p>
            ) : (
              <ul ref={cardsRef} className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4 pb-4">
                {shown.map((project, index) => (
                  <li key={project.path} data-flip-key={project.path} className="scf-rise group relative" style={stagger(index + 2)}>
                    <button
                      type="button"
                      aria-label={`Open ${project.name}`}
                      title={project.exists ? project.path : `Not found: ${project.path}`}
                      disabled={!project.exists}
                      onClick={() => onOpenRecent(project.path)}
                      className="scf-card flex w-full flex-col overflow-hidden rounded-xl text-left disabled:cursor-not-allowed"
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
                          <span className="absolute inset-x-0 bottom-0 bg-red-950/85 px-2 py-1 text-center text-2xs text-red-200">File not found</span>
                        )}
                      </div>
                      <div className="space-y-0.5 px-3 py-2.5">
                        <p className="truncate text-sm font-medium text-slate-100">{project.name}</p>
                        <p className="truncate text-2xs text-slate-400">
                          {project.width > 0 ? `${project.width}x${project.height}` : 'Empty'}
                          {project.fps > 0 ? ` · ${project.fps} fps` : ''} · {formatLength(project.durationFrames, project.fps)}
                          {project.clipCount > 0 ? ` · ${project.clipCount} clip${project.clipCount === 1 ? '' : 's'}` : ''}
                        </p>
                        <p className="text-2xs text-slate-500">{relativeTime(project.lastOpened)}</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${project.name} from recent projects`}
                      title="Remove from the list (the file stays where it is)"
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
