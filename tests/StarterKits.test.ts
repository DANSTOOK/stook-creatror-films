import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { STARTER_KITS, kitById } from '@renderer/project/kits';
import { BACKGROUNDS } from '@renderer/backgrounds/catalog';
import { FRAMES } from '@renderer/frames/catalog';
import { TITLE_TEMPLATES } from '@renderer/text/templates';

/**
 * The starter kits: what each one is made of.
 *
 * What a kit BUILDS is judged in the running app (tests/ui/kits.mjs), where
 * there is a project to build it into. Here, the thing that would break
 * silently: a kit naming a background, a frame or a title template that no
 * longer exists would simply leave that piece out, and the kit would arrive
 * missing its background with nothing said.
 */

/** The ids a kit's source asks for, read out of the module's own text. */
const asked = (source: string, call: string): string[] =>
  [...source.matchAll(new RegExp(`${call}\\('([^']+)'`, 'g'))].map((match) => match[1]);

describe('the starter kits', () => {
  it('has four, each its own id', () => {
    expect(STARTER_KITS).toHaveLength(4);
    expect(new Set(STARTER_KITS.map((kit) => kit.id)).size).toBe(STARTER_KITS.length);
    expect(kitById('short')?.shape).toBe('vertical');
    expect(kitById('podcast')?.shape).toBe('wide');
    expect(kitById('nothing')).toBeUndefined();
  });

  it('names each, and says what it is, in both languages', () => {
    for (const kit of STARTER_KITS) {
      for (const key of [kit.name, kit.what]) {
        expect(en[key], `${kit.id} ${key}`).toBeTruthy();
        expect(es[key], `${kit.id} ${key}`).toBeTruthy();
      }
    }
  });

  it('asks only for backgrounds, frames and title templates that exist', async () => {
    // Read from the source, because a kit's pieces are calls rather than data:
    // a missing id would not throw, it would quietly build one piece less.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('src/renderer/project/kits.ts', 'utf8');

    const backgrounds = asked(source, 'addBackground');
    const frames = asked(source, 'addFrame');
    const titles = asked(source, 'title');
    expect(backgrounds.length).toBeGreaterThanOrEqual(4);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(titles.length).toBeGreaterThanOrEqual(5);

    for (const id of backgrounds) expect(BACKGROUNDS.some((background) => background.id === id), id).toBe(true);
    for (const id of frames) expect(FRAMES.some((frame) => frame.id === id), id).toBe(true);
    for (const id of titles) expect(TITLE_TEMPLATES.some((template) => template.id === id), id).toBe(true);
  });

  it('builds something for every kit', () => {
    for (const kit of STARTER_KITS) expect(typeof kit.build, kit.id).toBe('function');
  });
});
