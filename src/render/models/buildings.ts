/**
 * Procedural low-poly building models for EPOCH.
 *
 * Every model is a single merged, non-indexed BufferGeometry with flat face
 * normals, linear-space vertex colours and a per-vertex `emissive` flag
 * (1 for window panes / lantern glass / embers, 0 elsewhere).
 *
 * Conventions: metres, Y up, origin at ground centre, front door faces +Z,
 * foundations reach 1.5 m below y = 0 so models can sit on sloped terrain.
 */
import * as THREE from 'three';

export type BuildingKind =
  | 'hut' | 'house' | 'longhouse' | 'farm' | 'barn' | 'market' | 'workshop'
  | 'storehouse' | 'temple' | 'well' | 'windmill' | 'watchtower' | 'dock';

export const BUILDING_KINDS: BuildingKind[] = [
  'hut', 'house', 'longhouse', 'farm', 'barn', 'market', 'workshop',
  'storehouse', 'temple', 'well', 'windmill', 'watchtower', 'dock',
];

export interface BuildingModel {
  geometry: THREE.BufferGeometry; // single merged geometry
  footprint: number;              // bounding radius on the ground plane (m)
  height: number;                 // max Y (m)
}

type V3 = [number, number, number];
type RGB = [number, number, number];

/** sRGB hex -> linear RGB triple. */
const rgb = (hex: number): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const tint = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];

// ---------------------------------------------------------------- palette
const STONE = rgb(0x8f8b82), STONE_D = rgb(0x6c6963), STONE_L = rgb(0xaeaa9d);
const PLASTER = rgb(0xdccfb0), DAUB = rgb(0xc2a67c);
const TIMBER = rgb(0x5a4030), TIMBER_D = rgb(0x3b2a20), PLANK = rgb(0x8a6844), PLANK_L = rgb(0xa98558);
const BARN = rgb(0x7a4a36), LOG_A = rgb(0x7b5a3c), LOG_B = rgb(0x6a4b32);
const THATCH = rgb(0xcba852), SHINGLE = rgb(0x4b4742), SHINGLE_W = rgb(0x66503c);
const RED = rgb(0x8e2f2a), OCHRE = rgb(0xc38d2e), TEAL = rgb(0x2f7a78), OLIVE = rgb(0x6b7a3a), CREAM = rgb(0xe4d8ba);
const SOIL = rgb(0x6a4f38), SOIL_D = rgb(0x4e3a2a), CROP = rgb(0x6f9a38), WHEAT = rgb(0xd2b24e), HAY = rgb(0xd6b65c);
const GLASS = rgb(0xf0c070), EMBER = rgb(0xff8a30), IRON = rgb(0x34322f), ROPE = rgb(0xb59a6a);
const WATER = rgb(0x2c5668), COPPER = rgb(0x3f8f86), GOLD = rgb(0xd6aa3c), MARBLE = rgb(0xc9c3b4);

// ---------------------------------------------------------------- builder
interface RoofOpts {
  col: RGB; trim?: RGB; over?: number; overEnd?: number; thick?: number; courses?: number;
  /** Ridge runs along X instead of Z. */
  alongX?: boolean;
}

/** Accumulates coloured, flat-shaded triangles. All faces are auto-wound so
 *  that their normal points away from a supplied interior reference point. */
class Builder {
  private pos: number[] = [];
  private col: number[] = [];
  private emi: number[] = [];
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private seed: number;

  constructor(seed: number) { this.seed = seed >>> 0; }

  /** Deterministic PRNG (mulberry32), returns [0, 1). */
  rnd(): number {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Brightness-jittered copy of a colour (+-amt). */
  jit(c: RGB, amt = 0.06): RGB { return tint(c, 1 + (this.rnd() - 0.5) * 2 * amt); }

  /** Run `fn` inside a local frame translated to (x,y,z) and rotated about Y. */
  place(x: number, y: number, z: number, rotY: number, fn: () => void): void {
    const saved = this.m.clone();
    this.m.multiply(new THREE.Matrix4().makeRotationY(rotY).setPosition(x, y, z));
    fn();
    this.m.copy(saved);
  }

  private push(p: V3, c: RGB, e: number): void {
    this.v.set(p[0], p[1], p[2]).applyMatrix4(this.m);
    this.pos.push(this.v.x, this.v.y, this.v.z);
    this.col.push(c[0], c[1], c[2]);
    this.emi.push(e);
  }

  /** True if triangle abc (CCW) faces away from `inside`. */
  private outward(a: V3, b: V3, c: V3, inside: V3): boolean {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return nx * (a[0] - inside[0]) + ny * (a[1] - inside[1]) + nz * (a[2] - inside[2]) >= 0;
  }

  tri(a: V3, b: V3, c: V3, col: RGB, inside: V3, e = 0): void {
    const k = this.jit(col, 0.05);
    const f = this.outward(a, b, c, inside);
    this.push(a, k, e); this.push(f ? b : c, k, e); this.push(f ? c : b, k, e);
  }

  /** Planar quad a-b-c-d (loop order), with +-5% per-face colour variation. */
  quad(a: V3, b: V3, c: V3, d: V3, col: RGB, inside: V3, e = 0): void {
    const k = this.jit(col, 0.05);
    const o = this.outward(a, b, c, inside) ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    for (const p of o) this.push(p, k, e);
  }

  /** Thin double-sided sheet (cloth, sails). */
  sheet(a: V3, b: V3, c: V3, d: V3, col: RGB): void {
    const mid: V3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
    const up: V3 = [mid[0], mid[1] + 50, mid[2] + 31], dn: V3 = [mid[0], mid[1] - 50, mid[2] - 31];
    this.quad(a, b, c, d, col, up);
    this.quad(a, b, c, d, tint(col, 0.85), dn);
  }

  /** Convex hexahedron: p[0..3] one loop, p[4..7] the matching opposite loop. */
  hexa(p: V3[], col: RGB, e = 0): void {
    const c: V3 = [0, 0, 0];
    for (const q of p) { c[0] += q[0] / 8; c[1] += q[1] / 8; c[2] += q[2] / 8; }
    const f = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    for (const [i, j, k, l] of f) this.quad(p[i], p[j], p[k], p[l], col, c, e);
  }

  /** Axis-aligned box: centred on (cx, cz), bottom at y0. */
  box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, col: RGB, e = 0): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2, y1 = y0 + sy;
    this.hexa([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
               [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], col, e);
  }

  /** Rectangular beam between two points (sw = horizontal width, uh = other). */
  beam(p1: V3, p2: V3, sw: number, uh: number, col: RGB): void {
    const d: V3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    let s: V3 = [-d[2], 0, d[0]];
    let sl = Math.hypot(s[0], s[2]);
    if (sl < 1e-5) { s = [1, 0, 0]; sl = 1; }
    s = [s[0] / sl * sw / 2, 0, s[2] / sl * sw / 2];
    let u: V3 = [s[1] * d[2] - s[2] * d[1], s[2] * d[0] - s[0] * d[2], s[0] * d[1] - s[1] * d[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul * uh / 2, u[1] / ul * uh / 2, u[2] / ul * uh / 2];
    const ring = (p: V3): V3[] => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
      [p[0] + s[0] * a + u[0] * b, p[1] + s[1] * a + u[1] * b, p[2] + s[2] * a + u[2] * b] as V3);
    this.hexa([...ring(p1), ...ring(p2)], col);
  }

  /** Vertical frustum / cone with n sides; side 0 is a flat face toward +Z. */
  cyl(cx: number, y0: number, cz: number, rb: number, rt: number, h: number, n: number, col: RGB,
      o: { top?: boolean; bottom?: boolean; e?: number } = {}): void {
    const inside: V3 = [cx, y0 + h / 2, cz], e = o.e ?? 0;
    const pt = (a: number, r: number, y: number): V3 => [cx + Math.sin(a) * r, y, cz + Math.cos(a) * r];
    for (let i = 0; i < n; i++) {
      const a0 = (i - 0.5) * Math.PI * 2 / n, a1 = (i + 0.5) * Math.PI * 2 / n;
      const p0 = pt(a0, rb, y0), p1 = pt(a1, rb, y0), p2 = pt(a1, rt, y0 + h), p3 = pt(a0, rt, y0 + h);
      if (rt < 1e-4) this.tri(p0, p1, [cx, y0 + h, cz], col, inside, e);
      else if (rb < 1e-4) this.tri(p3, p2, [cx, y0, cz], col, inside, e);
      else this.quad(p0, p1, p2, p3, col, inside, e);
      if (o.top && rt > 1e-4) this.tri(p3, p2, [cx, y0 + h, cz], col, inside, e);
      if (o.bottom && rb > 1e-4) this.tri(p0, p1, [cx, y0, cz], col, inside, e);
    }
  }

  /** Four-sided pyramid roof with a closed base. */
  pyramid(cx: number, y0: number, cz: number, w: number, d: number, h: number, col: RGB): void {
    const c: V3[] = [[cx - w / 2, y0, cz - d / 2], [cx + w / 2, y0, cz - d / 2], [cx + w / 2, y0, cz + d / 2], [cx - w / 2, y0, cz + d / 2]];
    const apex: V3 = [cx, y0 + h, cz], inside: V3 = [cx, y0 + h * 0.2, cz];
    for (let i = 0; i < 4; i++) this.tri(c[i], c[(i + 1) % 4], apex, col, inside);
    this.quad(c[0], c[1], c[2], c[3], tint(col, 0.6), inside);
  }

  /** Sloped slab (lean-to roof, awning): top height goes yA -> yB along Z (or X). */
  slope(cx: number, cz: number, sx: number, sz: number, yA: number, yB: number, thick: number, col: RGB, alongX = false): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const y = alongX ? [yA, yB, yB, yA] : [yA, yA, yB, yB];
    const xs = [x0, x1, x1, x0], zs = [z0, z0, z1, z1];
    const lo = xs.map((x, i) => [x, y[i] - thick, zs[i]] as V3), hi = xs.map((x, i) => [x, y[i], zs[i]] as V3);
    this.hexa([...lo, ...hi], col);
  }

  /**
   * Gable roof with overhang, thickness, stepped courses, barge boards and a
   * ridge cap. `w` is the span across the ridge, `d` the length along it,
   * `y` the wall-plate height and `h` the rise.
   */
  gableRoof(cx: number, y: number, cz: number, w: number, d: number, h: number, o: RoofOpts): void {
    const over = o.over ?? 0.5, thick = o.thick ?? 0.25, n = o.courses ?? 5;
    const trim = o.trim ?? tint(o.col, 0.68);
    const P = (u: number, yy: number, v: number): V3 => (o.alongX ? [cx + v, yy, cz + u] : [cx + u, yy, cz + v]);
    const s = h / (w / 2), hw = w / 2 + over, hl = d / 2 + (o.overEnd ?? 0.4);
    const lift = thick * 0.6, step = thick * 0.4;
    const yE = y - over * s + lift, yR = y + h + lift;
    const below = P(0, y - 1000, 0), above = P(0, y + 1000, 0), mid = P(0, y + h * 0.3, 0);
    for (const sg of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const u0 = sg * hw * (1 - t0), u1 = sg * hw * (1 - t1);
        const y0 = yE + (yR - yE) * t0, y1 = yE + (yR - yE) * t1;
        const c = this.jit(o.col, 0.07);
        this.quad(P(u0, y0 + step, -hl), P(u0, y0 + step, hl), P(u1, y1, hl), P(u1, y1, -hl), c, below);
        if (i < n - 1) this.quad(P(u1, y1, -hl), P(u1, y1, hl), P(u1, y1 + step, hl), P(u1, y1 + step, -hl), tint(c, 0.78), mid);
      }
      this.quad(P(sg * hw, yE - thick, -hl), P(sg * hw, yE - thick, hl), P(0, yR - thick, hl), P(0, yR - thick, -hl), tint(o.col, 0.75), above);
      this.quad(P(sg * hw, yE + step, -hl), P(sg * hw, yE + step, hl), P(sg * hw, yE - thick, hl), P(sg * hw, yE - thick, -hl), trim, mid);
      for (const e of [-1, 1]) {
        this.quad(P(sg * hw, yE + step, e * hl), P(0, yR + step, e * hl), P(0, yR - thick, e * hl), P(sg * hw, yE - thick, e * hl), trim, P(0, y, 0));
      }
    }
    this.beam(P(0, yR + step * 0.4, -hl - 0.05), P(0, yR + step * 0.4, hl + 0.05), 0.42, 0.22, trim);
  }

  get triangles(): number { return this.pos.length / 9; }

  build(): BuildingModel {
    const pos = new Float32Array(this.pos), nor = new Float32Array(pos.length);
    let footprint = 0, height = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
      const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 9; k += 3) {
        nor[i + k] = nx; nor[i + k + 1] = ny; nor[i + k + 2] = nz;
        footprint = Math.max(footprint, Math.hypot(pos[i + k], pos[i + k + 2]));
        height = Math.max(height, pos[i + k + 1]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geometry.setAttribute('emissive', new THREE.BufferAttribute(new Float32Array(this.emi), 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, footprint, height };
  }
}

// ---------------------------------------------------------------- shared parts
const HP = Math.PI / 2;

/** Call fn for the 4 walls of a w x d rectangle in a frame where the wall
 *  faces local +Z at z = zf. Index: 0 front, 1 right (+X), 2 back, 3 left. */
function sides(b: Builder, w: number, d: number, fn: (width: number, zf: number, i: number) => void): void {
  for (let i = 0; i < 4; i++) b.place(0, 0, 0, i * HP, () => fn(i % 2 ? d : w, (i % 2 ? w : d) / 2, i));
}

/** Rows of irregular fieldstone blocks around a rectangle. */
function stoneCourse(b: Builder, w: number, d: number, y0: number, h: number, rows = 1): void {
  const rh = h / rows;
  sides(b, w, d, (width, zf) => {
    for (let r = 0; r < rows; r++) {
      const n = Math.max(2, Math.round(width / 1.0) - (r % 2)), len = width / n;
      for (let i = 0; i < n; i++) {
        const out = b.rnd() * 0.07;
        b.box(-width / 2 + (i + 0.5) * len, y0 + r * rh, zf - 0.2 + out / 2, len, rh, 0.4 + out, b.jit(STONE, 0.12));
      }
    }
  });
}

/** Underground footing (to -1.5 m) plus a visible fieldstone plinth. */
function base(b: Builder, w: number, d: number, top: number, rows = 1): void {
  b.box(0, -1.5, 0, w + 0.1, 1.5, d + 0.1, STONE_D);
  stoneCourse(b, w, d, 0, top, rows);
}

/** Timber framing on one wall face (sill, plate, rail, studs, braces). */
function frameFace(b: Builder, width: number, y0: number, h: number, zf: number, panels: number): void {
  const T = 0.16, D = 0.12;
  b.box(0, y0, zf, width, T, D, TIMBER);
  b.box(0, y0 + h - T, zf, width, T, D, TIMBER);
  b.box(0, y0 + h * 0.5, zf, width, T * 0.8, D, TIMBER);
  const pw = width / panels;
  for (let i = 1; i < panels; i++) b.box(-width / 2 + i * pw, y0, zf, T, h, D, b.jit(TIMBER));
  for (const s of [-1, 1]) {
    b.beam([s * (width / 2 - 0.1), y0 + T, zf], [s * (width / 2 - pw + 0.05), y0 + h * 0.5, zf], D, T * 0.8, TIMBER);
  }
}

/** Plastered, timber-framed wall box. */
function timberBody(b: Builder, w: number, d: number, y0: number, h: number, pf: number, ps: number): void {
  b.box(0, y0, 0, w, h, d, PLASTER);
  sides(b, w, d, (width, zf, i) => frameFace(b, width, y0, h, zf, i % 2 ? ps : pf));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(sx * (w / 2 - 0.05), y0, sz * (d / 2 - 0.05), 0.26, h, 0.26, TIMBER);
  }
}

/** Triangular gable wall infill at both ridge ends (same w/d convention as gableRoof). */
function gableEnds(b: Builder, w: number, d: number, y0: number, h: number, alongX: boolean, col: RGB, framed: boolean): void {
  for (const s of [0, 1]) {
    b.place(0, 0, 0, (alongX ? HP : 0) + s * Math.PI, () => {
      const zf = d / 2;
      b.tri([-w / 2, y0, zf], [w / 2, y0, zf], [0, y0 + h, zf], col, [0, y0, 0]);
      if (framed) {
        b.box(0, y0, zf, 0.16, h - 0.3, 0.12, TIMBER);
        b.box(0, y0 + h * 0.42, zf, w * 0.58 - 0.2, 0.14, 0.12, TIMBER);
      }
    });
  }
}

/** Window on a +Z facing wall: frame, glowing pane, mullions, optional shutters. */
function windowAt(b: Builder, x: number, y: number, w: number, h: number, zf: number, shutter: RGB | null): void {
  const f = 0.09;
  b.quad([x - w / 2, y, zf + 0.09], [x + w / 2, y, zf + 0.09], [x + w / 2, y + h, zf + 0.09], [x - w / 2, y + h, zf + 0.09], GLASS, [x, y, zf - 1], 1);
  b.box(x, y - f, zf + 0.08, w + 0.3, f, 0.22, TIMBER_D);
  b.box(x, y + h, zf + 0.07, w + 0.2, f, 0.18, TIMBER_D);
  for (const s of [-1, 1]) b.box(x + s * (w / 2 + f / 2), y, zf + 0.07, f, h, 0.18, TIMBER_D);
  b.box(x, y, zf + 0.09, 0.05, h, 0.06, TIMBER_D);
  b.box(x, y + h / 2 - 0.025, zf + 0.09, w, 0.05, 0.06, TIMBER_D);
  if (shutter) for (const s of [-1, 1]) b.box(x + s * (w * 0.75 + f + 0.02), y, zf + 0.06, w / 2, h, 0.07, b.jit(shutter));
}

/** Plank door with frame, iron bands and handle on a +Z facing wall. */
function doorAt(b: Builder, x: number, y: number, w: number, h: number, zf: number, col: RGB = PLANK): void {
  const n = Math.max(3, Math.round(w / 0.35)), pw = w / n;
  for (let i = 0; i < n; i++) b.box(x - w / 2 + (i + 0.5) * pw, y, zf + 0.05, pw, h, 0.1, b.jit(col, 0.1));
  for (const s of [-1, 1]) b.box(x + s * (w / 2 + 0.08), y, zf + 0.07, 0.16, h + 0.1, 0.2, TIMBER_D);
  b.box(x, y + h, zf + 0.07, w + 0.44, 0.18, 0.22, TIMBER_D);
  for (const t of [0.22, 0.75]) b.box(x, y + h * t, zf + 0.11, w, 0.07, 0.03, IRON);
  b.box(x + w / 2 - 0.15, y + h * 0.45, zf + 0.13, 0.07, 0.16, 0.05, IRON);
}

function chimney(b: Builder, x: number, z: number, y0: number, y1: number, s = 0.75): void {
  b.box(x, y0, z, s, y1 - y0, s, b.jit(STONE));
  b.box(x, y1, z, s + 0.2, 0.16, s + 0.2, STONE_D);
  b.box(x, y1 + 0.16, z, s - 0.2, 0.2, s - 0.2, TIMBER_D);
}

function barrel(b: Builder, x: number, y: number, z: number, r = 0.36, h = 0.9): void {
  const c = b.jit(PLANK, 0.1);
  b.cyl(x, y, z, r * 0.82, r, h / 2, 8, c);
  b.cyl(x, y + h / 2, z, r, r * 0.82, h / 2, 8, c, { top: true });
  b.cyl(x, y + h * 0.46, z, r * 1.03, r * 1.03, h * 0.08, 8, IRON);
}

function crate(b: Builder, x: number, y: number, z: number, s = 0.6, top: RGB | null = null): void {
  b.box(x, y, z, s, s * 0.8, s, b.jit(PLANK_L, 0.12));
  if (top) b.box(x, y + s * 0.8, z, s * 0.82, 0.1, s * 0.82, b.jit(top, 0.1));
}

function sack(b: Builder, x: number, y: number, z: number): void {
  b.cyl(x, y, z, 0.3, 0.2, 0.55, 6, b.jit(CREAM, 0.1), { top: true });
}

/** Post-and-rail fence along a polyline of [x, z] points. */
function fence(b: Builder, pts: [number, number][], h = 1.0): void {
  const post = (x: number, z: number) => b.box(x, -0.6, z, 0.13, h + 0.7, 0.13, b.jit(TIMBER, 0.1));
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1.7);
    for (let k = 0; k < n; k++) post(x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n);
    for (const y of [0.45, 0.85]) b.beam([x0, y * h, z0], [x1, y * h, z1], 0.06, 0.1, b.jit(PLANK, 0.1));
  }
  const l = pts[pts.length - 1];
  post(l[0], l[1]);
}

/** Lantern: iron cage with glowing glass, top at (x, y, z). */
function lantern(b: Builder, x: number, y: number, z: number, s = 0.3): void {
  b.box(x, y - 0.08, z, s + 0.1, 0.08, s + 0.1, IRON);
  b.box(x, y - 0.08 - s * 1.2, z, s, s * 1.2, s, GLASS, 1);
  b.box(x, y - 0.14 - s * 1.2, z, s + 0.06, 0.06, s + 0.06, IRON);
}

interface CottageOpts {
  w: number; d: number; base: number; wallH: number; roofH: number;
  roof: RGB; thick: number; shutter: RGB | null; win: number[]; door?: number;
  chimney?: [number, number]; stoneRows?: number; courses?: number;
}

/** Generic timber-framed cottage, ridge along X, door in the +Z long wall. */
function cottage(b: Builder, o: CottageOpts): void {
  const top = o.base + o.wallH, wy = o.base + o.wallH * 0.44;
  base(b, o.w + 0.3, o.d + 0.3, o.base, o.stoneRows ?? 1);
  timberBody(b, o.w, o.d, o.base, o.wallH, Math.round(o.w / 1.6), Math.round(o.d / 1.6));
  gableEnds(b, o.d, o.w, top, o.roofH, true, PLASTER, true);
  b.gableRoof(0, top, 0, o.d, o.w, o.roofH, { col: o.roof, thick: o.thick, over: 0.55, overEnd: 0.45, alongX: true, courses: o.courses ?? 5 });
  sides(b, o.w, o.d, (width, zf, i) => {
    if (i === 0) {
      if (o.door !== undefined) {
        doorAt(b, o.door, o.base, 1.05, 1.95, zf);
        b.box(o.door, -0.4, zf + 0.55, 1.7, 0.4 + o.base * 0.6, 0.7, b.jit(STONE_L));
      }
      for (const x of o.win) windowAt(b, x, wy, 0.8, 0.9, zf, o.shutter);
    } else if (i === 2) {
      for (const s of [-1, 1]) windowAt(b, s * width / 4, wy, 0.8, 0.9, zf, o.shutter);
    } else {
      windowAt(b, 0, wy, 0.8, 0.9, zf, o.shutter);
    }
  });
  if (o.chimney) chimney(b, o.chimney[0], o.chimney[1], top, top + o.roofH + 0.7);
}

// ---------------------------------------------------------------- buildings
function hut(b: Builder): void {
  b.cyl(0, -1.5, 0, 2.4, 2.3, 1.8, 12, STONE, { top: true });
  b.cyl(0, 0.3, 0, 2.0, 2.0, 1.9, 12, DAUB);
  for (let i = 0; i < 12; i++) {           // wall posts at every facet edge
    const a = (i + 0.5) * Math.PI / 6;
    b.place(Math.sin(a) * 2.0, 0.3, Math.cos(a) * 2.0, a, () => b.box(0, 0, 0, 0.17, 1.9, 0.17, b.jit(TIMBER)));
  }
  b.cyl(0, 2.05, 0, 2.75, 1.4, 1.5, 12, tint(THATCH, 0.88), { bottom: true });   // two-tier thatch
  b.cyl(0, 3.2, 0, 1.9, 0, 1.7, 12, THATCH, { bottom: true });
  for (let i = 0; i < 3; i++) {            // crossed poles at the smoke hole
    const a = i * Math.PI * 2 / 3 + 0.4;
    b.beam([Math.sin(a) * 0.3, 4.5, Math.cos(a) * 0.3], [-Math.sin(a) * 0.35, 5.35, -Math.cos(a) * 0.35], 0.07, 0.07, TIMBER_D);
  }
  doorAt(b, 0, 0.3, 0.95, 1.65, 1.95);
  b.slope(0, 2.45, 1.7, 0.9, 2.3, 2.05, 0.14, tint(THATCH, 0.8));               // door hood
  b.box(0, -0.4, 2.5, 1.4, 0.55, 0.6, STONE_L);
  for (const a of [HP, -HP]) b.place(0, 0, 0, a, () => windowAt(b, 0, 1.1, 0.5, 0.5, 1.9, null));
  // fire pit, drying rack and pots
  b.cyl(2.9, -0.5, 2.2, 0.55, 0.5, 0.65, 8, STONE_D, { top: true });
  b.cyl(2.9, 0.15, 2.2, 0.3, 0, 0.3, 5, EMBER, { e: 1 });
  for (const s of [-1, 1]) b.box(-3.0, -0.5, 0.2 + s * 0.8, 0.09, 1.9, 0.09, TIMBER);
  b.beam([-3.0, 1.35, -0.7], [-3.0, 1.35, 1.1], 0.07, 0.07, TIMBER);
  b.sheet([-3.0, 1.3, -0.4], [-3.0, 1.3, 0.8], [-3.02, 0.55, 0.8], [-3.02, 0.55, -0.4], DAUB);
  b.cyl(-2.3, -0.3, 1.9, 0.22, 0.3, 0.75, 6, rgb(0x9a5a3a), { top: true });
}

function house(b: Builder): void {
  cottage(b, { w: 8, d: 6, base: 0.4, wallH: 2.5, roofH: 3.0, roof: THATCH, thick: 0.36, shutter: TEAL,
               win: [-2.5, 2.5], door: 0, chimney: [-2.4, -1.0], courses: 6 });
  barrel(b, 3.3, -0.3, 3.6);
  crate(b, 2.5, -0.3, 3.55, 0.6);
  b.box(-2.6, -0.3, 3.5, 1.5, 0.75, 0.12, PLANK);                                // bench
  b.box(-2.6, 0.45, 3.5, 1.6, 0.08, 0.45, PLANK_L);
  for (let i = 0; i < 4; i++) b.box(4.75, -0.4 + i * 0.26, -0.5, 0.8, 0.26, 2.2 - i * 0.2, b.jit(LOG_A, 0.15)); // woodpile
}

function longhouse(b: Builder): void {
  const w = 16, d = 6.6, y0 = 0.3, wh = 2.2, top = y0 + wh, rh = 4.0;
  base(b, w + 0.3, d + 0.3, y0);
  b.box(0, y0, 0, w, wh, d, TIMBER);
  sides(b, w, d, (width, zf, i) => {       // vertical stave walls
    const n = Math.round(width / 1.1);
    for (let k = 0; k <= n; k++) b.box(-width / 2 + k * width / n, y0, zf, 0.24, wh, 0.14, b.jit(LOG_A, 0.12));
    if (i === 0) for (const x of [-6, -3.3, 3.3, 6]) windowAt(b, x, 1.25, 0.7, 0.55, zf, null);
    if (i === 2) for (const x of [-5, 0, 5]) windowAt(b, x, 1.25, 0.7, 0.55, zf, null);
    if (i % 2 === 0) for (const x of [-6.9, -4.6, -2.2, 2.2, 4.6, 6.9]) {        // raking buttress posts
      b.beam([x, -0.6, zf + 1.15], [x, 2.0, zf + 0.1], 0.2, 0.2, TIMBER_D);
    }
  });
  gableEnds(b, d, w, top, rh, true, LOG_B, true);
  b.gableRoof(0, top, 0, d, w, rh, { col: THATCH, thick: 0.4, over: 0.5, overEnd: 0.6, alongX: true, courses: 7 });
  for (const sx of [-1, 1]) for (const sg of [-1, 1]) {                          // crossed gable finials
    const x = sx * (w / 2 + 0.62);
    b.beam([x, top + rh * 0.55 + 0.4, sg * d * 0.225], [x, top + rh * 1.22 + 0.4, -sg * d * 0.11], 0.12, 0.2, TIMBER_D);
  }
  // gabled porch over the door
  doorAt(b, 0, y0, 1.3, 1.9, d / 2);
  for (const s of [-1, 1]) b.box(s * 1.15, -0.6, d / 2 + 1.9, 0.24, 3.0, 0.24, TIMBER);
  b.box(0, 2.3, d / 2 + 1.9, 2.6, 0.2, 0.22, TIMBER);
  b.tri([-1.3, 2.4, d / 2 + 2.0], [1.3, 2.4, d / 2 + 2.0], [0, 3.6, d / 2 + 2.0], LOG_B, [0, 2.4, 0]);
  b.gableRoof(0, 2.4, d / 2 + 0.7, 2.6, 2.8, 1.2, { col: THATCH, thick: 0.3, over: 0.35, overEnd: 0.25, courses: 3 });
  b.box(0, -0.5, d / 2 + 1.1, 2.2, 0.75, 2.0, STONE_L);
  // smoke louvre on the ridge
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * 0.9, top + rh - 0.3, sz * 0.35, 0.12, 1.0, 0.12, TIMBER_D);
  b.gableRoof(0, top + rh + 0.65, 0, 1.3, 2.3, 0.5, { col: tint(THATCH, 0.9), thick: 0.2, over: 0.2, overEnd: 0.15, alongX: true, courses: 2 });
  barrel(b, 3.0, -0.3, d / 2 + 0.7);
  barrel(b, 3.8, -0.3, d / 2 + 0.75, 0.32, 0.8);
  for (let i = 0; i < 4; i++) b.box(-4.5, -0.4 + i * 0.26, d / 2 + 0.75, 2.4 - i * 0.25, 0.26, 0.8, b.jit(LOG_A, 0.15));
}

function farm(b: Builder): void {
  b.place(-4.2, 0, -2.4, 0, () => cottage(b, { w: 5, d: 4.4, base: 0.35, wallH: 2.3, roofH: 2.3, roof: THATCH, thick: 0.32,
                                             shutter: RED, win: [1.5], door: -0.8, chimney: [1.5, -0.7] }));
  // tilled plot with crop rows
  b.box(2.8, -1.5, 0, 7.8, 1.6, 9.4, SOIL);
  for (let i = 0; i < 6; i++) {
    const x = -0.2 + i * 1.2;
    b.box(x, 0.1, 0, 0.75, 0.13, 8.6, b.jit(SOIL_D, 0.1));
    for (let k = 0; k < 9; k++) {
      const z = -3.8 + k * 0.95 + (b.rnd() - 0.5) * 0.15;
      if (i < 3) b.cyl(x, 0.2, z, 0.3, 0, 0.35 + b.rnd() * 0.15, 5, b.jit(CROP, 0.15));
      else b.box(x, 0.2, z, 0.26, 0.8 + b.rnd() * 0.25, 0.8, b.jit(WHEAT, 0.12));
    }
  }
  fence(b, [[-1.3, 0.4], [-1.3, -4.9], [6.9, -4.9], [6.9, 4.9], [-1.3, 4.9], [-1.3, 2.2]]);
  // scarecrow
  b.box(2.8, 0, 0.2, 0.1, 2.0, 0.1, TIMBER);
  b.beam([2.0, 1.5, 0.2], [3.6, 1.5, 0.2], 0.08, 0.08, TIMBER);
  b.box(2.8, 0.95, 0.2, 0.5, 0.65, 0.2, RED);
  b.box(2.8, 1.75, 0.2, 0.3, 0.32, 0.3, CREAM);
  b.cyl(2.8, 2.05, 0.2, 0.42, 0, 0.35, 6, HAY, { bottom: true });
  // haystack, hay bales and trough in the yard
  b.cyl(-4.6, -1.5, 3.2, 1.25, 1.1, 2.7, 9, HAY);
  b.cyl(-4.6, 1.2, 3.2, 1.25, 0, 1.2, 9, tint(HAY, 0.92), { bottom: true });
  b.box(-2.3, -0.4, 4.3, 0.9, 0.95, 0.6, b.jit(HAY));
  b.box(-6.6, -0.4, 1.2, 0.7, 0.85, 1.8, PLANK);
  b.box(-6.6, 0.45, 1.2, 0.5, 0.03, 1.6, WATER);
}

function barn(b: Builder): void {
  const w = 9, d = 12, y0 = 0.5, wh = 3.6, top = y0 + wh, rh = 4.0;
  base(b, w + 0.3, d + 0.3, y0);
  b.box(0, y0, 0, w, wh, d, BARN);
  sides(b, w, d, (width, zf, i) => {       // board-and-batten walls
    const n = Math.round(width / 0.9);
    for (let k = 0; k <= n; k++) b.box(-width / 2 + k * width / n, y0, zf, 0.12, wh, 0.08, b.jit(tint(BARN, 0.8), 0.1));
    b.box(0, y0 + wh - 0.2, zf, width + 0.1, 0.2, 0.14, TIMBER_D);
    if (i % 2) for (const x of [-3.5, 3.5]) windowAt(b, x, 2.2, 0.8, 0.7, zf, null);
  });
  gableEnds(b, w, d, top, rh, false, BARN, false);
  b.gableRoof(0, top, 0, w, d, rh, { col: SHINGLE_W, thick: 0.2, over: 0.55, overEnd: 0.5, courses: 8 });
  for (const s of [0, 1]) b.place(0, 0, 0, s * Math.PI, () => {                  // gable trim boards
    b.box(0, top, d / 2, w, 0.22, 0.14, TIMBER_D);
    b.box(0, top + rh * 0.55, d / 2, w * 0.45 - 0.2, 0.18, 0.12, TIMBER_D);
  });
  // big double doors with cross braces
  const zf = d / 2;
  for (const s of [-1, 1]) {
    const x = s * 0.8;
    for (let i = 0; i < 4; i++) b.box(x - 0.6 + i * 0.4, y0, zf + 0.06, 0.4, 3.0, 0.12, b.jit(PLANK, 0.1));
    b.beam([x - 0.7, y0 + 0.15, zf + 0.14], [x + 0.7, y0 + 2.85, zf + 0.14], 0.05, 0.16, PLANK_L);
    b.beam([x + 0.7, y0 + 0.15, zf + 0.14], [x - 0.7, y0 + 2.85, zf + 0.14], 0.05, 0.16, PLANK_L);
    b.box(s * 1.72, y0, zf + 0.08, 0.22, 3.2, 0.2, TIMBER_D);
  }
  b.box(0, y0 + 3.0, zf + 0.08, 3.9, 0.24, 0.22, TIMBER_D);
  b.slope(0, zf + 1.1, 3.4, 2.0, y0, -0.3, 1.2, b.jit(SOIL));                    // earth ramp
  // hay loft door and hoist
  doorAt(b, 0, top + 0.7, 1.2, 1.3, zf, PLANK_L);
  b.beam([0, top + 2.9, zf - 0.5], [0, top + 2.9, zf + 1.5], 0.18, 0.18, TIMBER_D);
  b.beam([0, top + 2.85, zf + 1.3], [0, top + 2.0, zf + 1.3], 0.04, 0.04, ROPE);
  b.box(0, top + 1.85, zf + 1.3, 0.14, 0.18, 0.14, IRON);
  // lean-to hay shelter on the left
  b.slope(-6.0, -1.5, 3.4, 6.4, 2.5, 3.5, 0.16, SHINGLE_W, true);
  b.place(0, 0, 0, 0, () => {
    for (const z of [-4.5, -1.5, 1.5]) b.box(-7.4, -0.6, z, 0.2, 3.25, 0.2, TIMBER);
    b.beam([-7.4, 2.55, -4.6], [-7.4, 2.55, 1.6], 0.16, 0.16, TIMBER);
    for (let i = 0; i < 3; i++) b.box(-5.6 - (i % 2) * 0.9, -0.4, -3.6 + i * 1.5, 1.5, 1.1, 0.9, b.jit(HAY));
    b.box(-5.7, 0.7, -2.8, 1.5, 0.7, 0.9, b.jit(HAY));
  });
  b.box(3.2, -0.4, zf + 0.9, 1.4, 1.0, 0.8, b.jit(HAY));
  b.box(3.4, 0.6, zf + 0.9, 1.0, 0.6, 0.8, b.jit(HAY));
  barrel(b, -3.2, -0.3, zf + 0.7);
}

/** One market stall; counter faces local +Z. */
function stall(b: Builder, cloth: RGB, goods: RGB[]): void {
  for (const sx of [-1, 1]) {
    b.box(sx * 1.5, -0.3, -0.9, 0.13, 3.0, 0.13, TIMBER);
    b.box(sx * 1.5, -0.3, 1.1, 0.13, 2.45, 0.13, TIMBER);
  }
  for (let i = 0; i < 6; i++) {            // striped awning and valance
    const c = b.jit(i % 2 ? CREAM : cloth, 0.06), x = -1.5 + i * 0.6;
    b.slope(x, 0.15, 0.6, 2.7, 2.8, 2.15, 0.05, c);
    b.box(x, 1.85, 1.5, 0.6, i % 2 ? 0.26 : 0.34, 0.04, c);
  }
  b.box(0, 0.82, 0.55, 3.0, 0.1, 1.0, PLANK_L);                                 // counter
  b.box(0, -0.3, 1.0, 2.9, 1.12, 0.06, b.jit(cloth, 0.08));
  for (const sx of [-1, 1]) b.box(sx * 1.4, -0.3, 0.1, 0.1, 1.12, 0.1, TIMBER);
  b.box(0, -0.3, -0.75, 2.9, 1.5, 0.08, PLANK);                                 // back board + shelf
  b.box(0, 1.2, -0.6, 2.9, 0.07, 0.4, PLANK_L);
  goods.forEach((g, i) => crate(b, -1.0 + i * 1.0, 0.92, 0.55, 0.62, g));
  for (let i = 0; i < 3; i++) b.box(-0.9 + i * 0.9, 1.27, -0.6, 0.35, 0.3 + (i % 2) * 0.12, 0.25, b.jit(goods[i % goods.length], 0.15));
  sack(b, 1.95, -0.3, 0.8);
  barrel(b, -2.0, -0.3, 0.6, 0.32, 0.8);
}

function market(b: Builder): void {
  b.cyl(0, -1.5, 0, 7.6, 7.4, 1.62, 16, STONE_L, { top: true });                 // paved plaza
  b.cyl(0, 0.12, 0, 4.2, 4.2, 0.03, 16, tint(STONE, 0.95), { top: true });
  // central post with lantern and banners
  b.cyl(0, 0.12, 0, 0.9, 0.75, 0.5, 8, STONE, { top: true });
  b.box(0, 0.6, 0, 0.3, 4.6, 0.3, TIMBER);
  b.beam([-1.3, 4.6, 0], [1.3, 4.6, 0], 0.14, 0.14, TIMBER);
  b.beam([0, 4.6, -1.3], [0, 4.6, 1.3], 0.14, 0.14, TIMBER);
  b.pyramid(0, 5.2, 0, 0.7, 0.7, 0.5, SHINGLE);
  for (const [x, z] of [[1.15, 0], [-1.15, 0], [0, 1.15], [0, -1.15]]) lantern(b, x, 4.5, z, 0.24);
  b.sheet([0.2, 4.4, 0.16], [0.9, 4.4, 0.16], [0.9, 3.0, 0.16], [0.2, 3.0, 0.16], RED);
  b.sheet([-0.2, 4.4, -0.16], [-0.9, 4.4, -0.16], [-0.9, 3.0, -0.16], [-0.2, 3.0, -0.16], OCHRE);
  const cloths = [RED, OCHRE, TEAL, OLIVE];
  const goods: RGB[][] = [[rgb(0xb5442e), CROP, OCHRE], [CREAM, rgb(0x9a6a3a), HAY], [rgb(0x7f8c94), TEAL, CREAM], [CROP, rgb(0xb5442e), rgb(0x6a4a7a)]];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * HP;
    b.place(Math.sin(a) * 5.0, 0.12, Math.cos(a) * 5.0, a + Math.PI, () => stall(b, cloths[i], goods[i]));
  }
  for (const a of [0, HP, Math.PI, -HP]) {
    b.place(Math.sin(a) * 6.2, 0.12, Math.cos(a) * 6.2, a, () => { crate(b, -0.5, 0, 0, 0.7); crate(b, 0.3, 0, 0.1, 0.55, WHEAT); sack(b, 0.95, 0, -0.1); });
  }
}

function workshop(b: Builder): void {
  cottage(b, { w: 7, d: 6, base: 1.1, wallH: 2.1, roofH: 2.7, roof: SHINGLE, thick: 0.2, shutter: OCHRE,
               win: [-2.2, 2.2], door: 0, stoneRows: 2, courses: 6 });
  b.box(0, -0.4, 3.75, 2.0, 0.9, 1.3, STONE_L);                                  // raised doorstep
  b.box(0, -0.4, 4.6, 2.4, 0.5, 0.6, STONE);
  // big forge chimney on the right gable
  b.box(3.9, -1.5, -0.6, 1.5, 4.6, 1.7, b.jit(STONE));
  b.slope(4.05, -0.6, 1.2, 1.7, 3.9, 3.9, 0.9, STONE_D);
  chimney(b, 3.95, -0.6, 3.1, 6.9, 0.95);
  // hanging sign
  b.beam([1.2, 2.75, 3.1], [1.2, 2.75, 4.0], 0.08, 0.08, IRON);
  b.box(1.2, 2.0, 3.75, 0.06, 0.6, 0.7, PLANK_L);
  b.box(1.24, 2.15, 3.75, 0.03, 0.3, 0.4, RED);
  // open lean-to smithy on the left
  b.box(-5.4, -1.5, 0, 3.8, 1.62, 5.4, STONE_L);
  b.slope(-5.35, 0, 3.9, 5.8, 2.45, 3.25, 0.16, SHINGLE, true);
  for (const z of [-2.5, 2.5]) {
    b.box(-7.0, 0.1, z, 0.22, 2.3, 0.22, TIMBER);
    b.beam([-7.0, 1.7, z], [-6.2, 2.4, z], 0.1, 0.12, TIMBER);
  }
  b.beam([-7.0, 2.42, -2.7], [-7.0, 2.42, 2.7], 0.18, 0.18, TIMBER);
  b.box(-4.2, 0.12, -1.7, 1.3, 0.9, 1.3, b.jit(STONE));                          // hearth with embers
  b.box(-4.2, 1.02, -1.7, 0.9, 0.08, 0.9, EMBER, 1);
  b.cyl(-5.3, 0.12, 0.3, 0.32, 0.3, 0.55, 8, LOG_B, { top: true });              // anvil on a stump
  b.box(-5.3, 0.67, 0.3, 0.3, 0.14, 0.24, IRON);
  b.box(-5.3, 0.81, 0.3, 0.7, 0.16, 0.26, IRON);
  b.box(-5.6, 0.12, 2.0, 2.0, 0.85, 0.7, PLANK);                                 // workbench
  b.box(-5.6, 0.97, 2.0, 2.2, 0.08, 0.85, PLANK_L);
  b.box(-6.1, 1.05, 2.0, 0.5, 0.12, 0.25, IRON);
  barrel(b, -4.1, 0.12, 0.6, 0.4, 0.8);
  b.box(-4.1, 0.9, 0.6, 0.5, 0.02, 0.5, WATER);
  for (let i = 0; i < 4; i++) b.box(-2.0 + i * 0.1, -0.4 + i * 0.26, 3.6, 0.8, 0.26, 0.7, b.jit(LOG_A, 0.15));
}

function storehouse(b: Builder): void {
  const w = 9, d = 6.5, y0 = 0.5, lh = 0.42, n = 7, top = y0 + n * lh, rh = 2.7;
  base(b, w + 0.3, d + 0.3, y0);
  b.box(0, y0, 0, w - 0.3, n * lh, d - 0.3, TIMBER_D);
  for (let i = 0; i < n; i++) {            // interlocking log courses
    const y = y0 + i * lh, ex = i % 2 ? 0.9 : 0, ez = i % 2 ? 0 : 0.9;
    for (const s of [-1, 1]) {
      b.box(0, y, s * (d / 2 - 0.1), w + ex, lh, 0.42, b.jit(i % 2 ? LOG_A : LOG_B, 0.08));
      b.box(s * (w / 2 - 0.1), y, 0, 0.42, lh, d + ez, b.jit(i % 2 ? LOG_B : LOG_A, 0.08));
    }
  }
  gableEnds(b, d, w, top, rh, true, PLANK, true);
  b.gableRoof(0, top, 0, d, w, rh, { col: SHINGLE_W, thick: 0.2, over: 0.6, overEnd: 0.6, alongX: true, courses: 7 });
  const zf = d / 2 + 0.12;
  // loading deck, steps, double door and porch roof
  b.box(0, -0.6, zf + 1.0, 4.4, 1.1, 2.0, STONE);
  for (let i = 0; i < 8; i++) b.box(-1.93 + i * 0.55, 0.5, zf + 1.0, 0.53, 0.1, 2.1, b.jit(PLANK_L, 0.1));
  b.box(0, -0.6, zf + 2.3, 2.0, 0.9, 0.6, STONE_L);
  doorAt(b, -0.55, 0.6, 1.1, 2.0, zf);
  doorAt(b, 0.55, 0.6, 1.1, 2.0, zf);
  b.slope(0, zf + 1.05, 4.8, 2.5, 3.3, 2.65, 0.14, SHINGLE_W);
  for (const s of [-1, 1]) {
    b.box(s * 2.05, 0.6, zf + 1.9, 0.2, 2.1, 0.2, TIMBER);
    b.beam([s * 2.05, 2.1, zf + 1.9], [s * 1.45, 2.65, zf + 1.9], 0.1, 0.1, TIMBER);
    windowAt(b, s * 3.2, 2.0, 0.6, 0.5, zf, null);
  }
  b.beam([-2.2, 2.68, zf + 1.9], [2.2, 2.68, zf + 1.9], 0.18, 0.16, TIMBER);
  // stored goods
  barrel(b, 1.5, 0.6, zf + 0.6); barrel(b, 1.55, 0.6, zf + 1.4, 0.33, 0.8);
  sack(b, -1.5, 0.6, zf + 0.5); sack(b, -1.6, 0.6, zf + 1.15); sack(b, -1.0, 0.6, zf + 0.75);
  crate(b, 3.4, -0.3, zf + 0.6, 0.9); crate(b, 4.3, -0.3, zf + 0.7, 0.75); crate(b, 3.6, 0.42, zf + 0.6, 0.6);
  crate(b, -3.5, -0.3, zf + 0.6, 0.8, WHEAT); barrel(b, -4.4, -0.3, zf + 0.6);
}

function temple(b: Builder): void {
  // stepped stone platform
  b.box(0, -1.5, 0, 10.6, 1.8, 14.6, STONE);
  b.box(0, 0.3, 0, 9.8, 0.3, 13.8, STONE_L);
  b.box(0, 0.6, 0, 9.0, 0.3, 13.0, MARBLE);
  b.box(0, -1.5, 7.6, 4.4, 1.65, 1.0, STONE_L);
  // cella (inner sanctuary) with corner pilasters and door
  b.box(0, 0.9, -0.95, 5.6, 4.5, 7.9, b.jit(STONE_L));
  b.box(0, 0.9, -0.95, 5.8, 0.5, 8.1, STONE);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * 2.75, 0.9, -0.95 + sz * 3.9, 0.5, 4.5, 0.5, MARBLE);
  doorAt(b, 0, 0.9, 1.8, 3.0, 3.1, TIMBER);
  windowAt(b, 0, 4.25, 1.4, 0.5, 3.0, null);
  for (const s of [0, 1]) b.place(0, 0, -0.95, HP + s * Math.PI, () => { for (const x of [-2.2, 0, 2.2]) windowAt(b, x, 3.2, 0.45, 1.1, 2.8, null); });
  // peristyle columns
  const column = (x: number, z: number) => {
    b.box(x, 0.9, z, 0.95, 0.2, 0.95, MARBLE);
    b.cyl(x, 1.1, z, 0.4, 0.33, 4.0, 8, b.jit(MARBLE, 0.04));
    b.box(x, 5.1, z, 0.95, 0.22, 0.95, MARBLE);
  };
  for (const x of [-3.6, -1.2, 1.2, 3.6]) { column(x, 5.7); column(x, -5.7); }
  for (const z of [-3.42, -1.14, 1.14, 3.42]) { column(-3.6, z); column(3.6, z); }
  // entablature, pediments and copper roof
  b.box(0, 5.32, 0, 8.3, 0.6, 12.5, STONE_L);
  b.box(0, 5.92, 0, 8.7, 0.22, 12.9, MARBLE);
  gableEnds(b, 8.5, 12.7, 6.14, 2.2, false, STONE_L, false);
  b.gableRoof(0, 6.14, 0, 8.7, 12.9, 2.25, { col: COPPER, trim: GOLD, thick: 0.22, over: 0.3, overEnd: 0.25, courses: 6 });
  b.place(0, 0, 0, 0, () => {              // golden sun emblem and acroteria
    b.box(0, 6.6, 6.38, 0.75, 0.75, 0.1, GOLD);
    b.box(0, 6.84, 6.4, 2.4, 0.1, 0.08, GOLD);
    for (const z of [-6.6, 6.6]) b.cyl(0, 8.55, z, 0.28, 0, 0.9, 4, GOLD);
    for (const sx of [-1, 1]) for (const z of [-6.5, 6.5]) b.cyl(sx * 4.5, 6.2, z, 0.22, 0, 0.6, 4, GOLD);
  });
  // flanking braziers
  for (const s of [-1, 1]) {
    b.cyl(s * 3.3, -1.5, 7.9, 0.5, 0.4, 2.6, 6, STONE, { top: true });
    b.cyl(s * 3.3, 1.1, 7.9, 0.25, 0.55, 0.35, 6, IRON, { top: true });
    b.cyl(s * 3.3, 1.42, 7.9, 0.38, 0, 0.6, 5, EMBER, { e: 1 });
  }
}

function well(b: Builder): void {
  b.cyl(0, -1.5, 0, 2.1, 2.0, 1.58, 12, STONE_D, { top: true });                 // paved apron
  for (let i = 0; i < 12; i++) {           // ring of trapezoidal stone blocks
    const a0 = i * Math.PI / 6, a1 = a0 + Math.PI / 6, h = 0.85 + b.rnd() * 0.08;
    const p = (a: number, r: number, y: number): V3 => [Math.sin(a) * r, y, Math.cos(a) * r];
    b.hexa([p(a0, 0.72, 0.05), p(a1, 0.72, 0.05), p(a1, 1.15, 0.05), p(a0, 1.15, 0.05),
            p(a0, 0.72, h), p(a1, 0.72, h), p(a1, 1.15, h), p(a0, 1.15, h)], b.jit(STONE, 0.14));
  }
  b.cyl(0, 0.3, 0, 0.74, 0.74, 0.02, 12, WATER, { top: true });
  // posts, windlass, crank, roof
  for (const s of [-1, 1]) {
    b.box(s * 1.25, 0.05, 0, 0.2, 2.75, 0.2, TIMBER);
    b.beam([s * 1.25, 2.1, 0], [s * 0.75, 2.7, 0], 0.1, 0.1, TIMBER);
  }
  b.beam([-1.25, 1.75, 0], [1.25, 1.75, 0], 0.2, 0.2, PLANK);
  b.beam([1.25, 1.75, 0], [1.6, 1.75, 0], 0.07, 0.07, IRON);
  b.beam([1.6, 1.75, 0], [1.6, 1.45, 0.2], 0.07, 0.07, IRON);
  b.beam([1.6, 1.45, 0.2], [1.85, 1.45, 0.2], 0.07, 0.07, TIMBER_D);
  b.box(0, 2.7, 0, 2.8, 0.14, 0.16, TIMBER);
  b.gableRoof(0, 2.8, 0, 2.0, 2.9, 0.85, { col: SHINGLE_W, thick: 0.14, over: 0.3, overEnd: 0.25, alongX: true, courses: 4 });
  // rope and bucket
  b.beam([0.15, 1.7, 0], [0.15, 1.2, 0], 0.035, 0.035, ROPE);
  b.cyl(0.15, 0.82, 0, 0.17, 0.22, 0.38, 8, PLANK_L, { bottom: true });
  b.cyl(0.15, 1.12, 0, 0.19, 0.19, 0.02, 8, WATER, { top: true });
  b.cyl(-1.55, 0.08, 1.0, 0.18, 0.23, 0.4, 8, PLANK, { top: true });             // spare bucket
  b.box(0, 0.08, 1.55, 1.0, 0.16, 0.6, STONE_L);                                 // step
}

function windmill(b: Builder): void {
  const rAt = (y: number) => 2.9 - (y - 2.2) * 0.15;
  b.cyl(0, -1.5, 0, 3.45, 3.15, 3.7, 8, STONE);                                  // stone base
  b.cyl(0, 2.2, 0, 3.25, 3.0, 0.25, 8, STONE_L, { top: true });
  b.cyl(0, 2.45, 0, rAt(2.45), rAt(8.2), 5.75, 8, PLASTER);                      // tapered tower
  for (let i = 0; i < 8; i++) {
    const a = (i + 0.5) * Math.PI / 4, s = Math.sin(a), c = Math.cos(a);
    b.beam([s * rAt(2.45), 2.45, c * rAt(2.45)], [s * rAt(8.2), 8.2, c * rAt(8.2)], 0.22, 0.22, TIMBER);
  }
  for (const y of [5.0, 7.95]) b.cyl(0, y, 0, rAt(y) + 0.05, rAt(y + 0.22) + 0.05, 0.22, 8, TIMBER);
  b.cyl(0, 8.2, 0, 2.55, 2.45, 0.3, 8, TIMBER_D, { bottom: true });              // cap
  b.cyl(0, 8.5, 0, 2.6, 0, 2.1, 8, SHINGLE, { bottom: true });
  b.box(0, 10.5, 0, 0.1, 0.7, 0.1, IRON);
  // door porch
  b.box(0, -1.5, 3.05, 1.9, 3.8, 0.9, b.jit(STONE_L));
  doorAt(b, 0, 0.15, 1.0, 1.9, 3.5);
  b.gableRoof(0, 2.3, 3.0, 2.0, 1.1, 0.7, { col: SHINGLE, thick: 0.14, over: 0.25, overEnd: 0.2, courses: 2 });
  b.box(0, -0.5, 4.0, 1.6, 0.6, 0.6, STONE);
  for (const [a, y] of [[HP, 3.4], [-HP, 3.4], [Math.PI, 5.9], [HP * 0.5, 6.0], [-HP * 0.5, 3.6]]) {
    const ap = rAt(y) * Math.cos(Math.PI / 8) - 0.05;
    b.place(Math.sin(a) * ap, 0, Math.cos(a) * ap, a, () => windowAt(b, 0, y, 0.6, 0.8, 0, null));
  }
  // axle, hub and four lattice sails
  const hy = 7.2, hz = 3.0, L = 4.7;
  b.beam([0, hy, 1.4], [0, hy, hz + 0.25], 0.3, 0.3, TIMBER_D);
  b.box(0, hy - 0.3, hz, 0.6, 0.6, 0.3, TIMBER);
  for (let k = 0; k < 4; k++) {
    const ang = 0.38 + k * HP, rx = Math.sin(ang), ry = Math.cos(ang), px = Math.cos(ang), py = -Math.sin(ang);
    const P = (s: number, t: number, z = hz): V3 => [rx * s + px * t, hy + ry * s + py * t, z];
    b.beam(P(0.2, 0), P(L, 0), 0.12, 0.16, TIMBER);
    b.beam(P(1.0, 1.15), P(L, 1.15), 0.07, 0.08, PLANK);
    for (let i = 0; i <= 5; i++) { const s = 1.0 + i * (L - 1.0) / 5; b.beam(P(s, 0), P(s, 1.15), 0.07, 0.07, PLANK); }
    b.sheet(P(1.05, 0.1, hz - 0.05), P(L - 0.05, 0.1, hz - 0.05), P(L - 0.05, 1.1, hz - 0.05), P(1.05, 1.1, hz - 0.05), CREAM);
  }
  // flour sacks and a millstone slab
  sack(b, 1.6, -0.3, 3.7); sack(b, 2.1, -0.3, 3.3); sack(b, 1.9, 0.15, 3.5);
  b.cyl(-2.0, -0.3, 3.9, 0.6, 0.6, 0.55, 10, STONE_L, { top: true });
  b.cyl(-2.0, 0.25, 3.9, 0.12, 0.12, 0.02, 6, IRON, { top: true });
}

function watchtower(b: Builder): void {
  const R2 = Math.SQRT2, half = (y: number) => 2.3 - (y + 1.5) * 0.4 / 6;       // tapered stone base
  b.cyl(0, -1.5, 0, 2.3 * R2, 1.9 * R2, 6, 4, STONE);
  stoneCourse(b, 4.5, 4.5, 0, 0.5);
  b.cyl(0, 4.3, 0, 2.05 * R2, 2.05 * R2, 0.3, 4, STONE_L, { top: true });
  for (const y of [1.6, 2.9]) b.cyl(0, y, 0, (half(y) + 0.03) * R2, (half(y + 0.12) + 0.03) * R2, 0.12, 4, STONE_D);
  b.box(0, -1.5, 2.0, 1.7, 4.1, 0.7, b.jit(STONE_L));                            // door surround
  doorAt(b, 0, 0.2, 1.0, 1.95, 2.35);
  b.box(0, -0.5, 2.9, 1.5, 0.7, 0.6, STONE_L);
  sides(b, 0, 0, (_w, _zf, i) => {         // arrow slits, one lit window per side
    if (i > 0) b.box(0, 1.9, half(2.2), 0.16, 0.8, 0.1, TIMBER_D);
    windowAt(b, 0, 3.2, 0.5, 0.7, half(3.2) - 0.04, null);
  });
  // timber stage with cross bracing
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(sx * 1.7, 4.6, sz * 1.7, 0.28, 4.4, 0.28, TIMBER);
    b.beam([sx * 1.75, 5.6, sz * 1.75], [sx * 2.5, 6.85, sz * 2.5], 0.14, 0.14, TIMBER_D);
    b.box(sx * 2.6, 6.9, sz * 2.6, 0.18, 1.35, 0.18, TIMBER);
  }
  sides(b, 3.4, 3.4, (_w, zf, i) => {
    b.beam([-1.6, 4.7, zf], [1.6, 6.8, zf], 0.1, 0.14, TIMBER_D);
    b.beam([1.6, 4.7, zf], [-1.6, 6.8, zf], 0.1, 0.14, TIMBER_D);
    b.box(0, 8.75, zf, 3.6, 0.2, 0.2, TIMBER);
    // platform joists, parapet planks and rail
    for (const x of [-1.7, 0, 1.7]) if (i % 2 === 0) b.beam([x, 6.8, 0], [x, 6.8, 2.75], 0.16, 0.18, TIMBER_D);
    for (let k = 0; k < 9; k++) b.box(-2.4 + k * 0.6, 7.1, 2.62, 0.56, 0.75 + (k % 2) * 0.12, 0.07, b.jit(PLANK, 0.12));
    b.box(0, 8.1, 2.62, 5.4, 0.12, 0.16, TIMBER);
  });
  b.box(0, 6.9, 0, 5.4, 0.2, 5.4, PLANK);
  for (const s of [-1, 1]) b.beam([s * 0.3, 4.6, -1.3], [s * 0.3, 6.9, -0.9], 0.07, 0.07, PLANK_L);   // ladder
  for (let i = 0; i < 6; i++) b.beam([-0.3, 4.9 + i * 0.36, -1.25 + i * 0.062], [0.3, 4.9 + i * 0.36, -1.25 + i * 0.062], 0.05, 0.05, PLANK_L);
  // roof, flag and lantern
  b.pyramid(0, 8.95, 0, 6.2, 6.2, 1.9, SHINGLE);
  b.pyramid(0, 9.05, 0, 4.2, 4.2, 1.95, tint(SHINGLE, 1.12));
  b.box(0, 10.8, 0, 0.08, 1.3, 0.08, TIMBER_D);
  b.sheet([0.04, 12.05, 0], [0.9, 11.85, 0], [0.9, 11.5, 0], [0.04, 11.55, 0], RED);
  b.beam([1.7, 8.6, 1.8], [1.7, 8.6, 3.1], 0.08, 0.08, IRON);
  lantern(b, 1.7, 8.5, 3.0, 0.28);
}

function dock(b: Builder): void {
  // quay with a small shed
  b.box(0, -1.5, -3.3, 7.4, 1.5, 6.8, STONE_D);
  b.box(0, 0, -3.3, 7.6, 0.3, 7.0, STONE_L);
  b.place(-0.6, 0.3, -3.9, 0, () => cottage(b, { w: 4.6, d: 3.4, base: 0.3, wallH: 2.2, roofH: 1.8, roof: SHINGLE_W, thick: 0.18,
                                                shutter: TEAL, win: [-1.4], door: 0.7, courses: 5 }));
  // pier: stringers, planks and piles, widening to a T at the end
  const deck = 0.62, z0 = -0.2, zEnd = 13.2;
  for (const x of [-1.3, 1.3]) b.box(x, deck - 0.34, (z0 + zEnd) / 2, 0.2, 0.22, zEnd - z0, TIMBER_D);
  for (let i = 0; i < 20; i++) {
    const z = z0 + 0.335 + i * 0.67, wide = z > 10.9;
    b.box((b.rnd() - 0.5) * 0.12, deck - 0.12, z, wide ? 6.4 : 3.4, 0.12, 0.63, b.jit(PLANK, 0.13));
  }
  for (const z of [11.0, 13.1]) b.box(0, deck - 0.34, z, 6.2, 0.22, 0.2, TIMBER_D);
  const pile = (x: number, z: number, top: number) => b.cyl(x, -3.5, z, 0.2, 0.17, 3.5 + top, 6, b.jit(TIMBER, 0.12), { top: true });
  for (const z of [1.2, 4.4, 7.6]) for (const s of [-1, 1]) pile(s * 1.6, z, z === 4.4 ? 1.35 : 0.5);
  for (const z of [11.0, 13.1]) for (const x of [-3.05, -1.0, 1.0, 3.05]) pile(x, z, Math.abs(x) > 2 ? 1.4 : 0.5);
  b.beam([-3.05, 1.5, 13.1], [3.05, 1.5, 13.1], 0.08, 0.1, PLANK);               // end rail
  // lantern post, cargo, rope coil
  b.box(2.9, deck, 11.3, 0.16, 2.6, 0.16, TIMBER);
  b.beam([2.9, 3.1, 11.3], [2.1, 3.1, 11.3], 0.08, 0.08, TIMBER);
  b.beam([2.9, 2.6, 11.3], [2.5, 3.05, 11.3], 0.06, 0.06, TIMBER);
  lantern(b, 2.2, 3.05, 11.3, 0.26);
  crate(b, -2.3, deck, 12.2, 0.8); crate(b, -1.5, deck, 12.4, 0.6, rgb(0x8fa0a8)); crate(b, -2.2, deck + 0.64, 12.2, 0.5);
  barrel(b, 1.1, deck, 3.0); barrel(b, 1.15, deck, 3.8, 0.32, 0.8);
  b.cyl(-1.0, deck, 8.6, 0.42, 0.42, 0.14, 8, ROPE, { top: true });
  barrel(b, 2.6, 0.3, -1.2); crate(b, 2.7, 0.3, -2.3, 0.8);
  // fishing net drying rack on the quay
  for (const z of [-5.6, -3.2]) b.box(2.9, 0.3, z, 0.1, 1.9, 0.1, TIMBER);
  b.beam([2.9, 2.15, -5.7], [2.9, 2.15, -3.1], 0.07, 0.07, TIMBER);
  b.sheet([2.9, 2.1, -5.5], [2.9, 2.1, -3.3], [3.0, 0.9, -3.5], [3.0, 0.9, -5.3], rgb(0x8c8f7a));
  // moored rowboat (assumes water level slightly below y = 0)
  b.place(-2.9, 0, 6.0, 0.08, () => {
    const top: V3[] = [[-0.6, 0.3, -1.5], [0.6, 0.3, -1.5], [0.8, 0.3, 0.3], [0, 0.42, 2.0], [-0.8, 0.3, 0.3]];
    const bot = top.map(([x, , z]) => [x * 0.55, -0.9, z * 0.8] as V3);
    const c: V3 = [0, -0.3, 0];
    for (let i = 0; i < 5; i++) {
      const j = (i + 1) % 5;
      b.quad(bot[i], bot[j], top[j], top[i], b.jit(PLANK, 0.1), c);
      b.beam(top[i], top[j], 0.1, 0.1, TIMBER_D);
    }
    for (let i = 1; i < 4; i++) { b.tri(top[0], top[i], top[i + 1], SOIL_D, c); b.tri(bot[0], bot[i], bot[i + 1], TIMBER_D, c); }
    for (const z of [-0.8, 0.4]) b.box(0, 0.24, z, 1.4, 0.07, 0.3, PLANK_L);
    b.beam([0.5, 0.36, -1.2], [0.75, 0.4, 1.3], 0.06, 0.05, PLANK_L);            // oar
  });
  b.beam([-1.6, 1.0, 4.4], [-2.6, 0.38, 6.9], 0.04, 0.04, ROPE);
}

// ---------------------------------------------------------------- public API
const GENERATORS: Record<BuildingKind, (b: Builder) => void> = {
  hut, house, longhouse, farm, barn, market, workshop, storehouse, temple, well, windmill, watchtower, dock,
};

/** Build every building model. Deterministic: same output on every call. */
export function buildBuildingModels(): Record<BuildingKind, BuildingModel> {
  const out = {} as Record<BuildingKind, BuildingModel>;
  BUILDING_KINDS.forEach((kind, i) => {
    const b = new Builder(1337 + i * 7919);
    GENERATORS[kind](b);
    out[kind] = b.build();
  });
  return out;
}
