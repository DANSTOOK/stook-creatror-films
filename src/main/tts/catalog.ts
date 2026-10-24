import type { TtsVoiceId } from '@shared/types/ipc';

/**
 * The text-to-speech voices the app offers, and which engine speaks each.
 *
 * Two engines, both standalone programs spawned as child processes exactly
 * the way ffmpeg and whisper-cli are:
 *
 * - **Piper** (github.com/rhasspy/piper, MIT): a VITS model per voice, one
 *   `.onnx` weight file plus its `.onnx.json` configuration. Quick - a
 *   sentence in a fraction of a second - and the most voices.
 * - **Kokoro** (github.com/hexgrad/kokoro, Apache-2.0) run by sherpa-onnx's
 *   `sherpa-onnx-offline-tts` (github.com/k2-fsa/sherpa-onnx, Apache-2.0):
 *   one 82M-parameter model holding many voices, more natural in its
 *   phrasing; slower (about real time on a laptop CPU). Its Spanish voices
 *   are read with espeak-ng's Latin American rules (`es-419`: "s" for "c"
 *   and "z"), so they speak as Latin America does.
 *
 * Both phonemise with espeak-ng (GPL-3.0), which ships as data beside Piper's
 * own executable and is never linked into the app; Kokoro reads the same data
 * (resources/piper/espeak-ng-data).
 *
 * Every voice here ships inside the installer (resources/tts-voices), so text
 * to speech works with no download on first use. `DOWNLOADABLE_VOICES` - none
 * at the moment - would be fetched on request, each checked against the
 * SHA-256 fixed here before it is ever run (main/tts/voices.ts).
 *
 * Only voices whose training data carries a licence usable in a commercial
 * product are listed. Many voices are trained on research-only or
 * non-commercial data (lessac/Blizzard, MMS, XTTS's CPML, F5's Emilia, …), or
 * imitate real people; those are deliberately left out.
 */

export type TtsLanguage = 'es' | 'en';
export type TtsEngineKind = 'piper' | 'kokoro';

export interface TtsVoice {
  id: TtsVoiceId;
  engine: TtsEngineKind;
  /** A person's name for the voice, as voice libraries name theirs. */
  name: string;
  /** What it sounds like and what it suits, as an i18n key (tts.persona.*). */
  persona: string;
  /** The language its text is read in: decides es vs en here. */
  language: TtsLanguage;
  /** For the picker: a short region tag, e.g. es-419, es-MX, es-ES, en-US. */
  region: string;
  sex: 'male' | 'female';
  /** Multi-speaker models pick a voice by id; single-speaker ignore it. */
  speakerId: number;
  /** Piper: the weight file's base name (`.onnx` and `.onnx.json`). Kokoro: the model's folder. */
  file: string;
  /** espeak-ng's voice for a Kokoro voice's text (es-419: Latin American Spanish). */
  phonemes?: string;
  /** Output sample rate the model was trained at. */
  sampleRate: number;
  /** The licence of the voice's training data, shown in the licences dialog. */
  licence: string;
  /** Where a downloadable voice comes from; null for a bundled one. */
  onnx: { bytes: number; sha256: string; url: string } | null;
  json: { bytes: number; sha256: string; url: string } | null;
}

const piper = (voice: Omit<TtsVoice, 'engine' | 'onnx' | 'json' | 'sampleRate'> & { sampleRate?: number }): TtsVoice => ({
  sampleRate: 22050,
  ...voice,
  engine: 'piper',
  onnx: null,
  json: null,
});

const KOKORO_LICENCE = 'Apache-2.0 - Kokoro-82M (hexgrad)';
const kokoro = (voice: Omit<TtsVoice, 'engine' | 'onnx' | 'json' | 'sampleRate' | 'file' | 'licence' | 'phonemes'>): TtsVoice => ({
  ...voice,
  engine: 'kokoro',
  file: 'kokoro',
  phonemes: voice.language === 'es' ? 'es-419' : 'en-us',
  sampleRate: 24000,
  licence: KOKORO_LICENCE,
  onnx: null,
  json: null,
});

/**
 * Voices that ship in the installer, Latin American first. No download, no
 * checksum at run time: they are part of the build and are trusted like any
 * other resource (the release workflow checks each against its SHA-256).
 */
export const BUNDLED_VOICES: readonly TtsVoice[] = [
  kokoro({ id: 'es-419-dora', name: 'Dora', persona: 'dora', language: 'es', region: 'es-419', sex: 'female', speakerId: 28 }),
  kokoro({ id: 'es-419-alex', name: 'Alex', persona: 'alex', language: 'es', region: 'es-419', sex: 'male', speakerId: 29 }),
  piper({ id: 'es-MX-ald', name: 'Aldo', persona: 'aldo', language: 'es', region: 'es-MX', sex: 'male', speakerId: 0, file: 'es_MX-ald-medium', licence: 'Unlicense (public domain) - rmcpantoja/Ald' }),
  piper({ id: 'es-MX-claude', name: 'Claude', persona: 'claude', language: 'es', region: 'es-MX', sex: 'male', speakerId: 0, file: 'es_MX-claude-high', licence: 'Apache-2.0 - HirCoir' }),
  piper({ id: 'es-AR-daniela', name: 'Daniela', persona: 'daniela', language: 'es', region: 'es-AR', sex: 'female', speakerId: 0, file: 'es_AR-daniela-high', licence: 'CC BY-SA 4.0 - openslr.org/61' }),
  kokoro({ id: 'es-419-santa', name: 'Santa', persona: 'santa', language: 'es', region: 'es-419', sex: 'male', speakerId: 53 }),
  piper({ id: 'es-ES-davefx', name: 'David', persona: 'david', language: 'es', region: 'es-ES', sex: 'male', speakerId: 0, file: 'es_ES-davefx-medium', licence: 'CC0 (public domain) - OHF voice-datasets' }),
  // The model holds two speakers (M=0, F=1); the female is the one offered.
  piper({ id: 'es-ES-sharvard', name: 'Sara', persona: 'sara', language: 'es', region: 'es-ES', sex: 'female', speakerId: 1, file: 'es_ES-sharvard-medium', licence: 'CC BY 3.0 - University of Edinburgh (Sharvard)' }),
  piper({ id: 'en-US-kristin', name: 'Kristin', persona: 'kristin', language: 'en', region: 'en-US', sex: 'female', speakerId: 0, file: 'en_US-kristin-medium', licence: 'Public domain (LibriVox) - Bryce Beattie' }),
  piper({ id: 'en-US-norman', name: 'Norman', persona: 'norman', language: 'en', region: 'en-US', sex: 'male', speakerId: 0, file: 'en_US-norman-medium', licence: 'Public domain (LibriVox) - Bryce Beattie' }),
];

/** Extra voices offered for optional download (none at the moment: every voice ships in the installer). */
export const DOWNLOADABLE_VOICES: readonly TtsVoice[] = [];

export const ALL_VOICES: readonly TtsVoice[] = [...BUNDLED_VOICES, ...DOWNLOADABLE_VOICES];

export const voiceById = (id: unknown): TtsVoice | undefined => ALL_VOICES.find((voice) => voice.id === id);

/** Where downloadable voices come from, as the permission prompt names it. */
export const VOICE_SOURCE = 'huggingface.co/rhasspy/piper-voices';
