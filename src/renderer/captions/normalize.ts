import type { CaptionContent, CaptionTrackSettings, CaptionWord } from '@shared/types';

/**
 * Captions read from a project file: whatever is missing or out of range
 * made safe, so a damaged or future file still opens with captions that draw.
 */

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function normalizeCaption(raw: unknown): CaptionContent {
  const source = (raw ?? {}) as { text?: unknown; words?: unknown };
  const text = typeof source.text === 'string' ? source.text : '';
  const words = Array.isArray(source.words)
    ? source.words
        .filter((word): word is CaptionWord => {
          const w = word as Partial<CaptionWord> | null;
          return Boolean(w) && typeof w?.text === 'string' && finite(w?.start) && finite(w?.end);
        })
        .map((word) => ({ text: word.text, start: word.start, end: Math.max(word.start, word.end) }))
    : [];
  return { text, ...(words.length > 0 ? { words } : {}) };
}

export function normalizeCaptionSettings(raw: unknown): CaptionTrackSettings {
  const source = (raw ?? {}) as Partial<Record<keyof CaptionTrackSettings, unknown>>;
  return {
    preset: source.preset === 'social' ? 'social' : 'classic',
    language: source.language === 'en' ? 'en' : 'es',
  };
}
