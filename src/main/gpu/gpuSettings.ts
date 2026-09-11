import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GpuPreference } from '@shared/types';
import { isGpuPreference, switchForPreference } from './classify';

/**
 * The saved GPU preference.
 *
 * It lives in the app's own settings file, not in the project: which GPU to
 * composite on is a property of the machine, and a project opened on a desktop
 * with one GPU must not inherit a laptop's "use the integrated one".
 *
 * Chromium picks its adapter once, at startup, from a command-line switch -
 * and switches are only honoured when appended before `ready`. So this is read
 * synchronously at module load, and a change is written for the NEXT launch.
 */

const settingsPath = (): string => join(app.getPath('userData'), 'gpu-settings.json');

/**
 * The preference the NEXT launch will use. An `FILMORA_GPU` override wins over
 * the file, so while it is set the saved value is not what a restart applies -
 * and reporting the file would show a "restart to apply" banner that lies.
 */
export function effectiveGpuPreference(): GpuPreference {
  const override = process.env.FILMORA_GPU;
  return isGpuPreference(override) ? override : readGpuPreference();
}

export function readGpuPreference(): GpuPreference {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { preference?: unknown };
    return isGpuPreference(parsed.preference) ? parsed.preference : 'auto';
  } catch {
    // No file yet, or a corrupted one: let the OS decide.
    return 'auto';
  }
}

export function writeGpuPreference(preference: GpuPreference): void {
  writeFileSync(settingsPath(), JSON.stringify({ preference }, null, 2), 'utf8');
}

/** The preference this process was started with. Set once, before ready. */
let applied: GpuPreference = 'auto';

export const appliedGpuPreference = (): GpuPreference => applied;

/**
 * Append the switch for the saved preference. Must run before `app.whenReady`
 * resolves; afterwards Chromium has already chosen its adapter.
 *
 * `FILMORA_GPU` overrides the saved value, which is how the tests pin a GPU
 * without touching the user's settings.
 */
export function applyGpuPreferenceAtStartup(): GpuPreference {
  applied = effectiveGpuPreference();

  const flag = switchForPreference(applied);
  if (flag) app.commandLine.appendSwitch(flag);
  return applied;
}
