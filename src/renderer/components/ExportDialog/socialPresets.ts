import { resolutionPresets } from '@shared/utils/resolution';
import { recommendedBitrateKbps } from '@shared/utils/bitrate';

/**
 * Exporting for a social network in one click - or for several at once, one
 * file each, named after the network.
 *
 * Each network has a shape it fills the screen with and a size it plays at
 * best. The export keeps the project's own shape - a picture is never
 * stretched or cropped behind the user's back - at the network's size on its
 * short side; when the shapes differ, the dialog says how it will show (with
 * bars) and that the project's shape is what to change for it to fill the
 * screen. MP4 / H.264 with AAC, which every one of them takes.
 */

export type SocialPlatformId = 'youtube' | 'youtube4k' | 'shorts' | 'tiktok' | 'reels' | 'instagram';

export interface SocialPlatform {
  id: SocialPlatformId;
  /** The network's own name, not translated. */
  name: string;
  /** The shape it fills the screen with, width over height. */
  aspect: { w: number; h: number };
  /** Its best size on the short side. */
  short: number;
  /** In the file name: "My video - TikTok.mp4". */
  suffix: string;
}

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  { id: 'youtube', name: 'YouTube', aspect: { w: 16, h: 9 }, short: 1080, suffix: 'YouTube' },
  { id: 'youtube4k', name: 'YouTube 4K', aspect: { w: 16, h: 9 }, short: 2160, suffix: 'YouTube 4K' },
  { id: 'shorts', name: 'YouTube Shorts', aspect: { w: 9, h: 16 }, short: 1080, suffix: 'Shorts' },
  { id: 'tiktok', name: 'TikTok', aspect: { w: 9, h: 16 }, short: 1080, suffix: 'TikTok' },
  { id: 'reels', name: 'Instagram Reels', aspect: { w: 9, h: 16 }, short: 1080, suffix: 'Reels' },
  { id: 'instagram', name: 'Instagram', aspect: { w: 4, h: 5 }, short: 1080, suffix: 'Instagram' },
];

/** Whether a frame of this size fills the network's screen: the same shape, within 2 %. */
export function fillsScreen(platform: SocialPlatform, width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  const want = platform.aspect.w / platform.aspect.h;
  return Math.abs(width / height / want - 1) < 0.02;
}

/** The size a project exports at for a network: its own shape, the network's short side. */
export function socialSize(platform: SocialPlatform, projectWidth: number, projectHeight: number): { width: number; height: number } {
  const presets = resolutionPresets(projectWidth, projectHeight);
  const id = platform.short >= 2160 ? '2160p' : platform.short >= 1440 ? '1440p' : platform.short >= 1080 ? '1080p' : '720p';
  const match = presets.find((preset) => preset.id === id) ?? presets[0];
  return { width: match.width, height: match.height };
}

/** The export settings a network asks for, at a frame rate (kept, but never past 60). */
export function socialSettings(platform: SocialPlatform, projectWidth: number, projectHeight: number, fps: number) {
  const size = socialSize(platform, projectWidth, projectHeight);
  const rate = Math.min(60, fps);
  return {
    format: 'mp4-h264' as const,
    exportAlpha: false,
    width: size.width,
    height: size.height,
    bitrateKbps: recommendedBitrateKbps(size.width, size.height, rate),
  };
}

/** How a project of this shape shows on a network: 'fills', or with bars at its sides or above and below. */
export function socialFit(platform: SocialPlatform, width: number, height: number): 'fills' | 'pillarbox' | 'letterbox' {
  if (fillsScreen(platform, width, height)) return 'fills';
  return width / height < platform.aspect.w / platform.aspect.h ? 'pillarbox' : 'letterbox';
}
