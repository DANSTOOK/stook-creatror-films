import { describe, expect, it } from 'vitest';
import type { EncoderOption, ExportSettings, GpuDevice } from '@shared/types';
import {
  VENDOR_IDS,
  attachEncoders,
  classifyDevices,
  isGpuPreference,
  parsePnpIds,
  switchForPreference,
  type RawGpuDevice,
} from '@main/gpu/classify';
import { encoderProbeArgs, videoCodecArgs } from '@main/exporter/HardwareAccel';
import { resolveEncoderPlan } from '@renderer/engine/encoderPlan';
import { DEFAULT_EXPORT_SETTINGS } from '@renderer/store/types';

/**
 * GPU selection for export.
 *
 * The fixtures are not invented: they are what `app.getGPUInfo('complete')` and
 * `Win32_VideoController` returned on the reference machine, a laptop with an
 * RTX 4060 and Intel UHD Graphics.
 */

const MEASURED_DEVICES: RawGpuDevice[] = [
  { active: true, deviceId: 10400, gpuPreference: 3, vendorId: 4318 }, // RTX 4060
  { active: false, deviceId: 42888, gpuPreference: 2, vendorId: 32902 }, // Intel UHD
  { active: false, deviceId: 140, gpuPreference: 0, vendorId: 5140 }, // Basic Render Driver
];

const MEASURED_NAMES = [
  { ...parsePnpIds('PCI\\VEN_10DE&DEV_28A0&SUBSYS_299D1043&REV_A1\\4&3AF7A62C&0&0008')!, name: 'NVIDIA GeForce RTX 4060 Laptop GPU' },
  { ...parsePnpIds('PCI\\VEN_8086&DEV_A788&SUBSYS_16E31043&REV_04\\3&11583659&0&10')!, name: 'Intel(R) UHD Graphics' },
];

const devices = classifyDevices(MEASURED_DEVICES, MEASURED_NAMES);
const rtx = devices.find((device) => device.vendor === 'nvidia') as GpuDevice;
const intel = devices.find((device) => device.vendor === 'intel') as GpuDevice;

describe('classifyDevices', () => {
  it('names each GPU from Windows, matched on PCI ids', () => {
    expect(rtx.name).toBe('NVIDIA GeForce RTX 4060 Laptop GPU');
    expect(intel.name).toBe('Intel(R) UHD Graphics');
  });

  it("uses Chromium's own classification for dedicated and integrated", () => {
    expect(rtx.kind).toBe('dedicated');
    expect(intel.kind).toBe('integrated');
  });

  it('drops the software rasterizer, which is not a place to render video', () => {
    expect(devices).toHaveLength(2);
    expect(devices.some((device) => device.vendorId === VENDOR_IDS.microsoft)).toBe(false);
  });

  it('marks the GPU the compositor is on', () => {
    expect(rtx.active).toBe(true);
    expect(intel.active).toBe(false);
  });

  it('falls back to a vendor name when Windows gives none', () => {
    expect(classifyDevices(MEASURED_DEVICES, [])[0].name).toBe('NVIDIA GPU');
  });

  it('lists an adapter once even if Chromium repeats it', () => {
    expect(classifyDevices([MEASURED_DEVICES[0], MEASURED_DEVICES[0]], [])).toHaveLength(1);
  });

  it('does not decide dedicated or integrated from the vendor alone', () => {
    // Intel makes discrete cards too (Arc). Only the OS classification counts.
    const arc = classifyDevices([{ vendorId: 0x8086, deviceId: 0x56a0, gpuPreference: 3 }], []);
    expect(arc[0].kind).toBe('dedicated');
  });
});

describe('parsePnpIds', () => {
  it('reads vendor and device ids out of a PNP device id', () => {
    expect(parsePnpIds('PCI\\VEN_10DE&DEV_28A0&SUBSYS_1')).toEqual({ vendorId: 0x10de, deviceId: 0x28a0 });
  });

  it('refuses anything that is not a PCI id', () => {
    expect(parsePnpIds('ROOT\\BasicRender\\0000')).toBeNull();
  });
});

describe('attachEncoders', () => {
  it('puts each working encoder on the GPU that runs it', () => {
    const options = attachEncoders(['nvenc', 'qsv'], devices);
    expect(options.find((option) => option.encoder === 'nvenc')?.gpu?.name).toContain('RTX 4060');
    expect(options.find((option) => option.encoder === 'qsv')?.gpu?.name).toContain('UHD');
  });

  it('prefers the dedicated adapter when a vendor has two', () => {
    const amd = classifyDevices(
      [
        { vendorId: 0x1002, deviceId: 1, gpuPreference: 2 },
        { vendorId: 0x1002, deviceId: 2, gpuPreference: 3 },
      ],
      [],
    );
    expect(attachEncoders(['amf'], amd)[0].gpu?.deviceId).toBe(2);
  });

  it('keeps an encoder whose GPU could not be matched, without inventing one', () => {
    expect(attachEncoders(['nvenc'], [])[0].gpu).toBeNull();
  });
});

describe('GPU preference', () => {
  it('maps each preference to the Chromium switch that realises it', () => {
    expect(switchForPreference('high-performance')).toBe('force_high_performance_gpu');
    expect(switchForPreference('low-power')).toBe('force_low_power_gpu');
    expect(switchForPreference('auto')).toBeNull();
  });

  it('rejects anything else, because it becomes a command-line switch', () => {
    expect(isGpuPreference('low-power')).toBe(true);
    expect(isGpuPreference('--disable-gpu')).toBe(false);
    expect(isGpuPreference(undefined)).toBe(false);
  });
});

describe('encoder probing', () => {
  it('actually encodes frames rather than asking what the build contains', () => {
    const args = encoderProbeArgs('h264_nvenc');
    expect(args).toContain('h264_nvenc');
    expect(args).not.toContain('-encoders');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('5');
  });

  it('sends automatic to ffmpeg as the CPU if it ever gets that far', () => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS, hardwareEncoder: 'auto' as const };
    const args = videoCodecArgs(settings);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
  });
});

describe('resolveEncoderPlan', () => {
  const both: EncoderOption[] = attachEncoders(['nvenc', 'qsv'], devices);
  const webCodecs = { codec: 'avc1.640033', pipeMode: 'annexb-h264' as const };
  const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
    ...DEFAULT_EXPORT_SETTINGS,
    ...overrides,
  });

  it('honours an explicit encoder instead of silently using WebCodecs', () => {
    // This is the bug: NVENC was picked and WebCodecs was used anyway.
    const plan = resolveEncoderPlan({
      settings: settings({ hardwareEncoder: 'qsv' }),
      webCodecs,
      encoders: both,
      activeGpu: rtx,
    });
    expect(plan.pipeMode).toBe('rawvideo');
    expect(plan.hardwareEncoder).toBe('qsv');
    expect(plan.label).toContain('Intel(R) UHD Graphics');
  });

  it('honours the CPU when asked', () => {
    const plan = resolveEncoderPlan({
      settings: settings({ hardwareEncoder: 'none' }),
      webCodecs,
      encoders: both,
      activeGpu: rtx,
    });
    expect(plan).toMatchObject({ pipeMode: 'rawvideo', hardwareEncoder: 'none' });
  });

  it('prefers WebCodecs on automatic, since the frame never leaves the GPU', () => {
    const plan = resolveEncoderPlan({ settings: settings(), webCodecs, encoders: both, activeGpu: rtx });
    expect(plan.pipeMode).toBe('annexb-h264');
    expect(plan.label).toContain('RTX 4060');
  });

  it('on automatic without WebCodecs, uses the encoder on the GPU the compositor is on', () => {
    const onIntel = resolveEncoderPlan({
      settings: settings(),
      webCodecs: null,
      encoders: both,
      activeGpu: { ...intel, active: true },
    });
    expect(onIntel.hardwareEncoder).toBe('qsv');

    const onRtx = resolveEncoderPlan({ settings: settings(), webCodecs: null, encoders: both, activeGpu: rtx });
    expect(onRtx.hardwareEncoder).toBe('nvenc');
  });

  it('falls back to the CPU when no hardware encoder works', () => {
    const plan = resolveEncoderPlan({ settings: settings(), webCodecs: null, encoders: [], activeGpu: rtx });
    expect(plan.hardwareEncoder).toBe('none');
  });

  it('says so when a saved encoder is not available on this machine', () => {
    const plan = resolveEncoderPlan({
      settings: settings({ hardwareEncoder: 'amf' }),
      webCodecs: null,
      encoders: both,
      activeGpu: rtx,
    });
    expect(plan.hardwareEncoder).toBe('nvenc');
    expect(plan.note).toContain('AMD AMF is not available');
  });

  it('keeps alpha on the CPU whatever was picked', () => {
    const plan = resolveEncoderPlan({
      settings: settings({ format: 'webm-vp9', exportAlpha: true, hardwareEncoder: 'nvenc' }),
      webCodecs: null,
      encoders: both,
      activeGpu: rtx,
    });
    expect(plan.hardwareEncoder).toBe('none');
  });

  it('never hands a hardware encoder to a format that has none', () => {
    const plan = resolveEncoderPlan({
      settings: settings({ format: 'prores4444', hardwareEncoder: 'nvenc' }),
      webCodecs: null,
      encoders: both,
      activeGpu: rtx,
    });
    expect(plan.hardwareEncoder).toBe('none');
  });
});
