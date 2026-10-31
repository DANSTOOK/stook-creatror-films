import type { TtsEffect } from '@shared/types/ipc';
import type { MessageKey } from '@shared/i18n';

/**
 * Characters: a voice, a pace, a pitch and a style in one click - the
 * documentary narrator, the radio host, the excited YouTuber, the storyteller,
 * a child, a monster, a robot - as CapCut's and Filmora's voice characters
 * offer them. Each is only a starting point: the voice, sliders and style it
 * sets stay free to change. The voices named are the installer's own
 * (main/tts/catalog.ts), a Spanish one and, for a script in English, an
 * English one; one that is missing falls back to any voice present.
 *
 * The Spanish voice of every character is a PIPER voice, each trained on
 * Spanish alone and chosen for its region: es-MX-claude and es-AR-daniela are
 * the two at 'high' quality, so they go where the voice is heard clean, and the
 * medium ones go where an effect covers it (the monster's cave, the robot).
 *
 * They used to be Kokoro's es-419 voices. Kokoro is one model for eight
 * languages trained on a few hundred hours in all (its own model card gives no
 * per-language figure), and its Spanish carries the accent of a model that is
 * mostly English - which is what 'the Mexican sounds American' was. Nothing had
 * to be downloaded to fix it: every Piper voice named here already ships in the
 * installer (build/tts-voices), they were simply not being used. Kokoro's
 * Spanish voices are still in the list to pick by hand, and its English ones
 * stay the English characters' - English is the language it was built for.
 */

export interface VoiceCharacter {
  id: string;
  label: MessageKey;
  voice: string;
  /** The voice when the script is in English (Kokoro's English voices). */
  voiceEn?: string;
  speed: number;
  pitch: number;
  effect: TtsEffect;
}

export const VOICE_CHARACTERS: readonly VoiceCharacter[] = [
  { id: 'narrator', label: 'tts.character.narrator', voice: 'es-MX-claude', voiceEn: 'en-US-michael', speed: 0.92, pitch: -1, effect: 'warm' },
  { id: 'host', label: 'tts.character.host', voice: 'es-AR-daniela', voiceEn: 'en-US-heart', speed: 1, pitch: 0, effect: 'radio' },
  { id: 'youtuber', label: 'tts.character.youtuber', voice: 'es-MX-claude', voiceEn: 'en-US-bella', speed: 1.15, pitch: 1, effect: 'none' },
  { id: 'news', label: 'tts.character.news', voice: 'es-AR-daniela', voiceEn: 'en-GB-emma', speed: 1.05, pitch: 0, effect: 'radio' },
  { id: 'storyteller', label: 'tts.character.storyteller', voice: 'es-ES-sharvard', voiceEn: 'en-GB-george', speed: 0.88, pitch: 0.5, effect: 'warm' },
  { id: 'grandpa', label: 'tts.character.grandpa', voice: 'es-ES-davefx', voiceEn: 'en-GB-george', speed: 0.9, pitch: 0, effect: 'warm' },
  { id: 'child', label: 'tts.character.child', voice: 'es-AR-daniela', voiceEn: 'en-US-bella', speed: 1.05, pitch: 6, effect: 'none' },
  { id: 'monster', label: 'tts.character.monster', voice: 'es-MX-ald', voiceEn: 'en-US-fenrir', speed: 0.9, pitch: -6, effect: 'cave' },
  { id: 'robot', label: 'tts.character.robot', voice: 'es-MX-ald', voiceEn: 'en-US-michael', speed: 1, pitch: 0, effect: 'robot' },
  { id: 'call', label: 'tts.character.call', voice: 'es-AR-daniela', voiceEn: 'en-US-heart', speed: 1, pitch: 0, effect: 'phone' },
  { id: 'whisper', label: 'tts.character.whisper', voice: 'es-ES-sharvard', voiceEn: 'en-US-heart', speed: 0.9, pitch: 0, effect: 'whisper' },
  { id: 'announcer', label: 'tts.character.announcer', voice: 'es-MX-claude', voiceEn: 'en-US-fenrir', speed: 1, pitch: -1, effect: 'stadium' },
];

/** The styles, in the order the panel shows them. */
export const VOICE_EFFECTS: ReadonlyArray<{ id: TtsEffect; label: MessageKey }> = [
  { id: 'none', label: 'tts.effect.none' },
  { id: 'warm', label: 'tts.effect.warm' },
  { id: 'radio', label: 'tts.effect.radio' },
  { id: 'phone', label: 'tts.effect.phone' },
  { id: 'megaphone', label: 'tts.effect.megaphone' },
  { id: 'robot', label: 'tts.effect.robot' },
  { id: 'whisper', label: 'tts.effect.whisper' },
  { id: 'cave', label: 'tts.effect.cave' },
  { id: 'stadium', label: 'tts.effect.stadium' },
];
