import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuDevice, GpuReport } from '@shared/types';
import { probeHardwareEncoders } from '../exporter/HardwareAccel';
import { attachEncoders, classifyDevices, parsePnpIds, type AdapterName, type RawGpuDevice } from './classify';
import { appliedGpuPreference, effectiveGpuPreference } from './gpuSettings';

const execFileAsync = promisify(execFile);

/**
 * Adapter names from Windows.
 *
 * Chromium reports PCI ids but no names, and "0x10de:0x28a0" is not something
 * to put in a menu. `Win32_VideoController` has both. Any failure - another
 * OS, a locked-down machine - degrades to vendor names, never to an error.
 */
async function readAdapterNames(): Promise<AdapterName[]> {
  if (process.platform !== 'win32') return [];

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.PNPDeviceID)|$($_.Name)" }',
      ],
      { timeout: 8000, windowsHide: true },
    );

    return stdout
      .split(/\r?\n/)
      .map((line) => {
        const [pnp, ...rest] = line.split('|');
        const ids = parsePnpIds(pnp ?? '');
        const name = rest.join('|').trim();
        return ids && name ? { ...ids, name } : null;
      })
      .filter((entry): entry is AdapterName => entry !== null);
  } catch {
    return [];
  }
}

let cachedDevices: GpuDevice[] | null = null;

async function listDevices(): Promise<GpuDevice[]> {
  if (cachedDevices) return cachedDevices;

  const [info, names] = await Promise.all([
    app.getGPUInfo('complete') as Promise<{ gpuDevice?: RawGpuDevice[] }>,
    readAdapterNames(),
  ]);

  cachedDevices = classifyDevices(info.gpuDevice ?? [], names);
  return cachedDevices;
}

/** Everything the export dialog needs to offer a real choice of hardware. */
export async function getGpuReport(): Promise<GpuReport> {
  const [devices, working] = await Promise.all([listDevices(), probeHardwareEncoders()]);

  return {
    devices,
    preference: effectiveGpuPreference(),
    appliedPreference: appliedGpuPreference(),
    encoders: attachEncoders(working, devices),
  };
}
