import { describe, expect, it } from 'vitest';
import { MATTE_MODEL_IDS } from '@shared/types';
import { MATTE_MODELS, matteModelById, modelInputSize } from '../src/main/matting/catalog';
import { chooseDevice, deviceOverride, matmulProbeModel } from '../src/main/matting/device';
import { matteFfmpegArgs } from '../src/main/matting/job';
import { MATTE_RECIPE, matteKey } from '../src/main/matting/matteStore';
import { outputToMatte, rgbToPlanar } from '../src/main/matting/pixels';
import { createClip, normalizeBackgroundRemoval, normalizeProject, createEmptyProject } from '@renderer/store/types';

describe('the matting model catalogue', () => {
  it('offers exactly the models a clip can name', () => {
    expect(MATTE_MODELS.map((model) => model.id).sort()).toEqual([...MATTE_MODEL_IDS].sort());
  });

  it('fixes a size and a SHA-256 for every file, and pins every download to one commit', () => {
    for (const model of MATTE_MODELS) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.bytes).toBeGreaterThan(1_000_000);
      expect(model.url.startsWith('https://huggingface.co/')).toBe(true);
      // A branch name would let the file change under the hash; a commit cannot.
      expect(model.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(['MIT', 'Apache-2.0', 'BSD-3-Clause']).toContain(model.licence);
    }
  });

  it('knows its models by id and nothing else', () => {
    expect(matteModelById('precise')?.file).toBe('birefnet-lite-fp16.onnx');
    expect(matteModelById('fast')?.file).toBe('modnet.onnx');
    expect(matteModelById('rvm')).toBeUndefined();
    expect(matteModelById(undefined)).toBeUndefined();
  });

  it('feeds BiRefNet its fixed square and MODNet the frame shape at 512, in 32s', () => {
    const precise = matteModelById('precise');
    const fast = matteModelById('fast');
    if (!precise || !fast) throw new Error('catalogue');
    expect(modelInputSize(precise, 1280, 720)).toEqual({ width: 1024, height: 1024 });
    expect(modelInputSize(fast, 1280, 720)).toEqual({ width: 896, height: 512 });
    expect(modelInputSize(fast, 1080, 1920)).toEqual({ width: 512, height: 896 });
    expect(modelInputSize(fast, 3840, 2160)).toEqual({ width: 896, height: 512 });
  });
});

describe('matte cache keys', () => {
  const stamp = { path: 'C:\\Footage\\Shot.mp4', bytes: 1000, modifiedMs: 1_700_000_000_000 };

  it('is the same for the same file and model', () => {
    expect(matteKey(stamp, 'precise')).toBe(matteKey({ ...stamp }, 'precise'));
    // Windows paths compare without case or slash direction.
    expect(matteKey({ ...stamp, path: 'c:/footage/shot.mp4' }, 'precise')).toBe(matteKey(stamp, 'precise'));
  });

  it('changes with the file, its size, its time and the model', () => {
    const base = matteKey(stamp, 'precise');
    expect(matteKey({ ...stamp, path: 'C:\\Footage\\Other.mp4' }, 'precise')).not.toBe(base);
    expect(matteKey({ ...stamp, bytes: 1001 }, 'precise')).not.toBe(base);
    expect(matteKey({ ...stamp, modifiedMs: stamp.modifiedMs + 2000 }, 'precise')).not.toBe(base);
    expect(matteKey(stamp, 'fast')).not.toBe(base);
  });

  it('says how the mattes were made, so a new recipe is not read as the old', () => {
    expect(matteKey(stamp, 'fast')).toContain(`.${MATTE_RECIPE}`);
    // Unsmoothed mattes, made only to measure the smoothing, are never found as the real ones.
    expect(matteKey(stamp, 'fast', false)).not.toBe(matteKey(stamp, 'fast'));
  });
});

describe('choosing the device', () => {
  it('takes the fastest GPU when it is at least twice the processor', () => {
    // Measured on the target laptop: CPU 75 ms, RTX 4060 10 ms, Intel UHD 74 ms.
    expect(chooseDevice(75, [{ index: 0, ms: 10 }, { index: 1, ms: 74 }])).toEqual({ kind: 'dml', index: 0 });
    expect(chooseDevice(75, [{ index: 0, ms: 74 }, { index: 1, ms: 10 }])).toEqual({ kind: 'dml', index: 1 });
  });

  it('stays on the processor when no GPU is clearly faster, or none works', () => {
    expect(chooseDevice(75, [{ index: 0, ms: 74 }])).toEqual({ kind: 'cpu' });
    expect(chooseDevice(75, [])).toEqual({ kind: 'cpu' });
    expect(chooseDevice(75, [{ index: 0, ms: Infinity }])).toEqual({ kind: 'cpu' });
  });

  it('takes a GPU when the processor could not run the probe at all', () => {
    expect(chooseDevice(Infinity, [{ index: 0, ms: 50 }])).toEqual({ kind: 'dml', index: 0 });
    expect(chooseDevice(0, [{ index: 0, ms: 50 }])).toEqual({ kind: 'dml', index: 0 });
  });

  it('reads SCF_MATTE_DEVICE', () => {
    expect(deviceOverride('cpu')).toEqual({ kind: 'cpu' });
    expect(deviceOverride('dml:1')).toEqual({ kind: 'dml', index: 1 });
    expect(deviceOverride('gpu')).toBeNull();
    expect(deviceOverride(undefined)).toBeNull();
  });

  it('builds a probe of the asked number of products', () => {
    const text = new TextDecoder().decode(matmulProbeModel(1024, 3));
    expect(text.match(/MatMul/g)).toHaveLength(3);
    // ir_version 8, field 1.
    expect([...matmulProbeModel(8).subarray(0, 2)]).toEqual([0x08, 0x08]);
  });
});

describe('frames to the model and back', () => {
  it('asks ffmpeg for raw RGB at the model size, at the file rate', () => {
    const args = matteFfmpegArgs('in.mp4', { width: 896, height: 512 }, 29.97002997, false);
    expect(args[args.indexOf('-vf') + 1]).toBe('fps=29.97003,scale=896:512:flags=bilinear,format=rgb24');
    expect(args.slice(-3)).toEqual(['-f', 'rawvideo', 'pipe:1']);
    expect(args).toContain('-an');
  });

  it('takes a still as its one picture, with no rate', () => {
    const args = matteFfmpegArgs('in.png', { width: 1024, height: 1024 }, 1, true);
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1024:1024:flags=bilinear,format=rgb24');
  });

  it('normalises RGB into planes', () => {
    const planar = rgbToPlanar(new Uint8Array([255, 0, 128, 0, 255, 255]), 2, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect([...planar].map((value) => Number(value.toFixed(3)))).toEqual([1, -1, -1, 1, 0.004, 1]);
  });

  it('turns logits into a 0-255 matte at the cache size', () => {
    // A 2x1 output: background on the left, subject on the right.
    const matte = outputToMatte(new Float32Array([-20, 20]), 2, 1, 'logit', 4, 2);
    expect([...matte]).toEqual([0, 64, 191, 255, 0, 64, 191, 255]);
    expect([...outputToMatte(new Float32Array([0.5, 2, -1]), 3, 1, 'alpha', 3, 1)]).toEqual([128, 255, 0]);
  });
});

describe('Remove background in a project', () => {
  it('starts off, on the precise model', () => {
    expect(createClip({ trackId: 't', name: 'c', sourceUri: 'u', startFrame: 0, durationFrames: 10 }).backgroundRemoval).toEqual({ enabled: false, model: 'precise', invert: false });
  });

  it('opens a project from before it existed with it off', () => {
    const project = createEmptyProject();
    const clip = createClip({ trackId: project.tracks[0].id, name: 'old', sourceUri: 'u', startFrame: 0, durationFrames: 10 });
    const { backgroundRemoval: _dropped, ...old } = clip;
    void _dropped;
    const opened = normalizeProject({ ...project, clips: { [clip.id]: old as typeof clip } });
    expect(opened.clips[clip.id].backgroundRemoval).toEqual({ enabled: false, model: 'precise', invert: false });
  });

  it('opens a project from before Invert existed keeping the subject', () => {
    const project = createEmptyProject();
    const clip = createClip({ trackId: project.tracks[0].id, name: 'v1.40', sourceUri: 'u', startFrame: 0, durationFrames: 10 });
    const saved = { ...clip, backgroundRemoval: { enabled: true, model: 'fast' } };
    const opened = normalizeProject({ ...project, clips: { [clip.id]: saved as unknown as typeof clip } });
    expect(opened.clips[clip.id].backgroundRemoval).toEqual({ enabled: true, model: 'fast', invert: false });
    const inverted = { ...clip, backgroundRemoval: { enabled: true, model: 'fast' as const, invert: true } };
    expect(normalizeProject({ ...project, clips: { [clip.id]: inverted } }).clips[clip.id].backgroundRemoval.invert).toBe(true);
  });

  it('keeps what it knows and mends what it does not', () => {
    expect(normalizeBackgroundRemoval({ enabled: true, model: 'fast' })).toEqual({ enabled: true, model: 'fast', invert: false });
    expect(normalizeBackgroundRemoval({ enabled: true, model: 'fast', invert: true })).toEqual({ enabled: true, model: 'fast', invert: true });
    expect(normalizeBackgroundRemoval({ enabled: true, model: 'rvm' })).toEqual({ enabled: true, model: 'precise', invert: false });
    expect(normalizeBackgroundRemoval({ enabled: 'yes', model: 7, invert: 'yes' })).toEqual({ enabled: false, model: 'precise', invert: false });
    expect(normalizeBackgroundRemoval(null)).toEqual({ enabled: false, model: 'precise', invert: false });
    expect(normalizeBackgroundRemoval('on')).toEqual({ enabled: false, model: 'precise', invert: false });
  });
});
