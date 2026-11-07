import type { TtsEffect } from '@shared/types/ipc';
import type { MessageKey } from '@shared/i18n';

/**
 * Characters: a voice, a pace, a pitch and a style in one click - the
 * documentary narrator, the radio host, the excited YouTuber, the storyteller,
 * a child, a monster, a robot - as CapCut's and Filmora's voice characters
 * offer them. Each is only a starting point: the voice, sliders and style it
 * sets stay free to change. Each names an Azure voice by its `ShortName`
 * (main/tts/azure/voices.ts), a Spanish one and, for a script in English, an
 * English one; a voice the person's key cannot speak falls back to one it can
 * (VoicePanel.pick), so a character always does something.
 *
 * The Spanish voices are chosen by region and by what the character is:
 * Mexico's Jorge and Dalia carry the narrator and the YouTuber, Argentina's
 * Elena the host and the child, Colombia's Salomé the news, and Spain's
 * Elvira and Álvaro the storyteller and the grandfather. Where an effect
 * covers the voice anyway - the monster's cave, the robot - the choice
 * matters least, so the same male voice does both.
 *
 * They used to be Piper's and Kokoro's voices, trained models that ran on
 * this computer. Those two engines are gone; these are the voices behind the
 * free text-to-speech pages, which is what was asked for.
 */

export interface VoiceCharacter {
  id: string;
  label: MessageKey;
  voice: string;
  /** The voice when the script is in English. */
  voiceEn?: string;
  speed: number;
  pitch: number;
  effect: TtsEffect;
}

export const VOICE_CHARACTERS: readonly VoiceCharacter[] = [
  { id: 'narrator', label: 'tts.character.narrator', voice: 'es-MX-JorgeNeural', voiceEn: 'en-US-AndrewMultilingualNeural', speed: 0.92, pitch: -1, effect: 'warm' },
  { id: 'host', label: 'tts.character.host', voice: 'es-AR-ElenaNeural', voiceEn: 'en-US-AvaMultilingualNeural', speed: 1, pitch: 0, effect: 'radio' },
  { id: 'youtuber', label: 'tts.character.youtuber', voice: 'es-MX-DaliaNeural', voiceEn: 'en-US-JennyNeural', speed: 1.15, pitch: 1, effect: 'none' },
  { id: 'news', label: 'tts.character.news', voice: 'es-CO-SalomeNeural', voiceEn: 'en-US-AriaNeural', speed: 1.05, pitch: 0, effect: 'radio' },
  { id: 'storyteller', label: 'tts.character.storyteller', voice: 'es-ES-ElviraNeural', voiceEn: 'en-GB-RyanNeural', speed: 0.88, pitch: 0.5, effect: 'warm' },
  { id: 'grandpa', label: 'tts.character.grandpa', voice: 'es-ES-AlvaroNeural', voiceEn: 'en-GB-RyanNeural', speed: 0.9, pitch: 0, effect: 'warm' },
  { id: 'child', label: 'tts.character.child', voice: 'es-AR-ElenaNeural', voiceEn: 'en-US-JennyNeural', speed: 1.05, pitch: 6, effect: 'none' },
  { id: 'monster', label: 'tts.character.monster', voice: 'es-MX-JorgeNeural', voiceEn: 'en-US-GuyNeural', speed: 0.9, pitch: -6, effect: 'cave' },
  { id: 'robot', label: 'tts.character.robot', voice: 'es-MX-JorgeNeural', voiceEn: 'en-US-GuyNeural', speed: 1, pitch: 0, effect: 'robot' },
  { id: 'call', label: 'tts.character.call', voice: 'es-AR-ElenaNeural', voiceEn: 'en-US-AvaMultilingualNeural', speed: 1, pitch: 0, effect: 'phone' },
  { id: 'whisper', label: 'tts.character.whisper', voice: 'es-ES-ElviraNeural', voiceEn: 'en-US-AvaMultilingualNeural', speed: 0.9, pitch: 0, effect: 'whisper' },
  { id: 'announcer', label: 'tts.character.announcer', voice: 'es-MX-JorgeNeural', voiceEn: 'en-US-GuyNeural', speed: 1, pitch: -1, effect: 'stadium' },
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
