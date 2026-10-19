import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONTS, FONT_KINDS, fontString } from '@renderer/text/fonts';
import { missingCharacters, weightAxis } from './fontTables';

/**
 * The fonts that ship for titles: exactly the files downloaded from their
 * authors' repositories (PROVENANCE.txt), declared from files inside the
 * app, never from the network, with their licences alongside - and every
 * one able to write Spanish.
 */

const fontsDir = resolve(__dirname, '../src/renderer/assets/fonts');
const css = readFileSync(resolve(__dirname, '../src/renderer/index.css'), 'utf8');
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(resolve(fontsDir, file))).digest('hex');

/** Every bundled file, by family, with the hash in PROVENANCE.txt. */
const FILES: Record<string, { file: string; sha256: string }> = {
  Inter: { file: 'InterVariable.woff2', sha256: '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3' },
  'Source Serif 4': { file: 'SourceSerif4Variable-Roman.ttf.woff2', sha256: '940a76eda1388de39d38c8e7a79bf6ea058a387faee0a9f33c8d25c6ba05e1be' },
  Oswald: { file: 'Oswald-wght.ttf', sha256: '5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817' },
  Outfit: { file: 'Outfit-wght.ttf', sha256: 'fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade' },
  'Space Grotesk': { file: 'SpaceGrotesk-wght.ttf', sha256: 'acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72' },
  'Bebas Neue': { file: 'BebasNeue-Regular.ttf', sha256: '08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73' },
  Anton: { file: 'Anton-Regular.ttf', sha256: 'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab' },
  'League Gothic': { file: 'LeagueGothic-wdth.ttf', sha256: '3b0e998c9a0034222394ffecdd383e6948259ad037b95555b139a217629ce1d0' },
  'Archivo Black': { file: 'ArchivoBlack-Regular.ttf', sha256: 'dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180' },
  'Playfair Display': { file: 'PlayfairDisplay-wght.ttf', sha256: 'c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6' },
  Cinzel: { file: 'Cinzel-wght.ttf', sha256: 'f4d83d34d1f6c741193e4acf4b3dff9531e5a67b6aa65228d00a7db72a4e0f34' },
  'Abril Fatface': { file: 'AbrilFatface-Regular.ttf', sha256: '5971d4a3758a922a9fedc7f6fb825a96341a2e718c45a4b2c9a6b417c8c4dbe9' },
  Caveat: { file: 'Caveat-wght.ttf', sha256: '0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988' },
  'Dancing Script': { file: 'DancingScript-wght.ttf', sha256: '21808625578fe8d8cd10cb684be546dca077b27cd03a53a2f1ec11dc743c924c' },
  Knewave: { file: 'Knewave-Regular.ttf', sha256: 'ed3bac761d755b89ab3082c844d4a623d63c7d6eef85d22ba1fb6c680e6a4436' },
  Bangers: { file: 'Bangers-Regular.ttf', sha256: '4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824' },
  Righteous: { file: 'Righteous-Regular.ttf', sha256: '2ffb3fe5c27d7e6571210b800448c4e234e651b46c6b4426c1bb567e5341348a' },
  Monoton: { file: 'Monoton-Regular.ttf', sha256: '951c4cea65ffede784a7c9672feec5d329a7e1e12216c42d53ecf36c90d04dea' },
  'Press Start 2P': { file: 'PressStart2P-Regular.ttf', sha256: '034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d' },
  'Courier Prime': { file: 'CourierPrime-Regular.ttf', sha256: '72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af' },
};

/** What Spanish needs beyond plain ASCII: every one of these must be the family's own glyph. */
const SPANISH = 'áéíóúüñÁÉÍÓÚÜÑ¿¡«»';

describe('the bundled font files', () => {
  it('are the files published by their authors, unmodified', () => {
    expect(Object.keys(FILES).sort()).toEqual(BUNDLED_FONTS.map((font) => font.family).sort());
    for (const [family, { file, sha256: hash }] of Object.entries(FILES)) expect(sha256(file), family).toBe(hash);
  });

  it('are a curated set of twenty, every kind represented, about 2.6 MB in all', () => {
    expect(BUNDLED_FONTS).toHaveLength(20);
    for (const kind of FONT_KINDS) expect(BUNDLED_FONTS.some((font) => font.kind === kind), kind).toBe(true);
    const bytes = Object.values(FILES).reduce((sum, { file }) => sum + readFileSync(resolve(fontsDir, file)).length, 0);
    // A guard on the installer: a heavy family added by accident shows up here.
    expect(bytes).toBeLessThan(3_200_000);
  });

  it('each travel with the SIL Open Font License, shown in the app', () => {
    expect(BUNDLED_FONTS.slice(0, 3).map((font) => font.family)).toEqual(['Inter', 'Source Serif 4', 'Oswald']);
    for (const font of BUNDLED_FONTS) {
      expect(font.licence, font.family).toMatch(/SIL OPEN FONT LICENSE,? Version 1\.1/i);
    }
    expect(BUNDLED_FONTS[1].licence).toMatch(/Reserved Font Name .Source./);
  });

  it('write Spanish: accents, ü, ñ, ¿ and ¡ in every family that is not WOFF2-compressed', () => {
    let checked = 0;
    for (const font of BUNDLED_FONTS) {
      const { file } = FILES[font.family];
      if (!file.endsWith('.ttf')) continue;
      expect(missingCharacters(readFileSync(resolve(fontsDir, file)), SPANISH), font.family).toEqual([]);
      checked += 1;
    }
    // Inter and Source Serif are WOFF2; every other family is read here.
    expect(checked).toBe(18);
    // And the reader can tell a missing glyph: Knewave has no ª.
    expect(missingCharacters(readFileSync(resolve(fontsDir, FILES.Knewave.file)), 'ª')).toEqual(['ª']);
  });

  it('offer the weights the inspector lists: a variable file its whole range, a static one its own weight', () => {
    for (const font of BUNDLED_FONTS) {
      const { file } = FILES[font.family];
      if (!file.endsWith('.ttf')) continue;
      const axis = weightAxis(readFileSync(resolve(fontsDir, file)));
      if (font.minWeight === font.maxWeight) expect(axis, font.family).toBeNull();
      else expect(axis, font.family).toEqual({ min: font.minWeight, max: font.maxWeight });
    }
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
      // And the file it names is really there, and is the family's own.
      const family = /font-family:\s*"([^"]+)"/.exec(face)?.[1] ?? '';
      expect(sources[0].replace('./assets/fonts/', '')).toBe(FILES[family].file);
    }
  });

  it('covers the weights the inspector offers for each family', () => {
    for (const font of BUNDLED_FONTS) {
      const face = faces.find((candidate) => candidate.includes(`"${font.family}"`)) ?? '';
      const weight = font.minWeight === font.maxWeight ? `${font.minWeight}` : `${font.minWeight} ${font.maxWeight}`;
      expect(face, font.family).toContain(`font-weight: ${weight};`);
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
