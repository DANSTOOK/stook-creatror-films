import type { MessageKey } from '@shared/i18n';
import type { ClipAnimationId } from '@renderer/fx/motion/animations';
import { circle, finish, heartPath, lettering, line, starPath, vertical } from './draw';
import { MORE_WORDS, NATURE, PARTY, POINTERS, REACTIONS, SOCIAL } from './sets';
import { BLOCK_EIGHT } from './more';

/**
 * Stickers: small pictures to put over the video - a heart, a star, an
 * arrow pointing at something, a "Subscribe" button - the stickers panel of
 * CapCut and Filmora.
 *
 * Every one is drawn on a canvas, in the same hand (stickers/draw): a bold
 * fill, a thick white outline and a soft shadow, so any two sit together and
 * each reads over any picture. Nothing is downloaded and no one else's artwork is
 * shipped. A sticker becomes a transparent PNG (stickers/addSticker), then an
 * ordinary still on its own track: moved, scaled, animated and exported as
 * any picture is. Each comes on with a pop and keeps moving with a loop of
 * its own (fx/motion/animations).
 */

export type StickerCategory = 'reactions' | 'shapes' | 'icons' | 'social' | 'party' | 'nature' | 'pointers' | 'words' | 'food' | 'travel';

export interface Sticker {
  id: string;
  category: StickerCategory;
  label: MessageKey;
  /** The loop it keeps moving with once it has popped on. */
  loop: ClipAnimationId;
  /** Draw it into a square `size` px canvas; `words` are its lettering, in the interface's language. */
  draw(context: CanvasRenderingContext2D, size: number, words: (key: MessageKey) => string): void;
}

/* The set ---------------------------------------------------------------------------- */

/** The first eighteen; the rest are in stickers/sets. */
const FIRST: readonly Sticker[] = [
  {
    id: 'heart',
    category: 'shapes',
    label: 'sticker.heart',
    loop: 'pulse',
    draw: (c, s) => finish(c, s, heartPath(s), vertical(c, s, '#ff6b8a', '#e11d48')),
  },
  {
    id: 'star',
    category: 'shapes',
    label: 'sticker.star',
    loop: 'sway',
    draw: (c, s) => finish(c, s, starPath(s / 2, s * 0.52, s * 0.4, s * 0.18, 5), vertical(c, s, '#ffe066', '#f59e0b')),
  },
  {
    id: 'fire',
    category: 'shapes',
    label: 'sticker.fire',
    loop: 'pulse',
    draw: (c, s) => {
      const outer = new Path2D();
      outer.moveTo(s * 0.5, s * 0.08);
      outer.bezierCurveTo(s * 0.62, s * 0.3, s * 0.86, s * 0.38, s * 0.8, s * 0.64);
      outer.bezierCurveTo(s * 0.76, s * 0.84, s * 0.6, s * 0.92, s * 0.5, s * 0.92);
      outer.bezierCurveTo(s * 0.32, s * 0.92, s * 0.18, s * 0.8, s * 0.2, s * 0.6);
      outer.bezierCurveTo(s * 0.22, s * 0.44, s * 0.34, s * 0.4, s * 0.36, s * 0.26);
      outer.bezierCurveTo(s * 0.44, s * 0.34, s * 0.46, s * 0.4, s * 0.44, s * 0.48);
      outer.bezierCurveTo(s * 0.54, s * 0.38, s * 0.56, s * 0.24, s * 0.5, s * 0.08);
      outer.closePath();
      finish(c, s, outer, vertical(c, s, '#fde047', '#ea580c'));
      const inner = new Path2D();
      inner.moveTo(s * 0.5, s * 0.5);
      inner.bezierCurveTo(s * 0.6, s * 0.62, s * 0.66, s * 0.7, s * 0.62, s * 0.8);
      inner.bezierCurveTo(s * 0.58, s * 0.88, s * 0.42, s * 0.88, s * 0.38, s * 0.8);
      inner.bezierCurveTo(s * 0.34, s * 0.7, s * 0.44, s * 0.64, s * 0.5, s * 0.5);
      inner.closePath();
      finish(c, s, inner, '#fef08a', false);
    },
  },
  {
    id: 'lightning',
    category: 'shapes',
    label: 'sticker.lightning',
    loop: 'pulse',
    draw: (c, s) => {
      const p = new Path2D();
      p.moveTo(s * 0.58, s * 0.06);
      p.lineTo(s * 0.24, s * 0.56);
      p.lineTo(s * 0.48, s * 0.56);
      p.lineTo(s * 0.4, s * 0.94);
      p.lineTo(s * 0.78, s * 0.4);
      p.lineTo(s * 0.54, s * 0.4);
      p.closePath();
      finish(c, s, p, vertical(c, s, '#fef08a', '#facc15'));
    },
  },
  {
    id: 'crown',
    category: 'shapes',
    label: 'sticker.crown',
    loop: 'float',
    draw: (c, s) => {
      const p = new Path2D();
      p.moveTo(s * 0.14, s * 0.72);
      p.lineTo(s * 0.1, s * 0.3);
      p.lineTo(s * 0.32, s * 0.5);
      p.lineTo(s * 0.5, s * 0.2);
      p.lineTo(s * 0.68, s * 0.5);
      p.lineTo(s * 0.9, s * 0.3);
      p.lineTo(s * 0.86, s * 0.72);
      p.closePath();
      p.rect(s * 0.14, s * 0.74, s * 0.72, s * 0.1);
      finish(c, s, p, vertical(c, s, '#fde68a', '#d97706'));
      for (const [x, y] of [[0.1, 0.3], [0.5, 0.2], [0.9, 0.3]] as const) finish(c, s, circle(s * x, s * y, s * 0.05), '#f43f5e', false);
    },
  },
  {
    id: 'sparkles',
    category: 'shapes',
    label: 'sticker.sparkles',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, starPath(s * 0.42, s * 0.5, s * 0.34, s * 0.07, 4), vertical(c, s, '#ffffff', '#fde047'));
      finish(c, s, starPath(s * 0.78, s * 0.24, s * 0.14, s * 0.03, 4), vertical(c, s, '#ffffff', '#fde047'));
      finish(c, s, starPath(s * 0.8, s * 0.78, s * 0.1, s * 0.025, 4), vertical(c, s, '#ffffff', '#fde047'));
    },
  },
  {
    id: 'arrow',
    category: 'shapes',
    label: 'sticker.arrow',
    loop: 'float',
    draw: (c, s) => {
      const shaft = new Path2D();
      shaft.moveTo(s * 0.12, s * 0.78);
      shaft.quadraticCurveTo(s * 0.2, s * 0.3, s * 0.7, s * 0.28);
      line(c, s, shaft, '#ef4444', s * 0.1);
      const head = new Path2D();
      head.moveTo(s * 0.9, s * 0.27);
      head.lineTo(s * 0.64, s * 0.1);
      head.lineTo(s * 0.66, s * 0.46);
      head.closePath();
      finish(c, s, head, '#ef4444');
    },
  },
  {
    id: 'ring',
    category: 'shapes',
    label: 'sticker.ring',
    loop: 'pulse',
    draw: (c, s) => {
      // A hand-drawn ring to circle something: a little more than once round, not quite closed.
      const p = new Path2D();
      p.ellipse(s * 0.5, s * 0.52, s * 0.38, s * 0.3, -0.12, Math.PI * 0.85, Math.PI * 2.95);
      line(c, s, p, '#ef4444', s * 0.06);
    },
  },
  {
    id: 'check',
    category: 'icons',
    label: 'sticker.check',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, circle(s / 2, s / 2, s * 0.4), vertical(c, s, '#4ade80', '#16a34a'));
      const tick = new Path2D();
      tick.moveTo(s * 0.3, s * 0.52);
      tick.lineTo(s * 0.44, s * 0.66);
      tick.lineTo(s * 0.72, s * 0.36);
      c.save();
      c.strokeStyle = '#ffffff';
      c.lineWidth = s * 0.09;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.stroke(tick);
      c.restore();
    },
  },
  {
    id: 'cross',
    category: 'icons',
    label: 'sticker.cross',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, circle(s / 2, s / 2, s * 0.4), vertical(c, s, '#f87171', '#dc2626'));
      const x = new Path2D();
      x.moveTo(s * 0.34, s * 0.34);
      x.lineTo(s * 0.66, s * 0.66);
      x.moveTo(s * 0.66, s * 0.34);
      x.lineTo(s * 0.34, s * 0.66);
      c.save();
      c.strokeStyle = '#ffffff';
      c.lineWidth = s * 0.09;
      c.lineCap = 'round';
      c.stroke(x);
      c.restore();
    },
  },
  {
    id: 'smile',
    category: 'icons',
    label: 'sticker.smile',
    loop: 'sway',
    draw: (c, s) => {
      finish(c, s, circle(s / 2, s / 2, s * 0.4), vertical(c, s, '#fde047', '#f59e0b'));
      c.save();
      c.fillStyle = '#3f2a14';
      c.fill(circle(s * 0.37, s * 0.42, s * 0.05));
      c.fill(circle(s * 0.63, s * 0.42, s * 0.05));
      const mouth = new Path2D();
      mouth.arc(s / 2, s * 0.52, s * 0.2, Math.PI * 0.15, Math.PI * 0.85);
      c.strokeStyle = '#3f2a14';
      c.lineWidth = s * 0.05;
      c.lineCap = 'round';
      c.stroke(mouth);
      c.restore();
    },
  },
  {
    id: 'question',
    category: 'icons',
    label: 'sticker.question',
    loop: 'sway',
    draw: (c, s, words) => {
      finish(c, s, circle(s / 2, s / 2, s * 0.4), vertical(c, s, '#a78bfa', '#7c3aed'));
      lettering(c, s, '?', s / 2, s * 0.52, s * 0.6, '#ffffff', s * 0.56);
      void words;
    },
  },
  {
    id: 'alert',
    category: 'icons',
    label: 'sticker.alert',
    loop: 'pulse',
    draw: (c, s) => {
      const p = new Path2D();
      p.moveTo(s * 0.5, s * 0.1);
      p.lineTo(s * 0.92, s * 0.86);
      p.lineTo(s * 0.08, s * 0.86);
      p.closePath();
      finish(c, s, p, vertical(c, s, '#fde047', '#f59e0b'));
      lettering(c, s, '!', s / 2, s * 0.6, s * 0.4, '#1f2937', s * 0.46);
    },
  },
  {
    id: 'music',
    category: 'icons',
    label: 'sticker.music',
    loop: 'sway',
    draw: (c, s) => {
      const p = new Path2D();
      p.ellipse(s * 0.3, s * 0.74, s * 0.14, s * 0.11, -0.4, 0, Math.PI * 2);
      p.ellipse(s * 0.72, s * 0.64, s * 0.14, s * 0.11, -0.4, 0, Math.PI * 2);
      p.rect(s * 0.38, s * 0.16, s * 0.07, s * 0.58);
      p.rect(s * 0.8, s * 0.08, s * 0.07, s * 0.56);
      const beam = new Path2D();
      beam.moveTo(s * 0.38, s * 0.16);
      beam.lineTo(s * 0.87, s * 0.06);
      beam.lineTo(s * 0.87, s * 0.2);
      beam.lineTo(s * 0.38, s * 0.3);
      beam.closePath();
      p.addPath(beam);
      finish(c, s, p, vertical(c, s, '#60a5fa', '#2563eb'));
    },
  },
  {
    id: 'pin',
    category: 'icons',
    label: 'sticker.pin',
    loop: 'float',
    draw: (c, s) => {
      const p = new Path2D();
      p.moveTo(s * 0.5, s * 0.94);
      p.bezierCurveTo(s * 0.3, s * 0.64, s * 0.16, s * 0.52, s * 0.16, s * 0.38);
      p.arc(s * 0.5, s * 0.38, s * 0.34, Math.PI, 0);
      p.bezierCurveTo(s * 0.84, s * 0.52, s * 0.7, s * 0.64, s * 0.5, s * 0.94);
      p.closePath();
      finish(c, s, p, vertical(c, s, '#f87171', '#dc2626'));
      finish(c, s, circle(s * 0.5, s * 0.38, s * 0.13), '#ffffff', false);
    },
  },
  {
    id: 'wow',
    category: 'words',
    label: 'sticker.wow',
    loop: 'sway',
    draw: (c, s, words) => {
      const bubble = new Path2D();
      bubble.ellipse(s * 0.5, s * 0.44, s * 0.42, s * 0.32, 0, 0, Math.PI * 2);
      const tail = new Path2D();
      tail.moveTo(s * 0.3, s * 0.68);
      tail.lineTo(s * 0.18, s * 0.92);
      tail.lineTo(s * 0.46, s * 0.74);
      tail.closePath();
      bubble.addPath(tail);
      finish(c, s, bubble, '#ffffff', false);
      c.save();
      c.strokeStyle = '#111827';
      c.lineWidth = s * 0.03;
      c.stroke(bubble);
      c.restore();
      lettering(c, s, words('sticker.wowText'), s * 0.5, s * 0.45, s * 0.66, '#f43f5e', s * 0.26);
    },
  },
  {
    id: 'new',
    category: 'words',
    label: 'sticker.new',
    loop: 'pulse',
    draw: (c, s, words) => {
      finish(c, s, starPath(s / 2, s / 2, s * 0.46, s * 0.36, 14), vertical(c, s, '#fde047', '#f97316'));
      lettering(c, s, words('sticker.newText'), s / 2, s * 0.51, s * 0.62, '#ffffff', s * 0.22);
    },
  },
  {
    id: 'subscribe',
    category: 'words',
    label: 'sticker.subscribe',
    loop: 'pulse',
    draw: (c, s, words) => {
      const pill = new Path2D();
      pill.roundRect(s * 0.04, s * 0.34, s * 0.92, s * 0.32, s * 0.16);
      finish(c, s, pill, vertical(c, s, '#ef4444', '#b91c1c'));
      lettering(c, s, words('sticker.subscribeText'), s * 0.5, s * 0.505, s * 0.8, '#ffffff', s * 0.13);
    },
  },
];

export const STICKERS: readonly Sticker[] = [...FIRST, ...REACTIONS, ...SOCIAL, ...PARTY, ...NATURE, ...POINTERS, ...MORE_WORDS, ...BLOCK_EIGHT];

/** The groups, in the order the panel shows them: the faces first, as CapCut's opens on its emoji. */
export const STICKER_CATEGORIES: readonly StickerCategory[] = ['reactions', 'shapes', 'icons', 'social', 'party', 'food', 'travel', 'nature', 'pointers', 'words'];
export const stickerById = (id: string): Sticker | undefined => STICKERS.find((sticker) => sticker.id === id);
