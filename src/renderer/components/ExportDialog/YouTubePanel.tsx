import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, LogOut, Upload, Youtube } from 'lucide-react';
import type {
  YouTubePrivacy,
  YouTubeProgressEvent,
  YouTubeStatus,
  YouTubeUploadResult,
} from '@shared/types/ipc';

/**
 * Sending a finished export to YouTube, two ways.
 *
 * "Open YouTube Studio" needs nothing set up: it shows the file in Explorer
 * and opens YouTube's own upload page in the browser, where it is dragged in.
 *
 * "Upload from here" signs in through Google in the browser - the editor
 * never sees the password - and sends the file with the YouTube Data API.
 * It needs a Google OAuth client the user makes once, and until Google audits
 * that project, YouTube keeps what it uploads private. Both are said here,
 * before anyone spends time on it.
 */

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';
const STUDIO_URL = 'https://studio.youtube.com/';

const PRIVACY_LABELS: Record<YouTubePrivacy, string> = {
  private: 'Private',
  unlisted: 'Unlisted',
  public: 'Public',
};

const openLink = (url: string): void => {
  // The main process sends every window.open to the system browser.
  window.open(url, '_blank');
};

const formatMegabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // ipcRenderer.invoke wraps the main process's message in its own words.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

export interface YouTubePanelProps {
  /** The file the export just finished writing. */
  path: string;
  defaultTitle: string;
}

export function YouTubePanel({ path, defaultTitle }: YouTubePanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<YouTubePrivacy>('private');
  const [madeForKids, setMadeForKids] = useState<boolean | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<YouTubeProgressEvent | null>(null);
  const [result, setResult] = useState<YouTubeUploadResult | null>(null);

  useEffect(() => {
    if (!expanded || status) return;
    void window.filmora.youtubeStatus().then(setStatus);
  }, [expanded, status]);

  useEffect(() => window.filmora.onYouTubeProgress(setProgress), []);

  // A new export is a new video: start its upload afresh.
  useEffect(() => {
    setResult(null);
    setProgress(null);
    setTitle(defaultTitle);
  }, [path, defaultTitle]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught));
    }
  }, []);

  const saveClient = (): Promise<void> =>
    run(async () => {
      setStatus(await window.filmora.youtubeConfigure(clientId, clientSecret));
      setClientSecret('');
    });

  const signIn = (): Promise<void> =>
    run(async () => {
      setSigningIn(true);
      try {
        setStatus(await window.filmora.youtubeSignIn());
      } finally {
        setSigningIn(false);
      }
    });

  const upload = (): Promise<void> =>
    run(async () => {
      if (madeForKids === null) throw new Error('Say whether the video is made for kids - YouTube asks for every upload.');
      setUploading(true);
      setResult(null);
      try {
        setResult(await window.filmora.youtubeUpload(path, { title, description, privacy, madeForKids }));
      } finally {
        setUploading(false);
      }
    });

  const percent = progress && progress.total > 0 ? (progress.sent / progress.total) * 100 : 0;

  return (
    // A column beside the export's result card, so everything here stacks:
    // the two ways in, then the form of the one that was opened.
    <section data-testid="youtube-panel" className="space-y-3 rounded-lg border border-panel-700 bg-panel-950 p-4">
      <div className="space-y-1">
        <h3 className="field-label flex items-center gap-1.5">
          <Youtube size={14} />
          Share to YouTube
        </h3>
        <p className="text-2xs leading-relaxed text-slate-400">
          Open YouTube Studio and drag the file in, or upload it from here.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="youtube-open-studio"
          className="tool-button border border-panel-600"
          title="Show the file in Explorer and open YouTube's upload page in your browser - drag the file in there"
          onClick={() => void run(() => window.filmora.youtubeOpenStudio(path))}
        >
          <ExternalLink size={13} />
          Open YouTube Studio
        </button>
        <button
          type="button"
          data-testid="youtube-direct"
          aria-expanded={expanded}
          className={`tool-button border ${expanded ? 'tool-button-active border-transparent' : 'border-panel-600'}`}
          onClick={() => setExpanded((open) => !open)}
        >
          <Upload size={13} />
          Upload from here
        </button>
      </div>

      {expanded && status === null && (
        <p className="flex items-center gap-2 text-2xs text-slate-400">
          <Loader2 size={12} className="animate-spin" />
          Checking the connection...
        </p>
      )}

      {/* Step one, once per machine: the user's own Google client. */}
      {expanded && status && !status.configured && (
        <div data-testid="youtube-setup" className="space-y-2">
          <p className="text-2xs leading-relaxed text-slate-300">
            Uploading from the editor goes through your own Google project. You sign in on Google&apos;s page in
            your browser; the editor never sees your password, and it forgets the sign-in when it closes.
          </p>
          <ol className="list-decimal space-y-0.5 pl-5 text-2xs leading-relaxed text-slate-400">
            <li>In Google Cloud, create a project and enable the YouTube Data API v3.</li>
            <li>Under the OAuth consent screen, choose External and add your own account as a test user.</li>
            <li>Under Credentials, create an OAuth client ID of type Desktop app, then paste it here.</li>
          </ol>
          <button type="button" className="tool-button h-7" onClick={() => openLink(CONSOLE_URL)}>
            <ExternalLink size={13} />
            Open Google Cloud credentials
          </button>
          <div className="grid gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">Client ID</span>
              <input
                className="numeric-input"
                spellCheck={false}
                placeholder="....apps.googleusercontent.com"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">Client secret</span>
              <input
                type="password"
                className="numeric-input"
                spellCheck={false}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </label>
          </div>
          <p className="text-2xs text-slate-400">
            These name your Google project, not your account; they are kept encrypted on this computer.
          </p>
          <button
            type="button"
            className="tool-button tool-button-active h-7"
            disabled={!clientId.trim() || !clientSecret.trim()}
            onClick={() => void saveClient()}
          >
            Save
          </button>
        </div>
      )}

      {/* Step two, once per session: permission to upload, in the browser. */}
      {expanded && status?.configured && !status.signedIn && (
        <div className="space-y-2">
          <p className="text-2xs leading-relaxed text-slate-300">
            Google&apos;s sign-in opens in your browser. The editor only asks to add videos - it cannot see, change
            or delete anything on your channel.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {signingIn ? (
              <>
                <span className="flex items-center gap-2 text-2xs text-slate-300">
                  <Loader2 size={12} className="animate-spin" />
                  Waiting for the browser...
                </span>
                <button type="button" className="tool-button h-7" onClick={() => void window.filmora.youtubeCancelSignIn()}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" data-testid="youtube-sign-in" className="tool-button tool-button-active h-7" onClick={() => void signIn()}>
                Sign in with Google
              </button>
            )}
            <button
              type="button"
              className="tool-button h-7 text-slate-400"
              disabled={signingIn}
              title={`Remove the Google client ${status.clientId}`}
              onClick={() => void run(async () => setStatus(await window.filmora.youtubeForgetClient()))}
            >
              Use another Google client
            </button>
          </div>
        </div>
      )}

      {/* Step three: what the video is, then send it. */}
      {expanded && status?.signedIn && (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">Title</span>
              <input
                data-testid="youtube-title"
                className="numeric-input"
                maxLength={100}
                value={title}
                disabled={uploading}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">Visibility</span>
              <select
                data-testid="youtube-privacy"
                className="numeric-input"
                value={privacy}
                disabled={uploading}
                onChange={(event) => setPrivacy(event.target.value as YouTubePrivacy)}
              >
                {(Object.keys(PRIVACY_LABELS) as YouTubePrivacy[]).map((value) => (
                  <option key={value} value={value}>
                    {PRIVACY_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-slate-400">Description</span>
            <textarea
              className="numeric-input h-16 resize-y py-1"
              value={description}
              disabled={uploading}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <fieldset className="flex flex-wrap items-center gap-3 text-xs text-slate-200" disabled={uploading}>
            <legend className="sr-only">Made for kids</legend>
            <span className="text-2xs text-slate-400">Made for kids?</span>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="youtube-kids"
                data-testid="youtube-kids-no"
                className="accent-blue-500"
                checked={madeForKids === false}
                onChange={() => setMadeForKids(false)}
              />
              No
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="youtube-kids"
                className="accent-blue-500"
                checked={madeForKids === true}
                onChange={() => setMadeForKids(true)}
              />
              Yes
            </label>
          </fieldset>
          {privacy !== 'private' && (
            <p className="text-2xs text-amber-300">
              Until Google audits your project, YouTube keeps uploads from it private. You can change the visibility
              in YouTube Studio afterwards.
            </p>
          )}

          {(uploading || progress) && !result && (
            <div className="space-y-1">
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-panel-700"
                role="progressbar"
                aria-label="Upload"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div
                  className="scf-progress-bar h-full w-full rounded-full bg-accent"
                  style={{ transform: `scaleX(${Math.min(100, percent) / 100})` }}
                />
              </div>
              {progress && (
                <p className="text-2xs tabular-nums text-slate-400">
                  {formatMegabytes(progress.sent)} of {formatMegabytes(progress.total)} ({percent.toFixed(0)}%)
                </p>
              )}
            </div>
          )}

          {result && (
            <div data-testid="youtube-result" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-2xs text-emerald-200">
              Uploaded.{' '}
              <button type="button" className="underline" onClick={() => openLink(result.url)}>
                {result.url}
              </button>{' '}
              - {PRIVACY_LABELS[result.privacy]}.
              {result.privacy !== result.requestedPrivacy && (
                <span className="block pt-1 text-amber-200">
                  YouTube made it private because the Google project has not been audited yet. Change it in{' '}
                  <button type="button" className="underline" onClick={() => openLink(STUDIO_URL)}>
                    YouTube Studio
                  </button>
                  .
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {uploading ? (
              <button type="button" className="tool-button h-7" onClick={() => void window.filmora.youtubeCancelUpload()}>
                Cancel upload
              </button>
            ) : (
              <button
                type="button"
                data-testid="youtube-upload"
                className="tool-button tool-button-active h-7"
                disabled={!title.trim()}
                onClick={() => void upload()}
              >
                <Upload size={13} />
                {result ? 'Upload again' : 'Upload'}
              </button>
            )}
            <button
              type="button"
              className="tool-button h-7 text-slate-400"
              disabled={uploading}
              title="Forget the sign-in and revoke it at Google"
              onClick={() => void run(async () => setStatus(await window.filmora.youtubeSignOut()))}
            >
              <LogOut size={13} />
              Sign out
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded bg-red-500/10 px-2 py-1.5 text-2xs text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}

export default YouTubePanel;
