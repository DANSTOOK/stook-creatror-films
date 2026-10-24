import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, Check, Minus, Plus } from 'lucide-react';
import type { Clip, TitleAlign, TitleStyle } from '@shared/types';
import { useT } from '@renderer/i18n';
import { tip } from '@renderer/components/Tooltip/Tooltip';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { BUNDLED_FONTS } from '@renderer/text/fonts';

/**
 * The text's own toolbar, floating over the title while it is typed into in
 * the viewer, as CapCut's player puts one by the text: the font, bold, the
 * size, the colour, the alignment, capitals, and done. Each change is the
 * title's style, as the Title tab sets it - the same undo steps.
 *
 * It must not end the edit it belongs to. Its buttons keep the focus where it
 * is (in the text, so typing goes on); the font list and the colour well need
 * the focus, so the text editor lets it come here (TitleTextEditor) and the
 * edit ends only when the focus leaves both.
 */

export interface TitleToolbarProps {
  clip: Clip;
  /** The title's box on the picture, in CSS pixels from the picture's top left. */
  box: { left: number; top: number; right: number; bottom: number };
  onDone(): void;
}

/** Room the toolbar needs above the box; with less, it goes under it. */
const ROOM_ABOVE_PX = 46;
const SIZE_STEP = 8;
const MIN_SIZE = 8;
const MAX_SIZE = 600;

const ALIGNS: Array<{ id: TitleAlign; icon: typeof AlignLeft; label: 'title.alignLeft' | 'title.alignCenter' | 'title.alignRight' }> = [
  { id: 'left', icon: AlignLeft, label: 'title.alignLeft' },
  { id: 'center', icon: AlignCenter, label: 'title.alignCenter' },
  { id: 'right', icon: AlignRight, label: 'title.alignRight' },
];

/** The focus going somewhere that is still the edit: this toolbar or the text itself. */
export const keepsTitleEdit = (next: EventTarget | null): boolean =>
  next instanceof Element && Boolean(next.closest('[data-title-toolbar], [data-testid="title-editor"]'));

export function TitleToolbar({ clip, box, onDone }: TitleToolbarProps): JSX.Element | null {
  const t = useT();
  const updateTitle = useProjectStore((state) => state.updateTitle);
  const style = clip.title?.style;
  if (!style) return null;

  const setStyle = (patch: Partial<TitleStyle>, control?: string): void => updateTitle(clip.id, { style: patch }, control ? `title:${clip.id}:${control}` : undefined);
  const font = BUNDLED_FONTS.find((candidate) => candidate.family === style.fontFamily);
  // Bold where the family has it; a family of one weight is never faked bolder.
  const canBold = !font || font.maxWeight >= 700;
  const bold = style.fontWeight >= 600;
  const below = box.top < ROOM_ABOVE_PX;
  /** A button: it does its work without taking the focus from the text. */
  const keepFocus = (event: ReactMouseEvent): void => event.preventDefault();
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (!keepsTitleEdit(event.relatedTarget)) onDone();
  };
  const backToText = (): void => (document.querySelector('[data-testid="title-editor"]') as HTMLElement | null)?.focus();

  return (
    <div
      data-title-toolbar
      data-testid="title-toolbar"
      role="toolbar"
      aria-label={t('title.toolbar')}
      className="scf-rise pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-full border border-panel-600 bg-panel-800/95 px-1.5 py-1 shadow-xl shadow-black/50"
      style={{
        left: `clamp(150px, ${(box.left + box.right) / 2}px, calc(100% - 150px))`,
        top: below ? box.bottom + 10 : box.top - 10,
        transform: below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
      }}
      onMouseDown={(event) => {
        // A press on the bar itself, between its controls, keeps the text focused too.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onBlur={onBlur}
    >
      <select
        data-testid="title-toolbar-font"
        className="numeric-input h-control-dense w-[112px] text-2xs"
        value={style.fontFamily}
        aria-label={t('title.family')}
        onChange={(event) => {
          const chosen = BUNDLED_FONTS.find((candidate) => candidate.family === event.target.value);
          const fontWeight = chosen ? Math.min(chosen.maxWeight, Math.max(chosen.minWeight, style.fontWeight)) : style.fontWeight;
          setStyle({ fontFamily: event.target.value, fontWeight });
          backToText();
        }}
      >
        {!font && <option value={style.fontFamily}>{style.fontFamily}</option>}
        {BUNDLED_FONTS.map((entry) => (
          <option key={entry.family} value={entry.family}>
            {entry.family}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid="title-toolbar-bold"
        aria-pressed={bold}
        disabled={!canBold}
        className={`tool-button tool-button-dense w-6 px-0 ${bold ? 'tool-button-active' : ''}`}
        onMouseDown={keepFocus}
        onClick={() => setStyle({ fontWeight: bold ? Math.max(font?.minWeight ?? 400, 400) : Math.min(font?.maxWeight ?? 700, 700) })}
        {...tip(t('title.bold'))}
      >
        <Bold size={13} />
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-panel-600" />
      <button
        type="button"
        data-testid="title-toolbar-smaller"
        className="tool-button tool-button-dense w-6 px-0"
        onMouseDown={keepFocus}
        onClick={() => setStyle({ fontSize: Math.max(MIN_SIZE, style.fontSize - SIZE_STEP) }, 'size')}
        {...tip(t('title.smaller'))}
      >
        <Minus size={12} />
      </button>
      <span data-testid="title-toolbar-size" className="timecode w-8 text-center text-2xs text-slate-200">
        {Math.round(style.fontSize)}
      </span>
      <button
        type="button"
        data-testid="title-toolbar-bigger"
        className="tool-button tool-button-dense w-6 px-0"
        onMouseDown={keepFocus}
        onClick={() => setStyle({ fontSize: Math.min(MAX_SIZE, style.fontSize + SIZE_STEP) }, 'size')}
        {...tip(t('title.bigger'))}
      >
        <Plus size={12} />
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-panel-600" />
      <label className="relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-control hover:bg-panel-700" {...tip(t('title.color'))}>
        <span aria-hidden className="h-3.5 w-3.5 rounded-full ring-1 ring-white/40" style={{ background: style.color }} />
        <input
          type="color"
          data-testid="title-toolbar-color"
          className="absolute inset-0 cursor-pointer opacity-0"
          value={style.color}
          aria-label={t('title.color')}
          onChange={(event) => setStyle({ color: event.target.value }, 'color')}
        />
      </label>
      {ALIGNS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          data-testid={`title-toolbar-align-${id}`}
          aria-pressed={style.align === id}
          className={`tool-button tool-button-dense w-6 px-0 ${style.align === id ? 'tool-button-active' : ''}`}
          onMouseDown={keepFocus}
          onClick={() => setStyle({ align: id })}
          {...tip(t(label))}
        >
          <Icon size={13} />
        </button>
      ))}
      <button
        type="button"
        data-testid="title-toolbar-caps"
        aria-pressed={style.uppercase === true}
        className={`tool-button tool-button-dense w-6 px-0 ${style.uppercase ? 'tool-button-active' : ''}`}
        onMouseDown={keepFocus}
        onClick={() => setStyle({ uppercase: !style.uppercase })}
        {...tip(t('title.capitals'))}
      >
        <CaseUpper size={14} />
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-panel-600" />
      <button
        type="button"
        data-testid="title-toolbar-done"
        className="tool-button tool-button-dense gap-1 px-2 text-2xs font-semibold text-accent-hover"
        onMouseDown={keepFocus}
        onClick={onDone}
        {...tip(t('title.doneEditing'), { shortcut: 'Esc', named: false })}
      >
        <Check size={13} />
        {t('title.doneEditing')}
      </button>
    </div>
  );
}
