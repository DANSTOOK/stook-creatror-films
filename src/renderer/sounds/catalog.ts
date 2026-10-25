import type { MessageKey } from '@shared/i18n';

/**
 * The sound library: effects and music made in the editor itself, by
 * synthesis (sounds/synth.ts, sounds/effects.ts) - so every one is free to
 * use anywhere, with nothing downloaded and no licence to read. Each is
 * rendered once, on first use, and kept as a WAV in the app's folder: an id
 * is a sound for good, so a sound is changed by giving it a new id.
 */

export type SoundCategory = 'effects' | 'music';

/** Where an effect sits in the panel: the groups CapCut's sound effects come in. */
export type EffectGroup = 'transitions' | 'interface' | 'cartoon' | 'drums' | 'everyday' | 'nature';

export interface Sound {
  id: string;
  category: SoundCategory;
  label: MessageKey;
  /** How long it is, in seconds. */
  seconds: number;
  /** An effect's group in the panel. */
  group?: EffectGroup;
}

const effect = (id: string, label: MessageKey, group: EffectGroup, seconds: number): Sound => ({ id, category: 'effects', label, seconds, group });

export const SOUNDS: readonly Sound[] = [
  effect('whoosh', 'sound.whoosh', 'transitions', 1.2),
  effect('swoosh', 'sound.swoosh', 'transitions', 0.6),
  effect('pop', 'sound.pop', 'interface', 0.35),
  effect('click', 'sound.click', 'interface', 0.15),
  effect('ding', 'sound.ding', 'interface', 2),
  effect('chime', 'sound.chime', 'interface', 1.8),
  effect('success', 'sound.success', 'interface', 1.4),
  effect('error', 'sound.error', 'interface', 0.7),
  effect('boom', 'sound.boom', 'transitions', 2.5),
  effect('riser', 'sound.riser', 'transitions', 3),
  effect('laser', 'sound.laser', 'cartoon', 0.6),
  effect('shutter', 'sound.shutter', 'everyday', 0.4),
  effect('typewriter', 'sound.typewriter', 'everyday', 2),
  effect('heartbeat', 'sound.heartbeat', 'everyday', 2),
  // Block 7b.
  effect('swipe', 'sound.swipe', 'transitions', 0.4),
  effect('reverseCymbal', 'sound.reverseCymbal', 'transitions', 2),
  effect('impact', 'sound.impact', 'transitions', 2.2),
  effect('subDrop', 'sound.subDrop', 'transitions', 2),
  effect('notification', 'sound.notification', 'interface', 1.2),
  effect('bubble', 'sound.bubble', 'interface', 0.5),
  effect('coin', 'sound.coin', 'interface', 0.6),
  effect('countdown', 'sound.countdown', 'interface', 3.8),
  effect('alarm', 'sound.alarm', 'interface', 2),
  effect('boing', 'sound.boing', 'cartoon', 0.8),
  effect('slideWhistle', 'sound.slideWhistle', 'cartoon', 1.2),
  effect('powerUp', 'sound.powerUp', 'cartoon', 1),
  effect('gameOver', 'sound.gameOver', 'cartoon', 1.8),
  effect('jump', 'sound.jump', 'cartoon', 0.4),
  effect('magic', 'sound.magic', 'cartoon', 2),
  effect('sadTrombone', 'sound.sadTrombone', 'cartoon', 2.5),
  effect('drumroll', 'sound.drumroll', 'drums', 3.6),
  effect('cymbal', 'sound.cymbal', 'drums', 2.6),
  effect('rimshot', 'sound.rimshot', 'drums', 1.7),
  effect('scratch', 'sound.scratch', 'drums', 0.8),
  effect('fanfare', 'sound.fanfare', 'drums', 2.6),
  effect('applause', 'sound.applause', 'drums', 3.2),
  effect('glitch', 'sound.glitch', 'drums', 0.8),
  effect('cashRegister', 'sound.cashRegister', 'everyday', 1.4),
  effect('knock', 'sound.knock', 'everyday', 1),
  effect('tick', 'sound.tick', 'everyday', 2),
  effect('phoneRing', 'sound.phoneRing', 'everyday', 2.5),
  effect('siren', 'sound.siren', 'everyday', 3.2),
  effect('thunder', 'sound.thunder', 'nature', 4.5),
  effect('wind', 'sound.wind', 'nature', 4),
  effect('rain', 'sound.rain', 'nature', 4),
  effect('waterDrop', 'sound.waterDrop', 'nature', 0.7),
  { id: 'upbeat', category: 'music', label: 'sound.upbeat', seconds: 24 },
  { id: 'lofi', category: 'music', label: 'sound.lofi', seconds: 24 },
  { id: 'cinematic', category: 'music', label: 'sound.cinematic', seconds: 24 },
  { id: 'corporate', category: 'music', label: 'sound.corporate', seconds: 24 },
  { id: 'chill', category: 'music', label: 'sound.chill', seconds: 24 },
];

/** The effects' groups, in the order the panel shows them. */
export const EFFECT_GROUPS: readonly EffectGroup[] = ['transitions', 'interface', 'cartoon', 'drums', 'everyday', 'nature'];

export const soundById = (id: string): Sound | undefined => SOUNDS.find((sound) => sound.id === id);
