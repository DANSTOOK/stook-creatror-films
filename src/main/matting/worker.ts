import { spawn, type ChildProcess } from 'node:child_process';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { MATTE_HEADER_BYTES, encodeMatteFrame, writeMatteHeader, writeMatteIndex } from '@shared/matte/format';
import { MatteSmoother } from '@shared/matte/smoothing';
import { modelInputSize } from './catalog';
import { MAX_DML_DEVICES, chooseDevice, describeDevice, matmulProbeModel, type DeviceTiming, type MatteDevice } from './device';
import { matteFfmpegArgs, type FromWorker, type MatteJob, type ToWorker } from './job';
import { outputToMatte, rgbToPlanar } from './pixels';

/**
 * The matting worker: an Electron utility process that turns one file into
 * its matte cache (shared/matte/format.ts) and exits.
 *
 * ffmpeg decodes the file and scales each frame to the model's size; the
 * model runs on the device chosen by measuring (device.ts) - DirectML on a
 * GPU worth using, the processor otherwise - and every matte is smoothed
 * against its neighbours (shared/matte/smoothing.ts), run-length coded and
 * appended to a temporary file. Only a complete file is renamed to its real
 * name, so a cancel, a crash or a power cut never leaves half a cache to be
 * trusted later.
 *
 * A GPU that fails mid-way - out of memory, a driver reset - does not end
 * the job: the model is loaded again on the processor and the frame retried.
 */

const port = process.parentPort;
const send = (message: FromWorker): void => port.postMessage(message);

let cancelled = false;
let ffmpeg: ChildProcess | null = null;

port.on('message', (event: { data: ToWorker }) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled = true;
    ffmpeg?.kill();
  } else if (message.type === 'start') {
    void run(message.job).then(
      () => process.exit(0),
      (error: unknown) => {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      },
    );
  }
});

/* The device --------------------------------------------------------------- */

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Time the probe (device.ts) on one execution provider; Infinity where it cannot run. */
async function timeProbe(providers: ort.InferenceSession.SessionOptions['executionProviders']): Promise<number> {
  const size = 1024;
  try {
    const session = await ort.InferenceSession.create(matmulProbeModel(size, 16), { executionProviders: providers });
    const a = new ort.Tensor('float32', new Float32Array(size * size).fill(0.5), [size, size]);
    const b = new ort.Tensor('float32', new Float32Array(size * size).fill(1 / size), [size, size]);
    const runs: number[] = [];
    // The first runs compile and upload; the median of the rest is the device.
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      await session.run({ A: a, B: b });
      if (run >= 2) runs.push(performance.now() - started);
    }
    await session.release();
    return median(runs);
  } catch {
    return Infinity;
  }
}

async function measureDevice(): Promise<{ device: MatteDevice; cpuMs: number; gpus: DeviceTiming[] }> {
  const cpuMs = await timeProbe(['cpu']);
  const gpus: DeviceTiming[] = [];
  if (process.platform === 'win32') {
    for (let index = 0; index < MAX_DML_DEVICES; index += 1) {
      const ms = await timeProbe([{ name: 'dml', deviceId: index }]);
      // DirectML refuses a number past its last adapter: there are no more.
      if (!Number.isFinite(ms)) break;
      gpus.push({ index, ms });
    }
  }
  return { device: chooseDevice(cpuMs, gpus), cpuMs, gpus };
}

async function loadModel(job: MatteJob, device: MatteDevice): Promise<ort.InferenceSession> {
  const options: ort.InferenceSession.SessionOptions =
    device.kind === 'dml'
      ? {
          executionProviders: [{ name: 'dml', deviceId: device.index }],
          graphOptimizationLevel: job.model.gpuOptimization,
          // DirectML wants no memory pattern; onnxruntime warns and turns it off otherwise.
          enableMemPattern: false,
          executionMode: 'sequential',
        }
      : { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: job.threads };
  const session = await ort.InferenceSession.create(job.modelPath, options);
  const input = session.inputMetadata[0];
  if (input && input.isTensor && input.type !== 'float32') throw new Error(`The model takes ${input.type}, not float32`);
  return session;
}

/* Frames from ffmpeg --------------------------------------------------------- */

/** Raw frames of exactly `frameBytes`, one at a time, with ffmpeg paused while the model works. */
function frameReader(child: ChildProcess, frameBytes: number): { next(): Promise<Uint8Array | null>; failure(): string } {
  const stdout = child.stdout;
  if (!stdout) throw new Error('ffmpeg has no output');
  const chunks: Buffer[] = [];
  let buffered = 0;
  let ended = false;
  let complaint = '';
  let wake: (() => void) | null = null;
  child.stderr?.on('data', (chunk: Buffer) => {
    complaint = `${complaint}${chunk.toString('utf8')}`.slice(-2000);
  });
  stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    buffered += chunk.length;
    // A few frames ahead is enough; more is only memory.
    if (buffered > frameBytes * 3) stdout.pause();
    wake?.();
  });
  const finish = (): void => {
    ended = true;
    wake?.();
  };
  stdout.on('end', finish);
  child.on('error', (error) => {
    complaint = error.message;
    finish();
  });

  return {
    async next() {
      while (buffered < frameBytes && !ended) {
        stdout.resume();
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      if (buffered < frameBytes) return null;
      const frame = new Uint8Array(frameBytes);
      let filled = 0;
      while (filled < frameBytes) {
        const head = chunks[0];
        const take = Math.min(head.length, frameBytes - filled);
        frame.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) chunks.shift();
        else chunks[0] = head.subarray(take);
      }
      buffered -= frameBytes;
      if (buffered <= frameBytes * 3) stdout.resume();
      return frame;
    },
    failure: () => complaint.trim(),
  };
}

/* The job -------------------------------------------------------------------- */

async function run(job: MatteJob): Promise<void> {
  const jobStarted = performance.now();
  let device = job.device;
  if (!device) {
    const measured = await measureDevice();
    device = measured.device;
    send({ type: 'device', device, probe: { cpuMs: measured.cpuMs, gpus: measured.gpus } });
  } else {
    send({ type: 'device', device });
  }

  const probed = performance.now();
  let session = await loadModel(job, device);
  const loaded = performance.now();
  const inputSize = modelInputSize(job.model, job.sourceWidth, job.sourceHeight);
  const pixels = inputSize.width * inputSize.height;
  const planar = new Float32Array(pixels * 3);

  ffmpeg = spawn(job.ffmpeg, matteFfmpegArgs(job.source, inputSize, job.fps, job.still), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => ffmpeg?.on('close', (code) => resolve(code)));
  const frames = frameReader(ffmpeg, pixels * 3);

  let file: FileHandle | null = await open(job.part, 'w');
  const offsets: number[] = [];
  let position = MATTE_HEADER_BYTES;
  await file.write(new Uint8Array(MATTE_HEADER_BYTES), 0, MATTE_HEADER_BYTES, 0);

  const smoother = job.smoothing ? new MatteSmoother() : null;
  const write = async (matte: Uint8Array): Promise<void> => {
    const coded = encodeMatteFrame(matte);
    offsets.push(position);
    await file?.write(coded, 0, coded.length, position);
    position += coded.length;
  };

  let decoded = 0;
  let inferenceMs = 0;
  const total = Math.max(1, job.expectedFrames);
  try {
    for (;;) {
      if (cancelled) break;
      const rgb = await frames.next();
      if (!rgb) break;
      rgbToPlanar(rgb, pixels, job.model.mean, job.model.std, planar);
      const input = new ort.Tensor('float32', planar, [1, 3, inputSize.height, inputSize.width]);
      const started = performance.now();
      let result: ort.InferenceSession.OnnxValueMapType;
      try {
        result = await session.run({ [session.inputNames[0]]: input });
      } catch (error) {
        if (device.kind === 'cpu') throw error;
        // The GPU gave up (out of memory, a lost device): carry on on the processor.
        console.warn(`[matte] ${describeDevice(device)} failed, continuing on the CPU: ${String(error)}`);
        await session.release().catch(() => undefined);
        device = { kind: 'cpu' };
        send({ type: 'device', device });
        session = await loadModel(job, device);
        result = await session.run({ [session.inputNames[0]]: input });
      }
      inferenceMs += performance.now() - started;
      const output = result[session.outputNames[session.outputNames.length - 1]] as ort.Tensor;
      const [outHeight, outWidth] = output.dims.slice(-2);
      const matte = outputToMatte(output.data as Float32Array, outWidth, outHeight, job.model.output, job.matteWidth, job.matteHeight);
      decoded += 1;
      const smoothed = smoother ? smoother.push(matte) : matte;
      if (smoothed) await write(smoothed);
      send({ type: 'progress', done: decoded, total: Math.max(total, decoded), msPerFrame: inferenceMs / decoded });
    }

    if (cancelled) {
      await file.close();
      file = null;
      await rm(job.part, { force: true });
      send({ type: 'cancelled' });
      return;
    }

    const last = smoother?.finish();
    if (last) await write(last);
    const code = await exited;
    if (code !== 0 || offsets.length === 0) {
      throw new Error(frames.failure() || `ffmpeg stopped (${String(code)}) after ${decoded} frames`);
    }

    offsets.push(position);
    const index = writeMatteIndex(offsets);
    await file.write(index, 0, index.length, position);
    const header = writeMatteHeader({ width: job.matteWidth, height: job.matteHeight, frames: offsets.length - 1, fps: job.fps, indexOffset: position });
    await file.write(header, 0, header.length, 0);
    await file.close();
    file = null;
    await rename(job.part, job.target);
    send({
      type: 'done',
      frames: offsets.length - 1,
      bytes: position + index.length,
      msPerFrame: inferenceMs / Math.max(1, decoded),
      timings: { probeMs: probed - jobStarted, loadMs: loaded - probed, framesMs: performance.now() - loaded },
    });
  } catch (error) {
    ffmpeg?.kill();
    await file?.close().catch(() => undefined);
    await rm(job.part, { force: true });
    throw error;
  } finally {
    await session.release().catch(() => undefined);
  }
}
