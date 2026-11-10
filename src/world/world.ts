import { Simplex3 } from '../core/noise';
import { hashString } from '../core/rng';
import { clamp, smoothstep } from '../core/math';
import { BIOME_NAMES, RESOURCE_KINDS, RESOURCE_NAMES, Water, type Landmass, type ResourceKind, type WorldData } from './types';

export interface CellInfo {
  index: number;
  x: number;
  y: number;
  latitude: number; // degrees
  longitude: number; // degrees
  elevation: number;
  temperature: number;
  moisture: number;
  fertility: number; // 0..1
  biodiversity: number; // 0..1
  forest: number; // 0..1
  biome: number;
  biomeName: string;
  climate: string;
  water: Water;
  landmass: Landmass | null;
  mineral: { kind: ResourceKind; name: string; richness: number } | null;
  constraints: string[];
}

/**
 * Read-only query API over WorldData shared by rendering and simulation:
 * continuous terrain height, cell lookup and human-readable descriptions.
 */
export class World {
  readonly W: number;
  readonly H: number;
  readonly R: number;
  /** Size of a grid cell at the equator in metres. */
  readonly cellSize: number;
  private detail: Simplex3;
  private landmassById = new Map<number, Landmass>();

  constructor(readonly data: WorldData) {
    this.W = data.width;
    this.H = data.height;
    this.R = data.radius;
    this.cellSize = (2 * Math.PI * this.R) / this.W;
    this.detail = new Simplex3(hashString(data.seed) ^ 0x9e37);
    for (const l of data.landmasses) this.landmassById.set(l.id, l);
  }

  /** Grid cell index under a unit direction. */
  cellAt(dx: number, dy: number, dz: number): number {
    const u = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
    const v = 0.5 - Math.asin(clamp(dy, -1, 1)) / Math.PI;
    const x = Math.min(this.W - 1, Math.floor(u * this.W));
    const y = Math.min(this.H - 1, Math.floor(v * this.H));
    return y * this.W + x;
  }

  /** Unit direction of the centre of a cell (fractional coordinates allowed). */
  cellDir(x: number, y: number, out: { x: number; y: number; z: number }): void {
    const lon = ((x + 0.5) / this.W) * 2 * Math.PI - Math.PI;
    const lat = Math.PI / 2 - ((y + 0.5) / this.H) * Math.PI;
    const cl = Math.cos(lat);
    out.x = cl * Math.cos(lon);
    out.y = Math.sin(lat);
    out.z = cl * Math.sin(lon);
  }

  /** Smooth (bicubic) elevation of the base grid, without micro detail. */
  baseElevation(dx: number, dy: number, dz: number): number {
    const W = this.W, H = this.H, e = this.data.elevation;
    const fx = (Math.atan2(dz, dx) / (2 * Math.PI) + 0.5) * W - 0.5;
    const fy = (0.5 - Math.asin(clamp(dy, -1, 1)) / Math.PI) * H - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    // Catmull-Rom weights
    const wx0 = ((-tx + 2) * tx - 1) * tx * 0.5, wx1 = ((3 * tx - 5) * tx * tx + 2) * 0.5;
    const wx2 = ((-3 * tx + 4) * tx + 1) * tx * 0.5, wx3 = (tx - 1) * tx * tx * 0.5;
    const wy0 = ((-ty + 2) * ty - 1) * ty * 0.5, wy1 = ((3 * ty - 5) * ty * ty + 2) * 0.5;
    const wy2 = ((-3 * ty + 4) * ty + 1) * ty * 0.5, wy3 = (ty - 1) * ty * ty * 0.5;
    const x0 = (ix - 1 + W) % W, x1 = (ix + W) % W, x2 = (ix + 1) % W, x3 = (ix + 2) % W;
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const yy = clamp(iy - 1 + j, 0, H - 1) * W;
      const row = e[yy + x0] * wx0 + e[yy + x1] * wx1 + e[yy + x2] * wx2 + e[yy + x3] * wx3;
      sum += row * (j === 0 ? wy0 : j === 1 ? wy1 : j === 2 ? wy2 : wy3);
    }
    return sum;
  }

  /** Final terrain elevation (m above sea level) including procedural micro relief. */
  elevationAt(dx: number, dy: number, dz: number): number {
    const h = this.baseElevation(dx, dy, dz);
    if (h < 0.4) return h;
    const cell = this.cellAt(dx, dy, dz);
    const dry = 1 - this.data.waterMask[cell] / 255;
    if (dry <= 0) return h;
    const amp = (0.25 + 2.4 * smoothstep(35, 220, h)) * smoothstep(0.4, 3, h) * dry;
    const f = this.R / 34;
    const n = this.detail.fbm(dx * f, dy * f, dz * f, 3);
    return h + n * amp;
  }

  /** Radius of the visible surface (terrain or sea) along a direction. */
  surfaceRadius(dx: number, dy: number, dz: number): number {
    return this.R + Math.max(0, this.elevationAt(dx, dy, dz));
  }

  /**
   * Intersects a ray with the visible surface (terrain or sea).
   * Returns the distance along the ray, or -1 when the ray misses the planet.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const top = this.R + 500;
    const b = ox * dx + oy * dy + oz * dz;
    const c = ox * ox + oy * oy + oz * oz - top * top;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    let t = Math.max(0, -b - sq);
    const tEnd = -b + sq;
    let prevT = t;
    for (let i = 0; i < 600 && t <= tEnd; i++) {
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      const len = Math.sqrt(px * px + py * py + pz * pz);
      const gap = len - this.surfaceRadius(px / len, py / len, pz / len);
      if (gap <= 0) {
        // refine by bisection between the last point above ground and this one
        let lo = prevT, hi = t;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
          const ml = Math.sqrt(mx * mx + my * my + mz * mz);
          if (ml - this.surfaceRadius(mx / ml, my / ml, mz / ml) > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }
      prevT = t;
      t += Math.max(0.4, gap * 0.45);
    }
    return -1;
  }

  /** Terrain slope (rise/run) at a cell. */
  slopeAt(index: number): number {
    const W = this.W, H = this.H, e = this.data.elevation;
    const x = index % W, y = (index / W) | 0;
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    const dxm = this.cellSize * Math.max(0.02, Math.cos(lat));
    const sx = (e[y * W + ((x + 1) % W)] - e[y * W + ((x + W - 1) % W)]) / (2 * dxm);
    const sy = (e[Math.max(0, y - 1) * W + x] - e[Math.min(H - 1, y + 1) * W + x]) / (2 * this.cellSize);
    return Math.hypot(sx, sy);
  }

  /**
   * Temperature at a cell for a seasonal phase in [-1, 1] (+1 = northern
   * summer solstice). Mirrors the formula used by the terrain shader.
   */
  seasonalTemperature(index: number, phase: number): number {
    const y = (index / this.W) | 0;
    const lat = Math.PI / 2 - ((y + 0.5) / this.H) * Math.PI;
    return this.data.temperature[index] + phase * clamp(Math.sin(lat) * 1.6, -1, 1) * 11;
  }

  describe(index: number): CellInfo {
    const d = this.data;
    const x = index % this.W, y = (index / this.W) | 0;
    const t = d.temperature[index], m = d.moisture[index], h = d.elevation[index];
    const slope = this.slopeAt(index);
    const water = d.water[index] as Water;
    let climate: string;
    if (water === Water.Ocean) climate = t < -8 ? 'Océanique polaire' : t > 20 ? 'Océanique tropical' : 'Océanique';
    else if (h > 170) climate = 'Montagnard';
    else if (t < -6) climate = 'Polaire';
    else if (t < 5) climate = m > 0.45 ? 'Subarctique' : 'Froid et sec';
    else if (t < 19) climate = m < 0.27 ? 'Aride tempéré' : m > 0.62 ? 'Tempéré humide' : 'Tempéré';
    else climate = m < 0.33 ? 'Aride chaud' : m > 0.68 ? 'Tropical humide' : 'Tropical sec';

    const constraints: string[] = [];
    if (water === Water.Land) {
      if (slope > 0.5) constraints.push('Relief escarpé');
      if (t < -3) constraints.push('Froid extrême');
      if (t > 30) constraints.push('Chaleur accablante');
      if (m < 0.25) constraints.push('Manque d’eau');
      if (d.volcanic[index] > 110) constraints.push('Activité volcanique');
      if (h > 200) constraints.push('Haute altitude');
      if (d.fertility[index] < 50 && constraints.length === 0) constraints.push('Sols pauvres');
    }
    const mv = d.mineral[index];
    const kind = mv >> 4 ? RESOURCE_KINDS[(mv >> 4) - 1] : null;
    return {
      index, x, y,
      latitude: 90 - ((y + 0.5) / this.H) * 180,
      longitude: ((x + 0.5) / this.W) * 360 - 180,
      elevation: h,
      temperature: t,
      moisture: m,
      fertility: d.fertility[index] / 255,
      biodiversity: d.biodiversity[index] / 255,
      forest: d.forest[index] / 255,
      biome: d.biome[index],
      biomeName: BIOME_NAMES[d.biome[index]],
      climate,
      water,
      landmass: this.landmassById.get(d.landmassId[index]) ?? null,
      mineral: kind ? { kind, name: RESOURCE_NAMES[kind], richness: (mv & 15) / 15 } : null,
      constraints,
    };
  }
}
