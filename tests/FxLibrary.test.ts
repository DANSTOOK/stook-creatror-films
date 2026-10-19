import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import {
  SHADER_TRANSITIONS,
  normalizeParamValue,
  normalizeShaderParams,
  shaderTransitionLabel,
  transitionCategoryLabel,
  SHADER_TRANSITION_CATEGORIES,
} from '@renderer/fx/transitions/catalog';
import { transitionSource, wrapTransition } from '@renderer/fx/transitions/shaders';
import {
  EFFECTS,
  createEffect,
  effectLabel,
  effectValuesAt,
  normalizeEffects,
  shiftEffectKeyframes,
  toggleKeyframe,
  withParam,
} from '@renderer/fx/effects/catalog';
import { EFFECT_PASSES } from '@renderer/fx/effects/shaders';
import {
  ALL_TRANSITION_PRESETS,
  TRANSITION_PRESETS,
  isTransitionPreset,
  normalizeTransitions,
  presetKind,
  presetOf,
} from '@renderer/timing/transitions';
import { TRANSITION_CREDITS, EFFECT_CREDITS } from '@renderer/fx/licenses';
import { moveClip } from '@renderer/components/Timeline/timelineOps';
import { createClip } from '@renderer/store/types';

const keys = new Set(Object.keys(en));

describe('shader transition catalog', () => {
  it('has 40 or more, with unique ids that never take a built-in name', () => {
    expect(SHADER_TRANSITIONS.length).toBeGreaterThanOrEqual(40);
    const ids = SHADER_TRANSITIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(TRANSITION_PRESETS as readonly string[]).not.toContain(id);
    expect(ALL_TRANSITION_PRESETS.length).toBe(TRANSITION_PRESETS.length + ids.length);
  });

  it('has a source for each, with its licence header and every uniform it declares', () => {
    for (const entry of SHADER_TRANSITIONS) {
      const source = transitionSource(entry.file);
      expect(source, entry.id).toBeTypeOf('string');
      expect(source).toMatch(/vec4\s+transition\s*\(/);
      expect(source).toMatch(new RegExp(`License: ${entry.licence === 'MIT' ? 'MIT' : 'BSD 3 Clause'}`));
      for (const param of entry.params) expect(source, `${entry.id}.${param.name}`).toMatch(new RegExp(`uniform\\s+\\w+\\s+${param.name}\\b`));
      // The wrapper declares these itself.
      expect(source).not.toMatch(/uniform\s+\w+\s+(progress|ratio)\b/);
      expect(wrapTransition(source!)).toMatch(/^#version 300 es/);
    }
  });

  it('gives every transition, category and labelled setting a name in English and Spanish', () => {
    for (const entry of SHADER_TRANSITIONS) {
      expect(keys.has(shaderTransitionLabel(entry.id)), entry.id).toBe(true);
      expect(es[shaderTransitionLabel(entry.id)]).toBeTruthy();
      for (const param of entry.params) if (param.label) expect(keys.has(param.label), param.label).toBe(true);
    }
    for (const category of [...SHADER_TRANSITION_CATEGORIES, 'basic' as const]) expect(keys.has(transitionCategoryLabel(category))).toBe(true);
  });

  it('keeps every default inside its own range', () => {
    for (const entry of SHADER_TRANSITIONS) {
      for (const param of entry.params) {
        const values = Array.isArray(param.default) ? param.default : typeof param.default === 'number' ? [param.default] : [];
        for (const value of values) {
          if (param.min !== undefined) expect(value, `${entry.id}.${param.name}`).toBeGreaterThanOrEqual(param.min);
          if (param.max !== undefined) expect(value, `${entry.id}.${param.name}`).toBeLessThanOrEqual(param.max);
        }
      }
    }
  });

  it('clamps settings, keeps a colour alpha as authored, and stores only what differs', () => {
    const bounce = SHADER_TRANSITIONS.find((entry) => entry.id === 'bounce')!;
    const bounces = bounce.params.find((param) => param.name === 'bounces')!;
    expect(normalizeParamValue(bounces, 99)).toBe(10);
    expect(normalizeParamValue(bounces, 'x')).toBe(3);
    const shadow = bounce.params.find((param) => param.name === 'shadow_colour')!;
    expect(normalizeParamValue(shadow, [1, 0.5, 2, 0])).toEqual([1, 0.5, 1, 0.6]);
    expect(normalizeShaderParams('bounce', { bounces: 3, shadow_height: 0.2, nonsense: 1 })).toEqual({ shadow_height: 0.2 });
    expect(normalizeShaderParams('bounce', { bounces: 3 })).toBeUndefined();
  });
});

describe('transitions in a project file', () => {
  const base = { id: 't', fromClipId: 'a', toClipId: 'b', durationFrames: 30, alignment: 'center' };

  it('keeps a shader transition and its settings', () => {
    const read = normalizeTransitions({ t: { ...base, kind: 'shader', shader: 'cube', params: { reflection: 5 } } });
    expect(read.t.kind).toBe('shader');
    expect(read.t.shader).toBe('cube');
    expect(read.t.params).toEqual({ reflection: 1 });
  });

  it('opens an unknown shader transition as a cross dissolve of the same length', () => {
    const read = normalizeTransitions({ t: { ...base, kind: 'shader', shader: 'fromTheFuture', params: { x: 1 } } });
    expect(read.t.kind).toBe('crossDissolve');
    expect(read.t.durationFrames).toBe(30);
    expect(read.t.shader).toBeUndefined();
    expect(read.t.params).toBeUndefined();
  });

  it('maps every preset to its fields and back', () => {
    for (const preset of ALL_TRANSITION_PRESETS) {
      expect(isTransitionPreset(preset)).toBe(true);
      expect(presetOf(presetKind(preset))).toBe(preset);
    }
    expect(presetKind('cube')).toMatchObject({ kind: 'shader', shader: 'cube', params: undefined });
    expect(presetKind('wipe')).toMatchObject({ kind: 'wipe', shader: undefined });
    expect(isTransitionPreset('fromTheFuture')).toBe(false);
  });
});

describe('effect catalog', () => {
  it('has 15 to 20 effects, each with passes, names in both languages and sane ranges', () => {
    expect(EFFECTS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(EFFECTS.map((effect) => effect.type)).size).toBe(EFFECTS.length);
    for (const effect of EFFECTS) {
      expect(EFFECT_PASSES[effect.type]?.length, effect.type).toBeGreaterThan(0);
      expect(keys.has(effectLabel(effect.type)), effect.type).toBe(true);
      expect(es[effectLabel(effect.type)]).toBeTruthy();
      for (const param of effect.params) {
        expect(keys.has(param.label), param.label).toBe(true);
        expect(param.min).toBeLessThan(param.max);
        expect(param.default).toBeGreaterThanOrEqual(param.min);
        expect(param.default).toBeLessThanOrEqual(param.max);
        expect(param.step).toBeGreaterThan(0);
      }
    }
  });

  it('gives every pass finite uniforms at the defaults and at the ends of every range', () => {
    const context = { width: 1920, height: 1080, seconds: 2.5 };
    for (const effect of EFFECTS) {
      for (const pick of ['min', 'default', 'max'] as const) {
        const values = Object.fromEntries(effect.params.map((param) => [param.name, param[pick]]));
        for (const pass of EFFECT_PASSES[effect.type]) {
          for (const [name, value] of Object.entries(pass.uniforms(values, context))) {
            const list = typeof value === 'number' ? [value] : [...value];
            for (const number of list) expect(Number.isFinite(number), `${effect.type}.${name} at ${pick}`).toBe(true);
          }
        }
      }
    }
  });

  it('reads a stack from a file: unknown effects dropped, settings clamped and filled in', () => {
    const read = normalizeEffects([
      { id: 'a', type: 'gaussianBlur', enabled: true, params: { radius: 1000 } },
      { id: 'b', type: 'fromTheFuture', enabled: true, params: {} },
      { id: 'a', type: 'sepia', params: { amount: 'lots' } },
      null,
    ]);
    expect(read.map((effect) => effect.type)).toEqual(['gaussianBlur', 'sepia']);
    expect(read[0].params.radius).toBe(100);
    expect(read[1].params.amount).toBe(1);
    expect(read[1].id).not.toBe('a');
    expect(read[1].enabled).toBe(true);
    expect(normalizeEffects(undefined)).toEqual([]);
  });

  it('animates a setting with keyframes, which move with the clip', () => {
    let effect = createEffect('gaussianBlur');
    effect = toggleKeyframe(effect, 'radius', 10); // starts animating, holding 10 px
    effect = withParam(effect, 'radius', 50, 30); // a second keyframe
    expect(effectValuesAt(effect, 10).radius).toBe(10);
    expect(effectValuesAt(effect, 20).radius).toBeCloseTo(30);
    expect(effectValuesAt(effect, 40).radius).toBe(50);
    const clip = { ...createClip({ trackId: 't', name: 'c', sourceUri: 'x', startFrame: 0, durationFrames: 60 }), effects: [effect] };
    const moved = moveClip(clip, 100);
    expect(effectValuesAt(moved.effects![0], 120).radius).toBeCloseTo(30);
    expect(shiftEffectKeyframes(undefined, 5)).toBeUndefined();
    // Removing both keyframes leaves the value where the last one was.
    let still = toggleKeyframe(effect, 'radius', 30);
    still = toggleKeyframe(still, 'radius', 10);
    expect(still.keyframes).toBeUndefined();
    expect(still.params.radius).toBe(10);
  });

  it('credits every transition and effect', () => {
    expect(TRANSITION_CREDITS.length).toBe(SHADER_TRANSITIONS.length);
    for (const credit of TRANSITION_CREDITS) expect(credit.author && credit.url.startsWith('https://github.com/gl-transitions/')).toBeTruthy();
    expect(EFFECT_CREDITS.length).toBe(EFFECTS.length);
  });
});
