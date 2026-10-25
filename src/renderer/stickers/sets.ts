import type { Sticker } from './catalog';
import {
  bubblePath,
  circle,
  cloudPath,
  drop,
  ellipse,
  fillPath,
  finish,
  heartAt,
  inked,
  lettering,
  line,
  polygon,
  roundRect,
  starPath,
  strokePath,
  turned,
  vertical,
} from './draw';

/**
 * The stickers added beside the first eighteen: reactions, social, party,
 * nature, pointers and more words - the groups CapCut's sticker panel opens
 * on. Drawn in the house hand (stickers/draw), every one in a square of
 * `s` px, its coordinates fractions of it.
 */

type Context = CanvasRenderingContext2D;

const INK = '#3f2a14';
const MOUTH = '#7c2d12';

/* Faces ---------------------------------------------------------------------------- */

const yellow = (c: Context, s: number): CanvasGradient => vertical(c, s, '#fde047', '#f59e0b');
const face = (c: Context, s: number, fill: string | CanvasGradient = yellow(c, s)): void => finish(c, s, circle(s / 2, s / 2, s * 0.4), fill);

/** An arc as its own path: a brow, a closed eye, a smile. */
function arc(cx: number, cy: number, r: number, from: number, to: number): Path2D {
  const path = new Path2D();
  path.arc(cx, cy, r, from, to);
  return path;
}

/** Two eyes squeezed shut with joy: arches. */
const happyEyes = (c: Context, s: number): void => {
  strokePath(c, arc(s * 0.36, s * 0.45, s * 0.07, Math.PI * 1.1, Math.PI * 1.9), INK, s * 0.045);
  strokePath(c, arc(s * 0.64, s * 0.45, s * 0.07, Math.PI * 1.1, Math.PI * 1.9), INK, s * 0.045);
};

const dotEyes = (c: Context, s: number, y = 0.44, r = 0.048): void => {
  fillPath(c, circle(s * 0.37, s * y, s * r), INK);
  fillPath(c, circle(s * 0.63, s * y, s * r), INK);
};

/** A mouth wide open: a D on its back. */
function openMouth(s: number, top: number, bottom: number, half: number): Path2D {
  const path = new Path2D();
  path.moveTo(s * (0.5 - half), s * top);
  path.quadraticCurveTo(s * 0.5, s * (top + 0.04), s * (0.5 + half), s * top);
  path.quadraticCurveTo(s * (0.5 + half * 0.9), s * bottom, s * 0.5, s * bottom);
  path.quadraticCurveTo(s * (0.5 - half * 0.9), s * bottom, s * (0.5 - half), s * top);
  path.closePath();
  return path;
}

const tear = (c: Context, s: number, x: number, y: number, r = 0.06): void => finish(c, s, drop(s * x, s * y, s * r), vertical(c, s, '#7dd3fc', '#0284c7'), true, 0.04);

/* Shapes used by several ---------------------------------------------------------------- */

/** An irregular comic burst: spikes of two lengths, turning. */
function burstPath(cx: number, cy: number, outer: number, inner: number, points: number): Path2D {
  const path = new Path2D();
  for (let i = 0; i < points * 2; i += 1) {
    const long = i % 2 === 0;
    const wobble = long ? (i % 4 === 0 ? 1 : 0.86) : 1;
    const r = (long ? outer : inner) * wobble;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

/** A pill-shaped button with its words. */
function pill(c: Context, s: number, text: string, top: string, bottom: string, ink = '#ffffff', height = 0.13): void {
  finish(c, s, roundRect(s * 0.04, s * 0.34, s * 0.92, s * 0.32, s * 0.16), vertical(c, s, top, bottom));
  lettering(c, s, text, s * 0.5, s * 0.505, s * 0.8, ink, s * height);
}

/** Bits of confetti: oblongs and dots, each turned its own way. */
function confettiBits(c: Context, s: number, bits: ReadonlyArray<readonly [number, number, number, string, 'bar' | 'dot']>): void {
  for (const [x, y, angle, colour, kind] of bits) {
    c.save();
    c.translate(s * x, s * y);
    c.rotate(angle);
    const shape = kind === 'dot' ? circle(0, 0, s * 0.035) : roundRect(-s * 0.05, -s * 0.022, s * 0.1, s * 0.044, s * 0.01);
    finish(c, s, shape, colour, true, 0.035);
    c.restore();
  }
}

/* The sets ---------------------------------------------------------------------------------- */

export const REACTIONS: readonly Sticker[] = [
  {
    id: 'laugh',
    category: 'reactions',
    label: 'sticker.laugh',
    loop: 'pulse',
    draw: (c, s) => {
      face(c, s);
      happyEyes(c, s);
      const mouth = openMouth(s, 0.56, 0.82, 0.22);
      fillPath(c, mouth, MOUTH);
      c.save();
      c.clip(mouth);
      fillPath(c, roundRect(s * 0.26, s * 0.55, s * 0.48, s * 0.06, s * 0.01), '#ffffff');
      fillPath(c, ellipse(s * 0.5, s * 0.81, s * 0.12, s * 0.07), '#f87171');
      c.restore();
      tear(c, s, 0.16, 0.5);
      tear(c, s, 0.84, 0.5);
    },
  },
  {
    id: 'love',
    category: 'reactions',
    label: 'sticker.love',
    loop: 'pulse',
    draw: (c, s) => {
      face(c, s);
      fillPath(c, heartAt(s * 0.36, s * 0.43, s * 0.17), vertical(c, s, '#fb7185', '#e11d48'));
      fillPath(c, heartAt(s * 0.64, s * 0.43, s * 0.17), vertical(c, s, '#fb7185', '#e11d48'));
      fillPath(c, openMouth(s, 0.6, 0.76, 0.16), MOUTH);
    },
  },
  {
    id: 'cool',
    category: 'reactions',
    label: 'sticker.cool',
    loop: 'sway',
    draw: (c, s) => {
      face(c, s);
      const glasses = new Path2D();
      glasses.addPath(polygon([[s * 0.16, s * 0.37], [s * 0.47, s * 0.37], [s * 0.44, s * 0.5], [s * 0.38, s * 0.55], [s * 0.25, s * 0.55], [s * 0.18, s * 0.48]]));
      glasses.addPath(polygon([[s * 0.53, s * 0.37], [s * 0.84, s * 0.37], [s * 0.82, s * 0.48], [s * 0.75, s * 0.55], [s * 0.62, s * 0.55], [s * 0.56, s * 0.5]]));
      glasses.addPath(roundRect(s * 0.45, s * 0.37, s * 0.1, s * 0.04, s * 0.01));
      fillPath(c, glasses, '#111827');
      strokePath(c, polygon([[s * 0.22, s * 0.41], [s * 0.3, s * 0.41]]), 'rgba(255, 255, 255, 0.55)', s * 0.025);
      strokePath(c, polygon([[s * 0.59, s * 0.41], [s * 0.67, s * 0.41]]), 'rgba(255, 255, 255, 0.55)', s * 0.025);
      const smirk = new Path2D();
      smirk.moveTo(s * 0.36, s * 0.68);
      smirk.quadraticCurveTo(s * 0.52, s * 0.75, s * 0.65, s * 0.63);
      strokePath(c, smirk, INK, s * 0.045);
    },
  },
  {
    id: 'surprised',
    category: 'reactions',
    label: 'sticker.surprised',
    loop: 'pulse',
    draw: (c, s) => {
      face(c, s);
      strokePath(c, arc(s * 0.36, s * 0.36, s * 0.08, Math.PI * 1.2, Math.PI * 1.8), INK, s * 0.035);
      strokePath(c, arc(s * 0.64, s * 0.36, s * 0.08, Math.PI * 1.2, Math.PI * 1.8), INK, s * 0.035);
      fillPath(c, ellipse(s * 0.37, s * 0.46, s * 0.045, s * 0.065), INK);
      fillPath(c, ellipse(s * 0.63, s * 0.46, s * 0.045, s * 0.065), INK);
      fillPath(c, ellipse(s * 0.5, s * 0.69, s * 0.075, s * 0.095), MOUTH);
    },
  },
  {
    id: 'wink',
    category: 'reactions',
    label: 'sticker.wink',
    loop: 'sway',
    draw: (c, s) => {
      face(c, s);
      fillPath(c, circle(s * 0.37, s * 0.43, s * 0.05), INK);
      strokePath(c, arc(s * 0.63, s * 0.46, s * 0.07, Math.PI * 1.15, Math.PI * 1.85), INK, s * 0.045);
      strokePath(c, arc(s * 0.5, s * 0.53, s * 0.2, Math.PI * 0.18, Math.PI * 0.82), INK, s * 0.05);
    },
  },
  {
    id: 'sad',
    category: 'reactions',
    label: 'sticker.sad',
    loop: 'float',
    draw: (c, s) => {
      face(c, s, vertical(c, s, '#fde68a', '#f59e0b'));
      strokePath(c, polygon([[s * 0.26, s * 0.36], [s * 0.42, s * 0.31]]), INK, s * 0.035);
      strokePath(c, polygon([[s * 0.74, s * 0.36], [s * 0.58, s * 0.31]]), INK, s * 0.035);
      dotEyes(c, s, 0.46, 0.045);
      strokePath(c, arc(s * 0.5, s * 0.8, s * 0.17, Math.PI * 1.22, Math.PI * 1.78), INK, s * 0.045);
      tear(c, s, 0.66, 0.6, 0.05);
    },
  },
  {
    id: 'angry',
    category: 'reactions',
    label: 'sticker.angry',
    loop: 'pulse',
    draw: (c, s) => {
      face(c, s, vertical(c, s, '#fb923c', '#dc2626'));
      strokePath(c, polygon([[s * 0.25, s * 0.33], [s * 0.44, s * 0.41]]), '#450a0a', s * 0.05);
      strokePath(c, polygon([[s * 0.75, s * 0.33], [s * 0.56, s * 0.41]]), '#450a0a', s * 0.05);
      fillPath(c, circle(s * 0.37, s * 0.48, s * 0.045), '#450a0a');
      fillPath(c, circle(s * 0.63, s * 0.48, s * 0.045), '#450a0a');
      strokePath(c, arc(s * 0.5, s * 0.82, s * 0.16, Math.PI * 1.25, Math.PI * 1.75), '#450a0a', s * 0.05);
    },
  },
  {
    id: 'partyFace',
    category: 'reactions',
    label: 'sticker.partyFace',
    loop: 'sway',
    draw: (c, s) => {
      // The face a little smaller and lower, to make room for the hat on it.
      c.save();
      c.translate(s * 0.07, s * 0.15);
      c.scale(0.86, 0.86);
      face(c, s);
      happyEyes(c, s);
      // The party horn, blown.
      const horn = polygon([[s * 0.52, s * 0.63], [s * 0.8, s * 0.56], [s * 0.82, s * 0.7], [s * 0.52, s * 0.67]]);
      finish(c, s, horn, vertical(c, s, '#38bdf8', '#0284c7'), true, 0.04);
      strokePath(c, arc(s * 0.88, s * 0.63, s * 0.05, -Math.PI * 0.6, Math.PI * 0.9), '#0284c7', s * 0.03);
      c.restore();
      // The hat, tipped on the top of the head, striped across.
      const hat = polygon([[s * 0.3, s * 0.04], [s * 0.6, s * 0.25], [s * 0.26, s * 0.36]]);
      finish(c, s, hat, vertical(c, s, '#c084fc', '#7c3aed'), true, 0.05);
      c.save();
      c.clip(hat);
      strokePath(c, scaled('M0.63 0.03 L0.09 0.29 M0.67 0.11 L0.13 0.37', s), '#fde047', s * 0.04);
      c.restore();
      finish(c, s, circle(s * 0.3, s * 0.05, s * 0.045), '#fde047', true, 0.03);
      confettiBits(c, s, [[0.16, 0.28, 0.6, '#f43f5e', 'bar'], [0.84, 0.3, -0.5, '#22c55e', 'bar'], [0.12, 0.7, 0, '#38bdf8', 'dot']]);
    },
  },
];

export const SOCIAL: readonly Sticker[] = [
  {
    id: 'thumbsUp',
    category: 'social',
    label: 'sticker.thumbsUp',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, roundRect(s * 0.12, s * 0.46, s * 0.16, s * 0.4, s * 0.04), vertical(c, s, '#60a5fa', '#2563eb'));
      const hand = new Path2D();
      hand.moveTo(s * 0.3, s * 0.86);
      hand.lineTo(s * 0.3, s * 0.5);
      hand.lineTo(s * 0.42, s * 0.44);
      hand.lineTo(s * 0.48, s * 0.22);
      hand.quadraticCurveTo(s * 0.5, s * 0.13, s * 0.57, s * 0.15);
      hand.quadraticCurveTo(s * 0.64, s * 0.18, s * 0.62, s * 0.28);
      hand.lineTo(s * 0.59, s * 0.42);
      hand.lineTo(s * 0.76, s * 0.42);
      hand.quadraticCurveTo(s * 0.84, s * 0.43, s * 0.83, s * 0.5);
      hand.lineTo(s * 0.81, s * 0.8);
      hand.quadraticCurveTo(s * 0.8, s * 0.86, s * 0.73, s * 0.86);
      hand.closePath();
      finish(c, s, hand, yellow(c, s));
      for (const y of [0.52, 0.62, 0.72]) strokePath(c, polygon([[s * 0.62, s * y], [s * 0.82, s * y]]), '#b45309', s * 0.022);
    },
  },
  {
    id: 'bell',
    category: 'social',
    label: 'sticker.bell',
    loop: 'sway',
    draw: (c, s) => {
      const bell = new Path2D();
      bell.moveTo(s * 0.5, s * 0.16);
      bell.bezierCurveTo(s * 0.3, s * 0.16, s * 0.26, s * 0.34, s * 0.26, s * 0.47);
      bell.lineTo(s * 0.24, s * 0.64);
      bell.quadraticCurveTo(s * 0.21, s * 0.7, s * 0.15, s * 0.75);
      bell.lineTo(s * 0.85, s * 0.75);
      bell.quadraticCurveTo(s * 0.79, s * 0.7, s * 0.76, s * 0.64);
      bell.lineTo(s * 0.74, s * 0.47);
      bell.bezierCurveTo(s * 0.74, s * 0.34, s * 0.7, s * 0.16, s * 0.5, s * 0.16);
      bell.closePath();
      bell.addPath(circle(s * 0.5, s * 0.82, s * 0.075));
      bell.addPath(circle(s * 0.5, s * 0.14, s * 0.05));
      finish(c, s, bell, vertical(c, s, '#fde68a', '#d97706'));
      finish(c, s, circle(s * 0.77, s * 0.27, s * 0.11), vertical(c, s, '#f87171', '#dc2626'), true, 0.04);
      lettering(c, s, '1', s * 0.77, s * 0.28, s * 0.12, '#ffffff', s * 0.14);
    },
  },
  {
    id: 'share',
    category: 'social',
    label: 'sticker.share',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, circle(s / 2, s / 2, s * 0.4), vertical(c, s, '#34d399', '#059669'));
      const links = new Path2D();
      links.moveTo(s * 0.35, s * 0.5);
      links.lineTo(s * 0.65, s * 0.32);
      links.moveTo(s * 0.35, s * 0.5);
      links.lineTo(s * 0.65, s * 0.68);
      strokePath(c, links, '#ffffff', s * 0.05);
      for (const [x, y] of [[0.35, 0.5], [0.65, 0.32], [0.65, 0.68]] as const) fillPath(c, circle(s * x, s * y, s * 0.085), '#ffffff');
    },
  },
  {
    id: 'comment',
    category: 'social',
    label: 'sticker.comment',
    loop: 'float',
    draw: (c, s) => {
      finish(c, s, bubblePath(s * 0.1, s * 0.16, s * 0.8, s * 0.56, s * 0.16, { from: s * 0.28, to: s * 0.46, tipX: s * 0.2, tipY: s * 0.9 }), vertical(c, s, '#60a5fa', '#2563eb'));
      for (const x of [0.33, 0.5, 0.67]) fillPath(c, circle(s * x, s * 0.44, s * 0.055), '#ffffff');
    },
  },
  {
    id: 'follow',
    category: 'social',
    label: 'sticker.follow',
    loop: 'pulse',
    draw: (c, s) => {
      const disc = circle(s / 2, s / 2, s * 0.4);
      finish(c, s, disc, vertical(c, s, '#a78bfa', '#7c3aed'));
      c.save();
      c.clip(disc);
      fillPath(c, circle(s * 0.44, s * 0.38, s * 0.11), '#ffffff');
      const body = new Path2D();
      body.moveTo(s * 0.22, s * 0.78);
      body.quadraticCurveTo(s * 0.22, s * 0.53, s * 0.44, s * 0.53);
      body.quadraticCurveTo(s * 0.66, s * 0.53, s * 0.66, s * 0.78);
      body.closePath();
      fillPath(c, body, '#ffffff');
      c.restore();
      finish(c, s, circle(s * 0.72, s * 0.68, s * 0.12), vertical(c, s, '#4ade80', '#16a34a'), true, 0.04);
      const plus = new Path2D();
      plus.moveTo(s * 0.72, s * 0.62);
      plus.lineTo(s * 0.72, s * 0.74);
      plus.moveTo(s * 0.66, s * 0.68);
      plus.lineTo(s * 0.78, s * 0.68);
      strokePath(c, plus, '#ffffff', s * 0.035);
    },
  },
  {
    id: 'live',
    category: 'social',
    label: 'sticker.live',
    loop: 'pulse',
    draw: (c, s, words) => {
      finish(c, s, roundRect(s * 0.06, s * 0.34, s * 0.88, s * 0.32, s * 0.08), vertical(c, s, '#f87171', '#dc2626'));
      fillPath(c, circle(s * 0.19, s * 0.5, s * 0.045), '#ffffff');
      lettering(c, s, words('sticker.liveText'), s * 0.57, s * 0.505, s * 0.62, '#ffffff', s * 0.16);
    },
  },
  {
    id: 'play',
    category: 'social',
    label: 'sticker.play',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, circle(s / 2, s / 2, s * 0.4), vertical(c, s, '#f472b6', '#db2777'));
      const triangle = polygon([[s * 0.42, s * 0.33], [s * 0.69, s * 0.5], [s * 0.42, s * 0.67]]);
      fillPath(c, triangle, '#ffffff');
      strokePath(c, triangle, '#ffffff', s * 0.04);
    },
  },
  {
    id: 'verified',
    category: 'social',
    label: 'sticker.verified',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, starPath(s / 2, s / 2, s * 0.42, s * 0.35, 12), vertical(c, s, '#38bdf8', '#0284c7'));
      strokePath(c, tick(s), '#ffffff', s * 0.08);
    },
  },
  {
    id: 'hashtag',
    category: 'social',
    label: 'sticker.hashtag',
    loop: 'sway',
    draw: (c, s) => {
      finish(c, s, roundRect(s * 0.14, s * 0.14, s * 0.72, s * 0.72, s * 0.18), vertical(c, s, '#fb923c', '#ea580c'));
      lettering(c, s, '#', s * 0.5, s * 0.53, s * 0.5, '#ffffff', s * 0.5);
    },
  },
];

/** A tick, open at its ends: drawn as a stroke, not closed into a triangle. */
function tick(s: number): Path2D {
  const path = new Path2D();
  path.moveTo(s * 0.33, s * 0.51);
  path.lineTo(s * 0.45, s * 0.63);
  path.lineTo(s * 0.68, s * 0.38);
  return path;
}

export const PARTY: readonly Sticker[] = [
  {
    id: 'confetti',
    category: 'party',
    label: 'sticker.confetti',
    loop: 'float',
    draw: (c, s) => {
      confettiBits(c, s, [
        [0.2, 0.22, 0.5, '#f43f5e', 'bar'], [0.46, 0.16, -0.3, '#facc15', 'bar'], [0.74, 0.22, 0.9, '#22c55e', 'bar'],
        [0.32, 0.4, -0.8, '#38bdf8', 'bar'], [0.6, 0.38, 0.2, '#a855f7', 'bar'], [0.84, 0.46, -0.4, '#f97316', 'bar'],
        [0.16, 0.56, 0.3, '#facc15', 'bar'], [0.44, 0.6, 1.1, '#f43f5e', 'bar'], [0.7, 0.64, -1, '#38bdf8', 'bar'],
        [0.26, 0.8, -0.2, '#22c55e', 'bar'], [0.56, 0.84, 0.6, '#a855f7', 'bar'], [0.84, 0.78, 0.1, '#facc15', 'bar'],
        [0.36, 0.28, 0, '#22c55e', 'dot'], [0.62, 0.52, 0, '#facc15', 'dot'], [0.18, 0.4, 0, '#a855f7', 'dot'], [0.4, 0.74, 0, '#f97316', 'dot'], [0.78, 0.32, 0, '#f43f5e', 'dot'],
      ]);
    },
  },
  {
    id: 'popper',
    category: 'party',
    label: 'sticker.popper',
    loop: 'sway',
    draw: (c, s) => {
      const cone = polygon([[s * 0.14, s * 0.88], [s * 0.3, s * 0.46], [s * 0.56, s * 0.72]]);
      finish(c, s, cone, vertical(c, s, '#c084fc', '#7c3aed'));
      c.save();
      c.clip(cone);
      for (const t of [0.35, 0.6]) fillPath(c, polygon([[s * (0.1 + t * 0.3), s * 0.4], [s * (0.18 + t * 0.3), s * 0.4], [s * (0.0 + t * 0.3), s * 0.95], [s * (-0.08 + t * 0.3), s * 0.95]]), '#fde047');
      c.restore();
      for (const [path, colour] of [
        ['M0.44 0.5 Q0.5 0.3 0.62 0.32 T0.8 0.14', '#f43f5e'],
        ['M0.48 0.56 Q0.66 0.48 0.72 0.56 T0.9 0.5', '#22c55e'],
      ] as const) line(c, s, scaled(path, s), colour, s * 0.03);
      confettiBits(c, s, [[0.56, 0.18, 0.4, '#facc15', 'bar'], [0.78, 0.34, -0.6, '#38bdf8', 'bar'], [0.86, 0.68, 0.3, '#f97316', 'bar'], [0.66, 0.4, 0, '#a855f7', 'dot'], [0.4, 0.3, 0, '#22c55e', 'dot']]);
    },
  },
  {
    id: 'balloon',
    category: 'party',
    label: 'sticker.balloon',
    loop: 'float',
    draw: (c, s) => {
      const string = new Path2D();
      string.moveTo(s * 0.5, s * 0.74);
      string.bezierCurveTo(s * 0.42, s * 0.82, s * 0.58, s * 0.88, s * 0.5, s * 0.97);
      strokePath(c, string, '#e2e8f0', s * 0.018);
      const body = ellipse(s * 0.5, s * 0.4, s * 0.27, s * 0.32);
      body.addPath(polygon([[s * 0.46, s * 0.75], [s * 0.54, s * 0.75], [s * 0.5, s * 0.69]]));
      finish(c, s, body, vertical(c, s, '#fb7185', '#e11d48'));
      fillPath(c, ellipse(s * 0.4, s * 0.27, s * 0.055, s * 0.1, -0.45), 'rgba(255, 255, 255, 0.6)');
    },
  },
  {
    id: 'gift',
    category: 'party',
    label: 'sticker.gift',
    loop: 'pulse',
    draw: (c, s) => {
      const bow = new Path2D();
      bow.addPath(ellipse(s * 0.39, s * 0.27, s * 0.11, s * 0.07, -0.5));
      bow.addPath(ellipse(s * 0.61, s * 0.27, s * 0.11, s * 0.07, 0.5));
      finish(c, s, bow, '#f43f5e');
      finish(c, s, roundRect(s * 0.18, s * 0.44, s * 0.64, s * 0.42, s * 0.03), vertical(c, s, '#60a5fa', '#2563eb'));
      finish(c, s, roundRect(s * 0.13, s * 0.33, s * 0.74, s * 0.14, s * 0.03), vertical(c, s, '#93c5fd', '#3b82f6'), false);
      fillPath(c, roundRect(s * 0.45, s * 0.33, s * 0.1, s * 0.53, s * 0.01), '#f43f5e');
      fillPath(c, circle(s * 0.5, s * 0.31, s * 0.045), '#be123c');
    },
  },
  {
    id: 'trophy',
    category: 'party',
    label: 'sticker.trophy',
    loop: 'float',
    draw: (c, s) => {
      const handles = new Path2D();
      handles.arc(s * 0.28, s * 0.32, s * 0.1, Math.PI * 0.5, Math.PI * 1.5);
      handles.moveTo(s * 0.72, s * 0.22);
      handles.arc(s * 0.72, s * 0.32, s * 0.1, Math.PI * 1.5, Math.PI * 0.5);
      line(c, s, handles, '#f59e0b', s * 0.05);
      const cup = new Path2D();
      cup.moveTo(s * 0.26, s * 0.14);
      cup.lineTo(s * 0.74, s * 0.14);
      cup.lineTo(s * 0.71, s * 0.36);
      cup.quadraticCurveTo(s * 0.67, s * 0.56, s * 0.5, s * 0.58);
      cup.quadraticCurveTo(s * 0.33, s * 0.56, s * 0.29, s * 0.36);
      cup.closePath();
      cup.addPath(roundRect(s * 0.45, s * 0.56, s * 0.1, s * 0.14, s * 0.01));
      cup.addPath(roundRect(s * 0.32, s * 0.69, s * 0.36, s * 0.08, s * 0.02));
      cup.addPath(roundRect(s * 0.25, s * 0.77, s * 0.5, s * 0.09, s * 0.02));
      finish(c, s, cup, vertical(c, s, '#fde68a', '#d97706'));
      fillPath(c, starPath(s * 0.5, s * 0.33, s * 0.09, s * 0.04, 5), 'rgba(255, 255, 255, 0.85)');
    },
  },
  {
    id: 'medal',
    category: 'party',
    label: 'sticker.medal',
    loop: 'sway',
    draw: (c, s) => {
      finish(c, s, polygon([[s * 0.3, s * 0.06], [s * 0.46, s * 0.06], [s * 0.58, s * 0.46], [s * 0.42, s * 0.46]]), vertical(c, s, '#60a5fa', '#2563eb'));
      finish(c, s, polygon([[s * 0.54, s * 0.06], [s * 0.7, s * 0.06], [s * 0.58, s * 0.46], [s * 0.42, s * 0.46]]), vertical(c, s, '#f87171', '#dc2626'));
      finish(c, s, circle(s * 0.5, s * 0.64, s * 0.24), vertical(c, s, '#fde68a', '#d97706'));
      strokePath(c, circle(s * 0.5, s * 0.64, s * 0.17), 'rgba(180, 83, 9, 0.7)', s * 0.02);
      fillPath(c, starPath(s * 0.5, s * 0.645, s * 0.12, s * 0.05, 5), '#fef3c7');
    },
  },
  {
    id: 'burst',
    category: 'party',
    label: 'sticker.burst',
    loop: 'pulse',
    draw: (c, s) => {
      finish(c, s, burstPath(s / 2, s / 2, s * 0.45, s * 0.28, 12), vertical(c, s, '#fde047', '#f97316'));
      fillPath(c, burstPath(s / 2, s / 2, s * 0.27, s * 0.15, 10), vertical(c, s, '#fb923c', '#ef4444'));
      fillPath(c, starPath(s / 2, s / 2, s * 0.1, s * 0.04, 4), '#fff7ed');
    },
  },
];

/** An SVG-style path of fractions ("M0.4 0.5 Q..."), at `s` px. Just M, L, Q, T and C. */
function scaled(d: string, s: number): Path2D {
  return new Path2D(d.replace(/-?\d*\.?\d+/g, (number) => String(Number(number) * s)));
}

export const NATURE: readonly Sticker[] = [
  {
    id: 'sun',
    category: 'nature',
    label: 'sticker.sun',
    loop: 'sway',
    draw: (c, s) => {
      const rays = new Path2D();
      for (let i = 0; i < 8; i += 1) {
        const a = (i * Math.PI) / 4;
        const point = (r: number, turn: number): [number, number] => [s * 0.5 + Math.cos(a + turn) * r, s * 0.5 + Math.sin(a + turn) * r];
        rays.addPath(polygon([point(s * 0.45, 0), point(s * 0.3, 0.2), point(s * 0.3, -0.2)]));
      }
      finish(c, s, rays, vertical(c, s, '#fde047', '#f97316'));
      finish(c, s, circle(s / 2, s / 2, s * 0.25), vertical(c, s, '#fef08a', '#f59e0b'));
    },
  },
  {
    id: 'cloud',
    category: 'nature',
    label: 'sticker.cloud',
    loop: 'float',
    draw: (c, s) => finish(c, s, cloudPath(s * 0.5, s * 0.72, s * 0.86), vertical(c, s, '#ffffff', '#bfdbfe')),
  },
  {
    id: 'rain',
    category: 'nature',
    label: 'sticker.rain',
    loop: 'float',
    draw: (c, s) => {
      for (const [x, y] of [[0.32, 0.74], [0.52, 0.82], [0.72, 0.74]] as const) finish(c, s, drop(s * x, s * y, s * 0.05), vertical(c, s, '#7dd3fc', '#0284c7'), true, 0.04);
      finish(c, s, cloudPath(s * 0.5, s * 0.58, s * 0.82), vertical(c, s, '#e2e8f0', '#94a3b8'));
    },
  },
  {
    id: 'snowflake',
    category: 'nature',
    label: 'sticker.snowflake',
    loop: 'sway',
    draw: (c, s) => {
      const flake = new Path2D();
      for (let k = 0; k < 6; k += 1) {
        const a = (k * Math.PI) / 3 - Math.PI / 2;
        const at = (r: number, turn = 0): [number, number] => [s * 0.5 + Math.cos(a + turn) * r, s * 0.5 + Math.sin(a + turn) * r];
        flake.moveTo(s * 0.5, s * 0.5);
        flake.lineTo(...at(s * 0.4));
        for (const [r, length] of [[0.2, 0.1], [0.3, 0.07]] as const) {
          const [bx, by] = at(s * r);
          for (const side of [-1, 1]) {
            flake.moveTo(bx, by);
            flake.lineTo(bx + Math.cos(a + side * 0.75) * s * length, by + Math.sin(a + side * 0.75) * s * length);
          }
        }
      }
      line(c, s, flake, '#38bdf8', s * 0.045);
    },
  },
  {
    id: 'rainbow',
    category: 'nature',
    label: 'sticker.rainbow',
    loop: 'float',
    draw: (c, s) => {
      const band = new Path2D();
      band.arc(s * 0.5, s * 0.74, s * 0.27, Math.PI, Math.PI * 2);
      line(c, s, band, 'rgba(255, 255, 255, 0)', s * 0.28);
      ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#8b5cf6'].forEach((colour, index) => {
        const arcPath = new Path2D();
        arcPath.arc(s * 0.5, s * 0.74, s * (0.385 - index * 0.046), Math.PI, Math.PI * 2);
        c.save();
        c.strokeStyle = colour;
        c.lineWidth = s * 0.048;
        c.stroke(arcPath);
        c.restore();
      });
      finish(c, s, cloudPath(s * 0.16, s * 0.8, s * 0.3), '#ffffff', true, 0.05);
      finish(c, s, cloudPath(s * 0.84, s * 0.8, s * 0.3), '#ffffff', true, 0.05);
    },
  },
  {
    id: 'flower',
    category: 'nature',
    label: 'sticker.flower',
    loop: 'sway',
    draw: (c, s) => {
      const petals = new Path2D();
      for (let k = 0; k < 5; k += 1) {
        const a = (k * Math.PI * 2) / 5 - Math.PI / 2;
        petals.addPath(ellipse(s * 0.5 + Math.cos(a) * s * 0.2, s * 0.5 + Math.sin(a) * s * 0.2, s * 0.15, s * 0.2, a + Math.PI / 2));
      }
      finish(c, s, petals, vertical(c, s, '#f9a8d4', '#ec4899'));
      finish(c, s, circle(s / 2, s / 2, s * 0.11), vertical(c, s, '#fde047', '#f59e0b'), true, 0.04);
    },
  },
  {
    id: 'leaf',
    category: 'nature',
    label: 'sticker.leaf',
    loop: 'sway',
    draw: (c, s) => {
      const leaf = new Path2D();
      leaf.moveTo(s * 0.2, s * 0.8);
      leaf.bezierCurveTo(s * 0.18, s * 0.4, s * 0.5, s * 0.16, s * 0.86, s * 0.14);
      leaf.bezierCurveTo(s * 0.86, s * 0.5, s * 0.6, s * 0.82, s * 0.2, s * 0.8);
      leaf.closePath();
      line(c, s, scaled('M0.2 0.8 L0.1 0.92', s), '#15803d', s * 0.04);
      finish(c, s, leaf, vertical(c, s, '#86efac', '#16a34a'));
      strokePath(c, scaled('M0.22 0.78 Q0.5 0.5 0.8 0.2', s), '#15803d', s * 0.025);
      strokePath(c, scaled('M0.42 0.56 L0.36 0.4 M0.56 0.42 L0.52 0.28 M0.48 0.5 L0.64 0.54 M0.62 0.36 L0.76 0.38', s), '#15803d', s * 0.018);
    },
  },
  {
    id: 'moon',
    category: 'nature',
    label: 'sticker.moon',
    loop: 'float',
    draw: (c, s) => {
      finish(c, s, scaled('M0.62 0.12 C0.3 0.14 0.14 0.42 0.24 0.66 C0.34 0.88 0.66 0.94 0.86 0.72 C0.62 0.78 0.4 0.62 0.42 0.4 C0.43 0.24 0.52 0.16 0.62 0.12 Z', s), vertical(c, s, '#fef08a', '#eab308'));
      finish(c, s, starPath(s * 0.74, s * 0.3, s * 0.08, s * 0.03, 4), '#fef9c3', true, 0.035);
      finish(c, s, starPath(s * 0.84, s * 0.5, s * 0.05, s * 0.02, 4), '#fef9c3', true, 0.03);
    },
  },
];

export const POINTERS: readonly Sticker[] = [
  {
    id: 'arrowDown',
    category: 'pointers',
    label: 'sticker.arrowDown',
    loop: 'float',
    draw: (c, s) => finish(c, s, polygon([[s * 0.38, s * 0.1], [s * 0.62, s * 0.1], [s * 0.62, s * 0.52], [s * 0.8, s * 0.52], [s * 0.5, s * 0.9], [s * 0.2, s * 0.52], [s * 0.38, s * 0.52]]), vertical(c, s, '#facc15', '#f97316')),
  },
  {
    id: 'arrowLoop',
    category: 'pointers',
    label: 'sticker.arrowLoop',
    loop: 'float',
    draw: (c, s) => {
      line(c, s, scaled('M0.1 0.82 C0.3 0.92 0.54 0.72 0.44 0.54 C0.36 0.4 0.2 0.52 0.3 0.64 C0.42 0.78 0.7 0.58 0.74 0.3', s), '#ec4899', s * 0.06);
      finish(c, s, polygon([[s * 0.76, s * 0.12], [s * 0.64, s * 0.34], [s * 0.88, s * 0.32]]), '#ec4899');
    },
  },
  {
    id: 'pointHand',
    category: 'pointers',
    label: 'sticker.pointHand',
    loop: 'float',
    draw: (c, s) => {
      finish(c, s, roundRect(s * 0.04, s * 0.44, s * 0.14, s * 0.36, s * 0.04), vertical(c, s, '#60a5fa', '#2563eb'));
      const hand = new Path2D();
      hand.moveTo(s * 0.18, s * 0.44);
      hand.lineTo(s * 0.36, s * 0.4);
      hand.quadraticCurveTo(s * 0.42, s * 0.28, s * 0.52, s * 0.31);
      hand.quadraticCurveTo(s * 0.58, s * 0.34, s * 0.54, s * 0.4);
      hand.lineTo(s * 0.86, s * 0.4);
      hand.quadraticCurveTo(s * 0.94, s * 0.45, s * 0.86, s * 0.51);
      hand.lineTo(s * 0.58, s * 0.51);
      hand.quadraticCurveTo(s * 0.63, s * 0.56, s * 0.58, s * 0.62);
      hand.quadraticCurveTo(s * 0.62, s * 0.67, s * 0.57, s * 0.72);
      hand.quadraticCurveTo(s * 0.6, s * 0.78, s * 0.52, s * 0.8);
      hand.lineTo(s * 0.3, s * 0.8);
      hand.quadraticCurveTo(s * 0.18, s * 0.78, s * 0.18, s * 0.64);
      hand.closePath();
      finish(c, s, hand, yellow(c, s));
      strokePath(c, scaled('M0.44 0.62 L0.58 0.62 M0.44 0.72 L0.57 0.72', s), '#b45309', s * 0.022);
    },
  },
  {
    id: 'cursor',
    category: 'pointers',
    label: 'sticker.cursor',
    loop: 'pulse',
    draw: (c, s) => {
      // The click: three short strokes off the tip.
      strokePath(c, scaled('M0.32 0.12 L0.32 0.03 M0.24 0.16 L0.16 0.1 M0.4 0.14 L0.47 0.07', s), '#facc15', s * 0.04);
      inked(c, s, polygon([[s * 0.32, s * 0.2], [s * 0.32, s * 0.78], [s * 0.45, s * 0.66], [s * 0.55, s * 0.88], [s * 0.65, s * 0.84], [s * 0.55, s * 0.62], [s * 0.73, s * 0.62]]), '#ffffff', '#111827', 0.05);
    },
  },
  {
    id: 'underline',
    category: 'pointers',
    label: 'sticker.underline',
    loop: 'pulse',
    draw: (c, s) => line(c, s, scaled('M0.08 0.56 C0.3 0.46 0.5 0.62 0.7 0.5 C0.78 0.46 0.86 0.48 0.92 0.46 M0.14 0.66 Q0.5 0.58 0.86 0.62', s), '#facc15', s * 0.07),
  },
  {
    id: 'bubble',
    category: 'pointers',
    label: 'sticker.bubble',
    loop: 'float',
    draw: (c, s) => inked(c, s, bubblePath(s * 0.08, s * 0.14, s * 0.84, s * 0.58, s * 0.2, { from: s * 0.26, to: s * 0.44, tipX: s * 0.16, tipY: s * 0.9 }), '#ffffff'),
  },
  {
    id: 'thought',
    category: 'pointers',
    label: 'sticker.thought',
    loop: 'float',
    draw: (c, s) => {
      inked(c, s, circle(s * 0.16, s * 0.88, s * 0.035), '#ffffff', '#111827', 0.04);
      inked(c, s, circle(s * 0.27, s * 0.76, s * 0.06), '#ffffff', '#111827', 0.05);
      inked(c, s, cloudPath(s * 0.54, s * 0.64, s * 0.8), '#ffffff');
    },
  },
];

export const MORE_WORDS: readonly Sticker[] = [
  {
    id: 'omg',
    category: 'words',
    label: 'sticker.omg',
    loop: 'pulse',
    draw: (c, s, words) => {
      finish(c, s, burstPath(s / 2, s / 2, s * 0.46, s * 0.34, 14), vertical(c, s, '#c084fc', '#7c3aed'));
      lettering(c, s, words('sticker.omgText'), s * 0.5, s * 0.52, s * 0.66, '#fde047', s * 0.24);
    },
  },
  {
    id: 'lol',
    category: 'words',
    label: 'sticker.lol',
    loop: 'sway',
    draw: (c, s, words) => pill(c, s, words('sticker.lolText'), '#f472b6', '#db2777', '#ffffff', 0.17),
  },
  {
    id: 'sale',
    category: 'words',
    label: 'sticker.sale',
    loop: 'sway',
    draw: (c, s, words) => {
      turned(c, s, -0.22, () => {
        finish(c, s, polygon([[s * 0.1, s * 0.32], [s * 0.66, s * 0.32], [s * 0.9, s * 0.5], [s * 0.66, s * 0.68], [s * 0.1, s * 0.68]]), vertical(c, s, '#f87171', '#dc2626'));
        fillPath(c, circle(s * 0.73, s * 0.5, s * 0.04), '#ffffff');
        lettering(c, s, words('sticker.saleText'), s * 0.38, s * 0.505, s * 0.46, '#ffffff', s * 0.15);
      });
    },
  },
  {
    id: 'trending',
    category: 'words',
    label: 'sticker.trending',
    loop: 'pulse',
    draw: (c, s, words) => pill(c, s, words('sticker.trendingText'), '#fb923c', '#dc2626'),
  },
  {
    id: 'free',
    category: 'words',
    label: 'sticker.free',
    loop: 'pulse',
    draw: (c, s, words) => {
      finish(c, s, roundRect(s * 0.12, s * 0.3, s * 0.76, s * 0.4, s * 0.12), vertical(c, s, '#4ade80', '#16a34a'));
      lettering(c, s, words('sticker.freeText'), s * 0.5, s * 0.505, s * 0.64, '#ffffff', s * 0.18);
    },
  },
  {
    id: 'boom',
    category: 'words',
    label: 'sticker.boom',
    loop: 'pulse',
    draw: (c, s, words) => {
      finish(c, s, burstPath(s / 2, s / 2, s * 0.47, s * 0.3, 11), vertical(c, s, '#fde047', '#f59e0b'));
      fillPath(c, burstPath(s / 2, s / 2, s * 0.34, s * 0.22, 11), vertical(c, s, '#fb923c', '#ef4444'));
      lettering(c, s, words('sticker.boomText'), s * 0.5, s * 0.52, s * 0.6, '#ffffff', s * 0.2);
    },
  },
  {
    id: 'top',
    category: 'words',
    label: 'sticker.top',
    loop: 'float',
    draw: (c, s, words) => {
      finish(c, s, polygon([[s * 0.02, s * 0.44], [s * 0.18, s * 0.44], [s * 0.18, s * 0.7], [s * 0.02, s * 0.7], [s * 0.08, s * 0.57]]), '#b45309');
      finish(c, s, polygon([[s * 0.98, s * 0.44], [s * 0.82, s * 0.44], [s * 0.82, s * 0.7], [s * 0.98, s * 0.7], [s * 0.92, s * 0.57]]), '#b45309');
      finish(c, s, roundRect(s * 0.12, s * 0.36, s * 0.76, s * 0.28, s * 0.04), vertical(c, s, '#fde68a', '#d97706'));
      lettering(c, s, words('sticker.topText'), s * 0.5, s * 0.505, s * 0.6, '#ffffff', s * 0.2);
    },
  },
  {
    id: 'followUs',
    category: 'words',
    label: 'sticker.followUs',
    loop: 'pulse',
    draw: (c, s, words) => pill(c, s, words('sticker.followUsText'), '#a78bfa', '#7c3aed'),
  },
  {
    id: 'linkBio',
    category: 'words',
    label: 'sticker.linkBio',
    loop: 'pulse',
    draw: (c, s, words) => pill(c, s, words('sticker.linkBioText'), '#22d3ee', '#0891b2', '#ffffff', 0.12),
  },
];
