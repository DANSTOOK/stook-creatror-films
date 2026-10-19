import type { TtsVoiceId } from '@shared/types/ipc';

/**
 * The text-to-speech voices the app offers.
 *
 * The engine is Piper (github.com/rhasspy/piper): a VITS model run by a
 * standalone program, `piper.exe`, spawned as a child process exactly the way
 * ffmpeg and whisper-cli are. Piper and its phonemiser are MIT; the phonemiser
 * links espeak-ng (GPL-3.0), which is why the program ships as its own
 * executable with its licence beside it (resources/piper) rather than being
 * linked into the app - the same treatment ffmpeg already gets.
 *
 * Each voice is one `.onnx` weight file plus its `.onnx.json` configuration.
 * The voices in `BUNDLED_VOICES` ship inside the installer (resources/tts-voices)
 * so text to speech works with no download on first use ("listo para usar").
 * `DOWNLOADABLE_VOICES` are fetched on request into the app's data folder, the
 * way captions models are (main/subtitles/models.ts), each checked against the
 * SHA-256 fixed here before it is ever run.
 *
 * Only voices whose training data carries a licence usable in a commercial
 * product are listed. Many Piper voices are trained on research-only or
 * non-commercial datasets (lessac/Blizzard, hi-fi captain, ryanspeech, …) and
 * are deliberately excluded; see .bench-tmp/tts-spike.md.
 */

export type TtsLanguage = 'es' | 'en';

export interface TtsVoice {
  id: TtsVoiceId;
  /** The espeak language Piper phonemises with: decides es vs en here. */
  language: TtsLanguage;
  /** For the picker: a short region tag, e.g. es-ES, es-MX, en-US. */
  region: string;
  /** Male / female / neutral, for the picker's description. */
  sex: 'male' | 'female';
  /** Piper multi-speaker models pick a voice by id; single-speaker ignore it. */
  speakerId: number;
  /** The weight file's base name; `.onnx` and `.onnx.json` share it. */
  file: string;
  /** Output sample rate the model was trained at. */
  sampleRate: number;
  /** The licence of the voice's training data, shown in the licences dialog. */
  licence: string;
  /** Where a downloadable voice comes from; null for a bundled one. */
  onnx: { bytes: number; sha256: string; url: string } | null;
  json: { bytes: number; sha256: string; url: string } | null;
}

const PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/**
 * Voices that ship in the installer. No download, no checksum at run time:
 * they are part of the build and are trusted like any other resource.
 */
export const BUNDLED_VOICES: readonly TtsVoice[] = [
  {
    id: 'es-ES-davefx',
    language: 'es',
    region: 'es-ES',
    sex: 'male',
    speakerId: 0,
    file: 'es_ES-davefx-medium',
    sampleRate: 22050,
    licence: 'CC0 (public domain) - OHF voice-datasets',
    onnx: null,
    json: null,
  },
  {
    id: 'es-ES-sharvard',
    language: 'es',
    region: 'es-ES',
    sex: 'female',
    // The model holds two speakers (M=0, F=1); the female is the one offered.
    speakerId: 1,
    file: 'es_ES-sharvard-medium',
    sampleRate: 22050,
    licence: 'CC BY 3.0 - University of Edinburgh (Sharvard)',
    onnx: null,
    json: null,
  },
  {
    id: 'es-MX-claude',
    language: 'es',
    region: 'es-MX',
    sex: 'male',
    speakerId: 0,
    file: 'es_MX-claude-high',
    sampleRate: 22050,
    licence: 'Apache-2.0 - HirCoir',
    onnx: null,
    json: null,
  },
  {
    id: 'en-US-kristin',
    language: 'en',
    region: 'en-US',
    sex: 'female',
    speakerId: 0,
    file: 'en_US-kristin-medium',
    sampleRate: 22050,
    licence: 'Public domain (LibriVox) - Bryce Beattie',
    onnx: null,
    json: null,
  },
  {
    id: 'en-US-norman',
    language: 'en',
    region: 'en-US',
    sex: 'male',
    speakerId: 0,
    file: 'en_US-norman-medium',
    sampleRate: 22050,
    licence: 'Public domain (LibriVox) - Bryce Beattie',
    onnx: null,
    json: null,
  },
];

/**
 * Extra voices offered for optional download. All commercially usable; the
 * ones with an attribution licence are credited in the licences dialog.
 */
export const DOWNLOADABLE_VOICES: readonly TtsVoice[] = [
  {
    id: 'es-AR-daniela',
    language: 'es',
    region: 'es-AR',
    sex: 'female',
    speakerId: 0,
    file: 'es_AR-daniela-high',
    sampleRate: 22050,
    licence: 'CC BY-SA 4.0 - openslr.org/61',
    onnx: {
      bytes: 114199011,
      sha256: '', // filled from the published file at build time; see release.yml note.
      url: `${PIPER}/es/es_AR/daniela/high/es_AR-daniela-high.onnx`,
    },
    json: {
      bytes: 7248,
      sha256: '',
      url: `${PIPER}/es/es_AR/daniela/high/es_AR-daniela-high.onnx.json`,
    },
  },
];

export const ALL_VOICES: readonly TtsVoice[] = [...BUNDLED_VOICES, ...DOWNLOADABLE_VOICES];

export const voiceById = (id: unknown): TtsVoice | undefined => ALL_VOICES.find((voice) => voice.id === id);

/** Where downloadable voices come from, as the permission prompt names it. */
export const VOICE_SOURCE = 'huggingface.co/rhasspy/piper-voices';
