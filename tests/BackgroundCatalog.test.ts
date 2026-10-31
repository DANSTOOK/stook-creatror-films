import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n/en';
import { es } from '@shared/i18n/es';
import { BACKGROUNDS, BACKGROUND_GROUPS, backgroundById } from '@renderer/backgrounds/catalog';

/**
 * The background catalog: twenty-four full-frame pictures in four groups, each
 * named in both languages. The pictures themselves are judged in the running
 * app (tests/ui/backgrounds.mjs); here, what the panel and the file names rely
 * on.
 */

describe('the background catalog', () => {
  it('has twenty-four backgrounds, each its own id', () => {
    expect(BACKGROUNDS).toHaveLength(24);
    expect(new Set(BACKGROUNDS.map((background) => background.id)).size).toBe(BACKGROUNDS.length);
    expect(backgroundById('sunrise')?.group).toBe('gradients');
    expect(backgroundById('cityNight')?.group).toBe('scenes');
  });

  it('puts every background in a group the panel shows, five or more to each group', () => {
    for (const background of BACKGROUNDS) expect(BACKGROUND_GROUPS).toContain(background.group);
    for (const group of BACKGROUND_GROUPS) expect(BACKGROUNDS.filter((background) => background.group === group).length).toBeGreaterThanOrEqual(5);
  });

  it('names each in both languages', () => {
    for (const background of BACKGROUNDS) {
      expect(en[background.label], background.id).toBeTruthy();
      expect(es[background.label], background.id).toBeTruthy();
    }
  });

  it('keeps every id its own once it is folded into a file name', () => {
    // The picture is kept as `bg-<id>-<width>x<height>.png`, and the main process
    // lowercases the name and drops everything but a-z, 0-9 and a dash. Two ids
    // that fold to the same name would be one file, so one background would
    // quietly show the other.
    const folded = BACKGROUNDS.map((background) => `bg-${background.id}`.toLowerCase().replace(/[^a-z0-9-]/g, ''));
    expect(new Set(folded).size).toBe(BACKGROUNDS.length);
    for (const name of folded) expect(name.length).toBeGreaterThan(3);
  });

  it('draws every background', () => {
    for (const background of BACKGROUNDS) expect(typeof background.draw, background.id).toBe('function');
  });
});

describe('a background that moves', () => {
  it('uses a loop slow enough for a whole frame, not a sticker\u2019s', async () => {
    const { animationPhase, animationPoseAt } = await import('@renderer/fx/motion/animations');
    const { BACKGROUND_LOOP } = await import('@renderer/backgrounds/addBackground');
    expect(animationPhase(BACKGROUND_LOOP)).toBe('loop');
    // It must come round to where it began, or the join would jump.
    const start = animationPoseAt(BACKGROUND_LOOP, 0);
    const end = animationPoseAt(BACKGROUND_LOOP, 1);
    expect(end.x ?? 0).toBeCloseTo(start.x ?? 0, 4);
    expect(end.scale ?? 1).toBeCloseTo(start.scale ?? 1, 4);
  });

  it('never shows an edge: the three slow loops all sit closer than the frame', async () => {
    const { animationPoseAt } = await import('@renderer/fx/motion/animations');
    for (const id of ['driftSlow', 'breathSlow', 'glideSlow'] as const) {
      for (let u = 0; u <= 1; u += 0.05) {
        const pose = animationPoseAt(id, u);
        const scale = pose.scale ?? 1;
        // Pushed in by more than it ever moves, each way.
        expect(scale - 1, `${id} at ${u.toFixed(2)}`).toBeGreaterThan(2 * Math.abs(pose.x ?? 0));
        expect(scale - 1, `${id} at ${u.toFixed(2)}`).toBeGreaterThan(2 * Math.abs(pose.y ?? 0));
      }
    }
  });
});
