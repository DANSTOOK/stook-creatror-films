import { describe, expect, it } from 'vitest';
import { insertMark, MAX_PAUSE, MIN_PAUSE, parseScript, pauseMark, pauseMarks, pauseSeconds, previewScript, scriptWords } from '@shared/tts/script';

/**
 * Pauses written into a text-to-speech script (shared/tts/script): what is
 * read as a pause, what is spoken, and the mark the Pause button writes.
 */

describe('parseScript', () => {
  it('reads the marks the Pause button writes, in both languages, and SSML breaks', () => {
    expect(parseScript('Hola. [pausa 1s] Adiós.')).toEqual([
      { kind: 'speech', text: 'Hola.' },
      { kind: 'pause', seconds: 1 },
      { kind: 'speech', text: 'Adiós.' },
    ]);
    expect(parseScript('One [pause 1.5s] two')[1]).toEqual({ kind: 'pause', seconds: 1.5 });
    expect(parseScript('Uno [pausa 0,5 s] dos')[1]).toEqual({ kind: 'pause', seconds: 0.5 });
    expect(parseScript('Uno [Pausa: 2 segundos] dos')[1]).toEqual({ kind: 'pause', seconds: 2 });
    expect(parseScript('Uno [pausa 750ms] dos')[1]).toEqual({ kind: 'pause', seconds: 0.75 });
    expect(parseScript('One <break time="2s"/> two')[1]).toEqual({ kind: 'pause', seconds: 2 });
    expect(parseScript("One <break time='500ms' /> two")[1]).toEqual({ kind: 'pause', seconds: 0.5 });
  });

  it('a pause at the start or the end is kept; pauses side by side are one', () => {
    expect(parseScript('[pausa 2s] Hola [pausa 1s][pausa 1,5s]')).toEqual([
      { kind: 'pause', seconds: 2 },
      { kind: 'speech', text: 'Hola' },
      { kind: 'pause', seconds: 2.5 },
    ]);
  });

  it('each mark is held to its range; anything that is not a mark is spoken as written', () => {
    expect(parseScript('a [pausa 99s] b')[1]).toEqual({ kind: 'pause', seconds: MAX_PAUSE });
    expect(parseScript('a [pausa 0s] b')[1]).toEqual({ kind: 'pause', seconds: MIN_PAUSE });
    // Brackets that are not a pause stay words.
    expect(parseScript('El [capítulo 2] empieza')).toEqual([{ kind: 'speech', text: 'El [capítulo 2] empieza' }]);
    expect(parseScript('')).toEqual([]);
  });

  it('keeps the line breaks of the speech, tidies its spaces', () => {
    expect(parseScript('Primera línea.  \n  Segunda   línea.')).toEqual([{ kind: 'speech', text: 'Primera línea.\nSegunda línea.' }]);
  });
});

describe('the words, the pauses and the marks', () => {
  it('scriptWords takes the marks out; pauseSeconds adds them up', () => {
    const script = 'Hola [pausa 1s] a todos. <break time="500ms"/> Empezamos.';
    expect(scriptWords(script)).toBe('Hola a todos. Empezamos.');
    expect(pauseSeconds(script)).toBe(1.5);
  });

  it('pauseMark writes the language’s word and decimal sign', () => {
    expect(pauseMark(1.5, 'es')).toBe('[pausa 1,5s]');
    expect(pauseMark(1.5, 'en')).toBe('[pause 1.5s]');
    expect(pauseMark(2, 'es')).toBe('[pausa 2s]');
    expect(parseScript(`a ${pauseMark(1.5, 'es')} b`)[1]).toEqual({ kind: 'pause', seconds: 1.5 });
  });

  it('pauseMarks finds where each mark is, to draw it', () => {
    const script = 'Hola [pausa 1s] y [pause 2s]';
    const marks = pauseMarks(script);
    expect(marks.map((mark) => script.slice(mark.start, mark.end))).toEqual(['[pausa 1s]', '[pause 2s]']);
    expect(marks.map((mark) => mark.seconds)).toEqual([1, 2]);
  });

  it('insertMark puts the mark at the caret, spaced from the words, and the caret past the space after it', () => {
    expect(insertMark('HolaAdiós', 4, 4, '[pausa 1s]')).toEqual({ text: 'Hola [pausa 1s] Adiós', caret: 16 });
    // At the end, a space is left after it to type on from.
    expect(insertMark('Hola ', 5, 5, '[pausa 1s]')).toEqual({ text: 'Hola [pausa 1s] ', caret: 16 });
    expect(insertMark('', 0, 0, '[pausa 1s]')).toEqual({ text: '[pausa 1s] ', caret: 11 });
    // A space already there is used, not doubled; over a selection, the selection goes.
    expect(insertMark('Hola a todos. Empezamos.', 13, 13, '[pausa 2s]')).toEqual({ text: 'Hola a todos. [pausa 2s] Empezamos.', caret: 25 });
    expect(insertMark('Hola XXX adiós', 5, 8, '[pausa 2s]')).toEqual({ text: 'Hola [pausa 2s] adiós', caret: 16 });
  });
});

describe('previewScript', () => {
  it('the first words for a quick listen, cut between words, its pauses kept but short, none at the ends', () => {
    expect(previewScript('[pausa 3s] Hola a todos. [pausa 5s] Empezamos el vídeo de hoy con algo nuevo. [pausa 1s]', 40)).toBe('Hola a todos. [pause 2s] Empezamos el vídeo de hoy');
    expect(previewScript('Una frase corta.', 200)).toBe('Una frase corta.');
    expect(previewScript('', 200)).toBe('');
  });
});
