import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { EFFECT_GROUPS, SOUNDS, soundById } from '@renderer/sounds/catalog';

/**
 * The sound catalog: forty-six effects in six groups (block 7b) and the
 * music, each named in both languages. How they sound is judged in the
 * running app (tests/ui/sounds.mjs, tests/ui/sounds-more.mjs); here, what the
 * panel and the files rely on.
 */

describe('the sound catalog', () => {
  const effects = SOUNDS.filter((sound) => sound.category === 'effects');

  it('has forty-six effects and the music, each its own id - also as a file name', () => {
    expect(effects).toHaveLength(46);
    expect(SOUNDS.filter((sound) => sound.category === 'music').length).toBeGreaterThanOrEqual(5);
    expect(new Set(SOUNDS.map((sound) => sound.id)).size).toBe(SOUNDS.length);
    // The app's folder keeps each as "<id, lower case>-v2.wav" (main/ipc/fileSystem): no two may meet there.
    expect(new Set(SOUNDS.map((sound) => sound.id.toLowerCase())).size).toBe(SOUNDS.length);
    expect(soundById('applause')?.group).toBe('drums');
  });

  it('puts every effect in a group the panel shows, four or more to each', () => {
    for (const sound of effects) expect(EFFECT_GROUPS, sound.id).toContain(sound.group);
    for (const group of EFFECT_GROUPS) expect(effects.filter((sound) => sound.group === group).length, group).toBeGreaterThanOrEqual(4);
  });

  it('names each in both languages, and each group', () => {
    for (const sound of SOUNDS) {
      expect(en[sound.label], sound.id).toBeTruthy();
      expect(es[sound.label], sound.id).toBeTruthy();
    }
    for (const key of ['sound.groupTransitions', 'sound.groupInterface', 'sound.groupCartoon', 'sound.groupDrums', 'sound.groupEveryday', 'sound.groupNature', 'sound.search'] as const) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
    }
  });

  it('gives every effect a length a short clip can have', () => {
    for (const sound of effects) expect(sound.seconds, sound.id).toBeGreaterThan(0.1);
    for (const sound of effects) expect(sound.seconds, sound.id).toBeLessThanOrEqual(5);
  });
});
