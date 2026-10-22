import type { CaptionContent, CaptionLink, CaptionStyleOverride, CaptionTrackSettings, CaptionWord } from '@shared/types';
import { normalizeLook } from './look';
import { normalizeCaptionAnimation } from './animation';

/**
 * Captions read from a project file: whatever is missing or out of range
 * made safe, so a damaged or future file still opens with captions that draw.
 */

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function normalizeCaption(raw: unknown): CaptionContent {
  const source = (raw ?? {}) as { text?: unknown; words?: unknown; manualBreaks?: unknown; link?: unknown; style?: unknown };
  const text = typeof source.text === 'string' ? source.text : '';
  const words = Array.isArray(source.words)
    ? source.words
        .filter((word): word is CaptionWord => {
          const w = word as Partial<CaptionWord> | null;
          return Boolean(w) && typeof w?.text === 'string' && finite(w?.start) && finite(w?.end);
        })
        .map((word) => ({ text: word.text, start: word.start, end: Math.max(word.start, word.end) }))
    : [];
  const link = normalizeLink(source.link);
  const style = normalizeCaptionStyle(source.style);
  return {
    text,
    ...(words.length > 0 ? { words } : {}),
    ...(source.manualBreaks === true ? { manualBreaks: true } : {}),
    ...(link ? { link } : {}),
    ...(style ? { style } : {}),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A caption's own look, kept only in parts this build can draw: nothing left, nothing kept. */
export function normalizeCaptionStyle(raw: unknown): CaptionStyleOverride | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const style: CaptionStyleOverride = {};
  if (typeof source.color === 'string' && HEX.test(source.color)) style.color = source.color.toLowerCase();
  if (source.bold === true) style.bold = true;
  if (finite(source.scale) && source.scale !== 1) style.scale = Math.min(2, Math.max(0.5, source.scale));
  if (typeof source.band === 'string' && HEX.test(source.band)) style.band = source.band.toLowerCase();
  return Object.keys(style).length > 0 ? style : undefined;
}

/** A link with every number a number, or nothing: a caption with a broken tie just stays put. */
function normalizeLink(raw: unknown): CaptionLink | null {
  const source = (raw ?? null) as Partial<Record<keyof CaptionLink, unknown>> | null;
  if (!source || typeof source.clipId !== 'string' || typeof source.sourceUri !== 'string') return null;
  if (!finite(source.from) || !finite(source.to) || !finite(source.origin)) return null;
  return {
    clipId: source.clipId,
    sourceUri: source.sourceUri,
    from: source.from,
    to: Math.max(source.from, source.to),
    origin: source.origin,
    ...(finite(source.lead) && source.lead > 0 ? { lead: source.lead } : {}),
    ...(finite(source.hold) && source.hold > 0 ? { hold: source.hold } : {}),
  };
}

export function normalizeCaptionSettings(raw: unknown): CaptionTrackSettings {
  const source = (raw ?? {}) as Partial<Record<keyof CaptionTrackSettings, unknown>>;
  const preset = source.preset === 'social' ? 'social' : 'classic';
  const animation = normalizeCaptionAnimation(source.animation);
  return {
    preset,
    language: source.language === 'en' ? 'en' : 'es',
    ...(source.look ? { look: normalizeLook(source.look, preset) } : {}),
    ...(animation ? { animation } : {}),
  };
}
