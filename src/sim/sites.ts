import { Water } from '../world/types';
import type { World } from '../world/world';
import type { Building, Settlement } from './settlements';
import type { SimSite, SiteBuilding } from './types';

export const SITE_CELL = 3; // metres
export const SITE_SIZE = 150; // cells -> 450 m across

const DWELLING_CAPACITY: Record<string, number> = { house: 5, hut: 3, longhouse: 8, farm: 5 };
export const dwellingCapacity = (kind: string): number => DWELLING_CAPACITY[kind] ?? 0;

/**
 * Builds the simulation's local map of a settlement from the real terrain:
 * where people can walk (dry, gentle ground, outside buildings), how rich the
 * land is for foraging, and where fresh water can be found.
 */
export function buildSimSite(world: World, settlement: Settlement, buildings: Building[]): SimSite {
  const c = settlement.dir;
  const R = world.R;
  let east = { x: c.y * 0 - c.z * 1, y: c.z * 0 - c.x * 0, z: c.x * 1 - c.y * 0 };
  const el = Math.hypot(east.x, east.y, east.z) || 1;
  east = { x: east.x / el, y: east.y / el, z: east.z / el };
  const north = { x: east.y * c.z - east.z * c.y, y: east.z * c.x - east.x * c.z, z: east.x * c.y - east.y * c.x };
  const size = SITE_SIZE, cell = SITE_CELL, half = (size * cell) / 2;
  const walk = new Uint8Array(size * size);
  const forage = new Uint8Array(size * size);
  const fresh: { e: number; n: number; d: number }[] = [];
  const d = world.data;

  const dirAt = (e: number, n: number) => {
    const x = c.x + (east.x * e + north.x * n) / R, y = c.y + (east.y * e + north.y * n) / R, z = c.z + (east.z * e + north.z * n) / R;
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  };

  const kindAt = new Uint8Array(size * size); // 0 land, 1 fresh water, 2 sea
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const e = (i + 0.5) * cell - half, n = (j + 0.5) * cell - half;
      const p = dirAt(e, n);
      const w = world.cellAt(p.x, p.y, p.z);
      const k = j * size + i;
      const water = d.water[w];
      if (water === Water.Ocean) { kindAt[k] = 2; continue; }
      if (water !== Water.Land || d.waterMask[w] > 90) { kindAt[k] = 1; continue; }
      if (world.baseElevation(p.x, p.y, p.z) < 0.5 || world.slopeAt(w) > 0.7) continue;
      walk[k] = 1;
      forage[k] = Math.max(d.fertility[w] * 0.8, d.forest[w] * 0.9, d.biodiversity[w] * 0.6);
    }
  }
  // Fresh water access points: walkable cells next to a river or lake; fishing shores enrich foraging.
  for (let j = 1; j < size - 1; j++) {
    for (let i = 1; i < size - 1; i++) {
      const k = j * size + i;
      if (!walk[k]) continue;
      let nearFresh = false, nearSea = false;
      for (const o of [k - 1, k + 1, k - size, k + size]) {
        if (kindAt[o] === 1) nearFresh = true;
        if (kindAt[o] === 2) nearSea = true;
      }
      if (nearFresh || nearSea) forage[k] = Math.min(255, forage[k] + 70);
      if (nearFresh) {
        const e = (i + 0.5) * cell - half, n = (j + 0.5) * cell - half;
        fresh.push({ e, n, d: Math.hypot(e, n) });
      }
    }
  }

  const sb: SiteBuilding[] = [];
  for (const b of buildings) {
    if (b.settlement !== settlement.id) continue;
    const rx = b.dir.x - c.x, ry = b.dir.y - c.y, rz = b.dir.z - c.z;
    const e = (rx * east.x + ry * east.y + rz * east.z) * R, n = (rx * north.x + ry * north.y + rz * north.z) * R;
    const fe = b.facing.x * east.x + b.facing.y * east.y + b.facing.z * east.z;
    const fn = b.facing.x * north.x + b.facing.y * north.y + b.facing.z * north.z;
    const reach = b.radius * 0.72 + 1.2;
    sb.push({ id: b.id, kind: b.kind, e, n, radius: b.radius, doorE: e + fe * reach, doorN: n + fn * reach });
  }
  // Building footprints are not walkable (doors stay reachable just outside).
  for (const b of sb) {
    if (b.kind === 'dock' || b.kind === 'market' || b.kind === 'farm') continue;
    const r = b.radius * 0.62;
    const i0 = Math.floor((b.e - r + half) / cell), i1 = Math.floor((b.e + r + half) / cell);
    const j0 = Math.floor((b.n - r + half) / cell), j1 = Math.floor((b.n + r + half) / cell);
    for (let j = Math.max(0, j0); j <= Math.min(size - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(size - 1, i1); i++) {
        const e = (i + 0.5) * cell - half, n = (j + 0.5) * cell - half;
        if (Math.hypot(e - b.e, n - b.n) < r) walk[j * size + i] = 0;
      }
    }
  }

  const water: { e: number; n: number }[] = [];
  const well = sb.find((b) => b.kind === 'well');
  if (well) water.push({ e: well.doorE, n: well.doorN });
  fresh.sort((a, b) => a.d - b.d);
  // keep a few well-spread natural water points
  for (const f of fresh) {
    if (water.length >= 6) break;
    if (water.every((w) => Math.hypot(w.e - f.e, w.n - f.n) > 40)) water.push({ e: f.e, n: f.n });
  }
  const market = sb.find((b) => b.kind === 'market');
  const plaza = market ? { e: market.doorE, n: market.doorN } : well ? { e: well.doorE + 3, n: well.doorN + 3 } : { e: 0, n: 0 };
  const cw = world.cellAt(c.x, c.y, c.z);
  return {
    id: settlement.id, name: settlement.name, longitude: Math.atan2(c.z, c.x), temperature: d.temperature[cw], sinLatitude: c.y,
    size, cell, walk, forage, buildings: sb, water, plaza, radius: settlement.radius,
  };
}

/** Unit direction on the planet of a local (east, north) position of a settlement. */
export function siteFrame(settlement: Settlement): { toDir: (e: number, n: number, R: number, out: { x: number; y: number; z: number }) => void } {
  const c = settlement.dir;
  let ex = -c.z, ey = 0, ez = c.x;
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el; ey /= el; ez /= el;
  const nx = ey * c.z - ez * c.y, ny = ez * c.x - ex * c.z, nz = ex * c.y - ey * c.x;
  return {
    toDir(e, n, R, out) {
      const x = c.x + (ex * e + nx * n) / R, y = c.y + (ey * e + ny * n) / R, z = c.z + (ez * e + nz * n) / R;
      const l = Math.hypot(x, y, z);
      out.x = x / l; out.y = y / l; out.z = z / l;
    },
  };
}
