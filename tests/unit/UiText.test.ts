import { describe, expect, it } from 'vitest';
import { dbLabel, panLabel, signedDb } from '@renderer/audio/levels';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { translate } from '@shared/i18n';

describe('level and pan readings', () => {
  it('writes unity gain as 0.0 dB, with no sign and no -0.0', () => {
    expect(dbLabel(1)).toBe('0.0 dB');
    expect(dbLabel(1.0000001)).toBe('0.0 dB');
    expect(dbLabel(0.9999999)).toBe('0.0 dB');
  });

  it('writes half gain as -6.0 dB and double as +6.0 dB', () => {
    expect(dbLabel(0.5)).toBe('-6.0 dB');
    expect(dbLabel(2)).toBe('+6.0 dB');
  });

  it('calls silence -inf dB', () => {
    expect(dbLabel(0)).toBe('-inf dB');
  });

  it('writes pan as L, C or R with a percentage', () => {
    expect(panLabel(0)).toBe('C');
    expect(panLabel(-0.3)).toBe('L30');
    expect(panLabel(1)).toBe('R100');
  });

  it('signs a decibel value that is already in dB', () => {
    expect(signedDb(3)).toBe('+3.0 dB');
    expect(signedDb(-12.5)).toBe('-12.5 dB');
    expect(signedDb(-0.01)).toBe('0.0 dB');
  });
});

describe('interface language', () => {
  it('has a Spanish message for every English one, and nothing extra', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('keeps every placeholder of a message in its translation', () => {
    const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'inspector.keyframeHint', { frame: 90 })).toBe('Editing a value adds a keyframe at frame 90.');
    expect(translate('es', 'menu.about', {})).toBe('Acerca de {app}');
  });
});
