import { useId } from 'react';
import type { CaptionLook, CaptionTrackSettings, Track } from '@shared/types';
import { useT, type MessageKey } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { BUNDLED_FONTS, isBundledFamily, isFamilyMissing } from '@renderer/text/fonts';
import { FALLBACK_FAMILY } from '@renderer/text/titleStyle';
import { useLocalFamilies } from '@renderer/text/useLocalFamilies';
import { captionStyle } from '@renderer/captions/captionRender';
import { lookOf, MAX_CAPTION_SIZE, MIN_CAPTION_SIZE, presetLook } from '@renderer/captions/look';
import { ColorRow, FieldRow } from './TitleTab';
import { Section, SliderRow, type SectionProps } from './rows';

/**
 * The Style tab of a caption: how every caption on its track looks.
 *
 * The track's, not the caption's - Resolve styles a subtitle track and
 * Premiere a caption track for the same reason: captions are read as a set.
 * So the tab says whose look it is, and a change shows on all of them at
 * once, in the viewer and in the export alike (they are one picture).
 *
 * A preset first - Classic or Social, which is the look and the line rules
 * together - then what can be changed from it: the font (the three that
 * come with the app, or any on this computer), the size (automatic until a
 * number is asked for), the colour, an outline, a band behind the text, and
 * the bottom or the top of the title-safe area.
 */
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

export interface CaptionStyleTabProps {
  track: Track;
  settings: CaptionTrackSettings;
  frame: { width: number; height: number };
  sectionProps(id: string): Pick<SectionProps, 'id' | 'open' | 'onOpenChange'>;
}

export function CaptionStyleTab({ track, settings, frame, sectionProps }: CaptionStyleTabProps): JSX.Element {
  const t = useT();
  const setCaptionLook = useProjectStore((state) => state.setCaptionLook);
  const setCaptionPreset = useProjectStore((state) => state.setCaptionPreset);
  const families = useLocalFamilies();
  const presetId = useId();
  const familyId = useId();
  const weightId = useId();
  const autoSizeId = useId();

  const look = lookOf(settings);
  const defaults = presetLook(settings.preset);
  // The size it is drawn at now, automatic or not: where the slider starts from.
  const drawnSize = captionStyle(settings, frame).fontSize;
  const change = (patch: Partial<CaptionLook>, control: string | false): void =>
    setCaptionLook(track.id, patch, control ? `caption-look:${track.id}:${control}` : undefined);

  const missing = isFamilyMissing(look.fontFamily);
  const bundled = BUNDLED_FONTS.find((font) => font.family === look.fontFamily);
  const weights = WEIGHTS.filter((weight) => !bundled || (weight >= bundled.minWeight && weight <= bundled.maxWeight));
  const systemFamilies = families ? [...families].filter((family) => !isBundledFamily(family)).sort((a, b) => a.localeCompare(b)) : [];
  const listed = isBundledFamily(look.fontFamily) || systemFamilies.includes(look.fontFamily);

  return (
    <>
      <p className="border-b border-panel-800 px-3 py-2 text-2xs leading-relaxed text-slate-400" data-testid="caption-style-scope">
        {t('captionStyle.scope', { name: track.name })}
      </p>

      <Section {...sectionProps('captionPreset')} title={t('captionStyle.sectionPreset')} onReset={settings.look ? () => setCaptionLook(track.id, null) : undefined}>
        <FieldRow label={t('captionStyle.preset')} htmlFor={presetId}>
          <select
            id={presetId}
            data-testid="caption-style-preset"
            className="numeric-input h-control-dense min-w-0 flex-1"
            value={settings.preset}
            onChange={(event) => setCaptionPreset(track.id, event.target.value === 'social' ? 'social' : 'classic')}
          >
            <option value="classic">{t('captionStyle.presetClassic')}</option>
            <option value="social">{t('captionStyle.presetSocial')}</option>
          </select>
        </FieldRow>
        <p className="text-2xs leading-relaxed text-slate-400">{t(settings.preset === 'social' ? 'captionStyle.presetSocialHint' : 'captionStyle.presetClassicHint')}</p>
      </Section>

      <Section
        {...sectionProps('captionFont')}
        title={t('title.sectionFont')}
        onReset={() => change({ fontFamily: defaults.fontFamily, fontWeight: defaults.fontWeight, fontSize: defaults.fontSize, color: defaults.color }, false)}
      >
        <FieldRow label={t('title.family')} htmlFor={familyId}>
          <select
            id={familyId}
            data-testid="caption-style-font"
            className="numeric-input h-control-dense min-w-0 flex-1"
            value={look.fontFamily}
            onChange={(event) => {
              // A family that lacks the weight in use takes the nearest it has.
              const next = BUNDLED_FONTS.find((font) => font.family === event.target.value);
              const fontWeight = next ? Math.min(next.maxWeight, Math.max(next.minWeight, look.fontWeight)) : look.fontWeight;
              change({ fontFamily: event.target.value, fontWeight }, false);
            }}
          >
            {!listed && <option value={look.fontFamily}>{missing ? t('title.missingOption', { font: look.fontFamily }) : look.fontFamily}</option>}
            <optgroup label={t('title.included')}>
              {BUNDLED_FONTS.map((font) => (
                <option key={font.family} value={font.family}>
                  {font.family}
                </option>
              ))}
            </optgroup>
            {systemFamilies.length > 0 && (
              <optgroup label={t('title.system')}>
                {systemFamilies.map((family) => (
                  <option key={family} value={family}>
                    {family}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </FieldRow>
        {missing && (
          <p role="status" data-testid="caption-style-font-missing" className="rounded-control bg-amber-400/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-200">
            {t('title.fontMissing', { font: look.fontFamily, fallback: FALLBACK_FAMILY })}
          </p>
        )}
        <FieldRow label={t('title.weight')} htmlFor={weightId}>
          <select
            id={weightId}
            data-testid="caption-style-weight"
            className="numeric-input h-control-dense min-w-0 flex-1"
            value={look.fontWeight}
            onChange={(event) => change({ fontWeight: Number(event.target.value) }, false)}
          >
            {(weights.includes(look.fontWeight as (typeof WEIGHTS)[number]) ? weights : [...weights, look.fontWeight]).map((weight) => (
              <option key={weight} value={weight}>
                {t(`title.weight${weight}` as MessageKey)}
              </option>
            ))}
          </select>
        </FieldRow>
        <label htmlFor={autoSizeId} className="grid grid-cols-[76px_1fr] items-center gap-2 text-xs text-slate-300">
          <span className="field-label truncate">{t('title.size')}</span>
          <span className="flex items-center gap-2 text-2xs text-slate-300">
            <input
              id={autoSizeId}
              type="checkbox"
              role="switch"
              data-testid="caption-style-auto-size"
              checked={look.fontSize === null}
              onChange={(event) => change({ fontSize: event.target.checked ? null : drawnSize }, false)}
            />
            {t('captionStyle.autoSize')}
          </span>
        </label>
        {look.fontSize !== null && (
          <SliderRow
            label={t('captionStyle.letters')}
            value={look.fontSize}
            min={MIN_CAPTION_SIZE}
            max={MAX_CAPTION_SIZE}
            step={1}
            typed={{ unit: 'px', step: 1 }}
            onChange={(fontSize) => change({ fontSize }, 'size')}
          />
        )}
        <ColorRow label={t('title.color')} name={t('title.textColor')} testId="caption-style-color" value={look.color} onChange={(color) => change({ color }, 'color')} />
      </Section>

      <Section
        {...sectionProps('captionOutline')}
        title={t('title.sectionStroke')}
        enabled={look.outline.enabled}
        onEnabledChange={(enabled) => change({ outline: { ...look.outline, enabled } }, false)}
        onReset={() => change({ outline: { ...defaults.outline, enabled: look.outline.enabled } }, false)}
      >
        <ColorRow
          label={t('title.color')}
          name={t('title.strokeColor')}
          testId="caption-style-outline-color"
          value={look.outline.color}
          onChange={(color) => change({ outline: { ...look.outline, enabled: true, color } }, 'outlineColor')}
        />
        <SliderRow
          label={t('title.width')}
          value={look.outline.width}
          min={0}
          max={20}
          step={0.5}
          typed={{ unit: 'px', step: 0.5 }}
          onChange={(width) => change({ outline: { ...look.outline, enabled: true, width } }, 'outlineWidth')}
        />
      </Section>

      <Section
        {...sectionProps('captionBox')}
        title={t('title.sectionBox')}
        enabled={look.box.enabled}
        onEnabledChange={(enabled) => change({ box: { ...look.box, enabled } }, false)}
        onReset={() => change({ box: { ...defaults.box, enabled: look.box.enabled } }, false)}
      >
        <ColorRow
          label={t('title.color')}
          name={t('title.boxColor')}
          testId="caption-style-box-color"
          value={look.box.color}
          onChange={(color) => change({ box: { ...look.box, enabled: true, color } }, 'boxColor')}
        />
        <SliderRow
          label={t('title.opacity')}
          value={look.box.opacity}
          min={0}
          max={1}
          step={0.01}
          typed={{ factor: 100, unit: '%', step: 1 }}
          onChange={(opacity) => change({ box: { ...look.box, enabled: true, opacity } }, 'boxOpacity')}
        />
      </Section>

      <Section {...sectionProps('captionPosition')} title={t('captionStyle.sectionPosition')}>
        <FieldRow label={t('captionStyle.position')}>
          <span role="group" aria-label={t('captionStyle.position')} className="flex gap-0.5">
            {(['bottom', 'top'] as const).map((position) => (
              <button
                key={position}
                type="button"
                data-testid={`caption-style-position-${position}`}
                aria-pressed={look.position === position}
                className={`tool-button tool-button-dense px-2 text-2xs ${look.position === position ? 'tool-button-active' : ''}`}
                onClick={() => change({ position }, false)}
              >
                {t(position === 'bottom' ? 'captionStyle.bottom' : 'captionStyle.top')}
              </button>
            ))}
          </span>
        </FieldRow>
        <p className="text-2xs leading-relaxed text-slate-400">{t('captionStyle.positionHint')}</p>
      </Section>
    </>
  );
}

export default CaptionStyleTab;
