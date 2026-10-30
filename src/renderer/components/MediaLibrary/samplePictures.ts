/**
 * The two pictures the library's previews are made of: a lake at sunset
 * (warm, bright, with a figure on the shore) and a city at night (cool,
 * dark, lit windows and neon). A transition goes from the first to the
 * second; an effect is shown on the first. Two real-looking places read at
 * a glance as two shots - the "A" and "B" tiles they replace did not - and
 * they differ in lightness as well as hue, so they stay apart for someone
 * who does not see the colours.
 *
 * Each is a photograph that ships with the app (assets/sample-*.jpg, 640x360,
 * about 30 kB each): a tile of a real shot reads at a glance as footage, which
 * is what the tiles are standing in for, and an effect's colour and blur show
 * on skin, sky and water as they will on the user's own clip. The drawn scenes
 * below are the fallback - they are what is shown until the files decode, and
 * all that is shown if they ever fail - so the panel never waits and never
 * shows a hole. Each picture is made at twice the size asked and scaled down,
 * then kept.
 *
 * A photograph arrives after the first tiles are drawn, so `onSamplesReady`
 * tells the panels to draw again (LibraryBrowsers, effectThumbs).
 */

export type SampleScene = 'sunset' | 'city';

/** Mulberry32: the same stars and windows every time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A ridge of peaks along `base` (fraction of the height), `height` tall at most. */
function ridge(context: CanvasRenderingContext2D, w: number, h: number, base: number, height: number, peaks: number, seed: number, fill: string | CanvasGradient): void {
  const random = seeded(seed);
  context.fillStyle = fill;
  context.beginPath();
  context.moveTo(0, h);
  context.lineTo(0, h * base);
  const step = w / peaks;
  for (let i = 0; i <= peaks; i += 1) {
    const x = i * step;
    const top = h * (base - height * (0.45 + 0.55 * random()));
    context.lineTo(x - step * 0.5, top);
    context.lineTo(x, h * (base - height * 0.25 * random()));
  }
  context.lineTo(w, h);
  context.closePath();
  context.fill();
}

function pine(context: CanvasRenderingContext2D, x: number, ground: number, height: number): void {
  context.beginPath();
  for (let tier = 0; tier < 4; tier += 1) {
    const top = ground - height * (0.35 + tier * 0.22);
    const half = height * (0.22 - tier * 0.04);
    context.moveTo(x, top - height * 0.12);
    context.lineTo(x - half, top + height * 0.18);
    context.lineTo(x + half, top + height * 0.18);
    context.closePath();
  }
  context.rect(x - height * 0.02, ground - height * 0.35, height * 0.04, height * 0.35);
  context.fill();
}

function drawSunset(context: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = h * 0.6;
  const sky = context.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1b2a5e');
  sky.addColorStop(0.45, '#6d3fa3');
  sky.addColorStop(0.78, '#f0855a');
  sky.addColorStop(1, '#ffd27a');
  context.fillStyle = sky;
  context.fillRect(0, 0, w, horizon + 2);
  // The sun and its glow.
  const sunX = w * 0.66;
  // Low in the sky, above the peaks.
  const sunY = h * 0.3;
  const glow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.42);
  glow.addColorStop(0, 'rgba(255, 244, 200, 0.95)');
  glow.addColorStop(0.18, 'rgba(255, 210, 120, 0.55)');
  glow.addColorStop(1, 'rgba(255, 160, 90, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, w, horizon);
  context.fillStyle = '#fff4cf';
  context.beginPath();
  context.arc(sunX, sunY, h * 0.075, 0, Math.PI * 2);
  context.fill();
  // Soft clouds lit from below.
  const random = seeded(7);
  for (let i = 0; i < 7; i += 1) {
    const cx = w * (0.08 + random() * 0.84);
    const cy = h * (0.12 + random() * 0.25);
    const cloud = context.createRadialGradient(cx, cy, 0, cx, cy, w * 0.12);
    cloud.addColorStop(0, `rgba(255, ${170 + Math.round(random() * 40)}, ${150 + Math.round(random() * 40)}, 0.38)`);
    cloud.addColorStop(1, 'rgba(255, 180, 160, 0)');
    context.fillStyle = cloud;
    context.save();
    context.translate(cx, cy);
    context.scale(1, 0.28);
    context.translate(-cx, -cy);
    context.fillRect(cx - w * 0.12, cy - w * 0.12, w * 0.24, w * 0.24);
    context.restore();
  }
  // Mountains, paler with distance.
  ridge(context, w, h, 0.6, 0.2, 5, 3, '#8a5a94');
  ridge(context, w, h, 0.6, 0.13, 7, 11, '#4e3474');
  ridge(context, w, h, 0.61, 0.07, 9, 17, '#2a2050');
  // The lake: the sky again, darker, with the sun's path on it.
  const lake = context.createLinearGradient(0, horizon, 0, h);
  lake.addColorStop(0, '#d0805f');
  lake.addColorStop(0.35, '#5a3a7a');
  lake.addColorStop(1, '#1a1838');
  context.fillStyle = lake;
  context.fillRect(0, horizon, w, h - horizon);
  for (let y = horizon + h * 0.01; y < h; y += h * 0.018) {
    const depth = (y - horizon) / (h - horizon);
    const width = w * (0.04 + depth * 0.16) * (0.6 + random() * 0.6);
    context.fillStyle = `rgba(255, 226, 160, ${0.75 - depth * 0.6})`;
    context.fillRect(sunX - width / 2 + (random() - 0.5) * w * 0.02, y, width, Math.max(1, h * 0.006));
  }
  // The near shore with pines, and a figure looking out.
  context.fillStyle = '#120f22';
  context.beginPath();
  context.moveTo(0, h);
  context.lineTo(0, h * 0.74);
  context.quadraticCurveTo(w * 0.22, h * 0.7, w * 0.42, h * 0.86);
  context.quadraticCurveTo(w * 0.5, h * 0.94, w * 0.56, h);
  context.closePath();
  context.fill();
  pine(context, w * 0.05, h * 0.78, h * 0.34);
  pine(context, w * 0.11, h * 0.76, h * 0.26);
  pine(context, w * 0.36, h * 0.84, h * 0.2);
  // The figure: warm skin, a red jacket - something for colour and edges.
  const fx = w * 0.23;
  const ground = h * 0.735;
  context.fillStyle = '#1e293b';
  context.fillRect(fx - h * 0.018, ground - h * 0.1, h * 0.014, h * 0.1);
  context.fillRect(fx + h * 0.004, ground - h * 0.1, h * 0.014, h * 0.1);
  context.fillStyle = '#d9473b';
  context.beginPath();
  context.roundRect(fx - h * 0.03, ground - h * 0.21, h * 0.06, h * 0.12, h * 0.015);
  context.fill();
  context.fillStyle = '#f0b48a';
  context.beginPath();
  context.arc(fx, ground - h * 0.245, h * 0.028, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#3b2416';
  context.beginPath();
  context.arc(fx, ground - h * 0.255, h * 0.028, Math.PI, Math.PI * 2);
  context.fill();
}

function drawCity(context: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = h * 0.64;
  const sky = context.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#050816');
  sky.addColorStop(0.6, '#141a45');
  sky.addColorStop(1, '#3a2a6e');
  context.fillStyle = sky;
  context.fillRect(0, 0, w, horizon + 2);
  const random = seeded(23);
  // Stars.
  for (let i = 0; i < 90; i += 1) {
    context.fillStyle = `rgba(255, 255, 255, ${0.25 + random() * 0.7})`;
    const size = random() < 0.1 ? h * 0.006 : h * 0.003;
    context.fillRect(random() * w, random() * horizon * 0.7, size, size);
  }
  // The moon.
  const moonX = w * 0.18;
  const moonY = h * 0.2;
  const halo = context.createRadialGradient(moonX, moonY, 0, moonX, moonY, h * 0.22);
  halo.addColorStop(0, 'rgba(220, 230, 255, 0.45)');
  halo.addColorStop(1, 'rgba(200, 210, 255, 0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, w * 0.5, h * 0.5);
  context.fillStyle = '#f2f0e1';
  context.beginPath();
  context.arc(moonX, moonY, h * 0.055, 0, Math.PI * 2);
  context.fill();
  // The skyline: back row darker and shorter, front row taller, windows lit.
  const rows: Array<{ shade: string; min: number; max: number; lit: number }> = [
    { shade: '#1b1f45', min: 0.12, max: 0.3, lit: 0.18 },
    { shade: '#0c0f27', min: 0.18, max: 0.5, lit: 0.42 },
  ];
  for (const row of rows) {
    let x = -w * 0.02;
    while (x < w) {
      const width = w * (0.05 + random() * 0.07);
      const top = horizon - h * (row.min + random() * (row.max - row.min));
      context.fillStyle = row.shade;
      context.fillRect(x, top, width - w * 0.004, horizon - top);
      const cell = h * 0.026;
      for (let wy = top + cell; wy < horizon - cell; wy += cell) {
        for (let wx = x + cell * 0.5; wx < x + width - cell; wx += cell * 0.9) {
          if (random() > row.lit) continue;
          context.fillStyle = random() < 0.7 ? 'rgba(255, 206, 120, 0.9)' : 'rgba(125, 211, 252, 0.85)';
          context.fillRect(wx, wy, cell * 0.45, cell * 0.5);
        }
      }
      x += width;
    }
  }
  // A neon sign: a pink frame and a cyan bar, glowing.
  const signX = w * 0.62;
  const signY = horizon - h * 0.36;
  context.save();
  context.shadowColor = '#ff3fa4';
  context.shadowBlur = h * 0.04;
  context.strokeStyle = '#ff5fb4';
  context.lineWidth = h * 0.012;
  context.beginPath();
  context.roundRect(signX, signY, w * 0.14, h * 0.08, h * 0.02);
  context.stroke();
  context.shadowColor = '#22d3ee';
  context.fillStyle = '#67e8f9';
  context.fillRect(signX + w * 0.025, signY + h * 0.032, w * 0.09, h * 0.016);
  context.restore();
  // The river: dark water holding the lights as streaks.
  const water = context.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, '#1a1840');
  water.addColorStop(1, '#04050f');
  context.fillStyle = water;
  context.fillRect(0, horizon, w, h - horizon);
  for (let i = 0; i < 70; i += 1) {
    const x = random() * w;
    const y = horizon + random() * (h - horizon) * 0.8;
    const warm = random() < 0.65;
    context.fillStyle = warm ? `rgba(255, 200, 110, ${0.15 + random() * 0.35})` : `rgba(120, 210, 255, ${0.15 + random() * 0.35})`;
    context.fillRect(x, y, w * (0.004 + random() * 0.012), h * (0.004 + random() * 0.01));
  }
  context.fillStyle = 'rgba(255, 95, 180, 0.35)';
  context.fillRect(signX + w * 0.01, horizon + h * 0.03, w * 0.12, h * 0.012);
}

const kept = new Map<string, HTMLCanvasElement>();

/** Scene `scene` at `width` x `height`, made once and kept: the photograph when it is in, else the drawn scene. */
export function samplePicture(scene: SampleScene, width: number, height: number): HTMLCanvasElement {
  const key = `${scene}:${width}x${height}`;
  const known = kept.get(key);
  if (known) return known;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(scene, canvas);
  kept.set(key, canvas);
  return canvas;
}

/* The photographs ---------------------------------------------------------- */

const PHOTOS: Record<SampleScene, string> = {
  sunset: new URL('../../assets/sample-sunset.jpg', import.meta.url).href,
  city: new URL('../../assets/sample-city.jpg', import.meta.url).href,
};

const photos = new Map<SampleScene, HTMLImageElement>();
const listeners = new Set<() => void>();

/** Called when a photograph has arrived and the kept pictures have been redrawn with it. */
export function onSamplesReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `photo` over the whole of `width` x `height`, cropped from the middle rather than squashed. */
function drawCover(context: CanvasRenderingContext2D, photo: HTMLImageElement, width: number, height: number): void {
  const scale = Math.max(width / photo.naturalWidth, height / photo.naturalHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  context.drawImage(
    photo,
    (photo.naturalWidth - cropWidth) / 2,
    (photo.naturalHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    0,
    0,
    width,
    height,
  );
}

function paint(scene: SampleScene, canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const photo = photos.get(scene);
  if (photo) {
    drawCover(context, photo, canvas.width, canvas.height);
    return;
  }
  const large = document.createElement('canvas');
  large.width = canvas.width * 2;
  large.height = canvas.height * 2;
  const big = large.getContext('2d');
  if (big) (scene === 'sunset' ? drawSunset : drawCity)(big, large.width, large.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(large, 0, 0, canvas.width, canvas.height);
}

if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
  for (const scene of ['sunset', 'city'] as SampleScene[]) {
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener(
      'load',
      () => {
        if (!(image.naturalWidth > 0)) return;
        photos.set(scene, image);
        // Whatever was drawn with the fallback is drawn again, in place: the
        // panels hold these very canvases.
        for (const [key, canvas] of kept) if (key.startsWith(`${scene}:`)) paint(scene, canvas);
        for (const listener of [...listeners]) listener();
      },
      { once: true },
    );
    image.src = PHOTOS[scene];
  }
}
