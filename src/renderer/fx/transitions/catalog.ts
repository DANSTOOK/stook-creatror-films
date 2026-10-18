import type { MessageKey } from '@shared/i18n';
import type { TransitionParamValue } from '@shared/types';

/**
 * The shader transitions: what each is called, where it goes in the
 * library, the settings it offers and whose work it is.
 *
 * Every one is a GL Transition (github.com/gl-transitions/gl-transitions),
 * kept as its author wrote it in ./glsl - its header, with the author and
 * the licence, travels with it into the build - and run by the compositor
 * through the one interface they all share: `getFromColor`, `getToColor`,
 * `progress` and `ratio`, plus uniforms of their own (fx/transitions/wrap).
 *
 * This file is only data, so the inspector, the library and the unit tests
 * can read it without pulling in a line of GLSL.
 *
 * Chosen from the 125 in the collection: the ones an editor reaches for,
 * without near-duplicates of each other or of the six built-in kinds (a
 * plain fade, a dip to colour, the four straight wipes and the plain slides
 * are those). Left out on purpose, see fx/licenses.ts: anything needing a
 * texture of its own, anything whose provenance is not plainly permissive.
 */

export type ShaderTransitionCategory = 'dissolve' | 'wipe' | 'motion' | 'zoom' | 'distort' | 'stylize';

export const SHADER_TRANSITION_CATEGORIES: readonly ShaderTransitionCategory[] = ['dissolve', 'wipe', 'motion', 'zoom', 'distort', 'stylize'];

/**
 * A uniform's type, as the shader declares it. A colour is a vec3 or a
 * vec4; in the vec4 one only the red, green and blue are offered, and the
 * alpha stays what the author chose (a shadow's 60%, say).
 */
export type ShaderParamType = 'float' | 'int' | 'bool' | 'vec2' | 'ivec2' | 'color3' | 'color4';

export interface ShaderParam {
  /** The uniform's name in the shader. */
  name: string;
  type: ShaderParamType;
  default: TransitionParamValue;
  /** For numbers and each component of a vector. */
  min?: number;
  max?: number;
  step?: number;
  /** Shown in the inspector under this name; without one, always the default. */
  label?: MessageKey;
}

export interface ShaderTransitionDef {
  /** Stored in the project, so never renamed. */
  id: string;
  /** The file in ./glsl, as the collection names it. */
  file: string;
  category: ShaderTransitionCategory;
  /** Its author, as the file's header gives it. */
  author: string;
  licence: 'MIT' | 'BSD-3-Clause';
  params: readonly ShaderParam[];
  /**
   * Where a still thumbnail stops: far enough in to show what it does. Most
   * are clearest half-way; a few are a blank flash or a single colour there.
   */
  still?: number;
}

const f = (name: string, value: number, min: number, max: number, label?: MessageKey, step?: number): ShaderParam => ({
  name,
  type: 'float',
  default: value,
  min,
  max,
  ...(step === undefined ? {} : { step }),
  ...(label ? { label } : {}),
});
const i = (name: string, value: number, min: number, max: number, label?: MessageKey): ShaderParam => ({ name, type: 'int', default: value, min, max, step: 1, ...(label ? { label } : {}) });
const b = (name: string, value: boolean, label?: MessageKey): ShaderParam => ({ name, type: 'bool', default: value, ...(label ? { label } : {}) });
const v2 = (name: string, value: [number, number], min: number, max: number, label?: MessageKey): ShaderParam => ({ name, type: 'vec2', default: value, min, max, ...(label ? { label } : {}) });
const iv2 = (name: string, value: [number, number], min: number, max: number, label?: MessageKey): ShaderParam => ({ name, type: 'ivec2', default: value, min, max, step: 1, ...(label ? { label } : {}) });
const c3 = (name: string, value: [number, number, number], label?: MessageKey): ShaderParam => ({ name, type: 'color3', default: value, min: 0, max: 1, ...(label ? { label } : {}) });
const c4 = (name: string, value: [number, number, number, number], label?: MessageKey): ShaderParam => ({ name, type: 'color4', default: value, min: 0, max: 1, ...(label ? { label } : {}) });

const def = (
  id: string,
  file: string,
  category: ShaderTransitionCategory,
  author: string,
  params: ShaderParam[] = [],
  extra: Partial<Pick<ShaderTransitionDef, 'still' | 'licence'>> = {},
): ShaderTransitionDef => ({ id, file, category, author, licence: 'MIT', params, ...extra });

export const SHADER_TRANSITIONS: readonly ShaderTransitionDef[] = [
  /* Dissolves: the two pictures blend, each in its own way. */
  def('grayscaleFade', 'fadegrayscale', 'dissolve', 'gre', [f('intensity', 0.3, 0, 1, 'fxp.grayPhase')]),
  def('colorPhase', 'colorphase', 'dissolve', 'gre', [
    { name: 'fromStep', type: 'color4', default: [0, 0.2, 0.4, 0], min: 0, max: 1 },
    { name: 'toStep', type: 'color4', default: [0.6, 0.8, 1, 1], min: 0, max: 1 },
  ]),
  def('overexposure', 'Overexposure', 'dissolve', 'Ben Zhang', [f('strength', 0.6, 0, 2, 'fxp.strength')]),
  def('burnFade', 'burn', 'dissolve', 'gre', [c3('color', [0.9, 0.4, 0.2], 'fxp.color')]),
  def('multiplyFade', 'multiply_blend', 'dissolve', 'Fernando Kuteken'),
  def('dreamy', 'Dreamy', 'dissolve', 'mikolalysenko'),
  def('blurDissolve', 'LinearBlur', 'dissolve', 'gre', [f('intensity', 0.1, 0, 0.5, 'fxp.blur')]),
  def('defocus', 'DefocusBlur', 'dissolve', 'Sergey Kosarevsky', [f('blurSize', 0.02, 0, 0.1, 'fxp.blur')]),
  def('staticFade', 'StaticFade', 'dissolve', 'Ben Lucas', [f('n_noise_pixels', 200, 20, 1000, 'fxp.grain', 1), f('static_luminosity', 0.8, 0, 1, 'fxp.brightness')], { still: 0.4 }),
  def('randomSquares', 'randomsquares', 'dissolve', 'gre', [iv2('size', [10, 10], 2, 50, 'fxp.squares'), f('smoothness', 0.5, 0, 1, 'fxp.softness')]),
  def('burnSpread', 'dissolve', 'dissolve', 'hjm1fb', [
    f('uLineWidth', 0.1, 0.01, 0.5, 'fxp.edgeWidth'),
    c3('uSpreadClr', [1, 0, 0], 'fxp.edgeColor'),
    c3('uHotClr', [0.9, 0.9, 0.2], 'fxp.hotColor'),
    f('uPow', 5, 1, 10),
    f('uIntensity', 1, 0, 2, 'fxp.glow'),
  ], { still: 0.65 }),
  def('crossZoom', 'CrossZoom', 'dissolve', 'rectalogic', [f('strength', 0.4, 0, 1, 'fxp.strength')]),

  /* Wipes and shapes: an edge or a shape crosses the picture. */
  def('clockWipe', 'angular', 'wipe', 'Fernando Kuteken', [f('startingAngle', 90, 0, 360, 'fxp.startAngle', 1)]),
  def('iris', 'circleopen', 'wipe', 'gre', [f('smoothness', 0.3, 0, 1, 'fxp.softness'), b('opening', true, 'fxp.opening')]),
  def('diagonalWipe', 'directionalwipe', 'wipe', 'gre', [v2('direction', [1, -1], -1, 1, 'fxp.direction'), f('smoothness', 0.5, 0, 1, 'fxp.softness')]),
  def('star', 'StarWipe', 'wipe', 'Ben Lucas', [
    f('border_thickness', 0.01, 0, 0.1, 'fxp.border'),
    f('star_rotation', 0.75, 0, 1, 'fxp.rotation'),
    c4('border_color', [1, 1, 1, 1], 'fxp.borderColor'),
    v2('star_center', [0.5, 0.5], 0, 1, 'fxp.center'),
  ], { still: 0.25 }),
  def('heart', 'heart', 'wipe', 'gre', [], { still: 0.6 }),
  def('blinds', 'windowblinds', 'wipe', 'Fabien Benetou'),
  def('slices', 'windowslice', 'wipe', 'gre', [f('count', 10, 2, 50, 'fxp.count', 1), f('smoothness', 0.5, 0, 1, 'fxp.softness')]),
  def('squaresWipe', 'squareswire', 'wipe', 'gre', [iv2('squares', [10, 10], 2, 50, 'fxp.squares'), v2('direction', [1, -0.5], -1, 1, 'fxp.direction'), f('smoothness', 1.6, 0, 3, 'fxp.softness')]),
  def('polkaDots', 'PolkaDotsCurtain', 'wipe', 'bobylito', [f('dots', 20, 2, 100, 'fxp.count', 1), v2('center', [0, 0], 0, 1, 'fxp.center')], { still: 0.3 }),
  def('splitHorizontal', 'HorizontalOpen', 'wipe', 'martiniti'),
  def('splitVertical', 'VerticalOpen', 'wipe', 'martiniti'),
  def('crosshatch', 'crosshatch', 'wipe', 'pthrasher', [v2('center', [0.5, 0.5], 0, 1, 'fxp.center'), f('threshold', 3, 0.5, 10, 'fxp.spread'), f('fadeEdge', 0.1, 0, 0.5, 'fxp.fade')]),
  def('checkerboard', 'chessboard', 'wipe', 'lql', [f('grid_num', 10, 2, 40, 'fxp.count', 1)], { still: 0.4 }),
  def('undulatingBurn', 'undulatingBurnOut', 'wipe', 'pthrasher', [f('smoothness', 0.03, 0, 0.2, 'fxp.softness'), v2('center', [0.5, 0.5], 0, 1, 'fxp.center'), c3('color', [0, 0, 0], 'fxp.edgeColor')]),
  def('wind', 'wind', 'wipe', 'gre', [f('size', 0.2, 0, 1, 'fxp.edgeWidth'), b('reversed', false, 'fxp.reverse')]),
  def('box', 'Rectangle', 'wipe', 'martiniti', [c4('bgcolor', [0, 0, 0, 1], 'fxp.color')], { still: 0.35 }),
  def('pinwheel', 'pinwheel', 'wipe', 'Mr Speaker', [f('speed', 2, 0.5, 10, 'fxp.speed')]),
  def('warpWipe', 'directionalwarp', 'wipe', 'pschroen', [f('smoothness', 0.1, 0, 1, 'fxp.softness'), v2('direction', [-1, 1], -1, 1, 'fxp.direction')]),

  /* 3D and motion: the pictures move, turn and fold. */
  def('cube', 'cube', 'motion', 'gre', [f('persp', 0.7, 0, 1, 'fxp.perspective'), f('unzoom', 0.3, 0, 1, 'fxp.pullBack'), f('reflection', 0.4, 0, 1, 'fxp.reflection'), f('floating', 3, 0, 10, 'fxp.height')]),
  def('doorway', 'doorway', 'motion', 'gre', [f('reflection', 0.4, 0, 1, 'fxp.reflection'), f('perspective', 0.4, 0, 1, 'fxp.perspective'), f('depth', 3, 1, 10, 'fxp.depth')]),
  def('swap', 'swap', 'motion', 'gre', [f('reflection', 0.4, 0, 1, 'fxp.reflection'), f('perspective', 0.2, 0, 1, 'fxp.perspective'), f('depth', 3, 1, 10, 'fxp.depth')], { still: 0.35 }),
  def('pageCurl', 'InvertedPageCurl', 'motion', 'Hewlett-Packard (adapted by Sergey Kosarevsky)', [], { licence: 'BSD-3-Clause' }),
  def('bookFlip', 'BookFlip', 'motion', 'hong', [], { still: 0.3 }),
  def('flip', 'SimpleFlip', 'motion', 'nwoeanhinnogaehr', [], { still: 0.3 }),
  def('gridFlip', 'GridFlip', 'motion', 'TimDonselaar', [
    iv2('size', [4, 4], 1, 20, 'fxp.tiles'),
    f('pause', 0.1, 0, 0.4, 'fxp.pause'),
    f('dividerWidth', 0.05, 0, 0.5, 'fxp.gap'),
    c4('bgcolor', [0, 0, 0, 1], 'fxp.color'),
    f('randomness', 0.1, 0, 1, 'fxp.randomness'),
  ], { still: 0.4 }),
  def('bounce', 'Bounce', 'motion', 'Adrian Purser', [c4('shadow_colour', [0, 0, 0, 0.6], 'fxp.shadowColor'), f('shadow_height', 0.075, 0.01, 0.5, 'fxp.shadow'), f('bounces', 3, 1, 10, 'fxp.bounces', 1)]),
  def('scaledPush', 'DirectionalScaled', 'motion', 'Thibaut Foussard', [v2('direction', [0, 1], -1, 1, 'fxp.direction'), f('scale', 0.7, 0.1, 1, 'fxp.scale')]),
  def('fold', 'Fold', 'motion', 'nwoeanhinnogaehr'),
  def('splitSlide', 'splitSlideInOutHorizontal', 'motion', 'OllyOllyOlly', [b('reverse', false, 'fxp.reverse')]),
  def('melt', 'DoomScreenTransition', 'motion', 'Zeh Fernando', [
    i('bars', 30, 5, 100, 'fxp.columns'),
    f('amplitude', 2, 0, 5, 'fxp.variation'),
    f('noise', 0.1, 0, 1, 'fxp.noise'),
    f('frequency', 0.5, 0, 2, 'fxp.frequency'),
    f('dripScale', 0.5, 0, 1, 'fxp.drip'),
  ], { still: 0.35 }),

  /* Zoom and spin. */
  def('zoomIn', 'SimpleZoom', 'zoom', '0gust1', [f('zoom_quickness', 0.8, 0.2, 1, 'fxp.zoomPart')], { still: 0.3 }),
  def('dreamyZoom', 'DreamyZoom', 'zoom', 'Zeh Fernando', [f('rotation', 6, -45, 45, 'fxp.rotationDeg', 1), f('scale', 1.2, 1, 3, 'fxp.scale')], { still: 0.3 }),
  def('crossWarp', 'crosswarp', 'zoom', 'Eke Péter'),
  def('zoomThrough', 'zoomInOut', 'zoom', 'OllyOllyOlly', [], { still: 0.15 }),
  def('spinZoom', 'rotate_scale_fade', 'zoom', 'Fernando Kuteken', [
    v2('center', [0.5, 0.5], 0, 1, 'fxp.center'),
    f('rotations', 1, -5, 5, 'fxp.turns', 0.25),
    f('scale', 8, 1, 20, 'fxp.scale'),
    c4('backColor', [0.15, 0.15, 0.15, 1], 'fxp.color'),
  ], { still: 0.3 }),
  def('swirl', 'Swirl', 'zoom', 'Sergey Kosarevsky', [], { still: 0.4 }),

  /* Distortions. */
  def('ripple', 'ripple', 'distort', 'gre', [f('amplitude', 100, 0, 300, 'fxp.frequency'), f('speed', 50, 0, 200, 'fxp.speed')], { still: 0.4 }),
  def('waterDrop', 'WaterDrop', 'distort', 'Paweł Płóciennik', [f('amplitude', 30, 0, 100, 'fxp.frequency'), f('speed', 30, 0, 100, 'fxp.speed')], { still: 0.4 }),
  def('morph', 'morph', 'distort', 'paniq', [f('strength', 0.1, 0, 1, 'fxp.strength')]),
  def('kaleidoscope', 'kaleidoscope', 'distort', 'nwoeanhinnogaehr', [f('speed', 1, 0, 5, 'fxp.speed'), f('angle', 1, 0, 5, 'fxp.angle'), f('power', 1.5, 0.5, 5, 'fxp.curve')]),
  def('flyEye', 'flyeye', 'distort', 'gre', [f('size', 0.04, 0, 0.2, 'fxp.size'), f('zoom', 50, 1, 100, 'fxp.lenses'), f('colorSeparation', 0.3, 0, 1, 'fxp.colorSeparation')]),
  def('squeeze', 'squeeze', 'distort', 'gre', [f('colorSeparation', 0.04, 0, 0.2, 'fxp.colorSeparation')]),

  /* Stylize and glitch. */
  def('pixelate', 'pixelize', 'stylize', 'gre', [iv2('squaresMin', [20, 20], 2, 100, 'fxp.squares'), i('steps', 50, 0, 100, 'fxp.steps')], { still: 0.4 }),
  def('hexagons', 'hexagonalize', 'stylize', 'Fernando Kuteken', [i('steps', 50, 0, 100, 'fxp.steps'), f('horizontalHexagons', 20, 2, 100, 'fxp.count', 1)], { still: 0.4 }),
  def('glitchDisplace', 'GlitchDisplace', 'stylize', 'Matt DesLauriers', [], { still: 0.4 }),
  def('filmBurn', 'FilmBurn', 'stylize', 'Anastasia Dunbar', [f('Seed', 2.31, 0, 10, 'fxp.seed')]),
  def('lostSignal', 'old_tv_lost_signal', 'stylize', 'mernking', [], { still: 0.4 }),
];

const BY_ID = new Map(SHADER_TRANSITIONS.map((entry) => [entry.id, entry]));

export const shaderTransition = (id: string | undefined): ShaderTransitionDef | undefined => (id ? BY_ID.get(id) : undefined);

export const isShaderTransitionId = (value: unknown): value is string => typeof value === 'string' && BY_ID.has(value);

/** Its name in the interface. */
export const shaderTransitionLabel = (id: string): MessageKey => `fxt.${id}` as MessageKey;

export const transitionCategoryLabel = (category: ShaderTransitionCategory | 'basic'): MessageKey => `fx.category.${category}` as MessageKey;

/** Where the shader file lives in the collection, for the licences. */
export const glTransitionUrl = (file: string): string => `https://github.com/gl-transitions/gl-transitions/blob/master/transitions/${file}.glsl`;

/* Values --------------------------------------------------------------------- */

const clampTo = (value: number, param: ShaderParam): number => {
  const low = param.min ?? Number.NEGATIVE_INFINITY;
  const high = param.max ?? Number.POSITIVE_INFINITY;
  const clamped = Math.min(high, Math.max(low, value));
  return param.type === 'int' || param.type === 'ivec2' ? Math.round(clamped) : clamped;
};

/**
 * One setting as read from a file or typed in: the right shape, in range,
 * or the default when it is anything else. A colour keeps the alpha its
 * author gave it, whatever is stored.
 */
export function normalizeParamValue(param: ShaderParam, raw: unknown): TransitionParamValue {
  if (param.type === 'bool') return typeof raw === 'boolean' ? raw : (param.default as boolean);
  if (param.type === 'float' || param.type === 'int') {
    return typeof raw === 'number' && Number.isFinite(raw) ? clampTo(raw, param) : (param.default as number);
  }
  const fallback = param.default as readonly number[];
  if (!Array.isArray(raw) || raw.length < (param.type === 'color4' ? 3 : fallback.length)) return [...fallback];
  const values = fallback.map((value, index) => {
    if (param.type === 'color4' && index === 3) return value;
    const candidate = raw[index];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? clampTo(candidate, param) : value;
  });
  return values;
}

/**
 * A transition's settings as read from a file: only the ones its shader
 * has, each normalised, and only those that differ from the default - so a
 * transition nobody touched carries none, and a later default reaches it.
 */
export function normalizeShaderParams(id: string, raw: unknown): Record<string, TransitionParamValue> | undefined {
  const entry = shaderTransition(id);
  if (!entry || !raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const result: Record<string, TransitionParamValue> = {};
  for (const param of entry.params) {
    if (!(param.name in source)) continue;
    const value = normalizeParamValue(param, source[param.name]);
    if (JSON.stringify(value) !== JSON.stringify(param.default)) result[param.name] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Every uniform's value for a draw: what is stored, else the default. */
export function resolvedShaderParams(entry: ShaderTransitionDef, stored: Record<string, TransitionParamValue> | undefined): Array<[ShaderParam, TransitionParamValue]> {
  return entry.params.map((param) => [param, stored && param.name in stored ? normalizeParamValue(param, stored[param.name]) : param.default]);
}
