import { describe, expect, it } from 'vitest';

import {
  pendingProxies,
  proxyPhaseOf,
  proxySummary,
  readableBytes,
  wantsProxy,
} from '@renderer/media/proxyState';
import type { MediaAsset } from '@shared/types';

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a',
  name: 'shot.mp4',
  uri: 'media://a',
  kind: 'video',
  durationFrames: 300,
  width: 3840,
  height: 2160,
  hasAlphaChannel: false,
  ...overrides,
});

describe('which footage wants a proxy', () => {
  it('is video big enough to be slow', () => {
    expect(wantsProxy(asset())).toBe(true);
    expect(wantsProxy(asset({ width: 1920, height: 1080 }))).toBe(true);
    expect(wantsProxy(asset({ width: 1080, height: 1920 }))).toBe(true);
  });

  it('is not sound, not a still, and not a small clip', () => {
    expect(wantsProxy(asset({ kind: 'audio' }))).toBe(false);
    expect(wantsProxy(asset({ kind: 'image' }))).toBe(false);
    expect(wantsProxy(asset({ width: 1280, height: 720 }))).toBe(false);
  });

  it('is not a file that is no longer there', () => {
    expect(wantsProxy(asset({ missing: true }))).toBe(false);
  });

  it('leaves out what already has one', () => {
    const library = [asset({ id: 'a' }), asset({ id: 'b', proxyUri: 'media://proxy-b' })];
    expect(pendingProxies(library).map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('what the strip says', () => {
  it('says nothing is needed when nothing is heavy', () => {
    expect(proxySummary([asset({ width: 1280, height: 720 })], new Map())).toContain('heavy enough');
  });

  it('counts what is ready, and repeats where the export reads from', () => {
    const library = [asset({ id: 'a', proxyUri: 'media://p' }), asset({ id: 'b', proxyUri: 'media://q' })];
    expect(proxySummary(library, new Map())).toBe('2 of 2 ready. Exports still use the originals.');
  });

  it('does not claim to be finished while one is missing', () => {
    const library = [asset({ id: 'a', proxyUri: 'media://p' }), asset({ id: 'b' })];
    expect(proxySummary(library, new Map())).toBe('1 of 2 ready.');
  });

  it('reports how far the build has got', () => {
    const library = [asset({ id: 'a' }), asset({ id: 'b' })];
    expect(proxySummary(library, new Map([['a', 0.5]]))).toBe('Building 1 of 2... 50%');
  });
});

describe('the state of one clip', () => {
  it('is building while it is being built, whatever else is true', () => {
    expect(proxyPhaseOf(asset({ proxyUri: 'media://p' }), new Map([['a', 0.25]]))).toEqual({
      phase: 'building',
      fraction: 0.25,
    });
  });

  it('is ready once it has one, and none before that', () => {
    expect(proxyPhaseOf(asset({ proxyUri: 'media://p' }), new Map()).phase).toBe('ready');
    expect(proxyPhaseOf(asset(), new Map()).phase).toBe('none');
  });
});

describe('sizes people can read', () => {
  it('scales up to the right unit', () => {
    expect(readableBytes(512)).toBe('512 B');
    expect(readableBytes(2048)).toBe('2.0 KB');
    expect(readableBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(readableBytes(1900 * 1024 * 1024)).toBe('1.9 GB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(readableBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});
