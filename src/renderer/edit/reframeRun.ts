import type { Clip, ClipTransform, Keyframe, MediaAsset, ProjectState, Vector2D } from '@shared/types';
import { createId } from '@shared/utils/id';
import { MATTE_HEADER_BYTES, decodeMatteFrame, readMatteHeader, readMatteIndex, readMatteTimes } from '@shared/matte/format';
import { rangeReader } from '@renderer/engine/rangeFetch';
import { speedOf } from '@renderer/timing/clipSpeed';
import { simplified } from '@renderer/fx/motion/animations';
import { DEFAULT_CAMERA, cameraPath, coverScale, positionFor, reframedSize, subjectCentre, type CameraOptions } from './reframe';

/**
 * Auto reframe, run on a project: which clips it moves, where the person is
 * in each (read from its file's people matte, a few times a second), and the
 * new size and tracks that come of it (edit/reframe.ts has the maths).
 */

/** Clips a reframe fills into the new frame: pictures from a file - not titles, captions or sound. */
export function reframeableClips(project: ProjectState, assets: readonly MediaAsset[]): Array<{ clip: Clip; asset: MediaAsset }> {
  const visual = new Set(project.tracks.filter((track) => track.type === 'video').map((track) => track.id));
  const out: Array<{ clip: Clip; asset: MediaAsset }> = [];
  for (const clip of Object.values(project.clips)) {
    if (!visual.has(clip.trackId) || clip.title || clip.caption || clip.audioOnly) continue;
    const asset = assets.find((candidate) => candidate.uri === clip.sourceUri);
    if (!asset || (asset.kind !== 'video' && asset.kind !== 'image') || !(asset.width && asset.height)) continue;
    out.push({ clip, asset });
  }
  return out;
}

/** How often the person is looked for: five times a second is plenty for a camera that moves in seconds. */
const SAMPLE_SECONDS = 0.2;

/**
 * Where the person is across a clip, from its file's matte at `url`: one
 * sample every 0.2 s of the clip, in seconds of the clip from its start,
 * with the subject's middle (0..1 across the file) or null for nobody.
 */
export async function trackSubject(url: string, clip: Clip, fps: number): Promise<Array<{ t: number; x: number | null }>> {
  const read = rangeReader(url);
  const header = readMatteHeader(await read(0, MATTE_HEADER_BYTES));
  if (!header) throw new Error('unreadable matte');
  const indexEnd = header.timesOffset > 0 ? header.timesOffset : header.indexOffset + (header.frames + 1) * 8;
  const offsets = readMatteIndex(await read(header.indexOffset, indexEnd - header.indexOffset), header.frames);
  const times = header.timesOffset > 0 ? readMatteTimes(await read(header.timesOffset, header.frames * 8), header.frames) : null;
  if (!offsets) throw new Error('unreadable matte index');
  const pixels = new Uint8Array(header.width * header.height);
  const speed = speedOf(clip);
  const clipSeconds = clip.durationFrames / fps;
  const samples: Array<{ t: number; x: number | null }> = [];
  for (let t = 0; t <= clipSeconds + 1e-9; t += SAMPLE_SECONDS) {
    const sourceSeconds = clip.sourceOffsetFrames / fps + t * speed;
    // The matte shown at that moment of the file: the last at or before it (a still has one).
    let frame = 0;
    if (times) {
      let low = 0;
      let high = times.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (times[mid] <= sourceSeconds + 1e-6) low = mid;
        else high = mid - 1;
      }
      frame = low;
    }
    const coded = await read(offsets[frame], offsets[frame + 1] - offsets[frame]);
    const found = decodeMatteFrame(coded, pixels) ? subjectCentre(pixels, header.width, header.height) : null;
    samples.push({ t, x: found ? found.x : null });
  }
  return samples;
}

export interface ReframePlan {
  size: { width: number; height: number };
  transforms: Record<string, Pick<ClipTransform, 'position' | 'scale'>>;
}

/**
 * The new size and each clip's tracks: filled into the new frame, and - with
 * where the person is, by clip - its position keyframed along the virtual
 * camera's path; without, centred.
 */
export function planReframe(
  project: ProjectState,
  assets: readonly MediaAsset[],
  aspect: { w: number; h: number },
  subjects: ReadonlyMap<string, ReadonlyArray<{ t: number; x: number | null }>>,
  camera: CameraOptions = DEFAULT_CAMERA,
): ReframePlan {
  const size = reframedSize(project.width, project.height, aspect);
  const transforms: ReframePlan['transforms'] = {};
  for (const { clip, asset } of reframeableClips(project, assets)) {
    const scale = coverScale(asset.width! / asset.height!, size.width / size.height);
    const drawnWidth = size.width * scale.x;
    const shotWidth = size.width / drawnWidth;
    const samples = subjects.get(clip.id);
    const scaleTrack: Keyframe<Vector2D>[] = [{ id: createId('kf'), frame: clip.startFrame, value: scale, easing: 'linear' }];
    if (!samples || samples.length === 0 || shotWidth >= 0.999) {
      transforms[clip.id] = { position: [], scale: scaleTrack };
      continue;
    }
    const path = cameraPath(samples, shotWidth, camera);
    const keys: Keyframe<Vector2D>[] = path.map((point) => ({
      id: createId('kf'),
      frame: Math.min(clip.startFrame + clip.durationFrames - 1, clip.startFrame + Math.round(point.t * project.fps)),
      value: { x: positionFor(point.x, drawnWidth, size.width), y: 0 },
      easing: 'linear',
    }));
    // One keyframe a frame at most, and only the ones the path needs (to within 3 px: nothing seen on a moving frame).
    const unique = [...new Map(keys.map((key) => [key.frame, key])).values()];
    const position = simplified(unique, 3);
    transforms[clip.id] = { position: position.length === 1 || position.every((key) => key.value.x === position[0].value.x) ? [{ ...position[0], frame: clip.startFrame }] : position, scale: scaleTrack };
  }
  return { size, transforms };
}
