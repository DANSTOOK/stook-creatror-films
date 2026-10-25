import type { DragEvent } from 'react';
import type { MediaKind } from '@shared/types';

/**
 * What follows the pointer while a clip is dragged out of the media panel: a
 * small card with its picture, its length and its name, edged in the accent,
 * as CapCut's does - in place of the browser's see-through copy of the whole
 * tile, its buttons and all.
 *
 * Drawn on a canvas from the tile's own thumbnail, already decoded, so it is
 * ready the instant the drag starts: an image made then would still be
 * decoding, and come out blank. The browser only pictures what is in the
 * page, so the canvas goes in, off screen, for that instant.
 */

const WIDTH = 144;
const PICTURE = 81;
const STRIP = 22;
const HEIGHT = PICTURE + STRIP;
const RADIUS = 8;

/** `text`, cut short with an ellipsis to fit `width`. */
function fitted(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > width) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function setClipDragImage(event: DragEvent<HTMLElement>, kind: MediaKind, name: string, length: string): void {
  const tile = event.currentTarget;
  const page = tile.ownerDocument;
  const view = page.defaultView;
  if (!view) return;
  const ratio = view.devicePixelRatio || 1;
  const canvas = page.createElement('canvas');
  canvas.width = Math.round(WIDTH * ratio);
  canvas.height = Math.round(HEIGHT * ratio);
  canvas.style.cssText = `position:fixed;left:-1000px;top:-1000px;width:${WIDTH}px;height:${HEIGHT}px;pointer-events:none`;
  const context = canvas.getContext('2d');
  if (!context) return;
  const accent = view.getComputedStyle(page.documentElement).getPropertyValue('--accent').trim();
  const font = view.getComputedStyle(tile).fontFamily || 'sans-serif';
  context.scale(ratio, ratio);

  const card = (): void => {
    context.beginPath();
    context.roundRect(1, 1, WIDTH - 2, HEIGHT - 2, RADIUS);
  };
  context.save();
  card();
  context.clip();
  context.fillStyle = kind === 'audio' ? '#1f3d33' : '#0e0f11';
  context.fillRect(0, 0, WIDTH, HEIGHT);
  const picture = tile.querySelector('img');
  if (picture && picture.complete && picture.naturalWidth > 0) {
    // Cropped to fill, as the tile shows it.
    const scale = Math.max(WIDTH / picture.naturalWidth, PICTURE / picture.naturalHeight);
    const sourceWidth = WIDTH / scale;
    const sourceHeight = PICTURE / scale;
    context.drawImage(picture, (picture.naturalWidth - sourceWidth) / 2, (picture.naturalHeight - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, WIDTH, PICTURE);
  }
  context.textBaseline = 'middle';
  // Its length, on the picture's corner.
  if (length) {
    context.font = `500 10px ${font}`;
    const badge = context.measureText(length).width + 8;
    context.fillStyle = 'rgba(0, 0, 0, 0.75)';
    context.beginPath();
    context.roundRect(WIDTH - badge - 5, PICTURE - 19, badge, 15, 3);
    context.fill();
    context.fillStyle = '#f1f5f9';
    context.fillText(length, WIDTH - badge - 1, PICTURE - 11.5);
  }
  // The name, on a strip under the picture.
  context.fillStyle = 'rgba(14, 15, 17, 0.94)';
  context.fillRect(0, PICTURE, WIDTH, STRIP);
  context.font = `500 11px ${font}`;
  context.fillStyle = '#e2e8f0';
  context.fillText(fitted(context, name, WIDTH - 12), 6, PICTURE + STRIP / 2);
  context.restore();
  // The accent's edge.
  card();
  context.lineWidth = 2;
  context.strokeStyle = accent ? `rgb(${accent})` : '#06c4de';
  context.stroke();

  page.body.appendChild(canvas);
  event.dataTransfer.setDragImage(canvas, 16, 16);
  view.setTimeout(() => canvas.remove(), 0);
}
