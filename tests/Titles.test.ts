import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, TitleContent } from '@shared/types';
import { contrastOf, TEXT_CONTRAST } from '@shared/utils/contrast';
import { layoutTitle, wrapParagraph, type Measurer } from '@renderer/text/layout';
import { normalizeTitle, presetStyle, titleName, TITLE_SAFE } from '@renderer/text/titleStyle';
import { planTitlePlacement } from '@renderer/text/titleClip';
import { subRectMatrix } from '@renderer/engine/Compositor';
import { makeQuadMatrix } from '@renderer/engine/GLProgram';
import { pasteClips } from '@renderer/components/Timeline/clipboard';
import { timelineRows } from '@renderer/components/Timeline/trackRows';
import { TRACK_TYPE_COLORS } from '@renderer/components/Timeline/TimelineCanvas';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { createClip, normalizeProject } from '@renderer/store/types';

/**
 * Titles, phase 1: the model, the layout and the placement, without a GPU.
 * What they look like on the real compositor is tests/ui/titles.mjs.
 */

/** A monospace stand-in: every character is half the size wide, spacing after each. */
const mono: Measurer = {
  width: (text, size, spacing) => [...text].length * (size * 0.5 + spacing) - (text ? spacing : 0),
  metrics: (size) => ({ ascent: size * 0.8, descent: size * 0.2 }),
};

const title = (text: string, patch: Partial<TitleContent['style']> = {}, preset: TitleContent['preset'] = 'title'): TitleContent => ({
  preset,
  text,
  style: { ...presetStyle(preset), ...patch },
});

describe('a title read from a file', () => {
  it('keeps what is valid and puts every missing or broken field back to its template', () => {
    const read = normalizeTitle({
      preset: 'lowerThird',
      text: 'Ana\nEditor',
      style: { fontSize: 9999, color: 'red', align: 'sideways', fontWeight: 651, stroke: { enabled: true }, fontFamily: 'Bahn"schrift' },
    });
    expect(read.preset).toBe('lowerThird');
    expect(read.text).toBe('Ana\nEditor');
    expect(read.style.fontSize).toBe(600);
    expect(read.style.color).toBe(presetStyle('lowerThird').color);
    expect(read.style.align).toBe('left');
    expect(read.style.fontWeight).toBe(700);
    expect(read.style.stroke).toEqual({ ...presetStyle('lowerThird').stroke, enabled: true });
    expect(read.style.fontFamily).toBe('Bahnschrift');
    expect(read.style.box.enabled).toBe(true);
  });

  it('opens a title with no style at all as its template', () => {
    expect(normalizeTitle({ preset: 'credits' })).toEqual({ preset: 'credits', text: '', style: presetStyle('credits') });
    expect(normalizeTitle(null).preset).toBe('title');
  });

  it('survives a save and reopen unchanged', () => {
    const clip: Clip = { ...createClip({ trackId: 'v', name: 'T', sourceUri: 'scf-title:x', startFrame: 0, durationFrames: 30 }), title: title('Hola') };
    const project = { ...useProjectStore.getState().project, clips: { [clip.id]: clip } };
    const reopened = normalizeProject(JSON.parse(JSON.stringify(project)));
    expect(reopened.clips[clip.id].title).toEqual(clip.title);
  });

  it('is named after its first line that has anything in it', () => {
    expect(titleName('\n  Ana López \nEditor', 'Title')).toBe('Ana López');
    expect(titleName('   ', 'Lower third')).toBe('Lower third');
    expect(titleName('x'.repeat(80), 'T')).toHaveLength(60);
  });
});

describe('wrapping', () => {
  const width = (text: string): number => text.length * 10;

  it('keeps a line that fits whole', () => {
    expect(wrapParagraph('A short line', 500, width)).toEqual(['A short line']);
  });

  it('breaks between words, never leaving a space at either end', () => {
    expect(wrapParagraph('one two three four', 90, width)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps punctuation with the word before it', () => {
    const lines = wrapParagraph('Hello, world, again', 70, width);
    expect(lines.every((line) => !/^[,.]/.test(line))).toBe(true);
    expect(lines[0]).toBe('Hello,');
  });

  it('breaks inside a word only when the word alone is wider than the line', () => {
    expect(wrapParagraph('abcdefghij', 40, width)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps an emoji or an accented letter whole when it has to break a word', () => {
    const lines = wrapParagraph('ééééé👍🏽👍🏽', 30, (text) => [...new Intl.Segmenter().segment(text)].length * 10);
    expect(lines.join('')).toBe('ééééé👍🏽👍🏽');
    expect(lines.some((line) => line.endsWith('\u{1F3FD}') || line.includes('👍🏽'))).toBe(true);
    expect(lines.every((line) => !line.startsWith('\u{1F3FD}'))).toBe(true);
  });

  it('keeps a blank line as a line, for spacing in credits', () => {
    expect(wrapParagraph('', 100, width)).toEqual(['']);
  });
});

describe('layout', () => {
  const hd = { width: 1920, height: 1080 };
  const uhd = { width: 3840, height: 2160 };

  it('centres a centre-anchored title on the frame', () => {
    const laid = layoutTitle(title('Title', { shadow: { ...presetStyle('title').shadow, enabled: false } }), hd, mono);
    expect(laid.block.x + laid.block.width / 2).toBeCloseTo(960, 6);
    expect(laid.block.y + laid.block.height / 2).toBeCloseTo(540, 6);
    expect(laid.lines[0].width).toBe(5 * 48);
  });

  it('pins a lower third, box and all, to the bottom-left corner of the title-safe area', () => {
    const laid = layoutTitle(title('Ana\nEditor', {}, 'lowerThird'), hd, mono);
    const margin = (1 - TITLE_SAFE) / 2;
    expect(laid.box).not.toBeNull();
    expect(laid.box!.x).toBeCloseTo(1920 * margin, 6);
    expect(laid.box!.y + laid.box!.height).toBeCloseTo(1080 * (1 - margin), 6);
    // The role is set smaller than the name.
    expect(laid.lines[1].size).toBeCloseTo(laid.lines[0].size * presetStyle('lowerThird').secondaryScale, 6);
  });

  it('scales with the project: a 4K frame lays out exactly twice as big', () => {
    const hdLaid = layoutTitle(title('Two words'), hd, mono);
    const uhdLaid = layoutTitle(title('Two words'), uhd, mono);
    expect(uhdLaid.unit).toBe(2);
    expect(uhdLaid.block.width).toBeCloseTo(hdLaid.block.width * 2, 6);
    expect(uhdLaid.block.x).toBeCloseTo(hdLaid.block.x * 2, 6);
    expect(uhdLaid.lines[0].baseline).toBeCloseTo(hdLaid.lines[0].baseline * 2, 6);
  });

  it('aligns lines inside the block', () => {
    const left = layoutTitle(title('a\nlonger line', { align: 'left' }), hd, mono);
    const right = layoutTitle(title('a\nlonger line', { align: 'right' }), hd, mono);
    expect(left.lines[0].x).toBe(left.block.x);
    expect(right.lines[0].x + right.lines[0].width).toBeCloseTo(right.block.x + right.block.width, 6);
  });

  it('wraps at the line length, which is a share of the title-safe width', () => {
    const laid = layoutTitle(title('word '.repeat(60).trim(), { maxWidth: 0.5 }), hd, mono);
    expect(laid.lines.length).toBeGreaterThan(1);
    expect(Math.max(...laid.lines.map((line) => line.width))).toBeLessThanOrEqual(1920 * TITLE_SAFE * 0.5);
  });

  it('leaves room in its bounds for the outline and the shadow', () => {
    const plain = layoutTitle(title('Title', { shadow: { ...presetStyle('title').shadow, enabled: false } }), hd, mono);
    const heavy = layoutTitle(title('Title', { stroke: { enabled: true, color: '#000000', width: 20 } }), hd, mono);
    expect(heavy.bounds.width).toBeGreaterThan(plain.bounds.width + 40);
    for (const laid of [plain, heavy]) {
      expect(laid.bounds.x).toBeLessThan(laid.block.x);
      expect(laid.bounds.x + laid.bounds.width).toBeGreaterThan(laid.block.x + laid.block.width);
    }
  });
});

describe('the quad a title is drawn on', () => {
  it('covers exactly its rect of the frame, under the clip transform', () => {
    const frame = makeQuadMatrix(0, 0, 1, 1, 0);
    const matrix = subRectMatrix(frame, { x: 480, y: 270, width: 960, height: 540 }, 1920, 1080);
    const apply = (u: number, v: number): [number, number] => [
      matrix[0] * u + matrix[3] * v + matrix[6],
      matrix[1] * u + matrix[4] * v + matrix[7],
    ];
    // The middle half of the frame, in clip space: -0.5..0.5 both ways.
    expect(apply(0, 0).map((n) => Number(n.toFixed(6)))).toEqual([-0.5, -0.5]);
    expect(apply(1, 1).map((n) => Number(n.toFixed(6)))).toEqual([0.5, 0.5]);
  });

  it('follows the clip: a clip moved and halved moves and halves its title', () => {
    const frame = makeQuadMatrix(0.2, 0, 0.5, 0.5, 0);
    const matrix = subRectMatrix(frame, { x: 0, y: 0, width: 1920, height: 540 }, 1920, 1080);
    // The top half of a half-size frame centred at x 0.2: y from 0 to 0.5.
    expect(Number((matrix[7]).toFixed(6))).toBe(0);
    expect(Number((matrix[4] + matrix[7]).toFixed(6))).toBe(0.5);
    expect(Number((matrix[6]).toFixed(6))).toBe(-0.3);
  });
});

describe('where a new title goes', () => {
  const state = () => useProjectStore.getState();
  let v1 = '';
  let v2 = '';

  beforeEach(() => {
    state().newProject();
    useHistoryStore.getState().clear();
    const rows = timelineRows(state().project.tracks);
    v2 = rows[0].id;
    v1 = rows[1].id;
  });

  const put = (trackId: string, start: number, duration: number): void => {
    const clip = createClip({ trackId, name: 'shot', sourceUri: 'media://shot', startFrame: start, durationFrames: duration });
    state().transact('seed', (project) => ({ ...project, clips: { ...project.clips, [clip.id]: clip } }));
  };

  it('goes above the picture at the playhead', () => {
    put(v1, 0, 300);
    expect(planTitlePlacement(state().project, 30, 150).trackId).toBe(v2);
  });

  it('goes on a new track on top when the track above is taken', () => {
    put(v1, 0, 300);
    put(v2, 100, 50);
    expect(planTitlePlacement(state().project, 30, 150).trackId).toBeNull();
  });

  it('skips a locked track', () => {
    put(v1, 0, 300);
    state().updateTrack(v2, { locked: true });
    expect(planTitlePlacement(state().project, 30, 150).trackId).toBeNull();
  });

  it('adds the title where planned, five seconds long, selected, as one undo step', () => {
    put(v1, 0, 300);
    state().setCurrentFrame(30);
    const before = useHistoryStore.getState().undoStack.length;
    const id = state().addTitle('lowerThird');
    const clip = state().project.clips[id];
    expect(clip.title?.preset).toBe('lowerThird');
    expect(clip.trackId).toBe(v2);
    expect(clip.startFrame).toBe(30);
    expect(clip.durationFrames).toBe(5 * state().project.fps);
    expect(state().ui.selectedClipIds).toEqual([id]);
    expect(useHistoryStore.getState().undoStack.length).toBe(before + 1);

    // A new track on top when there is no room above.
    const second = state().addTitle('title');
    const rows = timelineRows(state().project.tracks);
    expect(rows[0].id).toBe(state().project.clips[second].trackId);
    expect(rows.filter((track) => track.type === 'video')).toHaveLength(3);
  });

  it('renames the clip after its text, and a typing run is one undo step', () => {
    const id = state().addTitle('title');
    const before = useHistoryStore.getState().undoStack.length;
    for (const text of ['H', 'He', 'Hel', 'Hello']) state().updateTitle(id, { text }, `title:${id}:text`);
    expect(state().project.clips[id].name).toBe('Hello');
    expect(useHistoryStore.getState().undoStack.length).toBe(before + 1);
    state().undo();
    expect(state().project.clips[id].title?.text).toBe('Title');
  });

  it('keeps a changed setting in range', () => {
    const id = state().addTitle('title');
    state().updateTitle(id, { style: { fontSize: -5, letterSpacing: 400 } });
    const style = state().project.clips[id].title!.style;
    expect(style.fontSize).toBe(4);
    expect(style.letterSpacing).toBe(100);
  });

  it('is never pasted onto an audio track', () => {
    const id = state().addTitle('title');
    const copied = state().project.clips[id];
    const audioOnly = { ...state().project, tracks: state().project.tracks.map((track) => ({ ...track, locked: track.type !== 'audio' })) };
    const pasted = pasteClips(audioOnly, { clips: [copied], trackTypes: {} }, 0, []);
    expect(pasted.pastedIds).toHaveLength(0);
  });
});

describe('the title colour on the timeline', () => {
  it('keeps the clip name and the missing-font mark readable (4.5:1)', () => {
    expect(contrastOf('#e2e8f0', TRACK_TYPE_COLORS.text)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrastOf('#fde68a', TRACK_TYPE_COLORS.text)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });
});
