import type { EncoderOption, GpuDevice, GpuEncoder, GpuPreference, GpuVendor } from '@shared/types';

/**
 * Pure GPU bookkeeping: no Electron, no child processes, so every rule here is
 * unit tested.
 *
 * Measured on the target machine (RTX 4060 Laptop + Intel UHD Graphics):
 * `app.getGPUInfo('complete')` lists every adapter with its PCI vendor and
 * device ids and Chromium's own `gpuPreference` classification, but no names.
 * The names come from Windows (`Win32_VideoController`), matched on those ids.
 */

/** PCI vendor ids. */
export const VENDOR_IDS = {
  nvidia: 0x10de,
  intel: 0x8086,
  amd: 0x1002,
  apple: 0x106b,
  /** "Microsoft Basic Render Driver" - the software rasterizer, never a real GPU. */
  microsoft: 0x1414,
} as const;

/**
 * Chromium's `gl::GpuPreference`: 0 none, 1 default, 2 low power, 3 high
 * performance. It reflects how Windows classifies each adapter, which is the
 * right definition of "dedicated" and "integrated" - vendor alone is not, since
 * Intel also makes discrete cards (Arc).
 */
const CHROMIUM_LOW_POWER = 2;
const CHROMIUM_HIGH_PERFORMANCE = 3;

export function vendorOf(vendorId: number): GpuVendor {
  switch (vendorId) {
    case VENDOR_IDS.nvidia:
      return 'nvidia';
    case VENDOR_IDS.intel:
      return 'intel';
    case VENDOR_IDS.amd:
      return 'amd';
    case VENDOR_IDS.apple:
      return 'apple';
    default:
      return 'other';
  }
}

/** The subset of Chromium's gpuDevice entries this module reads. */
export interface RawGpuDevice {
  vendorId: number;
  deviceId: number;
  active?: boolean;
  gpuPreference?: number;
}

/** A name reported by the OS, keyed by the same PCI ids. */
export interface AdapterName {
  vendorId: number;
  deviceId: number;
  name: string;
}

const FALLBACK_NAMES: Record<GpuVendor, string> = {
  nvidia: 'NVIDIA GPU',
  intel: 'Intel GPU',
  amd: 'AMD GPU',
  apple: 'Apple GPU',
  other: 'GPU',
};

/**
 * Merge Chromium's adapter list with the OS names.
 *
 * The software rasterizer is dropped: offering "Microsoft Basic Render Driver"
 * as a place to render video would be a trap.
 */
export function classifyDevices(raw: readonly RawGpuDevice[], names: readonly AdapterName[]): GpuDevice[] {
  const seen = new Set<string>();
  const devices: GpuDevice[] = [];

  for (const device of raw) {
    if (device.vendorId === VENDOR_IDS.microsoft || device.vendorId === 0) continue;

    const key = `${device.vendorId}:${device.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const vendor = vendorOf(device.vendorId);
    const named = names.find(
      (entry) => entry.vendorId === device.vendorId && entry.deviceId === device.deviceId,
    );

    devices.push({
      vendorId: device.vendorId,
      deviceId: device.deviceId,
      vendor,
      name: named?.name ?? FALLBACK_NAMES[vendor],
      kind:
        device.gpuPreference === CHROMIUM_HIGH_PERFORMANCE
          ? 'dedicated'
          : device.gpuPreference === CHROMIUM_LOW_POWER
            ? 'integrated'
            : 'unknown',
      active: device.active === true,
    });
  }

  return devices;
}

/**
 * Parse `PNPDeviceID` strings such as
 * `PCI\VEN_10DE&DEV_28A0&SUBSYS_...` into PCI ids.
 */
export function parsePnpIds(pnpDeviceId: string): { vendorId: number; deviceId: number } | null {
  const match = /VEN_([0-9A-F]{4}).*?DEV_([0-9A-F]{4})/i.exec(pnpDeviceId);
  if (!match) return null;
  return { vendorId: parseInt(match[1], 16), deviceId: parseInt(match[2], 16) };
}

/** Which vendor's silicon runs each ffmpeg hardware encoder. */
export const ENCODER_VENDOR: Record<GpuEncoder, GpuVendor> = {
  nvenc: 'nvidia',
  qsv: 'intel',
  amf: 'amd',
  videotoolbox: 'apple',
};

/**
 * Attach each working encoder to the GPU it runs on.
 *
 * When a vendor has more than one adapter (an AMD APU next to a Radeon card),
 * the dedicated one is preferred: that is where the encoder block that ffmpeg
 * opens by default lives on every machine this has been checked on.
 */
export function attachEncoders(working: readonly GpuEncoder[], devices: readonly GpuDevice[]): EncoderOption[] {
  return working.map((encoder) => {
    const candidates = devices.filter((device) => device.vendor === ENCODER_VENDOR[encoder]);
    const gpu =
      candidates.find((device) => device.kind === 'dedicated') ?? candidates[0] ?? null;
    return { encoder, gpu };
  });
}

/** The Chromium switch that realises a preference, if any. */
export function switchForPreference(preference: GpuPreference): string | null {
  switch (preference) {
    case 'high-performance':
      return 'force_high_performance_gpu';
    case 'low-power':
      return 'force_low_power_gpu';
    default:
      return null;
  }
}

export function isGpuPreference(value: unknown): value is GpuPreference {
  return value === 'auto' || value === 'high-performance' || value === 'low-power';
}
