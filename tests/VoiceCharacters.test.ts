import { describe, expect, it } from 'vitest';
import { SHORTLIST } from '@main/tts/azure/voices';
import { VOICE_CHARACTERS } from '@renderer/tts/characters';

/**
 * The voice characters: which voice each one speaks with.
 *
 * A character naming a voice that is not offered falls back to "any voice the
 * key can speak" (VoicePanel.pick), so a typo here is silent - the character
 * simply stops sounding like itself. These checks are the thing that makes it
 * loud.
 */

const byId = new Map(SHORTLIST.map((voice) => [voice.shortName, voice]));

describe('the voice characters', () => {
  it('names a voice the picker offers, for Spanish and for English', () => {
    for (const character of VOICE_CHARACTERS) {
      expect(byId.get(character.voice), `${character.id} (es)`).toBeDefined();
      expect(byId.get(character.voiceEn ?? ''), `${character.id} (en)`).toBeDefined();
    }
  });

  it('speaks Spanish with a Spanish voice and English with an English one', () => {
    for (const character of VOICE_CHARACTERS) {
      expect(byId.get(character.voice)?.locale.startsWith('es'), character.id).toBe(true);
      expect(byId.get(character.voiceEn ?? '')?.locale.startsWith('en'), character.id).toBe(true);
    }
  });

  it('asks for a pitch and a pace Azure accepts', () => {
    // The SSML builder clamps both, but a character outside the range would be
    // asking for something it will not get.
    for (const character of VOICE_CHARACTERS) {
      expect(character.speed, character.id).toBeGreaterThanOrEqual(0.5);
      expect(character.speed, character.id).toBeLessThanOrEqual(2);
      expect(Math.abs(character.pitch), character.id).toBeLessThanOrEqual(6);
    }
  });

  it('gives the deep characters a male voice and the bright ones a female one', () => {
    const male = ['narrator', 'grandpa', 'monster', 'robot', 'announcer'];
    const female = ['host', 'youtuber', 'news', 'child'];
    for (const id of male) {
      const character = VOICE_CHARACTERS.find((candidate) => candidate.id === id);
      expect(byId.get(character!.voice)?.sex, id).toBe('male');
    }
    for (const id of female) {
      const character = VOICE_CHARACTERS.find((candidate) => candidate.id === id);
      expect(byId.get(character!.voice)?.sex, id).toBe('female');
    }
  });
});
