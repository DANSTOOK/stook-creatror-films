import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, fontString } from '@renderer/text/fonts';

/**
 * The fonts that ship for titles: exactly the files downloaded from their
 * authors' repositories (PROVENANCE.txt), declared from files inside the
 * app, never from the network, with their licences alongside.
 */

const fontsDir = resolve(__dirname, '../src/renderer/assets/fonts');
const css = readFileSync(resolve(__dirname, '../src/renderer/index.css'), 'utf8');
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(resolve(fontsDir, file))).digest('hex');

describe('the bundled font files', () => {
  it('are the files published by their authors, unmodified', () => {
    expect(sha256('InterVariable.woff2')).toBe('693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3');
    expect(sha256('SourceSerif4Variable-Roman.ttf.woff2')).toBe('940a76eda1388de39d38c8e7a79bf6ea058a387faee0a9f33c8d25c6ba05e1be');
    expect(sha256('Oswald-wght.ttf')).toBe('5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817');
  });

  it('each travel with the SIL Open Font License, shown in the app', () => {
    expect(BUNDLED_FONTS.map((font) => font.family)).toEqual(['Inter', 'Source Serif 4', 'Oswald']);
    for (const font of BUNDLED_FONTS) {
      expect(font.licence).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
    }
    expect(BUNDLED_FONTS[1].licence).toMatch(/Reserved Font Name .Source./);
  });
});

describe('@font-face', () => {
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((match) => match[1]);

  it('declares each bundled family once', () => {
    const families = faces.map((face) => /font-family:\s*"([^"]+)"/.exec(face)?.[1]);
    expect(families).toEqual(BUNDLED_FONTS.map((font) => font.family));
  });

  it('loads only from files in the app: no network, no local() lookups', () => {
    for (const face of faces) {
      const sources = [...face.matchAll(/url\(\s*"?([^")]+)"?\s*\)/g)].map((match) => match[1]);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatch(/^\.\/assets\/fonts\/[\w.-]+\.(woff2|ttf)$/);
      expect(face).not.toMatch(/https?:|local\(/);
      // And the file it names is really there.
      expect(() => readFileSync(resolve(fontsDir, sources[0].replace('./assets/fonts/', '')))).not.toThrow();
    }
  });

  it('covers the weights the inspector offers for each family', () => {
    for (const font of BUNDLED_FONTS) {
      const face = faces.find((candidate) => candidate.includes(`"${font.family}"`)) ?? '';
      expect(face).toContain(`font-weight: ${font.minWeight} ${font.maxWeight};`);
    }
  });
});

describe('the font a title asks for', () => {
  it('falls back to Inter, then the system, for anything the family lacks', () => {
    expect(fontString('Oswald', 600, 48)).toBe('600 48px "Oswald", "Inter", sans-serif');
    expect(fontString('Inter', 700, 96)).toBe('700 96px "Inter", sans-serif');
    // A name cannot break out of its quotes.
    expect(fontString('Evil", serif', 400, 10)).toBe('400 10px "Evil, serif", "Inter", sans-serif');
  });
});
