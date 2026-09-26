import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FilePlus2,
  FolderOpen,
  Headphones,
  Home as HomeIcon,
  Keyboard,
  Languages,
  LayoutDashboard,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Redo2,
  Save,
  Settings2,
  Share2,
  Undo2,
} from 'lucide-react';
import { ExportDialog } from './components/ExportDialog';
import { Home } from './components/Home/Home';
import { Inspector } from './components/Inspector';
import { Splitter } from './components/Layout/Splitter';
import { MediaLibrary } from './components/MediaLibrary';
import { Mixer } from './components/Mixer';
import { ProjectSettings } from './components/ProjectSettings';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { PreferencesDialog } from './components/Preferences/PreferencesDialog';
import { ContextMenu, useContextMenu } from './components/ContextMenu';
import { PreviewViewport } from './components/PreviewViewport';
import { Timeline } from './components/Timeline';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog/UnsavedChangesDialog';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import { usePresence } from './hooks/usePresence';
import { useEditorShortcuts, usePlaybackClock } from './hooks/useTransport';
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  clampLayout,
  loadLayout,
  resizePanel,
  saveLayout,
  type LayoutKey,
  type PanelLayout,
} from './layout/layoutSizes';
import { hasNativeBridge } from './media/importMedia';
import { useProjectActions } from './project/useProjectActions';
import { useAutosave } from './project/useAutosave';
import { getActiveFrameRenderer } from './engine/FrameRenderer';
import { useHistoryStore } from './store/useHistoryStore';
import { useProjectStore } from './store/useProjectStore';
import { useIsDirty, useSessionStore } from './store/useSessionStore';
import { t, useLanguageStore, useT } from './i18n';
import { notify } from './notifications/notifications';
import { NotificationsButton, Toaster } from './notifications/Toaster';
import { TooltipLayer } from './components/Tooltip/Tooltip';
import { MENU_IMPORT_EVENT } from './components/MediaLibrary/MediaLibrary';
import type { MenuCommand } from '@shared/types/ipc';

/** The project logo, bundled by Vite with the rest of the page. */
const LOGO_URL = new URL('./assets/logo.png', import.meta.url).href;
const APP_TITLE = 'STOOK CREATOR FILMS';

/**
 * Main layout: the start screen, or a fixed toolbar over a three-column
 * editing row (media, viewport, inspector) with the timeline docked underneath.
 *
 * Every border between them drags, as in DaVinci Resolve - see layoutSizes.ts.
 * The preview takes whatever the other panels leave.
 *
 * The start screen covers the editor rather than replacing it: the preview's
 * GPU context, the decoders and the audio graph stay alive across a trip
 * home, so coming back or opening the next project does not rebuild them.
 */
export default function App(): JSX.Element {
  // The clock advances the playhead and must exist exactly once in the tree.
  usePlaybackClock();
  useEditorShortcuts();
  useAudioPlayback();

  // Swallow drops that land outside a drop zone. Chromium's default is to open
  // the dropped file in the window - the whole editor replaced by a video
  // player, with every unsaved edit gone. Zones that accept drops cancel the
  // event first; anything still uncancelled here gets the "not allowed" cursor
  // and no default action. The main process blocks navigation as a backstop.
  useEffect(() => {
    const refuse = (event: DragEvent): void => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);

  const [exportOpen, setExportOpen] = useState(false);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const tr = useT();
  /**
   * Areas that are put away.
   *
   * Final Cut hides the browser and the inspector from its Window menu, and
   * for the same reason: on a laptop the picture is worth more than either
   * of them. The timeline and the viewer cannot be hidden - with both gone
   * there is no editor left.
   */
  const [hidden, setHidden] = useState({ media: false, inspector: false });
  const { menu: windowMenu, open: openWindowMenu, close: closeWindowMenu } = useContextMenu();
  const exportPresence = usePresence(exportOpen);
  const mixerPresence = usePresence(mixerOpen);
  const settingsPresence = usePresence(settingsOpen);
  const preferencesPresence = usePresence(preferencesOpen);

  /* Session ----------------------------------------------------------------- */

  const view = useSessionStore((state) => state.view);
  const projectName = useSessionStore((state) => state.projectName);
  const projectPath = useSessionStore((state) => state.projectPath);
  const dirty = useIsDirty();
  const actions = useProjectActions();

  // Saving on a timer, so a crash or a closed laptop costs minutes rather
  // than an afternoon. Never while the renderer is taken: an export owns it.
  useAutosave({
    save: useCallback(() => actions.save(false, { automatic: true }), [actions]),
    isBusy: useCallback(() => getActiveFrameRenderer()?.isExclusive === true, []),
    report: useCallback((message: string) => void notify(message, 'error'), []),
  });

  // Picking the project's format from the first clip imported is worth
  // saying once, when it happens - it used to sit in the media panel for good.
  useEffect(
    () =>
      useProjectStore.subscribe((state, previous) => {
        const from = state.adoptedSettingsFrom;
        if (!from || from === previous.adoptedSettingsFrom) return;
        const { width, height, fps } = state.project;
        notify(t('notify.adopted', { width, height, fps, name: from }), 'info');
      }),
    [],
  );

  // The window title names the project, as editors do; the start screen keeps
  // the plain app name.
  useEffect(() => {
    document.title = view === 'editor' && projectPath ? `${dirty ? '* ' : ''}${projectName} - ${APP_TITLE}` : APP_TITLE;
  }, [view, projectPath, projectName, dirty]);

  // The main process asks before closing a window with unsaved changes.
  useEffect(() => {
    if (!hasNativeBridge()) return;
    window.filmora.documentState({ dirty: view === 'editor' && dirty, name: projectName });
  }, [dirty, projectName, view]);

  useEffect(() => {
    if (!hasNativeBridge()) return undefined;
    return window.filmora.onSaveBeforeClose(() => {
      void actions.save(false).then((saved) => {
        if (saved) void window.filmora.closeAfterSave();
      });
    });
  }, [actions]);

  // Project shortcuts. Registered in the capture phase so Ctrl+S saves instead
  // of also reaching the editor's plain S (snapping).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      let run: (() => void) | null = null;
      if (key === 's' && view === 'editor') run = () => void actions.save(event.shiftKey);
      else if (key === 'o' && !event.shiftKey) run = () => void actions.openFromDialog();
      if (!run) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!useSessionStore.getState().unsavedPrompt) run();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [actions, view]);

  // Escape leaves the full-screen viewer. A dialog open on top takes the key
  // first (components/Dialog), so Escape closes the nearest thing, which is
  // how it behaves everywhere else.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || useSessionStore.getState().unsavedPrompt) return;
      const { ui, setUi } = useProjectStore.getState();
      if (!ui.fullscreenViewer) return;
      event.preventDefault();
      setUi({ fullscreenViewer: false });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * "?" opens the list of keys, as it does in Resolve and in most things built
   * for the keyboard. Not while typing: a question mark belongs in the field.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (typing || useSessionStore.getState().unsavedPrompt) return;
      event.preventDefault();
      setShortcutsOpen((open) => !open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Behind the start screen the editor is inert: no focus, no clicks, no screen reader.
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    element.toggleAttribute('inert', view !== 'editor');
    if (view !== 'editor') useProjectStore.getState().setPlaying(false);
  }, [view]);

  /* Panel sizes ------------------------------------------------------------- */

  const workspaceRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState<PanelLayout>(loadLayout);
  // Sizes are fitted to the window on every render rather than stored fitted,
  // so shrinking the window and growing it back returns the panels to the
  // sizes that were chosen.
  const fitted = clampLayout(layout, space);
  const dragOrigin = useRef<PanelLayout>(fitted);
  const latest = useRef<PanelLayout>(layout);
  latest.current = layout;

  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSpace({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const commitLayout = useCallback((next: PanelLayout) => {
    setLayout(next);
    saveLayout(next);
  }, []);

  /**
   * A border for one panel. `grows` says which way the pointer has to move for
   * the panel to get bigger: right for the media panel, left for the
   * inspector, up for the timeline.
   */
  const border = (key: LayoutKey, label: string, orientation: 'vertical' | 'horizontal', grows: 1 | -1): JSX.Element => (
    <Splitter
      orientation={orientation}
      label={label}
      value={fitted[key]}
      min={LAYOUT_LIMITS[key].min}
      max={LAYOUT_LIMITS[key].max}
      onDragStart={() => {
        dragOrigin.current = fitted;
      }}
      onDrag={(offset) => setLayout(resizePanel(dragOrigin.current, key, grows * offset, space))}
      onDragEnd={() => saveLayout(latest.current)}
      onStep={(offset) => commitLayout(resizePanel(fitted, key, grows * offset, space))}
      onReset={() => commitLayout(clampLayout({ ...fitted, [key]: DEFAULT_LAYOUT[key] }, space))}
    />
  );

  // Saving, opening and exporting all go through the native bridge, so those
  // controls are disabled rather than throwing when running in a browser.
  const nativeAvailable = hasNativeBridge();

  const canUndo = useHistoryStore((state) => state.canUndo);
  const canRedo = useHistoryStore((state) => state.canRedo);
  const undo = useProjectStore((state) => state.undo);
  const redo = useProjectStore((state) => state.redo);

  const desktopOnly = (title: string): string => (nativeAvailable ? title : tr('toolbar.desktopOnly'));

  /* The application menu ---------------------------------------------------- */

  // The menu lives in the main process; it is told what to label, tick and
  // grey out, and it names the action back when an item is chosen.
  const language = useLanguageStore((state) => state.language);
  const fullscreenViewer = useProjectStore((state) => state.ui.fullscreenViewer);
  useEffect(() => {
    if (!hasNativeBridge()) return;
    window.filmora.menuState({
      language,
      editor: view === 'editor',
      canUndo,
      canRedo,
      mediaShown: !hidden.media,
      inspectorShown: !hidden.inspector,
      fullscreenViewer,
    });
  }, [language, view, canUndo, canRedo, hidden, fullscreenViewer]);

  // Kept in a ref so the listener is registered once and always runs the
  // current actions.
  const runMenuCommand = useRef<(command: MenuCommand) => void>(() => undefined);
  runMenuCommand.current = (command) => {
    const session = useSessionStore.getState();
    if (session.unsavedPrompt) return;
    // The start screen offers a new project and opening one; everything else
    // is about the project in the editor.
    if (session.view !== 'editor' && command !== 'new' && command !== 'open' && command !== 'preferences') return;
    const store = useProjectStore.getState();
    const target = document.activeElement as HTMLElement | null;
    const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
    switch (command) {
      case 'new':
        void actions.newBlank();
        return;
      case 'open':
        if (nativeAvailable) void actions.openFromDialog();
        return;
      case 'save':
      case 'saveAs':
        if (nativeAvailable) void actions.save(command === 'saveAs');
        return;
      case 'import':
        // The media panel owns importing; bring it back first if it was put away.
        setHidden((current) => ({ ...current, media: false }));
        window.setTimeout(() => window.dispatchEvent(new Event(MENU_IMPORT_EVENT)), 0);
        return;
      case 'export':
        if (nativeAvailable) setExportOpen(true);
        return;
      case 'projectSettings':
        setSettingsOpen(true);
        return;
      case 'home':
        void actions.goHome();
        return;
      case 'undo':
        store.undo();
        return;
      case 'redo':
        store.redo();
        return;
      case 'cut':
      case 'copy':
      case 'paste':
        // Text in a field when one has focus, as in any app; clips otherwise.
        if (typing) window.filmora.editText(command);
        else if (command === 'cut') store.cutSelection();
        else if (command === 'copy') store.copySelection();
        else store.paste();
        return;
      case 'toggleMedia':
        setHidden((current) => ({ ...current, media: !current.media }));
        return;
      case 'toggleInspector':
        setHidden((current) => ({ ...current, inspector: !current.inspector }));
        return;
      case 'fullscreenViewer':
        store.setUi({ fullscreenViewer: !store.ui.fullscreenViewer });
        return;
      case 'resetLayout':
        setHidden({ media: false, inspector: false });
        commitLayout({ ...DEFAULT_LAYOUT });
        return;
      case 'mixer':
        setMixerOpen(true);
        return;
      case 'shortcuts':
        setShortcutsOpen(true);
        return;
      case 'preferences':
        setPreferencesOpen(true);
        return;
      default:
        return;
    }
  };
  useEffect(() => {
    if (!hasNativeBridge()) return undefined;
    return window.filmora.onMenuCommand((command) => runMenuCommand.current(command));
  }, []);

  return (
    <div className="relative h-full">
      <div ref={editorRef} aria-hidden={view !== 'editor'} className="flex h-full flex-col gap-1.5 bg-panel-950 p-1.5">
        <header className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-panel-700 bg-panel-900 px-2 shadow-md shadow-black/30">
          <button
            type="button"
            className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-panel-800"
            onClick={() => void actions.goHome()}
            title={tr('toolbar.homeHint')}
            aria-label={tr('toolbar.home')}
          >
            {/* The project logo. It has its own light ground, so it sits in a
                rounded tile rather than being cut out against the dark header. */}
            <img
              src={LOGO_URL}
              alt="SCF"
              className="h-6 w-6 rounded-md transition-transform duration-200 group-hover:scale-110"
              draggable={false}
            />
            <HomeIcon size={13} className="text-slate-400 transition-colors duration-150 group-hover:text-slate-200" />
          </button>

          <div className="toolbar-group">
            <button type="button" className="tool-button" onClick={() => void actions.newBlank()} title={tr('toolbar.newHint')}>
              <FilePlus2 size={14} />
              {tr('toolbar.new')}
            </button>
            <button
              type="button"
              className="tool-button"
              disabled={!nativeAvailable}
              onClick={() => void actions.openFromDialog()}
              title={desktopOnly(tr('toolbar.openHint'))}
            >
              <FolderOpen size={14} />
              {tr('toolbar.open')}
            </button>
            <button
              type="button"
              className="tool-button"
              disabled={!nativeAvailable}
              onClick={() => void actions.save(false)}
              title={desktopOnly(tr('toolbar.saveHint'))}
            >
              <Save size={14} />
              {tr('toolbar.save')}
            </button>
          </div>

          <div className="toolbar-group">
            <button type="button" className="tool-button" disabled={!canUndo} onClick={undo} title={tr('toolbar.undoHint')}>
              <Undo2 size={14} />
              {tr('toolbar.undo')}
            </button>
            <button type="button" className="tool-button" disabled={!canRedo} onClick={redo} title={tr('toolbar.redoHint')}>
              <Redo2 size={14} />
              {tr('toolbar.redo')}
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className={`tool-button ${mixerOpen ? 'tool-button-active' : ''}`}
              onClick={() => setMixerOpen(true)}
              title={tr('toolbar.mixerHint')}
            >
              <Headphones size={14} />
              {tr('toolbar.mixer')}
            </button>
            {/*
              One menu for the window itself, the way a Mac editor keeps it:
              which areas are showing, how they are arranged, and the settings
              that belong to the project rather than to a clip. Four loose
              buttons of four different kinds were four decisions in the way.
            */}
            <button
              type="button"
              className={`tool-button ${windowMenu ? 'tool-button-active' : ''}`}
              data-testid="window-menu-button"
              aria-haspopup="menu"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                openWindowMenu({ preventDefault: () => undefined, clientX: box.left, clientY: box.bottom + 4 }, [
                  {
                    label: hidden.media ? tr('quick.showMedia') : tr('quick.hideMedia'),
                    icon: PanelLeft,
                    onSelect: () => setHidden((current) => ({ ...current, media: !current.media })),
                  },
                  {
                    label: hidden.inspector ? tr('quick.showInspector') : tr('quick.hideInspector'),
                    icon: PanelRight,
                    onSelect: () => setHidden((current) => ({ ...current, inspector: !current.inspector })),
                  },
                  { separator: true },
                  {
                    label: tr('quick.resetLayout'),
                    icon: LayoutDashboard,
                    onSelect: () => {
                      setHidden({ media: false, inspector: false });
                      commitLayout({ ...DEFAULT_LAYOUT });
                    },
                  },
                  { separator: true },
                  {
                    label: tr('quick.projectSettings'),
                    icon: Settings2,
                    onSelect: () => setSettingsOpen(true),
                  },
                  {
                    label: tr('quick.preferences'),
                    icon: Languages,
                    onSelect: () => setPreferencesOpen(true),
                  },
                  {
                    label: tr('quick.shortcuts'),
                    icon: Keyboard,
                    shortcut: '?',
                    onSelect: () => setShortcutsOpen(true),
                  },
                ]);
              }}
              title={tr('toolbar.windowHint')}
            >
              <PanelsTopLeft size={14} />
              {tr('toolbar.window')}
            </button>
          </div>

          {/* The open project, and whether it has unsaved changes. */}
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-3" title={projectPath ?? tr('toolbar.notSaved')}>
            <span data-testid="project-name" className="truncate text-xs font-medium text-slate-200">
              {projectName}
            </span>
            {dirty && (
              <span
                data-testid="unsaved-indicator"
                className="scf-dirty-dot h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                title={tr('toolbar.unsaved')}
              />
            )}
          </div>

          <NotificationsButton />

          <button
            type="button"
            className="button-primary"
            disabled={!nativeAvailable}
            onClick={() => setExportOpen(true)}
            title={nativeAvailable ? tr('toolbar.exportHint') : tr('toolbar.exportDesktopOnly')}
          >
            <Share2 size={14} />
            {tr('toolbar.export')}
          </button>
        </header>

        <div ref={workspaceRef} className="flex min-h-0 flex-1 flex-col">
          <main className="flex min-h-0 flex-1">
            {/* A hidden area gives its width to the picture, and its border
                goes with it: a splitter for something that is not there is a
                handle that does nothing. */}
            {!hidden.media && (
              <>
                <div className="flex min-h-0 shrink-0" style={{ width: fitted.mediaWidth }}>
                  <MediaLibrary />
                </div>
                {border('mediaWidth', 'Resize the media panel', 'vertical', 1)}
              </>
            )}
            <PreviewViewport />
            {!hidden.inspector && (
              <>
                {border('inspectorWidth', 'Resize the inspector', 'vertical', -1)}
                <div className="flex min-h-0 shrink-0" style={{ width: fitted.inspectorWidth }}>
                  <Inspector />
                </div>
              </>
            )}
          </main>

          {border('timelineHeight', 'Resize the timeline', 'horizontal', -1)}

          <div className="shrink-0" style={{ height: fitted.timelineHeight }}>
            <Timeline />
          </div>
        </div>

        {exportPresence.mounted && <ExportDialog closing={exportPresence.closing} onClose={() => setExportOpen(false)} />}
        {mixerPresence.mounted && <Mixer closing={mixerPresence.closing} onClose={() => setMixerOpen(false)} />}
        {windowMenu && <ContextMenu {...windowMenu} onClose={closeWindowMenu} />}
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
        {preferencesPresence.mounted && (
          <PreferencesDialog closing={preferencesPresence.closing} onClose={() => setPreferencesOpen(false)} />
        )}
        {settingsPresence.mounted && (
          <ProjectSettings
            closing={settingsPresence.closing}
            onClose={() => setSettingsOpen(false)}
            onRestore={async (contents, savedAt) => {
              // The panel goes first: what it was showing belongs to the
              // project that is being replaced.
              setSettingsOpen(false);
              await actions.restoreContents(contents, savedAt);
            }}
          />
        )}
      </div>

      {/* The swap itself is a view transition (motion/viewTransition.ts), so this
          is a plain switch: the browser cross-fades the two states for us. */}
      {view === 'home' && (
        <div className="absolute inset-0 z-40">
          <Home
            onBlank={() => void actions.newBlank()}
            onCreate={actions.createProject}
            onOpenDialog={() => void actions.openFromDialog()}
            onOpenRecent={(path) => void actions.openRecent(path)}
            onRecover={() => void actions.recoverUnsaved()}
          />
        </div>
      )}

      <UnsavedChangesDialog />
      <Toaster />
      <TooltipLayer />
    </div>
  );
}
