import { describe, expect, it } from 'vitest';
import { clashes, comboOf, eventInit, remapPress } from '@renderer/keys/remap';

const press = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  comboOf({ key, ctrlKey: Boolean(mods.ctrl), metaKey: false, altKey: Boolean(mods.alt), shiftKey: Boolean(mods.shift) });

describe('keys of one\u2019s own', () => {
  it('writes a press the same way whatever its case, and a shifted symbol as itself', () => {
    expect(press('b')).toBe('B');
    expect(press('B', { shift: true })).toBe('Shift+B');
    expect(press('z', { ctrl: true })).toBe('Ctrl+Z');
    expect(press(' ')).toBe('Space');
    expect(press('+', { shift: true })).toBe('+');
    expect(press('Shift', { shift: true })).toBeNull();
  });

  it('a key given to an action sends the editor its own key, and the old one does nothing', () => {
    const custom = { split: 'F' };
    expect(remapPress('F', custom)).toBe('B');
    expect(remapPress('B', custom)).toBe('swallow');
    expect(remapPress('C', custom)).toBeNull();
  });

  it('two actions swapped each answer to the other\u2019s key', () => {
    const custom = { razor: 'V', select: 'C' };
    expect(remapPress('V', custom)).toBe('C');
    expect(remapPress('C', custom)).toBe('V');
  });

  it('says which action a new key would take from', () => {
    expect(clashes('split', 'C', {}).map((action) => action.id)).toEqual(['razor']);
    expect(clashes('split', 'F', {})).toEqual([]);
  });

  it('the key it sends is what a real press would be, code included', () => {
    expect(eventInit('B')).toMatchObject({ key: 'b', code: 'KeyB', ctrlKey: false });
    expect(eventInit('Ctrl+Alt+S')).toMatchObject({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
    expect(eventInit('Space')).toMatchObject({ key: ' ', code: 'Space' });
    expect(eventInit(',')).toMatchObject({ key: ',', code: 'Comma' });
  });
});
