import type { MessageKey } from '@shared/i18n';

/**
 * The sound library: effects and music made in the editor itself, by
 * synthesis (sounds/synth.ts) - so every one is free to use anywhere, with
 * nothing downloaded and no licence to read. Each is rendered once, on first
 * use, and kept as a WAV in the app's folder.
 */

export type SoundCategory = 'effects' | 'music';

export interface Sound {
  id: string;
  category: SoundCategory;
  label: MessageKey;
  /** How long it is, in seconds. */
  seconds: number;
}

export const SOUNDS: readonly Sound[] = [
  { id: 'whoosh', category: 'effects', label: 'sound.whoosh', seconds: 1.2 },
  { id: 'swoosh', category: 'effects', label: 'sound.swoosh', seconds: 0.6 },
  { id: 'pop', category: 'effects', label: 'sound.pop', seconds: 0.35 },
  { id: 'click', category: 'effects', label: 'sound.click', seconds: 0.15 },
  { id: 'ding', category: 'effects', label: 'sound.ding', seconds: 2 },
  { id: 'chime', category: 'effects', label: 'sound.chime', seconds: 1.8 },
  { id: 'success', category: 'effects', label: 'sound.success', seconds: 1.4 },
  { id: 'error', category: 'effects', label: 'sound.error', seconds: 0.7 },
  { id: 'boom', category: 'effects', label: 'sound.boom', seconds: 2.5 },
  { id: 'riser', category: 'effects', label: 'sound.riser', seconds: 3 },
  { id: 'laser', category: 'effects', label: 'sound.laser', seconds: 0.6 },
  { id: 'shutter', category: 'effects', label: 'sound.shutter', seconds: 0.4 },
  { id: 'typewriter', category: 'effects', label: 'sound.typewriter', seconds: 2 },
  { id: 'heartbeat', category: 'effects', label: 'sound.heartbeat', seconds: 2 },
  { id: 'upbeat', category: 'music', label: 'sound.upbeat', seconds: 24 },
  { id: 'lofi', category: 'music', label: 'sound.lofi', seconds: 24 },
  { id: 'cinematic', category: 'music', label: 'sound.cinematic', seconds: 24 },
  { id: 'corporate', category: 'music', label: 'sound.corporate', seconds: 24 },
  { id: 'chill', category: 'music', label: 'sound.chill', seconds: 24 },
];

export const soundById = (id: string): Sound | undefined => SOUNDS.find((sound) => sound.id === id);
