import { describe, expect, it } from 'vitest';

import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { fxEn } from '@shared/i18n/fx.en';
import { fxEs } from '@shared/i18n/fx.es';

/**
 * Every word the interface shows, read as text: no UTF-8 read back as
 * Latin-1 on the way in. "Modo de fusiÃ³n" sat in the inspector for months
 * - a file once saved through the wrong code page turns "ó" into "Ã³", "é"
 * into "Ã©", a dash into "â€”" - and nothing but looking caught it.
 */

const GARBLED = /Ã[\u0080-¿]|Â[\u0080-¿ ]|â€|ï¿½|�/;

const dictionaries = { en, es, fxEn, fxEs } as Record<string, Record<string, string>>;

describe('the interface text', () => {
  for (const [name, dictionary] of Object.entries(dictionaries)) {
    it(`has no garbled characters in ${name}`, () => {
      const garbled = Object.entries(dictionary).filter(([, text]) => GARBLED.test(text)).map(([key, text]) => `${key}: ${text}`);
      expect(garbled).toEqual([]);
    });
  }

  it('catches the garbling it is there for', () => {
    expect(GARBLED.test('Modo de fusiÃ³n')).toBe(true);
    expect(GARBLED.test('Modo de fusión')).toBe(false);
    expect(GARBLED.test('Más ajustes del proyecto…')).toBe(false);
  });
});
