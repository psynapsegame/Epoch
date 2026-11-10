import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep } from '../core/math';
import type { World } from '../world/world';
import { twoFingerDelta } from './gestures';

const MIN_DIST = 7;
const MAX_DIST = 15000;
const Y = new THREE.Vector3(0, 1, 0);

export interface CameraState {
  dir: [number, number, number];
  distance: number;
  heading: number;
  tilt: number;
}

/**
 * Planet camera: one continuous zoom from orbit (strategic view) down to
 * eye level (immersive view). The camera orbits a focus point on the surface.
 * Touch (primary):  one finger drag = travel · pinch = zoom · twist = rotate ·
 *                   two fingers sliding up/down = tilt · tap = select
 * Mouse / keyboard: left drag = travel · right drag = rotate / tilt · wheel = zoom ·
 *                   WASD / arrows = travel · Q/E = turn
 */
export class CameraController {
  /** Focus point direction (goal + smoothed). */
  readonly goalDir = new THREE.Vector3(1, 0.35, 0.2).normalize();
  readonly dir = this.goalDir.clone();
  goalDistance = 9500;
  distance = 9500;
  goalHeading = 0;
  heading = 0;
  goalTilt = 0;
  tilt = 0;
  /** When true the user does not control the camera (intro cinematic). */
  cinematic = false;
  enabled = true;
  private userTilt = false;
  private keys = new Set<string>();
  /** Active pointers (fingers or mouse buttons). */
  private pointers = new Map<number, { x: number; y: number; button: number; touch: boolean; lastDy?: number }>();
  /** True once a gesture used two fingers: its release must not count as a tap. */
  private multiTouch = false;
  /** performance.now() of the last user input, for frame pacing. */
  lastInput = 0;
  private groundR = 0;
  private moved = 0;
  /** Called whenever the player moves the focus point (used to stop following someone). */
  onPan: (() => void) | null = null;
  /** Called on a click that was not a drag. */
  onClick: ((ev: PointerEvent) => void) | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera, private dom: HTMLElement, private world: World | null = null) {
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    dom.style.touchAction = 'none';
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setWorld(world: World | null): void {
    this.world = world;
    this.groundR = 0;
  }

  get interactive(): boolean {
    return this.enabled && !this.cinematic;
  }

  /** Steepest tilt allowed at a distance: straight down from orbit, near-horizontal close to the ground. */
  private maxTilt(d: number): number {
    return lerp(1.5, 0, smoothstep(Math.log(1800), Math.log(8000), Math.log(d)));
  }
  private autoTilt(d: number): number {
    return lerp(1.2, 0, smoothstep(Math.log(40), Math.log(6500), Math.log(d)));
  }

  private onDown = (e: PointerEvent) => {
    if (!this.interactive) return;
    this.lastInput = performance.now();
    if (this.pointers.size === 0) {
      this.moved = 0;
      this.multiTouch = false;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, touch: e.pointerType !== 'mouse' });
    if (this.pointers.size >= 2) this.multiTouch = true;
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.interactive) return;
    this.lastInput = performance.now();
    const px = p.x, py = p.y;
    const dx = e.clientX - px, dy = e.clientY - py;
    this.moved += Math.abs(dx) + Math.abs(dy);

    if (this.pointers.size >= 2) {
      // Two fingers: pinch = zoom, twist = rotate, parallel vertical slide = tilt.
      let other: { x: number; y: number } | null = null;
      for (const [id, q] of this.pointers) if (id !== e.pointerId) { other = q; break; }
      p.x = e.clientX;
      p.y = e.clientY;
      if (!other) return;
      // The other finger is treated as still for this event; its own events mirror this.
      const g = twoFingerDelta({ x: px, y: py }, other, p, other);
      if (g.zoomFactor !== 1) this.zoomBy(g.zoomFactor);
      this.goalHeading += g.rotation;
      if (Math.abs(dy) > Math.abs(dx) * 1.5 && this.sameVerticalTrend(e.pointerId, dy)) {
        this.goalTilt = clamp(this.goalTilt - dy * 0.004, 0, this.maxTilt(this.goalDistance));
        this.userTilt = true;
      }
      p.lastDy = dy;
      return;
    }

    p.x = e.clientX;
    p.y = e.clientY;
    if (p.touch || (p.button === 0 && !e.shiftKey)) {
      const mPerPx = (2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / this.dom.clientHeight;
      this.pan(-dx * mPerPx, (dy * mPerPx) / Math.max(0.35, Math.cos(this.tilt)));
    } else {
      this.goalHeading -= dx * 0.005;
      this.goalTilt = clamp(this.goalTilt - dy * 0.005, 0, this.maxTilt(this.goalDistance));
      this.userTilt = true;
    }
  };

  /** Both fingers recently moved in the same vertical direction (a tilt slide, not a pinch). */
  private sameVerticalTrend(id: number, dy: number): boolean {
    for (const [oid, q] of this.pointers) {
      if (oid !== id) return (q.lastDy ?? 0) * dy > 0;
    }
    return false;
  }

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    this.lastInput = performance.now();
    const slop = p.touch ? 14 : 5;
    const isTap = e.type === 'pointerup' && !this.multiTouch && this.moved < slop && (p.touch || p.button === 0);
    if (isTap && this.pointers.size === 0 && this.interactive) this.onClick?.(e);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.interactive) return;
    this.lastInput = performance.now();
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    // ctrl+wheel is how trackpads report a pinch
    this.zoomBy(Math.exp(clamp(delta, -400, 400) * (e.ctrlKey ? 0.01 : 0.0016)));
  };

  zoomBy(factor: number): void {
    this.goalDistance = clamp(this.goalDistance * factor, MIN_DIST, MAX_DIST);
    if (!this.userTilt || this.goalDistance > 6000) {
      this.goalTilt = this.autoTilt(this.goalDistance);
      if (this.goalDistance > 6000) this.userTilt = false;
    }
    this.goalTilt = Math.min(this.goalTilt, this.maxTilt(this.goalDistance));
  }

  /** Moves the focus point by metres along the camera's right / forward ground axes. */
  pan(right: number, forward: number): void {
    this.onPan?.();
    const R = this.world?.R ?? 3200;
    const up = this.goalDir;
    const east = new THREE.Vector3().crossVectors(up, Y);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(east, up).normalize();
    const fwd = north.clone().multiplyScalar(Math.cos(this.heading)).addScaledVector(east, Math.sin(this.heading));
    const rgt = new THREE.Vector3().crossVectors(fwd, up);
    const move = fwd.multiplyScalar(forward / R).addScaledVector(rgt, right / R);
    const before = north.clone();
    this.goalDir.add(move).normalize();
    // Keep heading stable relative to the ground when crossing meridians / near poles.
    const east2 = new THREE.Vector3().crossVectors(this.goalDir, Y);
    if (east2.lengthSq() > 1e-6) {
      east2.normalize();
      const north2 = new THREE.Vector3().crossVectors(east2, this.goalDir);
      const projected = before.sub(this.goalDir.clone().multiplyScalar(before.dot(this.goalDir))).normalize();
      const ang = Math.atan2(projected.dot(east2), projected.dot(north2));
      this.goalHeading += ang;
      this.heading += ang;
    }
  }

  /** Smoothly travels to a place. */
  flyTo(dir: THREE.Vector3, distance?: number, tilt?: number): void {
    this.goalDir.copy(dir).normalize();
    if (distance !== undefined) {
      this.goalDistance = clamp(distance, MIN_DIST, MAX_DIST);
      this.userTilt = tilt !== undefined;
      this.goalTilt = Math.min(tilt ?? this.autoTilt(this.goalDistance), this.maxTilt(this.goalDistance));
    }
  }

  strategicView(): void {
    this.userTilt = false;
    this.goalDistance = 9500;
    this.goalTilt = 0;
  }

  immersiveView(): void {
    this.userTilt = true;
    this.goalDistance = 60;
    this.goalTilt = 1.28;
  }

  /** True while the camera has not yet settled on its goal (or a cinematic plays). */
  get moving(): boolean {
    return (
      this.cinematic ||
      this.pointers.size > 0 ||
      Math.abs(Math.log(this.distance / this.goalDistance)) > 0.002 ||
      this.dir.distanceToSquared(this.goalDir) > 1e-10 ||
      Math.abs(this.heading - this.goalHeading) > 0.002 ||
      Math.abs(this.tilt - Math.min(this.goalTilt, this.maxTilt(this.distance))) > 0.002
    );
  }

  get altitude(): number {
    return this.camera.position.length() - (this.world?.R ?? 3200);
  }

  getState(): CameraState {
    return { dir: [this.goalDir.x, this.goalDir.y, this.goalDir.z], distance: this.goalDistance, heading: this.goalHeading, tilt: this.goalTilt };
  }

  setState(s: CameraState, snap = true): void {
    this.goalDir.set(s.dir[0], s.dir[1], s.dir[2]).normalize();
    this.goalDistance = s.distance;
    this.goalHeading = s.heading;
    this.goalTilt = s.tilt;
    this.userTilt = true;
    if (snap) {
      this.dir.copy(this.goalDir);
      this.distance = s.distance;
      this.heading = s.heading;
      this.tilt = s.tilt;
    }
  }

  update(dt: number): void {
    if (this.cinematic) {
      // slow orbital drift
      this.goalDir.applyAxisAngle(Y, dt * 0.05).normalize();
    } else if (this.enabled) {
      const k = this.keys;
      const speed = this.distance * 0.9 * dt * (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1);
      let f = 0, r = 0;
      if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
      if (f || r) this.pan(r * speed, f * speed);
      if (k.size) this.lastInput = performance.now();
      if (k.has('KeyQ')) this.goalHeading += dt * 1.2;
      if (k.has('KeyE')) this.goalHeading -= dt * 1.2;
      if (k.has('KeyR')) this.zoomBy(Math.exp(-dt * 1.6));
      if (k.has('KeyF')) this.zoomBy(Math.exp(dt * 1.6));
    }

    const a = damp(7, dt);
    // slerp-like smoothing of the focus direction
    this.dir.lerp(this.goalDir, damp(this.cinematic ? 2 : 9, dt)).normalize();
    this.distance = Math.exp(lerp(Math.log(this.distance), Math.log(this.goalDistance), a));
    this.heading = lerp(this.heading, this.goalHeading, a);
    this.tilt = lerp(this.tilt, Math.min(this.goalTilt, this.maxTilt(this.distance)), a);

    const R = this.world?.R ?? 3200;
    const targetR = this.world ? this.world.surfaceRadius(this.dir.x, this.dir.y, this.dir.z) : R;
    this.groundR = this.groundR === 0 ? targetR : lerp(this.groundR, targetR, damp(6, dt));

    const up = this.dir;
    const east = new THREE.Vector3().crossVectors(up, Y);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(east, up).normalize();
    const fwd = north.multiplyScalar(Math.cos(this.heading)).addScaledVector(east, Math.sin(this.heading));
    const target = up.clone().multiplyScalar(this.groundR + 1.6);
    const cam = this.camera;
    cam.position.copy(target).addScaledVector(up, Math.cos(this.tilt) * this.distance).addScaledVector(fwd, -Math.sin(this.tilt) * this.distance);

    // never go below the terrain
    if (this.world) {
      const len = cam.position.length();
      const minR = this.world.surfaceRadius(cam.position.x / len, cam.position.y / len, cam.position.z / len) + 1.7;
      if (len < minR) cam.position.multiplyScalar(minR / len);
    }
    cam.up.copy(fwd).multiplyScalar(Math.cos(this.tilt)).addScaledVector(up, Math.sin(this.tilt)).normalize();
    cam.lookAt(target);

    const alt = Math.max(1, cam.position.length() - R);
    const camLen = cam.position.length();
    cam.near = clamp(Math.min(alt, this.distance) * 0.04, 0.35, 400);
    cam.far = Math.sqrt(Math.max(0, camLen * camLen - R * R)) + R * 1.6;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
