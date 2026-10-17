import { describe, expect, it } from 'vitest';
import { spaceFromSlider } from '@renderer/hooks/spaceFromSlider';

/**
 * "Space stops working": a slider keeps the focus after it is clicked or
 * dragged, and the editor's shortcuts used to leave every key alone while an
 * input had the focus - so Space after touching opacity or volume did
 * nothing. Reproduced in the running app on v1.41 (tests/ui/playhead-layers:
 * focus on a range input, Space, playhead still at frame 0).
 */

const key = (target: unknown, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: ' ', target, ctrlKey: false, metaKey: false, altKey: false, ...extra }) as KeyboardEvent;
const input = (type: string, inDialog = false) => ({ tagName: 'INPUT', type, closest: () => (inDialog ? {} : null) });

describe('Space on a slider', () => {
  it('a slider that kept the focus after a drag lets Space through to the transport', () => {
    expect(spaceFromSlider(key(input('range')))).toBe(true);
  });

  it('a text or number field keeps its Space, and so does a slider in a dialog', () => {
    expect(spaceFromSlider(key(input('text')))).toBe(false);
    expect(spaceFromSlider(key(input('number')))).toBe(false);
    expect(spaceFromSlider(key(input('range', true)))).toBe(false);
    expect(spaceFromSlider(key({ tagName: 'TEXTAREA', type: '', closest: () => null }))).toBe(false);
    expect(spaceFromSlider(key({ tagName: 'SELECT', type: 'select-one', closest: () => null }))).toBe(false);
  });

  it('only Space, and only without a modifier', () => {
    expect(spaceFromSlider(key(input('range'), { key: 'ArrowLeft' }))).toBe(false);
    expect(spaceFromSlider(key(input('range'), { key: 'k' }))).toBe(false);
    expect(spaceFromSlider(key(input('range'), { ctrlKey: true }))).toBe(false);
    expect(spaceFromSlider(key(input('range'), { altKey: true }))).toBe(false);
  });

  it('nothing focused is not a slider', () => {
    expect(spaceFromSlider(key(null))).toBe(false);
  });
});
