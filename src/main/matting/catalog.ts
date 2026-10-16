import type { MatteModelId } from '@shared/types';
import type { ModelFile } from '../subtitles/models';

/**
 * The background-removal models the app offers, and nothing else.
 *
 * Both are under permissive licences - code and weights - which is what lets
 * them be offered from an app that ships in an installer. Measured on the
 * target machine (RTX 4060 Laptop, Intel UHD, i9-13980HX; .bench-tmp spike,
 * 2026-10-15), per 1280x720 frame:
 *
 * - Preciso: BiRefNet-lite (Swin-T backbone, 44M parameters), MIT -
 *   github.com/ZhengPeng7/BiRefNet and huggingface.co/ZhengPeng7/BiRefNet_lite.
 *   Any subject, clean edges. The file is the half-precision ONNX that
 *   onnx-community converted from the official export (whose full-precision
 *   file is byte for byte the one in the official v1 release); full
 *   precision ran out of the 8 GB card's memory under DirectML. About 0.8 s
 *   a frame on the RTX 4060, 5.6 s on the processor: for shots, not for
 *   whole interviews.
 * - Rápido: MODNet, Apache-2.0 for code and models - github.com/ZHKKKe/MODNet.
 *   People only (it was trained for portraits), soft hair edges. The file is
 *   byte for byte the official ONNX the MODNet README links to; it is fetched
 *   from a Hugging Face mirror because the original lives on Google Drive,
 *   which is no place to download from inside an app. About 21 ms a frame on
 *   the RTX 4060, 0.22 s on the processor.
 *
 * Every download is pinned to one commit and checked against the SHA-256
 * fixed here before it is ever run (subtitles/models.ts).
 */

export interface MatteModel extends ModelFile {
  id: MatteModelId;
  /** What the model is shown: a square of `size`, or the frame's own shape with its short edge at `size`. */
  input: { kind: 'square'; size: number } | { kind: 'shortEdge'; size: number; multiple: number };
  /** Per-channel normalisation of 0..1 RGB: (value - mean) / std. */
  mean: [number, number, number];
  std: [number, number, number];
  /** What the model's output is: a logit, or already 0..1. */
  output: 'logit' | 'alpha';
  /**
   * onnxruntime's graph optimisation on DirectML. BiRefNet ran fastest with
   * none (0.75-0.8 s against 1.2-1.75 s with any), MODNet with all of it.
   */
  gpuOptimization: 'disabled' | 'all';
  /** Where it comes from and under what licence, as the permission prompt names it. */
  source: string;
  licence: string;
}

export const MATTE_MODELS: readonly MatteModel[] = [
  {
    id: 'precise',
    file: 'birefnet-lite-fp16.onnx',
    bytes: 114_538_221,
    sha256: 'd39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx',
    input: { kind: 'square', size: 1024 },
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    output: 'logit',
    gpuOptimization: 'disabled',
    source: 'huggingface.co/onnx-community/BiRefNet_lite-ONNX',
    licence: 'MIT',
  },
  {
    id: 'fast',
    file: 'modnet.onnx',
    bytes: 25_888_640,
    sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
    url: 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx',
    input: { kind: 'shortEdge', size: 512, multiple: 32 },
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    output: 'alpha',
    gpuOptimization: 'all',
    source: 'huggingface.co/Xenova/modnet',
    licence: 'Apache-2.0',
  },
];

export const matteModelById = (id: unknown): MatteModel | undefined => MATTE_MODELS.find((model) => model.id === id);

/**
 * The size a frame is scaled to before the model sees it. BiRefNet takes a
 * fixed square (its export has no other size), so a wide frame is squeezed
 * into it and the matte stretched back out; MODNet takes the frame's own
 * shape, short edge at 512, both sides a multiple of 32 as its network needs.
 */
export function modelInputSize(model: Pick<MatteModel, 'input'>, width: number, height: number): { width: number; height: number } {
  const { input } = model;
  if (input.kind === 'square') return { width: input.size, height: input.size };
  if (!(width > 0) || !(height > 0)) return { width: input.size, height: input.size };
  const scale = input.size / Math.min(width, height);
  const fit = (value: number): number => Math.max(input.multiple, Math.round((value * scale) / input.multiple) * input.multiple);
  return { width: fit(width), height: fit(height) };
}
