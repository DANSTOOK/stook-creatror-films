import { describe, expect, it } from 'vitest';
import type { CaptionTrackSettings, Clip, ProjectState } from '@shared/types';
import { defaultAnimation, normalizeCaptionAnimation, timedWords, wordAnimationFor, wordPages } from '@renderer/captions/animation';
import { captionStyle, withCaptionTitles } from '@renderer/captions/captionRender';
import { createCaptionClip } from '@renderer/captions/captionClips';
import { normalizeCaptionSettings } from '@renderer/captions/normalize';
import { activeWord, EMPHASIS, POP_SECONDS, wordAnimationOf, wordFrameAt, type WordAnimation } from '@renderer/text/wordAnimation';
import { createTrack } from '@renderer/store/types';

/**
 * Captions that move word by word: when each word is said (also after the
 * text was typed over), which word a frame shows being said, and what each
 * kind of animation does to the words at that moment.
 */

const said = (text: string, start: number, end: number) => ({ text, start, end });
const WORDS = [said('Hoy', 0.1, 0.35), said('vamos', 0.4, 0.75), said('a', 0.8, 0.85), said('editar', 0.9, 1.4), said('un', 1.5, 1.6), said('vídeo.', 1.65, 2.1)];
const TEXT = 'Hoy vamos a editar\nun vídeo.';
const SPAN = { from: 0, to: 2.6 };

describe('when each word is said', () => {
  it('keeps the transcribed times while the text is what was transcribed, line breaks or not', () => {
    expect(timedWords(TEXT, WORDS, SPAN)).toEqual(WORDS.map(({ start, end }) => ({ start, end })));
  });

  it('gives a corrected word the time of the one it replaced, and leaves the rest alone', () => {
    const times = timedWords('Hoy vamos a montar\nun vídeo.', WORDS, SPAN);
    expect(times[3]).toEqual({ start: 0.9, end: 1.4 });
    expect(times[0]).toEqual({ start: 0.1, end: 0.35 });
    expect(times[5]).toEqual({ start: 1.65, end: 2.1 });
  });

  it('shares a replaced stretch among more words by their length', () => {
    // "editar" (0.9-1.4) said as three words.
    const times = timedWords('Hoy vamos a cortar y pegar un vídeo.', WORDS, SPAN);
    expect(times).toHaveLength(8);
    expect(times[3].start).toBeCloseTo(0.9, 6);
    expect(times[5].end).toBeCloseTo(1.4, 6);
    // "cortar" is longer than "y": it gets more of the time.
    expect(times[3].end - times[3].start).toBeGreaterThan(times[4].end - times[4].start);
    expect(times[6]).toEqual({ start: 1.5, end: 1.6 });
  });

  it('finds room for a word put in between two that touch: the word before shares its own', () => {
    const times = timedWords('Hoy vamos a editar un buen vídeo.', [said('Hoy', 0.1, 0.35), said('vamos', 0.4, 0.75), said('a', 0.8, 0.85), said('editar', 0.9, 1.4), said('un', 1.5, 1.6), said('vídeo.', 1.6, 2.1)], SPAN);
    expect(times).toHaveLength(7);
    expect(times[5].start).toBeGreaterThan(times[4].start);
    expect(times[5].end - times[5].start).toBeGreaterThan(0.05);
    expect(times[6].start).toBeCloseTo(1.6, 6);
  });

  it('drops the time of a word taken out', () => {
    const times = timedWords('Hoy vamos a editar\nvídeo.', WORDS, SPAN);
    expect(times).toEqual([WORDS[0], WORDS[1], WORDS[2], WORDS[3], WORDS[5]].map(({ start, end }) => ({ start, end })));
  });

  it('with no times at all, shares the time on screen less a moment at the end, by length', () => {
    const times = timedWords('Un subtítulo escrito a mano', undefined, { from: 0, to: 2 });
    expect(times[0].start).toBe(0);
    expect(times[times.length - 1].end).toBeCloseTo(2 - 0.3, 6);
    expect(times[1].end - times[1].start).toBeGreaterThan(times[0].end - times[0].start);
  });

  it('never runs backwards, whatever was typed', () => {
    for (const text of ['vídeo un editar a vamos Hoy', 'Hoy Hoy Hoy', 'x', '¡Hola! Hoy, vamos... a editar un vídeo, ¿vale?']) {
      const times = timedWords(text, WORDS, SPAN);
      for (let i = 1; i < times.length; i += 1) expect(times[i].start).toBeGreaterThanOrEqual(times[i - 1].start);
      for (const time of times) expect(time.end).toBeGreaterThanOrEqual(time.start);
    }
  });
});

describe('a few words at a time', () => {
  it('never carries a page past the end of a sentence', () => {
    expect(wordPages(['Buenos', 'días', 'a', 'todos.', 'Hoy', 'editamos.'], 2)).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 3 },
      { first: 4, last: 5 },
    ]);
    expect(wordPages(['Uno.', 'Dos', 'tres', 'cuatro'], 3)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 3 },
    ]);
    expect(wordPages(['a', 'b', 'c'], null)).toEqual([{ first: 0, last: 2 }]);
  });
});

const animate = (kind: WordAnimation['kind'], bounce = true, perPage = 2): WordAnimation =>
  wordAnimationFor({ ...defaultAnimation(kind), bounce, perPage }, TEXT, WORDS, SPAN);

describe('one moment of a word animation', () => {
  it('knows which word is being said: the last that has started, and none before the first', () => {
    expect(activeWord(WORDS, 0)).toBe(-1);
    expect(activeWord(WORDS, 0.1)).toBe(0);
    expect(activeWord(WORDS, 0.38)).toBe(0);
    expect(activeWord(WORDS, 0.9)).toBe(3);
    expect(activeWord(WORDS, 5)).toBe(5);
  });

  it('highlight: the word being said takes the colour and springs larger; the others are as they were', () => {
    const at = wordFrameAt(animate('highlight'), 0.9 + POP_SECONDS);
    expect(at.active).toBe(3);
    expect(at.words.map((word) => word.fill)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(at.words[3].scale).toBeCloseTo(1 + EMPHASIS, 3);
    expect(at.words[0].scale).toBe(1);
    // As it starts, it is at its own size; the spring takes it up from there.
    expect(wordFrameAt(animate('highlight'), 0.9).words[3].scale).toBeCloseTo(1, 6);
    // The word before goes back to its size.
    const handOff = wordFrameAt(animate('highlight'), 0.9 + 0.05);
    expect(handOff.words[2].scale).toBeGreaterThan(1);
    expect(wordFrameAt(animate('highlight'), 0.9 + 0.2).words[2].scale).toBe(1);
  });

  it('without bounce, the colour moves and nothing changes size', () => {
    for (const seconds of [0.12, 0.5, 0.95, 1.7]) {
      for (const word of wordFrameAt(animate('highlight', false), seconds).words) expect(word.scale).toBe(1);
    }
  });

  it('karaoke: what was said is coloured, the word being said fills from the left in its own time', () => {
    const at = wordFrameAt(animate('karaoke'), 0.9 + 0.25);
    [1, 1, 1, 0.5, 0, 0].forEach((fill, index) => expect(at.words[index].fill).toBeCloseTo(fill, 9));
  });

  it('appear: words come on as they are said, and stay', () => {
    const at = wordFrameAt(animate('appear'), 0.9 + POP_SECONDS);
    expect(at.words.map((word) => word.visible)).toEqual([true, true, true, true, false, false]);
    expect(at.words[3].opacity).toBe(1);
    // Coming on: smaller and fading in.
    const coming = wordFrameAt(animate('appear'), 0.9 + 0.03);
    expect(coming.words[3].scale).toBeLessThan(1);
    expect(coming.words[3].opacity).toBeLessThan(1);
    expect(wordFrameAt(animate('appear'), 0.05).words.every((word) => !word.visible)).toBe(true);
  });

  it('a few words at a time: one page on screen, never one before the first word', () => {
    const animation = animate('words', true, 2);
    expect(animation.pages).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 3 },
      { first: 4, last: 5 },
    ]);
    expect(wordFrameAt(animation, 0.05).words.every((word) => !word.visible)).toBe(true);
    const at = wordFrameAt(animation, 0.9 + POP_SECONDS);
    expect(at.page).toBe(1);
    expect(at.words.map((word) => word.visible)).toEqual([false, false, true, true, false, false]);
    expect(at.words[3].fill).toBe(1);
    expect(at.words[2].fill).toBe(0);
  });

  it('box: it sits on the word being said, gliding from the one before along the same page', () => {
    const at = wordFrameAt(animate('box'), 0.9 + 0.02);
    expect(at.box).toMatchObject({ to: 3, from: 2 });
    expect(at.box?.progress).toBeLessThan(1);
    expect(at.words.every((word) => word.fill === 0)).toBe(true);
    expect(wordFrameAt(animate('box', false), 0.92).box).toEqual({ to: 3, from: null, progress: 1, opacity: 1 });
    expect(wordFrameAt(animate('box'), 0.05).box).toBeNull();
  });

  it('frames showing the same picture share a key, so the picture is drawn once', () => {
    const still = animate('highlight', false);
    // Every frame while "editar" is said (30 fps), without bounce: one picture.
    const keys = new Set<string>();
    for (let frame = 27; frame < 45; frame += 1) keys.add(wordFrameAt(still, frame / 30).key);
    expect(keys.size).toBe(1);
    expect(wordFrameAt(still, 1.0).key).not.toBe(wordFrameAt(still, 1.55).key);
    // With bounce, the spring moves for its settle time (0.31 s) and then stops.
    const springy = animate('highlight');
    const settled = new Set<string>();
    for (let frame = 37; frame < 45; frame += 1) settled.add(wordFrameAt(springy, frame / 30).key);
    expect(settled.size).toBe(1);
  });
});

describe('a captions track that moves', () => {
  it('reads an animation from a file safely, and drops one it does not know', () => {
    expect(normalizeCaptionAnimation({ kind: 'words', color: '#FF0000', bounce: false, perPage: 9 })).toEqual({ kind: 'words', color: '#ff0000', bounce: false, perPage: 3 });
    expect(normalizeCaptionAnimation({ kind: 'spin' })).toBeNull();
    expect(normalizeCaptionSettings({ preset: 'social', language: 'en', animation: { kind: 'karaoke' } })).toEqual({
      preset: 'social',
      language: 'en',
      animation: { kind: 'karaoke', color: '#ffe600', bounce: false, perPage: 2 },
    });
  });

  it('a few words at a time are drawn large', () => {
    const plain: CaptionTrackSettings = { preset: 'classic', language: 'es' };
    expect(captionStyle(plain, { width: 1920, height: 1080 }).fontSize).toBe(46);
    expect(captionStyle({ ...plain, animation: defaultAnimation('words') }, { width: 1920, height: 1080 }).fontSize).toBe(96);
    // Tall: as large as sixteen letters across allow.
    const tall = captionStyle({ ...plain, animation: defaultAnimation('words') }, { width: 1080, height: 1920 }).fontSize;
    expect(tall).toBeGreaterThan(46);
    expect(tall).toBeLessThan(96);
  });

  function projectWith(settings: CaptionTrackSettings): ProjectState {
    const track = { ...createTrack('captions', 0, 'Captions 1'), captions: settings };
    const clip: Clip = createCaptionClip(track.id, 30, 108, TEXT, WORDS);
    return {
      id: 'p',
      name: 'p',
      fps: 30,
      width: 1920,
      height: 1080,
      durationFrames: 300,
      currentFrame: 0,
      tracks: [track],
      clips: { [clip.id]: clip },
      hasAlphaBackground: false,
      markers: [],
      audio: { masterGain: 1, ducking: { enabled: false } },
    } as unknown as ProjectState;
  }

  it('a still track draws its captions as before: no word animation beside the title', () => {
    const drawn = withCaptionTitles(projectWith({ preset: 'classic', language: 'es' }));
    const title = Object.values(drawn.clips)[0].title;
    expect(title).toBeDefined();
    expect(wordAnimationOf(title!)).toBeUndefined();
  });

  it('a moving track hands the compositor the words and their times', () => {
    const drawn = withCaptionTitles(projectWith({ preset: 'classic', language: 'es', animation: defaultAnimation('highlight') }));
    const animation = wordAnimationOf(Object.values(drawn.clips)[0].title!);
    expect(animation?.kind).toBe('highlight');
    expect(animation?.times).toHaveLength(6);
    expect(animation?.times[3]).toEqual({ start: 0.9, end: 1.4 });
  });
});
