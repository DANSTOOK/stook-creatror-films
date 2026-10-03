import type { CaptionContent, CaptionLink, CaptionTrackSettings, CaptionWord } from '@shared/types';
import { normalizeLook } from './look';
import { normalizeCaptionAnimation } from './animation';

/**
 * Captions read from a project file: whatever is missing or out of range
 * made safe, so a damaged or future file still opens with captions that draw.
 */

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function normalizeCaption(raw: unknown): CaptionContent {
  const source = (raw ?? {}) as { text?: unknown; words?: unknown; manualBreaks?: unknown; link?: unknown };
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
  return { text, ...(words.length > 0 ? { words } : {}), ...(source.manualBreaks === true ? { manualBreaks: true } : {}), ...(link ? { link } : {}) };
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
