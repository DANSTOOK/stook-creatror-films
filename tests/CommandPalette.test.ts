import { describe, expect, it } from 'vitest';
import { acceleratorLabel, flattenMenu, normalise, rank, score, type PaletteCommand } from '@renderer/components/CommandPalette/commands';
import type { AppMenuEntry } from '@shared/types/ipc';

/**
 * Finding a function by name.
 *
 * The list the palette searches is the application menu, so these tests work
 * on menu trees shaped like the real one - submenus, separators, ticks, and
 * items with no id, which exist in the menu but cannot be run by one.
 *
 * That every command in the menu is actually reachable is checked in the app
 * itself, against the menu the running app builds; no fixture here could
 * promise that.
 */

const menu: AppMenuEntry[] = [
  {
    label: 'File',
    type: 'submenu',
    enabled: true,
    submenu: [
      { id: 'new', label: 'New project', type: 'normal', enabled: true, accelerator: 'CmdOrCtrl+N' },
      { id: 'save', label: 'Save', type: 'normal', enabled: false, accelerator: 'CmdOrCtrl+S' },
      { label: '', type: 'separator', enabled: true },
      { id: 'saveAs', label: 'Save as…', type: 'normal', enabled: false },
      // No id: a menu item the page cannot invoke by name.
      { label: 'Exit', type: 'normal', enabled: true },
    ],
  },
  {
    label: 'View',
    type: 'submenu',
    enabled: true,
    submenu: [
      { id: 'toggleMedia', label: 'Show media', type: 'checkbox', enabled: true, checked: true },
      { id: 'resetLayout', label: 'Reset layout', type: 'normal', enabled: true },
    ],
  },
];

const ids = (commands: readonly PaletteCommand[]): string[] => commands.map((command) => command.id);

describe('the menu as a list of commands', () => {
  it('finds every item that can be run, and nothing else', () => {
    expect(ids(flattenMenu(menu))).toEqual(['new', 'save', 'saveAs', 'toggleMedia', 'resetLayout']);
  });

  it('remembers which menu each came from, so a row can say where it lives', () => {
    const commands = flattenMenu(menu);
    expect(commands.find((command) => command.id === 'new')?.group).toBe('File');
    expect(commands.find((command) => command.id === 'resetLayout')?.group).toBe('View');
  });

  it('carries the shortcut, the enabled state and the tick', () => {
    const commands = flattenMenu(menu);
    const save = commands.find((command) => command.id === 'save');
    expect(save).toMatchObject({ accelerator: 'CmdOrCtrl+S', enabled: false });
    expect(commands.find((command) => command.id === 'toggleMedia')?.checked).toBe(true);
    // An action is not a tick, and must not be labelled as off.
    expect(commands.find((command) => command.id === 'new')?.checked).toBeUndefined();
  });

  it('walks nested submenus and names them in the path', () => {
    const nested: AppMenuEntry[] = [
      {
        label: 'Timeline',
        type: 'submenu',
        enabled: true,
        submenu: [
          {
            label: 'Captions',
            type: 'submenu',
            enabled: true,
            submenu: [{ id: 'importCaptions', label: 'Import subtitles', type: 'normal', enabled: true }],
          },
        ],
      },
    ];
    expect(flattenMenu(nested)[0]).toMatchObject({ id: 'importCaptions', group: 'Timeline / Captions' });
  });
});

describe('what somebody typed', () => {
  it('ignores case and accents, which a Spanish keyboard charges two keys for', () => {
    expect(normalise('Márgenes SEGUROS')).toBe('margenes seguros');
    expect(normalise('Añadir título')).toBe('anadir titulo');
  });

  const command = (label: string, group = 'File', enabled = true): PaletteCommand => ({ id: label, label, group, enabled });

  it('matches every word, in any order', () => {
    const subtitles = command('Export subtitles', 'Timeline');
    expect(score(subtitles, 'export sub')).toBeGreaterThan(0);
    expect(score(subtitles, 'sub export')).toBeGreaterThan(0);
    expect(score(subtitles, 'export audio')).toBe(0);
  });

  it('finds a Spanish name typed without its accent', () => {
    expect(score(command('Añadir título'), 'anadir titulo')).toBeGreaterThan(0);
    expect(score(command('Márgenes seguros'), 'margenes')).toBeGreaterThan(0);
  });

  it('puts the start of a name above the middle of one', () => {
    expect(score(command('Save'), 'sa')).toBeGreaterThan(score(command('Autosave'), 'sa'));
  });

  it('puts a name above the menu it sits in', () => {
    const inName = command('View full screen', 'Window');
    const inMenu = command('Reset layout', 'View');
    expect(score(inName, 'view')).toBeGreaterThan(score(inMenu, 'view'));
  });

  it('prefers the shorter of two names that both match', () => {
    expect(score(command('Save'), 'save')).toBeGreaterThan(score(command('Save as…'), 'save'));
  });

  it('shows everything when nothing has been typed yet', () => {
    expect(ids(rank(flattenMenu(menu), ''))).toHaveLength(5);
    expect(ids(rank(flattenMenu(menu), '   '))).toHaveLength(5);
  });

  it('sinks what cannot be run right now, without hiding it', () => {
    // Save is disabled in the fixture; typing its name still finds it, last.
    const matches = rank(flattenMenu(menu), 'save');
    expect(ids(matches)).toContain('save');
    expect(matches.every((item) => !item.enabled)).toBe(true);

    const mixed = rank(flattenMenu(menu), 's');
    const enabledFirst = mixed.findIndex((item) => !item.enabled);
    expect(mixed.slice(0, enabledFirst).every((item) => item.enabled)).toBe(true);
  });

  it('answers with nothing rather than everything when there is no match', () => {
    expect(rank(flattenMenu(menu), 'xyzzy')).toEqual([]);
  });

  it('keeps the list short enough to show', () => {
    const many = Array.from({ length: 200 }, (_, index) => command(`Command ${index}`));
    expect(rank(many, 'command')).toHaveLength(40);
    expect(rank(many, 'command', 5)).toHaveLength(5);
  });
});

describe('the key beside a name', () => {
  it('reads as the key on the keyboard, not as Electron writes it', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+S')).toBe('Ctrl+Shift+S');
    expect(acceleratorLabel('CommandOrControl+N')).toBe('Ctrl+N');
    // The shortcuts list is on "?", which is how it is typed, not Shift+/.
    expect(acceleratorLabel('Shift+/')).toBe('?');
    expect(acceleratorLabel(undefined)).toBeUndefined();
  });
});
