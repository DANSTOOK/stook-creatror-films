import { describe, expect, it } from 'vitest';
import { keepScrubbers } from '../src/renderer/engine/scrubHandover';

class FakeScrubber {
  closed = false;
  constructor(readonly sourceUri: string) {}
  close(): void {
    this.closed = true;
  }
}

describe('forward decoder handover', () => {
  it('keeps the decoders of clips still wanted and closes the rest', () => {
    const kept = new FakeScrubber('a.mp4');
    const gone = new FakeScrubber('b.mp4');
    const scrubbers = new Map([
      ['c1|a.mp4', kept],
      ['c2|b.mp4', gone],
    ]);

    keepScrubbers(scrubbers, new Map([['c1|a.mp4', 'a.mp4']]));

    expect([...scrubbers.keys()]).toEqual(['c1|a.mp4']);
    expect(kept.closed).toBe(false);
    expect(gone.closed).toBe(true);
  });

  it('hands a cut clip\'s decoder, and what it kept, to the new clip of the same file', () => {
    const scrubber = new FakeScrubber('a.mp4');
    const scrubbers = new Map([['whole|a.mp4', scrubber]]);

    // The cut replaced `whole` with two halves; the right one is under the playhead.
    keepScrubbers(scrubbers, new Map([['right|a.mp4', 'a.mp4']]));

    expect(scrubbers.get('right|a.mp4')).toBe(scrubber);
    expect(scrubbers.has('whole|a.mp4')).toBe(false);
    expect(scrubber.closed).toBe(false);
  });

  it('never hands a decoder to a clip that now shows a different file', () => {
    const scrubber = new FakeScrubber('old.mp4');
    const scrubbers = new Map([['c1|old.mp4', scrubber]]);

    // Relinked: same clip id, another file.
    keepScrubbers(scrubbers, new Map([['c1|new.mp4', 'new.mp4']]));

    expect(scrubbers.size).toBe(0);
    expect(scrubber.closed).toBe(true);
  });

  it('does not replace a decoder the wanted clip already has', () => {
    const existing = new FakeScrubber('a.mp4');
    const orphan = new FakeScrubber('a.mp4');
    const scrubbers = new Map([
      ['right|a.mp4', existing],
      ['whole|a.mp4', orphan],
    ]);

    keepScrubbers(scrubbers, new Map([['right|a.mp4', 'a.mp4']]));

    expect(scrubbers.get('right|a.mp4')).toBe(existing);
    expect(existing.closed).toBe(false);
    expect(orphan.closed).toBe(true);
  });

  it('gives one orphan to each heir and closes the spare', () => {
    const first = new FakeScrubber('a.mp4');
    const second = new FakeScrubber('a.mp4');
    const scrubbers = new Map([
      ['x|a.mp4', first],
      ['y|a.mp4', second],
    ]);

    keepScrubbers(scrubbers, new Map([['z|a.mp4', 'a.mp4']]));

    expect(scrubbers.size).toBe(1);
    expect([first, second].filter((s) => s.closed)).toHaveLength(1);
    expect(scrubbers.get('z|a.mp4')?.closed).toBe(false);
  });

  it('closes everything when nothing is wanted (playback, export)', () => {
    const one = new FakeScrubber('a.mp4');
    const two = new FakeScrubber('a.mp4');
    const scrubbers = new Map([
      ['c1|a.mp4', one],
      ['c2|a.mp4', two],
    ]);

    keepScrubbers(scrubbers, new Map());

    expect(scrubbers.size).toBe(0);
    expect(one.closed && two.closed).toBe(true);
  });
});
