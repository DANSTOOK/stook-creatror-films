/**
 * Export resolution presets, the way other editors list them - 720p, 1080p,
 * 2K, 4K - but fitted to the PROJECT's shape.
 *
 * The preset names the short side. A 16:9 project at "1080p" exports 1920x1080;
 * a vertical 9:16 phone project at "1080p" exports 1080x1920, not a landscape
 * frame with its picture squashed or letterboxed. Dimensions are rounded to
 * even numbers, because yuv420p - what every MP4 player expects - cannot
 * represent an odd width or height.
 */

export interface ResolutionPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

const SHORT_SIDES: { id: string; name: string; short: number }[] = [
  { id: '720p', name: '720p HD', short: 720 },
  { id: '1080p', name: '1080p Full HD', short: 1080 },
  { id: '1440p', name: '2K QHD (1440p)', short: 1440 },
  { id: '2160p', name: '4K UHD (2160p)', short: 2160 },
];

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

export function resolutionPresets(projectWidth: number, projectHeight: number): ResolutionPreset[] {
  const width = projectWidth > 0 ? projectWidth : 1920;
  const height = projectHeight > 0 ? projectHeight : 1080;
  const landscape = width >= height;
  const aspect = width / height;

  const presets: ResolutionPreset[] = [
    { id: 'project', label: `Project (${width}x${height})`, width: even(width), height: even(height) },
  ];

  for (const { id, name, short } of SHORT_SIDES) {
    const presetWidth = landscape ? even(short * aspect) : short;
    const presetHeight = landscape ? short : even(short / aspect);
    presets.push({ id, label: `${name} - ${presetWidth}x${presetHeight}`, width: presetWidth, height: presetHeight });
  }

  return presets;
}

/** The preset matching a size exactly, or null for a custom size. */
export function matchPreset(
  presets: readonly ResolutionPreset[],
  width: number,
  height: number,
): ResolutionPreset | null {
  return presets.find((preset) => preset.width === width && preset.height === height) ?? null;
}
