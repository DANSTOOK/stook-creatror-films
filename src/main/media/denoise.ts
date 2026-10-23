import { execFile, spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { proxyKey } from './proxies';

/**
 * Noise reduction for a voice: the hiss of a room, a fan, a hum - taken out
 * of a file's sound by ffmpeg, once, and kept like a proxy. A high-pass at
 * 80 Hz first (rumble, handling, the mains' lower hum), then afftdn, which
 * pulls everything near the noise floor down by `nr` dB in each frequency
 * band - the spectral subtraction Audition's and Premiere's "Reduce noise"
 * are - while the voice, well above the floor, is left as it was.
 *
 * The floor is the file's own: measured first, as the level of its quietest
 * tenth (noiseFloorDb) - the pauses, where there is nothing but the room. A
 * fixed floor either missed a loud room entirely or ate the quiet of a voice;
 * afftdn's own tracking (tn) left the measured hiss of the test recording
 * where it was.
 */

export type DenoiseStrength = 'light' | 'medium' | 'strong';

/** How far the noise is pulled down, in dB, at each strength (measured: 10, 17, 25 dB of hiss gone). */
export const DENOISE_DB: Record<DenoiseStrength, number> = { light: 10, medium: 18, strong: 28 };

/** The floor afftdn is told sits this far above the quietest tenth's level: the bands of the hiss reach a little above its average. */
const FLOOR_MARGIN_DB = 3;

export function denoiseArgs(source: string, target: string, strength: DenoiseStrength, floorDb: number): string[] {
  const nf = Math.round(Math.min(-20, Math.max(-80, floorDb + FLOOR_MARGIN_DB)));
  return [
    '-hide_banner', '-v', 'error', '-y',
    '-i', source,
    '-vn',
    '-af', `highpass=f=80,afftdn=nr=${DENOISE_DB[strength]}:nf=${nf}`,
    '-c:a', 'aac', '-b:a', '192k',
    target,
  ];
}

/** The level of the quietest tenth of `levels` (dBFS, one a window): the floor. */
export function quietestTenth(levels: readonly number[]): number {
  if (levels.length === 0) return -60;
  const sorted = [...levels].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)];
}

/** Window levels (dBFS) of mono samples, 50 ms each. Pure. */
export function windowLevels(samples: Float32Array, sampleRate: number): number[] {
  const window = Math.max(1, Math.round(sampleRate * 0.05));
  const levels: number[] = [];
  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i += 1) sum += samples[i] * samples[i];
    levels.push(10 * Math.log10(sum / window + 1e-12));
  }
  return levels;
}

/** The noise floor of a sound, in dBFS: the level of its quietest tenth, in windows of 50 ms. Pure. */
export const noiseFloorDb = (samples: Float32Array, sampleRate: number): number => quietestTenth(windowLevels(samples, sampleRate));

const execFileAsync = promisify(execFile);
const MEASURE_RATE = 48000;

/**
 * The file's floor, read through ffmpeg at the full 48 kHz - the hiss is
 * mostly high, and a lower rate measured the floor 7 dB under itself - in
 * windows as it arrives, so an hour of sound costs its window levels, not
 * its samples.
 */
function measureFloor(ffmpeg: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(MEASURE_RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const window = Math.round(MEASURE_RATE * 0.05);
    const levels: number[] = [];
    let sum = 0;
    let count = 0;
    let carry = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const usable = bytes.length - (bytes.length % 4);
      for (let offset = 0; offset < usable; offset += 4) {
        const value = bytes.readFloatLE(offset);
        sum += value * value;
        count += 1;
        if (count === window) {
          levels.push(10 * Math.log10(sum / window + 1e-12));
          sum = 0;
          count = 0;
        }
      }
      carry = Buffer.from(bytes.subarray(usable));
    });
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', () => resolve(quietestTenth(levels)));
  });
}

export class DenoiseStore {
  private readonly building = new Map<string, Promise<string>>();

  constructor(
    private readonly folder: string,
    private readonly ffmpeg: string,
  ) {}

  /** The cleaned sound of `path` at `strength`: made now, or found from before. */
  async make(path: string, strength: DenoiseStrength): Promise<string> {
    const info = await stat(path);
    const key = `${proxyKey({ path, bytes: info.size, modifiedMs: info.mtimeMs })}-${strength}`;
    const target = join(this.folder, `${key}.m4a`);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size > 0) return target;
    const already = this.building.get(key);
    if (already) return already;
    const run = (async () => {
      await mkdir(this.folder, { recursive: true });
      const temporary = target.replace(/\.m4a$/, `.building-${process.pid}.m4a`);
      try {
        const floor = await measureFloor(this.ffmpeg, path);
        await execFileAsync(this.ffmpeg, denoiseArgs(path, temporary, strength, floor), { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        await rename(temporary, target);
        return target;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    })().finally(() => this.building.delete(key));
    this.building.set(key, run);
    return run;
  }
}
