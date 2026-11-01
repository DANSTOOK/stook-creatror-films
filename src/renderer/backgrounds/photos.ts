/**
 * Real photographs, searched for rather than shipped.
 *
 * Openverse (openverse.org, run by WordPress) indexes openly licensed media
 * from Flickr, Wikimedia and others. It is used here rather than Pexels or
 * Unsplash for three reasons that all matter:
 *
 *  - It needs NO API KEY, so nothing has to be registered, kept secret or
 *    shipped inside the installer.
 *  - Every result carries its LICENCE and its CREATOR, so a photo can be
 *    credited and a user can tell what they are allowed to do with it.
 *  - Only the photo the user picks is ever downloaded. Nobody's artwork is
 *    packaged with the app, which is what keeps the app itself clean.
 *
 * The anonymous limits are 20 requests a minute and 200 a day per address.
 * That is plenty for a person choosing a background and far too few for
 * anything automatic, so searching is done on a key press and not as you type.
 *
 * Licences are limited to the ones that let a video be published without
 * conditions a video cannot meet: CC0 and PDM are public domain, BY and BY-SA
 * only ask for credit, which the app writes down with the clip.
 */

export interface StockPhoto {
  id: string;
  title: string;
  /** The full picture. */
  url: string;
  /** A small one for the grid, served by Openverse itself. */
  thumbnail: string;
  creator: string;
  /** 'cc0', 'pdm', 'by', 'by-sa'. */
  licence: string;
  /** Where Openverse found it: flickr, wikimedia, and so on. */
  source: string;
  width: number;
  height: number;
  /** The page to send someone to for the original and its terms. */
  pageUrl: string;
}

/**
 * The licences offered.
 *
 * Deliberately not every licence Openverse knows: NC forbids commercial use
 * and ND forbids changes, and a background put under a video is a change used
 * commercially more often than not. Offering them would be setting a trap.
 */
export const PHOTO_LICENCES = 'cc0,pdm,by,by-sa';

/** A licence that asks for credit, so the app can say so when one is used. */
export const needsCredit = (licence: string): boolean => licence === 'by' || licence === 'by-sa';

export interface PhotoSearch {
  query: string;
  page?: number;
  /** Only pictures at least this wide, so a background is not blown up. */
  /**
   * Pictures narrower than this are left out. 800 rather than the frame’s
   * own width because Openverse mostly indexes 1024-wide copies: asking for
   * 1280 threw away every result of a search that had 240 of them. A 1024
   * picture across a 1080p frame is a little soft, and the grid says how big
   * each one is so that is the user’s call rather than a silent one.
   */
  minWidth?: number;
}

export interface PhotoResults {
  photos: StockPhoto[];
  /** How many there are in all, so the grid can say there is more. */
  total: number;
  page: number;
  hasMore: boolean;
}

/** Unpack one result, or null when it is missing something it cannot be shown without. */
export function toPhoto(raw: unknown): StockPhoto | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : null;
  const url = typeof item.url === 'string' ? item.url : null;
  if (!id || !url) return null;
  const width = Number(item.width);
  const height = Number(item.height);
  return {
    id,
    title: typeof item.title === 'string' && item.title ? item.title : 'Untitled',
    url,
    thumbnail: typeof item.thumbnail === 'string' && item.thumbnail ? item.thumbnail : url,
    creator: typeof item.creator === 'string' && item.creator ? item.creator : 'Unknown',
    licence: typeof item.license === 'string' ? item.license : 'cc0',
    source: typeof item.source === 'string' ? item.source : 'openverse',
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
    pageUrl: typeof item.foreign_landing_url === 'string' ? item.foreign_landing_url : url,
  };
}

/** The line to put with a clip so its photographer is credited. */
export function creditFor(photo: StockPhoto): string {
  return `${photo.title} — ${photo.creator} (${photo.licence.toUpperCase()}, via ${photo.source})`;
}

/**
 * Search Openverse.
 *
 * Throws with a plain reason rather than a status code: the panel shows what
 * comes back here straight to the user, and "429" tells nobody anything.
 */
/**
 * Search Openverse, through the main process.
 *
 * The page's CSP allows no outside connection and that rule is kept: the
 * request is made in main (main/ipc/photos), which is also where this app
 * already does its networking.
 *
 * Throws with a plain word rather than a status code, because the panel
 * shows what comes back here and "429" tells nobody anything.
 */
export async function searchPhotos({ query, page = 1, minWidth = 800 }: PhotoSearch): Promise<PhotoResults> {
  const trimmed = query.trim();
  if (!trimmed) return { photos: [], total: 0, page: 1, hasMore: false };
  const api = window.filmora;
  if (!api?.photosSearch) throw new Error('failed');

  const reply = await api.photosSearch(trimmed, Math.max(1, Math.floor(page)));
  if (reply.error) throw new Error(reply.error);

  const photos: StockPhoto[] = [];
  for (const raw of reply.results) {
    const photo = toPhoto(raw);
    // Too small to carry a frame at all; the rest is the user’s judgement.
    if (photo && (photo.width === 0 || photo.width >= minWidth)) photos.push(photo);
  }
  return { photos, total: reply.resultCount, page, hasMore: page < reply.pageCount };
}

/**
 * A picture's bytes as a data URL, so the page can show it without being
 * allowed to reach the host that holds it.
 */
export async function photoDataUrl(url: string): Promise<string | null> {
  const bytes = await window.filmora?.photosFetch?.(url);
  if (!bytes || bytes.byteLength === 0) return null;
  const blob = new Blob([bytes]);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}