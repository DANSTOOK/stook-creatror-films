import { useId } from 'react';
import type { CaptionTrackSettings, Clip } from '@shared/types';
import { framesToTimecode } from '@shared/utils/timecode';
import { useLanguageStore, useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { readingSpeed, rulesFor } from '@renderer/captions/rules';

/**
 * The inspector for a caption: its text, and how it stands against the
 * rules it was cut by.
 *
 * The text is the caption's own from the moment it is touched - line breaks
 * included: Enter starts a second line, and nothing re-flows what was typed.
 * Its timing is changed where a clip's is, on the timeline; here it is only
 * read. Under the text, the three numbers the rules are about: lines,
 * the longest line, and the reading speed - said plainly, and marked when
 * one is over, so a caption that will be hard to read is seen before the
 * audience sees it.
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
  const textId = useId();
  const statsId = useId();
  const text = clip.caption?.text ?? '';

  const rules = rulesFor(settings.preset, frame);
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const longest = Math.max(0, ...lines.map((line) => line.trim().length));
  const seconds = clip.durationFrames / frame.fps;
  const speed = readingSpeed(lines.map((line) => line.trim()), seconds);
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });

  const overLines = lines.length > rules.maxLines;
  const overLength = longest > rules.maxCharsPerLine;
  const overSpeed = speed > rules.maxCps + 1e-6;

  const stat = (label: string, value: string, over: boolean, testId: string): JSX.Element => (
    <div className="contents">
      <dt className="text-slate-400">{label}</dt>
      <dd data-testid={testId} data-over={over} className={`tabular-nums ${over ? 'font-semibold text-amber-200' : 'text-slate-200'}`}>
        {value}
      </dd>
    </div>
  );

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={textId} className="field-label">
          {t('caption.text')}
        </label>
        <textarea
          id={textId}
          data-testid="caption-text"
          rows={Math.min(6, Math.max(2, text.split('\n').length))}
          spellCheck
          lang={settings.language}
          aria-describedby={statsId}
          className="numeric-input h-auto min-h-[56px] resize-y py-1.5 leading-snug"
          value={text}
          onChange={(event) => setCaptionText(clip.id, event.target.value, `caption:${clip.id}:text`)}
        />
      </div>

      <dl id={statsId} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-2xs">
        {stat(t('caption.lines'), t('caption.ofMax', { value: lines.length, max: rules.maxLines }), overLines, 'caption-lines')}
        {stat(t('caption.longestLine'), t('caption.ofMaxChars', { value: longest, max: rules.maxCharsPerLine }), overLength, 'caption-length')}
        {stat(t('caption.readingSpeed'), t('caption.ofMaxSpeed', { value: number.format(speed), max: rules.maxCps }), overSpeed, 'caption-speed')}
        {stat(t('caption.in'), framesToTimecode(clip.startFrame, frame.fps), false, 'caption-in')}
        {stat(t('caption.out'), framesToTimecode(clip.startFrame + clip.durationFrames, frame.fps), false, 'caption-out')}
      </dl>

      {(overLines || overLength || overSpeed) && (
        <p role="status" className="text-2xs leading-relaxed text-amber-200" data-testid="caption-warning">
          {overSpeed ? t('caption.tooFast') : overLength ? t('caption.tooLong') : t('caption.tooManyLines')}
        </p>
      )}
      <p className="text-2xs leading-relaxed text-slate-400">{t('caption.hint')}</p>
    </div>
  );
}

export default CaptionTab;
