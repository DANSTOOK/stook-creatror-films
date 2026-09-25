import { describe, expect, it } from 'vitest';
import { dbLabel, panLabel, signedDb } from '@renderer/audio/levels';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { translate } from '@shared/i18n';
import { framesToTimecode, parseDuration } from '@shared/utils/timecode';
import { defaultFileName } from '@renderer/components/ExportDialog/exportName';

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

describe('a typed duration', () => {
  it('reads timecode fields from the right, as Premiere does', () => {
    expect(parseDuration('00:00:05:12', 30)).toBe(5 * 30 + 12);
    expect(parseDuration('5:12', 30)).toBe(5 * 30 + 12);
    expect(parseDuration('1:00:00', 25)).toBe(60 * 25);
    expect(parseDuration('01:02:03:04', 24)).toBe(((1 * 60 + 2) * 60 + 3) * 24 + 4);
  });

  it('takes a bare number as frames', () => {
    expect(parseDuration('150', 30)).toBe(150);
  });

  it('refuses what is not a duration instead of guessing', () => {
    expect(parseDuration('', 30)).toBeNull();
    expect(parseDuration('abc', 30)).toBeNull();
    expect(parseDuration('-5', 30)).toBeNull();
    expect(parseDuration('0:30', 30)).toBeNull(); // frame 30 does not exist at 30 fps
    expect(parseDuration('1:75:00', 30)).toBeNull();
  });

  it('round-trips what the field shows', () => {
    expect(parseDuration(framesToTimecode(4321, 30), 30)).toBe(4321);
  });
});

describe('the export file name', () => {
  it('is the project name, not the first clip', () => {
    expect(defaultFileName('Wedding')).toBe('Wedding');
  });

  it('drops what Windows will not take in a file name', () => {
    expect(defaultFileName('Cut: final/v2?')).toBe('Cut finalv2');
    expect(defaultFileName('Trailing dots...')).toBe('Trailing dots');
  });

  it('falls back to "export" when nothing is left', () => {
    expect(defaultFileName('???')).toBe('export');
    expect(defaultFileName('   ')).toBe('export');
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
