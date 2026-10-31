import { describe, expect, it } from 'vitest';
import { ALL_VOICES, voiceById } from '@main/tts/catalog';
import { VOICE_CHARACTERS } from '@renderer/tts/characters';

/**
 * The voice characters: which voice each one speaks with.
 *
 * A character naming a voice that does not exist falls back to "any voice
 * present", so a typo here is silent - the character simply stops sounding like
 * itself. These checks are the thing that makes it loud.
 */

describe('the voice characters', () => {
  it('names a voice that exists, for Spanish and for English', () => {
    for (const character of VOICE_CHARACTERS) {
      expect(voiceById(character.voice), `${character.id} (es)`).toBeDefined();
      expect(voiceById(character.voiceEn), `${character.id} (en)`).toBeDefined();
    }
  });

  it('speaks Spanish with a voice trained on Spanish alone, never Kokoro’s', () => {
    // Kokoro is one model for eight languages; its Spanish carries the accent of
    // a model that is mostly English. Every Spanish character uses Piper.
    for (const character of VOICE_CHARACTERS) {
      const voice = voiceById(character.voice);
      expect(voice?.language, character.id).toBe('es');
      expect(voice?.engine, character.id).toBe('piper');
    }
  });

  it('spends the two high-quality voices where the voice is heard clean', () => {
    const high = new Set(['es-MX-claude', 'es-AR-daniela']);
    // An effect that rebuilds the voice - the robot, the monster's cave - hides
    // whatever quality went in, so those get a medium voice instead.
    for (const character of VOICE_CHARACTERS) {
      if (character.effect === 'robot' || character.effect === 'cave') {
        expect(high.has(character.voice), character.id).toBe(false);
      }
    }
    // And the plain-spoken ones do get them.
    for (const id of ['narrator', 'host', 'news', 'announcer']) {
      const character = VOICE_CHARACTERS.find((candidate) => candidate.id === id);
      expect(high.has(character!.voice), id).toBe(true);
    }
  });

  it('keeps Kokoro’s Spanish voices in the list to pick by hand', () => {
    // Demoted from the characters, not removed: they are still a choice.
    expect(ALL_VOICES.some((voice) => voice.language === 'es' && voice.engine === 'kokoro')).toBe(true);
  });
});
