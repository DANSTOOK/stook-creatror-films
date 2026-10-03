import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Link2, ListPlus, Merge, Plus, Replace, ReplaceAll, Scissors, Search, SpellCheck, Trash2, TriangleAlert, Unlink, WandSparkles } from 'lucide-react';
import type { CaptionLanguage, Clip } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useLanguageStore, useT } from '@renderer/i18n';
import { hasNativeBridge } from '@renderer/media/importMedia';
import { notify } from '@renderer/notifications/notifications';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { captionSettingsOf } from '@renderer/captions/captionClips';
import { findInCaptions, type CaptionMatch } from '@renderer/captions/findReplace';
import { captionIssues, hasIssues, readingSpeed, rulesFor, type CaptionIssues, type CaptionRules } from '@renderer/captions/rules';
import { isLineBreakInput, useKeptCaret } from '@renderer/captions/useKeptCaret';
import { glossarySuggestions, normalizeGlossary } from '@renderer/captions/glossary';

/**
 * The Transcript: every caption of a track as a list - its times, its text,
 * and whether anything is wrong with it - with find and replace across them.
 *
 * It lives in the Library panel, beside Media, Titles and Transitions,
 * because of what it has to sit next to. Premiere's Text panel and Final
 * Cut's timeline index (with its Captions list and its search) are both on
 * the left, away from the inspector, so the list and the one caption's
 * detail are on screen together: pick a line here, change its style or see
 * its numbers there. Resolve puts the list inside the inspector, and the
 * two then take turns in one column. The list is also tall and narrow, the
 * shape of this panel.
 *
 * A row is a line of the film: click it and the playhead goes there; click
 * its text (or press Enter on it) and it is typed into in place, its lines
 * laid out by the rules as it changes. Enter finishes; Shift+Enter breaks
 * the line where the author wants it; Tab goes on to the next caption.
 *
 * A track can be started empty and typed - another language beside the one
 * transcribed - and each track says which language it is in. The project's
 * names and terms (its glossary) are kept here too, and a word in the
 * captions one letter away from one of them is offered for replacing
 * everywhere, in one undo step.
 */

interface RowData {
  clip: Clip;
  index: number;
  issues: CaptionIssues;
}

/** What is wrong with a caption, in words, for its tooltip and for a screen reader. */
function issueText(issues: CaptionIssues, clip: Clip, rules: CaptionRules, fps: number, t: ReturnType<typeof useT>, language: string): string {
  const seconds = clip.durationFrames / fps;
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const lines = (clip.caption?.text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const parts: string[] = [];
  if (issues.tooFast) parts.push(t('transcript.issueFast', { value: number.format(readingSpeed(lines, seconds)), max: rules.maxCps }));
  if (issues.tooShort) parts.push(t('transcript.issueShort', { value: number.format(seconds) }));
  if (issues.tooLong) parts.push(t('transcript.issueLong', { value: number.format(seconds), max: rules.maxSeconds }));
  if (issues.tooManyLines) parts.push(t('transcript.issueLines', { value: lines.length, max: rules.maxLines }));
  if (issues.lineTooLong) parts.push(t('transcript.issueLength', { value: Math.max(0, ...lines.map((line) => line.length)), max: rules.maxCharsPerLine }));
  return parts.join(' ');
}

/** A caption's text with the matches of the search marked. */
function Marked({ text, matches, current }: { text: string; matches: readonly CaptionMatch[]; current: CaptionMatch | null }): JSX.Element {
  if (matches.length === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let at = 0;
  matches.forEach((match, index) => {
    if (match.index > at) parts.push(<span key={`t${index}`}>{text.slice(at, match.index)}</span>);
    const isCurrent = current !== null && current.clipId === match.clipId && current.occurrence === match.occurrence;
    parts.push(
      <mark key={`m${index}`} data-current={isCurrent} className={`rounded-sm px-px ${isCurrent ? 'bg-amber-300 text-panel-950' : 'bg-amber-300/30 text-slate-100'}`}>
        {text.slice(match.index, match.index + match.length)}
      </mark>,
    );
    at = match.index + match.length;
  });
  if (at < text.length) parts.push(<span key="tail">{text.slice(at)}</span>);
  return <>{parts}</>;
}

interface RowProps {
  row: RowData;
  fps: number;
  active: boolean;
  selected: boolean;
  editing: boolean;
  matches: readonly CaptionMatch[];
  current: CaptionMatch | null;
  issueLabel: string;
  language: CaptionLanguage;
  onPick(id: string): void;
  onEdit(id: string | null, next?: 1 | -1): void;
  onMenu(event: React.MouseEvent, id: string): void;
}

const Row = memo(function Row({ row, fps, active, selected, editing, matches, current, issueLabel, language, onPick, onEdit, onMenu }: RowProps): JSX.Element {
  const { clip, index } = row;
  const setCaptionText = useProjectStore((state) => state.setCaptionText);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const text = clip.caption?.text ?? '';
  const keepCaret = useKeptCaret(textRef, text);
  const warned = hasIssues(row.issues);

  useEffect(() => {
    if (!editing) return;
    const element = textRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  return (
    <li
      data-testid="transcript-row"
      data-clip={clip.id}
      data-active={active}
      data-selected={selected}
      data-warning={warned}
      aria-current={active ? 'true' : undefined}
      className={`scf-transcript-row group relative flex gap-2 border-b border-panel-800 px-2 py-1.5 ${selected ? 'bg-accent/15' : active ? 'bg-panel-800' : 'hover:bg-panel-800/60'}`}
      onContextMenu={(event) => onMenu(event, clip.id)}
    >
      {/* The playhead is on this one: the same line down the side as the selected tab's. */}
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <button
        type="button"
        data-testid="transcript-time"
        className="flex w-[62px] shrink-0 flex-col items-start rounded-control text-left text-2xs leading-tight tabular-nums text-slate-400 hover:text-slate-200"
        onClick={() => onPick(clip.id)}
        aria-label={`${index + 1}. ${framesToTimecode(clip.startFrame, fps)}`}
      >
        <span className="text-slate-300">{index + 1}</span>
        <span>{framesToTimecode(clip.startFrame, fps).slice(3)}</span>
        <span>{framesToTimecode(clip.startFrame + clip.durationFrames, fps).slice(3)}</span>
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            ref={textRef}
            data-testid="transcript-edit"
            rows={Math.max(2, text.split('\n').length)}
            spellCheck
            lang={language}
            aria-label={`${index + 1}`}
            className="numeric-input h-auto w-full resize-none py-1 text-xs leading-snug"
            value={text}
            onChange={(event) => {
              keepCaret();
              setCaptionText(clip.id, event.target.value, `caption:${clip.id}:text`, isLineBreakInput(event));
            }}
            onBlur={() => onEdit(null)}
            onKeyDown={(event) => {
              // Nothing here is a timeline shortcut while it is being typed into.
              event.stopPropagation();
              if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault();
                onEdit(null);
              } else if (event.key === 'Tab') {
                event.preventDefault();
                onEdit(clip.id, event.shiftKey ? -1 : 1);
              }
            }}
          />
        ) : (
          <button
            type="button"
            data-testid="transcript-text"
            lang={language}
            className="block w-full whitespace-pre-wrap break-words rounded-control text-left text-xs leading-snug text-slate-100"
            onClick={() => {
              onPick(clip.id);
              onEdit(clip.id);
            }}
          >
            {text.trim() === '' ? <span className="text-slate-400">…</span> : <Marked text={text} matches={matches} current={current} />}
          </button>
        )}
      </div>
      {warned && (
        <span data-testid="transcript-warning" className="mt-0.5 shrink-0 text-amber-300" role="img" aria-label={issueLabel} {...tip(issueLabel)}>
          <TriangleAlert size={13} aria-hidden />
        </span>
      )}
    </li>
  );
});

/** Ask the application menu for one of its commands, as a click on it would. */
const menuCommand = (id: string): void => {
  if (hasNativeBridge()) window.filmora.appMenuInvoke(id);
};

export function TranscriptPanel(): JSX.Element {
  const t = useT();
  const uiLanguage = useLanguageStore((state) => state.language);
  const tracks = useProjectStore((state) => state.project.tracks);
  const clips = useProjectStore((state) => state.project.clips);
  const parked = useProjectStore((state) => state.project.parkedCaptions);
  const fps = useProjectStore((state) => state.project.fps);
  const width = useProjectStore((state) => state.project.width);
  const height = useProjectStore((state) => state.project.height);
  const selectedId = useProjectStore((state) => (state.ui.selectedClipIds.length === 1 ? state.ui.selectedClipIds[0] : null));
  const glossary = useProjectStore((state) => state.project.glossary);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const captionTracks = useMemo(() => tracks.filter((track) => track.type === 'captions').sort((a, b) => b.order - a.order), [tracks]);
  const [chosenTrack, setChosenTrack] = useState<string | null>(null);
  // The track of the caption that is selected, else the one chosen here, else the top one.
  const selectedTrack = selectedId ? clips[selectedId]?.caption && clips[selectedId].trackId : null;
  const track = captionTracks.find((candidate) => candidate.id === (selectedTrack || chosenTrack)) ?? captionTracks.find((candidate) => candidate.id === chosenTrack) ?? captionTracks[0];
  const trackId = track?.id ?? null;
  useEffect(() => {
    if (selectedTrack) setChosenTrack(selectedTrack);
  }, [selectedTrack]);

  const settings = useMemo(() => captionSettingsOf(track), [track]);
  const rules = useMemo(() => rulesFor(settings.preset, { width, height }), [settings.preset, width, height]);
  const rows = useMemo<RowData[]>(() => {
    if (!trackId) return [];
    return Object.values(clips)
      .filter((clip) => clip.trackId === trackId && clip.caption)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
      .map((clip, index) => ({ clip, index, issues: captionIssues(clip.caption?.text ?? '', clip.durationFrames / fps, rules) }));
  }, [clips, trackId, fps, rules]);
  const parkedCount = useMemo(() => Object.values(parked ?? {}).filter((clip) => clip.trackId === trackId).length, [parked, trackId]);
  const suggestions = useMemo(() => glossarySuggestions(rows.map((row) => row.clip), glossary ?? []), [rows, glossary]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryText, setGlossaryText] = useState('');
  useEffect(() => {
    if (!glossaryOpen) setGlossaryText((glossary ?? []).join('\n'));
  }, [glossary, glossaryOpen]);
  const warnings = rows.filter((row) => hasIssues(row.issues)).length;

  // The caption under the playhead. Asked of the store with the rows at
  // hand, so the panel is drawn again when that caption changes, not on
  // every frame of playback.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const activeId = useProjectStore((state) => {
    const frame = state.project.currentFrame;
    const list = rowsRef.current;
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const { clip } = list[middle];
      if (frame < clip.startFrame) high = middle - 1;
      else if (frame >= clip.startFrame + clip.durationFrames) low = middle + 1;
      else return clip.id;
    }
    return null;
  });

  /* Find and replace ---------------------------------------------------------- */
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [cursor, setCursor] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(
    () => (finding ? findInCaptions(rows.map((row) => ({ id: row.clip.id, text: row.clip.caption?.text ?? '' })), query, { matchCase }) : []),
    [finding, rows, query, matchCase],
  );
  const current = matches.length > 0 ? matches[Math.min(cursor, matches.length - 1)] : null;
  const matchesByClip = useMemo(() => {
    const map = new Map<string, CaptionMatch[]>();
    for (const match of matches) {
      const list = map.get(match.clipId);
      if (list) list.push(match);
      else map.set(match.clipId, [match]);
    }
    return map;
  }, [matches]);

  const listRef = useRef<HTMLUListElement>(null);
  const reveal = useCallback((id: string) => {
    listRef.current?.querySelector(`[data-clip="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, []);

  const [editingId, setEditingId] = useState<string | null>(null);

  /** The playhead and the selection go to a caption. */
  const pick = useCallback((id: string) => {
    const store = useProjectStore.getState();
    const clip = store.project.clips[id];
    if (!clip) return;
    store.setPlaying(false);
    store.setCurrentFrame(clip.startFrame);
    store.selectClips([id]);
    store.revealFrames(clip.startFrame, clip.startFrame + clip.durationFrames);
  }, []);

  const edit = useCallback(
    (id: string | null, next?: 1 | -1) => {
      if (id === null || next === undefined) {
        setEditingId(id);
        return;
      }
      const list = rowsRef.current;
      const at = list.findIndex((row) => row.clip.id === id);
      const target = list[at + next];
      if (!target) {
        setEditingId(null);
        return;
      }
      pick(target.clip.id);
      setEditingId(target.clip.id);
      reveal(target.clip.id);
    },
    [pick, reveal],
  );

  // The list keeps up with the playhead, unless a caption is being typed into.
  useEffect(() => {
    if (activeId && editingId === null) reveal(activeId);
  }, [activeId, editingId, reveal]);

  const goToMatch = (index: number): void => {
    if (matches.length === 0) return;
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setCursor(wrapped);
    pick(matches[wrapped].clipId);
    reveal(matches[wrapped].clipId);
  };

  const replaceOne = (): void => {
    if (!trackId || !current) return;
    const done = useProjectStore.getState().replaceInCaptions(trackId, query, replacement, { matchCase, only: { clipId: current.clipId, occurrence: current.occurrence } });
    // The match after it takes its number; nothing to skip.
    if (done > 0) setCursor((value) => Math.min(value, Math.max(0, matches.length - 2)));
  };

  const replaceAll = (): void => {
    if (!trackId || matches.length === 0) return;
    const done = useProjectStore.getState().replaceInCaptions(trackId, query, replacement, { matchCase });
    setCursor(0);
    notify(t('transcript.replaced', { count: done }), 'success');
  };

  const fixTiming = (): void => {
    if (!trackId) return;
    const before = warnings;
    const fixed = useProjectStore.getState().fixCaptionTiming(trackId);
    if (fixed === 0) {
      notify(t(before > 0 ? 'transcript.fixedNoneLeft' : 'transcript.fixedNothing', { count: before }), 'info');
      return;
    }
    const { project } = useProjectStore.getState();
    const left = Object.values(project.clips).filter(
      (clip) => clip.trackId === trackId && clip.caption && hasIssues(captionIssues(clip.caption.text, clip.durationFrames / project.fps, rules)),
    ).length;
    notify(t(left > 0 ? 'transcript.fixedSome' : 'transcript.fixedAll', { count: fixed, left }), 'success');
  };

  /** A new, empty captions track, in the language of the interface; it becomes the one shown. */
  const newTrack = (): void => {
    const id = useProjectStore.getState().addEmptyCaptionTrack({ preset: settings.preset, language: uiLanguage === 'en' ? 'en' : 'es' });
    setChosenTrack(id);
  };

  /** A caption at the playhead, typed into straight away. */
  const addCaption = (): void => {
    if (!trackId) return;
    const store = useProjectStore.getState();
    const id = store.addCaptionAt(trackId, store.project.currentFrame, '');
    if (!id) {
      notify(t('transcript.addCaptionBusy'), 'info');
      return;
    }
    setEditingId(id);
    window.setTimeout(() => reveal(id), 0);
  };

  const takeSuggestion = (term: string, found: string): void => {
    if (!trackId) return;
    const done = useProjectStore.getState().replaceInCaptions(trackId, found, term, { matchCase: true, wholeWord: true });
    if (done > 0) notify(t('transcript.glossaryReplaced', { count: done, found, term }), 'success');
  };

  const rowMenu = useCallback(
    (event: React.MouseEvent, id: string) => {
      const store = useProjectStore.getState();
      const clip = store.project.clips[id];
      if (!clip) return;
      const list = rowsRef.current;
      const at = list.findIndex((row) => row.clip.id === id);
      const frame = store.project.currentFrame;
      const inside = frame > clip.startFrame && frame < clip.startFrame + clip.durationFrames;
      const linked = Boolean(clip.caption?.link);
      const items: ContextMenuItem[] = [
        { label: t('transcript.split'), icon: Scissors, disabled: !inside, onSelect: () => store.razorAtFrame(frame, [id]) },
        { label: t('transcript.mergePrevious'), icon: Merge, disabled: at <= 0, onSelect: () => void store.mergeCaptions(id, 'previous') },
        { label: t('transcript.mergeNext'), icon: Merge, disabled: at === list.length - 1, onSelect: () => void store.mergeCaptions(id, 'next') },
        { separator: true },
        {
          label: t(linked ? 'caption.unlink' : 'caption.link'),
          icon: linked ? Unlink : Link2,
          onSelect: () => {
            if (linked) store.unlinkCaptionsFromClips([id]);
            else if (store.linkCaptionsToClips([id]) === 0) notify(t('caption.nothingToFollow'), 'warning');
          },
        },
        { separator: true },
        { label: t('transcript.delete'), icon: Trash2, onSelect: () => store.removeClips([id]) },
      ];
      openMenu(event, items, { label: t('library.captions') });
    },
    [openMenu, t],
  );

  if (!track || !trackId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center" data-testid="transcript-empty">
        <p className="text-xs leading-relaxed text-slate-300">{t('transcript.empty')}</p>
        <div className="flex flex-col gap-1.5">
          <button type="button" className="tool-button h-control border border-panel-600 px-3" data-testid="transcript-generate" onClick={() => menuCommand('generateCaptions')}>
            {t('menu.generateCaptions')}
          </button>
          <button type="button" className="tool-button h-control border border-panel-600 px-3" data-testid="transcript-import" onClick={() => menuCommand('importCaptions')}>
            {t('menu.importCaptions')}
          </button>
          <button type="button" className="tool-button h-control border border-panel-600 px-3" data-testid="transcript-new-track" onClick={newTrack} {...tip(t('transcript.newTrack'), { hint: t('transcript.newTrackHint') })}>
            {t('transcript.newTrack')}
          </button>
        </div>
      </div>
    );
  }

  const selectedRow = rows.find((row) => row.clip.id === selectedId);
  const selectedAt = selectedRow ? rows.indexOf(selectedRow) : -1;
  const playhead = useProjectStore.getState().project.currentFrame;
  const canSplit = Boolean(selectedRow && activeId === selectedRow.clip.id && playhead > selectedRow.clip.startFrame);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="transcript-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-panel-800 px-2 py-1.5">
        {captionTracks.length > 1 ? (
          <select
            className="numeric-input h-control-dense min-w-0 flex-1 text-xs"
            data-testid="transcript-track"
            aria-label={t('transcript.track')}
            value={trackId}
            onChange={(event) => setChosenTrack(event.target.value)}
          >
            {captionTracks.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-300" data-testid="transcript-count">
            {t('transcript.count', { count: rows.length })}
          </span>
        )}
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0"
          data-testid="transcript-split"
          disabled={!canSplit}
          onClick={() => selectedRow && useProjectStore.getState().razorAtFrame(useProjectStore.getState().project.currentFrame, [selectedRow.clip.id])}
          {...tip(t('transcript.split'), { hint: t('transcript.splitHint') })}
        >
          <Scissors size={13} />
        </button>
        <button
          type="button"
          className="tool-button tool-button-dense w-6 px-0"
          data-testid="transcript-merge"
          disabled={!selectedRow || selectedAt === rows.length - 1}
          onClick={() => selectedRow && void useProjectStore.getState().mergeCaptions(selectedRow.clip.id, 'next')}
          {...tip(t('transcript.mergeNext'), { hint: t('transcript.mergeHint') })}
        >
          <Merge size={13} />
        </button>
        <button
          type="button"
          className={`tool-button tool-button-dense gap-1 px-1.5 text-2xs tabular-nums ${warnings > 0 ? 'text-amber-300' : ''}`}
          data-testid="transcript-fix"
          onClick={fixTiming}
          {...tip(t('transcript.fixTiming'), { hint: t('transcript.fixTimingHint') })}
        >
          <WandSparkles size={13} />
          {warnings > 0 && <span data-testid="transcript-warnings">{warnings}</span>}
        </button>
        <button type="button" className="tool-button tool-button-dense w-6 px-0" data-testid="transcript-add" onClick={addCaption} {...tip(t('transcript.addCaption'))}>
          <Plus size={13} />
        </button>
        <button
          type="button"
          className={`tool-button tool-button-dense w-6 px-0 ${glossaryOpen ? 'tool-button-active' : ''}`}
          data-testid="transcript-glossary-toggle"
          aria-pressed={glossaryOpen}
          onClick={() => setGlossaryOpen((value) => !value)}
          {...tip(t('transcript.glossary'), { hint: t('transcript.glossaryHint') })}
        >
          <SpellCheck size={13} />
        </button>
        <button
          type="button"
          className={`tool-button tool-button-dense w-6 px-0 ${finding ? 'tool-button-active' : ''}`}
          data-testid="transcript-find-toggle"
          aria-pressed={finding}
          onClick={() => {
            setFinding((value) => !value);
            window.setTimeout(() => findRef.current?.focus(), 0);
          }}
          {...tip(t('transcript.find'), { shortcut: 'Ctrl+F' })}
        >
          <Search size={13} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-panel-800 px-2 py-1">
        <select
          className="numeric-input h-control-dense min-w-0 flex-1 text-2xs"
          data-testid="transcript-language"
          aria-label={t('transcript.language')}
          value={settings.language}
          onChange={(event) => useProjectStore.getState().setCaptionLanguage(trackId, event.target.value === 'en' ? 'en' : 'es')}
        >
          <option value="es">{t('captions.languageNameEs')}</option>
          <option value="en">{t('captions.languageNameEn')}</option>
        </select>
        <button type="button" className="tool-button tool-button-dense w-6 px-0" data-testid="transcript-new-track" onClick={newTrack} {...tip(t('transcript.newTrack'), { hint: t('transcript.newTrackHint') })}>
          <ListPlus size={13} />
        </button>
      </div>

      {glossaryOpen && (
        <div className="shrink-0 space-y-1 border-b border-panel-800 px-2 py-1.5" data-testid="transcript-glossary">
          <textarea
            data-testid="transcript-glossary-text"
            aria-label={t('transcript.glossary')}
            rows={3}
            spellCheck={false}
            className="numeric-input min-h-[52px] w-full resize-y py-1 text-xs leading-snug"
            value={glossaryText}
            onChange={(event) => setGlossaryText(event.target.value)}
            onBlur={() => useProjectStore.getState().setGlossary(normalizeGlossary(glossaryText))}
            onKeyDown={(event) => event.stopPropagation()}
          />
          <p className="text-2xs leading-relaxed text-slate-400">{t('transcript.glossaryHint')}</p>
          {suggestions.length === 0 && (glossary ?? []).length > 0 && (
            <p className="text-2xs leading-relaxed text-slate-400" data-testid="transcript-glossary-none" role="status">
              {t('transcript.glossaryNone')}
            </p>
          )}
        </div>
      )}

      {suggestions.length > 0 && (
        <ul className="shrink-0 space-y-0.5 border-b border-panel-800 px-2 py-1" data-testid="transcript-suggestions" aria-label={t('transcript.glossary')}>
          {suggestions.slice(0, 5).map((suggestion) => (
            <li key={`${suggestion.term}|${suggestion.found}`} className="flex items-center gap-1 text-2xs text-slate-300" data-testid="transcript-glossary-suggestion">
              <span className="min-w-0 flex-1 truncate">{t('transcript.glossarySuggestion', { found: suggestion.found, term: suggestion.term, count: suggestion.count })}</span>
              <button type="button" className="tool-button tool-button-dense shrink-0 px-1.5 text-2xs" data-testid="transcript-glossary-replace" onClick={() => takeSuggestion(suggestion.term, suggestion.found)}>
                {t('transcript.glossaryReplace')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {finding && (
        <div className="shrink-0 space-y-1 border-b border-panel-800 px-2 py-1.5" data-testid="transcript-findbar" role="search">
          <div className="flex items-center gap-1">
            <input
              ref={findRef}
              type="search"
              className="numeric-input h-control-dense min-w-0 flex-1 text-xs"
              data-testid="transcript-find"
              placeholder={t('transcript.find')}
              aria-label={t('transcript.find')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(0);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') goToMatch(cursor + (event.shiftKey ? -1 : 1));
                if (event.key === 'Escape') setFinding(false);
              }}
            />
            <span className="w-[52px] shrink-0 text-right text-2xs tabular-nums text-slate-400" data-testid="transcript-match-count" role="status">
              {query.trim() === '' ? '' : matches.length === 0 ? t('transcript.noMatches') : t('transcript.matchOf', { current: Math.min(cursor, matches.length - 1) + 1, total: matches.length })}
            </span>
            <button type="button" className="tool-button tool-button-dense w-6 px-0" data-testid="transcript-find-previous" disabled={matches.length === 0} onClick={() => goToMatch(cursor - 1)} {...tip(t('transcript.previousMatch'), { shortcut: 'Shift+Enter' })}>
              <ChevronUp size={13} />
            </button>
            <button type="button" className="tool-button tool-button-dense w-6 px-0" data-testid="transcript-find-next" disabled={matches.length === 0} onClick={() => goToMatch(cursor + 1)} {...tip(t('transcript.nextMatch'), { shortcut: 'Enter' })}>
              <ChevronDown size={13} />
            </button>
            <button
              type="button"
              className={`tool-button tool-button-dense w-6 px-0 ${matchCase ? 'tool-button-active' : ''}`}
              data-testid="transcript-match-case"
              aria-pressed={matchCase}
              onClick={() => {
                setMatchCase((value) => !value);
                setCursor(0);
              }}
              {...tip(t('transcript.matchCase'))}
            >
              <CaseSensitive size={14} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              className="numeric-input h-control-dense min-w-0 flex-1 text-xs"
              data-testid="transcript-replace"
              placeholder={t('transcript.replaceWith')}
              aria-label={t('transcript.replaceWith')}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') replaceOne();
                if (event.key === 'Escape') setFinding(false);
              }}
            />
            <button type="button" className="tool-button tool-button-dense w-6 px-0" data-testid="transcript-replace-one" disabled={!current} onClick={replaceOne} {...tip(t('transcript.replaceOne'))}>
              <Replace size={13} />
            </button>
            <button type="button" className="tool-button tool-button-dense w-6 px-0" data-testid="transcript-replace-all" disabled={matches.length === 0} onClick={replaceAll} {...tip(t('transcript.replaceAll'))}>
              <ReplaceAll size={13} />
            </button>
          </div>
        </div>
      )}

      <ul
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="transcript-list"
        aria-label={t('library.captions')}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            event.stopPropagation();
            setFinding(true);
            window.setTimeout(() => findRef.current?.focus(), 0);
          }
        }}
      >
        {rows.length === 0 && (
          <li className="px-3 py-4 text-center text-2xs leading-relaxed text-slate-400" data-testid="transcript-empty-track">
            {t('transcript.emptyTrack')}
          </li>
        )}
        {rows.map((row) => (
          <Row
            key={row.clip.id}
            row={row}
            fps={fps}
            active={row.clip.id === activeId}
            selected={row.clip.id === selectedId}
            editing={row.clip.id === editingId}
            matches={matchesByClip.get(row.clip.id) ?? NO_MATCHES}
            current={current && current.clipId === row.clip.id ? current : null}
            issueLabel={hasIssues(row.issues) ? issueText(row.issues, row.clip, rules, fps, t, uiLanguage) : ''}
            language={settings.language}
            onPick={pick}
            onEdit={edit}
            onMenu={rowMenu}
          />
        ))}
      </ul>

      {parkedCount > 0 && (
        <p className="shrink-0 border-t border-panel-800 px-2 py-1.5 text-2xs leading-relaxed text-slate-400" data-testid="transcript-parked" role="status">
          {t('transcript.parked', { count: parkedCount })}
        </p>
      )}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </div>
  );
}

const NO_MATCHES: readonly CaptionMatch[] = [];

export default TranscriptPanel;
