import type { TtsEngineStatus } from '@shared/types/ipc';
import type { Clip } from '@shared/types';
import { t } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { buildAsset } from '@renderer/media/importMedia';
import { dismissNotification, notify } from '@renderer/notifications/notifications';
import { DEFAULT_CAPTION_SETTINGS } from '@renderer/captions/captionClips';
import { createId } from '@shared/utils/id';

/**
 * Text to speech onto the timeline, from wherever it is asked for: the Text
 * to speech window, a title's "Read aloud", a captions track's "Narrate".
 * The voice is made on this computer (main/tts: Piper, then a clear-voice
 * finish), kept with the app's data, and put at the given frame on a Voice
 * track on the dialogue bus - so music under it ducks - with, when asked,
 * captions of what it says. One undo step a call.
 */

export interface TtsOptions {
  language: 'es' | 'en';
  voice: string;
  speed: number;
  /** Semitones, -6..6. */
  pitch: number;
  /** Clear voice: cleaned, compressed and levelled. */
  enhance: boolean;
  /** Captions of what is said, on a track of their own. */
  captions: boolean;
}

export const TTS_OPTIONS_KEY = 'scf.tts.options';
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** What was chosen last, in the window or anywhere else: kept between sessions. */
export function ttsOptions(uiLanguage: string): TtsOptions {
  let raw: Partial<TtsOptions> = {};
  try {
    raw = JSON.parse(window.localStorage.getItem(TTS_OPTIONS_KEY) ?? '{}') as Partial<TtsOptions>;
  } catch {
    raw = {};
  }
  const number = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    language: raw.language === 'es' || raw.language === 'en' ? raw.language : uiLanguage === 'es' ? 'es' : 'en',
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    speed: number(raw.speed, MIN_SPEED, MAX_SPEED, 1),
    pitch: number(raw.pitch, -6, 6, 0),
    enhance: raw.enhance !== false,
    captions: raw.captions === true,
  };
}

export function rememberTtsOptions(options: TtsOptions): void {
  try {
    window.localStorage.setItem(TTS_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Kept for this session only.
  }
}

/** The voice to speak with: the one chosen, if it is here, else the first present in the language. */
export function voiceFor(status: TtsEngineStatus | null | undefined, options: TtsOptions): string | null {
  const present = (status?.voices ?? []).filter((voice) => voice.present);
  return (present.find((voice) => voice.id === options.voice) ?? present.find((voice) => voice.language === options.language) ?? present[0])?.id ?? null;
}

/** Lines for captions of `text` over `seconds`: a sentence each (long ones in pieces), timed by their length. */
export function captionLines(text: string, seconds: number): Array<{ start: number; end: number; text: string }> {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…;:])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => {
      if (sentence.length <= 84) return [sentence];
      // Long sentences in pieces of a few words, at a comma where there is one.
      const pieces: string[] = [];
      let current = '';
      for (const word of sentence.split(' ')) {
        if (current && (current + ' ' + word).length > 60) {
          pieces.push(current);
          current = word;
        } else current = current ? `${current} ${word}` : word;
        if (/,$/.test(current) && current.length > 30) {
          pieces.push(current);
          current = '';
        }
      }
      if (current) pieces.push(current);
      return pieces;
    });
  const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
  let at = 0;
  return sentences.map((sentence) => {
    const length = (sentence.length / total) * seconds;
    const line = { start: at, end: at + length, text: sentence };
    at += length;
    return line;
  });
}

/** A Voice track free over [start, end), or a new one. */
function voiceTrackFor(start: number, end: number): string {
  const name = t('tts.track');
  const free = (trackId: string): boolean =>
    !Object.values(useProjectStore.getState().project.clips).some((clip) => clip.trackId === trackId && clip.startFrame < end && clip.startFrame + clip.durationFrames > start);
  const existing = useProjectStore.getState().project.tracks.find((track) => track.type === 'audio' && track.name === name && !track.locked && free(track.id));
  if (existing) return existing.id;
  const before = new Set(useProjectStore.getState().project.tracks.map((track) => track.id));
  useProjectStore.getState().addTrack('audio', name);
  const made = useProjectStore.getState().project.tracks.find((track) => !before.has(track.id));
  if (!made) throw new Error('no track');
  useProjectStore.getState().updateTrack(made.id, { bus: 'dialogue' });
  return made.id;
}

/** One line spoken: generated, kept, imported. No timeline change yet. */
async function generate(text: string, options: TtsOptions, voice: string, onProgress?: (fraction: number) => void, job?: string) {
  const jobId = job ?? createId('tts');
  const stop = onProgress ? window.filmora.onTtsProgress?.((event) => event.jobId === jobId && onProgress(event.fraction)) : undefined;
  try {
    const result = await window.filmora.ttsGenerate?.(jobId, { text, voice, speed: options.speed, pitch: options.pitch, enhance: options.enhance });
    if (!result || result.cancelled || !result.path) return null;
    const uri = await window.filmora.mediaUrl(result.path);
    const fps = useProjectStore.getState().project.fps;
    const words = text.trim().split(/\s+/).slice(0, 5).join(' ');
    const asset = await buildAsset({ name: `${t('tts.title')} · ${words}${text.trim().split(/\s+/).length > 5 ? '…' : ''}.wav`, uri, sourcePath: result.path, hasAudio: true }, fps);
    return { asset, seconds: result.durationSeconds || asset.durationSeconds || 0, jobId };
  } finally {
    stop?.();
  }
}

/**
 * `text` spoken from `startFrame`: the clip on a Voice track, and captions of
 * it when the options ask. One undo step. The clip's id, or null if nothing
 * was made (cancelled, or no voice).
 */
export async function speakText(text: string, startFrame: number, options: TtsOptions, voice: string, onProgress?: (fraction: number) => void, jobId?: string): Promise<string | null> {
  if (!text.trim()) return null;
  const made = await generate(text, options, voice, onProgress, jobId);
  if (!made) return null;
  const mark = useHistoryStore.getState().undoStack.length;
  useProjectStore.getState().addAssets([made.asset]);
  const asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === made.asset.sourcePath) ?? made.asset;
  const fps = useProjectStore.getState().project.fps;
  const length = Math.max(1, Math.round(made.seconds * fps));
  const trackId = voiceTrackFor(startFrame, startFrame + length);
  const clipId = useProjectStore.getState().addAssetToTimeline(asset, trackId, startFrame);
  if (options.captions) {
    const start = startFrame / fps;
    const subtitles = captionLines(text, made.seconds).map((line) => ({ startMs: Math.round((start + line.start) * 1000), endMs: Math.round((start + line.end) * 1000), text: line.text }));
    if (subtitles.length > 0) useProjectStore.getState().addCaptionTrack({ subtitles }, { ...DEFAULT_CAPTION_SETTINGS, language: options.language });
  }
  useHistoryStore.getState().squash(mark, 'Text to speech');
  useProjectStore.getState().setUi({ selectedClipIds: [clipId] });
  return clipId;
}

/** A title's own words, read aloud from where it starts. */
export async function readTitleAloud(clip: Clip): Promise<string | null> {
  const text = clip.title?.text ?? clip.caption?.text ?? '';
  return speakWithRemembered(text, clip.startFrame, { captions: false });
}

/** The remembered voice and settings, from `startFrame`; says why when no voice is ready. */
export async function speakWithRemembered(text: string, startFrame: number, overrides: Partial<TtsOptions> = {}): Promise<string | null> {
  const options = { ...ttsOptions(document.documentElement.lang), ...overrides };
  const status = await window.filmora.ttsStatus?.().catch(() => null);
  const voice = voiceFor(status, options);
  if (!status?.available || !voice) {
    notify(t('tts.noVoiceReady'), 'warning');
    return null;
  }
  const waiting = notify(t('tts.speaking'), 'info', { persistent: true });
  try {
    const clipId = await speakText(text, startFrame, options, voice);
    if (clipId) notify(t('tts.spoke'), 'success');
    return clipId;
  } catch (error) {
    notify(t('tts.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    return null;
  } finally {
    dismissNotification(waiting);
  }
}

/**
 * Every caption of a captions track narrated at its own time: dubbing, from
 * a script. A line longer than its caption goes on a Voice track of its own
 * rather than over the next one; how many did is said. One undo step.
 */
export async function narrateCaptions(trackId: string): Promise<number> {
  const options = { ...ttsOptions(document.documentElement.lang), captions: false };
  const status = await window.filmora.ttsStatus?.().catch(() => null);
  const voice = voiceFor(status, options);
  if (!status?.available || !voice) {
    notify(t('tts.noVoiceReady'), 'warning');
    return 0;
  }
  const cues = Object.values(useProjectStore.getState().project.clips)
    .filter((clip) => clip.trackId === trackId && clip.caption?.text.trim())
    .sort((a, b) => a.startFrame - b.startFrame);
  if (cues.length === 0) return 0;
  let waiting = notify(t('tts.narrating', { done: 0, count: cues.length }), 'info', { persistent: true });
  const mark = useHistoryStore.getState().undoStack.length;
  let made = 0;
  let longer = 0;
  try {
    for (const [index, cue] of cues.entries()) {
      const line = await generate(cue.caption?.text ?? '', options, voice);
      if (!line) break;
      useProjectStore.getState().addAssets([line.asset]);
      const asset = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === line.asset.sourcePath) ?? line.asset;
      const fps = useProjectStore.getState().project.fps;
      const length = Math.max(1, Math.round(line.seconds * fps));
      if (length > cue.durationFrames + Math.round(fps * 0.25)) longer += 1;
      useProjectStore.getState().addAssetToTimeline(asset, voiceTrackFor(cue.startFrame, cue.startFrame + length), cue.startFrame);
      made += 1;
      dismissNotification(waiting);
      waiting = notify(t('tts.narrating', { done: index + 1, count: cues.length }), 'info', { persistent: true });
    }
  } catch (error) {
    notify(t('tts.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
  } finally {
    dismissNotification(waiting);
  }
  if (made > 0) useHistoryStore.getState().squash(mark, 'Narrate captions');
  if (made > 0) notify(longer > 0 ? t('tts.narratedLonger', { count: made, longer }) : t('tts.narrated', { count: made }), longer > 0 ? 'warning' : 'success');
  return made;
}
