import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAPTION_MODELS, type CaptionModel } from '@main/subtitles/catalog';
import { chooseVulkanDevice, engineIn, findEngine, parseVulkanDevices, threadsFor, whisperCommand } from '@main/subtitles/engine';
import { ChecksumError, deleteModel, downloadModel, importModel, isModelReady, modelPath } from '@main/subtitles/models';

/**
 * The speech engine's plumbing, without the engine: which GPU, which
 * command line, and the rule that a model is never used before its checksum
 * has matched. The engine itself runs in tests/ui/captions.mjs.
 */

/** What whisper.cpp's Vulkan backend prints as it loads, on a laptop with two GPUs. */
const TWO_GPUS = [
  'ggml_vulkan: Found 2 Vulkan devices:',
  'ggml_vulkan: 0 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none',
  'ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2',
  'load_backend: loaded Vulkan backend from C:\\app\\resources\\whisper\\ggml-vulkan.dll',
].join('\r\n');

describe('which GPU transcribes', () => {
  it('reads the GPUs the Vulkan backend lists, with their place in Vulkan\'s own order', () => {
    expect(parseVulkanDevices(TWO_GPUS)).toEqual([
      { index: 0, name: 'Intel(R) UHD Graphics', integrated: true },
      { index: 1, name: 'NVIDIA GeForce RTX 4060 Laptop GPU', integrated: false },
    ]);
    expect(parseVulkanDevices('load_backend: loaded CPU backend from x')).toEqual([]);
  });

  it('takes the NVIDIA GPU, never the Intel one, whichever comes first', () => {
    expect(chooseVulkanDevice(parseVulkanDevices(TWO_GPUS))?.name).toBe('NVIDIA GeForce RTX 4060 Laptop GPU');
    const swapped = parseVulkanDevices(TWO_GPUS.replace('0 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1', '0 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0').replace('1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0', '1 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1'));
    expect(chooseVulkanDevice(swapped)).toMatchObject({ index: 0, name: 'NVIDIA GeForce RTX 4060 Laptop GPU' });
  });

  it('uses the processor when the only GPU is integrated, or is not a GPU at all', () => {
    expect(chooseVulkanDevice(parseVulkanDevices('ggml_vulkan: 0 = Intel(R) Iris(R) Xe Graphics (Intel Corporation) | uma: 1 | fp16: 1'))).toBeNull();
    expect(chooseVulkanDevice(parseVulkanDevices('ggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1'))).toBeNull();
    expect(chooseVulkanDevice(parseVulkanDevices('ggml_vulkan: 0 = llvmpipe (LLVM 17.0.6, 256 bits) (llvmpipe) | uma: 0 | fp16: 1'))).toBeNull();
    expect(chooseVulkanDevice([])).toBeNull();
  });

  it('takes another dedicated GPU when there is no NVIDIA one', () => {
    const devices = parseVulkanDevices(['ggml_vulkan: 0 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1', 'ggml_vulkan: 1 = AMD Radeon RX 7600 (AMD proprietary driver) | uma: 0', 'ggml_vulkan: 2 = Intel(R) Arc(TM) A770 Graphics (Intel Corporation) | uma: 0'].join('\n'));
    expect(chooseVulkanDevice(devices)?.name).toBe('AMD Radeon RX 7600');
  });
});

describe('the command line', () => {
  const run = { model: 'C:\\m\\model.bin', dtw: 'large.v3.turbo', audio: 'C:\\t\\audio.wav', output: 'C:\\t\\out', language: 'es' as const, threads: 4, vadModel: null };

  it('on a chosen GPU: only that GPU is visible, and it is device 0', () => {
    const { args, env } = whisperCommand({ ...run, gpu: { index: 1, name: 'NVIDIA GeForce RTX 4060 Laptop GPU', integrated: false } });
    expect(env).toEqual({ GGML_VK_VISIBLE_DEVICES: '1' });
    expect(args).toEqual(['-m', run.model, '-f', run.audio, '-l', 'es', '-ojf', '-of', run.output, '-pp', '-t', '4', '-dtw', 'large.v3.turbo', '-nfa', '-dev', '0']);
  });

  it('on the processor: -ng, and no GPU named', () => {
    const { args, env } = whisperCommand({ ...run, gpu: null, language: 'en', dtw: 'small' });
    expect(env).toEqual({});
    expect(args.slice(-1)).toEqual(['-ng']);
    expect(args.join(' ')).toContain('-l en');
    expect(args.join(' ')).toContain('-dtw small -nfa');
  });

  it('left to the program when its GPUs could not be listed', () => {
    const { args, env } = whisperCommand({ ...run, gpu: 'auto' });
    expect(env).toEqual({});
    expect(args).not.toContain('-ng');
    expect(args).not.toContain('-dev');
  });

  it('uses the voice detector when it ships', () => {
    const { args } = whisperCommand({ ...run, gpu: null, vadModel: 'C:\\w\\ggml-silero-v6.2.0.bin' });
    expect(args.join(' ')).toContain('--vad -vm C:\\w\\ggml-silero-v6.2.0.bin');
  });

  it('leaves the processor room for the editor', () => {
    expect(threadsFor(24, false)).toBe(8);
    expect(threadsFor(8, false)).toBe(4);
    expect(threadsFor(2, false)).toBe(1);
    expect(threadsFor(24, true)).toBe(4);
  });
});

describe('finding the engine and checking models', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scf-captions-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cli = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

  it('finds the program, and whether the Vulkan backend and the voice detector came with it', async () => {
    expect(engineIn(dir)).toBeNull();
    await writeFile(join(dir, cli), '');
    expect(engineIn(dir)).toMatchObject({ vulkan: false, vadModel: null });
    await writeFile(join(dir, 'ggml-vulkan.dll'), '');
    await writeFile(join(dir, 'ggml-silero-v6.2.0.bin'), '');
    expect(engineIn(dir)).toMatchObject({ dir, cli: join(dir, cli), vulkan: true, vadModel: join(dir, 'ggml-silero-v6.2.0.bin') });
  });

  it('looks where a test points first, then inside the installed app, then in the checkout', async () => {
    const resources = join(dir, 'resources');
    const checkout = join(dir, 'checkout');
    for (const place of [join(dir, 'pointed'), join(resources, 'whisper'), join(checkout, 'build', 'whisper')]) {
      await (await import('node:fs/promises')).mkdir(place, { recursive: true });
      await writeFile(join(place, cli), '');
    }
    expect(findEngine({ resourcesPath: resources, appPath: checkout, env: { SCF_WHISPER_DIR: join(dir, 'pointed') } })?.dir).toBe(join(dir, 'pointed'));
    expect(findEngine({ resourcesPath: resources, appPath: checkout, env: {} })?.dir).toBe(join(resources, 'whisper'));
    expect(findEngine({ appPath: checkout, env: {} })?.dir).toBe(join(checkout, 'build', 'whisper'));
    expect(findEngine({ appPath: join(dir, 'nowhere'), env: {} })).toBeNull();
  });

  /** A small stand-in for a model: the rules are the same at any size. */
  const contents = Buffer.from('not really a model, but hashed like one '.repeat(2000));
  const model: CaptionModel = {
    id: 'fast',
    file: 'ggml-test.bin',
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
    url: 'https://example.invalid/ggml-test.bin',
    dtw: 'small',
  };
  /** A fetch that serves `body` in pieces, and counts what it was asked. */
  const serving = (body: Buffer, calls: string[] = [], onChunk?: () => void) => async (url: string, init: { signal: AbortSignal }): Promise<Response> => {
    calls.push(url);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let at = 0; at < body.length; at += 16_384) {
          if (init.signal.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          controller.enqueue(body.subarray(at, at + 16_384));
          onChunk?.();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
  };

  it('a download is kept only when its SHA-256 matches, and is then ready', async () => {
    const calls: string[] = [];
    const progress: number[] = [];
    await downloadModel(dir, model, { fetch: serving(contents, calls), signal: new AbortController().signal, onProgress: (received) => progress.push(received) });
    expect(calls).toEqual([model.url]);
    expect(progress[progress.length - 1]).toBe(contents.length);
    expect((await readdir(dir)).sort()).toEqual(['ggml-test.bin', 'ggml-test.bin.verified']);
    expect(await isModelReady(dir, model)).toBe(true);
  });

  it('a download with the wrong contents is thrown away', async () => {
    const tampered = Buffer.from(contents);
    tampered[1234] ^= 0xff;
    await expect(downloadModel(dir, model, { fetch: serving(tampered), signal: new AbortController().signal })).rejects.toBeInstanceOf(ChecksumError);
    expect(await readdir(dir)).toEqual([]);
    expect(await isModelReady(dir, model)).toBe(false);
    // Cut short, the same.
    await expect(downloadModel(dir, model, { fetch: serving(contents.subarray(0, 5000)), signal: new AbortController().signal })).rejects.toBeInstanceOf(ChecksumError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a cancelled download leaves no half file', async () => {
    const controller = new AbortController();
    let chunks = 0;
    const download = downloadModel(dir, model, { fetch: serving(contents, [], () => { chunks += 1; if (chunks === 2) controller.abort(); }), signal: controller.signal });
    await expect(download).rejects.toBeDefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it('a failed request leaves nothing either', async () => {
    const failing = async (): Promise<Response> => new Response('nope', { status: 503 });
    await expect(downloadModel(dir, model, { fetch: failing, signal: new AbortController().signal })).rejects.toThrow('HTTP 503');
    expect(await readdir(dir)).toEqual([]);
  });

  it('a model changed on disk is not ready any more, whatever its marker says', async () => {
    await downloadModel(dir, model, { fetch: serving(contents), signal: new AbortController().signal });
    const tampered = Buffer.from(contents);
    tampered[0] ^= 0xff;
    await writeFile(modelPath(dir, model), tampered);
    // Even with the old modified time put back, the size and time are not the proof: the hash is.
    await utimes(modelPath(dir, model), new Date(), new Date(Date.now() + 5000));
    expect(await isModelReady(dir, model)).toBe(false);
    await writeFile(modelPath(dir, model), contents);
    expect(await isModelReady(dir, model)).toBe(true);
    // A file of the wrong size is not even hashed.
    await writeFile(modelPath(dir, model), contents.subarray(0, 100));
    expect(await isModelReady(dir, model)).toBe(false);
    await deleteModel(dir, model);
    expect(await readdir(dir)).toEqual([]);
  });

  it('importing refuses a file that is not one of the two models', async () => {
    const stranger = join(dir, 'ggml-large-v3-turbo-q5_0.bin');
    await writeFile(stranger, contents);
    const models = join(dir, 'models');
    await expect(importModel(models, stranger)).rejects.toBeInstanceOf(ChecksumError);
    expect(existsSync(models) ? await readdir(models) : []).toEqual([]);
  });

  it('the catalogue is the two official files, with full SHA-256s', () => {
    expect(CAPTION_MODELS.map((entry) => entry.id)).toEqual(['precise', 'fast']);
    for (const entry of CAPTION_MODELS) {
      expect(entry.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${entry.file}`);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(100_000_000);
    }
    expect(CAPTION_MODELS[0]).toMatchObject({ file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574_041_195, dtw: 'large.v3.turbo' });
    expect(CAPTION_MODELS[1]).toMatchObject({ file: 'ggml-small-q5_1.bin', bytes: 190_085_487, dtw: 'small' });
  });
});
