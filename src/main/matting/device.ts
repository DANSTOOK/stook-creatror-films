/**
 * Which processor runs the matting model.
 *
 * DirectML numbers the GPUs in the order Windows lists them, and that order
 * says nothing about which is which: on the target laptop device 0 happened
 * to be the RTX 4060 and device 1 the Intel UHD, and it can be the other way
 * round on the next machine. Nor does onnxruntime say which device it opened.
 * So each one is asked to do the same small sum - one 1024 x 1024 matrix
 * product, built here as an ONNX model of a single MatMul - and timed against
 * the processor doing it.
 *
 * The GPU is used only when it is clearly faster: twice the processor's speed
 * at least. An integrated GPU is not, and measured on the real models it is
 * slower than the processor (MODNet 322 ms against 224; BiRefNet 12.8 s
 * against 5.6 s), so that margin keeps it out, as captions keep it out
 * (subtitles/engine.ts chooseVulkanDevice).
 *
 * Nothing here needs Electron or onnxruntime: the worker runs the probe and
 * hands the timings to `chooseDevice`.
 */

export type MatteDevice = { kind: 'cpu' } | { kind: 'dml'; index: number };

export interface DeviceTiming {
  index: number;
  ms: number;
}

/** How many DirectML devices are tried; no computer this runs on has more GPUs. */
export const MAX_DML_DEVICES = 4;

/** A GPU must be at least this much faster than the processor to be worth it. */
export const GPU_ADVANTAGE = 2;

export function chooseDevice(cpuMs: number, gpus: readonly DeviceTiming[]): MatteDevice {
  const fastest = [...gpus].filter((gpu) => Number.isFinite(gpu.ms) && gpu.ms > 0).sort((a, b) => a.ms - b.ms)[0];
  if (!fastest) return { kind: 'cpu' };
  if (!(cpuMs > 0) || fastest.ms * GPU_ADVANTAGE <= cpuMs) return { kind: 'dml', index: fastest.index };
  return { kind: 'cpu' };
}

/**
 * SCF_MATTE_DEVICE picks the device by hand, for measuring one against the
 * other and for the tests: `cpu`, or `dml:<n>`. Anything else is ignored.
 */
export function deviceOverride(value: string | undefined): MatteDevice | null {
  if (!value) return null;
  if (value === 'cpu') return { kind: 'cpu' };
  const match = /^dml:(\d)$/.exec(value);
  return match ? { kind: 'dml', index: Number(match[1]) } : null;
}

export const describeDevice = (device: MatteDevice): string => (device.kind === 'cpu' ? 'cpu' : `dml:${device.index}`);

/* The probe model ------------------------------------------------------------ */

/*
  An ONNX file is a protocol buffer. The model needed is tiny - two float
  inputs of a fixed size, one MatMul, one output - so it is written out
  field by field here rather than shipping a file or a protobuf library for
  it. Field numbers are those of onnx.proto (ModelProto, GraphProto,
  NodeProto, ValueInfoProto, TypeProto, TensorShapeProto).
*/

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

const tag = (field: number, wireType: 0 | 2): number[] => varint((field << 3) | wireType);
const intField = (field: number, value: number): number[] => [...tag(field, 0), ...varint(value)];
const bytesField = (field: number, payload: readonly number[]): number[] => [...tag(field, 2), ...varint(payload.length), ...payload];
const stringField = (field: number, text: string): number[] => bytesField(field, [...new TextEncoder().encode(text)]);

const FLOAT = 1;

function floatTensorInfo(name: string, dims: readonly number[]): number[] {
  const shape = dims.flatMap((dim) => bytesField(1, intField(1, dim)));
  const tensorType = [...intField(1, FLOAT), ...bytesField(2, shape)];
  return [...stringField(1, name), ...bytesField(2, bytesField(1, tensorType))];
}

/**
 * A model multiplying `A` by `B` `steps` times over (A x B x B x ...), for
 * two `size` x `size` float matrices, its result `C`. A chain rather than one
 * product, so the timing is the device's arithmetic and not the copy of the
 * matrices to it and back - one 1024 product measured 4.3 ms on the RTX 4060,
 * 7.7 on the Intel UHD and 6.1 on the processor, which is mostly copying.
 */
export function matmulProbeModel(size: number, steps = 1): Uint8Array {
  const nodes: number[] = [];
  for (let step = 0; step < steps; step += 1) {
    const input = step === 0 ? 'A' : `T${step}`;
    const output = step === steps - 1 ? 'C' : `T${step + 1}`;
    const node = [...stringField(1, input), ...stringField(1, 'B'), ...stringField(2, output), ...stringField(3, `probe${step}`), ...stringField(4, 'MatMul')];
    nodes.push(...bytesField(1, node));
  }
  const graph = [
    ...nodes,
    ...stringField(2, 'scf-matte-probe'),
    ...bytesField(11, floatTensorInfo('A', [size, size])),
    ...bytesField(11, floatTensorInfo('B', [size, size])),
    ...bytesField(12, floatTensorInfo('C', [size, size])),
  ];
  const opset = [...stringField(1, ''), ...intField(2, 13)];
  return new Uint8Array([...intField(1, 8), ...bytesField(7, graph), ...bytesField(8, opset)]);
}
