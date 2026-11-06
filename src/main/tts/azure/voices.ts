import type { AzureVoice } from './client';

/**
 * Which Azure voices the picker offers, and in what order.
 *
 * The truth about what exists is the voices list the service itself returns
 * for a key (`client.listVoices`), and that is what the panel shows once a
 * key is set. This file is the fallback for before then, and the order and
 * the shortlist for after: Azure offers hundreds of voices in a hundred and
 * thirty-odd locales, and a picker that long is worse than a picker that is
 * short and in the right order.
 *
 * The shortlist is Spanish first, Latin America before Spain, because that
 * is this app's audience. Nothing here claims a style: which voices support
 * `<mstts:express-as>` is in the `StyleList` of the live list, and guessing
 * it would mean offering a person a style their voice silently ignores.
 */

export interface AzureVoiceChoice {
  /** Azure's `ShortName`, which is what goes in the SSML. */
  shortName: string;
  /** A person's name for it, as the picker shows. */
  name: string;
  locale: string;
  sex: 'male' | 'female';
  /** The `<mstts:express-as>` styles this voice has, from the live list; empty when it has none. */
  styles: string[];
}

/**
 * The voices offered, Spanish first.
 *
 * Each `shortName` follows Azure's own pattern, `{locale}-{Name}Neural`.
 * The list was taken from the catalogue the service actually serves, not
 * from memory; a voice that is no longer there simply stops appearing,
 * because the live list is what the panel shows whenever a key works.
 */
export const SHORTLIST: readonly AzureVoiceChoice[] = [
  // Latin America.
  { shortName: 'es-MX-DaliaNeural', name: 'Dalia', locale: 'es-MX', sex: 'female', styles: [] },
  { shortName: 'es-MX-JorgeNeural', name: 'Jorge', locale: 'es-MX', sex: 'male', styles: [] },
  { shortName: 'es-CO-SalomeNeural', name: 'Salomé', locale: 'es-CO', sex: 'female', styles: [] },
  { shortName: 'es-CO-GonzaloNeural', name: 'Gonzalo', locale: 'es-CO', sex: 'male', styles: [] },
  { shortName: 'es-AR-ElenaNeural', name: 'Elena', locale: 'es-AR', sex: 'female', styles: [] },
  { shortName: 'es-AR-TomasNeural', name: 'Tomás', locale: 'es-AR', sex: 'male', styles: [] },
  { shortName: 'es-PE-CamilaNeural', name: 'Camila', locale: 'es-PE', sex: 'female', styles: [] },
  { shortName: 'es-PE-AlexNeural', name: 'Alex', locale: 'es-PE', sex: 'male', styles: [] },
  { shortName: 'es-US-PalomaNeural', name: 'Paloma', locale: 'es-US', sex: 'female', styles: [] },
  { shortName: 'es-US-AlonsoNeural', name: 'Alonso', locale: 'es-US', sex: 'male', styles: [] },
  { shortName: 'es-EC-AndreaNeural', name: 'Andrea', locale: 'es-EC', sex: 'female', styles: [] },
  { shortName: 'es-EC-LuisNeural', name: 'Luis', locale: 'es-EC', sex: 'male', styles: [] },
  { shortName: 'es-CR-MariaNeural', name: 'María', locale: 'es-CR', sex: 'female', styles: [] },
  { shortName: 'es-CR-JuanNeural', name: 'Juan', locale: 'es-CR', sex: 'male', styles: [] },
  { shortName: 'es-VE-PaolaNeural', name: 'Paola', locale: 'es-VE', sex: 'female', styles: [] },
  { shortName: 'es-VE-SebastianNeural', name: 'Sebastián', locale: 'es-VE', sex: 'male', styles: [] },
  { shortName: 'es-UY-ValentinaNeural', name: 'Valentina', locale: 'es-UY', sex: 'female', styles: [] },
  { shortName: 'es-UY-MateoNeural', name: 'Mateo', locale: 'es-UY', sex: 'male', styles: [] },
  { shortName: 'es-GT-MartaNeural', name: 'Marta', locale: 'es-GT', sex: 'female', styles: [] },
  { shortName: 'es-GT-AndresNeural', name: 'Andrés', locale: 'es-GT', sex: 'male', styles: [] },
  // Spain.
  { shortName: 'es-ES-ElviraNeural', name: 'Elvira', locale: 'es-ES', sex: 'female', styles: [] },
  { shortName: 'es-ES-AlvaroNeural', name: 'Álvaro', locale: 'es-ES', sex: 'male', styles: [] },
  // English.
  { shortName: 'en-US-AvaMultilingualNeural', name: 'Ava', locale: 'en-US', sex: 'female', styles: [] },
  { shortName: 'en-US-AndrewMultilingualNeural', name: 'Andrew', locale: 'en-US', sex: 'male', styles: [] },
  { shortName: 'en-US-JennyNeural', name: 'Jenny', locale: 'en-US', sex: 'female', styles: [] },
  { shortName: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', sex: 'male', styles: [] },
  { shortName: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', sex: 'female', styles: [] },
  { shortName: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', sex: 'female', styles: [] },
  { shortName: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', sex: 'male', styles: [] },
];

const sexOf = (gender: string): 'male' | 'female' => (gender.toLowerCase() === 'male' ? 'male' : 'female');

/**
 * The picker's list for a key that works: the shortlist, in its order, with
 * each voice's real name and styles filled in from the live list - and
 * anything on the shortlist the key cannot actually use dropped, so the
 * picker never offers a voice that would fail.
 *
 * A voice the live list has and the shortlist does not is left out. That is
 * the point of the shortlist: Azure serves hundreds, and the extras are
 * other languages, retired voices and preview models.
 */
export function offeredVoices(live: readonly AzureVoice[]): AzureVoiceChoice[] {
  const byShortName = new Map(live.map((voice) => [voice.ShortName, voice]));
  const offered: AzureVoiceChoice[] = [];
  for (const choice of SHORTLIST) {
    const found = byShortName.get(choice.shortName);
    if (!found) continue;
    offered.push({
      shortName: choice.shortName,
      // The shortlist's name is the one written here with its accents; Azure's
      // DisplayName is the same name without them ("Alvaro"), so it is only a
      // fallback.
      name: choice.name || found.LocalName || found.DisplayName,
      locale: found.Locale || choice.locale,
      sex: found.Gender ? sexOf(found.Gender) : choice.sex,
      styles: Array.isArray(found.StyleList) ? found.StyleList.filter((style) => typeof style === 'string') : [],
    });
  }
  return offered;
}

/** Whether a voice id is one the shortlist knows, so a stale project cannot ask for anything else. */
export const isOffered = (shortName: unknown): boolean => SHORTLIST.some((choice) => choice.shortName === shortName);
