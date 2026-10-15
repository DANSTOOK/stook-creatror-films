import type { AppMenuEntry } from '@shared/types/ipc';
import { keyLabel } from '@renderer/i18n';

/**
 * Finding a function by name.
 *
 * The list is not written here: it is the application menu itself, as the
 * main process reports it (IPC appMenuModel, the same model the title bar
 * draws). So whatever the menus can do, this finds - with the labels of the
 * language in use, the real shortcut, and the real enabled state - and a
 * command added to the menu appears here without anyone remembering to.
 *
 * Everything in this file is pure, and tested against the menu the app
 * actually builds.
 */

export interface PaletteCommand {
  /** The menu item's id, which is what runs it (appMenuInvoke). */
  id: string;
  label: string;
  /** Where it lives, e.g. "File" or "Timeline", for the second line. */
  group: string;
  accelerator?: string;
  enabled: boolean;
  /** For a menu item that is a tick rather than an action. */
  checked?: boolean;
}

/**
 * Every runnable item in the menu tree, depth first.
 *
 * Separators and submenu headers are not commands, and an item with no id
 * cannot be run by id - so neither is listed.
 */
export function flattenMenu(entries: readonly AppMenuEntry[], group = ''): PaletteCommand[] {
  const found: PaletteCommand[] = [];
  for (const entry of entries) {
    if (entry.type === 'separator') continue;
    if (entry.submenu && entry.submenu.length > 0) {
      found.push(...flattenMenu(entry.submenu, group === '' ? entry.label : `${group} / ${entry.label}`));
      continue;
    }
    if (!entry.id) continue;
    found.push({
      id: entry.id,
      label: entry.label,
      group,
      ...(entry.accelerator ? { accelerator: entry.accelerator } : {}),
      enabled: entry.enabled,
      ...(entry.type === 'checkbox' ? { checked: Boolean(entry.checked) } : {}),
    });
  }
  return found;
}

/**
 * For comparing what somebody typed with what is on screen.
 *
 * Accents come off and case goes away, because "Mezclador" has to be found by
 * typing "mezclador" and "Márgenes" by typing "margenes" - on a keyboard
 * where the accent is two keystrokes, requiring it is requiring work for
 * nothing.
 */
export function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * How well a command answers a query: higher is better, 0 means it does not.
 *
 * Every word typed must appear somewhere in the name or its menu, in any
 * order, so "export sub" finds "Export subtitles" and so does "sub export".
 * A word at the start of the name beats one in the middle, and the name
 * beats the menu it sits in - typing "view" should not bury Show media under
 * everything else in the View menu.
 */
export function score(command: PaletteCommand, query: string): number {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;

  const label = normalise(command.label);
  const group = normalise(command.group);
  let total = 0;

  for (const word of words) {
    const inLabel = label.indexOf(word);
    const inGroup = group.indexOf(word);
    if (inLabel === -1 && inGroup === -1) return 0;

    if (inLabel === 0) total += 100;
    else if (inLabel > 0) total += label[inLabel - 1] === ' ' ? 60 : 30;
    else total += inGroup === 0 ? 12 : 8;
  }

  // A short name that matches is usually the one meant: "Save" over "Save as".
  total += Math.max(0, 20 - label.length / 2);
  // Something greyed out cannot be run now, so it goes below what can.
  if (!command.enabled) total -= 500;
  return Math.max(1, total);
}

/** The commands worth showing for a query, best first. */
export function rank(commands: readonly PaletteCommand[], query: string, limit = 40): PaletteCommand[] {
  return commands
    .map((command) => ({ command, points: score(command, query) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points || a.command.label.localeCompare(b.command.label))
    .slice(0, limit)
    .map((entry) => entry.command);
}

/** An Electron accelerator as the keys read in this language: "CmdOrCtrl+Shift+S" to "Ctrl+Mayús+S". */
export function acceleratorLabel(accelerator: string | undefined): string | undefined {
  if (!accelerator) return undefined;
  const plain = accelerator.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/^Shift\+\/$/, '?');
  return keyLabel(plain);
}
