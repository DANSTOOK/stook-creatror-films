import type { ExportFormat, ExportSettings, SubtitleStream } from '../types';

/**
 * A subtitle track inside the exported file: which containers take one, and
 * as what.
 *
 * - MP4 and MOV carry timed text as `mov_text` (3GPP Timed Text): what
 *   QuickTime, VLC, mpv and most televisions read.
 * - WebM carries WebVTT.
 * - A PNG sequence is a folder of pictures: there is nowhere to put one.
 *
 * Such a track is plain text with times - the player draws it, in its own
 * look, when the viewer switches it on. It is not how YouTube takes
 * subtitles (that is the separate .srt), and it is not the captions' look
 * (that is burning them into the picture).
 */
export function subtitleCodecFor(format: ExportFormat): 'mov_text' | 'webvtt' | null {
  switch (format) {
    case 'mp4-h264':
    case 'mp4-h265':
    case 'prores4444':
      return 'mov_text';
    case 'webm-vp9':
      return 'webvtt';
    default:
      return null;
  }
}

/** The streams an export carries: several, or the one, or none. */
export function subtitleStreamsOf(settings: Pick<ExportSettings, 'subtitles' | 'subtitleStreams'>): SubtitleStream[] {
  if (settings.subtitleStreams && settings.subtitleStreams.length > 0) return settings.subtitleStreams;
  return settings.subtitles ? [settings.subtitles] : [];
}

/** The ISO 639-2 code a container tags a subtitle track with. */
export const subtitleLanguageCode = (language: 'es' | 'en'): 'spa' | 'eng' => (language === 'en' ? 'eng' : 'spa');
