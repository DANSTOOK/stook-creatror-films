import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { STICKERS, STICKER_CATEGORIES, stickerById } from '@renderer/stickers/catalog';

/**
 * The sticker catalog: 218 stickers in eleven groups - 98 drawn here and the 120
 * emoji of Twemoji (stickers/twemoji) - each
 * named in both languages, the lettered ones with their words in both.
 * The pictures themselves are judged in the running app (tests/ui/stickers.mjs,
 * tests/ui/stickers-more.mjs); here, what the panel and the drawings rely on.
 */

describe('the sticker catalog', () => {
  it('has 218 stickers, each its own id', () => {
    expect(STICKERS).toHaveLength(218);
    expect(new Set(STICKERS.map((sticker) => sticker.id)).size).toBe(STICKERS.length);
    expect(stickerById('thumbsUp')?.category).toBe('social');
  });

it('is either drawn here or artwork from elsewhere, never both and never neither', () => {
    for (const sticker of STICKERS) {
      // paintSticker chooses between the two, so a sticker with neither would
      // be a blank tile and a blank PNG on the timeline.
      expect(Boolean(sticker.draw) !== Boolean(sticker.art), sticker.id).toBe(true);
    }
  });

  it('keeps the emoji in a group of their own, and their ids apart from the drawn ones', () => {
    const emoji = STICKERS.filter((sticker) => sticker.category === 'emoji');
    expect(emoji).toHaveLength(120);
    for (const sticker of emoji) {
      expect(sticker.art, sticker.id).toBeTruthy();
      expect(sticker.id.startsWith('emoji-'), sticker.id).toBe(true);
    }
    // An emoji called pizza and the drawn pizza are two stickers and two files.
    expect(STICKERS.filter((sticker) => sticker.id === 'pizza')).toHaveLength(1);
    expect(STICKERS.filter((sticker) => sticker.id === 'emoji-pizza')).toHaveLength(1);
  });

  it('puts every sticker in a group the panel shows, five or more to each group', () => {
    for (const sticker of STICKERS) expect(STICKER_CATEGORIES).toContain(sticker.category);
    for (const category of STICKER_CATEGORIES) expect(STICKERS.filter((sticker) => sticker.category === category).length).toBeGreaterThanOrEqual(5);
  });

  it('names each in both languages', () => {
    for (const sticker of STICKERS) {
      expect(en[sticker.label], sticker.id).toBeTruthy();
      expect(es[sticker.label], sticker.id).toBeTruthy();
    }
  });

  it('has the words of every lettered sticker in both languages, and says them in Spanish', () => {
    // The words a sticker letters are the messages ending in "Text" beside its name.
    const lettered = Object.keys(en).filter((key) => key.startsWith('sticker.') && key.endsWith('Text'));
    expect(lettered.length).toBeGreaterThanOrEqual(13);
    for (const key of lettered) expect(es[key as keyof typeof es], key).toBeTruthy();
    expect(es['sticker.saleText']).toBe('OFERTA');
    expect(es['sticker.followUsText']).toBe('SÍGUENOS');
    expect(es['sticker.liveText']).toBe('EN VIVO');
  });
});
