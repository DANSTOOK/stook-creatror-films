import { app, safeStorage } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AzureAccount } from './client';

/**
 * Where the Azure key is kept.
 *
 * It is the person's own key to their own Azure resource, and whoever holds
 * it can spend their quota - so it is encrypted with the operating system's
 * keychain (DPAPI on Windows) exactly as the YouTube client secret is, and
 * written only into the app's own data folder. It never goes into a project
 * file, which people send each other, and never into the renderer: the page
 * asks whether a key is set and is told yes or no, never the key itself.
 *
 * On a system with no keychain, `safeStorage` cannot encrypt. The key is
 * then stored as it is, and `encrypted` says so, so the panel can tell the
 * person the truth rather than implying a protection that is not there.
 */

const settingsPath = (): string => join(app.getPath('userData'), 'azure-speech.json');

interface Stored {
  region: string;
  /** base64; encrypted by safeStorage when `encrypted`. */
  key: string;
  encrypted: boolean;
}

/** The account on this computer, or null when none has been set. */
export function readAccount(): AzureAccount | null {
  try {
    const stored = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Stored>;
    if (typeof stored.region !== 'string' || typeof stored.key !== 'string') return null;
    const bytes = Buffer.from(stored.key, 'base64');
    const key = stored.encrypted ? safeStorage.decryptString(bytes) : bytes.toString('utf8');
    if (!key) return null;
    return { key, region: stored.region };
  } catch {
    // A file written by another account, a keychain that has changed, or no
    // file at all: either way there is no usable key, which is not an error.
    return null;
  }
}

export function writeAccount(account: AzureAccount): void {
  const encrypted = safeStorage.isEncryptionAvailable();
  const key = encrypted
    ? safeStorage.encryptString(account.key).toString('base64')
    : Buffer.from(account.key, 'utf8').toString('base64');
  const stored: Stored = { region: account.region.trim(), key, encrypted };
  writeFileSync(settingsPath(), JSON.stringify(stored, null, 2), 'utf8');
}

export function forgetAccount(): void {
  rmSync(settingsPath(), { force: true });
}

/** Whether the key on disk is protected by the operating system's keychain. */
export const keychainAvailable = (): boolean => safeStorage.isEncryptionAvailable();
