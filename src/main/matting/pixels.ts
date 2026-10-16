/**
 * The arithmetic either side of the model: RGB bytes into the planar,
 * normalised floats it takes, and its output back into an 8-bit matte the
 * size of the cache. Pure, so it is unit tested (tests/MatteCache.test.ts).
 */

/** Interleaved RGB bytes to planar (R plane, G plane, B plane) of (value / 255 - mean) / std. */
export function rgbToPlanar(rgb: Uint8Array, pixels: number, mean: readonly number[], std: readonly number[], into = new Float32Array(pixels * 3)): Float32Array {
  const scale = [1 / (255 * std[0]), 1 / (255 * std[1]), 1 / (255 * std[2])];
  const shift = [mean[0] / std[0], mean[1] / std[1], mean[2] / std[2]];
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * 3;
    into[pixel] = rgb[at] * scale[0] - shift[0];
    into[pixels + pixel] = rgb[at + 1] * scale[1] - shift[1];
    into[2 * pixels + pixel] = rgb[at + 2] * scale[2] - shift[2];
  }
  return into;
}

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

/**
 * The model's output (`width` x `height` floats, a logit or already 0..1)
 * resampled bilinearly to `toWidth` x `toHeight` and written as 0..255. The
 * activation is applied before resampling, so an edge stays the soft edge the
 * model drew rather than a resampled logit.
 */
export function outputToMatte(
  output: ArrayLike<number>,
  width: number,
  height: number,
  kind: 'logit' | 'alpha',
  toWidth: number,
  toHeight: number,
): Uint8Array {
  const alpha = new Float32Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    const value = kind === 'logit' ? sigmoid(output[index]) : output[index];
    alpha[index] = value < 0 ? 0 : value > 1 ? 1 : value;
  }
  const matte = new Uint8Array(toWidth * toHeight);
  const xScale = width / toWidth;
  const yScale = height / toHeight;
  for (let y = 0; y < toHeight; y += 1) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < toWidth; x += 1) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      const top = alpha[y0 * width + x0] * (1 - wx) + alpha[y0 * width + x1] * wx;
      const bottom = alpha[y1 * width + x0] * (1 - wx) + alpha[y1 * width + x1] * wx;
      matte[y * toWidth + x] = Math.round((top * (1 - wy) + bottom * wy) * 255);
    }
  }
  return matte;
}
