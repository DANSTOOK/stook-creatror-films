import { useId, useRef } from 'react';
import { Link2, Unlink } from 'lucide-react';
import type { CaptionTrackSettings, Clip } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { useLanguageStore, useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { captionIssues, hasIssues, readingSpeed, rulesFor } from '@renderer/captions/rules';
import { isLineBreakInput, useKeptCaret } from '@renderer/captions/useKeptCaret';
import { notify } from '@renderer/notifications/notifications';

/**
 * The inspector for a caption: its text, how it stands against the rules
 * it was cut by, and what it is tied to.
 *
 * Its lines are laid out by the rules as the text changes - one line while
 * it fits, two at the best break - until Enter is pressed: then the breaks
 * are the author's and are left alone, and the switch under the text hands
 * them back to the rules. Its timing is changed where a clip's is, on the
 * timeline; here it is only read, and "Fix timing" does what can safely be
 * done about a caption that is up too briefly or too close to the next.
 *
 * A caption made from the sound follows the clip its words are in
 * (captions/follow.ts); the last row says which, and can set it free.
 */
export interface CaptionTabProps {
  clip: Clip;
  settings: CaptionTrackSettings;
  frame: { width: number; height: number; fps: number };
}

export function CaptionTab({ clip, settings, frame }: CaptionTabProps): JSX.Element {
  const t = useT();
  const language = useLanguageStore((state) => state.language);
  const setCaptionText = useProjectStore((state) => state.setCaptionText);
  const setCaptionBreaks = useProjectStore((state) => state.setCaptionBreaks);
  const fixCaptionTiming = useProjectStore((state) => state.fixCaptionTiming);
  const linkCaptionsToClips = useProjectStore((state) => state.linkCaptionsToClips);
  const unlinkCaptionsFromClips = useProjectStore((state) => state.unlinkCaptionsFromClips);
  const anchorName = useProjectStore((state) => (clip.caption?.link ? state.project.clips[clip.caption.link.clipId]?.name ?? null : null));
  const textId = useId();
  const statsId = useId();
  const breaksId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const text = clip.caption?.text ?? '';
  const keepCaret = useKeptCaret(textRef, text);

  const rules = rulesFor(settings.preset, frame);
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const longest = Math.max(0, ...lines.map((line) => line.trim().length));
  const seconds = clip.durationFrames / frame.fps;
  const speed = readingSpeed(lines.map((line) => line.trim()), seconds);
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const issues = captionIssues(text, seconds, rules);
  const manual = clip.caption?.manualBreaks === true;
  const linked = Boolean(clip.caption?.link);

  const stat = (label: string, value: string, over: boolean, testId: string): JSX.Element => (
    <div className="contents">
      <dt className="text-slate-400">{label}</dt>
      <dd data-testid={testId} data-over={over} className={`tabular-nums ${over ? 'font-semibold text-amber-200' : 'text-slate-200'}`}>
        {value}
      </dd>
    </div>
  );

  const warning = issues.tooFast
    ? t('caption.tooFast')
    : issues.lineTooLong
      ? t('caption.tooLong')
      : issues.tooManyLines
        ? t('caption.tooManyLines')
        : issues.tooShort
          ? t('caption.tooShort')
          : issues.tooLong
            ? t('caption.tooLongTime')
            : null;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={textId} className="field-label">
          {t('caption.text')}
        </label>
        <textarea
          ref={textRef}
          id={textId}
          data-testid="caption-text"
          rows={Math.min(6, Math.max(2, text.split('\n').length))}
          spellCheck
          lang={settings.language}
          aria-describedby={statsId}
          className="numeric-input h-auto min-h-[56px] resize-y py-1.5 leading-snug"
          value={text}
          onChange={(event) => {
            keepCaret();
            setCaptionText(clip.id, event.target.value, `caption:${clip.id}:text`, isLineBreakInput(event));
          }}
        />
        <label htmlFor={breaksId} className="flex items-start gap-2 text-2xs leading-relaxed text-slate-300">
          <input
            id={breaksId}
            type="checkbox"
            role="switch"
            className="mt-px"
            data-testid="caption-auto-breaks"
            checked={!manual}
            onChange={(event) => setCaptionBreaks(clip.id, !event.target.checked)}
          />
          <span>
            {t('caption.autoBreaks')}
            <span className="block text-slate-400">{t(manual ? 'caption.autoBreaksOff' : 'caption.autoBreaksOn')}</span>
          </span>
        </label>
      </div>

      <dl id={statsId} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-2xs">
        {stat(t('caption.lines'), t('caption.ofMax', { value: lines.length, max: rules.maxLines }), issues.tooManyLines, 'caption-lines')}
        {stat(t('caption.longestLine'), t('caption.ofMaxChars', { value: longest, max: rules.maxCharsPerLine }), issues.lineTooLong, 'caption-length')}
        {stat(t('caption.readingSpeed'), t('caption.ofMaxSpeed', { value: number.format(speed), max: rules.maxCps }), issues.tooFast, 'caption-speed')}
        {stat(t('caption.duration'), t('caption.seconds', { value: number.format(seconds) }), issues.tooShort || issues.tooLong, 'caption-duration')}
        {stat(t('caption.in'), framesToTimecode(clip.startFrame, frame.fps), false, 'caption-in')}
        {stat(t('caption.out'), framesToTimecode(clip.startFrame + clip.durationFrames, frame.fps), false, 'caption-out')}
      </dl>

      {hasIssues(issues) && warning && (
        <div className="space-y-1.5">
          <p role="status" className="text-2xs leading-relaxed text-amber-200" data-testid="caption-warning">
            {warning}
          </p>
          <button
            type="button"
            className="tool-button h-control-dense border border-panel-600 px-2 text-2xs"
            data-testid="caption-fix-timing"
            onClick={() => {
              const fixed = fixCaptionTiming(clip.trackId, [clip.id]);
              notify(t(fixed > 0 ? 'transcript.fixedOne' : 'transcript.fixedNone'), fixed > 0 ? 'success' : 'info');
            }}
          >
            {t('transcript.fixTiming')}
          </button>
        </div>
      )}

      <div className="flex items-start justify-between gap-2 border-t border-panel-800 pt-3">
        <p className="min-w-0 text-2xs leading-relaxed text-slate-400" data-testid="caption-link" data-linked={linked}>
          {linked ? t('caption.follows', { name: anchorName ?? '…' }) : t('caption.free')}
        </p>
        <button
          type="button"
          className="tool-button h-control-dense shrink-0 border border-panel-600 px-2 text-2xs"
          data-testid="caption-link-toggle"
          onClick={() => {
            if (linked) unlinkCaptionsFromClips([clip.id]);
            else if (linkCaptionsToClips([clip.id]) === 0) notify(t('caption.nothingToFollow'), 'warning');
          }}
        >
          {linked ? <Unlink size={12} aria-hidden /> : <Link2 size={12} aria-hidden />}
          {t(linked ? 'caption.unlink' : 'caption.link')}
        </button>
      </div>

      <p className="text-2xs leading-relaxed text-slate-400">{t('caption.hint')}</p>
    </div>
  );
}

export default CaptionTab;
