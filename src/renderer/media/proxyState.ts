/**
 * What the interface needs to know about proxies.
 *
 * Kept apart from the building itself so the rules can be checked without an
 * ffmpeg anywhere near them: which clips are worth a proxy, what a library
 * looks like halfway through building them, and what the button should say.
 */

import type { MediaAsset } from '@shared/types';
import { translate, type Language } from '@shared/i18n';

export const PROXY_STORAGE_KEY = 'scf.useProxies.v1';

/** Footage at least this wide is worth a proxy. Mirrors the main process's rule. */
export const PROXY_WORTH_IT_WIDTH = 1920;

export type ProxyPhase = 'none' | 'building' | 'ready';

export interface ProxyStatus {
  phase: ProxyPhase;
  /** 0 to 1 while building. */
  fraction: number;
}

/** Is this asset one a proxy would help with? */
export function wantsProxy(asset: MediaAsset): boolean {
  return asset.kind === 'video' && !asset.missing && Math.max(asset.width, asset.height) >= PROXY_WORTH_IT_WIDTH;
}

/** Those still to build: heavy footage with no proxy yet. */
export function pendingProxies(assets: readonly MediaAsset[]): MediaAsset[] {
  return assets.filter((asset) => wantsProxy(asset) && !asset.proxyUri);
}

export function proxyPhaseOf(
  asset: MediaAsset,
  building: ReadonlyMap<string, number>,
): ProxyStatus {
  const fraction = building.get(asset.id);
  if (fraction !== undefined) return { phase: 'building', fraction };
  return asset.proxyUri ? { phase: 'ready', fraction: 1 } : { phase: 'none', fraction: 0 };
}

/**
 * The line under the proxy button.
 *
 * It says what is true rather than what is being done to be reassuring: how
 * many are ready out of how many need one, and what is happening right now.
 */
export function proxySummary(
  assets: readonly MediaAsset[],
  building: ReadonlyMap<string, number>,
  language: Language = 'en',
): string {
  const heavy = assets.filter(wantsProxy);
  if (heavy.length === 0) return translate(language, 'proxy.summaryNone');

  const ready = heavy.filter((asset) => asset.proxyUri).length;
  const total = heavy.length;
  if (building.size > 0) {
    const done = [...building.values()].reduce((sum, fraction) => sum + fraction, 0);
    const percent = Math.round((done / building.size) * 100);
    return translate(language, 'proxy.summaryBuilding', { count: building.size, total, percent });
  }
  if (ready === total) return translate(language, 'proxy.summaryAllReady', { ready, total });
  return translate(language, 'proxy.summaryReady', { ready, total });
}

/** Bytes as something a person reads. */
export function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
