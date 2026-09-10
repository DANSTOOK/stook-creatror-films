import type { Vector2D } from '../types';

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpVec2 = (a: Vector2D, b: Vector2D, t: number): Vector2D => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;

export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

export const nearlyEqual = (a: number, b: number, epsilon = 1e-6): boolean =>
  Math.abs(a - b) <= epsilon;

/** Narrowing helper shared by the keyframe evaluator and the inspector. */
export const isVector2D = (value: unknown): value is Vector2D =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Vector2D).x === 'number' &&
  typeof (value as Vector2D).y === 'number';
