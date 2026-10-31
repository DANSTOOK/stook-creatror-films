import type { MessageKey } from '@shared/i18n';

/**
 * Backgrounds: full-frame pictures to put behind a title, a talking head on a
 * green screen, or a Short that needs something under the text - the "stock"
 * shelf of CapCut and Canva.
 *
 * Every one is DRAWN here, at whatever size is asked, the way the stickers are
 * (renderer/stickers): a gradient, a texture, a pattern or a simple scene,
 * made of shapes and seeded noise. Nothing is downloaded and no one else's
 * photograph or artwork ships with the app, so each of these is free to use in
 * anything, with no licence to read and no attribution to carry.
 *
 * Because they are drawn and not decoded, one is made at the project's own
 * resolution - 4K included - and a vertical project gets a vertical picture
 * rather than a crop of a wide one. That is the thing a library of real
 * photographs cannot do.
 *
 * What this is NOT: photographs of real places and people. Those cannot be
 * drawn, and shipping someone else's would need a licence. A browser onto a
 * stock service (Pexels, Unsplash) is a separate decision, because it means
 * requests over the network, an API key and that service's terms.
 */

export type BackgroundGroup = 'gradients' | 'textures' | 'patterns' | 'scenes';

export interface Background {
  id: string;
  group: BackgroundGroup;
  label: MessageKey;
  /** Paint it over the whole of a `width` x `height` canvas. */
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
}

/* The brushes ---------------------------------------------------------------------- */

/** Mulberry32: the same grain and the same stars every time a background is drawn. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A straight gradient at `angle` radians across the frame, through `stops`. */
function sweep(context: CanvasRenderingContext2D, w: number, h: number, angle: number, stops: readonly string[]): void {
  const half = Math.hypot(w, h) / 2;
  const gradient = context.createLinearGradient(
    w / 2 - Math.cos(angle) * half,
    h / 2 - Math.sin(angle) * half,
    w / 2 + Math.cos(angle) * half,
    h / 2 + Math.sin(angle) * half,
  );
  stops.forEach((colour, index) => gradient.addColorStop(stops.length === 1 ? 0 : index / (stops.length - 1), colour));
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
}

/** A soft round glow centred at a fraction of the frame: a sun, a lamp, a bloom. */
function glow(context: CanvasRenderingContext2D, w: number, h: number, cx: number, cy: number, radius: number, inner: string, outer: string): void {
  const r = radius * Math.max(w, h);
  const gradient = context.createRadialGradient(w * cx, h * cy, 0, w * cx, h * cy, r);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
}

/**
 * Film grain: `amount` of black and white specks over the whole frame.
 *
 * Drawn as 1-pixel rectangles rather than through getImageData, because the
 * canvas may be 4K and a round trip of twenty-four million pixels to JavaScript
 * and back is far slower than the specks are.
 */
function grain(context: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number, size = 1): void {
  const random = seeded(seed);
  const count = Math.round((w * h * amount) / 1000);
  for (let index = 0; index < count; index += 1) {
    const light = random() > 0.5;
    context.fillStyle = light ? `rgb(255 255 255 / ${0.04 + random() * 0.1})` : `rgb(0 0 0 / ${0.04 + random() * 0.1})`;
    context.fillRect(random() * w, random() * h, size, size);
  }
}

/** A band of hills along `base` (a fraction of the height), `rise` tall at most. */
function hills(context: CanvasRenderingContext2D, w: number, h: number, base: number, rise: number, peaks: number, seed: number, fill: string): void {
  const random = seeded(seed);
  context.fillStyle = fill;
  context.beginPath();
  context.moveTo(0, h);
  context.lineTo(0, h * base);
  const step = w / peaks;
  for (let index = 0; index <= peaks; index += 1) {
    const x = index * step;
    const y = h * base - random() * h * rise;
    context.quadraticCurveTo(x - step / 2, y, x, h * base - random() * h * rise * 0.5);
  }
  context.lineTo(w, h);
  context.closePath();
  context.fill();
}

/** `count` discs of `fill`, sizes and places from `seed`: bokeh, confetti, stars. */
function specks(context: CanvasRenderingContext2D, w: number, h: number, count: number, seed: number, fill: (alpha: number) => string, from: number, to: number): void {
  const random = seeded(seed);
  for (let index = 0; index < count; index += 1) {
    const radius = (from + random() * (to - from)) * Math.min(w, h);
    context.fillStyle = fill(0.08 + random() * 0.35);
    context.beginPath();
    context.arc(random() * w, random() * h, radius, 0, Math.PI * 2);
    context.fill();
  }
}

/** A tile `cell` px wide repeated over the frame, each one painted by `paint`. */
function tiled(w: number, h: number, cell: number, paint: (x: number, y: number, row: number, column: number) => void): void {
  const columns = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) paint(column * cell, row * cell, row, column);
  }
}

/* The set -------------------------------------------------------------------------- */

const gradient = (id: string, label: MessageKey, angle: number, stops: readonly string[], bloom?: readonly [number, number, string]): Background => ({
  id,
  group: 'gradients',
  label,
  draw: (context, w, h) => {
    sweep(context, w, h, angle, stops);
    if (bloom) glow(context, w, h, bloom[0], bloom[1], 0.7, bloom[2], 'rgb(255 255 255 / 0)');
    // A whisper of grain over every gradient: a perfectly smooth ramp bands on
    // an 8-bit screen, and the noise breaks the bands up.
    grain(context, w, h, 0.5, 7);
  },
});

export const BACKGROUNDS: readonly Background[] = [
  /* Gradients ------------------------------------------------------------- */
  gradient('sunrise', 'background.sunrise', Math.PI / 2, ['#fb7185', '#fbbf24', '#fef3c7'], [0.5, 0.86, 'rgb(255 237 213 / 0.5)']),
  gradient('ocean', 'background.ocean', Math.PI / 2, ['#0e7490', '#0284c7', '#67e8f9']),
  gradient('mint', 'background.mint', Math.PI / 3, ['#a7f3d0', '#34d399', '#0f766e']),
  gradient('grape', 'background.grape', -Math.PI / 4, ['#4c1d95', '#7c3aed', '#f0abfc'], [0.22, 0.2, 'rgb(240 171 252 / 0.45)']),
  gradient('ember', 'background.ember', Math.PI / 2, ['#450a0a', '#b91c1c', '#f59e0b'], [0.5, 1, 'rgb(249 115 22 / 0.5)']),
  gradient('midnight', 'background.midnight', Math.PI / 2, ['#020617', '#1e293b', '#334155']),

  /* Textures -------------------------------------------------------------- */
  {
    id: 'paper',
    group: 'textures',
    label: 'background.paper',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#fdf6e3', '#efe4cb']);
      // Fibres: short pale strokes every which way, which is what tells paper from card.
      const random = seeded(3);
      context.lineWidth = Math.max(1, Math.min(w, h) / 900);
      for (let index = 0; index < Math.round((w * h) / 9000); index += 1) {
        const x = random() * w;
        const y = random() * h;
        const angle = random() * Math.PI;
        const length = (0.004 + random() * 0.01) * Math.min(w, h);
        context.strokeStyle = random() > 0.5 ? 'rgb(255 255 255 / 0.5)' : 'rgb(120 100 70 / 0.12)';
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
        context.stroke();
      }
      glow(context, w, h, 0.5, 0.5, 0.9, 'rgb(255 255 255 / 0)', 'rgb(120 100 70 / 0.18)');
    },
  },
  {
    id: 'filmGrain',
    group: 'textures',
    label: 'background.filmGrain',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#1c1917', '#44403c']);
      grain(context, w, h, 24, 13, Math.max(1, Math.round(Math.min(w, h) / 540)));
      glow(context, w, h, 0.5, 0.5, 0.8, 'rgb(255 255 255 / 0.06)', 'rgb(0 0 0 / 0.5)');
    },
  },
  {
    id: 'concrete',
    group: 'textures',
    label: 'background.concrete',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 3, ['#9ca3af', '#6b7280']);
      // Blotches, then grain: the mottle is what reads as a wall.
      specks(context, w, h, 120, 17, (alpha) => `rgb(255 255 255 / ${alpha * 0.3})`, 0.03, 0.14);
      specks(context, w, h, 120, 23, (alpha) => `rgb(0 0 0 / ${alpha * 0.25})`, 0.03, 0.14);
      grain(context, w, h, 10, 29);
    },
  },
  {
    id: 'linen',
    group: 'textures',
    label: 'background.linen',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#e7e5e4', '#d6d3d1']);
      // A weave: threads one way, then the other, both faint.
      const thread = Math.max(2, Math.min(w, h) / 220);
      context.lineWidth = thread / 2;
      for (let x = 0; x < w; x += thread) {
        context.strokeStyle = `rgb(255 255 255 / ${x % (thread * 2) === 0 ? 0.5 : 0.15})`;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, h);
        context.stroke();
      }
      for (let y = 0; y < h; y += thread) {
        context.strokeStyle = `rgb(0 0 0 / ${y % (thread * 2) === 0 ? 0.06 : 0.02})`;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(w, y);
        context.stroke();
      }
    },
  },
  {
    id: 'bokeh',
    group: 'textures',
    label: 'background.bokeh',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#172554', '#1e40af']);
      specks(context, w, h, 60, 31, (alpha) => `rgb(191 219 254 / ${alpha})`, 0.03, 0.13);
      specks(context, w, h, 18, 37, (alpha) => `rgb(255 255 255 / ${alpha})`, 0.1, 0.22);
      glow(context, w, h, 0.3, 0.3, 0.8, 'rgb(96 165 250 / 0.35)', 'rgb(96 165 250 / 0)');
    },
  },
  {
    id: 'marble',
    group: 'textures',
    label: 'background.marble',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#f8fafc', '#e2e8f0']);
      // Veins: a few wandering lines, each with a finer one beside it.
      const random = seeded(41);
      for (let vein = 0; vein < 7; vein += 1) {
        let x = random() * w;
        let y = -h * 0.1;
        context.beginPath();
        context.moveTo(x, y);
        while (y < h) {
          x += (random() - 0.5) * w * 0.12;
          y += h * 0.08;
          context.lineTo(x, y);
        }
        context.strokeStyle = `rgb(100 116 139 / ${0.1 + random() * 0.18})`;
        context.lineWidth = Math.max(1, (Math.min(w, h) / 300) * (0.5 + random()));
        context.stroke();
      }
      grain(context, w, h, 3, 43);
    },
  },

  /* Patterns -------------------------------------------------------------- */
  {
    id: 'dots',
    group: 'patterns',
    label: 'background.dots',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#0f172a', '#1e293b']);
      const cell = Math.min(w, h) / 14;
      context.fillStyle = 'rgb(103 232 249 / 0.5)';
      // Every other row offset by half a cell, so the dots sit in a honeycomb.
      tiled(w, h, cell, (x, y, row) => {
        context.beginPath();
        context.arc(x + (row % 2 === 0 ? 0 : cell / 2), y, cell * 0.12, 0, Math.PI * 2);
        context.fill();
      });
    },
  },
  {
    id: 'stripes',
    group: 'patterns',
    label: 'background.stripes',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#fef3c7', '#fde68a']);
      const band = Math.min(w, h) / 9;
      context.save();
      context.translate(w / 2, h / 2);
      context.rotate(-Math.PI / 6);
      context.fillStyle = 'rgb(251 146 60 / 0.5)';
      const reach = Math.hypot(w, h);
      for (let x = -reach; x < reach; x += band * 2) context.fillRect(x, -reach, band, reach * 2);
      context.restore();
    },
  },
  {
    id: 'grid',
    group: 'patterns',
    label: 'background.grid',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#020617', '#0f172a']);
      const cell = Math.min(w, h) / 12;
      context.strokeStyle = 'rgb(56 189 248 / 0.35)';
      context.lineWidth = Math.max(1, Math.min(w, h) / 600);
      for (let x = 0; x <= w; x += cell) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, h);
        context.stroke();
      }
      for (let y = 0; y <= h; y += cell) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(w, y);
        context.stroke();
      }
      glow(context, w, h, 0.5, 0.5, 0.75, 'rgb(56 189 248 / 0.2)', 'rgb(56 189 248 / 0)');
    },
  },
  {
    id: 'chevron',
    group: 'patterns',
    label: 'background.chevron',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#1e1b4b', '#312e81']);
      const cell = Math.min(w, h) / 8;
      context.strokeStyle = 'rgb(165 180 252 / 0.45)';
      context.lineWidth = cell * 0.14;
      tiled(w, h, cell, (x, y) => {
        context.beginPath();
        context.moveTo(x, y + cell * 0.6);
        context.lineTo(x + cell / 2, y + cell * 0.25);
        context.lineTo(x + cell, y + cell * 0.6);
        context.stroke();
      });
    },
  },
  {
    id: 'confetti',
    group: 'patterns',
    label: 'background.confetti',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#fdf2f8', '#fce7f3']);
      const random = seeded(53);
      const colours = ['#f472b6', '#38bdf8', '#fbbf24', '#4ade80', '#a78bfa'];
      const piece = Math.min(w, h) / 46;
      for (let index = 0; index < 160; index += 1) {
        context.save();
        context.translate(random() * w, random() * h);
        context.rotate(random() * Math.PI);
        context.fillStyle = colours[index % colours.length];
        context.fillRect(-piece / 2, -piece / 6, piece, piece / 3);
        context.restore();
      }
    },
  },
  {
    id: 'ripple',
    group: 'patterns',
    label: 'background.ripple',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#042f2e', '#0f766e']);
      // Rings out from one corner, so the frame never looks like a target.
      context.strokeStyle = 'rgb(153 246 228 / 0.3)';
      context.lineWidth = Math.max(1, Math.min(w, h) / 400);
      const step = Math.min(w, h) / 11;
      for (let radius = step; radius < Math.hypot(w, h) * 1.1; radius += step) {
        context.beginPath();
        context.arc(w * 0.12, h * 0.88, radius, 0, Math.PI * 2);
        context.stroke();
      }
    },
  },

  /* Scenes ---------------------------------------------------------------- */
  {
    id: 'beach',
    group: 'scenes',
    label: 'background.beach',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#38bdf8', '#bae6fd', '#fef3c7']);
      glow(context, w, h, 0.74, 0.22, 0.4, 'rgb(255 247 200 / 0.9)', 'rgb(255 247 200 / 0)');
      // Sea, then the foam at its edge, then the sand.
      context.fillStyle = '#0284c7';
      context.fillRect(0, h * 0.52, w, h * 0.2);
      context.fillStyle = 'rgb(255 255 255 / 0.6)';
      context.fillRect(0, h * 0.7, w, h * 0.025);
      sweepBand(context, w, h, 0.72, 1, ['#fde68a', '#d6b36a']);
      grain(context, w, h, 2, 59);
    },
  },
  {
    id: 'mountains',
    group: 'scenes',
    label: 'background.mountains',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#1e3a8a', '#7c3aed', '#fb7185']);
      glow(context, w, h, 0.5, 0.42, 0.3, 'rgb(254 240 138 / 0.85)', 'rgb(254 240 138 / 0)');
      // Three ridges, each darker and lower: the depth comes from the stacking.
      hills(context, w, h, 0.68, 0.22, 7, 61, 'rgb(76 29 149 / 0.85)');
      hills(context, w, h, 0.8, 0.16, 5, 67, 'rgb(49 10 101 / 0.9)');
      hills(context, w, h, 0.92, 0.1, 4, 71, '#1e1b4b');
    },
  },
  {
    id: 'cityNight',
    group: 'scenes',
    label: 'background.cityNight',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#020617', '#1e1b4b', '#6d28d9']);
      specks(context, w, h, 90, 73, (alpha) => `rgb(255 255 255 / ${alpha * 0.7})`, 0.001, 0.004);
      // A skyline of towers, and a lit window here and there in each.
      const random = seeded(79);
      let x = 0;
      while (x < w) {
        const width = Math.min(w, h) * (0.05 + random() * 0.07);
        const top = h * (0.4 + random() * 0.35);
        context.fillStyle = '#0b1120';
        context.fillRect(x, top, width, h - top);
        for (let y = top + h * 0.03; y < h - h * 0.02; y += h * 0.045) {
          for (let wx = x + width * 0.15; wx < x + width * 0.85; wx += width * 0.3) {
            if (random() > 0.45) {
              context.fillStyle = random() > 0.6 ? 'rgb(253 224 71 / 0.9)' : 'rgb(147 197 253 / 0.75)';
              context.fillRect(wx, y, width * 0.16, h * 0.016);
            }
          }
        }
        x += width * 1.08;
      }
    },
  },
  {
    id: 'forest',
    group: 'scenes',
    label: 'background.forest',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#bbf7d0', '#15803d', '#052e16']);
      glow(context, w, h, 0.3, 0.1, 0.5, 'rgb(254 249 195 / 0.55)', 'rgb(254 249 195 / 0)');
      // Trunks in two ranks, the nearer ones darker and wider.
      const random = seeded(83);
      for (const rank of [{ alpha: 0.3, width: 0.012, count: 16 }, { alpha: 0.7, width: 0.03, count: 8 }]) {
        for (let index = 0; index < rank.count; index += 1) {
          const trunk = w * rank.width * (0.6 + random());
          context.fillStyle = `rgb(5 46 22 / ${rank.alpha})`;
          context.fillRect(random() * w, h * (0.1 + random() * 0.2), trunk, h);
        }
      }
    },
  },
  {
    id: 'desert',
    group: 'scenes',
    label: 'background.desert',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#fb923c', '#fdba74', '#fef3c7']);
      glow(context, w, h, 0.5, 0.3, 0.26, 'rgb(255 237 160 / 0.95)', 'rgb(255 237 160 / 0)');
      // Dunes: broad, low, overlapping curves.
      hills(context, w, h, 0.72, 0.1, 3, 89, 'rgb(217 119 6 / 0.55)');
      hills(context, w, h, 0.84, 0.08, 3, 97, 'rgb(180 83 9 / 0.65)');
      hills(context, w, h, 0.95, 0.06, 2, 101, '#92400e');
      grain(context, w, h, 2, 103);
    },
  },
  {
    id: 'space',
    group: 'scenes',
    label: 'background.space',
    draw: (context, w, h) => {
      sweep(context, w, h, Math.PI / 2, ['#020617', '#0b1120']);
      // A nebula behind, stars in three sizes in front.
      glow(context, w, h, 0.68, 0.34, 0.5, 'rgb(124 58 237 / 0.5)', 'rgb(124 58 237 / 0)');
      glow(context, w, h, 0.3, 0.66, 0.4, 'rgb(14 165 233 / 0.35)', 'rgb(14 165 233 / 0)');
      specks(context, w, h, 320, 107, (alpha) => `rgb(255 255 255 / ${alpha})`, 0.0008, 0.002);
      specks(context, w, h, 40, 109, (alpha) => `rgb(255 255 255 / ${alpha})`, 0.002, 0.005);
      specks(context, w, h, 8, 113, () => 'rgb(255 255 255 / 0.9)', 0.004, 0.008);
    },
  },
];

/** A gradient filling the band from `from` to `to` of the height. */
function sweepBand(context: CanvasRenderingContext2D, w: number, h: number, from: number, to: number, stops: readonly string[]): void {
  const gradient = context.createLinearGradient(0, h * from, 0, h * to);
  stops.forEach((colour, index) => gradient.addColorStop(stops.length === 1 ? 0 : index / (stops.length - 1), colour));
  context.fillStyle = gradient;
  context.fillRect(0, h * from, w, h * (to - from));
}

/** The groups, in the order the panel shows them. */
export const BACKGROUND_GROUPS: readonly BackgroundGroup[] = ['gradients', 'scenes', 'patterns', 'textures'];

export const backgroundById = (id: string): Background | undefined => BACKGROUNDS.find((background) => background.id === id);
