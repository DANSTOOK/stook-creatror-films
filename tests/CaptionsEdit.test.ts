import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptionWord, Clip } from '@shared/types';
import { captionIssues, fixTiming, hasIssues, isWeak, reflowText, rulesFor, wordsToCues, type TimedCaption } from '@renderer/captions/rules';
import { findInCaptions, replaceInText } from '@renderer/captions/findReplace';
import { lookOf, normalizeLook, presetLook } from '@renderer/captions/look';
import { captionStyle, withCaptionTitles } from '@renderer/captions/captionRender';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { normalizeProject } from '@renderer/store/types';

/**
 * Captions, phase 2, without a GPU: lines laid out again as the text is
 * typed, joining and parting captions with their word times intact, find and
 * replace, the warnings and the timing fix, and a track's look.
 */

const classic = rulesFor('classic');
const store = () => useProjectStore.getState();
const row = (): Clip[] =>
  Object.values(store().project.clips)
    .filter((clip) => clip.caption)
    .sort((a, b) => a.startFrame - b.startFrame);
const texts = (): string[] => row().map((clip) => clip.caption?.text ?? '');

/** Words spoken evenly from `start`, 0.3 s each with 0.05 s between. */
function speak(text: string, start: number): CaptionWord[] {
  return text.split(' ').map((word, index) => ({ text: word, start: start + index * 0.35, end: start + index * 0.35 + 0.3 }));
}

describe('lines laid out again as the text changes', () => {
  it('keeps on one line what fits, and breaks the rest where the rules would', () => {
    expect(reflowText('El color también importa.', classic, 'es')).toBe('El color también importa.');
    expect(reflowText('La imagen tiembla mucho, pero se puede corregir durante la edición.', classic, 'es')).toBe(
      'La imagen tiembla mucho,\npero se puede corregir durante la edición.',
    );
  });

  it('moves the break as words are typed, and leaves no line ending on an article or preposition while another break fits', () => {
    const sentence = 'Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara y su mercado';
    const words = sentence.split(' ');
    let typed = '';
    for (const word of words) {
      // What a textarea holds after a keystroke: the old text, breaks and all, plus the new word.
      typed = reflowText(typed === '' ? word : `${typed} ${word}`, classic, 'es');
      const lines = typed.split('\n');
      expect(typed.replace(/\n/g, ' ')).toBe(words.slice(0, words.indexOf(word) + 1).join(' '));
      if (lines.length === 2) {
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
        // Is there a break that fits both lines and does not end the first on a weak word?
        const all = typed.replace(/\n/g, ' ').split(' ');
        const better = all.some((last, index) => index < all.length - 1 && !isWeak(last, 'es') && all.slice(0, index + 1).join(' ').length <= 42 && all.slice(index + 1).join(' ').length <= 42);
        // Two lines with a poor break are still better than three.
        if (better) expect(isWeak(lines[0].split(' ').pop() as string, 'es'), typed).toBe(false);
      }
    }
    expect(typed.split('\n')).toHaveLength(2);
  });

  it('changes only the spaces between words, so the caret stays put and a trailing space is not eaten', () => {
    const before = 'La imagen tiembla mucho, pero se puede corregir durante la edición. ';
    const after = reflowText(before, classic, 'es');
    expect(after).toHaveLength(before.length);
    expect(after.endsWith(' ')).toBe(true);
    expect(after.replace(/\n/g, ' ')).toBe(before);
    expect(reflowText('', classic, 'es')).toBe('');
    expect(reflowText('  ', classic, 'es')).toBe('  ');
  });

  it('goes to more than two lines only when two cannot hold it - and that is then a warning', () => {
    const long = 'Primero importamos los clips, después los ordenamos en la línea de tiempo y, por último, añadimos la música y los títulos.';
    const lines = reflowText(long, classic, 'es').split('\n');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
    expect(captionIssues(lines.join('\n'), 6, classic).tooManyLines).toBe(true);
  });
});

describe('warnings', () => {
  it('says what is wrong with a caption, and nothing when nothing is', () => {
    expect(hasIssues(captionIssues('Hola a todos.', 2, classic))).toBe(false);
    // 34 characters in one second: 34 a second, twice what can be read.
    expect(captionIssues('Hoy vamos a editar un vídeo corto.', 1, classic)).toMatchObject({ tooFast: true, tooShort: false });
    expect(captionIssues('Sí.', 0.5, classic)).toMatchObject({ tooShort: true, tooFast: false });
    expect(captionIssues('Hola a todos.', 7.5, classic)).toMatchObject({ tooLong: true });
    expect(captionIssues('uno\ndos\ntres', 3, classic)).toMatchObject({ tooManyLines: true });
    expect(captionIssues('x'.repeat(43), 5, classic)).toMatchObject({ lineTooLong: true });
    // The one-line style counts a second line as one too many.
    expect(captionIssues('uno\ndos', 3, rulesFor('social'))).toMatchObject({ tooManyLines: true });
    // Exactly at the limits is within them.
    expect(hasIssues(captionIssues('x'.repeat(34), 2, classic))).toBe(false);
    expect(hasIssues(captionIssues('Sí.', 5 / 6, classic))).toBe(false);
    expect(hasIssues(captionIssues('', 0.1, classic))).toBe(false);
  });

  it('what the rules generate carries no warning but speech that is itself too fast', () => {
    const cues = wordsToCues(speak('Buenos días a todos. Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara, desde el mercado hasta la catedral.', 0), classic, 'es', 30);
    for (const cue of cues) {
      const issues = captionIssues(cue.lines.join('\n'), cue.end - cue.start, classic);
      expect({ ...issues, tooFast: false }, cue.lines.join(' / ')).toEqual({ tooFast: false, tooShort: false, tooLong: false, tooManyLines: false, lineTooLong: false });
    }
  });
});

describe('the timing fix', () => {
  const caption = (id: string, startFrame: number, endFrame: number, text = 'Hola a todos.'): TimedCaption => ({ id, startFrame, endFrame, text });

  it('keeps a caption up longer when it is too short or too fast, into free time only', () => {
    const fixed = fixTiming(
      [
        caption('short', 0, 10), // a third of a second, alone: to the 25-frame minimum
        caption('fast', 300, 330, 'Una frase bastante larga para un segundo.'), // 41 characters: 73 frames at 17 a second
        caption('hemmed', 600, 610, 'Una frase bastante larga para un segundo.'), // the next one is 20 frames on
        caption('next', 630, 700),
      ],
      classic,
      30,
    );
    expect(fixed.get('short')).toBe(25);
    expect(fixed.get('fast')).toBe(300 + 73);
    // As far as 2 frames before the next, and no further.
    expect(fixed.get('hemmed')).toBe(628);
    expect(fixed.has('next')).toBe(false);
  });

  it('never moves a start, never shortens what is fine, never passes seven seconds', () => {
    const fine = [caption('a', 0, 60), caption('b', 90, 150), caption('c', 200, 400, 'x'.repeat(84))];
    const fixed = fixTiming(fine, classic, 30);
    expect(fixed.has('a')).toBe(false);
    expect(fixed.has('b')).toBe(false);
    // 84 characters want 149 frames and have 200: left alone.
    expect(fixed.has('c')).toBe(false);
    const crowded = fixTiming([caption('long', 0, 100, 'x'.repeat(200))], classic, 30);
    expect(crowded.get('long')).toBe(210);
  });

  it('puts the gaps right: 2 frames where captions touch or run into each other, and where the gap is under half a second', () => {
    const fixed = fixTiming([caption('touching', 0, 60), caption('b', 60, 120), caption('over', 150, 200), caption('d', 190, 260), caption('near', 300, 360), caption('f', 368, 430), caption('far', 500, 560), caption('h', 580, 640)], classic, 30);
    expect(fixed.get('touching')).toBe(58);
    expect(fixed.get('over')).toBe(188);
    // 8 frames apart: chained to 2.
    expect(fixed.get('near')).toBe(366);
    // 20 frames is half a second or more: left.
    expect(fixed.has('far')).toBe(false);
    expect(fixed.has('h')).toBe(false);
  });

  it('through the store it is one undo step, and says how many it changed', () => {
    store().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
    const trackId = store().addCaptionTrack(
      { subtitles: [{ startMs: 0, endMs: 300, text: 'Sí.' }, { startMs: 5000, endMs: 6000, text: 'Una frase bastante larga para un segundo.' }, { startMs: 9000, endMs: 12000, text: 'Bien.' }] },
      { preset: 'classic', language: 'es' },
    );
    const depth = useHistoryStore.getState().undoStack.length;
    expect(store().fixCaptionTiming(trackId)).toBe(2);
    expect(row().map((clip) => [clip.startFrame, clip.startFrame + clip.durationFrames])).toEqual([[0, 25], [150, 223], [270, 360]]);
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 1);
    expect(store().fixCaptionTiming(trackId)).toBe(0);
    store().undo();
    expect(row().map((clip) => clip.durationFrames)).toEqual([9, 30, 90]);
    // One caption only, when asked.
    expect(store().fixCaptionTiming(trackId, [row()[0].id])).toBe(1);
    expect(row().map((clip) => clip.durationFrames)).toEqual([25, 30, 90]);
  });
});

describe('joining and parting captions', () => {
  beforeEach(() => {
    store().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
    const cues = [
      { start: 1, end: 3.2, lines: ['Hoy vamos a editar'], words: speak('Hoy vamos a editar', 1) },
      { start: 3.4, end: 5.5, lines: ['un vídeo corto.'], words: speak('un vídeo corto.', 3.4) },
      { start: 8, end: 9, lines: ['Y ya está.'], words: speak('Y ya está.', 8) },
    ];
    store().addCaptionTrack({ cues, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
  });

  /** When each word is spoken, in timeline frames, whatever caption it is in. */
  const spoken = (): Array<[string, number]> =>
    row().flatMap((clip) => (clip.caption?.words ?? []).map((word): [string, number] => [word.text, Math.round(clip.startFrame + word.start * 30 - clip.sourceOffsetFrames)]));

  it('merge with the next: one caption from the start of the first to the end of the second, text laid out again', () => {
    const before = spoken();
    const [first, second] = row();
    const depth = useHistoryStore.getState().undoStack.length;
    expect(store().mergeCaptions(first.id, 'next')).toBe(first.id);
    expect(texts()).toEqual(['Hoy vamos a editar un vídeo corto.', 'Y ya está.']);
    expect(row()[0]).toMatchObject({ id: first.id, startFrame: 30, durationFrames: 165 - 30, name: 'Hoy vamos a editar un vídeo corto.' });
    expect(store().project.clips[second.id]).toBeUndefined();
    // Every word is spoken on the frame it was spoken on before.
    expect(spoken()).toEqual(before);
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 1);
    expect(store().ui.selectedClipIds).toEqual([first.id]);
    store().undo();
    expect(texts()).toEqual(['Hoy vamos a editar', 'un vídeo corto.', 'Y ya está.']);
    expect(spoken()).toEqual(before);
  });

  it('merge with the previous is the same join, asked from the second', () => {
    const [first, second] = row();
    expect(store().mergeCaptions(second.id, 'previous')).toBe(first.id);
    expect(texts()).toEqual(['Hoy vamos a editar un vídeo corto.', 'Y ya está.']);
    // Nothing before the first, nothing after the last.
    expect(store().mergeCaptions(first.id, 'previous')).toBeNull();
    expect(store().mergeCaptions(row()[1].id, 'next')).toBeNull();
  });

  it('merged and cut again where they were joined, they are the two they were', () => {
    const before = spoken();
    const [first, second] = row();
    const joint = second.startFrame;
    store().mergeCaptions(first.id, 'next');
    store().razorAtFrame(joint - 2, [first.id]);
    expect(texts()).toEqual(['Hoy vamos a editar', 'un vídeo corto.', 'Y ya está.']);
    expect(spoken()).toEqual(before);
  });

  it('a long join breaks into two lines by the rules; captions with their author\'s breaks keep their lines', () => {
    const [first, , third] = row();
    store().mergeCaptions(first.id, 'next');
    store().mergeCaptions(first.id, 'next');
    expect(texts()).toEqual(['Hoy vamos a editar\nun vídeo corto. Y ya está.']);
    store().undo();
    store().undo();
    store().setCaptionText(third.id, 'Y ya\nestá.', undefined, true);
    store().mergeCaptions(row()[1].id, 'next');
    expect(texts()[1]).toBe('un vídeo corto.\nY ya\nestá.');
    expect(row()[1].caption?.manualBreaks).toBe(true);
  });

  it('split at the playhead is the razor: between two words, one undo step', () => {
    const [first] = row();
    const words = first.caption?.words ?? [];
    // Word times are counted from the caption's own start.
    const frame = first.startFrame + Math.round(((words[1].end + words[2].start) / 2) * 30);
    store().setCurrentFrame(frame);
    const depth = useHistoryStore.getState().undoStack.length;
    store().razorAtFrame(undefined, [first.id]);
    expect(texts().slice(0, 2)).toEqual(['Hoy vamos', 'a editar']);
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 1);
  });
});

describe('typing in a caption', () => {
  beforeEach(() => {
    store().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
    store().addCaptionTrack({ cues: [{ start: 1, end: 5, lines: ['Hola.'], words: speak('Hola.', 1) }], offsetFrame: 0 }, { preset: 'classic', language: 'es' });
  });

  it('lays the lines out again as it grows, in one undo step', () => {
    const [clip] = row();
    const depth = useHistoryStore.getState().undoStack.length;
    let typed = '';
    for (const character of 'La imagen tiembla mucho, pero se puede corregir durante la edición.') {
      typed = `${store().project.clips[clip.id].caption?.text === 'Hola.' ? '' : store().project.clips[clip.id].caption?.text}${character}`;
      store().setCaptionText(clip.id, typed, `caption:${clip.id}:text`);
    }
    expect(texts()).toEqual(['La imagen tiembla mucho,\npero se puede corregir durante la edición.']);
    expect(row()[0].name).toBe('La imagen tiembla mucho, pero se puede corregir durante la edición.');
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 1);
    store().undo();
    expect(texts()).toEqual(['Hola.']);
  });

  it('Enter makes the breaks the author\'s, and they are then left alone; automatic can be asked for again', () => {
    const [clip] = row();
    store().setCaptionText(clip.id, 'La imagen\ntiembla mucho, pero se puede corregir durante la edición.', undefined, true);
    expect(row()[0].caption).toMatchObject({ text: 'La imagen\ntiembla mucho, pero se puede corregir durante la edición.', manualBreaks: true });
    // More typing does not move the break.
    store().setCaptionText(clip.id, 'La imagen\ntiembla mucho, pero se puede corregir durante la edición. Sí.');
    expect(texts()[0].startsWith('La imagen\ntiembla')).toBe(true);
    store().setCaptionBreaks(clip.id, false);
    expect(row()[0].caption?.manualBreaks).toBeUndefined();
    expect(texts()[0].split('\n')[0]).not.toBe('La imagen');
    for (const line of texts()[0].split('\n')) expect(line.length).toBeLessThanOrEqual(42);
  });
});

describe('find and replace', () => {
  const list = [
    { id: 'a', text: 'Hoy vamos a editar un video corto' },
    { id: 'b', text: 'El video se exporta\ny el Video se comparte.' },
    { id: 'c', text: 'Nada que ver.' },
    { id: 'd', text: 'frases cortas, de no más\nde dos líneas' },
  ];

  it('counts every match, whatever its case, caption by caption', () => {
    const matches = findInCaptions(list, 'video');
    expect(matches.map((match) => [match.clipId, match.occurrence, match.index])).toEqual([['a', 0, 22], ['b', 0, 3], ['b', 1, 25]]);
    expect(findInCaptions(list, 'video', { matchCase: true })).toHaveLength(2);
    expect(findInCaptions(list, 'Video', { matchCase: true })).toHaveLength(1);
    expect(findInCaptions(list, '')).toEqual([]);
    expect(findInCaptions(list, '   ')).toEqual([]);
  });

  it('finds a phrase across a line break, and treats what is typed as text, not as a pattern', () => {
    expect(findInCaptions(list, 'no más de dos')).toEqual([{ clipId: 'd', occurrence: 0, index: 18, length: 13 }]);
    expect(findInCaptions([{ id: 'x', text: 'cuesta $5 (más o menos)' }], '$5 (más')).toHaveLength(1);
    expect(findInCaptions([{ id: 'x', text: 'a.b' }], '.')).toHaveLength(1);
    // An accent is a different letter.
    expect(findInCaptions([{ id: 'x', text: 'sí, si quieres' }], 'si')).toHaveLength(1);
  });

  it('replaces all, or just the one asked for, and counts them', () => {
    expect(replaceInText(list[1].text, 'video', 'vídeo')).toEqual({ text: 'El vídeo se exporta\ny el vídeo se comparte.', count: 2 });
    expect(replaceInText(list[1].text, 'video', 'vídeo', { occurrence: 1 })).toEqual({ text: 'El video se exporta\ny el vídeo se comparte.', count: 1 });
    expect(replaceInText(list[1].text, 'video', 'vídeo', { matchCase: true })).toEqual({ text: 'El vídeo se exporta\ny el Video se comparte.', count: 1 });
    expect(replaceInText('precio', 'precio', '$1 y $&')).toEqual({ text: '$1 y $&', count: 1 });
    expect(replaceInText('nada', 'x', 'y')).toEqual({ text: 'nada', count: 0 });
  });

  it('through the store: replace all is one undo step, lays the lines out again, and leaves other tracks alone', () => {
    store().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
    const cue = (start: number, text: string) => ({ start, end: start + 3, lines: text.split('\n'), words: [] as CaptionWord[] });
    const trackId = store().addCaptionTrack(
      { cues: [cue(0, 'Hoy vamos a editar un video corto'), cue(5, 'El video se exporta\ny el Video se comparte.'), cue(10, 'Nada que ver.')], offsetFrame: 0 },
      { preset: 'classic', language: 'es' },
    );
    const other = store().addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 1000, text: 'otro video' }] }, { preset: 'classic', language: 'es' });
    const depth = useHistoryStore.getState().undoStack.length;
    expect(store().replaceInCaptions(trackId, 'video', 'vídeo de la ciudad')).toBe(3);
    const mine = row().filter((clip) => clip.trackId === trackId).map((clip) => clip.caption?.text);
    expect(mine).toEqual(['Hoy vamos a editar\nun vídeo de la ciudad corto', 'El vídeo de la ciudad se exporta\ny el vídeo de la ciudad se comparte.', 'Nada que ver.']);
    expect(row().find((clip) => clip.trackId === other)?.caption?.text).toBe('otro video');
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 1);
    store().undo();
    expect(row().filter((clip) => clip.trackId === trackId)[1].caption?.text).toBe('El video se exporta\ny el Video se comparte.');
    // One match only.
    const second = row().filter((clip) => clip.trackId === trackId)[1];
    expect(store().replaceInCaptions(trackId, 'video', 'vídeo', { only: { clipId: second.id, occurrence: 1 } })).toBe(1);
    expect(store().project.clips[second.id].caption?.text).toBe('El video se exporta\ny el vídeo se comparte.');
    expect(store().replaceInCaptions(trackId, 'no está', 'x')).toBe(0);
  });
});

describe('a track\'s look', () => {
  beforeEach(() => {
    store().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
  });

  it('starts as its preset\'s, and is the same picture phase 1 drew', () => {
    expect(presetLook('classic')).toMatchObject({ fontFamily: 'Inter', fontWeight: 600, fontSize: null, color: '#ffffff', position: 'bottom', outline: { enabled: true, color: '#000000', width: 3 }, box: { enabled: false } });
    expect(captionStyle({ preset: 'classic', language: 'es' }, { width: 1920, height: 1080 })).toMatchObject({
      fontFamily: 'Inter', fontWeight: 600, fontSize: 46, color: '#ffffff', anchor: 'bottom', align: 'center',
      stroke: { enabled: true, color: '#000000', width: 3 }, shadow: { enabled: true }, box: { enabled: false },
    });
    expect(captionStyle({ preset: 'social', language: 'es' }, { width: 1920, height: 1080 })).toMatchObject({ fontWeight: 800, fontSize: 64, stroke: { width: 5 } });
  });

  it('a change applies to every caption on the track, in the picture, and is one undo step per kind of change', () => {
    const trackId = store().addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 2000, text: 'uno' }, { startMs: 3000, endMs: 5000, text: 'dos' }] }, { preset: 'classic', language: 'es' });
    const depth = useHistoryStore.getState().undoStack.length;
    store().setCaptionLook(trackId, { fontFamily: 'Oswald', fontSize: 60, color: '#ffe600', position: 'top' });
    store().setCaptionLook(trackId, { box: { enabled: true, color: '#101010', opacity: 0.8 }, outline: { enabled: false, color: '#000000', width: 3 } });
    const settings = store().project.tracks.find((track) => track.id === trackId)?.captions;
    expect(settings?.look).toMatchObject({ fontFamily: 'Oswald', fontSize: 60, color: '#ffe600', position: 'top', box: { enabled: true, opacity: 0.8 }, outline: { enabled: false } });
    const drawn = Object.values(withCaptionTitles(store().project).clips);
    for (const clip of drawn) {
      expect(clip.title?.style).toMatchObject({ fontFamily: 'Oswald', fontSize: 60, color: '#ffe600', anchor: 'top', box: { enabled: true, color: '#101010', opacity: 0.8 }, stroke: { enabled: false }, shadow: { enabled: false } });
    }
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 2);
    // Back to the preset's own.
    store().setCaptionLook(trackId, null);
    expect(store().project.tracks.find((track) => track.id === trackId)?.captions).toEqual({ preset: 'classic', language: 'es' });
  });

  it('a preset brings its rules and its look, and what was changed by hand goes', () => {
    const trackId = store().addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 2000, text: 'uno' }] }, { preset: 'classic', language: 'es' });
    store().setCaptionLook(trackId, { color: '#ff0000' });
    store().setCaptionPreset(trackId, 'social');
    const settings = store().project.tracks.find((track) => track.id === trackId)?.captions;
    expect(settings).toEqual({ preset: 'social', language: 'es' });
    expect(lookOf(settings as NonNullable<typeof settings>)).toEqual(presetLook('social'));
  });

  it('a look read from a file is made safe: sizes in range, colours that are colours', () => {
    expect(normalizeLook({ fontFamily: '  ', fontWeight: 5000, fontSize: 9999, color: 'red', position: 'middle', outline: { width: -4 }, box: { opacity: 7 } }, 'classic')).toEqual({
      fontFamily: 'Inter', fontWeight: 900, fontSize: 160, color: '#ffffff', position: 'bottom',
      outline: { enabled: true, color: '#000000', width: 0 }, box: { enabled: false, color: '#000000', opacity: 1 },
    });
    store().addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 2000, text: 'uno' }] }, { preset: 'classic', language: 'es' });
    const saved = JSON.parse(JSON.stringify(store().project));
    saved.tracks.find((track: { type: string }) => track.type === 'captions').captions.look = { color: '#ABCDEF', fontSize: 'big' };
    const opened = normalizeProject(saved);
    expect(opened.tracks.find((track) => track.type === 'captions')?.captions?.look).toMatchObject({ color: '#abcdef', fontSize: null, fontFamily: 'Inter' });
  });
});
