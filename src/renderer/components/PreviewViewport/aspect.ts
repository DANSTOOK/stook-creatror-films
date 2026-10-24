import { reframedSize } from '@renderer/edit/reframe';

/**
 * The shapes the viewer offers under the picture, as CapCut's player does:
 * landscape, vertical (Reels, TikTok, Shorts), square, and the 4:5 portrait
 * that feeds favour. Choosing one keeps the frame's short side - a 1080p edit
 * stays 1080 across in any shape - so the picture is as sharp as it was; the
 * clips are fitted to it without stretching (edit/frameShape.ts).
 */

export const ASPECTS = [
  { id: '16:9', across: 16, down: 9 },
  { id: '9:16', across: 9, down: 16 },
  { id: '1:1', across: 1, down: 1 },
  { id: '4:5', across: 4, down: 5 },
] as const;

export type AspectId = (typeof ASPECTS)[number]['id'];

export const isAspectId = (value: string): value is AspectId => ASPECTS.some((aspect) => aspect.id === value);

/** Which of them a frame is, or null for any other shape. A pixel or two off still counts: 1366×768 is 16:9. */
export function aspectOf(width: number, height: number): AspectId | null {
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = width / height;
  return ASPECTS.find((aspect) => Math.abs(ratio / (aspect.across / aspect.down) - 1) < 0.01)?.id ?? null;
}

/** The frame of that shape at the same sharpness: the short side kept, as Auto reframe makes it. */
export function frameForAspect(width: number, height: number, id: AspectId): { width: number; height: number } {
  const aspect = ASPECTS.find((entry) => entry.id === id) ?? ASPECTS[0];
  return reframedSize(width, height, { w: aspect.across, h: aspect.down });
}

/** The sharpnesses offered for any shape, by the frame's short side: 720p, 1080p, 1440p and 4K. */
export const SHORT_SIDES = [720, 1080, 1440, 2160] as const;

/** The frame of that shape whose short side is `short`: 1080 makes 1920×1080 in 16:9 and 1080×1920 in 9:16. */
export const frameAtShortSide = (id: AspectId, short: number): { width: number; height: number } => frameForAspect(short, short, id);

/** What the short side is called: 720p, 1080p, 1440p, 4K. */
export const sharpnessName = (short: number): string => (short === 2160 ? '4K' : `${short}p`);
