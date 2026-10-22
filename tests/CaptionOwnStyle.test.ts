import { describe, expect, it } from 'vitest';
import type { Clip, ProjectState } from '@shared/types';
import { captionStyle, withCaptionOverride, withCaptionTitles } from '@renderer/captions/captionRender';
import { normalizeCaption, normalizeCaptionStyle } from '@renderer/captions/normalize';

const settings = { preset: 'classic' as const, language: 'es' as const };
const frame = { width: 1920, height: 1080 };

describe('one caption with a look of its own', () => {
  const base = captionStyle(settings, frame);

  it('changes only what it says, over the track look', () => {
    const own = withCaptionOverride(base, { color: '#ffd400', bold: true, scale: 1.5 });
    expect(own.color).toBe('#ffd400');
    expect(own.fontWeight).toBe(800);
    expect(own.fontSize).toBe(Math.round(base.fontSize * 1.5));
    expect(own.fontFamily).toBe(base.fontFamily);
    expect(own.stroke).toEqual(base.stroke);
    expect(withCaptionOverride(base, undefined)).toBe(base);
  });

  it('a band puts a box behind it, and no shadow under the letters', () => {
    const own = withCaptionOverride(base, { band: '#102040' });
    expect(own.box).toMatchObject({ enabled: true, color: '#102040' });
    expect(own.shadow.enabled).toBe(false);
  });

  it('a saved look is kept only in parts it can draw', () => {
    expect(normalizeCaptionStyle({ color: '#FFD400', bold: true, scale: 9, band: 'red', extra: 1 })).toEqual({ color: '#ffd400', bold: true, scale: 2 });
    expect(normalizeCaptionStyle({ scale: 1 })).toBeUndefined();
    expect(normalizeCaption({ text: 'Hola', style: { color: '#00ff00' } }).style).toEqual({ color: '#00ff00' });
    expect(normalizeCaption({ text: 'Hola' }).style).toBeUndefined();
  });

  it('on the timeline, only that caption is drawn its own way', () => {
    const caption = (id: string, start: number, style?: object): Clip =>
      ({
        id,
        trackId: 'cap',
        name: id,
        sourceUri: '',
        startFrame: start,
        durationFrames: 30,
        sourceOffsetFrames: 0,
        transform: { position: [], scale: [], rotation: [], opacity: [], anchorPoint: { x: 0.5, y: 0.5 } },
        volume: 1,
        pan: 0,
        caption: { text: id, ...(style ? { style } : {}) },
      }) as unknown as Clip;
    const project = {
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [{ id: 'cap', type: 'captions', captions: settings, order: 0, visible: true }],
      clips: { plain: caption('plain', 0), loud: caption('loud', 30, { color: '#ffd400' }) },
    } as unknown as ProjectState;
    const drawn = withCaptionTitles(project);
    expect(drawn.clips.plain.title?.style.color).toBe(base.color);
    expect(drawn.clips.loud.title?.style.color).toBe('#ffd400');
  });
});
