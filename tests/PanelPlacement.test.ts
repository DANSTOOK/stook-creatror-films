import { describe, expect, it } from 'vitest';
import { placePanelWindow } from '../src/main/panelPlacement';

/**
 * A panel's window reopens where it was last - unless that was on a monitor
 * that is gone, where it would be lost with no title bar to drag it back by.
 */

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };

describe('placing a panel window', () => {
  it('leaves a window on a screen where it is', () => {
    const bounds = { x: 2100, y: 120, width: 1100, height: 720 };
    expect(placePanelWindow(bounds, 36, [primary, second], primary)).toBe(bounds);
  });

  it('brings a window from a monitor that is gone to the middle of the editor\'s', () => {
    const bounds = { x: 2100, y: 120, width: 1100, height: 720 };
    expect(placePanelWindow(bounds, 36, [primary], primary)).toEqual({ x: 410, y: 160, width: 1100, height: 720 });
  });

  it('counts only a title bar that can be grabbed, not one grazing an edge', () => {
    // Everything but four pixels of the bar is off the bottom of the screen.
    const bounds = { x: 100, y: 1038, width: 600, height: 400 };
    expect(placePanelWindow(bounds, 36, [primary], primary)).not.toBe(bounds);
  });

  it('shrinks a window bigger than the screen it is brought to', () => {
    const bounds = { x: -5000, y: -5000, width: 2560, height: 1400 };
    expect(placePanelWindow(bounds, 36, [primary], primary)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
});
