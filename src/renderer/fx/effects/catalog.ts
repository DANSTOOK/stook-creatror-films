import type { ClipEffect, Keyframe } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { createId } from '@shared/utils/id';
import { evaluateNumber } from '@renderer/engine/KeyframeEvaluator';

/**
 * The per-clip effects: what each is called, where it goes in the "Add
 * effect" menu, its settings and their ranges, and whose work it is.
 *
 * Only data and arithmetic, so the inspector and the unit tests can read it
 * without any GLSL; the passes that draw them are in ./shaders.ts.
 *
 * Where the stack runs, in the compositor's chain for a clip: chroma key,
 * then the colour grade with its LUT and vignette, then this stack from top
 * to bottom, then the mask and pixel art. Looks (grain, a light leak, a
 * glitch) belong on the graded picture, as they would on film; a mask's edge
 * stays crisp because no blur runs after it.
 *
 * Sizes are given in pixels of a 1080-line frame and scaled to the frame
 * being drawn, so a 10 px blur is the same blur in a 4K export, a 1080p one
 * and the smaller viewer.
 */

export type EffectCategory = 'camera' | 'color' | 'blur' | 'distort' | 'glitch' | 'stylize' | 'film';

export const EFFECT_CATEGORIES: readonly EffectCategory[] = ['camera', 'color', 'blur', 'distort', 'glitch', 'stylize', 'film'];

/**
 * The two kinds the Effects panel keeps apart, each in its own colour: what
 * moves the camera - shakes, punches, and the Movement presets and the
 * animations beside them - and what changes the look of the picture.
 */
export type EffectFamily = 'camera' | 'look';
export const effectFamily = (category: EffectCategory): EffectFamily => (category === 'camera' ? 'camera' : 'look');

/** How a setting is shown: the stored number, converted for reading only. */
export type EffectParamFormat = 'percent' | 'signedPercent' | 'degrees' | 'px' | 'plain' | 'toggle' | 'position';

export interface EffectParamDef {
  name: string;
  label: MessageKey;
  default: number;
  min: number;
  max: number;
  step: number;
  format: EffectParamFormat;
}

/**
 * How much of a frame an effect costs, measured at 1080p on the integrated
 * GPU (tests/ui/fx-bench.mjs): light is well under a millisecond, medium a
 * few, heavy enough that two or three of them stacked can cost real-time
 * playback on a laptop's integrated graphics.
 */
export type EffectCost = 'light' | 'medium' | 'heavy';

export interface EffectDef {
  /** Stored in the project, so never renamed. */
  type: string;
  category: EffectCategory;
  params: readonly EffectParamDef[];
  /** 'glfx' for ports of glfx.js (MIT, Evan Wallace); 'scf' for this app's own. */
  origin: 'glfx' | 'scf';
  cost: EffectCost;
  /** Changes from frame to frame by itself (grain, glitch, a light leak), even when nothing is keyframed. */
  animated?: boolean;
}

const p = (name: string, label: MessageKey, value: number, min: number, max: number, step: number, format: EffectParamFormat): EffectParamDef => ({
  name,
  label,
  default: value,
  min,
  max,
  step,
  format,
});

const centre = (): EffectParamDef[] => [
  p('centerX', 'fxp.centerX', 0.5, 0, 1, 0.01, 'position'),
  p('centerY', 'fxp.centerY', 0.5, 0, 1, 0.01, 'position'),
];

export const EFFECTS: readonly EffectDef[] = [
  /* Colour ----------------------------------------------------------------- */
  {
    type: 'brightnessContrast',
    category: 'color',
    origin: 'glfx',
    cost: 'light',
    // Applied, it does something you can see: a touch brighter, with more punch. At 0 and 0 it did nothing.
    params: [p('brightness', 'fxp.brightness', 0.06, -1, 1, 0.01, 'signedPercent'), p('contrast', 'fxp.contrast', 0.2, -1, 0.95, 0.01, 'signedPercent')],
  },
  {
    type: 'hueSaturation',
    category: 'color',
    origin: 'glfx',
    cost: 'light',
    // Hue is a turn either way, -1 to 1; shown in degrees.
    // Applied, the colours come up; hue stays where it is until it is turned.
    params: [p('hue', 'fxp.hue', 0, -1, 1, 0.005, 'degrees'), p('saturation', 'fxp.saturation', 0.35, -1, 1, 0.01, 'signedPercent')],
  },
  { type: 'vibrance', category: 'color', origin: 'glfx', cost: 'light', params: [p('amount', 'fxp.amount', 0.5, -1, 1, 0.01, 'signedPercent')] },
  { type: 'sepia', category: 'color', origin: 'glfx', cost: 'light', params: [p('amount', 'fxp.amount', 1, 0, 1, 0.01, 'percent')] },

  /* Blur and sharpen --------------------------------------------------------- */
  { type: 'gaussianBlur', category: 'blur', origin: 'glfx', cost: 'medium', params: [p('radius', 'fxp.radius', 10, 0, 100, 0.5, 'px')] },
  {
    type: 'zoomBlur',
    category: 'blur',
    origin: 'glfx',
    cost: 'medium',
    params: [...centre(), p('strength', 'fxp.strength', 0.3, 0, 1, 0.01, 'percent')],
  },
  {
    type: 'tiltShift',
    category: 'blur',
    origin: 'glfx',
    cost: 'medium',
    params: [
      p('position', 'fxp.focusPosition', 0.5, 0, 1, 0.01, 'position'),
      p('angle', 'fxp.angle', 0, -90, 90, 1, 'degrees'),
      p('blur', 'fxp.blur', 15, 0, 60, 0.5, 'px'),
      p('falloff', 'fxp.focusWidth', 200, 10, 800, 1, 'px'),
    ],
  },
  {
    type: 'unsharpMask',
    category: 'blur',
    origin: 'glfx',
    cost: 'medium',
    params: [p('radius', 'fxp.radius', 20, 1, 100, 0.5, 'px'), p('strength', 'fxp.strength', 1, 0, 5, 0.01, 'percent')],
  },
  { type: 'denoise', category: 'blur', origin: 'glfx', cost: 'heavy', params: [p('smoothing', 'fxp.smoothing', 20, 0, 50, 0.5, 'plain')] },

  /* Hiding a part of the picture: this app's own ----------------------------------- */
  {
    type: 'censor',
    category: 'blur',
    origin: 'scf',
    cost: 'light',
    params: [
      ...centre(),
      p('width', 'fxp.boxWidth', 0.3, 0.02, 1, 0.005, 'percent'),
      p('height', 'fxp.boxHeight', 0.4, 0.02, 1, 0.005, 'percent'),
      p('pixelate', 'fxp.pixelate', 0, 0, 1, 1, 'toggle'),
      p('round', 'fxp.oval', 1, 0, 1, 1, 'toggle'),
      // Strong enough by default that a face cannot be read: a censor, not a soft focus.
      p('amount', 'fxp.strength', 36, 2, 120, 0.5, 'px'),
      p('feather', 'fxp.softness', 8, 0, 40, 0.5, 'px'),
    ],
  },

  /* Distort ------------------------------------------------------------------- */
  {
    type: 'swirl',
    category: 'distort',
    origin: 'glfx',
    cost: 'light',
    params: [...centre(), p('radius', 'fxp.radiusFrame', 0.4, 0, 1, 0.01, 'percent'), p('angle', 'fxp.angle', 180, -720, 720, 1, 'degrees')],
  },
  {
    type: 'bulgePinch',
    category: 'distort',
    origin: 'glfx',
    cost: 'light',
    params: [...centre(), p('radius', 'fxp.radiusFrame', 0.4, 0, 1, 0.01, 'percent'), p('strength', 'fxp.bulge', 0.5, -1, 1, 0.01, 'signedPercent')],
  },
  {
    type: 'chromaticAberration',
    category: 'distort',
    origin: 'scf',
    cost: 'light',
    params: [
      p('amount', 'fxp.offset', 6, 0, 40, 0.5, 'px'),
      p('radial', 'fxp.radial', 1, 0, 1, 1, 'toggle'),
      p('angle', 'fxp.angle', 0, 0, 360, 1, 'degrees'),
    ],
  },
  {
    type: 'glitch',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [
      p('amount', 'fxp.amount', 0.5, 0, 1, 0.01, 'percent'),
      p('blockSize', 'fxp.blockSize', 40, 4, 200, 1, 'px'),
      p('shift', 'fxp.offset', 8, 0, 40, 0.5, 'px'),
      p('speed', 'fxp.changesPerSecond', 10, 0, 30, 0.5, 'plain'),
    ],
  },

  /* Glitch: this app's own -------------------------------------------------------- */
  {
    type: 'vhs',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.amount', 0.6, 0, 1, 0.01, 'percent'), p('noise', 'fxp.noise', 0.35, 0, 1, 0.01, 'percent'), p('tracking', 'fxp.tracking', 0.4, 0, 1, 0.01, 'percent')],
  },
  {
    type: 'blockGlitch',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.amount', 0.5, 0, 1, 0.01, 'percent'), p('blockSize', 'fxp.blockSize', 24, 4, 120, 1, 'px'), p('speed', 'fxp.changesPerSecond', 12, 0, 30, 0.5, 'plain')],
  },
  {
    type: 'sliceGlitch',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.amount', 0.5, 0, 1, 0.01, 'percent'), p('slices', 'fxp.slices', 18, 3, 80, 1, 'plain'), p('speed', 'fxp.changesPerSecond', 8, 0, 30, 0.5, 'plain')],
  },
  {
    type: 'rgbSplit',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.offset', 14, 0, 80, 0.5, 'px'), p('speed', 'fxp.speed', 3, 0, 15, 0.1, 'plain'), p('angle', 'fxp.angle', 0, 0, 360, 1, 'degrees')],
  },
  {
    type: 'staticNoise',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.amount', 0.35, 0, 1, 0.01, 'percent'), p('size', 'fxp.grainSize', 2, 1, 8, 0.5, 'px')],
  },
  {
    type: 'crt',
    category: 'glitch',
    origin: 'scf',
    cost: 'light',
    params: [p('strength', 'fxp.strength', 0.5, 0, 1, 0.01, 'percent'), p('spacing', 'fxp.lineSpacing', 4, 2, 16, 0.5, 'px'), p('curvature', 'fxp.curve', 0.5, 0, 1, 0.01, 'percent')],
  },

  /* Camera: this app's own -------------------------------------------------------- */
  {
    type: 'cameraShake',
    category: 'camera',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('intensity', 'fxp.reach', 20, 0, 100, 0.5, 'px'), p('speed', 'fxp.changesPerSecond', 12, 0.5, 30, 0.5, 'plain'), p('rotation', 'fxp.rotation', 1, 0, 10, 0.1, 'degrees')],
  },
  {
    type: 'handheld',
    category: 'camera',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('intensity', 'fxp.reach', 14, 0, 60, 0.5, 'px'), p('speed', 'fxp.speed', 0.6, 0.1, 3, 0.05, 'plain'), p('rotation', 'fxp.rotation', 0.8, 0, 5, 0.1, 'degrees')],
  },
  {
    type: 'zoomPulse',
    category: 'camera',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.zoom', 0.12, 0.01, 0.6, 0.01, 'percent'), p('rate', 'fxp.perSecond', 2, 0.25, 8, 0.05, 'plain'), ...centre()],
  },

  /* Stylize --------------------------------------------------------------------- */
  { type: 'posterize', category: 'stylize', origin: 'scf', cost: 'light', params: [p('levels', 'fxp.levels', 5, 2, 16, 1, 'plain')] },
  {
    type: 'duotone',
    category: 'stylize',
    origin: 'scf',
    cost: 'light',
    params: [p('shadowHue', 'fxp.shadowHue', 260, 0, 360, 1, 'degrees'), p('highlightHue', 'fxp.highlightHue', 40, 0, 360, 1, 'degrees'), p('amount', 'fxp.amount', 1, 0, 1, 0.01, 'percent')],
  },
  { type: 'mirror', category: 'stylize', origin: 'scf', cost: 'light', params: [p('flip', 'fxp.otherSide', 0, 0, 1, 1, 'toggle'), p('vertical', 'fxp.vertical', 0, 0, 1, 1, 'toggle')] },
  { type: 'ink', category: 'stylize', origin: 'glfx', cost: 'light', params: [p('strength', 'fxp.strength', 0.25, 0, 1, 0.01, 'percent')] },
  { type: 'edgeWork', category: 'stylize', origin: 'glfx', cost: 'medium', params: [p('radius', 'fxp.radius', 10, 1, 60, 0.5, 'px')] },
  { type: 'hexagonalPixelate', category: 'stylize', origin: 'glfx', cost: 'light', params: [p('size', 'fxp.cellSize', 20, 2, 200, 1, 'px')] },
  { type: 'dotScreen', category: 'stylize', origin: 'glfx', cost: 'light', params: [p('angle', 'fxp.angle', 25, 0, 180, 1, 'degrees'), p('size', 'fxp.dotSize', 3, 1, 50, 0.5, 'px')] },
  { type: 'colorHalftone', category: 'stylize', origin: 'glfx', cost: 'light', params: [p('angle', 'fxp.angle', 25, 0, 180, 1, 'degrees'), p('size', 'fxp.dotSize', 4, 1, 50, 0.5, 'px')] },

  { type: 'fisheye', category: 'distort', origin: 'scf', cost: 'light', params: [p('strength', 'fxp.strength', 0.5, -0.6, 1, 0.01, 'signedPercent')] },

  /* Film and light ----------------------------------------------------------------- */
  {
    type: 'glow',
    category: 'film',
    origin: 'scf',
    cost: 'medium',
    params: [p('threshold', 'fxp.threshold', 0.6, 0, 1, 0.01, 'percent'), p('intensity', 'fxp.intensity', 0.9, 0, 2, 0.01, 'percent'), p('radius', 'fxp.radius', 18, 2, 60, 0.5, 'px')],
  },
  {
    type: 'flash',
    category: 'film',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('rate', 'fxp.perSecond', 2, 0.25, 10, 0.05, 'plain'), p('intensity', 'fxp.intensity', 0.7, 0, 1, 0.01, 'percent')],
  },
  {
    type: 'filmGrain',
    category: 'film',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [p('amount', 'fxp.amount', 0.3, 0, 1, 0.01, 'percent'), p('size', 'fxp.grainSize', 1.5, 0.5, 6, 0.1, 'px'), p('color', 'fxp.colorGrain', 0, 0, 1, 1, 'toggle')],
  },
  {
    type: 'lightLeak',
    category: 'film',
    origin: 'scf',
    cost: 'light',
    animated: true,
    params: [
      p('intensity', 'fxp.intensity', 0.6, 0, 1, 0.01, 'percent'),
      p('hue', 'fxp.hue', 30, 0, 360, 1, 'degrees'),
      p('position', 'fxp.position', 0.2, 0, 1, 0.01, 'position'),
      p('spread', 'fxp.spread', 0.5, 0.1, 1, 0.01, 'percent'),
      p('speed', 'fxp.speed', 0.3, 0, 2, 0.01, 'plain'),
    ],
  },
];

const BY_TYPE = new Map(EFFECTS.map((effect) => [effect.type, effect]));

export const effectDef = (type: string): EffectDef | undefined => BY_TYPE.get(type);

export const effectLabel = (type: string): MessageKey => `fxe.${type}` as MessageKey;
export const effectCategoryLabel = (category: EffectCategory): MessageKey => `fx.effectCategory.${category}` as MessageKey;

/* Making and reading ------------------------------------------------------------- */

const clampParam = (param: EffectParamDef, value: number): number => {
  const clamped = Math.min(param.max, Math.max(param.min, value));
  return param.format === 'toggle' ? (clamped >= 0.5 ? 1 : 0) : clamped;
};

export const defaultParams = (def: EffectDef): Record<string, number> => Object.fromEntries(def.params.map((param) => [param.name, param.default]));

/** A new effect of `type`, on and at its defaults. */
export function createEffect(type: string): ClipEffect {
  const def = effectDef(type);
  if (!def) throw new Error(`Unknown effect "${type}"`);
  return { id: createId('fx'), type, enabled: true, params: defaultParams(def) };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * A clip's effects as read from a file: the ones this build knows, each
 * with every setting present and in range, keyframes sorted and valid. An
 * effect from a later version (a type this one does not know) is dropped,
 * and the clip opens without it rather than not at all.
 */
export function normalizeEffects(raw: unknown): ClipEffect[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: ClipEffect[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Partial<ClipEffect>;
    const def = typeof source.type === 'string' ? effectDef(source.type) : undefined;
    if (!def) continue;
    let id = typeof source.id === 'string' && source.id ? source.id : createId('fx');
    if (seen.has(id)) id = createId('fx');
    seen.add(id);
    const storedParams = (source.params && typeof source.params === 'object' ? source.params : {}) as Record<string, unknown>;
    const params: Record<string, number> = {};
    for (const param of def.params) {
      const value = storedParams[param.name];
      params[param.name] = finite(value) ? clampParam(param, value) : param.default;
    }
    const keyframes: Record<string, Keyframe<number>[]> = {};
    const storedKeys = (source.keyframes && typeof source.keyframes === 'object' ? source.keyframes : {}) as Record<string, unknown>;
    for (const param of def.params) {
      const track = storedKeys[param.name];
      if (!Array.isArray(track) || param.format === 'toggle') continue;
      const keys = track
        .filter((key): key is Keyframe<number> => Boolean(key) && finite((key as Keyframe<number>).frame) && finite((key as Keyframe<number>).value))
        .map((key) => ({
          id: typeof key.id === 'string' && key.id ? key.id : createId('kf'),
          frame: Math.round(key.frame),
          value: clampParam(param, key.value),
          easing: key.easing === 'easeIn' || key.easing === 'easeOut' || key.easing === 'bezier' ? key.easing : ('linear' as const),
          ...(key.easing === 'bezier' && key.bezierParams ? { bezierParams: key.bezierParams } : {}),
        }))
        .sort((a, b) => a.frame - b.frame);
      if (keys.length > 0) keyframes[param.name] = keys;
    }
    result.push({
      id,
      type: def.type,
      enabled: source.enabled !== false,
      params,
      ...(Object.keys(keyframes).length > 0 ? { keyframes } : {}),
    });
  }
  return result;
}

/** Every setting of `effect` at timeline `frame`: keyframed ones where their keyframes put them. */
export function effectValuesAt(effect: ClipEffect, frame: number): Record<string, number> {
  const def = effectDef(effect.type);
  if (!def) return { ...effect.params };
  const values: Record<string, number> = {};
  for (const param of def.params) {
    const stored = finite(effect.params[param.name]) ? effect.params[param.name] : param.default;
    const track = effect.keyframes?.[param.name];
    values[param.name] = clampParam(param, track && track.length > 0 ? evaluateNumber(track, frame, stored) : stored);
  }
  return values;
}

/** The effects that draw: known, on. */
export const activeEffects = (effects: readonly ClipEffect[] | undefined): ClipEffect[] =>
  (effects ?? []).filter((effect) => effect.enabled && effectDef(effect.type) !== undefined);

/** An effect's keyframes moved by `delta` frames, as a clip's move moves its transform's. */
export function shiftEffectKeyframes(effects: ClipEffect[] | undefined, delta: number): ClipEffect[] | undefined {
  if (!effects || delta === 0 || !effects.some((effect) => effect.keyframes)) return effects;
  return effects.map((effect) =>
    effect.keyframes
      ? {
          ...effect,
          keyframes: Object.fromEntries(
            Object.entries(effect.keyframes).map(([name, track]) => [name, track.map((key) => ({ ...key, frame: key.frame + delta }))]),
          ),
        }
      : effect,
  );
}

/**
 * A setting changed to `value`. Held still, the setting just changes; once
 * it animates (it has keyframes), the change is a keyframe at `frame`,
 * placed or replaced, as the transform's numbers work.
 */
export function withParam(effect: ClipEffect, name: string, value: number, frame: number): ClipEffect {
  const def = effectDef(effect.type);
  const param = def?.params.find((candidate) => candidate.name === name);
  if (!param) return effect;
  const next = clampParam(param, value);
  const track = effect.keyframes?.[name];
  if (!track || track.length === 0) return { ...effect, params: { ...effect.params, [name]: next } };
  const at = Math.round(frame);
  const placed = track.some((key) => key.frame === at)
    ? track.map((key) => (key.frame === at ? { ...key, value: next } : key))
    : [...track, { id: createId('kf'), frame: at, value: next, easing: 'linear' as const }].sort((a, b) => a.frame - b.frame);
  return { ...effect, keyframes: { ...effect.keyframes, [name]: placed } };
}

/**
 * The keyframe button: on a setting that holds still, starts animating it
 * with a keyframe at `frame` holding its value; on a keyframe, removes it
 * (the last one gone, the setting holds the value it had there); between
 * keyframes, adds one with the value it has there.
 */
export function toggleKeyframe(effect: ClipEffect, name: string, frame: number): ClipEffect {
  const def = effectDef(effect.type);
  const param = def?.params.find((candidate) => candidate.name === name);
  if (!param || param.format === 'toggle') return effect;
  const at = Math.round(frame);
  const track = effect.keyframes?.[name] ?? [];
  const value = effectValuesAt(effect, at)[name];
  const keyed = track.some((key) => key.frame === at);
  if (!keyed) {
    const placed = [...track, { id: createId('kf'), frame: at, value, easing: 'linear' as const }].sort((a, b) => a.frame - b.frame);
    return { ...effect, keyframes: { ...effect.keyframes, [name]: placed } };
  }
  const rest = track.filter((key) => key.frame !== at);
  const { [name]: _gone, ...others } = effect.keyframes ?? {};
  void _gone;
  if (rest.length > 0) return { ...effect, keyframes: { ...others, [name]: rest } };
  const keyframes = Object.keys(others).length > 0 ? others : undefined;
  const { keyframes: _old, ...plain } = effect;
  void _old;
  return { ...plain, params: { ...effect.params, [name]: value }, ...(keyframes ? { keyframes } : {}) };
}
