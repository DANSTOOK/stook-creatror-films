import type { MessageKey } from '@shared/i18n';

/**
 * Frames: a full-frame picture with a hole in the middle, laid over the video -
 * a border, a vignette, or the guide that keeps a Short's content out of where
 * the app it is posted to puts its own buttons.
 *
 * Drawn here, at whatever size is asked, the way the stickers and backgrounds
 * are (renderer/stickers, renderer/backgrounds): nothing is downloaded and no
 * one else's artwork ships with the app.
 *
 * What these are NOT: a copy of TikTok's or YouTube's interface. Their logos,
 * their buttons and their layout are somebody's brand, and a frame that looked
 * like the real thing would be an imitation of it. A "frame for Shorts" here
 * means a frame drawn for the SHAPE and the SAFE AREA those apps leave - the
 * strip down the right and the band along the bottom that their own controls
 * cover - which is the part that is actually useful and is nobody's property.
 *
 * The safe-area margins are the ones the platforms publish for creators and are
 * generous rather than exact, because every version of those apps moves its
 * buttons: a guide that is a little wide costs nothing, and one that is too
 * tight puts a caption under a button.
 */

export type FrameGroup = 'safe' | 'borders' | 'vignettes';

export interface Frame {
  id: string;
  group: FrameGroup;
  label: MessageKey;
  /**
   * Paint it over a `width` x `height` canvas that starts out CLEAR. Whatever
   * is left transparent is where the video shows through.
   */
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
}

/* The brushes ---------------------------------------------------------------------- */

/** A rectangle with a rectangular hole: the frame itself, in one fill. */
function hole(
  context: CanvasRenderingContext2D,
  w: number,
  h: number,
  inset: { left: number; right: number; top: number; bottom: number },
  radius: number,
  fill: string | CanvasGradient,
): void {
  const path = new Path2D();
  path.rect(0, 0, w, h);
  const inner = new Path2D();
  inner.roundRect(w * inset.left, h * inset.top, w * (1 - inset.left - inset.right), h * (1 - inset.top - inset.bottom), radius);
  path.addPath(inner);
  context.fillStyle = fill;
  // Even-odd, so the inner rectangle is the hole rather than more paint.
  context.fill(path, 'evenodd');
}

/** An even border `share` of the short side thick. */
const border = (context: CanvasRenderingContext2D, w: number, h: number, share: number, fill: string | CanvasGradient, radius = 0): void => {
  const thickness = (Math.min(w, h) * share) / Math.min(w, h);
  hole(context, w, h, { left: thickness, right: thickness, top: (Math.min(w, h) * share) / h, bottom: (Math.min(w, h) * share) / h }, radius, fill);
};

/** A dashed line just inside the edge: a guide, not decoration. */
function guideLine(context: CanvasRenderingContext2D, w: number, h: number, inset: { left: number; right: number; top: number; bottom: number }, colour: string): void {
  const x = w * inset.left;
  const y = h * inset.top;
  const width = w * (1 - inset.left - inset.right);
  const height = h * (1 - inset.top - inset.bottom);
  context.save();
  context.strokeStyle = colour;
  context.lineWidth = Math.max(2, Math.min(w, h) / 360);
  context.setLineDash([Math.min(w, h) / 36, Math.min(w, h) / 54]);
  context.strokeRect(x, y, width, height);
  context.restore();
}

/** A vertical gradient along one edge, fading to nothing: a scrim to read text over. */
function scrim(context: CanvasRenderingContext2D, w: number, h: number, edge: 'top' | 'bottom', share: number, colour: string): void {
  const height = h * share;
  const from = edge === 'top' ? 0 : h - height;
  const gradient = context.createLinearGradient(0, from, 0, edge === 'top' ? height : h);
  gradient.addColorStop(edge === 'top' ? 0 : 1, colour);
  gradient.addColorStop(edge === 'top' ? 1 : 0, 'rgb(0 0 0 / 0)');
  context.fillStyle = gradient;
  context.fillRect(0, from, w, height);
}

/* The set -------------------------------------------------------------------------- */

/**
 * What a vertical app leaves clear, as a share of the frame.
 *
 * Down the right is where the buttons stack; along the bottom is the caption and
 * the handle; the top carries the progress bar and whatever is pinned there.
 */
const SHORTS = { left: 0.04, right: 0.2, top: 0.1, bottom: 0.2 };
const REELS = { left: 0.05, right: 0.18, top: 0.08, bottom: 0.24 };

export const FRAMES: readonly Frame[] = [
  /* Safe areas ------------------------------------------------------------ */
  {
    id: 'safeShorts',
    group: 'safe',
    label: 'frame.safeShorts',
    draw: (context, w, h) => {
      // Dimmed where the app's own controls go, so what is covered is obvious
      // while editing - and a dashed line on the edge of what is safe.
      hole(context, w, h, SHORTS, 0, 'rgb(0 0 0 / 0.45)');
      guideLine(context, w, h, SHORTS, 'rgb(103 232 249 / 0.9)');
    },
  },
  {
    id: 'safeReels',
    group: 'safe',
    label: 'frame.safeReels',
    draw: (context, w, h) => {
      hole(context, w, h, REELS, 0, 'rgb(0 0 0 / 0.45)');
      guideLine(context, w, h, REELS, 'rgb(244 114 182 / 0.9)');
    },
  },
  {
    id: 'safeGuide',
    group: 'safe',
    label: 'frame.safeGuide',
    draw: (context, w, h) => {
      // The guide alone: nothing dimmed, so it can be left on while grading.
      guideLine(context, w, h, SHORTS, 'rgb(103 232 249 / 0.85)');
      guideLine(context, w, h, { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 }, 'rgb(255 255 255 / 0.35)');
    },
  },
  {
    id: 'titleSafe',
    group: 'safe',
    label: 'frame.titleSafe',
    draw: (context, w, h) => {
      // Broadcast's two: 90 % for action, 80 % for titles.
      guideLine(context, w, h, { left: 0.05, right: 0.05, top: 0.05, bottom: 0.05 }, 'rgb(255 255 255 / 0.4)');
      guideLine(context, w, h, { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 }, 'rgb(253 224 71 / 0.8)');
    },
  },
  {
    id: 'lowerScrim',
    group: 'safe',
    label: 'frame.lowerScrim',
    draw: (context, w, h) => {
      // No guide, just the dark gradient a caption needs to stay readable.
      scrim(context, w, h, 'bottom', 0.34, 'rgb(0 0 0 / 0.75)');
    },
  },

  /* Borders --------------------------------------------------------------- */
  {
    id: 'white',
    group: 'borders',
    label: 'frame.white',
    draw: (context, w, h) => border(context, w, h, 0.035, '#ffffff'),
  },
  {
    id: 'polaroid',
    group: 'borders',
    label: 'frame.polaroid',
    draw: (context, w, h) => {
      // Even on three sides, deep at the bottom: the print you write on.
      hole(context, w, h, { left: 0.05, right: 0.05, top: 0.05, bottom: 0.2 }, 0, '#f8f5ee');
    },
  },
  {
    id: 'rounded',
    group: 'borders',
    label: 'frame.rounded',
    draw: (context, w, h) => {
      // A phone's corners: the picture keeps its own, the frame fills the rest.
      hole(context, w, h, { left: 0.02, right: 0.02, top: 0.02, bottom: 0.02 }, Math.min(w, h) * 0.07, '#0f172a');
    },
  },
  {
    id: 'neon',
    group: 'borders',
    label: 'frame.neon',
    draw: (context, w, h) => {
      const thin = Math.min(w, h) * 0.012;
      const gradient = context.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#22d3ee');
      gradient.addColorStop(0.5, '#a78bfa');
      gradient.addColorStop(1, '#f472b6');
      // The glow first, wide and faint, then the line over it.
      context.save();
      context.shadowColor = '#22d3ee';
      context.shadowBlur = thin * 6;
      hole(context, w, h, { left: 0.03, right: 0.03, top: (Math.min(w, h) * 0.03) / h, bottom: (Math.min(w, h) * 0.03) / h }, thin * 2, gradient);
      context.restore();
    },
  },
  {
    id: 'film',
    group: 'borders',
    label: 'frame.film',
    draw: (context, w, h) => {
      const edge = Math.min(w, h) * 0.08;
      hole(context, w, h, { left: edge / w, right: edge / w, top: 0, bottom: 0 }, 0, '#111111');
      // Sprocket holes down both sides, as a strip of film has them.
      const hole1 = Math.min(w, h) * 0.03;
      context.fillStyle = '#f8fafc';
      for (let y = hole1; y < h - hole1; y += hole1 * 2.4) {
        context.beginPath();
        context.roundRect(edge * 0.25, y, hole1, hole1 * 1.3, hole1 * 0.2);
        context.roundRect(w - edge * 0.25 - hole1, y, hole1, hole1 * 1.3, hole1 * 0.2);
        context.fill();
      }
    },
  },
  {
    id: 'tape',
    group: 'borders',
    label: 'frame.tape',
    draw: (context, w, h) => {
      border(context, w, h, 0.03, '#0b1120');
      // A bright inner line, as a viewfinder's frame has.
      guideLine(context, w, h, { left: 0.045, right: 0.045, top: 0.045, bottom: 0.045 }, 'rgb(248 250 252 / 0.5)');
    },
  },

  /* Vignettes ------------------------------------------------------------- */
  {
    id: 'vignette',
    group: 'vignettes',
    label: 'frame.vignette',
    draw: (context, w, h) => {
      const gradient = context.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      gradient.addColorStop(0, 'rgb(0 0 0 / 0)');
      gradient.addColorStop(1, 'rgb(0 0 0 / 0.75)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'spotlight',
    group: 'vignettes',
    label: 'frame.spotlight',
    draw: (context, w, h) => {
      // Tighter and higher: the light on a face in an interview.
      const gradient = context.createRadialGradient(w / 2, h * 0.42, Math.min(w, h) * 0.18, w / 2, h * 0.42, Math.max(w, h) * 0.6);
      gradient.addColorStop(0, 'rgb(0 0 0 / 0)');
      gradient.addColorStop(1, 'rgb(0 0 0 / 0.88)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'letterbox',
    group: 'vignettes',
    label: 'frame.letterbox',
    draw: (context, w, h) => {
      // 2.39:1 bars over whatever shape the project is.
      const keep = w / 2.39;
      const bar = Math.max(0, (h - keep) / 2);
      context.fillStyle = '#000000';
      context.fillRect(0, 0, w, bar);
      context.fillRect(0, h - bar, w, bar);
    },
  },
  {
    id: 'cornerFade',
    group: 'vignettes',
    label: 'frame.cornerFade',
    draw: (context, w, h) => {
      scrim(context, w, h, 'top', 0.22, 'rgb(0 0 0 / 0.6)');
      scrim(context, w, h, 'bottom', 0.22, 'rgb(0 0 0 / 0.6)');
    },
  },
  {
    id: 'blurEdge',
    group: 'vignettes',
    label: 'frame.blurEdge',
    draw: (context, w, h) => {
      // A soft white edge: the picture seems to melt into the page.
      const gradient = context.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.7);
      gradient.addColorStop(0, 'rgb(255 255 255 / 0)');
      gradient.addColorStop(1, 'rgb(255 255 255 / 0.85)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'gold',
    group: 'borders',
    label: 'frame.gold',
    draw: (context, w, h) => {
      // A gilt picture frame: a broad band with a lit edge and a dark one, so
      // it reads as moulding rather than a flat stripe.
      const band = Math.min(w, h) * 0.055;
      const sheen = context.createLinearGradient(0, 0, w, h);
      sheen.addColorStop(0, '#fde68a');
      sheen.addColorStop(0.35, '#b45309');
      sheen.addColorStop(0.5, '#fef3c7');
      sheen.addColorStop(0.7, '#92400e');
      sheen.addColorStop(1, '#fbbf24');
      hole(context, w, h, { left: band / w, right: band / w, top: band / h, bottom: band / h }, 0, sheen);
      context.strokeStyle = 'rgb(69 26 3 / 0.55)';
      context.lineWidth = Math.max(1, band * 0.09);
      context.strokeRect(band * 0.3, band * 0.3, w - band * 0.6, h - band * 0.6);
      context.strokeRect(band, band, w - band * 2, h - band * 2);
    },
  },
  {
    id: 'woodFrame',
    group: 'borders',
    label: 'frame.wood',
    draw: (context, w, h) => {
      const band = Math.min(w, h) * 0.05;
      context.fillStyle = '#8b5a2b';
      context.fillRect(0, 0, w, h);
      // Grain along the band, which is what tells wood from brown paint.
      context.strokeStyle = 'rgb(69 26 3 / 0.35)';
      context.lineWidth = Math.max(1, band * 0.05);
      for (let line = 0; line < 26; line += 1) {
        const y = (h / 26) * line + band * 0.1;
        context.beginPath();
        context.moveTo(0, y);
        context.bezierCurveTo(w * 0.3, y + band * 0.1, w * 0.7, y - band * 0.1, w, y);
        context.stroke();
      }
      // The grain was drawn across the whole canvas; cut the picture out of it.
      context.globalCompositeOperation = 'destination-out';
      context.fillRect(band, band, w - band * 2, h - band * 2);
      context.globalCompositeOperation = 'source-over';
      context.strokeStyle = 'rgb(255 255 255 / 0.18)';
      context.lineWidth = Math.max(1, band * 0.08);
      context.strokeRect(band * 0.5, band * 0.5, w - band, h - band);
    },
  },
  {
    id: 'doubleLine',
    group: 'borders',
    label: 'frame.doubleLine',
    draw: (context, w, h) => {
      // Two hairlines with air between them: the plainest frame that still
      // looks deliberate.
      const gap = Math.min(w, h) * 0.022;
      context.strokeStyle = '#f8fafc';
      context.lineWidth = Math.max(1, Math.min(w, h) * 0.004);
      context.strokeRect(gap, gap, w - gap * 2, h - gap * 2);
      context.lineWidth = Math.max(1, Math.min(w, h) * 0.0018);
      context.strokeRect(gap * 2.1, gap * 2.1, w - gap * 4.2, h - gap * 4.2);
    },
  },
  {
    id: 'cornerTicks',
    group: 'borders',
    label: 'frame.cornerTicks',
    draw: (context, w, h) => {
      // Only the corners: a viewfinder, which frames without boxing in.
      const arm = Math.min(w, h) * 0.09;
      const inset = Math.min(w, h) * 0.035;
      context.strokeStyle = '#f8fafc';
      context.lineWidth = Math.max(2, Math.min(w, h) * 0.006);
      context.lineCap = 'round';
      const corner = (x: number, y: number, dx: number, dy: number): void => {
        context.beginPath();
        context.moveTo(x + dx * arm, y);
        context.lineTo(x, y);
        context.lineTo(x, y + dy * arm);
        context.stroke();
      };
      corner(inset, inset, 1, 1);
      corner(w - inset, inset, -1, 1);
      corner(inset, h - inset, 1, -1);
      corner(w - inset, h - inset, -1, -1);
    },
  },
  {
    id: 'torn',
    group: 'borders',
    label: 'frame.torn',
    draw: (context, w, h) => {
      // A torn paper edge: a ragged white band round the picture.
      const band = Math.min(w, h) * 0.05;
      let seed = 7;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      context.fillStyle = '#fafaf9';
      context.beginPath();
      context.rect(0, 0, w, h);
      context.moveTo(band, band);
      const edge = (fromX: number, fromY: number, toX: number, toY: number): void => {
        const steps = 26;
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const jitter = (random() - 0.5) * band * 0.7;
          const nx = fromX + (toX - fromX) * t + (fromY === toY ? 0 : jitter);
          const ny = fromY + (toY - fromY) * t + (fromX === toX ? 0 : jitter);
          context.lineTo(nx, ny);
        }
      };
      edge(band, band, w - band, band);
      edge(w - band, band, w - band, h - band);
      edge(w - band, h - band, band, h - band);
      edge(band, h - band, band, band);
      context.closePath();
      context.fill('evenodd');
    },
  },
  {
    id: 'dashed',
    group: 'borders',
    label: 'frame.dashed',
    draw: (context, w, h) => {
      const inset = Math.min(w, h) * 0.03;
      const unit = Math.min(w, h) * 0.02;
      context.strokeStyle = '#f8fafc';
      context.lineWidth = Math.max(2, Math.min(w, h) * 0.005);
      context.setLineDash([unit, unit * 0.7]);
      context.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
      context.setLineDash([]);
    },
  },
  {
    id: 'ribbon',
    group: 'borders',
    label: 'frame.ribbon',
    draw: (context, w, h) => {
      // A coloured band along the bottom to write on, and a thin rule above it.
      const bandH = h * 0.16;
      const ribbon = context.createLinearGradient(0, h - bandH, 0, h);
      ribbon.addColorStop(0, 'rgb(6 182 212 / 0.92)');
      ribbon.addColorStop(1, 'rgb(14 116 144 / 0.96)');
      context.fillStyle = ribbon;
      context.fillRect(0, h - bandH, w, bandH);
      context.fillStyle = 'rgb(255 255 255 / 0.85)';
      context.fillRect(0, h - bandH, w, Math.max(2, h * 0.004));
    },
  },
  {
    id: 'arch',
    group: 'borders',
    label: 'frame.arch',
    draw: (context, w, h) => {
      // An arched top, as a poster or a church window: the picture is cut to
      // a rounded head and everything round it is covered.
      const inset = Math.min(w, h) * 0.05;
      const left = inset;
      const right = w - inset;
      const bottom = h - inset;
      const radius = Math.min((right - left) / 2, (bottom - inset) * 0.42);
      const headY = inset + radius;
      context.fillStyle = '#f8fafc';
      context.beginPath();
      context.rect(0, 0, w, h);
      context.moveTo(left, bottom);
      context.lineTo(left, headY);
      // The head is a half-ellipse, so it spans the full width whatever the
      // frame’s shape while the sides stay straight.
      context.ellipse((left + right) / 2, headY, (right - left) / 2, radius, 0, Math.PI, 0);
      context.lineTo(right, bottom);
      context.closePath();
      context.fill('evenodd');
    },
  },
  {
    id: 'roundWindow',
    group: 'vignettes',
    label: 'frame.roundWindow',
    draw: (context, w, h) => {
      // Everything outside a circle is covered: a porthole.
      context.fillStyle = '#000000';
      context.beginPath();
      context.rect(0, 0, w, h);
      context.arc(w / 2, h / 2, Math.min(w, h) * 0.44, 0, Math.PI * 2);
      context.fill('evenodd');
    },
  },
  {
    id: 'warmVignette',
    group: 'vignettes',
    label: 'frame.warmVignette',
    draw: (context, w, h) => {
      const gradient = context.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
      gradient.addColorStop(0, 'rgb(120 53 15 / 0)');
      gradient.addColorStop(1, 'rgb(69 26 3 / 0.7)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'sideScrims',
    group: 'vignettes',
    label: 'frame.sideScrims',
    draw: (context, w, h) => {
      // Darkened down the sides: a wide shot cropped by eye to the middle.
      for (const side of [0, 1]) {
        const gradient = context.createLinearGradient(side ? w : 0, 0, side ? w * 0.74 : w * 0.26, 0);
        gradient.addColorStop(0, 'rgb(0 0 0 / 0.75)');
        gradient.addColorStop(1, 'rgb(0 0 0 / 0)');
        context.fillStyle = gradient;
        context.fillRect(side ? w * 0.74 : 0, 0, w * 0.26, h);
      }
    },
  },
  {
    id: 'safeSquare',
    group: 'safe',
    label: 'frame.safeSquare',
    draw: (context, w, h) => {
      // The square middle a feed crops to, marked on a wider frame.
      const side = Math.min(w, h);
      const x = (w - side) / 2;
      const y = (h - side) / 2;
      context.fillStyle = 'rgb(0 0 0 / 0.55)';
      context.beginPath();
      context.rect(0, 0, w, h);
      context.rect(x, y, side, side);
      context.fill('evenodd');
      context.strokeStyle = 'rgb(34 211 238 / 0.95)';
      // At least 2px: a hairline works out thinner than a pixel on a thumbnail
      // and the guide disappears exactly where it is being chosen.
      context.lineWidth = Math.max(2, Math.min(w, h) * 0.005);
      context.strokeRect(x, y, side, side);
    },
  },
];

/** The groups, in the order the panel shows them. */
export const FRAME_GROUPS: readonly FrameGroup[] = ['safe', 'borders', 'vignettes'];

export const frameById = (id: string): Frame | undefined => FRAMES.find((frame) => frame.id === id);
