import type { CaptionModelId } from '@shared/types/ipc';

/**
 * The speech models the app offers, and nothing else.
 *
 * Both come from whisper.cpp's own model repository on Hugging Face - the
 * official source - and are checked against the SHA-256 Hugging Face
 * publishes for each (the LFS object id of the file), fixed here, before
 * they are used. A file that does not hash to this is never run.
 *
 * - Preciso: Whisper large-v3-turbo, quantised to 5 bits (q5_0). The
 *   default: about as accurate as large-v2 and several times faster than
 *   large-v3. Transcription only (it does not translate).
 * - Rápido: Whisper small, 5 bits (q5_1). A third of the size and several
 *   times faster again, for machines without a capable GPU.
 *
 * Whisper's code and weights are MIT-licensed (github.com/openai/whisper);
 * whisper.cpp and its GGML conversions are MIT too.
 */

export interface CaptionModel {
  id: CaptionModelId;
  file: string;
  bytes: number;
  sha256: string;
  url: string;
  /** whisper.cpp's name for the model's alignment heads, for `-dtw`. */
  dtw: string;
}

const REPOSITORY = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const CAPTION_MODELS: readonly CaptionModel[] = [
  {
    id: 'precise',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    url: `${REPOSITORY}/ggml-large-v3-turbo-q5_0.bin`,
    dtw: 'large.v3.turbo',
  },
  {
    id: 'fast',
    file: 'ggml-small-q5_1.bin',
    bytes: 190_085_487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    url: `${REPOSITORY}/ggml-small-q5_1.bin`,
    dtw: 'small',
  },
];

/** Where the models come from, as the permission prompt names it. */
export const MODEL_SOURCE = 'huggingface.co/ggerganov/whisper.cpp';

export const modelById = (id: unknown): CaptionModel | undefined => CAPTION_MODELS.find((model) => model.id === id);
