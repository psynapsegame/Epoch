/**
 * Two-finger gesture maths (pure): turns the previous and current positions
 * of two touches into zoom, rotation and tilt deltas.
 */
export interface Point { x: number; y: number }

export interface TwoFingerDelta {
  /** Multiply the camera distance by this (pinch out < 1 = zoom in). */
  zoomFactor: number;
  /** Rotation of the finger pair in radians (screen space, clockwise positive). */
  rotation: number;
  /** Shared vertical travel in pixels (both fingers moving together), else 0. */
  tiltPixels: number;
}

export function twoFingerDelta(a0: Point, b0: Point, a1: Point, b1: Point): TwoFingerDelta {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const zoomFactor = d0 > 1 && d1 > 1 ? d0 / d1 : 1;
  let rotation = Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
  if (rotation > Math.PI) rotation -= 2 * Math.PI;
  if (rotation < -Math.PI) rotation += 2 * Math.PI;
  // Too close together: the angle is unreliable.
  if (d0 < 24 || d1 < 24) rotation = 0;
  const dya = a1.y - a0.y, dyb = b1.y - b0.y;
  const together = dya * dyb > 0 && Math.abs(dya - dyb) < Math.max(Math.abs(dya), Math.abs(dyb)) * 0.7 + 1;
  const tiltPixels = together ? (dya + dyb) * 0.5 : 0;
  return { zoomFactor, rotation, tiltPixels };
}
