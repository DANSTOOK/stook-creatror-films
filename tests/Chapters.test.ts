import { describe, expect, it } from 'vitest';
import { chapterTime, youtubeChapters } from '../src/renderer/edit/chapters';
import type { Marker } from '../src/shared/types';

const names = { intro: 'Intro', numbered: (index: number) => `Chapter ${index}` };
const at = (seconds: number, label: string): Marker => ({ id: label, frame: seconds * 30, label, color: '#facc15' });

describe('YouTube chapters from markers', () => {
  it('writes times as YouTube does, with hours from an hour on', () => {
    expect(chapterTime(83, false)).toBe('01:23');
    expect(chapterTime(3725, true)).toBe('1:02:05');
  });

  it('starts at 00:00 with an intro when no marker is there, in order', () => {
    const chapters = youtubeChapters([at(120, 'Results'), at(30, 'The build')], 30, 300 * 30, names);
    expect(chapters.text).toBe('00:00 Intro\n00:30 The build\n02:00 Results');
    expect(chapters).toMatchObject({ count: 3, skipped: 0, tooFew: false });
  });

  it('uses a marker at the very start as the first chapter', () => {
    expect(youtubeChapters([at(0, 'Hello'), at(40, 'Two'), at(90, 'Three')], 30, 200 * 30, names).text).toBe('00:00 Hello\n00:40 Two\n01:30 Three');
  });

  it('leaves out a marker less than ten seconds after the one before, and one too near the end', () => {
    const chapters = youtubeChapters([at(30, 'A'), at(35, 'Too soon'), at(60, 'B'), at(195, 'Too late')], 30, 200 * 30, names);
    expect(chapters.text).toBe('00:00 Intro\n00:30 A\n01:00 B');
    expect(chapters.skipped).toBe(2);
  });

  it('names an unnamed marker by its place, skips beat markers, and says when there are too few', () => {
    const chapters = youtubeChapters([at(30, ''), at(50, '♪')], 30, 100 * 30, names);
    expect(chapters.text).toBe('00:00 Intro\n00:30 Chapter 2');
    expect(chapters.tooFew).toBe(true);
  });

  it('counts hours on a long video', () => {
    expect(youtubeChapters([at(1800, 'Half'), at(3700, 'Late')], 30, 4000 * 30, names).text).toBe('0:00:00 Intro\n0:30:00 Half\n1:01:40 Late');
  });
});
