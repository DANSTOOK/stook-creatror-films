/**
 * The SSML one Azure request carries.
 *
 * Azure's text-to-speech REST endpoint takes no plain text: the body is
 * always an SSML document (`Content-Type: application/ssml+xml`). This
 * module builds it and nothing else - no network, no Electron - so the
 * document can be checked character by character in the unit tests, which
 * is the only way to be sure of a format a remote service parses.
 *
 * Everything here follows Microsoft's own documentation, and the parts that
 * matter carry the figure from it:
 *
 *  - learn.microsoft.com/azure/ai-services/speech-service/speech-synthesis-markup-structure
 *  - learn.microsoft.com/azure/ai-services/speech-service/speech-synthesis-markup-voice
 *
 * What is deliberately NOT built here: `<break>`. The app already has pauses
 * that work - the marks written into a script (`[pausa 2s]`), parsed by
 * shared/tts/script and turned into real silence by main/tts/synth when it
 * joins the pieces. That silence is exact and the caption timings are
 * measured from the finished audio, so moving pauses into the SSML would
 * trade a measured length for a reported one and gain nothing.
 */

/** Azure's own limits on `<prosody rate>`: "within 0.5 to 2 times the original audio". */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

/**
 * Pitch, in semitones. Azure says a pitch change "should be within 0.5 to
 * 1.5 times the original audio"; the app offers -6..+6 semitones, which is
 * about 0.7x to 1.4x and so sits inside that.
 */
export const MIN_SEMITONES = -6;
export const MAX_SEMITONES = 6;

/** `<mstts:express-as styledegree>`: "0.01 to 2 inclusive. The default value is 1." */
export const MIN_STYLE_DEGREE = 0.01;
export const MAX_STYLE_DEGREE = 2;

export interface SsmlRequest {
  /** The voice's `ShortName`, e.g. `es-MX-DaliaNeural`. */
  voice: string;
  /** What is said. Escaped here; never pre-escaped by the caller. */
  text: string;
  /** The document's language, e.g. `es-MX`. Taken from the voice when absent. */
  locale?: string;
  /** A multiplier: 1 is the voice's own pace. Clamped to Azure's range. */
  rate?: number;
  /** Semitones up or down; 0 or absent leaves the voice's own pitch. */
  semitones?: number;
  /** An `<mstts:express-as>` style, e.g. `newscast`. Only some voices have any. */
  style?: string;
  /** How strongly, 0.01..2. Ignored without a style. */
  styleDegree?: number;
  /** An `<mstts:express-as>` role, e.g. `YoungAdultFemale`. Ignored without a style. */
  role?: string;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * XML entities for the five characters that would otherwise end the
 * document early or break an attribute.
 *
 * Microsoft requires `&`, `<` and `>` ("Otherwise the SSML isn't parsed
 * correctly") and says quotation marks and apostrophes "must be escaped"
 * without naming the entities; `&quot;` and `&apos;` are XML 1.0's own, and
 * escaping them costs nothing. `&` goes first: escaping it after the others
 * would escape the ampersands they just introduced.
 */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The locale a voice's ShortName starts with: `es-MX-DaliaNeural` -> `es-MX`. */
export function localeOf(voice: string): string {
  const match = /^([a-z]{2,3}(?:-[A-Za-z]+)?-[A-Z]{2})(?=-)/.exec(voice);
  return match ? match[1] : 'en-US';
}

/**
 * A number for an attribute: at most two decimals and never in exponential
 * notation or with a locale's comma, either of which Azure would reject.
 */
const number = (value: number): string => String(Math.round(value * 100) / 100);

/** `<prosody>`'s attributes for this request, or none when the voice speaks as it is. */
function prosodyAttributes(request: SsmlRequest): string {
  const parts: string[] = [];
  const rate = request.rate === undefined ? 1 : clamp(request.rate, MIN_RATE, MAX_RATE);
  if (rate !== 1) parts.push(`rate="${number(rate)}"`);
  const semitones = request.semitones === undefined ? 0 : clamp(request.semitones, MIN_SEMITONES, MAX_SEMITONES);
  // Azure's relative semitone form: "+80Hz or -2st". A sign is always written,
  // because "2st" without one is not the relative form.
  if (semitones !== 0) parts.push(`pitch="${semitones > 0 ? '+' : '-'}${number(Math.abs(semitones))}st"`);
  return parts.join(' ');
}

/**
 * The namespace for the `mstts` prefix.
 *
 * Microsoft's own pages disagree with themselves: the document-structure
 * template writes `https://www.w3.org/2001/mstts` while every worked example
 * on the same page writes `http://`. The examples are what people actually
 * run, so `http://` is what goes out here - and it is only declared at all
 * when a style is used, so a plain request cannot be refused over a
 * namespace it never needed.
 */
const MSTTS_NS = 'http://www.w3.org/2001/mstts';

/** The one SSML document for a piece of speech. */
export function buildSsml(request: SsmlRequest): string {
  const locale = request.locale ?? localeOf(request.voice);
  const style = request.style?.trim() || undefined;

  let inner = escapeSsml(request.text);

  const prosody = prosodyAttributes(request);
  if (prosody) inner = `<prosody ${prosody}>${inner}</prosody>`;

  if (style) {
    const degree = request.styleDegree === undefined ? undefined : clamp(request.styleDegree, MIN_STYLE_DEGREE, MAX_STYLE_DEGREE);
    const attributes = [`style="${escapeSsml(style)}"`];
    if (degree !== undefined && degree !== 1) attributes.push(`styledegree="${number(degree)}"`);
    if (request.role?.trim()) attributes.push(`role="${escapeSsml(request.role.trim())}"`);
    inner = `<mstts:express-as ${attributes.join(' ')}>${inner}</mstts:express-as>`;
  }

  const namespaces = [`xmlns="http://www.w3.org/2001/10/synthesis"`];
  if (style) namespaces.push(`xmlns:mstts="${MSTTS_NS}"`);

  return (
    `<speak version="1.0" ${namespaces.join(' ')} xml:lang="${locale}">` +
    `<voice name="${escapeSsml(request.voice)}">${inner}</voice>` +
    `</speak>`
  );
}
