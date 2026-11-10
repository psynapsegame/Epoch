import { Rng, hashString } from '../core/rng';
import { Water } from '../world/types';
import type { World } from '../world/world';
import type { BuildingKind } from '../render/models/buildings';

export interface Vec3 { x: number; y: number; z: number }

export interface Building {
  id: number;
  kind: BuildingKind;
  settlement: number;
  /** Unit direction of the building on the planet. */
  dir: Vec3;
  /** Unit tangent the front door faces. */
  facing: Vec3;
  /** Footprint radius (m) used for spacing. */
  radius: number;
  /** Construction progress 0..1 (absent = complete). */
  progress?: number;
}

export interface Settlement {
  id: number;
  name: string;
  dir: Vec3;
  /** Radius of the built-up area in metres. */
  radius: number;
  siteIndex: number;
  buildings: number[];
}

const FOOTPRINT: Record<BuildingKind, number> = {
  hut: 4.5, house: 6.5, longhouse: 10, farm: 10, barn: 9.5, market: 8.5, workshop: 8.5,
  storehouse: 7, temple: 10, well: 3, windmill: 6.5, watchtower: 5, dock: 8, mine: 8,
};

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/**
 * Lays out a hamlet on a settlement site: every building is validated against
 * the real terrain (dry, gentle slope, free space).
 *
 * Phase 1 uses this to raise a few "founding hamlets" showcasing the building
 * pipeline; from Phase 3 on, the inhabitants themselves will decide what to
 * build and this function will only provide placement.
 */
export function layoutHamlet(world: World, siteIndex: number, id: number, name: string, firstBuildingId: number): { settlement: Settlement; buildings: Building[] } {
  const site = world.data.sites[siteIndex];
  const rng = new Rng(hashString(world.data.seed) ^ (siteIndex * 2654435761));
  const centre: Vec3 = { x: 0, y: 0, z: 0 };
  world.cellDir(site.x, site.y, centre);
  let east = cross(centre, { x: 0, y: 1, z: 0 });
  east = norm(east);
  const north = norm(cross(east, centre));
  const R = world.R;
  const buildings: Building[] = [];
  const placed: { e: number; n: number; r: number }[] = [];

  const at = (e: number, n: number): Vec3 =>
    norm({ x: centre.x + (east.x * e + north.x * n) / R, y: centre.y + (east.y * e + north.y * n) / R, z: centre.z + (east.z * e + north.z * n) / R });

  const suitable = (e: number, n: number, r: number): boolean => {
    for (const p of placed) if (Math.hypot(p.e - e, p.n - n) < p.r + r + 1.5) return false;
    let hmin = 1e9, hmax = -1e9;
    for (let k = 0; k < 5; k++) {
      const a = (k / 4) * Math.PI * 2;
      const d = at(e + (k === 4 ? 0 : Math.cos(a) * r), n + (k === 4 ? 0 : Math.sin(a) * r));
      const cell = world.cellAt(d.x, d.y, d.z);
      if (world.data.water[cell] !== Water.Land || world.data.waterMask[cell] > 40) return false;
      const h = world.elevationAt(d.x, d.y, d.z);
      hmin = Math.min(hmin, h);
      hmax = Math.max(hmax, h);
    }
    return hmin > 1.2 && hmax - hmin < Math.max(1.3, r * 0.22);
  };

  const place = (kind: BuildingKind, e: number, n: number, faceE: number, faceN: number): boolean => {
    const r = FOOTPRINT[kind];
    if (!suitable(e, n, r)) return false;
    const dir = at(e, n);
    // tangent facing vector, re-orthogonalised against the local up
    let f: Vec3 = { x: east.x * faceE + north.x * faceN, y: east.y * faceE + north.y * faceN, z: east.z * faceE + north.z * faceN };
    const d = f.x * dir.x + f.y * dir.y + f.z * dir.z;
    f = norm({ x: f.x - dir.x * d, y: f.y - dir.y * d, z: f.z - dir.z * d });
    placed.push({ e, n, r });
    buildings.push({ id: firstBuildingId + buildings.length, kind, settlement: id, dir, facing: f, radius: r });
    return true;
  };

  /** Tries random spots on a ring, facing the village centre (with a little disorder). */
  const ring = (kind: BuildingKind, rMin: number, rMax: number, count: number): number => {
    let done = 0;
    for (let attempt = 0; attempt < count * 14 && done < count; attempt++) {
      const a = rng.next() * Math.PI * 2;
      const rad = rng.range(rMin, rMax);
      const e = Math.cos(a) * rad, n = Math.sin(a) * rad;
      const jitter = rng.range(-0.5, 0.5);
      const fa = a + Math.PI + jitter;
      if (place(kind, e, n, Math.cos(fa), Math.sin(fa))) done++;
    }
    return done;
  };

  place('well', 0, 0, 0, 1);
  const size = 0.75 + rng.next() * 0.6; // hamlet scale
  ring('market', 9, 15, 1);
  ring('house', 14, 30, Math.round(5 * size));
  ring('hut', 16, 36, Math.round(4 * size));
  ring('longhouse', 22, 38, 1);
  ring('workshop', 24, 42, 1);
  ring('storehouse', 24, 44, 1);
  ring('house', 30, 52, Math.round(4 * size));
  if (size > 1) ring('temple', 34, 56, 1);
  ring('barn', 44, 66, 1);
  ring('farm', 48, 82, Math.round(4 * size));
  ring('windmill', 55, 90, 1);
  ring('watchtower', 50, 85, 1);

  // A dock on the nearest gentle shore, pier pointing out to sea.
  if (site.coastal) {
    let best: { e: number; n: number; fe: number; fn: number } | null = null;
    for (let a = 0; a < 32 && !best; a++) {
      const ang = (a / 32) * Math.PI * 2;
      for (let rad = 20; rad < 170; rad += 3) {
        const d = at(Math.cos(ang) * rad, Math.sin(ang) * rad);
        const h = world.elevationAt(d.x, d.y, d.z);
        if (h < 0.35) {
          const cell = world.cellAt(d.x, d.y, d.z);
          if (world.data.water[cell] === Water.Ocean && rad > 24) {
            best = { e: Math.cos(ang) * (rad - 2.5), n: Math.sin(ang) * (rad - 2.5), fe: Math.cos(ang), fn: Math.sin(ang) };
          }
          break;
        }
      }
    }
    if (best) {
      const dir = at(best.e, best.n);
      const h = world.elevationAt(dir.x, dir.y, dir.z);
      if (h > 0.1 && h < 2.2) {
        let f: Vec3 = { x: east.x * best.fe + north.x * best.fn, y: east.y * best.fe + north.y * best.fn, z: east.z * best.fe + north.z * best.fn };
        const dd = f.x * dir.x + f.y * dir.y + f.z * dir.z;
        f = norm({ x: f.x - dir.x * dd, y: f.y - dir.y * dd, z: f.z - dir.z * dd });
        buildings.push({ id: firstBuildingId + buildings.length, kind: 'dock', settlement: id, dir, facing: f, radius: FOOTPRINT.dock });
        placed.push({ e: best.e, n: best.n, r: FOOTPRINT.dock });
      }
    }
  }

  let radius = 30;
  for (const p of placed) radius = Math.max(radius, Math.hypot(p.e, p.n) + p.r);
  return {
    settlement: { id, name, dir: centre, radius, siteIndex, buildings: buildings.map((b) => b.id) },
    buildings,
  };
}
