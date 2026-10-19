import type { TitleAnimation, TitleContent, TitleEntrance, TitleExit, TitlePreset, TitleShape, TitleStyle } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { presetStyle, TITLE_PRESETS } from './titleStyle';
import { presetAnimation } from './animation';
import type { FrameSize } from './layout';

/**
 * The title library: ready-made titles in seven groups, each a look (a
 * TitleStyle), an entrance and an exit, and a line or two of text in the
 * interface's language - Spanish ones with their accents, ñ, ¿ and ¡.
 *
 * Every template here was designed for this app. They follow the common
 * shapes of the trade - a broadcast lower third, a trailer card, a social
 * hook, a callout - but copy no commercial editor's assets: no Premiere
 * MOGRT, Filmora, CapCut or Clipchamp template, and no logo. The shapes are
 * drawn from paths (text/shapes.ts); the fonts are the bundled OFL families.
 *
 * A template is applied once, when the title is made: from then on the
 * title is the user's, saved whole in the project, so changing a template
 * here never changes a title already made. Its id is saved too, so a reset
 * goes back to its look; an id this build does not know falls back to the
 * title's preset.
 *
 * Sizes are in pixels of a 1080-line frame, as every title's are. A
 * vertical (9:16) template is designed on a 1080x1920 frame, so its sizes
 * are those of a frame 1920 lines tall; `styleForFrame` adapts any template
 * to the project it is put in.
 */

export type TemplateCategory = 'basic' | 'lowerThirds' | 'cinematic' | 'social' | 'callouts' | 'credits' | 'kinetic';

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ['basic', 'lowerThirds', 'cinematic', 'social', 'callouts', 'credits', 'kinetic'];

export const CATEGORY_NAME: Record<TemplateCategory, MessageKey> = {
  basic: 'titleLibrary.basic',
  lowerThirds: 'titleLibrary.lowerThirds',
  cinematic: 'titleLibrary.cinematic',
  social: 'titleLibrary.social',
  callouts: 'titleLibrary.callouts',
  credits: 'titleLibrary.credits',
  kinetic: 'titleLibrary.kinetic',
};

export interface TitleTemplate {
  id: string;
  category: TemplateCategory;
  /** The kind of title it makes: what its name falls back to, and what an unknown id is drawn as. */
  preset: TitlePreset;
  name: MessageKey;
  /** Its text, in the interface's language: lines separated by \n. */
  text: MessageKey;
  style: TitleStyle;
  animation: TitleAnimation;
  /** Designed for a vertical 9:16 frame. */
  vertical: boolean;
  /** How long a new title made from it lasts. */
  seconds: number;
}

/* Building blocks ------------------------------------------------------------------ */

/** The look every template starts from: Inter, white, centred, with a soft shadow - and fitted to the safe area. */
const BASE: TitleStyle = {
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
  box: { enabled: false, color: '#000000', opacity: 0.6, padding: 24, radius: 8 },
  fit: true,
};

type LookPatch = Partial<Omit<TitleStyle, 'stroke' | 'shadow' | 'box'>> & {
  stroke?: Partial<TitleStyle['stroke']>;
  shadow?: Partial<TitleStyle['shadow']>;
  box?: Partial<TitleStyle['box']>;
};

/** A look: the base with a few things changed. A stroke, shadow or box given at all is on unless it says otherwise. */
function look(patch: LookPatch): TitleStyle {
  const { stroke, shadow, box, ...rest } = patch;
  return {
    ...BASE,
    ...rest,
    stroke: { ...BASE.stroke, ...(stroke ? { enabled: true } : {}), ...stroke },
    shadow: { ...BASE.shadow, ...shadow },
    box: { ...BASE.box, ...(box ? { enabled: true } : {}), ...box },
  };
}

const NO_SHADOW = { enabled: false } as const;

const shape = (kind: TitleShape['kind'], color: string, size = 4): TitleShape => ({ kind, color, size });

const motion = (entrance: TitleEntrance, exit: TitleExit, inSeconds = 0.6, outSeconds = 0.4): TitleAnimation => ({
  in: entrance,
  inSeconds,
  out: exit,
  outSeconds,
  roll: false,
});

interface Entry {
  id: string;
  category: TemplateCategory;
  style: TitleStyle;
  animation: TitleAnimation;
  preset?: TitlePreset;
  vertical?: boolean;
  seconds?: number;
}

/** The three templates titles started with, under their old ids and names, so files and tests that name them still find them. */
const ORIGINAL: Record<TitlePreset, { category: TemplateCategory; name: MessageKey; text: MessageKey; seconds: number }> = {
  title: { category: 'basic', name: 'title.presetTitle', text: 'title.textTitle', seconds: 5 },
  lowerThird: { category: 'lowerThirds', name: 'title.presetLowerThird', text: 'title.textLowerThird', seconds: 5 },
  credits: { category: 'credits', name: 'title.presetCredits', text: 'title.textCredits', seconds: 5 },
};

/* The library ---------------------------------------------------------------------- */

const ENTRIES: readonly Entry[] = [
  /* Basic */
  {
    id: 'basic-subtitle',
    category: 'basic',
    style: look({ fontWeight: 800, fontSize: 104, lineHeight: 1.1, letterSpacing: -1, secondaryScale: 0.42, secondaryColor: '#e2e8f0' }),
    animation: motion('rise', 'fade'),
  },
  {
    id: 'basic-outline',
    category: 'basic',
    style: look({ fontFamily: 'Archivo Black', fontWeight: 400, fontSize: 120, uppercase: true, stroke: { width: 6 }, shadow: NO_SHADOW }),
    animation: motion('pop', 'vanish'),
  },
  {
    id: 'basic-boxed',
    category: 'basic',
    style: look({ fontFamily: 'Outfit', fontSize: 72, color: '#111111', shadow: NO_SHADOW, box: { color: '#ffffff', opacity: 1, padding: 26, radius: 4 } }),
    animation: motion('wipe', 'fade'),
  },
  {
    id: 'basic-serif',
    category: 'basic',
    style: look({ fontFamily: 'Playfair Display', fontWeight: 600, fontSize: 104, letterSpacing: 0.5, lineHeight: 1.2, secondaryScale: 0.45, secondaryColor: '#e7e5e4' }),
    animation: motion('blur', 'blur', 0.8, 0.5),
  },
  {
    id: 'basic-headline',
    category: 'basic',
    style: look({
      fontFamily: 'Outfit',
      fontWeight: 800,
      fontSize: 60,
      uppercase: true,
      letterSpacing: 6,
      anchor: 'top',
      shadow: NO_SHADOW,
      box: { color: '#000000', opacity: 0.55, padding: 22, radius: 2 },
    }),
    animation: motion('fall', 'lift'),
  },
  {
    id: 'basic-chapter',
    category: 'basic',
    style: look({
      fontFamily: 'Space Grotesk',
      fontWeight: 600,
      fontSize: 46,
      align: 'left',
      anchor: 'topLeft',
      secondaryScale: 0.7,
      secondaryColor: '#cbd5e1',
      maxWidth: 0.5,
      shape: shape('bar', '#f59e0b', 6),
    }),
    animation: motion('fromLeft', 'toLeft'),
  },
  {
    id: 'basic-condensed',
    category: 'basic',
    style: look({ fontFamily: 'Bebas Neue', fontWeight: 400, fontSize: 170, letterSpacing: 2, shadow: { opacity: 0.6, distance: 6, blur: 16 } }),
    animation: motion('zoom', 'zoom', 0.7, 0.4),
  },

  /* Lower thirds */
  {
    id: 'lt-accent',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontFamily: 'Outfit',
      fontSize: 58,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.6,
      secondaryColor: '#fbbf24',
      maxWidth: 0.6,
      shadow: { opacity: 0.6, distance: 2, blur: 10 },
      shape: shape('bar', '#f59e0b', 8),
    }),
    animation: motion('fromLeft', 'toLeft', 0.5, 0.35),
  },
  {
    id: 'lt-news',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontSize: 50,
      align: 'left',
      anchor: 'bottomLeft',
      color: '#0f172a',
      secondaryScale: 0.62,
      secondaryColor: '#b91c1c',
      maxWidth: 0.65,
      shadow: NO_SHADOW,
      box: { color: '#ffffff', opacity: 0.96, padding: 22, radius: 0 },
      shape: shape('bar', '#dc2626', 12),
    }),
    animation: motion('wipe', 'fade', 0.5, 0.35),
  },
  {
    id: 'lt-underline',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontWeight: 500,
      fontSize: 50,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.66,
      secondaryColor: '#cbd5e1',
      maxWidth: 0.6,
      shape: shape('underline', '#22d3ee', 4),
    }),
    animation: motion('letters', 'fade', 0.8, 0.35),
  },
  {
    id: 'lt-pill',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontFamily: 'Outfit',
      fontWeight: 600,
      fontSize: 44,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.72,
      secondaryColor: '#d1d5db',
      maxWidth: 0.6,
      shadow: NO_SHADOW,
      box: { color: '#111827', opacity: 0.82, padding: 24, radius: 36 },
    }),
    animation: motion('pop', 'vanish', 0.5, 0.3),
  },
  {
    id: 'lt-bold',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontFamily: 'Anton',
      fontWeight: 400,
      fontSize: 76,
      uppercase: true,
      letterSpacing: 1,
      lineHeight: 1.05,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.5,
      secondaryColor: '#facc15',
      maxWidth: 0.6,
      shadow: NO_SHADOW,
      box: { color: '#000000', opacity: 0.85, padding: 22, radius: 0 },
    }),
    animation: motion('lines', 'lines', 0.6, 0.4),
  },
  {
    id: 'lt-band',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontWeight: 600,
      fontSize: 48,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.65,
      secondaryColor: '#bae6fd',
      maxWidth: 0.9,
      shadow: NO_SHADOW,
      shape: shape('band', '#0b2545', 0),
    }),
    animation: motion('wipe', 'fade', 0.6, 0.35),
  },
  {
    id: 'lt-right',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontFamily: 'Space Grotesk',
      fontWeight: 600,
      fontSize: 50,
      align: 'right',
      anchor: 'bottomRight',
      secondaryScale: 0.66,
      secondaryColor: '#a5f3fc',
      maxWidth: 0.6,
      shape: shape('underline', '#22d3ee', 5),
    }),
    animation: motion('fromRight', 'toRight', 0.5, 0.35),
  },
  {
    id: 'lt-location',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontFamily: 'Outfit',
      fontWeight: 600,
      fontSize: 50,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.62,
      secondaryColor: '#e5e7eb',
      maxWidth: 0.6,
      shape: shape('pin', '#ef4444', 0),
    }),
    animation: motion('rise', 'drop'),
  },
  {
    id: 'lt-glass',
    category: 'lowerThirds',
    preset: 'lowerThird',
    style: look({
      fontFamily: 'Outfit',
      fontWeight: 500,
      fontSize: 46,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.65,
      maxWidth: 0.6,
      shadow: { opacity: 0.35, distance: 1, blur: 4 },
      box: { color: '#ffffff', opacity: 0.18, padding: 24, radius: 14 },
    }),
    animation: motion('blur', 'blur', 0.6, 0.4),
  },

  /* Cinematic */
  {
    id: 'cin-epic',
    category: 'cinematic',
    style: look({
      fontFamily: 'Cinzel',
      fontSize: 112,
      uppercase: true,
      letterSpacing: 14,
      lineHeight: 1.1,
      secondaryScale: 0.4,
      color: '#fde68a',
      gradientColor: '#b45309',
      shadow: { opacity: 0.7, distance: 0, blur: 18 },
    }),
    animation: motion('tracking', 'blur', 1.4, 0.8),
  },
  {
    id: 'cin-trailer',
    category: 'cinematic',
    style: look({ fontFamily: 'Bebas Neue', fontWeight: 400, fontSize: 190, letterSpacing: 10, shadow: NO_SHADOW, shape: shape('rules', '#ffffff', 3) }),
    animation: motion('zoom', 'fade', 1, 0.6),
  },
  {
    id: 'cin-serif',
    category: 'cinematic',
    style: look({ fontFamily: 'Playfair Display', fontWeight: 400, fontSize: 100, lineHeight: 1.25, secondaryScale: 0.36, secondaryColor: '#d6d3d1' }),
    animation: motion('blur', 'fade', 1.2, 0.8),
  },
  {
    id: 'cin-chapter',
    category: 'cinematic',
    style: look({
      fontFamily: 'Cinzel',
      fontWeight: 600,
      fontSize: 64,
      uppercase: true,
      letterSpacing: 20,
      lineHeight: 1.3,
      secondaryScale: 0.55,
      secondaryColor: '#d4d4d8',
      shape: shape('rules', '#e5e7eb', 2),
    }),
    animation: motion('fade', 'fade', 1, 0.8),
  },
  {
    id: 'cin-wide',
    category: 'cinematic',
    style: look({ fontFamily: 'Outfit', fontWeight: 200, fontSize: 110, uppercase: true, letterSpacing: 36 }),
    animation: motion('tracking', 'tracking', 1.6, 0.8),
  },
  {
    id: 'cin-stamp',
    category: 'cinematic',
    style: look({
      fontFamily: 'Courier Prime',
      fontWeight: 400,
      fontSize: 46,
      align: 'left',
      anchor: 'bottomLeft',
      secondaryScale: 0.85,
      secondaryColor: '#d4d4d8',
      maxWidth: 0.6,
    }),
    animation: motion('typewriter', 'typewriter', 1.4, 0.8),
    seconds: 6,
  },
  {
    id: 'cin-noir',
    category: 'cinematic',
    style: look({ fontFamily: 'Abril Fatface', fontWeight: 400, fontSize: 140, shape: shape('frame', '#ffffff', 3) }),
    animation: motion('zoom', 'blur', 0.9, 0.6),
  },
  {
    id: 'cin-neon',
    category: 'cinematic',
    style: look({ fontFamily: 'Monoton', fontWeight: 400, fontSize: 104, color: '#f5d0fe', shadow: { color: '#e879f9', opacity: 1, distance: 0, blur: 22 } }),
    animation: motion('blur', 'blur', 0.8, 0.5),
  },
  {
    id: 'cin-gold',
    category: 'cinematic',
    style: look({ fontFamily: 'Playfair Display', fontWeight: 800, fontSize: 120, color: '#fef3c7', gradientColor: '#d97706', shadow: { opacity: 0.6 } }),
    animation: motion('letters', 'fade', 1, 0.5),
  },

  /* Social and vertical: sizes on a 1080x1920 frame */
  {
    id: 'soc-hook',
    category: 'social',
    vertical: true,
    style: look({ fontFamily: 'Outfit', fontWeight: 900, fontSize: 64, uppercase: true, lineHeight: 1.05, anchor: 'top', stroke: { width: 5 } }),
    animation: motion('words', 'fade', 0.8, 0.35),
  },
  {
    id: 'soc-highlight',
    category: 'social',
    vertical: true,
    style: look({
      fontFamily: 'Archivo Black',
      fontWeight: 400,
      fontSize: 52,
      color: '#111111',
      shadow: NO_SHADOW,
      box: { color: '#facc15', opacity: 1, padding: 18, radius: 10 },
    }),
    animation: motion('pop', 'vanish', 0.5, 0.3),
  },
  {
    id: 'soc-bubble',
    category: 'social',
    vertical: true,
    style: look({
      fontFamily: 'Outfit',
      fontSize: 46,
      color: '#111827',
      shadow: { opacity: 0.25, distance: 3, blur: 10 },
      box: { color: '#ffffff', opacity: 1, padding: 26, radius: 36 },
      shape: shape('tail', '#ffffff', 0),
    }),
    animation: motion('bounce', 'vanish', 0.8, 0.3),
  },
  {
    id: 'soc-brush',
    category: 'social',
    vertical: true,
    style: look({ fontFamily: 'Knewave', fontWeight: 400, fontSize: 76, lineHeight: 1.1, stroke: { color: '#ec4899', width: 4 } }),
    animation: motion('letters', 'letters', 0.9, 0.5),
  },
  {
    id: 'soc-caption',
    category: 'social',
    vertical: true,
    style: look({ fontFamily: 'Outfit', fontWeight: 800, fontSize: 44, anchor: 'bottom', lineHeight: 1.15, stroke: { width: 4 } }),
    animation: motion('words', 'fade', 0.7, 0.3),
  },
  {
    id: 'soc-handle',
    category: 'social',
    vertical: true,
    style: look({
      fontFamily: 'Outfit',
      fontSize: 40,
      shadow: NO_SHADOW,
      box: { color: '#000000', opacity: 0.6, padding: 18, radius: 40 },
      shape: shape('play', '#ef4444', 0),
    }),
    animation: motion('fromLeft', 'toLeft', 0.5, 0.35),
  },
  {
    id: 'soc-stack',
    category: 'social',
    vertical: true,
    style: look({ fontFamily: 'Anton', fontWeight: 400, fontSize: 110, uppercase: true, lineHeight: 0.98, secondaryScale: 1, secondaryColor: '#facc15' }),
    animation: motion('lines', 'lines', 0.8, 0.5),
  },
  {
    id: 'soc-poll',
    category: 'social',
    vertical: true,
    style: look({
      fontFamily: 'Space Grotesk',
      fontSize: 48,
      color: '#0f172a',
      secondaryScale: 0.6,
      secondaryColor: '#475569',
      shadow: NO_SHADOW,
      box: { color: '#ffffff', opacity: 1, padding: 26, radius: 20 },
    }),
    animation: motion('rise', 'drop'),
  },
  {
    id: 'soc-wow',
    category: 'social',
    style: look({ fontFamily: 'Bangers', fontWeight: 400, fontSize: 130, letterSpacing: 2, color: '#facc15', stroke: { width: 7 } }),
    animation: motion('bounce', 'zoom', 0.9, 0.35),
  },

  /* Callouts and labels */
  {
    id: 'call-arrow',
    category: 'callouts',
    style: look({ fontFamily: 'Outfit', fontSize: 50, align: 'left', anchor: 'right', maxWidth: 0.45, shape: shape('arrow', '#facc15', 0) }),
    animation: motion('fromRight', 'toRight', 0.5, 0.35),
  },
  {
    id: 'call-frame',
    category: 'callouts',
    style: look({ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 42, uppercase: true, letterSpacing: 4, maxWidth: 0.5, shape: shape('frame', '#ffffff', 3) }),
    animation: motion('pop', 'vanish', 0.5, 0.3),
  },
  {
    id: 'call-brackets',
    category: 'callouts',
    style: look({ fontFamily: 'Outfit', fontWeight: 600, fontSize: 48, maxWidth: 0.5, shape: shape('brackets', '#22d3ee', 5) }),
    animation: motion('zoom', 'fade', 0.6, 0.35),
  },
  {
    id: 'call-tag',
    category: 'callouts',
    style: look({
      fontWeight: 800,
      fontSize: 34,
      uppercase: true,
      letterSpacing: 6,
      anchor: 'topRight',
      maxWidth: 0.4,
      shadow: NO_SHADOW,
      box: { color: '#dc2626', opacity: 1, padding: 14, radius: 6 },
    }),
    animation: motion('pop', 'vanish', 0.45, 0.3),
  },
  {
    id: 'call-live',
    category: 'callouts',
    style: look({
      fontWeight: 800,
      fontSize: 34,
      uppercase: true,
      letterSpacing: 6,
      anchor: 'topLeft',
      maxWidth: 0.4,
      shadow: NO_SHADOW,
      box: { color: '#b91c1c', opacity: 0.95, padding: 14, radius: 4 },
      shape: shape('dot', '#ffffff', 0),
    }),
    animation: motion('pop', 'fade', 0.45, 0.3),
  },
  {
    id: 'call-tip',
    category: 'callouts',
    style: look({
      fontFamily: 'Outfit',
      fontWeight: 600,
      fontSize: 44,
      align: 'left',
      anchor: 'left',
      secondaryScale: 0.72,
      secondaryColor: '#cbd5e1',
      maxWidth: 0.55,
      shadow: NO_SHADOW,
      box: { color: '#0f172a', opacity: 0.88, padding: 24, radius: 14 },
      shape: shape('star', '#facc15', 0),
    }),
    animation: motion('rise', 'fade'),
  },
  {
    id: 'call-step',
    category: 'callouts',
    style: look({
      fontFamily: 'Space Grotesk',
      fontSize: 52,
      align: 'left',
      anchor: 'topLeft',
      secondaryScale: 0.62,
      secondaryColor: '#d1fae5',
      maxWidth: 0.55,
      shape: shape('bar', '#22c55e', 8),
    }),
    animation: motion('fromLeft', 'toLeft', 0.5, 0.35),
  },
  {
    id: 'call-warning',
    category: 'callouts',
    style: look({
      fontFamily: 'Bangers',
      fontWeight: 400,
      fontSize: 64,
      letterSpacing: 2,
      color: '#111111',
      shadow: NO_SHADOW,
      box: { color: '#facc15', opacity: 1, padding: 20, radius: 8 },
    }),
    animation: motion('bounce', 'zoom', 0.7, 0.3),
  },
  {
    id: 'call-quote',
    category: 'callouts',
    style: look({
      fontFamily: 'Playfair Display',
      fontWeight: 500,
      fontSize: 64,
      lineHeight: 1.25,
      secondaryScale: 0.55,
      secondaryColor: '#d6d3d1',
      maxWidth: 0.75,
      shape: shape('rules', '#a8a29e', 2),
    }),
    animation: motion('words', 'fade', 1.2, 0.5),
    seconds: 6,
  },

  /* Credits and end cards */
  {
    id: 'end-thanks',
    category: 'credits',
    style: look({ fontFamily: 'Dancing Script', fontSize: 130, shadow: { opacity: 0.6, distance: 2, blur: 14 } }),
    animation: motion('blur', 'fade', 1, 0.8),
  },
  {
    id: 'end-subscribe',
    category: 'credits',
    style: look({
      fontWeight: 800,
      fontSize: 52,
      uppercase: true,
      letterSpacing: 3,
      anchor: 'bottom',
      shadow: NO_SHADOW,
      box: { color: '#dc2626', opacity: 1, padding: 22, radius: 12 },
      shape: shape('bell', '#ffffff', 0),
    }),
    animation: motion('pop', 'vanish', 0.5, 0.3),
  },
  {
    id: 'end-like',
    category: 'credits',
    style: look({
      fontFamily: 'Outfit',
      fontSize: 46,
      color: '#111827',
      anchor: 'bottom',
      shadow: NO_SHADOW,
      box: { color: '#ffffff', opacity: 1, padding: 20, radius: 40 },
      shape: shape('heart', '#ef4444', 0),
    }),
    animation: motion('bounce', 'vanish', 0.7, 0.3),
  },
  {
    id: 'end-next',
    category: 'credits',
    style: look({
      fontFamily: 'Outfit',
      fontSize: 56,
      anchor: 'right',
      maxWidth: 0.5,
      shadow: NO_SHADOW,
      box: { color: '#000000', opacity: 0.6, padding: 22, radius: 10 },
      shape: shape('play', '#ffffff', 0),
    }),
    animation: motion('fromRight', 'toRight', 0.5, 0.35),
  },
  {
    id: 'end-fin',
    category: 'credits',
    style: look({ fontFamily: 'Abril Fatface', fontWeight: 400, fontSize: 170, shape: shape('rules', '#ffffff', 2) }),
    animation: motion('fade', 'fade', 1.2, 1),
  },
  {
    id: 'credits-static',
    category: 'credits',
    preset: 'credits',
    style: look({ fontWeight: 500, fontSize: 64, lineHeight: 1.45, secondaryScale: 0.62, secondaryColor: '#e5e7eb', maxWidth: 0.8, shadow: { opacity: 0.45, distance: 2, blur: 6 } }),
    animation: motion('fade', 'fade', 0.6, 0.5),
    seconds: 6,
  },
  {
    id: 'credits-serif',
    category: 'credits',
    preset: 'credits',
    style: look({ fontFamily: 'Playfair Display', fontWeight: 500, fontSize: 56, lineHeight: 1.5, secondaryScale: 0.8, maxWidth: 0.8, fit: false }),
    animation: { ...motion('none', 'none'), roll: true },
    seconds: 12,
  },

  /* Kinetic */
  {
    id: 'kin-typewriter',
    category: 'kinetic',
    style: look({ fontFamily: 'Courier Prime', fontWeight: 400, fontSize: 64 }),
    animation: motion('typewriter', 'typewriter', 1.6, 0.9),
    seconds: 6,
  },
  {
    id: 'kin-letters',
    category: 'kinetic',
    style: look({ fontFamily: 'Outfit', fontWeight: 800, fontSize: 110 }),
    animation: motion('letters', 'letters', 1, 0.6),
  },
  {
    id: 'kin-words',
    category: 'kinetic',
    style: look({ fontFamily: 'Anton', fontWeight: 400, fontSize: 110, uppercase: true, lineHeight: 1 }),
    animation: motion('words', 'words', 1.2, 0.6),
  },
  {
    id: 'kin-bounce',
    category: 'kinetic',
    style: look({ fontFamily: 'Bangers', fontWeight: 400, fontSize: 140, letterSpacing: 3, color: '#facc15', stroke: { width: 7 } }),
    animation: motion('bounce', 'zoom', 1, 0.4),
  },
  {
    id: 'kin-blur',
    category: 'kinetic',
    style: look({ fontFamily: 'Outfit', fontWeight: 300, fontSize: 100, uppercase: true, letterSpacing: 12 }),
    animation: motion('blur', 'blur', 1, 0.6),
  },
  {
    id: 'kin-lines',
    category: 'kinetic',
    style: look({ fontFamily: 'Bebas Neue', fontWeight: 400, fontSize: 150, lineHeight: 0.95, secondaryScale: 1, secondaryColor: '#f59e0b' }),
    animation: motion('lines', 'lines', 0.8, 0.5),
  },
  {
    id: 'kin-tracking',
    category: 'kinetic',
    style: look({ fontFamily: 'Space Grotesk', fontWeight: 500, fontSize: 90, letterSpacing: 6 }),
    animation: motion('tracking', 'tracking', 1.4, 0.7),
  },
  {
    id: 'kin-pixel',
    category: 'kinetic',
    style: look({
      fontFamily: 'Press Start 2P',
      fontWeight: 400,
      fontSize: 52,
      lineHeight: 1.5,
      color: '#4ade80',
      shadow: { color: '#14532d', opacity: 1, distance: 6, angle: 45, blur: 0 },
    }),
    animation: motion('typewriter', 'letters', 1.2, 0.6),
  },
  {
    id: 'kin-retro',
    category: 'kinetic',
    style: look({ fontFamily: 'Righteous', fontWeight: 400, fontSize: 120, color: '#f9a8d4', gradientColor: '#8b5cf6', stroke: { color: '#ffffff', width: 3 } }),
    animation: motion('bounce', 'vanish', 0.9, 0.35),
  },
  {
    id: 'kin-handwritten',
    category: 'kinetic',
    style: look({ fontFamily: 'Caveat', fontSize: 130 }),
    animation: motion('letters', 'fade', 1.4, 0.6),
  },
];

/* The registry --------------------------------------------------------------------- */

const originals: TitleTemplate[] = TITLE_PRESETS.map((preset) => ({
  id: preset,
  preset,
  category: ORIGINAL[preset].category,
  name: ORIGINAL[preset].name,
  text: ORIGINAL[preset].text,
  style: presetStyle(preset),
  animation: presetAnimation(preset),
  vertical: false,
  seconds: ORIGINAL[preset].seconds,
}));

const library: TitleTemplate[] = ENTRIES.map((entry) => ({
  id: entry.id,
  category: entry.category,
  preset: entry.preset ?? 'title',
  name: `tpl.${entry.id}` as MessageKey,
  text: `tpl.${entry.id}.text` as MessageKey,
  style: entry.style,
  animation: entry.animation,
  vertical: entry.vertical ?? false,
  seconds: entry.seconds ?? 5,
}));

/** Every template, grouped by category in the order the library shows them. */
export const TITLE_TEMPLATES: readonly TitleTemplate[] = TEMPLATE_CATEGORIES.flatMap((category) =>
  [...originals, ...library].filter((template) => template.category === category),
);

const byId = new Map(TITLE_TEMPLATES.map((template) => [template.id, template]));

export const templateById = (id: string | undefined): TitleTemplate | undefined => (id === undefined ? undefined : byId.get(id));

export const isTemplateId = (value: unknown): value is string => typeof value === 'string' && byId.has(value);

/** The template a title came from: its own when this build knows it, else its preset's. */
export const templateOf = (title: Pick<TitleContent, 'template' | 'preset'>): TitleTemplate =>
  templateById(title.template) ?? byId.get(title.preset) ?? (byId.get('title') as TitleTemplate);

/* Fitting a template to the project ---------------------------------------------- */

/** The shorter side of a frame over its height: 1 for landscape and square, 9/16 for vertical. */
const shortOverHeight = (frame: FrameSize): number => Math.min(frame.width, frame.height) / Math.max(1, frame.height);

/** How much a template's lengths are multiplied by on this frame. */
export function frameFactor(template: TitleTemplate, frame: FrameSize): number {
  const designed = template.vertical ? 1080 / 1920 : 1;
  return shortOverHeight(frame) / designed;
}

/**
 * A template's look for a frame of this size. Lengths are in 1080-line
 * pixels, which on a vertical frame are 16/9 larger next to its width than
 * on a landscape one; so a landscape template on a vertical project (and a
 * vertical one on a landscape project) is scaled to keep its letters the
 * same size next to the frame's shorter side - the size it was designed at.
 */
export function styleForFrame(template: TitleTemplate, frame: FrameSize): TitleStyle {
  const factor = frameFactor(template, frame);
  if (Math.abs(factor - 1) < 0.01) return template.style;
  const style = template.style;
  const portrait = frame.height > frame.width;
  return {
    ...style,
    fontSize: style.fontSize * factor,
    // A narrow frame needs every bit of its width for the lines.
    maxWidth: portrait && !template.vertical ? Math.max(style.maxWidth, 0.9) : style.maxWidth,
    stroke: { ...style.stroke, width: style.stroke.width * factor },
    shadow: { ...style.shadow, distance: style.shadow.distance * factor, blur: style.shadow.blur * factor },
    box: { ...style.box, padding: style.box.padding * factor, radius: style.box.radius * factor },
    ...(style.shape ? { shape: { ...style.shape, size: style.shape.size * factor } } : {}),
  };
}

/** A new title made from a template, with its text, for a frame of this size. */
export function titleFromTemplate(template: TitleTemplate, text: string, frame: FrameSize): TitleContent {
  return {
    preset: template.preset,
    text,
    style: styleForFrame(template, frame),
    animation: { ...template.animation },
    origin: 'text',
    // The three original templates are told apart by their preset alone, as they always were.
    ...(template.id === template.preset ? {} : { template: template.id }),
  };
}

/* Searching ----------------------------------------------------------------------- */

/** Lower case without accents, so "titulo" finds "Título" and "nino" finds "Niño". */
export const searchable = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Whether every word of a query is in a template's name, its category's name or its text. */
export function templateMatches(haystack: readonly string[], query: string): boolean {
  const words = searchable(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const within = searchable(haystack.join(' '));
  return words.every((word) => within.includes(word));
}
