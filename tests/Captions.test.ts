import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptionWord, Clip } from '@shared/types';
import { breakLines, checkCue, isWeak, readingSpeed, rulesFor, timeCues, wordsToCues, type Cue } from '@renderer/captions/rules';
import { captionCues, cuesToClips, splitCaption, subtitleCuesToClips, textMatchesWords } from '@renderer/captions/captionClips';
import { captionStyle, withCaptionTitles, withoutCaptions } from '@renderer/captions/captionRender';
import { parseSubtitles, writeSrt } from '@renderer/captions/subtitleFiles';
import { insertionRow, timelineRows, trackAccepts } from '@renderer/components/Timeline/trackRows';
import { planTitlePlacement } from '@renderer/text/titleClip';
import { splitClip } from '@renderer/components/Timeline/timelineOps';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { normalizeProject } from '@renderer/store/types';

/**
 * Captions, phase 1: the rules, the clips and the files, without a GPU or a
 * speech model. The real thing - a recording transcribed in the running app
 * - is tests/ui/captions.mjs.
 */

/** Words spoken evenly, 0.07 s a letter with a short gap, a pause after each sentence. */
function speak(text: string, startAt = 0): CaptionWord[] {
  const words: CaptionWord[] = [];
  let at = startAt;
  for (const word of text.split(/\s+/)) {
    const length = Math.max(0.12, word.replace(/[^\p{L}\p{N}]/gu, '').length * 0.07);
    words.push({ text: word, start: Math.round(at * 1000) / 1000, end: Math.round((at + length) * 1000) / 1000 });
    at += length + 0.04 + (/[.?!]$/.test(word) ? 0.8 : /,$/.test(word) ? 0.25 : 0);
  }
  return words;
}

const SPEECH =
  'Buenos días a todos. Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara, desde el mercado hasta la catedral. ' +
  '¿Alguna vez has intentado grabar con el teléfono mientras caminas? La imagen tiembla mucho, pero se puede corregir durante la edición. ' +
  'Primero importamos los clips, después los ordenamos en la línea de tiempo y, por último, añadimos la música y los títulos. ' +
  'Una toma un poco oscura mejora bastante si subimos la exposición y bajamos las sombras con cuidado. ¡Qué bonito quedó el atardecer!';

describe('caption rules', () => {
  const classic = rulesFor('classic');

  it('has the Netflix Spanish numbers', () => {
    expect(classic).toMatchObject({ maxCharsPerLine: 42, maxLines: 2, maxCps: 17, maxSeconds: 7, gapFrames: 2 });
    expect(classic.minSeconds).toBeCloseTo(5 / 6);
    expect(rulesFor('social')).toMatchObject({ maxLines: 1, maxCharsPerLine: 28 });
    // A tall frame has less room across.
    expect(rulesFor('classic', { width: 1080, height: 1920 }).maxCharsPerLine).toBe(32);
    expect(rulesFor('social', { width: 1080, height: 1920 }).maxCharsPerLine).toBe(22);
  });

  it('keeps on one line what fits on one', () => {
    expect(breakLines('El color también importa.'.split(' '), classic, 'es')).toEqual(['El color también importa.']);
  });

  it('breaks after punctuation when it can', () => {
    expect(breakLines('La imagen tiembla mucho, pero se puede corregir durante la edición.'.split(' '), classic, 'es')).toEqual([
      'La imagen tiembla mucho,',
      'pero se puede corregir durante la edición.',
    ]);
  });

  it('never leaves an article, preposition or conjunction at the end of a line', () => {
    const cases = [
      'Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara,',
      'Las nubes naranjas y el cielo morado hacen que la escena parezca',
      'cruzó tres puentes y llegó a la costa justo antes de que empezara',
      'y toda la familia se reunía en su cocina a conversar hasta tarde',
    ];
    for (const text of cases) {
      const lines = breakLines(text.split(' '), classic, 'es');
      expect(lines, text).not.toBeNull();
      expect(lines).toHaveLength(2);
      const last = (lines as string[])[0].split(' ').pop() as string;
      expect(isWeak(last, 'es'), `"${(lines as string[])[0]}" ends on "${last}"`).toBe(false);
      for (const line of lines as string[]) expect(line.length).toBeLessThanOrEqual(42);
    }
    // The same in English.
    const english = breakLines('We walked along the river and then we stopped at the old bridge'.split(' '), classic, 'en') as string[];
    expect(isWeak(english[0].split(' ').pop() as string, 'en')).toBe(false);
  });

  it('knows a weak word, and that punctuation after it frees the break', () => {
    expect(isWeak('la', 'es')).toBe(true);
    expect(isWeak('De', 'es')).toBe(true);
    expect(isWeak('y,', 'es')).toBe(false);
    expect(isWeak('catedral', 'es')).toBe(false);
    expect(isWeak('the', 'en')).toBe(true);
    expect(isWeak('la', 'en')).toBe(false);
  });

  it('says when words do not fit in the lines allowed', () => {
    expect(breakLines(SPEECH.split(' ').slice(0, 30), classic, 'es')).toBeNull();
    expect(breakLines('una frase que no cabe en una sola línea corta'.split(' '), rulesFor('social'), 'es')).toBeNull();
  });

  it('cuts speech into captions that keep every rule', () => {
    for (const preset of ['classic', 'social'] as const) {
      const rules = rulesFor(preset);
      const cues = wordsToCues(speak(SPEECH), rules, 'es', 30);
      expect(cues.length).toBeGreaterThan(5);
      // Every word, once, in order.
      expect(cues.flatMap((cue) => cue.words.map((word) => word.text)).join(' ')).toBe(SPEECH);
      cues.forEach((cue, index) => {
        const check = checkCue(cue, rules);
        const label = `${preset} #${index} "${cue.lines.join(' / ')}" ${cue.start}-${cue.end}`;
        expect(check.charsPerLine, label).toBe(true);
        expect(check.lines, label).toBe(true);
        expect(check.maxDuration, label).toBe(true);
        expect(check.minDuration, label).toBe(true);
        expect(cue.lines.join(' ')).toBe(cue.words.map((word) => word.text).join(' '));
        const next = cues[index + 1];
        if (next) {
          const gap = next.start - cue.end;
          // Two frames, or half a second or more.
          expect(Math.abs(gap - 2 / 30) < 1e-6 || gap >= 0.5 - 1e-6, `${label} gap ${gap}`).toBe(true);
        }
      });
    }
  });

  it('gives a sentence that needs two captions two even ones, not a full one and a scrap', () => {
    const sentence = 'Una toma un poco oscura mejora bastante si subimos la exposición y bajamos las sombras con cuidado.';
    const cues = wordsToCues(speak(sentence), classic, 'es', 30);
    expect(cues).toHaveLength(2);
    const [first, second] = cues.map((cue) => cue.lines.join(' ').length);
    expect(Math.abs(first - second)).toBeLessThan(20);
    expect(isWeak(cues[0].words[cues[0].words.length - 1].text, 'es')).toBe(false);
  });

  it('starts a new caption at a sentence end and at a pause', () => {
    const cues = wordsToCues(speak('Hola a todos. Empezamos ya.'), classic, 'es', 30);
    // Two short sentences with hardly a pause would share a caption; these have a pause.
    expect(cues.map((cue) => cue.lines.join(' / '))).toEqual(['Hola a todos.', 'Empezamos ya.']);
    const paused: CaptionWord[] = [
      { text: 'uno', start: 0, end: 0.3 },
      { text: 'dos', start: 0.35, end: 0.6 },
      { text: 'tres', start: 2, end: 2.3 },
    ];
    expect(wordsToCues(paused, classic, 'es', 30).map((cue) => cue.lines[0])).toEqual(['uno dos', 'tres']);
  });

  it('puts two short sentences said in one breath on two lines of one caption', () => {
    const words: CaptionWord[] = [
      { text: '¿Listos?', start: 0, end: 0.5 },
      { text: 'Entonces', start: 0.7, end: 1.1 },
      { text: 'empezamos', start: 1.15, end: 1.7 },
      { text: 'con', start: 1.75, end: 1.9 },
      { text: 'el', start: 1.95, end: 2.0 },
      { text: 'primer', start: 2.05, end: 2.4 },
      { text: 'capítulo.', start: 2.45, end: 2.9 },
    ];
    const cues = wordsToCues(words, classic, 'es', 30);
    expect(cues).toHaveLength(1);
    expect(cues[0].lines).toEqual(['¿Listos?', 'Entonces empezamos con el primer capítulo.']);
  });

  it('times captions: lag-out, the minimum, reading speed and the gaps', () => {
    const cue = (start: number, end: number, text: string): Cue => ({ start, end, lines: [text], words: [] });
    const timed = timeCues(
      [
        cue(0, 0.2, 'Sí.'), // far too short, alone: the minimum and the lag-out
        cue(5, 6, 'Una frase bastante larga para un segundo.'), // 41 characters in 1 s: too fast
        cue(9, 10, 'Pegada a la siguiente.'),
        cue(10.3, 11, 'Final.'),
      ],
      rulesFor('classic'),
      30,
    );
    expect(timed[0].end).toBeCloseTo(5 / 6, 5);
    // 41 characters at 17 a second need 2.41 s: 73 whole frames.
    expect(timed[1].end).toBeCloseTo(5 + 73 / 30, 5);
    expect(readingSpeed(timed[1].lines, timed[1].end - timed[1].start)).toBeLessThanOrEqual(17 + 1e-9);
    // 0.3 s to the next one is neither 2 frames nor half a second: closed to 2 frames.
    expect(timed[2].end).toBeCloseTo(10.3 - 2 / 30, 5);
    // The last one stays half a second past its words.
    expect(timed[3].end).toBeCloseTo(11.5, 5);
    // Never longer than seven seconds, however slow the reading.
    const long = timeCues([cue(0, 6.9, 'x'.repeat(84))], rulesFor('classic'), 30);
    expect(long[0].end).toBeLessThanOrEqual(7 + 1e-9);
  });

  it('gives a caption its reading time in whole frames: on the timeline it is not a frame short', () => {
    // 72 characters need 4.235 s. Starting at 52.87 s that ended on frame
    // 1713 of a caption begun on 1586: 127 frames, 4.233 s, 17.008 a second -
    // and the caption was marked as too fast the moment it was generated.
    const rules = rulesFor('classic');
    for (const fps of [24, 25, 30, 60, 30000 / 1001]) {
      for (const start of [52.87, 0.016, 10.49, 3.333, 7.0166]) {
        for (const chars of [20, 41, 72, 84]) {
          const cue: Cue = { start, end: start + 0.4, lines: ['x'.repeat(chars)], words: [] };
          const [clip] = cuesToClips(timeCues([cue], rules, fps), 'track', fps);
          const seconds = clip.durationFrames / fps;
          const check = checkCue({ start: 0, end: seconds, lines: cue.lines }, rules);
          expect(check.readingSpeed, `${chars} characters from ${start} s at ${fps} fps: ${clip.durationFrames} frames`).toBe(true);
          expect(check.minDuration, `${start} s at ${fps} fps: ${clip.durationFrames} frames`).toBe(true);
        }
      }
    }
  });
});

describe('caption clips', () => {
  const rules = rulesFor('classic');
  const cues = wordsToCues(speak(SPEECH), rules, 'es', 30);

  it('become clips that never share a frame, with words counted from their own start', () => {
    const clips = cuesToClips(cues, 'track', 30);
    expect(clips).toHaveLength(cues.length);
    clips.forEach((clip, index) => {
      expect(clip.caption?.text).toBe(cues[index].lines.join('\n'));
      expect(clip.name).toBe(cues[index].lines.join(' '));
      expect(clip.startFrame).toBe(Math.round(cues[index].start * 30));
      const next = clips[index + 1];
      if (next) expect(next.startFrame).toBeGreaterThanOrEqual(clip.startFrame + clip.durationFrames);
      // The first word starts with the caption, give or take the frame it was rounded to.
      expect(Math.abs(clip.caption?.words?.[0].start ?? 1)).toBeLessThan(1 / 30);
    });
    // Placed from another frame, the same captions later.
    const later = cuesToClips(cues, 'track', 30, 90);
    expect(later[0].startFrame).toBe(clips[0].startFrame + 90);
    expect(later[0].caption?.words).toEqual(clips[0].caption?.words);
  });

  it('the razor shares the words out by when they were spoken, and lays the text out again', () => {
    const [clip] = cuesToClips(wordsToCues(speak('Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara,'), rules, 'es', 30), 'track', 30);
    const words = clip.caption?.words ?? [];
    // Cut in the silence between "corto" and "sobre".
    const at = words.findIndex((word) => word.text === 'sobre');
    const frame = clip.startFrame + Math.round(((words[at - 1].end + words[at].start) / 2) * 30);
    const halves = splitClip(clip, frame) as [Clip, Clip];
    const [left, right] = splitCaption(halves[0], halves[1], frame, 30, { preset: 'classic', language: 'es' }, { width: 1920, height: 1080 });
    expect(left.caption?.text).toBe('Hoy vamos a editar un vídeo corto');
    expect(right.caption?.text).toBe('sobre la ciudad de Guadalajara,');
    expect(left.caption?.words?.map((word) => word.text)).toEqual(['Hoy', 'vamos', 'a', 'editar', 'un', 'vídeo', 'corto']);
    expect(right.name).toBe('sobre la ciudad de Guadalajara,');
    expect(left.id).toBe(clip.id);
    expect(right.startFrame).toBe(frame);
    // A cut through the middle of a word leaves the word whole, on the side most of it is.
    const mid = clip.startFrame + Math.round((words[at].start + (words[at].end - words[at].start) * 0.8) * 30);
    const again = splitClip(clip, mid) as [Clip, Clip];
    const [, late] = splitCaption(again[0], again[1], mid, 30, { preset: 'classic', language: 'es' }, { width: 1920, height: 1080 });
    expect(late.caption?.text.startsWith('la ciudad')).toBe(true);
    // The right half can be cut again: its words still know when they were spoken.
    const second = right.caption?.words ?? [];
    const deAt = second.findIndex((word) => word.text === 'de');
    const frame2 = right.startFrame + Math.round(((second[deAt - 1].end + second[deAt].start) / 2 - right.sourceOffsetFrames / 30) * 30);
    const halves2 = splitClip(right, frame2) as [Clip, Clip];
    const [a, b] = splitCaption(halves2[0], halves2[1], frame2, 30, { preset: 'classic', language: 'es' }, { width: 1920, height: 1080 });
    expect([a.caption?.text, b.caption?.text]).toEqual(['sobre la ciudad', 'de Guadalajara,']);
  });

  it('a caption retyped by hand keeps the edit when it is cut', () => {
    const [clip] = cuesToClips(wordsToCues(speak('Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara,'), rules, 'es', 30), 'track', 30);
    const edited: Clip = { ...clip, caption: { ...clip.caption, text: 'HOY EDITAMOS UN VIDEO\nSOBRE GUADALAJARA' } as Clip['caption'] };
    expect(textMatchesWords(edited.caption?.text ?? '', edited.caption?.words ?? [])).toBe(false);
    const frame = clip.startFrame + Math.round(clip.durationFrames / 2);
    const halves = splitClip(edited, frame) as [Clip, Clip];
    const [left, right] = splitCaption(halves[0], halves[1], frame, 30, { preset: 'classic', language: 'es' }, { width: 1920, height: 1080 });
    expect(`${left.caption?.text} ${right.caption?.text}`.replace(/\n/g, ' ')).toBe('HOY EDITAMOS UN VIDEO SOBRE GUADALAJARA');
    expect(left.caption?.text).not.toBe('');
    expect(right.caption?.text).not.toBe('');
  });

  it('a caption from a file, with no words, is cut by where the cut falls', () => {
    const [clip] = subtitleCuesToClips([{ startMs: 0, endMs: 4000, text: 'uno dos tres cuatro' }], 'track', 30);
    const halves = splitClip(clip, 30) as [Clip, Clip];
    const [left, right] = splitCaption(halves[0], halves[1], 30, 30, { preset: 'classic', language: 'es' }, { width: 1920, height: 1080 });
    expect([left.caption?.text, right.caption?.text]).toEqual(['uno', 'dos tres cuatro']);
  });
});

describe('captions on the timeline', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject(1920, 1080, 30);
    useHistoryStore.getState().clear();
  });

  const cues = wordsToCues(speak(SPEECH), rulesFor('classic'), 'es', 30);

  it('go on a new captions track above every picture track, in one undo step', () => {
    const store = useProjectStore.getState();
    const before = store.project.tracks.length;
    const trackId = store.addCaptionTrack({ cues, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
    const { project } = useProjectStore.getState();
    const rows = timelineRows(project.tracks);
    expect(rows[0].id).toBe(trackId);
    expect(rows[0]).toMatchObject({ type: 'captions', name: 'Captions 1', captions: { preset: 'classic', language: 'es' } });
    expect(Object.values(project.clips).filter((clip) => clip.caption && clip.trackId === trackId)).toHaveLength(cues.length);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.tracks).toHaveLength(before);
    expect(Object.keys(useProjectStore.getState().project.clips)).toHaveLength(0);
  });

  it('stay on top: a new video track and a new title go under the captions', () => {
    const store = useProjectStore.getState();
    const trackId = store.addCaptionTrack({ cues, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
    useProjectStore.getState().addTrack('video');
    let rows = timelineRows(useProjectStore.getState().project.tracks);
    expect(rows[0].id).toBe(trackId);
    expect(rows[1].type).toBe('video');
    expect(insertionRow(rows, 'captions')).toBe(0);
    // A title at a frame a caption covers is not put on the captions track, nor above it.
    const placement = planTitlePlacement(useProjectStore.getState().project, 10, 150);
    expect(placement.trackId).not.toBe(trackId);
    const titleId = useProjectStore.getState().addTitle('title');
    const { project } = useProjectStore.getState();
    rows = timelineRows(project.tracks);
    expect(rows[0].id).toBe(trackId);
    expect(project.clips[titleId].trackId).not.toBe(trackId);
  });

  it('a captions track takes captions and nothing else', () => {
    expect(trackAccepts({ type: 'captions' }, 'caption')).toBe(true);
    expect(trackAccepts({ type: 'video' }, 'caption')).toBe(false);
    expect(trackAccepts({ type: 'audio' }, 'caption')).toBe(false);
    expect(trackAccepts({ type: 'captions' }, 'video')).toBe(false);
    expect(trackAccepts({ type: 'captions' }, 'image')).toBe(false);
    expect(trackAccepts({ type: 'captions' }, undefined)).toBe(false);
    // Dragged over a video track, a caption stays on its own.
    const store = useProjectStore.getState();
    const trackId = store.addCaptionTrack({ cues, offsetFrame: 0 }, { preset: 'classic', language: 'es' });
    const state = useProjectStore.getState();
    const clip = Object.values(state.project.clips).find((candidate) => candidate.caption) as Clip;
    const video = state.project.tracks.find((track) => track.type === 'video') as { id: string };
    state.moveClipTo(clip.id, video.id, clip.startFrame);
    expect(useProjectStore.getState().project.clips[clip.id].trackId).toBe(trackId);
  });

  it('the razor cuts a caption between its words, and undo puts it back', () => {
    const store = useProjectStore.getState();
    store.addCaptionTrack({ cues: wordsToCues(speak('Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara,'), rulesFor('classic'), 'es', 30), offsetFrame: 0 }, { preset: 'classic', language: 'es' });
    const clip = Object.values(useProjectStore.getState().project.clips)[0];
    const words = clip.caption?.words ?? [];
    const at = words.findIndex((word) => word.text === 'sobre');
    const frame = clip.startFrame + Math.round(((words[at - 1].end + words[at].start) / 2) * 30);
    useProjectStore.getState().razorAtFrame(frame, [clip.id]);
    const after = Object.values(useProjectStore.getState().project.clips).sort((a, b) => a.startFrame - b.startFrame);
    expect(after.map((half) => half.caption?.text)).toEqual(['Hoy vamos a editar un vídeo corto', 'sobre la ciudad de Guadalajara,']);
    expect(after[0].startFrame + after[0].durationFrames).toBe(frame);
    useProjectStore.getState().undo();
    const restored = Object.values(useProjectStore.getState().project.clips);
    expect(restored).toHaveLength(1);
    expect(restored[0].caption?.text).toBe(clip.caption?.text);
  });

  it('the magnet leaves captions alone: deleting, moving or trimming one never moves the others', () => {
    const store = useProjectStore.getState();
    store.addCaptionTrack(
      { subtitles: [{ startMs: 0, endMs: 1000, text: 'a' }, { startMs: 2000, endMs: 3000, text: 'b' }, { startMs: 3100, endMs: 4000, text: 'c' }, { startMs: 6000, endMs: 7000, text: 'd' }] },
      { preset: 'classic', language: 'es' },
    );
    expect(useProjectStore.getState().ui.rippleEnabled).toBe(true);
    const byText = (): Record<string, Clip> => Object.fromEntries(Object.values(useProjectStore.getState().project.clips).map((clip) => [clip.caption?.text ?? '', clip]));
    const starts = (): number[] => ['a', 'b', 'c', 'd'].map((text) => byText()[text]?.startFrame ?? -1);
    expect(starts()).toEqual([0, 60, 93, 180]);

    // Deleted: the hole stays open.
    useProjectStore.getState().removeClips([byText().b.id]);
    expect(starts()).toEqual([0, -1, 93, 180]);
    useProjectStore.getState().undo();

    // Moved later: it stops at the caption after it, which does not budge.
    useProjectStore.getState().moveClipTo(byText().b.id, byText().b.trackId, 200);
    expect(starts()).toEqual([0, 63, 93, 180]);
    // Moved earlier: it stops at the one before.
    useProjectStore.getState().moveClipTo(byText().b.id, byText().b.trackId, 0);
    expect(starts()).toEqual([0, 30, 93, 180]);
    // Into free space: it goes where it is put.
    useProjectStore.getState().moveClipTo(byText().c.id, byText().c.trackId, 120);
    expect(starts()).toEqual([0, 30, 120, 180]);
    // Dragged as a group, the same.
    useProjectStore.getState().moveClipGroup([byText().a.id, byText().b.id], 500, 0);
    expect(starts()).toEqual([60, 90, 120, 180]);

    // Trimmed shorter at its end: the next one stays; longer: it stops at the next one.
    useProjectStore.getState().trimClip(byText().c.id, 'end', 130);
    expect(starts()).toEqual([60, 90, 120, 180]);
    expect(byText().c.durationFrames).toBe(10);
    useProjectStore.getState().trimClip(byText().c.id, 'end', 400);
    expect(byText().c.startFrame + byText().c.durationFrames).toBe(180);
    expect(starts()).toEqual([60, 90, 120, 180]);
  });

  it('typing in a caption is one undo step, and renames the clip', () => {
    const store = useProjectStore.getState();
    store.addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 2000, text: 'Hola' }] }, { preset: 'classic', language: 'es' });
    const clip = Object.values(useProjectStore.getState().project.clips)[0];
    const depth = useHistoryStore.getState().undoStack.length;
    for (const text of ['Hola,', 'Hola, m', 'Hola, mundo']) useProjectStore.getState().setCaptionText(clip.id, text, `caption:${clip.id}`);
    const typed = useProjectStore.getState().project.clips[clip.id];
    expect(typed.caption?.text).toBe('Hola, mundo');
    expect(typed.name).toBe('Hola, mundo');
    expect(useHistoryStore.getState().undoStack).toHaveLength(depth + 1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[clip.id].caption?.text).toBe('Hola');
  });

  it('a subtitle file imported and exported again is the same file', () => {
    const file = writeSrt([
      { startMs: 0, endMs: 1933, text: 'Buenos días a todos.' },
      { startMs: 2000, endMs: 5700, text: 'Hoy vamos a editar un vídeo corto\nsobre la ciudad de Guadalajara,' },
      { startMs: 61_033, endMs: 63_500, text: '¿Qué tal?' },
    ]);
    for (const fps of [30, 24, 25, 60]) {
      useProjectStore.getState().newProject(1920, 1080, fps);
      useProjectStore.getState().addCaptionTrack({ subtitles: parseSubtitles(file) }, { preset: 'classic', language: 'es' });
      const once = writeSrt(captionCues(useProjectStore.getState().project));
      // Times land on this project's frames; from there on nothing moves.
      useProjectStore.getState().newProject(1920, 1080, fps);
      useProjectStore.getState().addCaptionTrack({ subtitles: parseSubtitles(once) }, { preset: 'classic', language: 'es' });
      expect(writeSrt(captionCues(useProjectStore.getState().project)), `${fps} fps`).toBe(once);
      if (fps === 30) expect(once).toBe(file);
    }
  });

  it('writes only the captions in the range exported, counted from its start', () => {
    useProjectStore.getState().addCaptionTrack(
      { subtitles: [{ startMs: 0, endMs: 1000, text: 'a' }, { startMs: 2000, endMs: 4000, text: 'b' }, { startMs: 9000, endMs: 9500, text: 'c' }] },
      { preset: 'classic', language: 'es' },
    );
    const { project } = useProjectStore.getState();
    expect(captionCues(project, { fromFrame: 90, toFrame: 240 })).toEqual([{ startMs: 0, endMs: 1000, text: 'b' }]);
    // A hidden captions track is not written.
    const hidden = { ...project, tracks: project.tracks.map((track) => (track.type === 'captions' ? { ...track, visible: false } : track)) };
    expect(captionCues(hidden)).toEqual([]);
  });

  it('is drawn as a title, in the captions look, and only on a captions track', () => {
    useProjectStore.getState().addCaptionTrack({ subtitles: [{ startMs: 0, endMs: 2000, text: 'Hola\nmundo' }] }, { preset: 'classic', language: 'es' });
    const { project } = useProjectStore.getState();
    const drawn = withCaptionTitles(project);
    const clip = Object.values(drawn.clips)[0];
    expect(clip.title).toMatchObject({ text: 'Hola\nmundo', style: { anchor: 'bottom', align: 'center', fontFamily: 'Inter', color: '#ffffff' } });
    expect(clip.title?.animation).toBeUndefined();
    // The same project gives the same objects, so the title cache keys them once.
    expect(withCaptionTitles(project)).toBe(drawn);
    const moved = { ...project, currentFrame: 5 };
    expect(Object.values(withCaptionTitles(moved).clips)[0].title).toBe(clip.title);
    // The store's clip is untouched: a caption is not a title to the editor.
    expect(Object.values(project.clips)[0].title).toBeUndefined();
    // Not burnt in: the track is hidden for the render.
    expect(withoutCaptions(project).tracks.find((track) => track.type === 'captions')?.visible).toBe(false);
    // A full line fits the title-safe width: 42 characters wide, 32 tall, 22 social tall.
    for (const [preset, frame] of [['classic', { width: 1920, height: 1080 }], ['classic', { width: 1080, height: 1920 }], ['social', { width: 1080, height: 1920 }], ['social', { width: 1920, height: 1080 }]] as const) {
      const style = captionStyle({ preset, language: 'es' }, frame);
      const chars = rulesFor(preset, frame).maxCharsPerLine;
      const width = chars * 0.56 * style.fontSize * (frame.height / 1080);
      expect(width, `${preset} ${frame.width}x${frame.height}`).toBeLessThanOrEqual(frame.width * 0.9);
      expect(style.fontSize).toBeGreaterThanOrEqual(24);
    }
  });

  it('survives saving and opening, and a damaged file still opens', () => {
    useProjectStore.getState().addCaptionTrack({ cues, offsetFrame: 0 }, { preset: 'social', language: 'en' });
    const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project));
    const opened = normalizeProject(saved);
    expect(opened).toEqual(saved);
    const track = saved.tracks.find((candidate: { type: string }) => candidate.type === 'captions');
    track.captions = { preset: 'nonsense' };
    const first = Object.values(saved.clips).find((clip) => (clip as Clip).caption) as Clip;
    (first.caption as unknown as Record<string, unknown>).words = [{ text: 'ok', start: 0, end: 1 }, { text: 5 }, null];
    const repaired = normalizeProject(saved);
    expect(repaired.tracks.find((candidate) => candidate.type === 'captions')?.captions).toEqual({ preset: 'classic', language: 'es' });
    expect(repaired.clips[first.id].caption?.words).toEqual([{ text: 'ok', start: 0, end: 1 }]);
  });
});
