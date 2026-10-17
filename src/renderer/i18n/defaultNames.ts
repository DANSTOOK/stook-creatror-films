import { LANGUAGES, translate, type MessageKey } from '@shared/i18n';
import type { TrackType } from '@shared/types';
import { t } from './index';

/**
 * Names the editor gives things it creates: "Video 1", "Bin 2", "Marker 90".
 *
 * Given in the language on screen at the moment the thing is made, and then
 * kept: a name is the user's from then on, like one they typed, and switching
 * the language later does not rename anything. Counting ("one more than the
 * highest used") reads the names in every language, so "Vídeo 3" follows
 * "Video 2" in a project begun in English.
 */

const TRACK_KEYS: Record<TrackType, MessageKey> = {
  video: 'name.videoTrack',
  audio: 'name.audioTrack',
  text: 'name.textTrack',
  adjustment: 'name.adjustmentTrack',
  captions: 'name.captionsTrack',
};

export const trackName = (type: TrackType, n: number): string => t(TRACK_KEYS[type], { n });
export const binName = (n: number): string => t('name.bin', { n });
export const markerName = (n: number): string => t('name.marker', { n });

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The number in a default name of this kind, in any language; null when it is not one. */
export function defaultNameNumber(key: MessageKey, name: string): number | null {
  for (const { id } of LANGUAGES) {
    const [before, after = ''] = translate(id, key, { n: '\u0000' }).split('\u0000');
    const match = new RegExp(`^${escapeRegExp(before)}(\\d+)${escapeRegExp(after)}$`, 'i').exec(name);
    if (match) return Number(match[1]);
  }
  return null;
}

export const trackNameNumber = (type: TrackType, name: string): number | null => defaultNameNumber(TRACK_KEYS[type], name);

/**
 * A default name given another number, in the language it was written in -
 * "Vídeo 3" becomes "Vídeo 2", never "Video 2" - or null when the name is
 * not a default one (the user's own names are never touched).
 */
export function renumberedDefaultName(key: MessageKey, name: string, n: number): string | null {
  for (const { id } of LANGUAGES) {
    const [before, after = ''] = translate(id, key, { n: '\u0000' }).split('\u0000');
    if (new RegExp(`^${escapeRegExp(before)}(\\d+)${escapeRegExp(after)}$`, 'i').test(name)) return translate(id, key, { n });
  }
  return null;
}

export const renumberedTrackName = (type: TrackType, name: string, n: number): string | null =>
  renumberedDefaultName(TRACK_KEYS[type], name, n);
