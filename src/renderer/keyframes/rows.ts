import type { BezierCurve, Clip, ClipEffect, ClipTransform, Keyframe, Vector2D } from '@shared/types';
import type { MessageKey } from '@shared/i18n';
import { createId } from '@shared/utils/id';
import { evaluateNumber, evaluateVector } from '@renderer/engine/KeyframeEvaluator';
import { PAN_RANGE, VOLUME_RANGE, clipPanAt, clipVolumeAt } from '@renderer/audio/audioEnvelope';
import { effectDef, effectLabel, effectValuesAt } from '@renderer/fx/effects/catalog';
import type { Easing } from './easing';

/**
 * What the keyframe editor shows of a clip, and the edits it makes.
 *
 * A row is one thing that animates: the transform's position, scale,
 * rotation and opacity, the gain and stereo position of a clip that has
 * sound, and every setting of every effect on the clip that can move
 * (switches cannot). Its keyframes are the diamonds on the row; its channels
 * are the curves the graph draws - two for a position or a scale (X and Y
 * share each keyframe, as in After Effects), one for anything else.
 *
 * Every edit here is pure: it takes the clip and returns the patch for
 * updateClip, so a drag in the editor is one undo step (one merge key) and
 * the inspector, the viewer and the export see the same clip.
 */

export type RowId = string;

export interface RowKeyframe {
  id: string;
  frame: number;
  easing: Easing;
  bezierParams?: BezierCurve;
}

export interface Channel {
  id: 'x' | 'y' | 'value';
  /** Colour of its curve: X red, Y green, as every graph editor draws them. */
  tone: 'x' | 'y' | 'value';
  /** The value at a timeline frame, as stored (opacity 0-1, rotation in degrees, a setting in its own units). */
  at(frame: number): number;
  /** The range the value lives in, for the graph's scale; null when it has none. */
  range: [number, number] | null;
}

export interface Row {
  id: RowId;
  /** What the editor calls it, and the group it sits under. */
  label: MessageKey;
  group: 'transform' | 'audio' | 'effect';
  /** The effect's name for an effect setting's group. */
  groupLabel?: MessageKey;
  keyframes: RowKeyframe[];
  channels: Channel[];
}

type TransformRow = 'position' | 'scale' | 'rotation' | 'opacity';
const TRANSFORM_ROWS: ReadonlyArray<{ property: TransformRow; label: MessageKey; vector: boolean; range: [number, number] | null }> = [
  { property: 'position', label: 'inspector.position', vector: true, range: null },
  { property: 'scale', label: 'inspector.scale', vector: true, range: null },
  { property: 'rotation', label: 'inspector.rotation', vector: false, range: null },
  { property: 'opacity', label: 'inspector.opacity', vector: false, range: [0, 1] },
];

const FALLBACK: Record<TransformRow, Vector2D | number> = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, opacity: 1 };

type AudioRow = 'volume' | 'pan';
/**
 * The sound rows, shown only for a clip that has any (see `rowsOf`): a title
 * with a volume curve would be a lie, and an empty row to drop keyframes on
 * is worse than no row.
 */
const AUDIO_ROWS: ReadonlyArray<{ property: AudioRow; label: MessageKey; range: [number, number] }> = [
  { property: 'volume', label: 'inspector.volume', range: [VOLUME_RANGE[0], VOLUME_RANGE[1]] },
  { property: 'pan', label: 'inspector.pan', range: [PAN_RANGE[0], PAN_RANGE[1]] },
];
const AUDIO_TRACK: Record<AudioRow, 'volumeKeyframes' | 'panKeyframes'> = { volume: 'volumeKeyframes', pan: 'panKeyframes' };

const asRowKeyframe = (key: Keyframe<number> | Keyframe<Vector2D>): RowKeyframe => ({
  id: key.id,
  frame: key.frame,
  easing: key.easing as Easing,
  ...(key.bezierParams ? { bezierParams: key.bezierParams } : {}),
});

/** A transform row's id, or an effect setting's. */
export const transformRowId = (property: TransformRow): RowId => `transform:${property}`;
export const audioRowId = (property: AudioRow): RowId => `audio:${property}`;
export const effectRowId = (effectId: string, param: string): RowId => `effect:${effectId}:${param}`;

/**
 * Every row of `clip`: the transform's first, then the sound's, then each
 * effect's settings in stack order.
 *
 * `sound` says whether this clip has any sound to animate - the project knows
 * that from the asset, this module does not - and when it does not, the gain
 * and pan rows are left out entirely.
 */
export function rowsOf(clip: Clip, sound = false): Row[] {
  const rows: Row[] = TRANSFORM_ROWS.map(({ property, label, vector, range }) => {
    const track = clip.transform[property] as Array<Keyframe<number> | Keyframe<Vector2D>>;
    const channels: Channel[] = vector
      ? (['x', 'y'] as const).map((axis) => ({
          id: axis,
          tone: axis,
          at: (frame: number) => evaluateVector(clip.transform[property] as Keyframe<Vector2D>[], frame, FALLBACK[property] as Vector2D)[axis],
          range,
        }))
      : [{ id: 'value', tone: 'value', at: (frame: number) => evaluateNumber(clip.transform[property] as Keyframe<number>[], frame, FALLBACK[property] as number), range }];
    return { id: transformRowId(property), label, group: 'transform', keyframes: track.map(asRowKeyframe), channels };
  });
  if (sound) {
    for (const { property, label, range } of AUDIO_ROWS) {
      const keyframes = clip[AUDIO_TRACK[property]] ?? [];
      rows.push({
        id: audioRowId(property),
        label,
        group: 'audio',
        groupLabel: 'workspace.audio',
        keyframes: keyframes.map(asRowKeyframe),
        channels: [
          {
            id: 'value',
            tone: 'value',
            at: (frame: number) => (property === 'volume' ? clipVolumeAt(clip, frame) : clipPanAt(clip, frame)),
            range,
          },
        ],
      });
    }
  }
  for (const effect of clip.effects ?? []) {
    const def = effectDef(effect.type);
    if (!def) continue;
    for (const param of def.params) {
      if (param.format === 'toggle') continue;
      rows.push({
        id: effectRowId(effect.id, param.name),
        label: param.label,
        group: 'effect',
        groupLabel: effectLabel(effect.type),
        keyframes: (effect.keyframes?.[param.name] ?? []).map(asRowKeyframe),
        channels: [{ id: 'value', tone: 'value', at: (frame: number) => effectValuesAt(effect, frame)[param.name], range: [param.min, param.max] }],
      });
    }
  }
  return rows;
}

/** A keyframe picked in the editor: its row and its id. */
export interface Picked {
  row: RowId;
  id: string;
}

type Track = Array<Keyframe<number> | Keyframe<Vector2D>>;

/** The track behind a row, as stored. */
function trackOf(clip: Clip, row: RowId): Track | null {
  const [kind, a, b] = row.split(':');
  if (kind === 'transform') return (clip.transform[a as TransformRow] as Track | undefined) ?? null;
  if (kind === 'audio') return clip[AUDIO_TRACK[a as AudioRow]] ?? [];
  const effect = (clip.effects ?? []).find((candidate) => candidate.id === a);
  return effect ? (effect.keyframes?.[b] ?? []) : null;
}

/** `clip` with each track `edit` touches replaced: the patch for updateClip. */
function patchTracks(clip: Clip, rows: Iterable<RowId>, edit: (row: RowId, track: Track) => Track): Partial<Clip> {
  let transform: ClipTransform | null = null;
  let effects: ClipEffect[] | null = null;
  const audio: { volumeKeyframes?: Keyframe<number>[]; panKeyframes?: Keyframe<number>[] } = {};
  for (const row of new Set(rows)) {
    const track = trackOf(clip, row);
    if (!track) continue;
    const next = [...edit(row, track)].sort((first, second) => first.frame - second.frame);
    const [kind, a, b] = row.split(':');
    if (kind === 'transform') {
      transform = { ...(transform ?? clip.transform), [a]: next };
    } else if (kind === 'audio') {
      audio[AUDIO_TRACK[a as AudioRow]] = next as Keyframe<number>[];
    } else {
      effects = (effects ?? clip.effects ?? []).map((effect) =>
        effect.id === a ? { ...effect, keyframes: { ...(effect.keyframes ?? {}), [b]: next as Keyframe<number>[] } } : effect,
      );
    }
  }
  return { ...(transform ? { transform } : {}), ...(effects ? { effects } : {}), ...audio };
}

const byRow = (picked: readonly Picked[]): Map<RowId, Set<string>> => {
  const rows = new Map<RowId, Set<string>>();
  for (const pick of picked) rows.set(pick.row, (rows.get(pick.row) ?? new Set()).add(pick.id));
  return rows;
};

/** The frames a clip spans, where its keyframes may go. */
export const clipSpan = (clip: Clip): [number, number] => [clip.startFrame, clip.startFrame + Math.max(1, clip.durationFrames) - 1];

/**
 * The picked keyframes moved by `delta` frames, as one. The move is held so
 * that none leaves the clip and none lands on a keyframe of its row that is
 * not moving (a row keeps one keyframe a frame); held, they all stop together.
 */
export function retime(clip: Clip, picked: readonly Picked[], delta: number): Partial<Clip> {
  const rows = byRow(picked);
  const [first, last] = clipSpan(clip);
  let allowed = Math.round(delta);
  for (const [row, ids] of rows) {
    const track = trackOf(clip, row) ?? [];
    const moving = track.filter((key) => ids.has(key.id));
    if (moving.length === 0) continue;
    const lowest = Math.min(...moving.map((key) => key.frame));
    const highest = Math.max(...moving.map((key) => key.frame));
    allowed = Math.max(first - lowest, Math.min(last - highest, allowed));
    const still = new Set(track.filter((key) => !ids.has(key.id)).map((key) => key.frame));
    // Shrink the move towards zero until no moving keyframe lands on a still one.
    while (allowed !== 0 && moving.some((key) => still.has(key.frame + allowed))) allowed -= Math.sign(allowed);
  }
  if (allowed === 0) return {};
  return patchTracks(clip, rows.keys(), (row, track) => track.map((key) => (rows.get(row)?.has(key.id) ? { ...key, frame: key.frame + allowed } : key)));
}

/** The picked keyframes' outgoing move given `easing` (with its curve, for a custom bezier). */
export function setEasing(clip: Clip, picked: readonly Picked[], easing: Easing, bezierParams?: BezierCurve): Partial<Clip> {
  const rows = byRow(picked);
  return patchTracks(clip, rows.keys(), (row, track) =>
    track.map((key) => {
      if (!rows.get(row)?.has(key.id)) return key;
      const { bezierParams: _old, ...rest } = key;
      void _old;
      return { ...rest, easing: easing as Keyframe['easing'], ...(easing === 'bezier' && bezierParams ? { bezierParams } : {}) };
    }),
  );
}

/** The picked keyframes gone. A row left with none holds the value it had at the playhead. */
export function removeKeyframes(clip: Clip, picked: readonly Picked[], frame: number): Partial<Clip> {
  const rows = byRow(picked);
  const patch = patchTracks(clip, rows.keys(), (row, track) => track.filter((key) => !rows.get(row)?.has(key.id)));
  return holdEmptied(clip, patch, frame);
}

/**
 * The keyframe at `frame` on `row` added (with the value the row has there)
 * or, if there is one, removed - the diamond button's two jobs.
 */
export function toggleKeyframeAt(clip: Clip, row: RowId, frame: number): Partial<Clip> {
  const at = Math.round(frame);
  const track = trackOf(clip, row);
  if (!track) return {};
  const existing = track.find((key) => key.frame === at);
  if (existing) return removeKeyframes(clip, [{ row, id: existing.id }], at);
  const value = valueOf(clip, row, at);
  if (value === null) return {};
  return patchTracks(clip, [row], (_row, current) => [...current, { id: createId('kf'), frame: at, value, easing: 'linear' } as Keyframe<number> | Keyframe<Vector2D>]);
}

/** A keyframe's value on one channel set to `value` (the graph's vertical drag). */
export function setKeyframeValue(clip: Clip, row: RowId, id: string, channel: Channel['id'], value: number): Partial<Clip> {
  return patchTracks(clip, [row], (_row, track) =>
    track.map((key) => {
      if (key.id !== id) return key;
      if (channel === 'value' || typeof key.value === 'number') return { ...key, value } as Keyframe<number>;
      return { ...key, value: { ...(key.value as Vector2D), [channel]: value } } as Keyframe<Vector2D>;
    }),
  );
}

/** The value a row has at `frame` (a point for position and scale), or null for a row that is not there. */
function valueOf(clip: Clip, row: RowId, frame: number): number | Vector2D | null {
  const [kind, a, b] = row.split(':');
  if (kind === 'transform') {
    const property = a as TransformRow;
    const track = clip.transform[property];
    return property === 'position' || property === 'scale'
      ? evaluateVector(track as Keyframe<Vector2D>[], frame, FALLBACK[property] as Vector2D)
      : evaluateNumber(track as Keyframe<number>[], frame, FALLBACK[property] as number);
  }
  if (kind === 'audio') return a === 'volume' ? clipVolumeAt(clip, frame) : clipPanAt(clip, frame);
  const effect = (clip.effects ?? []).find((candidate) => candidate.id === a);
  return effect ? effectValuesAt(effect, frame)[b] ?? null : null;
}

/**
 * After keyframes are removed: a transform row with none left keeps one, at
 * the clip's start, holding the value it had at `frame` (the transform always
 * has a value to draw); an effect setting with none left holds that value as
 * its plain setting, as the inspector's diamond leaves it. A gain or pan row
 * emptied does the same: the fader takes the value the curve had at `frame`,
 * so deleting the last keyframe does not jump the sound back to whatever the
 * fader was before the curve was drawn.
 */
function holdEmptied(clip: Clip, patch: Partial<Clip>, frame: number): Partial<Clip> {
  const next = { ...clip, ...patch };
  let transform = patch.transform;
  for (const { property } of TRANSFORM_ROWS) {
    if (!patch.transform || next.transform[property].length > 0) continue;
    const value = valueOf(clip, transformRowId(property), frame);
    if (value === null) continue;
    transform = { ...(transform ?? next.transform), [property]: [{ id: createId('kf'), frame: clip.startFrame, value, easing: 'linear' }] };
  }
  const audio: { volume?: number; pan?: number } = {};
  for (const { property, range } of AUDIO_ROWS) {
    const key = AUDIO_TRACK[property];
    if (patch[key] === undefined || (patch[key] ?? []).length > 0) continue;
    const held = valueOf(clip, audioRowId(property), frame);
    if (typeof held !== 'number') continue;
    audio[property] = Math.min(range[1], Math.max(range[0], held));
  }
  let effects = patch.effects;
  if (patch.effects) {
    effects = patch.effects.map((effect) => {
      const empty = Object.entries(effect.keyframes ?? {}).filter(([, track]) => track.length === 0).map(([name]) => name);
      if (empty.length === 0) return effect;
      const before = (clip.effects ?? []).find((candidate) => candidate.id === effect.id) ?? effect;
      const held = effectValuesAt(before, frame);
      const keyframes = Object.fromEntries(Object.entries(effect.keyframes ?? {}).filter(([, track]) => track.length > 0));
      const { keyframes: _old, ...plain } = effect;
      void _old;
      return {
        ...plain,
        params: { ...effect.params, ...Object.fromEntries(empty.map((name) => [name, held[name]])) },
        ...(Object.keys(keyframes).length > 0 ? { keyframes } : {}),
      };
    });
  }
  return { ...patch, ...(transform ? { transform } : {}), ...(effects ? { effects } : {}), ...audio };
}

/** The keyframe before or after `frame` on any of `rows` (all rows when none given): where ◀ and ▶ go. */
export function neighbourKeyframe(rows: readonly Row[], frame: number, direction: -1 | 1): number | null {
  let best: number | null = null;
  for (const row of rows) {
    for (const key of row.keyframes) {
      if (direction > 0 ? key.frame > frame && (best === null || key.frame < best) : key.frame < frame && (best === null || key.frame > best)) best = key.frame;
    }
  }
  return best;
}
