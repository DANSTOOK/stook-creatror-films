import type { Clip, OnionSkin } from '@shared/types';
import { exposureAt } from '@renderer/animation/model';
import { rasterizeAnimation, rasterKey } from '@renderer/animation/raster';
import type { ClipSource } from './Compositor';
import type { TextureManager } from './TextureManager';

/**
 * Drawn animation clips as textures.
 *
 * Built like TitleLayers, and for the same reason: a clip with no file whose
 * picture comes from its own data. The drawing is rasterized once per change
 * and the texture kept, so while a drawing is held - two frames at "on twos",
 * and often many more - playing it back costs what a still image costs.
 *
 * The scratch canvas is kept too. One canvas per clip is reused for every
 * frame, so playing an animation allocates nothing.
 */
export class AnimationLayers {
  private readonly keys = new Map<string, string>();
  private readonly canvases = new Map<string, HTMLCanvasElement>();

  constructor(private readonly textures: TextureManager) {}

  private static textureKey(clip: Clip): string {
    return `anim:${clip.id}`;
  }

  /**
   * The texture for an animation clip at a timeline frame.
   *
   * `onion` is passed only by the viewer, and only for the clip being drawn
   * into: an export must never carry the ghosts, and neither should the other
   * animation clips in the same project.
   */
  sourceFor(clip: Clip, width: number, height: number, frame: number, onion?: OnionSkin): ClipSource | null {
    const anim = clip.anim;
    if (!anim) return null;
    const exposure = exposureAt(anim, clip, frame);
    const key = rasterKey(anim, exposure, width, height, onion, frame);
    const textureKey = AnimationLayers.textureKey(clip);

    if (this.keys.get(clip.id) === key) {
      const texture = this.textures.get(textureKey);
      if (texture) return { texture, flipY: true };
    }

    let canvas = this.canvases.get(clip.id);
    canvas = rasterizeAnimation(anim, exposure, { width, height, onion, into: canvas, frame });
    this.canvases.set(clip.id, canvas);
    const texture = this.textures.upload(textureKey, canvas, key);
    this.keys.set(clip.id, key);
    return { texture, flipY: true };
  }

  /** Nothing to wait for: a drawing needs no font and no decoder. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async prepare(_clip: Clip): Promise<void> {}

  /** The textures and canvases of clips that are gone. */
  retain(clipIds: Set<string>): void {
    for (const id of [...this.keys.keys()]) {
      if (clipIds.has(id)) continue;
      this.textures.release(`anim:${id}`);
      this.keys.delete(id);
      this.canvases.delete(id);
    }
  }
}
