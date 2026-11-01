import type { MessageKey } from '@shared/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { addBackground } from '@renderer/backgrounds/addBackground';
import { addFrame } from '@renderer/frames/addFrame';

/**
 * Starter kits: a project that already has something in it.
 *
 * A new project was always an empty timeline, and the start screen offered
 * only the user's OWN saved templates (project/templates.tsx) - which is no
 * help on the first day. A kit is the first day's work done: a background
 * behind, the safe-area guide for where it is going, a heading and a line
 * under it, and the clip lengths set so the whole thing is the length a short
 * actually is.
 *
 * They are CODE, not saved project files, and that is the point. A saved file
 * carries one resolution, one shape and whatever media it was made from; a kit
 * is a few calls to the catalogues that already ship, so the same kit fills a
 * 4K 16:9 project and a 1080x1920 vertical one correctly, draws its background
 * at that size, and needs nothing bundled beside the app.
 *
 * Each is one undo step: Ctrl+Z once and the project is empty again.
 */

export interface StarterKit {
  id: string;
  name: MessageKey;
  what: MessageKey;
  /** The shape it is meant for, for the start screen to suggest one. */
  shape: 'vertical' | 'wide' | 'any';
  /** Builds it into the project that is already open. */
  build(): Promise<void>;
}

/** A title from a template, at a frame, lasting `seconds`. */
async function title(template: string, startFrame: number, seconds: number): Promise<string | null> {
  const store = useProjectStore.getState();
  const id = store.addTitle(template, { trackId: null, startFrame });
  if (!id) return null;
  const fps = useProjectStore.getState().project.fps;
  useProjectStore.getState().updateClip(id, { durationFrames: Math.max(1, Math.round(seconds * fps)) });
  return id;
}

/** Every clip stretched to `seconds`, so a kit is as long as it says it is. */
function lastFor(seconds: number): void {
  const store = useProjectStore.getState();
  const fps = store.project.fps;
  const frames = Math.max(1, Math.round(seconds * fps));
  for (const clip of Object.values(store.project.clips)) {
    // A title keeps its own length; the background and the frame fill the piece.
    if (clip.title) continue;
    useProjectStore.getState().updateClip(clip.id, { durationFrames: frames });
  }
}

export const STARTER_KITS: readonly StarterKit[] = [
  {
    id: 'short',
    name: 'kit.short',
    what: 'kit.shortWhat',
    shape: 'vertical',
    build: async () => {
      await addBackground('grape', { motion: true });
      // The guide goes on last of the two, so it sits over the background.
      await addFrame('safeShorts');
      await title('head-vertical', 0, 3);
      await title('head-sub-pill', Math.round(useProjectStore.getState().project.fps * 3), 4);
      lastFor(15);
    },
  },
  {
    id: 'podcast',
    name: 'kit.podcast',
    what: 'kit.podcastWhat',
    shape: 'wide',
    build: async () => {
      await addBackground('midnight');
      // The scrim, not a border: a lower third has to stay readable over it.
      await addFrame('lowerScrim');
      await title('lowerThird', 0, 6);
      lastFor(30);
    },
  },
  {
    id: 'tutorial',
    name: 'kit.tutorial',
    what: 'kit.tutorialWhat',
    shape: 'wide',
    build: async () => {
      await addBackground('paper');
      await addFrame('titleSafe');
      await title('head-top', 0, 5);
      await title('head-sub-wide', Math.round(useProjectStore.getState().project.fps * 5), 5);
      lastFor(30);
    },
  },
  {
    id: 'cover',
    name: 'kit.cover',
    what: 'kit.coverWhat',
    shape: 'any',
    build: async () => {
      await addBackground('ember', { motion: true });
      await title('head-mega', 0, 4);
      lastFor(5);
    },
  },
];

export const kitById = (id: string): StarterKit | undefined => STARTER_KITS.find((kit) => kit.id === id);

/**
 * Build `id` into the project that is open, as ONE undo step.
 *
 * The kit's own pieces each push a step of their own - a background is added
 * and sent to the bottom, a title is added and sized - and a person who does
 * not like the kit wants one Ctrl+Z, not eleven.
 */
export async function applyKit(id: string): Promise<boolean> {
  const kit = kitById(id);
  if (!kit) return false;
  const mark = useHistoryStore.getState().undoStack.length;
  try {
    await kit.build();
  } finally {
    useHistoryStore.getState().squash(mark, 'Starter kit');
  }
  return true;
}
