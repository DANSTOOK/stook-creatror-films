import type { Sticker } from './catalog';
import { circle, ellipse, fillPath, finish, inked, line, polygon, roundRect, starPath, strokePath, turned, vertical } from './draw';

/**
 * The fourth set of stickers (block 8): food and drink, travel, and more
 * shapes, icons, party pieces, pointers and nature.
 *
 * Drawn here on a canvas in the same hand as the rest (stickers/draw): a bold
 * fill, a thick white outline and a soft shadow, so one of these sits beside
 * one of the first sixty-six without looking borrowed. Nothing is downloaded
 * and no one else's artwork ships with the app.
 *
 * Food and travel are new groups rather than more "icons": a panel of ninety
 * stickers needs shelves a person can aim at, and these are the two CapCut and
 * Filmora both keep separate.
 */

/** A mug or a glass: a tapered body, and a handle when one is asked for. */
function cup(context: CanvasRenderingContext2D, size: number, top: string, bottom: string, handle: boolean): void {
  const body = polygon([
    [size * 0.28, size * 0.3],
    [size * 0.72, size * 0.3],
    [size * 0.64, size * 0.84],
    [size * 0.36, size * 0.84],
  ]);
  if (handle) {
    const ear = new Path2D();
    ear.ellipse(size * 0.76, size * 0.48, size * 0.12, size * 0.1, 0, 0, Math.PI * 2);
    finish(context, size, ear, vertical(context, size, top, bottom));
  }
  finish(context, size, body, vertical(context, size, top, bottom));
}

/** A rounded leaf, pointed at both ends, turned by `angle`. */
function leafAt(cx: number, cy: number, length: number, width: number, angle: number): Path2D {
  const path = new Path2D();
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const at = (along: number, across: number): [number, number] => [cx + cos * along - sin * across, cy + sin * along + cos * across];
  const [tipX, tipY] = at(length, 0);
  const [baseX, baseY] = at(-length, 0);
  const [leftX, leftY] = at(0, -width);
  const [rightX, rightY] = at(0, width);
  path.moveTo(baseX, baseY);
  path.quadraticCurveTo(leftX, leftY, tipX, tipY);
  path.quadraticCurveTo(rightX, rightY, baseX, baseY);
  return path;
}

export const FOOD: readonly Sticker[] = [
  {
    id: 'pizza',
    category: 'food',
    label: 'sticker.pizza',
    loop: 'sway',
    draw: (c, s) => {
      const slice = polygon([[s * 0.5, s * 0.1], [s * 0.88, s * 0.82], [s * 0.12, s * 0.82]]);
      finish(c, s, slice, vertical(c, s, '#fcd34d', '#f59e0b'));
      // The crust is the wide end, and the pepperoni sit above it.
      const crust = polygon([[s * 0.88, s * 0.82], [s * 0.12, s * 0.82], [s * 0.2, s * 0.66], [s * 0.8, s * 0.66]]);
      fillPath(c, crust, vertical(c, s, '#f59e0b', '#c2410c'));
      for (const [x, y] of [[0.42, 0.44], [0.6, 0.6], [0.36, 0.64]] as const) fillPath(c, circle(s * x, s * y, s * 0.06), '#dc2626');
    },
  },
  {
    id: 'burger',
    category: 'food',
    label: 'sticker.burger',
    loop: 'pulse',
    draw: (c, s) => {
      const bun = new Path2D();
      bun.moveTo(s * 0.14, s * 0.42);
      bun.quadraticCurveTo(s * 0.5, s * 0.04, s * 0.86, s * 0.42);
      bun.closePath();
      finish(c, s, bun, vertical(c, s, '#fbbf24', '#d97706'));
      fillPath(c, roundRect(s * 0.12, s * 0.44, s * 0.76, s * 0.1, s * 0.05), '#4ade80');
      fillPath(c, roundRect(s * 0.14, s * 0.53, s * 0.72, s * 0.14, s * 0.05), '#92400e');
      finish(c, s, roundRect(s * 0.14, s * 0.66, s * 0.72, s * 0.18, s * 0.09), vertical(c, s, '#fbbf24', '#b45309'));
    },
  },
  {
    id: 'coffee',
    category: 'food',
    label: 'sticker.coffee',
    loop: 'float',
    draw: (c, s) => {
      cup(c, s, '#f8fafc', '#cbd5e1', true);
      fillPath(c, roundRect(s * 0.3, s * 0.32, s * 0.4, s * 0.08, s * 0.04), '#78350f');
      // Steam: two ribbons leaning the same way.
      for (const x of [0.42, 0.58]) {
        const steam = new Path2D();
        steam.moveTo(s * x, s * 0.26);
        steam.quadraticCurveTo(s * (x + 0.07), s * 0.18, s * x, s * 0.1);
        strokePath(c, steam, '#ffffff', s * 0.045);
      }
    },
  },
  {
    id: 'iceCream',
    category: 'food',
    label: 'sticker.iceCream',
    loop: 'sway',
    draw: (c, s) => {
      const cone = polygon([[s * 0.34, s * 0.5], [s * 0.66, s * 0.5], [s * 0.5, s * 0.92]]);
      finish(c, s, cone, vertical(c, s, '#fcd34d', '#b45309'));
      finish(c, s, circle(s * 0.42, s * 0.36, s * 0.16), vertical(c, s, '#fda4af', '#e11d48'));
      finish(c, s, circle(s * 0.6, s * 0.34, s * 0.15), vertical(c, s, '#fef3c7', '#f59e0b'));
      finish(c, s, circle(s * 0.5, s * 0.22, s * 0.14), vertical(c, s, '#ffffff', '#bae6fd'));
    },
  },
  {
    id: 'donut',
    category: 'food',
    label: 'sticker.donut',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, circle(s * 0.5, s * 0.5, s * 0.4), vertical(c, s, '#fbbf24', '#b45309'));
      // The icing, poured over the top half and dripping.
      const icing = new Path2D();
      icing.arc(s * 0.5, s * 0.5, s * 0.38, Math.PI, 0);
      icing.quadraticCurveTo(s * 0.74, s * 0.68, s * 0.5, s * 0.6);
      icing.quadraticCurveTo(s * 0.26, s * 0.68, s * 0.12, s * 0.5);
      fillPath(c, icing, vertical(c, s, '#f9a8d4', '#db2777'));
      fillPath(c, circle(s * 0.5, s * 0.5, s * 0.13), '#ffffff');
      for (const [x, y, a] of [[0.36, 0.34, 0.5], [0.58, 0.3, -0.4], [0.68, 0.46, 0.3]] as const) {
        turned(c, s, a, () => fillPath(c, roundRect(s * x, s * y, s * 0.09, s * 0.03, s * 0.015), '#ffffff'));
      }
    },
  },
  {
    id: 'taco',
    category: 'food',
    label: 'sticker.taco',
    loop: 'sway',
    draw: (c, s) => {
      const shell = new Path2D();
      shell.moveTo(s * 0.1, s * 0.72);
      shell.quadraticCurveTo(s * 0.5, s * 0.1, s * 0.9, s * 0.72);
      shell.closePath();
      finish(c, s, shell, vertical(c, s, '#fcd34d', '#d97706'));
      const filling = new Path2D();
      filling.moveTo(s * 0.16, s * 0.6);
      filling.quadraticCurveTo(s * 0.5, s * 0.3, s * 0.84, s * 0.6);
      strokePath(c, filling, '#16a34a', s * 0.1);
      strokePath(c, filling, '#dc2626', s * 0.05);
    },
  },
  {
    id: 'cake',
    category: 'food',
    label: 'sticker.cake',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, roundRect(s * 0.16, s * 0.5, s * 0.68, s * 0.34, s * 0.06), vertical(c, s, '#fda4af', '#be123c'));
      fillPath(c, roundRect(s * 0.16, s * 0.56, s * 0.68, s * 0.08, s * 0.04), '#ffffff');
      // One candle, lit.
      fillPath(c, roundRect(s * 0.47, s * 0.28, s * 0.06, s * 0.22, s * 0.03), '#f8fafc');
      finish(c, s, ellipse(s * 0.5, s * 0.22, s * 0.05, s * 0.08), vertical(c, s, '#fde047', '#f97316'), true, 0.04);
    },
  },
  {
    id: 'avocado',
    category: 'food',
    label: 'sticker.avocado',
    loop: 'float',
    draw: (c, s) => {
      const half = new Path2D();
      half.moveTo(s * 0.5, s * 0.1);
      half.bezierCurveTo(s * 0.78, s * 0.22, s * 0.84, s * 0.56, s * 0.5, s * 0.9);
      half.bezierCurveTo(s * 0.16, s * 0.56, s * 0.22, s * 0.22, s * 0.5, s * 0.1);
      finish(c, s, half, vertical(c, s, '#4ade80', '#15803d'));
      fillPath(c, circle(s * 0.5, s * 0.56, s * 0.22), '#fef9c3');
      fillPath(c, circle(s * 0.5, s * 0.58, s * 0.12), '#a16207');
    },
  },
];

export const TRAVEL: readonly Sticker[] = [
  {
    id: 'plane',
    category: 'travel',
    label: 'sticker.plane',
    loop: 'float',
    draw: (c, s) => {
      const body = polygon([
        [s * 0.5, s * 0.08],
        [s * 0.6, s * 0.4],
        [s * 0.94, s * 0.6],
        [s * 0.94, s * 0.7],
        [s * 0.58, s * 0.62],
        [s * 0.56, s * 0.82],
        [s * 0.68, s * 0.92],
        [s * 0.5, s * 0.88],
        [s * 0.32, s * 0.92],
        [s * 0.44, s * 0.82],
        [s * 0.42, s * 0.62],
        [s * 0.06, s * 0.7],
        [s * 0.06, s * 0.6],
        [s * 0.4, s * 0.4],
      ]);
      finish(c, s, body, vertical(c, s, '#e2e8f0', '#64748b'));
    },
  },
  {
    id: 'suitcase',
    category: 'travel',
    label: 'sticker.suitcase',
    loop: 'sway',
    draw: (c, s) => {
      const handle = new Path2D();
      handle.moveTo(s * 0.38, s * 0.28);
      handle.quadraticCurveTo(s * 0.5, s * 0.14, s * 0.62, s * 0.28);
      strokePath(c, handle, '#ffffff', s * 0.1);
      strokePath(c, handle, '#475569', s * 0.06);
      finish(c, s, roundRect(s * 0.14, s * 0.3, s * 0.72, s * 0.54, s * 0.08), vertical(c, s, '#f59e0b', '#b45309'));
      fillPath(c, roundRect(s * 0.14, s * 0.52, s * 0.72, s * 0.08, 0), '#78350f');
    },
  },
  {
    id: 'camera',
    category: 'travel',
    label: 'sticker.camera',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, roundRect(s * 0.1, s * 0.3, s * 0.8, s * 0.48, s * 0.09), vertical(c, s, '#64748b', '#1e293b'));
      fillPath(c, roundRect(s * 0.34, s * 0.2, s * 0.26, s * 0.12, s * 0.04), '#334155');
      finish(c, s, circle(s * 0.5, s * 0.54, s * 0.17), vertical(c, s, '#93c5fd', '#1d4ed8'), true, 0.045);
      fillPath(c, circle(s * 0.44, s * 0.48, s * 0.05), '#ffffff');
    },
  },
  {
    id: 'palm',
    category: 'travel',
    label: 'sticker.palm',
    loop: 'sway',
    draw: (c, s) => {
      const trunk = new Path2D();
      trunk.moveTo(s * 0.44, s * 0.9);
      trunk.quadraticCurveTo(s * 0.52, s * 0.6, s * 0.46, s * 0.36);
      line(c, s, trunk, '#a16207', s * 0.09);
      for (const angle of [-2.5, -2, -1.5, -1, -0.6]) {
        finish(c, s, leafAt(s * 0.47, s * 0.34, s * 0.26, s * 0.1, angle), vertical(c, s, '#4ade80', '#15803d'), true, 0.035);
      }
    },
  },
  {
    id: 'ticket',
    category: 'travel',
    label: 'sticker.ticket',
    loop: 'pulse',
    draw: (c, s) => {
      turned(c, s, -0.15, () => {
        finish(c, s, roundRect(s * 0.08, s * 0.34, s * 0.84, s * 0.34, s * 0.06), vertical(c, s, '#fcd34d', '#d97706'));
        // The stub, torn off along a dotted line.
        const tear = new Path2D();
        tear.moveTo(s * 0.66, s * 0.34);
        tear.lineTo(s * 0.66, s * 0.68);
        c.save();
        c.setLineDash([s * 0.04, s * 0.03]);
        strokePath(c, tear, '#78350f', s * 0.02);
        c.restore();
        fillPath(c, circle(s * 0.66, s * 0.34, s * 0.04), '#ffffff');
        fillPath(c, circle(s * 0.66, s * 0.68, s * 0.04), '#ffffff');
      });
    },
  },
  {
    id: 'globe',
    category: 'travel',
    label: 'sticker.globe',
    loop: 'sway',
    draw: (c, s) => {
      finish(c, s, circle(s * 0.5, s * 0.5, s * 0.4), vertical(c, s, '#60a5fa', '#1d4ed8'));
      // Two continents, enough to read as land without pretending to be a map.
      fillPath(c, polygon([[s * 0.3, s * 0.36], [s * 0.48, s * 0.3], [s * 0.5, s * 0.46], [s * 0.34, s * 0.52]]), '#4ade80');
      fillPath(c, polygon([[s * 0.56, s * 0.54], [s * 0.72, s * 0.5], [s * 0.7, s * 0.68], [s * 0.54, s * 0.66]]), '#4ade80');
      const meridian = new Path2D();
      meridian.ellipse(s * 0.5, s * 0.5, s * 0.16, s * 0.4, 0, 0, Math.PI * 2);
      strokePath(c, meridian, '#ffffff', s * 0.022);
    },
  },
];

export const MORE_SHAPES: readonly Sticker[] = [
  {
    id: 'diamond',
    category: 'shapes',
    label: 'sticker.diamond',
    loop: 'pulse',
    draw: (c, s) => finish(c, s, polygon([[s * 0.5, s * 0.08], [s * 0.9, s * 0.5], [s * 0.5, s * 0.92], [s * 0.1, s * 0.5]]), vertical(c, s, '#a5f3fc', '#0891b2')),
  },
  {
    id: 'hexagon',
    category: 'shapes',
    label: 'sticker.hexagon',
    loop: 'sway',
    draw: (c, s) => {
      const points: Array<readonly [number, number]> = [];
      for (let index = 0; index < 6; index += 1) {
        const angle = (index * Math.PI) / 3 - Math.PI / 2;
        points.push([s * 0.5 + Math.cos(angle) * s * 0.42, s * 0.5 + Math.sin(angle) * s * 0.42]);
      }
      finish(c, s, polygon(points), vertical(c, s, '#c4b5fd', '#6d28d9'));
    },
  },
  {
    id: 'badge',
    category: 'shapes',
    label: 'sticker.badge',
    loop: 'pulse',
    draw: (c, s) => {
      // A rosette: a many-pointed star with a disc on it, the shape a price sits in.
      finish(c, s, starPath(s * 0.5, s * 0.5, s * 0.46, s * 0.38, 12), vertical(c, s, '#fb7185', '#be123c'));
      finish(c, s, circle(s * 0.5, s * 0.5, s * 0.28), vertical(c, s, '#fff1f2', '#fda4af'), true, 0.04);
    },
  },
  {
    id: 'spark',
    category: 'shapes',
    label: 'sticker.spark',
    loop: 'pulse',
    draw: (c, s) => {
      // A four-pointed glint, the one that says "new" or "clean".
      const glint = starPath(s * 0.5, s * 0.5, s * 0.46, s * 0.1, 4);
      finish(c, s, glint, vertical(c, s, '#ffffff', '#38bdf8'));
    },
  },
  {
    id: 'blob',
    category: 'shapes',
    label: 'sticker.blob',
    loop: 'float',
    draw: (c, s) => {
      const blob = new Path2D();
      blob.moveTo(s * 0.5, s * 0.08);
      blob.bezierCurveTo(s * 0.86, s * 0.12, s * 0.94, s * 0.48, s * 0.78, s * 0.74);
      blob.bezierCurveTo(s * 0.6, s * 0.98, s * 0.2, s * 0.9, s * 0.1, s * 0.6);
      blob.bezierCurveTo(s * 0.02, s * 0.34, s * 0.2, s * 0.08, s * 0.5, s * 0.08);
      finish(c, s, blob, vertical(c, s, '#fde68a', '#f97316'));
    },
  },
];

export const MORE_ICONS: readonly Sticker[] = [
  {
    id: 'lock',
    category: 'icons',
    label: 'sticker.lock',
    loop: 'pulse',
    draw: (c, s) => {
      const shackle = new Path2D();
      shackle.arc(s * 0.5, s * 0.4, s * 0.18, Math.PI, 0);
      strokePath(c, shackle, '#ffffff', s * 0.14);
      strokePath(c, shackle, '#64748b', s * 0.09);
      finish(c, s, roundRect(s * 0.24, s * 0.4, s * 0.52, s * 0.44, s * 0.08), vertical(c, s, '#fbbf24', '#b45309'));
      fillPath(c, circle(s * 0.5, s * 0.6, s * 0.06), '#78350f');
    },
  },
  {
    id: 'bulb',
    category: 'icons',
    label: 'sticker.bulb',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, circle(s * 0.5, s * 0.42, s * 0.28), vertical(c, s, '#fef08a', '#f59e0b'));
      finish(c, s, roundRect(s * 0.4, s * 0.66, s * 0.2, s * 0.2, s * 0.04), vertical(c, s, '#cbd5e1', '#475569'));
      for (const angle of [-0.9, -0.3, 0.3, 0.9]) {
        const ray = new Path2D();
        ray.moveTo(s * 0.5 + Math.sin(angle) * s * 0.34, s * 0.42 - Math.cos(angle) * s * 0.34);
        ray.lineTo(s * 0.5 + Math.sin(angle) * s * 0.46, s * 0.42 - Math.cos(angle) * s * 0.46);
        strokePath(c, ray, '#fbbf24', s * 0.045);
      }
    },
  },
  {
    id: 'rocket',
    category: 'icons',
    label: 'sticker.rocket',
    loop: 'float',
    draw: (c, s) => {
      const body = new Path2D();
      body.moveTo(s * 0.5, s * 0.06);
      body.quadraticCurveTo(s * 0.72, s * 0.34, s * 0.68, s * 0.7);
      body.lineTo(s * 0.32, s * 0.7);
      body.quadraticCurveTo(s * 0.28, s * 0.34, s * 0.5, s * 0.06);
      finish(c, s, body, vertical(c, s, '#f8fafc', '#94a3b8'));
      finish(c, s, polygon([[s * 0.32, s * 0.52], [s * 0.14, s * 0.78], [s * 0.32, s * 0.7]]), vertical(c, s, '#fb7185', '#be123c'), true, 0.04);
      finish(c, s, polygon([[s * 0.68, s * 0.52], [s * 0.86, s * 0.78], [s * 0.68, s * 0.7]]), vertical(c, s, '#fb7185', '#be123c'), true, 0.04);
      fillPath(c, circle(s * 0.5, s * 0.38, s * 0.09), '#38bdf8');
      finish(c, s, ellipse(s * 0.5, s * 0.82, s * 0.1, s * 0.14), vertical(c, s, '#fde047', '#f97316'), true, 0.04);
    },
  },
  {
    id: 'clock',
    category: 'icons',
    label: 'sticker.clock',
    loop: 'sway',
    draw: (c, s) => {
      finish(c, s, circle(s * 0.5, s * 0.5, s * 0.4), vertical(c, s, '#f8fafc', '#cbd5e1'));
      fillPath(c, circle(s * 0.5, s * 0.5, s * 0.32), '#ffffff');
      const hands = new Path2D();
      hands.moveTo(s * 0.5, s * 0.5);
      hands.lineTo(s * 0.5, s * 0.26);
      hands.moveTo(s * 0.5, s * 0.5);
      hands.lineTo(s * 0.68, s * 0.56);
      strokePath(c, hands, '#1e293b', s * 0.05);
      fillPath(c, circle(s * 0.5, s * 0.5, s * 0.04), '#ef4444');
    },
  },
  {
    id: 'paw',
    category: 'icons',
    label: 'sticker.paw',
    loop: 'pulse',
    draw: (c, s) => {
      for (const [x, y, r] of [[0.28, 0.4, 0.1], [0.43, 0.3, 0.1], [0.58, 0.3, 0.1], [0.73, 0.4, 0.1]] as const) {
        finish(c, s, circle(s * x, s * y, s * r), vertical(c, s, '#fdba74', '#c2410c'), true, 0.04);
      }
      finish(c, s, ellipse(s * 0.5, s * 0.66, s * 0.24, s * 0.2), vertical(c, s, '#fdba74', '#c2410c'));
    },
  },
];

export const MORE_PARTY: readonly Sticker[] = [
  {
    id: 'streamer',
    category: 'party',
    label: 'sticker.streamer',
    loop: 'sway',
    draw: (c, s) => {
      // A paper streamer: one ribbon curling down, in three colours.
      const colours = ['#f472b6', '#38bdf8', '#fde047'];
      colours.forEach((colour, index) => {
        const ribbon = new Path2D();
        const x = 0.24 + index * 0.26;
        ribbon.moveTo(s * x, s * 0.08);
        ribbon.bezierCurveTo(s * (x + 0.14), s * 0.34, s * (x - 0.14), s * 0.6, s * x, s * 0.9);
        strokePath(c, ribbon, '#ffffff', s * 0.095);
        strokePath(c, ribbon, colour, s * 0.055);
      });
    },
  },
  {
    id: 'sparkler',
    category: 'party',
    label: 'sticker.sparkler',
    loop: 'pulse',
    draw: (c, s) => {
      const stick = new Path2D();
      stick.moveTo(s * 0.5, s * 0.92);
      stick.lineTo(s * 0.5, s * 0.5);
      line(c, s, stick, '#475569', s * 0.055);
      // The burst at the top: spokes of different lengths, so it reads as a shower.
      for (let index = 0; index < 14; index += 1) {
        const angle = (index / 14) * Math.PI * 2;
        const length = s * (index % 3 === 0 ? 0.3 : 0.2);
        const ray = new Path2D();
        ray.moveTo(s * 0.5 + Math.cos(angle) * s * 0.06, s * 0.44 + Math.sin(angle) * s * 0.06);
        ray.lineTo(s * 0.5 + Math.cos(angle) * length, s * 0.44 + Math.sin(angle) * length);
        strokePath(c, ray, '#ffffff', s * 0.05);
        strokePath(c, ray, index % 2 === 0 ? '#fde047' : '#fb923c', s * 0.026);
      }
    },
  },
  {
    id: 'gem',
    category: 'party',
    label: 'sticker.gem',
    loop: 'pulse',
    draw: (c, s) => {
      const stone = polygon([[s * 0.5, s * 0.9], [s * 0.1, s * 0.42], [s * 0.26, s * 0.16], [s * 0.74, s * 0.16], [s * 0.9, s * 0.42]]);
      finish(c, s, stone, vertical(c, s, '#67e8f9', '#0e7490'));
      // The facets: lines from the crown down to the point.
      const facets = new Path2D();
      for (const x of [0.26, 0.5, 0.74]) {
        facets.moveTo(s * x, s * 0.16);
        facets.lineTo(s * 0.5, s * 0.9);
      }
      facets.moveTo(s * 0.1, s * 0.42);
      facets.lineTo(s * 0.9, s * 0.42);
      strokePath(c, facets, '#cffafe', s * 0.022);
    },
  },
];

export const MORE_POINTERS: readonly Sticker[] = [
  {
    id: 'arrowUp',
    category: 'pointers',
    label: 'sticker.arrowUp',
    loop: 'float',
    draw: (c, s) => {
      const arrow = polygon([
        [s * 0.5, s * 0.08],
        [s * 0.86, s * 0.46],
        [s * 0.64, s * 0.46],
        [s * 0.64, s * 0.9],
        [s * 0.36, s * 0.9],
        [s * 0.36, s * 0.46],
        [s * 0.14, s * 0.46],
      ]);
      finish(c, s, arrow, vertical(c, s, '#4ade80', '#15803d'));
    },
  },
  {
    id: 'circleMark',
    category: 'pointers',
    label: 'sticker.circleMark',
    loop: 'pulse',
    draw: (c, s) => {
      // A ring drawn by hand around something, as a marker pen leaves it:
      // not quite closed, and not quite round.
      const ring = new Path2D();
      ring.ellipse(s * 0.5, s * 0.5, s * 0.4, s * 0.33, -0.12, 0.5, Math.PI * 2.1);
      strokePath(c, ring, '#ffffff', s * 0.12);
      strokePath(c, ring, '#ef4444', s * 0.075);
    },
  },
  {
    id: 'swipeHand',
    category: 'pointers',
    label: 'sticker.swipeHand',
    loop: 'sway',
    draw: (c, s) => {
      // A hand with one finger out, and the trail of the swipe behind it.
      const trail = new Path2D();
      trail.moveTo(s * 0.16, s * 0.3);
      trail.quadraticCurveTo(s * 0.38, s * 0.18, s * 0.56, s * 0.3);
      c.save();
      c.setLineDash([s * 0.06, s * 0.05]);
      strokePath(c, trail, '#ffffff', s * 0.05);
      c.restore();
      const hand = new Path2D();
      hand.moveTo(s * 0.46, s * 0.9);
      hand.lineTo(s * 0.44, s * 0.52);
      hand.quadraticCurveTo(s * 0.44, s * 0.34, s * 0.54, s * 0.34);
      hand.quadraticCurveTo(s * 0.64, s * 0.34, s * 0.64, s * 0.52);
      hand.lineTo(s * 0.78, s * 0.58);
      hand.quadraticCurveTo(s * 0.86, s * 0.64, s * 0.8, s * 0.78);
      hand.quadraticCurveTo(s * 0.72, s * 0.9, s * 0.46, s * 0.9);
      inked(c, s, hand, vertical(c, s, '#fde68a', '#f59e0b'));
    },
  },
];

export const MORE_NATURE: readonly Sticker[] = [
  {
    id: 'seaWave',
    category: 'nature',
    label: 'sticker.seaWave',
    loop: 'float',
    draw: (c, s) => {
      const wave = new Path2D();
      wave.moveTo(s * 0.06, s * 0.62);
      wave.quadraticCurveTo(s * 0.3, s * 0.3, s * 0.52, s * 0.56);
      wave.quadraticCurveTo(s * 0.72, s * 0.8, s * 0.94, s * 0.48);
      wave.lineTo(s * 0.94, s * 0.86);
      wave.lineTo(s * 0.06, s * 0.86);
      finish(c, s, wave, vertical(c, s, '#60a5fa', '#1d4ed8'));
      const crest = new Path2D();
      crest.moveTo(s * 0.06, s * 0.62);
      crest.quadraticCurveTo(s * 0.3, s * 0.3, s * 0.52, s * 0.56);
      strokePath(c, crest, '#ffffff', s * 0.05);
    },
  },
  {
    id: 'cactus',
    category: 'nature',
    label: 'sticker.cactus',
    loop: 'sway',
    draw: (c, s) => {
      finish(c, s, roundRect(s * 0.42, s * 0.24, s * 0.18, s * 0.62, s * 0.09), vertical(c, s, '#4ade80', '#15803d'));
      // Two arms, one higher than the other, which is what makes it read as a cactus.
      const arm = (x: number, y: number, up: number, flip: number): void => {
        const path = new Path2D();
        path.moveTo(s * x, s * y);
        path.lineTo(s * (x + flip * 0.14), s * y);
        path.lineTo(s * (x + flip * 0.14), s * up);
        strokePath(c, path, '#ffffff', s * 0.16);
        strokePath(c, path, '#16a34a', s * 0.11);
      };
      arm(0.44, 0.56, 0.4, -1);
      arm(0.58, 0.66, 0.5, 1);
      fillPath(c, roundRect(s * 0.3, s * 0.86, s * 0.42, s * 0.08, s * 0.04), '#a16207');
    },
  },
];

/** The fourth set, in the order the panel's groups come in. */
export const BLOCK_EIGHT: readonly Sticker[] = [
  ...MORE_SHAPES,
  ...MORE_ICONS,
  ...MORE_PARTY,
  ...MORE_NATURE,
  ...MORE_POINTERS,
  ...FOOD,
  ...TRAVEL,
];
