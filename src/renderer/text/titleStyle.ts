import type { Clip, TitleAlign, TitleAnchor, TitleContent, TitlePreset, TitleStyle } from '@shared/types';
import { normalizeAnimation } from './animation';

/**
 * The three title templates, and the rules that keep a title's settings
 * sane - including one read from a file an older or newer build saved.
 *
 * Every length is in pixels of a 1080-line frame (see TitleStyle), which is
 * the unit Final Cut and Premiere users read title sizes in; the renderer
 * scales them to the project.
 */

/** The frame height the lengths in a TitleStyle are measured against. */
export const REFERENCE_HEIGHT = 1080;

/**
 * The title-safe area, as a share of the frame each way: SMPTE ST 2046-1's
 * 90%, which is also what Final Cut and Premiere draw as their title-safe
 * guide. Templates pin text to its edges, never to the frame's.
 */
export const TITLE_SAFE = 0.9;

/** What the family falls back to when the one asked for is not on this computer. */
export const FALLBACK_FAMILY = 'Inter';

export const TITLE_PRESETS: readonly TitlePreset[] = ['title', 'lowerThird', 'credits'];

export const TITLE_ANCHORS: readonly TitleAnchor[] = [
  'topLeft',
  'top',
  'topRight',
  'left',
  'center',
  'right',
  'bottomLeft',
  'bottom',
  'bottomRight',
];

const ALIGNS: readonly TitleAlign[] = ['left', 'center', 'right'];

/**
 * The look of each template. The text itself is not here: it is written in
 * the interface language when the title is made (see titleDefaultText).
 */
export function presetStyle(preset: TitlePreset): TitleStyle {
  switch (preset) {
    case 'lowerThird':
      // A name over a role, on a dark band at the bottom left of the safe
      // area: the shape broadcast lower thirds have, readable over any shot.
      return {
        fontFamily: 'Inter',
        fontWeight: 600,
        fontSize: 54,
        color: '#ffffff',
        align: 'left',
        lineHeight: 1.25,
        letterSpacing: 0,
        secondaryScale: 0.65,
        maxWidth: 0.6,
        anchor: 'bottomLeft',
        stroke: { enabled: false, color: '#000000', width: 3 },
        shadow: { enabled: false, color: '#000000', opacity: 0.5, distance: 3, angle: 90, blur: 8 },
        box: { enabled: true, color: '#000000', opacity: 0.6, padding: 24, radius: 6 },
      };
    case 'credits':
      // A centred list, static for now; rolling comes with the animations.
      return {
        fontFamily: 'Inter',
        fontWeight: 500,
        fontSize: 44,
        color: '#ffffff',
        align: 'center',
        lineHeight: 1.45,
        letterSpacing: 0,
        secondaryScale: 1,
        maxWidth: 0.8,
        anchor: 'center',
        stroke: { enabled: false, color: '#000000', width: 3 },
        shadow: { enabled: true, color: '#000000', opacity: 0.45, distance: 2, angle: 90, blur: 6 },
        box: { enabled: false, color: '#000000', opacity: 0.6, padding: 24, radius: 6 },
      };
    case 'title':
    default:
      // Large, bold, centred, with a soft shadow so white type holds up on a
      // bright shot without an outline.
      return {
        fontFamily: 'Inter',
        fontWeight: 700,
        fontSize: 96,
        color: '#ffffff',
        align: 'center',
        lineHeight: 1.15,
        letterSpacing: 0,
        secondaryScale: 0.6,
        maxWidth: 0.9,
        anchor: 'center',
        stroke: { enabled: false, color: '#000000', width: 4 },
        shadow: { enabled: true, color: '#000000', opacity: 0.5, distance: 4, angle: 90, blur: 12 },
        box: { enabled: false, color: '#000000', opacity: 0.6, padding: 28, radius: 8 },
      };
  }
}

/** The name a title clip goes by: its first line, as Final Cut labels them. */
export function titleName(text: string, fallback: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
  if (!first) return fallback;
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/* Normalising ----------------------------------------------------------------- */

const HEX = /^#[0-9a-f]{6}$/i;

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const colour = (value: unknown, fallback: string): string =>
  typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

export const isTitlePreset = (value: unknown): value is TitlePreset =>
  value === 'title' || value === 'lowerThird' || value === 'credits';

/** The weight rounded to the nearest hundred, which is all a font names. */
export const roundWeight = (value: number): number => Math.min(900, Math.max(100, Math.round(value / 100) * 100));

/**
 * A title with every field present and in range. A field missing or out of
 * range takes its template's value, so a damaged or future file still opens
 * as a title that draws.
 */
export function normalizeTitleStyle(raw: unknown, preset: TitlePreset): TitleStyle {
  const base = presetStyle(preset);
  const source = (raw ?? {}) as Partial<Record<keyof TitleStyle, unknown>>;
  const stroke = (source.stroke ?? {}) as Partial<Record<keyof TitleStyle['stroke'], unknown>>;
  const shadow = (source.shadow ?? {}) as Partial<Record<keyof TitleStyle['shadow'], unknown>>;
  const box = (source.box ?? {}) as Partial<Record<keyof TitleStyle['box'], unknown>>;
  const family = typeof source.fontFamily === 'string' ? source.fontFamily.replace(/["\\]/g, '').trim() : '';

  return {
    fontFamily: family || base.fontFamily,
    fontWeight: roundWeight(clampNumber(source.fontWeight, 100, 900, base.fontWeight)),
    fontSize: clampNumber(source.fontSize, 4, 600, base.fontSize),
    color: colour(source.color, base.color),
    align: ALIGNS.includes(source.align as TitleAlign) ? (source.align as TitleAlign) : base.align,
    lineHeight: clampNumber(source.lineHeight, 0.5, 3, base.lineHeight),
    letterSpacing: clampNumber(source.letterSpacing, -20, 100, base.letterSpacing),
    secondaryScale: clampNumber(source.secondaryScale, 0.2, 1.5, base.secondaryScale),
    maxWidth: clampNumber(source.maxWidth, 0.1, 1, base.maxWidth),
    anchor: TITLE_ANCHORS.includes(source.anchor as TitleAnchor) ? (source.anchor as TitleAnchor) : base.anchor,
    stroke: {
      enabled: flag(stroke.enabled, base.stroke.enabled),
      color: colour(stroke.color, base.stroke.color),
      width: clampNumber(stroke.width, 0, 40, base.stroke.width),
    },
    shadow: {
      enabled: flag(shadow.enabled, base.shadow.enabled),
      color: colour(shadow.color, base.shadow.color),
      opacity: clampNumber(shadow.opacity, 0, 1, base.shadow.opacity),
      distance: clampNumber(shadow.distance, 0, 100, base.shadow.distance),
      angle: clampNumber(shadow.angle, 0, 360, base.shadow.angle),
      blur: clampNumber(shadow.blur, 0, 100, base.shadow.blur),
    },
    box: {
      enabled: flag(box.enabled, base.box.enabled),
      color: colour(box.color, base.box.color),
      opacity: clampNumber(box.opacity, 0, 1, base.box.opacity),
      padding: clampNumber(box.padding, 0, 200, base.box.padding),
      radius: clampNumber(box.radius, 0, 200, base.box.radius),
    },
  };
}

export function normalizeTitle(raw: unknown): TitleContent {
  const source = (raw ?? {}) as Partial<Record<keyof TitleContent, unknown>>;
  const preset = isTitlePreset(source.preset) ? source.preset : 'title';
  return {
    preset,
    text: typeof source.text === 'string' ? source.text : '',
    style: normalizeTitleStyle(source.style, preset),
    // Titles from before animations have none, and keep none.
    ...(source.animation ? { animation: normalizeAnimation(source.animation) } : {}),
    ...(source.origin === 'text' || source.origin === 'frame' ? { origin: source.origin } : {}),
  };
}

/**
 * Titles scale and turn about their text's centre; the first ones scaled and
 * turned about the frame's. The two only draw differently while a title is
 * scaled or turned, so a title that never is - every one made so far but a
 * few - moves to the text's centre on opening and looks exactly the same.
 * One that is keeps the frame's centre, so an opened project never looks
 * different from when it was saved; the Title tab offers the change.
 */
export function migrateTitleOrigin(clip: Clip): Clip {
  if (!clip.title || clip.title.origin === 'text' || clip.title.origin === 'frame') return clip;
  const identity =
    clip.transform.scale.every((keyframe) => keyframe.value.x === 1 && keyframe.value.y === 1) &&
    clip.transform.rotation.every((keyframe) => keyframe.value === 0);
  return { ...clip, title: { ...clip.title, origin: identity ? 'text' : 'frame' } };
}

/** What a title scales and turns about: see TitleOrigin. Absent means the frame's centre. */
export const originOf = (title: TitleContent): 'text' | 'frame' => title.origin ?? 'frame';

/* Naming the source ------------------------------------------------------------ */

/**
 * A title has no file. Its `sourceUri` says so, with a scheme no file or
 * media URL ever has, so nothing that looks media up by URI finds anything.
 */
export const TITLE_URI_PREFIX = 'scf-title:';

export const isTitleUri = (uri: string): boolean => uri.startsWith(TITLE_URI_PREFIX);
