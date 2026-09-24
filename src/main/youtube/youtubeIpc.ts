import { app, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IPC,
  type YouTubeStatus,
  type YouTubeUploadMeta,
  type YouTubeUploadResult,
} from '@shared/types/ipc';
import { isFinishedExport } from '../ipc/fileSystem';
import { GOOGLE_ENDPOINTS, YouTubeClient, type OAuthClient, type YouTubeEndpoints } from './YouTubeClient';

/**
 * YouTube, from the export dialog.
 *
 * What is kept on disk is the Google OAuth client the user created - its ID
 * and the "secret" Google issues to desktop apps, which names the app and
 * which Google itself says an installed app cannot keep secret. It is still
 * encrypted with the OS keychain when there is one. No password, token or
 * anything about the account is ever written: those live in YouTubeClient,
 * in memory, for this session.
 */

/** YouTube Studio's upload page; it opens the "Upload videos" dialog. */
export const YOUTUBE_UPLOAD_PAGE = 'https://www.youtube.com/upload';

const settingsPath = (): string => join(app.getPath('userData'), 'youtube-client.json');

interface StoredClient {
  clientId: string;
  /** base64, encrypted by safeStorage when `encrypted`. */
  secret: string;
  encrypted: boolean;
}

function readClient(): OAuthClient | null {
  try {
    const stored = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<StoredClient>;
    if (typeof stored.clientId !== 'string' || typeof stored.secret !== 'string') return null;
    const bytes = Buffer.from(stored.secret, 'base64');
    const clientSecret = stored.encrypted ? safeStorage.decryptString(bytes) : bytes.toString('utf8');
    return { clientId: stored.clientId, clientSecret };
  } catch {
    return null;
  }
}

function writeClient(client: OAuthClient): void {
  const encrypted = safeStorage.isEncryptionAvailable();
  const secret = encrypted
    ? safeStorage.encryptString(client.clientSecret).toString('base64')
    : Buffer.from(client.clientSecret, 'utf8').toString('base64');
  const stored: StoredClient = { clientId: client.clientId, secret, encrypted };
  writeFileSync(settingsPath(), JSON.stringify(stored, null, 2), 'utf8');
}

/**
 * The tests stand in for Google on 127.0.0.1. Nothing else is accepted, so
 * the variable cannot send a sign-in anywhere but this machine.
 */
function endpointsFromEnvironment(): YouTubeEndpoints {
  const base = process.env.SCF_YOUTUBE_ENDPOINT;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return GOOGLE_ENDPOINTS;
  return { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, upload: base };
}

/** A Google client ID for a desktop app ends like this. */
export const looksLikeClientId = (value: string): boolean =>
  /^[\w-]+\.apps\.googleusercontent\.com$/.test(value.trim());

export function registerYouTubeHandlers(getWindow: () => BrowserWindow | null): void {
  const client = new YouTubeClient((url) => shell.openExternal(url), endpointsFromEnvironment());

  const status = (): YouTubeStatus => {
    const stored = readClient();
    return { configured: stored !== null, clientId: stored?.clientId ?? '', signedIn: client.signedIn };
  };

  ipcMain.handle(IPC.youtubeStatus, () => status());

  ipcMain.handle(IPC.youtubeConfigure, async (_event, clientId: unknown, clientSecret: unknown) => {
    if (typeof clientId !== 'string' || !looksLikeClientId(clientId)) {
      throw new Error('That is not a Google client ID. It ends in .apps.googleusercontent.com.');
    }
    if (typeof clientSecret !== 'string' || clientSecret.trim().length < 8) {
      throw new Error('Paste the client secret from the same Google client.');
    }
    // A different client: the old sign-in belongs to the old one.
    if (client.signedIn) await client.signOut();
    writeClient({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    return status();
  });

  ipcMain.handle(IPC.youtubeForgetClient, async () => {
    await client.signOut();
    rmSync(settingsPath(), { force: true });
    return status();
  });

  ipcMain.handle(IPC.youtubeSignIn, async () => {
    const stored = readClient();
    if (!stored) throw new Error('Enter the Google client first.');
    await client.signIn(stored);
    // The browser has the focus now; bring the editor back.
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    return status();
  });

  ipcMain.handle(IPC.youtubeCancelSignIn, () => client.cancelSignIn());

  ipcMain.handle(IPC.youtubeSignOut, async () => {
    await client.signOut();
    return status();
  });

  ipcMain.handle(
    IPC.youtubeUpload,
    async (_event, path: unknown, meta: YouTubeUploadMeta): Promise<YouTubeUploadResult> => {
      // Only what this session rendered: the page cannot name any file on the
      // disk and have it sent to the internet.
      if (typeof path !== 'string' || !isFinishedExport(path)) {
        throw new Error('Only a video exported in this session can be uploaded.');
      }
      let lastSentAt = 0;
      return client.uploadVideo(path, meta, (sent, total) => {
        const now = Date.now();
        if (sent < total && now - lastSentAt < 150) return;
        lastSentAt = now;
        getWindow()?.webContents.send(IPC.youtubeProgress, { sent, total });
      });
    },
  );

  ipcMain.handle(IPC.youtubeCancelUpload, () => client.cancelUpload());

  ipcMain.handle(IPC.youtubeOpenStudio, async (_event, path: unknown) => {
    if (typeof path === 'string' && isFinishedExport(path)) shell.showItemInFolder(path);
    await shell.openExternal(YOUTUBE_UPLOAD_PAGE);
  });
}
