import { describe, expect, it } from 'vitest';
import { SOCIAL_PLATFORMS, fillsScreen, socialFit, socialSettings, socialSize } from '@renderer/components/ExportDialog/socialPresets';

const platform = (id: string) => SOCIAL_PLATFORMS.find((candidate) => candidate.id === id)!;

describe('exporting for social networks', () => {
  it('a vertical project fills TikTok, Reels and Shorts at 1080x1920', () => {
    for (const id of ['tiktok', 'reels', 'shorts']) {
      expect(socialSize(platform(id), 1080, 1920)).toEqual({ width: 1080, height: 1920 });
      expect(socialFit(platform(id), 1080, 1920)).toBe('fills');
    }
  });

  it('a landscape project keeps its shape for a vertical network, and shows with bars above and below', () => {
    expect(socialSize(platform('tiktok'), 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(socialFit(platform('tiktok'), 1920, 1080)).toBe('letterbox');
    expect(fillsScreen(platform('tiktok'), 1920, 1080)).toBe(false);
  });

  it('a vertical project on YouTube shows with bars at the sides', () => {
    expect(socialFit(platform('youtube'), 1080, 1920)).toBe('pillarbox');
  });

  it('YouTube 4K is the project at 2160 on its short side', () => {
    expect(socialSize(platform('youtube4k'), 1920, 1080)).toEqual({ width: 3840, height: 2160 });
  });

  it('asks for MP4 / H.264 with no alpha, a bitrate for the size, and no more than 60 fps', () => {
    const at30 = socialSettings(platform('youtube'), 1920, 1080, 30);
    const at120 = socialSettings(platform('youtube'), 1920, 1080, 120);
    expect(at30.format).toBe('mp4-h264');
    expect(at30.exportAlpha).toBe(false);
    expect(at30.bitrateKbps).toBeGreaterThan(4000);
    expect(at120.bitrateKbps).toBe(socialSettings(platform('youtube'), 1920, 1080, 60).bitrateKbps);
  });

  it('Instagram feed is 4:5: a 1080x1350 project fills it', () => {
    expect(socialFit(platform('instagram'), 1080, 1350)).toBe('fills');
    expect(socialSize(platform('instagram'), 1080, 1350)).toEqual({ width: 1080, height: 1350 });
  });
});
