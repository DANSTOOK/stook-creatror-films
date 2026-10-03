import type { Clip, TitleContent } from '@shared/types';
import { loadTitleFonts, titleFontsReady } from '@renderer/text/fonts';
import { rasterizeTitle } from '@renderer/text/render';
import type { Rect } from '@renderer/text/layout';
import { geometryFromLayout, titleGeometry, type TitleGeometry } from '@renderer/text/geometry';
import { wordAnimationOf, wordFrameAt, type WordAnimation } from '@renderer/text/wordAnimation';
import { rasterizeWords } from '@renderer/text/words';
import { speedOf } from '@renderer/timing/clipSpeed';
import type { ClipSource } from './Compositor';
import type { TextureManager } from './TextureManager';

/**
 * Title clips as textures.
 *
 * A title is drawn once per change - of its text or look, of the project's
 * size, or of how far it is scaled up - and the texture is kept. Playing a
 * title back only moves that texture, so a title costs a frame what a still
 * image does.
 *
 * Nothing is drawn before the fonts it needs are loaded: the viewer leaves
 * the title out for the frame or two that takes (keeping the previous
 * picture when there is one), and an exact render - the export - waits for
 * them in `prepare`.
 */

interface Resident {
  key: string;
  rect: Rect;
  geometry: TitleGeometry;
}

/** Largest scale a clip reaches in any of its keyframes, so the text is drawn sharp for it. */
export function largestScale(clip: Clip): number {
  let largest = 1;
  for (const keyframe of clip.transform.scale) {
    largest = Math.max(largest, Math.abs(keyframe.value.x), Math.abs(keyframe.value.y));
  }
  return largest;
}

const keyOf = (title: TitleContent, width: number, height: number, scale: number): string =>
  `${width}x${height}@${scale}|${JSON.stringify(title)}`;

export class TitleLayers {
  private readonly resident = new Map<string, Resident>();
  /** The key of a title object, which never changes: titles are replaced, not edited in place. */
  private readonly keys = new WeakMap<TitleContent, { size: string; key: string }>();

  constructor(private readonly textures: TextureManager) {}

  private static textureKey(clip: Clip): string {
    return `title:${clip.id}`;
  }

  private keyFor(title: TitleContent, width: number, height: number, scale: number): string {
    const size = `${width}x${height}@${scale}`;
    const known = this.keys.get(title);
    if (known && known.size === size) return known.key;
    const key = keyOf(title, width, height, scale);
    this.keys.set(title, { size, key });
    return key;
  }

  /**
   * The texture for a title clip, drawing it if it changed. Null while its
   * fonts load and nothing was drawn for it before.
   *
   * `at` is the frame being drawn. A title whose words move (a caption with
   * an animation, text/wordAnimation) is drawn as it stands at that frame -
   * but only when that differs from what the texture already holds: between
   * one word and the next, once its spring has settled, nothing is drawn.
   */
  sourceFor(clip: Clip, width: number, height: number, at?: { frame: number; fps: number }): ClipSource | null {
    const title = clip.title;
    if (!title) return null;
    const scale = largestScale(clip);
    const animation = at ? wordAnimationOf(title) : undefined;
    if (animation && at) return this.animatedSourceFor(clip, title, animation, width, height, scale, at);
    const key = this.keyFor(title, width, height, scale);
    const textureKey = TitleLayers.textureKey(clip);
    const resident = this.resident.get(clip.id);

    if (resident?.key === key) {
      const texture = this.textures.get(textureKey);
      if (texture) return { texture, flipY: true, rect: resident.rect, title: resident.geometry };
    }

    if (!titleFontsReady(title)) {
      void loadTitleFonts(title);
      // The last picture until the new one can be drawn, like a video seeking.
      const held = resident ? this.textures.get(textureKey) : undefined;
      return held && resident ? { texture: held, flipY: true, rect: resident.rect, title: resident.geometry } : null;
    }

    const raster = rasterizeTitle(title, { width, height }, scale);
    const texture = this.textures.upload(textureKey, raster.canvas, key);
    // Where the text is and what it turns about, as the viewer measures it too.
    const geometry = titleGeometry(title, { width, height });
    this.resident.set(clip.id, { key, rect: raster.rect, geometry });
    return { texture, flipY: true, rect: raster.rect, title: geometry };
  }

  private animatedSourceFor(
    clip: Clip,
    title: TitleContent,
    animation: WordAnimation,
    width: number,
    height: number,
    scale: number,
    at: { frame: number; fps: number },
  ): ClipSource | null {
    const seconds = (clip.sourceOffsetFrames + (at.frame - clip.startFrame) * speedOf(clip)) / at.fps;
    const state = wordFrameAt(animation, seconds);
    const key = `${this.keyFor(title, width, height, scale)}|${animation.key}|${state.key}`;
    const textureKey = TitleLayers.textureKey(clip);
    const resident = this.resident.get(clip.id);

    if (resident?.key === key) {
      const texture = this.textures.get(textureKey);
      if (texture) return { texture, flipY: true, rect: resident.rect, title: resident.geometry };
    }
    if (!titleFontsReady(title)) {
      void loadTitleFonts(title);
      const held = resident ? this.textures.get(textureKey) : undefined;
      return held && resident ? { texture: held, flipY: true, rect: resident.rect, title: resident.geometry } : null;
    }

    const raster = rasterizeWords(title, animation, state, { width, height }, scale);
    const texture = this.textures.upload(textureKey, raster.canvas, key);
    // The words on screen are what the viewer picks the caption by.
    const geometry = raster.page ? geometryFromLayout(raster.page.layout, title, { width, height }) : titleGeometry(title, { width, height });
    this.resident.set(clip.id, { key, rect: raster.rect, geometry });
    this.drawn += 1;
    return { texture, flipY: true, rect: raster.rect, title: geometry };
  }

  /** Pictures of moving words drawn so far: for measuring what animated captions cost. */
  drawn = 0;

  /** Where a title's picture sits on the frame, as last drawn. */
  rectOf(clipId: string): Rect | null {
    return this.resident.get(clipId)?.rect ?? null;
  }

  /** Wait for the fonts of a title, so the next draw of it is the real one. */
  async prepare(clip: Clip): Promise<void> {
    if (!clip.title) return;
    if (!titleFontsReady(clip.title)) await loadTitleFonts(clip.title);
    // Loaded faces are ready to draw once the document says so.
    await document.fonts?.ready;
  }

  /** Forget titles that are not in the project any more. */
  retain(clipIds: ReadonlySet<string>): void {
    for (const id of [...this.resident.keys()]) {
      if (clipIds.has(id)) continue;
      this.resident.delete(id);
      this.textures.release(`title:${id}`);
    }
  }
}
