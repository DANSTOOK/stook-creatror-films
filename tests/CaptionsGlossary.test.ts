import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip } from '@shared/types';
import { editDistance, glossaryPrompt, glossarySuggestions, normalizeGlossary, MAX_PROMPT_LENGTH } from '@renderer/captions/glossary';
import { replaceInText } from '@renderer/captions/findReplace';
import { cleanPrompt, whisperCommand } from '../src/main/subtitles/engine';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';

/**
 * The glossary: names and terms a project says. Given to Whisper as its
 * prompt, and looked for, one letter off, in what it wrote.
 */

const caption = (id: string, text: string): Pick<Clip, 'id' | 'caption'> => ({ id, caption: { text } });

describe('the glossary', () => {
  it('takes terms one a line or separated by commas, tidied, without repeats', () => {
    expect(normalizeGlossary('Stook\n  Zorbelia ,Kratonix;stook\n\n')).toEqual(['Stook', 'Zorbelia', 'Kratonix']);
    expect(normalizeGlossary(['  Mirelda   Quintavares ', '', 42, 'Mirelda Quintavares'])).toEqual(['Mirelda Quintavares']);
    expect(normalizeGlossary(null)).toEqual([]);
  });

  it('becomes a prompt that lists the terms, and stays inside what Whisper reads', () => {
    expect(glossaryPrompt(['Stook', 'Zorbelia'])).toBe('Stook, Zorbelia.');
    expect(glossaryPrompt([])).toBe('');
    const many = Array.from({ length: 100 }, (_, i) => `Nombre${i}Largo`);
    expect(glossaryPrompt(many).length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH);
  });

  it('reaches whisper-cli as one argument, on one line', () => {
    const run = { model: 'm.bin', dtw: 'small', audio: 'a.wav', output: 'o', language: 'es' as const, threads: 4, gpu: null, vadModel: null };
    expect(whisperCommand(run).args).not.toContain('--prompt');
    const { args } = whisperCommand({ ...run, prompt: 'Stook, Zorbelia.' });
    expect(args[args.indexOf('--prompt') + 1]).toBe('Stook, Zorbelia.');
    expect(cleanPrompt('Stook\n--model x\u0000 "y"')).toBe('Stook --model x "y"');
  });

  it('counts edits: one letter changed, put in, taken out or two swapped', () => {
    expect(editDistance('stook', 'stuk', 2)).toBe(2);
    expect(editDistance('stook', 'stok')).toBe(1);
    expect(editDistance('zorbelia', 'zorbelia')).toBe(0);
    expect(editDistance('kratonix', 'kratnoix')).toBe(1);
    expect(editDistance('kratonix', 'cratonis', 1)).toBe(2);
  });
});

describe('suggestions from the glossary', () => {
  const terms = ['Zorbelia', 'Kratonix', 'Mirelda Quintavares', 'Mara', 'Ana'];

  it('finds a term written one letter off, or with other case or accents, and counts it', () => {
    const found = glossarySuggestions(
      [
        caption('a', 'Hoy viajamos a Zorbelía con Kratonis.'),
        caption('b', 'En Zorbelía hace calor,\ny Kratonis lo sabe.'),
        caption('c', 'Mirelda Quintavarez nos espera.'),
      ],
      terms,
    );
    expect(found).toEqual([
      { term: 'Kratonix', found: 'Kratonis', count: 2, clipIds: ['a', 'b'] },
      { term: 'Zorbelia', found: 'Zorbelía', count: 2, clipIds: ['a', 'b'] },
      { term: 'Mirelda Quintavares', found: 'Mirelda Quintavarez', count: 1, clipIds: ['c'] },
    ]);
  });

  it('leaves alone what is already right, short terms, ordinary words in small letters, and words further off', () => {
    expect(glossarySuggestions([caption('a', 'Zorbelia, Kratonix. Una para todos: Anabel y Krotanox.')], terms)).toEqual([]);
  });

  it('a suggestion taken replaces whole words only, in one undo step', () => {
    expect(replaceInText('Kratonis y Kratonista', 'Kratonis', 'Kratonix', { matchCase: true, wholeWord: true })).toEqual({ text: 'Kratonix y Kratonista', count: 1 });
  });
});

describe('the glossary in the project', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
  });

  it('is kept with the project, tidied, and undone in one step', () => {
    useProjectStore.getState().setGlossary(['Stook', ' Zorbelia ', 'stook']);
    expect(useProjectStore.getState().project.glossary).toEqual(['Stook', 'Zorbelia']);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.glossary).toBeUndefined();
  });
});
