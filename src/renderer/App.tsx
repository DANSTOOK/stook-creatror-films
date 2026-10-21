import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExportDialog } from './components/ExportDialog';
import { Home } from './components/Home/Home';
import { Inspector } from './components/Inspector';
import { Splitter } from './components/Layout/Splitter';
import { PanelSlot, markEditorShown } from './components/Layout/PanelSlot';
import { PanelWindow, focusPanelWindow } from './components/Layout/PanelWindow';
import { PanelEmptyState } from './components/Layout/PanelEmptyState';
import { DetachButton } from './components/Layout/DetachButton';
import { PictureInPicture2, SlidersHorizontal } from 'lucide-react';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { MediaLibrary } from './components/MediaLibrary';
import { Mixer } from './components/Mixer';
import { ProjectSettings } from './components/ProjectSettings';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { FontLicensesDialog } from './components/FontLicensesDialog';
import { TransitionDialog } from './components/TransitionDialog';
import { SHOW_INSPECTOR_EVENT } from './components/Timeline/Timeline';
import { loadLocalFamilies } from './text/fonts';
import { PreferencesDialog } from './components/Preferences/PreferencesDialog';
import { GenerateCaptionsDialog } from './components/Captions/GenerateCaptionsDialog';
import { TextToSpeechWindow } from './components/TextToSpeech/TextToSpeechWindow';
import { focusDetachedWindow } from './components/Layout/useDetachedWindow';
import { CaptionProgress } from './components/Captions/CaptionProgress';
import { exportCaptionsToDialog, importCaptionsFromDialog } from './captions/captionFiles';
import { PreviewViewport } from './components/PreviewViewport';
import { Timeline } from './components/Timeline';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog/UnsavedChangesDialog';
import { RelinkDialog } from './components/RelinkDialog/RelinkDialog';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import { useClipContent } from './media/useClipContent';
import { useMatteLookups } from './matting/mattes';
import { usePresence } from './hooks/usePresence';
import { detachSelectionAudio, rejoinSelectionAudio, useEditorShortcuts, usePlaybackClock } from './hooks/useTransport';
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  clampLayout,
  isCompactWindow,
  loadLayout,
  responsiveLayout,
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
import { TitleBar, type PanelKey } from './components/TitleBar/TitleBar';
import { useProjectStore } from './store/useProjectStore';
import { useIsDirty, useSessionStore } from './store/useSessionStore';
import { t, useLanguageStore } from './i18n';
import { notify } from './notifications/notifications';
import { Toaster } from './notifications/Toaster';
import { TooltipLayer } from './components/Tooltip/Tooltip';
import { MENU_IMPORT_EVENT } from './components/MediaLibrary/MediaLibrary';
import type { MenuCommand } from '@shared/types/ipc';

/** The project logo, bundled by Vite with the rest of the page. */
const LOGO_URL = new URL('./assets/logo.png', import.meta.url).href;
const APP_TITLE = 'STOOK CREATOR FILMS';
const MIXER_OPEN_KEY = 'scf.mixerOpen';

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
  useClipContent();
  useMatteLookups();

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
  /*
    The mixer is docked beside the timeline, as Resolve docks its mixer on
    the Edit page, and whether it is out is remembered on this machine.
    Showing it brings the timeline back if that was put away.
  */
  // Panels that are open in a window of their own, for a second monitor.
  const detached = useWorkspaceStore((state) => state.detached);
  const setDetached = useWorkspaceStore((state) => state.setDetached);
  // The inspector's own window shows an empty state of its own; only nothing
  // at all picked counts (a transition picked has settings to show).
  const nothingSelected = useProjectStore(
    (state) =>
      state.ui.selectedClipIds.length === 0 &&
      !(state.ui.selectedTransitionId && state.project.transitions?.[state.ui.selectedTransitionId]),
  );

  // The mixer's window opens as wide as its strips need (Mixer: up to 120px
  // each, and the master), rather than one width for three tracks or twelve.
  const trackCount = useProjectStore((state) => state.project.tracks.length);
  const mixerWindowWidth = Math.min(1280, Math.max(440, (trackCount + 1) * 124 + 32));

  const [mixerOpen, setMixerOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(MIXER_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setMixerOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    setMixerOpenState((open) => {
      const value = typeof next === 'function' ? next(open) : next;
      try {
        window.localStorage.setItem(MIXER_OPEN_KEY, value ? '1' : '0');
      } catch {
        // Kept for this session only.
      }
      if (value) setHidden((current) => (current.timeline ? { ...current, timeline: false } : current));
      return value;
    });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);

  // Which fonts this computer has, asked once, so a title whose font is
  // missing is flagged on the timeline and in the export without waiting
  // for its inspector to open.
  useEffect(() => {
    void loadLocalFamilies();
  }, []);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [ttsOpen, setTtsOpen] = useState(false);
  /**
   * Areas that are put away.
   *
   * Final Cut shows and hides its browser, timeline and inspector from
   * buttons in its toolbar (and Ctrl+Cmd+1, Ctrl+Cmd+2, Cmd+4), and for the
   * same reason: on a laptop the picture is worth more than any of them. The
   * viewer cannot be hidden - it is what the rest is for.
   */
  const [chosenHidden, setHidden] = useState<Record<PanelKey, boolean>>({ media: false, inspector: false, timeline: false });

  /*
    A narrow window folds the side panels away (layoutSizes.ts); the title
    bar's buttons then bring one back for as long as it is wanted. What was
    chosen in a wide window is kept for when the window is wide again.
  */
  const [windowWidth, setWindowWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  const [windowHeight, setWindowHeight] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight));
  useEffect(() => {
    const onResize = (): void => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const compact = isCompactWindow(windowWidth);
  const [revealed, setRevealed] = useState({ media: false, inspector: false });
  useEffect(() => {
    if (!compact) setRevealed({ media: false, inspector: false });
  }, [compact]);
  // Folding the side panels away is for the viewer's sake; with the viewer in
  // a window of its own there is nothing to make room for, and folding them
  // left a laptop's editor with nothing in it but the timeline.
  const folds = compact && !detached.viewer;
  // A side panel open as a drawer over the picture goes again with Escape.
  const drawerOpen = folds && (revealed.media || revealed.inspector);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setRevealed({ media: false, inspector: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  const hidden: Record<PanelKey, boolean> = {
    timeline: chosenHidden.timeline,
    media: chosenHidden.media || (folds && !revealed.media),
    inspector: chosenHidden.inspector || (folds && !revealed.inspector),
  };

  /** Show or hide a panel: in a compact window, the side panels are revealed instead. */
  const togglePanelRef = useRef<(panel: PanelKey) => void>(() => undefined);
  togglePanelRef.current = (panel) => {
    // A panel out in its own window is not here to show or hide: its button
    // brings that window to the front instead.
    if (detached[panel] && focusPanelWindow(panel)) return;
    if (folds && panel !== 'timeline' && !chosenHidden[panel]) {
      setRevealed((current) => ({ ...current, [panel]: !current[panel] }));
      return;
    }
    setHidden((current) => ({ ...current, [panel]: !current[panel] }));
  };

  // A transition double-clicked on the timeline opens in the inspector, shown if it was put away.
  useEffect(() => {
    const show = (): void => {
      setHidden((current) => (current.inspector ? { ...current, inspector: false } : current));
      if (compact) setRevealed((current) => ({ ...current, inspector: true }));
    };
    window.addEventListener(SHOW_INSPECTOR_EVENT, show);
    return () => window.removeEventListener(SHOW_INSPECTOR_EVENT, show);
  }, [compact]);
  // Panels shown from here on slide in; the first layout is simply there.
  useEffect(() => {
    const frame = requestAnimationFrame(() => markEditorShown());
    return () => cancelAnimationFrame(frame);
  }, []);

  const exportPresence = usePresence(exportOpen);
  const settingsPresence = usePresence(settingsOpen);
  const preferencesPresence = usePresence(preferencesOpen);
  const captionsPresence = usePresence(captionsOpen);

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
      // Typing into a title in the viewer: only saving reaches the project.
      if ((event.target as HTMLElement | null)?.isContentEditable && key !== 's') return;
      let run: (() => void) | null = null;
      // With a dialog open, only saving still reaches the project: a new
      // project or a second dialog under a modal one would be lost behind it.
      const modal = document.querySelector('[aria-modal="true"]') !== null;
      const editing = view === 'editor' && !event.shiftKey && !modal;
      if (key === 's' && view === 'editor') run = () => void actions.save(event.shiftKey);
      else if (key === 'o' && !event.shiftKey && !modal) run = () => void actions.openFromDialog();
      // The keys New, Import and Export have in Premiere and Final Cut, now
      // that their buttons have left the toolbar for the menu.
      else if (key === 'n' && !event.shiftKey && !modal) run = () => void actions.newBlank();
      else if (key === 'i' && editing) run = () => runMenuCommand.current('import');
      else if (key === 'e' && editing && hasNativeBridge()) run = () => setExportOpen(true);
      // Final Cut's browser, timeline and inspector keys.
      // Find a function by name, on the key VS Code, Resolve and Artcraft
      // all use for it. Allowed while it is itself the open dialog, so the
      // same key closes it again.
      else if (key === 'p' && event.shiftKey && view === 'editor'
        && (!modal || document.querySelector('[data-testid="command-palette"]') !== null)) {
        run = () => setPaletteOpen((open) => !open);
      }
      else if (key === '1' && editing) run = () => togglePanelRef.current('media');
      else if (key === '2' && editing) run = () => togglePanelRef.current('timeline');
      else if (key === '4' && editing) run = () => togglePanelRef.current('inspector');
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
  const fitted = clampLayout(responsiveLayout(layout, windowWidth, windowHeight), space);
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

  /* The application menu ---------------------------------------------------- */

  // The menu lives in the main process; it is told what to label, tick and
  // grey out, and it names the action back when an item is chosen.
  const language = useLanguageStore((state) => state.language);
  const fullscreenViewer = useProjectStore((state) => state.ui.fullscreenViewer);
  const loopPlayback = useProjectStore((state) => state.ui.loopPlayback);
  useEffect(() => {
    if (!hasNativeBridge()) return;
    window.filmora.menuState({
      language,
      editor: view === 'editor',
      canUndo,
      canRedo,
      mediaShown: !hidden.media,
      inspectorShown: !hidden.inspector,
      timelineShown: !hidden.timeline,
      fullscreenViewer,
      loopPlayback,
    });
  }, [language, view, canUndo, canRedo, hidden.media, hidden.inspector, hidden.timeline, fullscreenViewer, loopPlayback]);

  // Kept in a ref so the listener is registered once and always runs the
  // current actions.
  const runMenuCommand = useRef<(command: MenuCommand) => void>(() => undefined);
  runMenuCommand.current = (command) => {
    const session = useSessionStore.getState();
    if (session.unsavedPrompt) return;
    // The start screen offers a new project and opening one; everything else
    // is about the project in the editor.
    if (session.view !== 'editor' && command !== 'new' && command !== 'open' && command !== 'preferences' && command !== 'fontLicenses') return;
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
        if (compact) setRevealed((current) => ({ ...current, media: true }));
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
        togglePanelRef.current('media');
        return;
      case 'toggleInspector':
        togglePanelRef.current('inspector');
        return;
      case 'toggleTimeline':
        togglePanelRef.current('timeline');
        return;
      case 'fullscreenViewer':
        store.setUi({ fullscreenViewer: !store.ui.fullscreenViewer });
        return;
      case 'resetLayout':
        // As Premiere's Reset Workspace does, panels out in windows come home too.
        useWorkspaceStore.getState().dockAll();
        setHidden({ media: false, inspector: false, timeline: false });
        commitLayout({ ...DEFAULT_LAYOUT });
        return;
      case 'mixer':
        setMixerOpen((open) => !open);
        return;
      case 'shortcuts':
        setShortcutsOpen(true);
        return;
      case 'commandPalette':
        // A second press closes it, as the key that opened it would.
        setPaletteOpen((open) => !open);
        return;
      case 'preferences':
        setPreferencesOpen(true);
        return;
      case 'addTitle':
        store.addTitle('title');
        return;
      case 'addLowerThird':
        store.addTitle('lowerThird');
        return;
      case 'addCredits':
        store.addTitle('credits');
        return;
      case 'addTransition':
        store.addTransitions();
        return;
      case 'fontLicenses':
        setLicensesOpen(true);
        return;
      case 'generateCaptions':
        if (nativeAvailable) setCaptionsOpen(true);
        return;
      case 'textToSpeech':
        // Its own window now, not a modal: if it is already open, the menu
        // brings that window to the front rather than opening a second.
        if (nativeAvailable) {
          if (!(ttsOpen && focusDetachedWindow('textToSpeech'))) setTtsOpen(true);
        }
        return;
      case 'importCaptions':
        if (nativeAvailable) void importCaptionsFromDialog();
        return;
      case 'exportCaptions':
        if (nativeAvailable) void exportCaptionsToDialog();
        return;
      case 'detachAudio':
        detachSelectionAudio();
        return;
      case 'rejoinAudio':
        rejoinSelectionAudio();
        return;
      case 'loopPlayback':
        store.setLoopPlayback(!store.ui.loopPlayback);
        return;
      default:
        return;
    }
  };
  useEffect(() => {
    if (!hasNativeBridge()) return undefined;
    return window.filmora.onMenuCommand((command) => runMenuCommand.current(command));
  }, []);

  const togglePanel = (panel: PanelKey): void => togglePanelRef.current(panel);

  /*
    A panel in a window of its own leaves this layout altogether, and the rest
    closes over its space rather than keeping a hole where it was - the title
    bar says where it went (Layout/DetachedPanelsTray). The viewer is what
    normally takes the width the side panels leave; with it on another screen
    the media panel takes that width (a wide browser, as Resolve's media pool
    gets on a dual-screen layout), or failing that the inspector. With nothing
    left in that row, the timeline takes the whole window, as Resolve's
    full-screen timeline does.
  */
  const mediaHere = !hidden.media && !detached.media;
  const inspectorHere = !hidden.inspector && !detached.inspector;
  /*
    In a narrow window a side panel brought back does not squeeze the picture:
    it slides in over it as a drawer, on a dimmed scrim, and goes again with a
    click outside it or Escape - how a phone or a half-screen editor shows a
    panel there is no room to dock.
  */
  const mediaDrawer = folds && mediaHere;
  const inspectorDrawer = folds && inspectorHere;
  const closeDrawers = (): void => setRevealed({ media: false, inspector: false });
  const timelineHere = !hidden.timeline && !detached.timeline;
  const rowFiller: 'viewer' | 'media' | 'inspector' | null = !detached.viewer
    ? 'viewer'
    : mediaHere
      ? 'media'
      : inspectorHere
        ? 'inspector'
        : null;
  const timelineFills = rowFiller === null;
  const nothingHere = timelineFills && !timelineHere;
  /*
    With the viewer elsewhere and the timeline here, the row above is a
    browser row - media and inspector - of a height of its own, and the
    timeline takes the rest: on a dual-screen layout this window is the one
    for editing, as Resolve's dual-screen Edit page gives one screen to the
    timeline. Stretching the media panel over the whole row instead put one
    thumbnail in a 1280px box over a 300px timeline.
  */
  const browserRow = rowFiller !== null && rowFiller !== 'viewer' && timelineHere;
  const timelineGrows = timelineFills || browserRow;
  // The mixer is docked beside the timeline, and goes with it to its window.
  const mixerDocked = mixerOpen && !detached.mixer;
  const grows = (fills: boolean): string => (fills ? 'min-w-0 flex-1' : 'shrink-0');

  return (
    <div className="flex h-full flex-col bg-panel-950">
      <TitleBar
        editor={view === 'editor'}
        logoUrl={LOGO_URL}
        projectName={projectName}
        projectPath={projectPath}
        dirty={dirty}
        shown={{
          media: !hidden.media || detached.media,
          timeline: !hidden.timeline || detached.timeline,
          inspector: !hidden.inspector || detached.inspector,
        }}
        onTogglePanel={togglePanel}
        mixerOpen={mixerOpen}
        onMixer={() => setMixerOpen((open) => !open)}
        onHome={() => void actions.goHome()}
        onExport={() => setExportOpen(true)}
        onCommandPalette={() => setPaletteOpen((open) => !open)}
        onPreferences={() => setPreferencesOpen(true)}
        nativeAvailable={nativeAvailable}
      />

      <div className="relative min-h-0 flex-1">
        <div ref={editorRef} aria-hidden={view !== 'editor'} className="flex h-full flex-col px-1.5 pb-1.5">
          <div ref={workspaceRef} className="flex min-h-0 flex-1 flex-col">
            <main
              className={`relative flex min-h-0 ${rowFiller ? (browserRow ? 'shrink-0' : 'flex-1') : ''}`}
              style={browserRow ? { height: fitted.browserHeight } : undefined}
            >
              {/*
                Each area has a wrapper that is always there, saying whether it
                is open (data-state), so a later transition has something to
                animate. What is inside is only mounted while it shows: a
                hidden area gives its width to the picture, and its border goes
                with it - a splitter for something that is not there is a
                handle that does nothing. The same goes for the border of an
                area that is filling the row: it has no size of its own to set.
              */}
              {(mediaDrawer || inspectorDrawer) && (
                <div data-testid="drawer-scrim" aria-hidden className="scf-scrim absolute inset-0 z-20 rounded-panel bg-black/45" onPointerDown={closeDrawers} />
              )}
              {mediaDrawer && (
                <div data-panel="media" data-state="open" data-drawer="true" className="absolute inset-y-0 left-0 z-30 flex min-h-0 shadow-2xl shadow-black/60" style={{ width: 'min(320px, 85%)' }}>
                  <PanelSlot edge="left" className="flex min-h-0 min-w-0 flex-1">
                    <MediaLibrary />
                  </PanelSlot>
                </div>
              )}
              <div data-panel="media" data-state={mediaHere && !mediaDrawer ? 'open' : 'closed'} className={`flex min-h-0 ${grows(rowFiller === 'media')}`}>
                {mediaHere && !mediaDrawer && (
                  <>
                    <PanelSlot edge="left" className={`flex min-h-0 ${grows(rowFiller === 'media')}`}>
                      <div
                        className={`flex min-h-0 ${grows(rowFiller === 'media')}`}
                        style={rowFiller === 'media' ? undefined : { width: fitted.mediaWidth }}
                      >
                        <MediaLibrary />
                      </div>
                    </PanelSlot>
                    {rowFiller !== 'media' && border('mediaWidth', t('layout.resizeMedia'), 'vertical', 1)}
                  </>
                )}
              </div>
              {rowFiller === 'viewer' && <PreviewViewport />}
              {inspectorDrawer && (
                <div data-panel="inspector" data-state="open" data-drawer="true" className="absolute inset-y-0 right-0 z-30 flex min-h-0 shadow-2xl shadow-black/60" style={{ width: 'min(340px, 85%)' }}>
                  <PanelSlot edge="right" className="flex min-h-0 min-w-0 flex-1">
                    <Inspector />
                  </PanelSlot>
                </div>
              )}
              <div
                data-panel="inspector"
                data-state={inspectorHere && !inspectorDrawer ? 'open' : 'closed'}
                className={`flex min-h-0 ${grows(rowFiller === 'inspector')}`}
              >
                {inspectorHere && !inspectorDrawer && (
                  <>
                    {rowFiller !== 'inspector' && border('inspectorWidth', t('layout.resizeInspector'), 'vertical', -1)}
                    <PanelSlot edge="right" className={`flex min-h-0 ${grows(rowFiller === 'inspector')}`}>
                      <div
                        className={`flex min-h-0 ${grows(rowFiller === 'inspector')}`}
                        style={rowFiller === 'inspector' ? undefined : { width: fitted.inspectorWidth }}
                      >
                        <Inspector />
                      </div>
                    </PanelSlot>
                  </>
                )}
              </div>
            </main>

            <div
              data-panel="timeline"
              data-state={timelineHere ? 'open' : 'closed'}
              className={`flex flex-col ${timelineGrows && timelineHere ? 'min-h-0 flex-1' : 'shrink-0'}`}
            >
              {timelineHere && (
                <>
                  {/* The border sizes the row above when that row has the
                      height of its own, and the timeline otherwise. */}
                  {browserRow
                    ? border('browserHeight', t('layout.resizeBrowser'), 'horizontal', 1)
                    : !timelineFills && border('timelineHeight', t('layout.resizeTimeline'), 'horizontal', -1)}
                  <PanelSlot edge="bottom" className={timelineGrows ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0'}>
                    <div
                      className={`flex gap-1.5 ${timelineGrows ? 'min-h-0 flex-1' : 'shrink-0'}`}
                      style={timelineGrows ? undefined : { height: fitted.timelineHeight }}
                    >
                      <div className="min-w-0 flex-1">
                        <Timeline />
                      </div>
                      {mixerDocked && (
                        <PanelSlot edge="right" className="flex min-h-0 max-w-[55%] shrink-0">
                          <Mixer onClose={() => setMixerOpen(false)} />
                        </PanelSlot>
                      )}
                    </div>
                  </PanelSlot>
                </>
              )}
            </div>

            {/* Everything is somewhere else: say so, and offer the way back,
                rather than a blank window. */}
            {nothingHere && (
              <section data-testid="editor-empty" className="panel min-h-0 flex-1">
                <PanelEmptyState icon={PictureInPicture2} title={t('panel.allAway')} hint={t('panel.allAwayHint')}>
                  <button
                    type="button"
                    className="tool-button mt-2 border border-panel-600"
                    onClick={() => {
                      useWorkspaceStore.getState().dockAll();
                      setHidden({ media: false, inspector: false, timeline: false });
                      if (folds) setRevealed({ media: true, inspector: true });
                    }}
                  >
                    {t('panel.bringBack')}
                  </button>
                </PanelEmptyState>
              </section>
            )}
          </div>

          {/*
            A detached panel renders here, into a window of its own. It is
            the same React tree and the same store - the window is opened
            by the page, so it shares this process (Layout/PanelWindow).
          */}
          {view === 'editor' && detached.viewer && (
            <PanelWindow panel="viewer" onClose={() => setDetached('viewer', false)} width={1100} height={720}>
              <PreviewViewport />
            </PanelWindow>
          )}
          {view === 'editor' && detached.timeline && (
            <PanelWindow panel="timeline" onClose={() => setDetached('timeline', false)} width={1400} height={480}>
              <div className="flex min-w-0 flex-1 gap-1.5">
                <div className="min-w-0 flex-1">
                  <Timeline />
                </div>
                {mixerDocked && (
                  // Never narrower than its header: that header shares the
                  // window's title strip with Windows' caption buttons, and
                  // squeezed under 300px its Ducking and close buttons went
                  // beneath them. The strips scroll instead.
                  <div className="flex min-h-0 min-w-[300px] max-w-[45%] shrink-0">
                    <Mixer onClose={() => setMixerOpen(false)} />
                  </div>
                )}
              </div>
            </PanelWindow>
          )}
          {view === 'editor' && detached.media && (
            <PanelWindow panel="media" onClose={() => setDetached('media', false)} width={560} height={760}>
              <MediaLibrary />
            </PanelWindow>
          )}
          {view === 'editor' && detached.inspector && (
            <PanelWindow panel="inspector" onClose={() => setDetached('inspector', false)} width={440} height={780}>
              {/* With nothing picked, a window this size says how to fill it
                  rather than holding one line at the top of an empty box. */}
              {nothingSelected ? (
                <section data-testid="inspector-empty" className="panel w-full">
                  {/* The header every panel's window has: it is the title
                      bar there, with the way back in it. */}
                  <header className="panel-header">
                    <span className="min-w-0 flex-1 truncate">{t('inspector.title')}</span>
                    <DetachButton panel="inspector" />
                  </header>
                  <PanelEmptyState icon={SlidersHorizontal} title={t('panel.noneSelected')} hint={t('panel.noneSelectedHint')} />
                </section>
              ) : (
                <Inspector />
              )}
            </PanelWindow>
          )}
          {view === 'editor' && mixerOpen && detached.mixer && (
            <PanelWindow panel="mixer" onClose={() => setDetached('mixer', false)} width={mixerWindowWidth} height={540}>
              <Mixer onClose={() => setMixerOpen(false)} />
            </PanelWindow>
          )}
          {exportPresence.mounted && <ExportDialog closing={exportPresence.closing} onClose={() => setExportOpen(false)} />}
          {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
          {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
          {captionsPresence.mounted && <GenerateCaptionsDialog closing={captionsPresence.closing} onClose={() => setCaptionsOpen(false)} />}
          {/* Text to speech lives in a window of its own now, not a modal, so
              the editor stays live while a voice is set up (TextToSpeechWindow). */}
          {view === 'editor' && ttsOpen && <TextToSpeechWindow onClose={() => setTtsOpen(false)} />}
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
      </div>

      <UnsavedChangesDialog />
      {/* Asked when a transition lacks footage: overlap, freeze or cancel. */}
      <TransitionDialog />
      {/* Outside the editor, which is inert behind the start screen: About works from there too. */}
      {licensesOpen && <FontLicensesDialog onClose={() => setLicensesOpen(false)} />}
      <RelinkDialog />
      {/* Captions being generated: a card in the corner, the editor still usable. */}
      {view === 'editor' && <CaptionProgress />}
      <Toaster />
      <TooltipLayer />
    </div>
  );
}
