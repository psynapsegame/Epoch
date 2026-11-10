import { Water } from '../world/types';
import type { World } from '../world/world';
import type { Building, Settlement } from './settlements';
import type { FoundingBuilding, SimSite, SiteNeighbor } from './types';

export const SITE_CELL = 3; // metres
export const SITE_SIZE = 150; // cells -> 450 m across

const DWELLING_CAPACITY: Record<string, number> = { house: 5, hut: 3, longhouse: 8, farm: 5 };
export const dwellingCapacity = (kind: string): number => DWELLING_CAPACITY[kind] ?? 0;

interface Frame {
  c: { x: number; y: number; z: number };
  east: { x: number; y: number; z: number };
  north: { x: number; y: number; z: number };
}

function frameOf(settlement: Settlement): Frame {
  const c = settlement.dir;
  let ex = -c.z, ey = 0, ez = c.x;
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el; ey /= el; ez /= el;
  return { c, east: { x: ex, y: ey, z: ez }, north: { x: ey * c.z - ez * c.y, y: ez * c.x - ex * c.z, z: ex * c.y - ey * c.x } };
}

/**
 * Builds the simulation's local map of the land around a settlement from the
 * real terrain: walkable ground, soil, forest, minerals, wild food and fresh
 * water, plus the neighbouring settlements reachable over land.
 */
export function buildSimSite(world: World, settlement: Settlement, all: Settlement[]): SimSite {
  const { c, east, north } = frameOf(settlement);
  const R = world.R;
  const size = SITE_SIZE, cell = SITE_CELL, half = (size * cell) / 2;
  const walk = new Uint8Array(size * size);
  const kind = new Uint8Array(size * size);
  const forage = new Uint8Array(size * size);
  const fertility = new Uint8Array(size * size);
  const wood = new Uint8Array(size * size);
  const mineral = new Uint8Array(size * size);
  const fresh: { e: number; n: number; d: number }[] = [];
  const d = world.data;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const e = (i + 0.5) * cell - half, n = (j + 0.5) * cell - half;
      const x = c.x + (east.x * e + north.x * n) / R, y = c.y + (east.y * e + north.y * n) / R, z = c.z + (east.z * e + north.z * n) / R;
      const l = Math.hypot(x, y, z);
      const px = x / l, py = y / l, pz = z / l;
      const w = world.cellAt(px, py, pz);
      const k = j * size + i;
      const water = d.water[w];
      if (water === Water.Ocean) { kind[k] = 2; continue; }
      if (water !== Water.Land || d.waterMask[w] > 90) { kind[k] = 1; continue; }
      mineral[k] = d.mineral[w];
      if (world.baseElevation(px, py, pz) < 0.5 || world.slopeAt(w) > 0.7) { kind[k] = 3; continue; }
      walk[k] = 1;
      fertility[k] = d.fertility[w];
      wood[k] = d.forest[w];
      forage[k] = Math.max(d.fertility[w] * 0.8, d.forest[w] * 0.9, d.biodiversity[w] * 0.6);
    }
  }
  for (let j = 1; j < size - 1; j++) {
    for (let i = 1; i < size - 1; i++) {
      const k = j * size + i;
      if (!walk[k]) continue;
      let nearFresh = false, nearSea = false;
      for (const o of [k - 1, k + 1, k - size, k + size]) {
        if (kind[o] === 1) nearFresh = true;
        if (kind[o] === 2) nearSea = true;
      }
      if (nearFresh || nearSea) forage[k] = Math.min(255, forage[k] + 70);
      if (nearFresh) {
        const e = (i + 0.5) * cell - half, n = (j + 0.5) * cell - half;
        fresh.push({ e, n, d: Math.hypot(e, n) });
      }
    }
  }
  fresh.sort((a, b) => a.d - b.d);
  const water: { e: number; n: number }[] = [];
  for (const f of fresh) {
    if (water.length >= 6) break;
    if (water.every((w) => Math.hypot(w.e - f.e, w.n - f.n) > 40)) water.push({ e: f.e, n: f.n });
  }

  // Neighbours on the same landmass, close enough for a trading journey on foot.
  const cw = world.cellAt(c.x, c.y, c.z);
  const land = d.landmassId[cw];
  const neighbors: SiteNeighbor[] = [];
  for (const o of all) {
    if (o.id === settlement.id) continue;
    const dot = o.dir.x * c.x + o.dir.y * c.y + o.dir.z * c.z;
    const distance = Math.acos(Math.max(-1, Math.min(1, dot))) * R;
    if (distance > 5200 || dot < 0.3) continue;
    const overSea = d.landmassId[world.cellAt(o.dir.x, o.dir.y, o.dir.z)] !== land;
    // gnomonic projection: straight lines in the local frame are great circles
    const qx = o.dir.x / dot - c.x, qy = o.dir.y / dot - c.y, qz = o.dir.z / dot - c.z;
    neighbors.push({ id: o.id, e: (qx * east.x + qy * east.y + qz * east.z) * R, n: (qx * north.x + qy * north.y + qz * north.z) * R, distance, overSea });
  }
  neighbors.sort((a, b) => a.distance - b.distance || a.id - b.id);

  let fert = 0, land2 = 0, sea = 0;
  for (let k = 0; k < walk.length; k++) {
    if (walk[k]) { fert += fertility[k]; land2++; }
    if (kind[k] === 2) sea++;
  }
  return {
    id: settlement.id, name: settlement.name, longitude: Math.atan2(c.z, c.x), temperature: d.temperature[cw], sinLatitude: c.y,
    size, cell, walk, kind, forage, fertility, wood, mineral, water, radius: settlement.radius, neighbors,
    richness: land2 ? fert / land2 / 255 : 0, coastal: sea > 40,
  };
}

/** Converts the founders' buildings (planet coordinates) into the settlement's local frame. */
export function foundingBuildings(world: World, settlements: Settlement[], buildings: Building[]): FoundingBuilding[] {
  const frames = new Map(settlements.map((s) => [s.id, frameOf(s)]));
  const R = world.R;
  const out: FoundingBuilding[] = [];
  for (const b of buildings) {
    const f = frames.get(b.settlement);
    if (!f) continue;
    const rx = b.dir.x - f.c.x, ry = b.dir.y - f.c.y, rz = b.dir.z - f.c.z;
    let fe = b.facing.x * f.east.x + b.facing.y * f.east.y + b.facing.z * f.east.z;
    let fn = b.facing.x * f.north.x + b.facing.y * f.north.y + b.facing.z * f.north.z;
    const fl = Math.hypot(fe, fn) || 1;
    fe /= fl; fn /= fl;
    out.push({
      kind: b.kind, settlement: b.settlement, radius: b.radius, fe, fn,
      e: (rx * f.east.x + ry * f.east.y + rz * f.east.z) * R, n: (rx * f.north.x + ry * f.north.y + rz * f.north.z) * R,
    });
  }
  return out;
}

/** Unit direction on the planet of a local (east, north) position of a settlement. */
export function siteFrame(settlement: Settlement): { toDir: (e: number, n: number, R: number, out: { x: number; y: number; z: number }) => void } {
  const { c, east, north } = frameOf(settlement);
  return {
    toDir(e, n, R, out) {
      const x = c.x + (east.x * e + north.x * n) / R, y = c.y + (east.y * e + north.y * n) / R, z = c.z + (east.z * e + north.z * n) / R;
      const l = Math.hypot(x, y, z);
      out.x = x / l; out.y = y / l; out.z = z / l;
    },
  };
}
