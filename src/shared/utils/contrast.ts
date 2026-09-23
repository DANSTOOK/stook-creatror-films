/**
 * Contrast, by the WCAG 2.1 formula.
 *
 * The interface is small, dense and dark, which is where contrast quietly goes
 * wrong: a grey that looks fine on a designer's screen at 16 px is unreadable
 * at 10 px on a laptop in daylight. The numbers that matter:
 *
 * - **4.5:1** for text of the sizes used here (WCAG 1.4.3; the 3:1 exception
 *   is for text at 24 px, or 18.66 px bold, and nothing here is that big).
 * - **3:1** for the shapes that carry meaning - a clip body against the
 *   timeline, a focus ring against what it sits on (1.4.11).
 *
 * Pure and shared on purpose: the interface tests walk the running app with
 * exactly this function, so "it passes" means the same thing in both places.
 */

export const TEXT_CONTRAST = 4.5;
export const SHAPE_CONTRAST = 3;

export type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, `rgb(r g b)` or `rgba(r, g, b, a)` - what a browser reports. */
export function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    const full = digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits;
    return {
      rgb: [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as Rgb,
      alpha: 1,
    };
  }

  const parts = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!parts) return null;
  const numbers = parts[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((piece) => (piece.endsWith('%') ? (Number.parseFloat(piece) / 100) * 255 : Number.parseFloat(piece)));
  if (numbers.length < 3 || numbers.some((n) => Number.isNaN(n))) return null;

  const alpha = numbers.length > 3 ? numbers[3] / (numbers[3] > 1 ? 255 : 1) : 1;
  return { rgb: [numbers[0], numbers[1], numbers[2]] as Rgb, alpha: Math.min(1, Math.max(0, alpha)) };
}

/** Lay a colour with alpha over an opaque one, as the screen does. */
export function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((value, index) => value * alpha + bottom[index] * (1 - alpha)) as Rgb;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (eight: number): number => {
    const v = Math.min(255, Math.max(0, eight)) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The ratio between two CSS colour strings, the background assumed opaque. */
export function contrastOf(foreground: string, background: string): number | null {
  const front = parseColor(foreground);
  const back = parseColor(background);
  if (!front || !back) return null;
  return contrastRatio(over(front.rgb, front.alpha, back.rgb), back.rgb);
}
