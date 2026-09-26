import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, LogOut, Upload, Youtube } from 'lucide-react';
import type {
  YouTubePrivacy,
  YouTubeProgressEvent,
  YouTubeStatus,
  YouTubeUploadResult,
} from '@shared/types/ipc';
import { useT, type MessageKey } from '@renderer/i18n';
import { errorText } from '@renderer/errorText';

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

const PRIVACY_LABELS: Record<YouTubePrivacy, MessageKey> = {
  private: 'yt.private',
  unlisted: 'yt.unlisted',
  public: 'yt.public',
};

const openLink = (url: string): void => {
  // The main process sends every window.open to the system browser.
  window.open(url, '_blank');
};

const formatMegabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

export interface YouTubePanelProps {
  /** The file the export just finished writing. */
  path: string;
  defaultTitle: string;
  /** "Upload from here" opened or closed: the dialog lays the panel out full width while open. */
  onExpandedChange?(expanded: boolean): void;
}

export function YouTubePanel({ path, defaultTitle, onExpandedChange }: YouTubePanelProps): JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => onExpandedChange?.(expanded), [expanded, onExpandedChange]);
  // Gone with its export (New export): the dialog goes back to two columns.
  useEffect(() => () => onExpandedChange?.(false), [onExpandedChange]);
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
      if (madeForKids === null) throw new Error(t('yt.kidsRequired'));
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
    <section data-testid="youtube-panel" data-state={expanded ? 'open' : 'closed'} className="space-y-3 rounded-lg border border-panel-700 bg-panel-950 p-4">
      <div className="space-y-1">
        <h3 className="field-label flex items-center gap-1.5">
          <Youtube size={14} />
          {t('yt.title')}
        </h3>
        <p className="text-2xs leading-relaxed text-slate-400">{t('yt.intro')}</p>
      </div>
      {/* Side by side once the panel is full width; stacked in the narrow column. */}
      <div className={`flex gap-2 ${expanded ? 'flex-row flex-wrap' : 'flex-col'}`}>
        <button
          type="button"
          data-testid="youtube-open-studio"
          className="tool-button border border-panel-600"
          title={t('yt.studioHint')}
          onClick={() => void run(() => window.filmora.youtubeOpenStudio(path))}
        >
          <ExternalLink size={13} />
          {t('yt.studio')}
        </button>
        <button
          type="button"
          data-testid="youtube-direct"
          aria-expanded={expanded}
          className={`tool-button border ${expanded ? 'tool-button-active border-transparent' : 'border-panel-600'}`}
          onClick={() => setExpanded((open) => !open)}
        >
          <Upload size={13} />
          {t('yt.direct')}
        </button>
      </div>

      {expanded && status === null && (
        <p className="flex items-center gap-2 text-2xs text-slate-400">
          <Loader2 size={12} className="animate-spin" />
          {t('yt.checking')}
        </p>
      )}

      {/* Step one, once per machine: the user's own Google client. */}
      {expanded && status && !status.configured && (
        <div data-testid="youtube-setup" className="space-y-2">
          <p className="text-2xs leading-relaxed text-slate-300">{t('yt.setupIntro')}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-2xs leading-relaxed text-slate-400">
            <li>{t('yt.step1')}</li>
            <li>{t('yt.step2')}</li>
            <li>{t('yt.step3')}</li>
          </ol>
          <button type="button" className="tool-button h-7" onClick={() => openLink(CONSOLE_URL)}>
            <ExternalLink size={13} />
            {t('yt.openConsole')}
          </button>
          <div className="grid gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">{t('yt.clientId')}</span>
              <input
                className="numeric-input"
                spellCheck={false}
                placeholder="....apps.googleusercontent.com"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">{t('yt.clientSecret')}</span>
              <input
                type="password"
                className="numeric-input"
                spellCheck={false}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </label>
          </div>
          <p className="text-2xs text-slate-400">{t('yt.clientNote')}</p>
          <button
            type="button"
            className="tool-button tool-button-active h-7"
            disabled={!clientId.trim() || !clientSecret.trim()}
            onClick={() => void saveClient()}
          >
            {t('yt.save')}
          </button>
        </div>
      )}

      {/* Step two, once per session: permission to upload, in the browser. */}
      {expanded && status?.configured && !status.signedIn && (
        <div className="space-y-2">
          <p className="text-2xs leading-relaxed text-slate-300">{t('yt.signInIntro')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {signingIn ? (
              <>
                <span className="flex items-center gap-2 text-2xs text-slate-300">
                  <Loader2 size={12} className="animate-spin" />
                  {t('yt.waiting')}
                </span>
                <button type="button" className="tool-button h-7" onClick={() => void window.filmora.youtubeCancelSignIn()}>
                  {t('yt.cancel')}
                </button>
              </>
            ) : (
              <button type="button" data-testid="youtube-sign-in" className="tool-button tool-button-active h-7" onClick={() => void signIn()}>
                {t('yt.signIn')}
              </button>
            )}
            <button
              type="button"
              className="tool-button h-7 text-slate-400"
              disabled={signingIn}
              title={t('yt.forgetClientHint', { id: status.clientId })}
              onClick={() => void run(async () => setStatus(await window.filmora.youtubeForgetClient()))}
            >
              {t('yt.forgetClient')}
            </button>
          </div>
        </div>
      )}

      {/* Step three: what the video is, then send it. */}
      {expanded && status?.signedIn && (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-slate-400">{t('yt.videoTitle')}</span>
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
              <span className="text-2xs text-slate-400">{t('yt.visibility')}</span>
              <select
                data-testid="youtube-privacy"
                className="numeric-input"
                value={privacy}
                disabled={uploading}
                onChange={(event) => setPrivacy(event.target.value as YouTubePrivacy)}
              >
                {(Object.keys(PRIVACY_LABELS) as YouTubePrivacy[]).map((value) => (
                  <option key={value} value={value}>
                    {t(PRIVACY_LABELS[value])}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-slate-400">{t('yt.description')}</span>
            <textarea
              className="numeric-input h-16 resize-y py-1"
              value={description}
              disabled={uploading}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <fieldset className="flex flex-wrap items-center gap-3 text-xs text-slate-200" disabled={uploading}>
            <legend className="sr-only">{t('yt.kids')}</legend>
            <span className="text-2xs text-slate-400">{t('yt.kidsQuestion')}</span>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="youtube-kids"
                data-testid="youtube-kids-no"
                className="accent-accent"
                checked={madeForKids === false}
                onChange={() => setMadeForKids(false)}
              />
              {t('yt.no')}
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="youtube-kids"
                className="accent-accent"
                checked={madeForKids === true}
                onChange={() => setMadeForKids(true)}
              />
              {t('yt.yes')}
            </label>
          </fieldset>
          {privacy !== 'private' && (
            <p className="text-2xs text-amber-300">{t('yt.auditNote')}</p>
          )}

          {(uploading || progress) && !result && (
            <div className="space-y-1">
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-panel-700"
                role="progressbar"
                aria-label={t('yt.progressLabel')}
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
                  {t('yt.progress', { sent: formatMegabytes(progress.sent), total: formatMegabytes(progress.total), percent: percent.toFixed(0) })}
                </p>
              )}
            </div>
          )}

          {result && (
            <div data-testid="youtube-result" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-2xs text-emerald-200">
              {t('yt.uploaded')}{' '}
              <button type="button" className="underline" onClick={() => openLink(result.url)}>
                {result.url}
              </button>{' '}
              - {t(PRIVACY_LABELS[result.privacy])}.
              {result.privacy !== result.requestedPrivacy && (
                <span className="block pt-1 text-amber-200">
                  {t('yt.madePrivate')}{' '}
                  <button type="button" className="underline" onClick={() => openLink(STUDIO_URL)}>
                    {t('yt.studioName')}
                  </button>
                  .
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {uploading ? (
              <button type="button" className="tool-button h-7" onClick={() => void window.filmora.youtubeCancelUpload()}>
                {t('yt.cancelUpload')}
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
                {result ? t('yt.uploadAgain') : t('yt.upload')}
              </button>
            )}
            <button
              type="button"
              className="tool-button h-7 text-slate-400"
              disabled={uploading}
              title={t('yt.signOutHint')}
              onClick={() => void run(async () => setStatus(await window.filmora.youtubeSignOut()))}
            >
              <LogOut size={13} />
              {t('yt.signOut')}
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
