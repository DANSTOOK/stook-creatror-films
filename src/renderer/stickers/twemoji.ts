import type { ClipAnimationId } from '@renderer/fx/motion/animations';
import type { Sticker, StickerCategory } from './catalog';
import { TWEMOJI_ART } from './twemojiAssets.generated';

/**
 * The emoji sticker group: a hundred and twenty of Twemoji's, in six shelves.
 *
 * These are the one thing in the library that is NOT drawn by this app. Twemoji's
 * graphics are CC-BY 4.0 and its code MIT (github.com/jdecked/twemoji), which
 * asks for credit, a link to the licence and a note of any change - carried in
 * renderer/fx/licenses.ts and shown in the Licenses dialog. The artwork is
 * unchanged but for its XML declaration and comments.
 *
 * They are kept in a group of their own on purpose. The other ninety-eight
 * stickers are drawn in one hand - a bold fill, a thick white outline, a soft
 * shadow - and an emoji beside one of those is visibly from somewhere else. A
 * separate shelf is honest about that; mixed in, the panel would just look
 * inconsistent.
 *
 * An emoji is a picture rather than a set of drawing calls, so it cannot be
 * painted in the same breath as the rest: see `paintSticker` in addSticker.ts,
 * which is what every caller goes through.
 */

/** The shelves, and what each one's stickers do once they have popped on. */
const LOOPS: Record<string, ClipAnimationId> = {
  faces: 'pulse',
  hands: 'sway',
  marks: 'pulse',
  animals: 'float',
  bites: 'sway',
  things: 'float',
};

export const TWEMOJI_GROUPS = ['faces', 'hands', 'marks', 'animals', 'bites', 'things'] as const;

export const TWEMOJI_STICKERS: readonly Sticker[] = TWEMOJI_ART.map((art) => ({
  // Prefixed, so an emoji called "pizza" and the drawn sticker called "pizza"
  // are two stickers and two files rather than one of each quietly winning.
  id: `emoji-${art.id}`,
  category: 'emoji' as StickerCategory,
  label: `twemoji.${art.id}` as Sticker['label'],
  loop: LOOPS[art.group] ?? 'pulse',
  art: art.svg,
  /** Which shelf of the emoji group it sits on. */
  shelf: art.group,
}));
