import { describe, expect, it } from 'vitest';

import {
  PROXY_LONG_EDGE,
  parseProgress,
  proxyArgs,
  proxyFileName,
  proxyKey,
  proxySize,
  worthProxying,
} from '../src/main/media/proxies';

const stamp = (overrides: Partial<{ path: string; bytes: number; modifiedMs: number }> = {}) => ({
  path: 'C:/footage/kratos.mp4',
  bytes: 1_900_000_000,
  modifiedMs: 1_758_300_000_000,
  ...overrides,
});

describe('which proxy belongs to which file', () => {
  it('gives the same file the same proxy every time', () => {
    expect(proxyKey(stamp())).toBe(proxyKey(stamp()));
  });

  it('does not care how the path is spelled: it is the same file on Windows', () => {
    expect(proxyKey(stamp())).toBe(proxyKey(stamp({ path: 'c:\\Footage\\Kratos.mp4' })));
  });

  it('builds a new one when the file itself changed', () => {
    // Re-rendered somewhere else under the same name: the old proxy is a
    // picture of something that no longer exists.
    expect(proxyKey(stamp({ bytes: 1_900_000_001 }))).not.toBe(proxyKey(stamp()));
    expect(proxyKey(stamp({ modifiedMs: 1_758_300_000_001 }))).not.toBe(proxyKey(stamp()));
  });

  it('keeps two different files apart', () => {
    expect(proxyKey(stamp({ path: 'C:/footage/thor.mp4' }))).not.toBe(proxyKey(stamp()));
    expect(proxyFileName(proxyKey(stamp()))).toMatch(/^[a-z0-9-]+\.mp4$/);
  });
});

describe('the size a proxy is made at', () => {
  it('brings 4K down to a quarter, keeping the shape', () => {
    expect(proxySize(3840, 2160)).toEqual({ width: 960, height: 540 });
  });

  it('brings 1080p down to a half', () => {
    expect(proxySize(1920, 1080)).toEqual({ width: 960, height: 540 });
  });

  it('handles a vertical clip by its own long edge', () => {
    expect(proxySize(2160, 3840)).toEqual({ width: 540, height: 960 });
  });

  it('never makes one bigger than the footage', () => {
    expect(proxySize(640, 360)).toEqual({ width: 640, height: 360 });
  });

  it('keeps both sides even, because H.264 cannot encode an odd one', () => {
    const size = proxySize(1999, 1103);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(PROXY_LONG_EDGE);
  });

  it('survives a file that measured as nothing', () => {
    expect(proxySize(0, 0)).toEqual({ width: 2, height: 2 });
  });
});

describe('what is worth a proxy', () => {
  it('is the footage that makes a timeline crawl', () => {
    expect(worthProxying(3840, 2160)).toBe(true);
    expect(worthProxying(1920, 1080)).toBe(true);
    expect(worthProxying(1080, 1920)).toBe(true);
  });

  it('is not a clip that already decodes in real time', () => {
    expect(worthProxying(1280, 720)).toBe(false);
    expect(worthProxying(640, 360)).toBe(false);
  });
});

describe('the encoder command', () => {
  const args = proxyArgs('C:/footage/kratos.mp4', 'C:/proxies/abc.mp4', { width: 960, height: 540 });

  it('drops the sound: it plays from the original', () => {
    expect(args).toContain('-an');
  });

  it('asks for short keyframe gaps, which is the whole point', () => {
    expect(args.join(' ')).toContain('-g 30');
  });

  it('scales to the size it was given, and writes where it was told', () => {
    expect(args.join(' ')).toContain('scale=960:540');
    expect(args[args.length - 1]).toBe('C:/proxies/abc.mp4');
  });
});

describe('reading ffmpeg progress', () => {
  it('turns finished output time into a fraction', () => {
    expect(parseProgress('out_time_us=5000000', 10)).toBeCloseTo(0.5);
    expect(parseProgress('out_time_ms=2500', 10)).toBeCloseTo(0.25);
  });

  it('ignores the lines that say nothing about progress', () => {
    expect(parseProgress('frame=120', 10)).toBeNull();
    expect(parseProgress('progress=continue', 10)).toBeNull();
    expect(parseProgress('', 10)).toBeNull();
  });

  it('never goes past the end, or below the start', () => {
    expect(parseProgress('out_time_us=99000000', 10)).toBe(1);
    expect(parseProgress('out_time_us=-1', 10)).toBeNull();
  });

  it('says nothing when the length is unknown', () => {
    expect(parseProgress('out_time_us=5000000', 0)).toBeNull();
  });
});
