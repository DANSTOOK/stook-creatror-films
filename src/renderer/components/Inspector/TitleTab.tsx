import { useId, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import type { Clip, TitleAlign, TitleAnchor, TitlePreset, TitleStyle, Vector2D } from '@shared/types';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useT, type MessageKey } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { BUNDLED_FONTS, isBundledFamily, isFamilyMissing } from '@renderer/text/fonts';
import { FALLBACK_FAMILY, presetStyle, TITLE_ANCHORS, TITLE_PRESETS } from '@renderer/text/titleStyle';
import { TITLE_NAME } from '@renderer/text/titleClip';
import { useLocalFamilies } from '@renderer/text/useLocalFamilies';
import { PairRow, Section, SliderRow, type SectionProps } from './rows';

/**
 * The Title tab: what a title says and how it looks.
 *
 * Grouped as Final Cut's Text inspector and Premiere's Properties panel
 * group them - text, font, paragraph, then the outline, shadow and
 * background each with a switch - and the place on screen last. Every
 * length reads in pixels of a 1080-line frame, the unit title sizes are
 * talked about in; the renderer scales them to the project.
 *
 * Typing is one undo step per run, and a slider drag one step per drag, by
 * the same merge keys the other tabs use.
 */

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

const ANCHOR_NAME: Record<TitleAnchor, MessageKey> = {
  topLeft: 'title.anchorTopLeft',
  top: 'title.anchorTop',
  topRight: 'title.anchorTopRight',
  left: 'title.anchorLeft',
  center: 'title.anchorCenter',
  right: 'title.anchorRight',
  bottomLeft: 'title.anchorBottomLeft',
  bottom: 'title.anchorBottom',
  bottomRight: 'title.anchorBottomRight',
};

const ALIGNS: Array<{ id: TitleAlign; label: MessageKey; icon: typeof AlignLeft }> = [
  { id: 'left', label: 'title.alignLeft', icon: AlignLeft },
  { id: 'center', label: 'title.alignCenter', icon: AlignCenter },
  { id: 'right', label: 'title.alignRight', icon: AlignRight },
];

const px = (value: number): string => `${Math.round(value)} px`;

/** A label on the left and anything on the right, as the other rows are laid out. */
function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[76px_1fr] items-center gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="field-label truncate">
          {label}
        </label>
      ) : (
        <span className="field-label truncate">{label}</span>
      )}
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A colour well with its value written beside it. */
function ColorRow({ label, name, value, testId, onChange }: { label: string; name: string; value: string; testId: string; onChange(value: string): void }): JSX.Element {
  const id = useId();
  return (
    <FieldRow label={label} htmlFor={id}>
      <input
        id={id}
        type="color"
        aria-label={name}
        data-testid={testId}
        className="h-control-dense w-10 shrink-0 cursor-pointer rounded-control border border-panel-600 bg-panel-950 p-0.5"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="timecode text-2xs text-slate-300">{value.toUpperCase()}</span>
    </FieldRow>
  );
}

export interface TitleTabProps {
  clip: Clip;
  sectionProps(id: string): Pick<SectionProps, 'id' | 'open' | 'onOpenChange'>;
  /** The clip's position at the playhead, and how to change it: the Video tab's own. */
  position: Vector2D;
  onPosition(axis: 'x' | 'y', value: number): void;
}

export function TitleTab({ clip, sectionProps, position, onPosition }: TitleTabProps): JSX.Element | null {
  const t = useT();
  const updateTitle = useProjectStore((state) => state.updateTitle);
  const families = useLocalFamilies();
  const textId = useId();
  const familyId = useId();
  const weightId = useId();
  const templateId = useId();

  const title = clip.title;
  if (!title) return null;
  const { style } = title;
  const defaults = presetStyle(title.preset);

  /** One control's changes, one undo step per drag or typing run. */
  const setStyle = (patch: Partial<TitleStyle>, control: string | false): void =>
    updateTitle(clip.id, { style: patch }, control ? `title:${clip.id}:${control}` : undefined);

  const missing = isFamilyMissing(style.fontFamily);
  const bundled = BUNDLED_FONTS.find((font) => font.family === style.fontFamily);
  const weights = WEIGHTS.filter((weight) => !bundled || (weight >= bundled.minWeight && weight <= bundled.maxWeight));
  const systemFamilies = families ? [...families].filter((family) => !isBundledFamily(family)).sort((a, b) => a.localeCompare(b)) : [];
  const listed = isBundledFamily(style.fontFamily) || systemFamilies.includes(style.fontFamily);

  return (
    <>
      <Section {...sectionProps('titleText')} title={t('title.sectionText')}>
        <FieldRow label={t('title.template')} htmlFor={templateId}>
          <select
            id={templateId}
            data-testid="title-template"
            className="numeric-input h-control-dense min-w-0 flex-1"
            value={title.preset}
            {...tip(t('title.templateHint'))}
            onChange={(event) => {
              const preset = event.target.value as TitlePreset;
              updateTitle(clip.id, { preset, style: presetStyle(preset) });
            }}
          >
            {TITLE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {t(TITLE_NAME[preset])}
              </option>
            ))}
          </select>
        </FieldRow>
        <label htmlFor={textId} className="sr-only">
          {t('title.sectionText')}
        </label>
        <textarea
          id={textId}
          data-testid="title-text"
          rows={Math.min(8, Math.max(2, title.text.split('\n').length))}
          spellCheck
          className="numeric-input h-auto min-h-[56px] resize-y py-1.5 leading-snug"
          value={title.text}
          onChange={(event) => updateTitle(clip.id, { text: event.target.value }, `title:${clip.id}:text`)}
        />
      </Section>

      <Section
        {...sectionProps('titleFont')}
        title={t('title.sectionFont')}
        onReset={() =>
          setStyle(
            { fontFamily: defaults.fontFamily, fontWeight: defaults.fontWeight, fontSize: defaults.fontSize, color: defaults.color },
            false,
          )
        }
      >
        <FieldRow label={t('title.family')} htmlFor={familyId}>
          <select
            id={familyId}
            data-testid="title-font"
            className="numeric-input h-control-dense min-w-0 flex-1"
            value={style.fontFamily}
            onChange={(event) => setStyle({ fontFamily: event.target.value }, false)}
          >
            {!listed && (
              <option value={style.fontFamily}>
                {missing ? t('title.missingOption', { font: style.fontFamily }) : style.fontFamily}
              </option>
            )}
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
          <p role="status" data-testid="title-font-missing" className="rounded-control bg-amber-400/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-200">
            {t('title.fontMissing', { font: style.fontFamily, fallback: FALLBACK_FAMILY })}
          </p>
        )}
        <FieldRow label={t('title.weight')} htmlFor={weightId}>
          <select
            id={weightId}
            data-testid="title-weight"
            className="numeric-input h-control-dense min-w-0 flex-1"
            value={style.fontWeight}
            onChange={(event) => setStyle({ fontWeight: Number(event.target.value) }, false)}
          >
            {(weights.includes(style.fontWeight as (typeof WEIGHTS)[number]) ? weights : [...weights, style.fontWeight]).map((weight) => (
              <option key={weight} value={weight}>
                {t(`title.weight${weight}` as MessageKey)}
              </option>
            ))}
          </select>
        </FieldRow>
        <SliderRow
          label={t('title.size')}
          value={style.fontSize}
          min={8}
          max={300}
          step={1}
          typed={{ unit: 'px', step: 1 }}
          onChange={(fontSize) => setStyle({ fontSize }, 'size')}
        />
        <ColorRow label={t('title.color')} name={t('title.textColor')} testId="title-color" value={style.color} onChange={(color) => setStyle({ color }, 'color')} />
      </Section>

      <Section
        {...sectionProps('titleParagraph')}
        title={t('title.sectionParagraph')}
        onReset={() =>
          setStyle(
            { align: defaults.align, lineHeight: defaults.lineHeight, letterSpacing: defaults.letterSpacing, secondaryScale: defaults.secondaryScale },
            false,
          )
        }
      >
        <FieldRow label={t('title.align')}>
          <span role="group" aria-label={t('title.align')} className="flex gap-0.5">
            {ALIGNS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                data-testid={`title-align-${id}`}
                aria-pressed={style.align === id}
                aria-label={t(label)}
                className={`tool-button tool-button-dense w-7 px-0 ${style.align === id ? 'tool-button-active' : ''}`}
                onClick={() => setStyle({ align: id }, false)}
                {...tip(t(label))}
              >
                <Icon size={13} />
              </button>
            ))}
          </span>
        </FieldRow>
        <SliderRow
          label={t('title.lineSpacing')}
          value={style.lineHeight}
          min={0.8}
          max={2.5}
          step={0.05}
          typed={{ factor: 100, unit: '%', step: 5 }}
          onChange={(lineHeight) => setStyle({ lineHeight }, 'lineHeight')}
        />
        <SliderRow
          label={t('title.letterSpacing')}
          value={style.letterSpacing}
          min={-10}
          max={50}
          step={0.5}
          typed={{ unit: '%', step: 1 }}
          onChange={(letterSpacing) => setStyle({ letterSpacing }, 'letterSpacing')}
        />
        <SliderRow
          label={t('title.secondaryScale')}
          value={style.secondaryScale}
          min={0.3}
          max={1}
          step={0.05}
          typed={{ factor: 100, unit: '%', step: 5 }}
          onChange={(secondaryScale) => setStyle({ secondaryScale }, 'secondaryScale')}
        />
        <p className="text-2xs leading-relaxed text-slate-400">{t('title.secondaryScaleHint')}</p>
      </Section>

      <Section
        {...sectionProps('titleStroke')}
        title={t('title.sectionStroke')}
        enabled={style.stroke.enabled}
        onEnabledChange={(enabled) => setStyle({ stroke: { ...style.stroke, enabled } }, false)}
        onReset={() => setStyle({ stroke: { ...defaults.stroke, enabled: style.stroke.enabled } }, false)}
      >
        <ColorRow
          label={t('title.color')}
          name={t('title.strokeColor')}
          testId="title-stroke-color"
          value={style.stroke.color}
          onChange={(color) => setStyle({ stroke: { ...style.stroke, enabled: true, color } }, 'strokeColor')}
        />
        <SliderRow
          label={t('title.width')}
          value={style.stroke.width}
          min={0}
          max={20}
          step={0.5}
          typed={{ unit: 'px', step: 0.5 }}
          onChange={(width) => setStyle({ stroke: { ...style.stroke, enabled: true, width } }, 'strokeWidth')}
        />
      </Section>

      <Section
        {...sectionProps('titleShadow')}
        title={t('title.sectionShadow')}
        enabled={style.shadow.enabled}
        onEnabledChange={(enabled) => setStyle({ shadow: { ...style.shadow, enabled } }, false)}
        onReset={() => setStyle({ shadow: { ...defaults.shadow, enabled: style.shadow.enabled } }, false)}
      >
        <ColorRow
          label={t('title.color')}
          name={t('title.shadowColor')}
          testId="title-shadow-color"
          value={style.shadow.color}
          onChange={(color) => setStyle({ shadow: { ...style.shadow, enabled: true, color } }, 'shadowColor')}
        />
        <SliderRow
          label={t('title.opacity')}
          value={style.shadow.opacity}
          typed={{ factor: 100, unit: '%', step: 1 }}
          onChange={(opacity) => setStyle({ shadow: { ...style.shadow, enabled: true, opacity } }, 'shadowOpacity')}
        />
        <SliderRow
          label={t('title.distance')}
          value={style.shadow.distance}
          max={50}
          step={1}
          format={px}
          onChange={(distance) => setStyle({ shadow: { ...style.shadow, enabled: true, distance } }, 'shadowDistance')}
        />
        <SliderRow
          label={t('title.angle')}
          value={style.shadow.angle}
          max={360}
          step={1}
          format={(value) => `${Math.round(value)}°`}
          onChange={(angle) => setStyle({ shadow: { ...style.shadow, enabled: true, angle } }, 'shadowAngle')}
        />
        <SliderRow
          label={t('title.blur')}
          value={style.shadow.blur}
          max={50}
          step={1}
          format={px}
          onChange={(blur) => setStyle({ shadow: { ...style.shadow, enabled: true, blur } }, 'shadowBlur')}
        />
      </Section>

      <Section
        {...sectionProps('titleBox')}
        title={t('title.sectionBox')}
        enabled={style.box.enabled}
        onEnabledChange={(enabled) => setStyle({ box: { ...style.box, enabled } }, false)}
        onReset={() => setStyle({ box: { ...defaults.box, enabled: style.box.enabled } }, false)}
      >
        <ColorRow
          label={t('title.color')}
          name={t('title.boxColor')}
          testId="title-box-color"
          value={style.box.color}
          onChange={(color) => setStyle({ box: { ...style.box, enabled: true, color } }, 'boxColor')}
        />
        <SliderRow
          label={t('title.opacity')}
          value={style.box.opacity}
          typed={{ factor: 100, unit: '%', step: 1 }}
          onChange={(opacity) => setStyle({ box: { ...style.box, enabled: true, opacity } }, 'boxOpacity')}
        />
        <SliderRow
          label={t('title.padding')}
          value={style.box.padding}
          max={100}
          step={1}
          format={px}
          onChange={(padding) => setStyle({ box: { ...style.box, enabled: true, padding } }, 'boxPadding')}
        />
        <SliderRow
          label={t('title.radius')}
          value={style.box.radius}
          max={60}
          step={1}
          format={px}
          onChange={(radius) => setStyle({ box: { ...style.box, enabled: true, radius } }, 'boxRadius')}
        />
      </Section>

      <Section
        {...sectionProps('titlePosition')}
        title={t('title.sectionPosition')}
        onReset={() => setStyle({ anchor: defaults.anchor, maxWidth: defaults.maxWidth }, false)}
      >
        <FieldRow label={t('title.anchor')}>
          {/* Nine points of the title-safe area, laid out where they are on screen. */}
          <span role="group" aria-label={t('title.anchorGroup')} className="grid grid-cols-3 gap-0.5 rounded-control bg-panel-950 p-0.5 ring-1 ring-panel-700">
            {TITLE_ANCHORS.map((anchor) => (
              <button
                key={anchor}
                type="button"
                data-testid={`title-anchor-${anchor}`}
                aria-pressed={style.anchor === anchor}
                aria-label={t(ANCHOR_NAME[anchor])}
                className={`tool-button h-5 min-w-0 w-6 px-0 ${style.anchor === anchor ? 'tool-button-active' : ''}`}
                onClick={() => setStyle({ anchor }, false)}
                {...tip(t(ANCHOR_NAME[anchor]))}
              >
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${style.anchor === anchor ? 'bg-accent-hover' : 'bg-slate-400'}`} />
              </button>
            ))}
          </span>
        </FieldRow>
        <SliderRow
          label={t('title.wrapWidth')}
          value={style.maxWidth}
          min={0.2}
          max={1}
          step={0.01}
          typed={{ factor: 100, unit: '%', step: 1 }}
          onChange={(maxWidth) => setStyle({ maxWidth }, 'maxWidth')}
        />
        <PairRow
          label={t('inspector.position')}
          xLabel={t('inspector.positionX')}
          yLabel={t('inspector.positionY')}
          x={position.x}
          y={position.y}
          unit="px"
          onChange={onPosition}
        />
        <p className="text-2xs leading-relaxed text-slate-400">{t('title.safeHint')}</p>
      </Section>
    </>
  );
}
