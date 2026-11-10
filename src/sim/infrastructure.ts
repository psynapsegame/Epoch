import type { Simulation } from './simulation';
import { cellOf, findPath, nearestWalkable } from './pathfinding';
import { type SettlementState, type SimBuilding, type SimSite } from './types';

/**
 * Roads and walls. Both are ordinary building projects: the settlement decides
 * them, its builders spend hours and materials on them, and once finished they
 * change how people move (roads are faster to walk, walls close the ground
 * except at their gates) and how a place withstands an assault.
 */

export const INFRA_ROAD = 1, INFRA_WALL = 2;
/** Walking is this much faster on a road. */
export const ROAD_SPEED = 1.35;
/** Length of one wall piece (m). */
export const WALL_PIECE = 3;
const GATE_HALF = 3.4;

export const isInfra = (kind: string): boolean => kind === 'road' || kind === 'wall';

export interface Cost { wood: number; stone: number; goods: number; hours: number }

export function pathLength(path: number[]): number {
  let d = 0;
  for (let i = 2; i < path.length; i += 2) d += Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
  return d;
}

/** Point at a distance along a polyline. */
export function pointAt(path: number[], dist: number): { e: number; n: number } {
  for (let i = 2; i < path.length; i += 2) {
    const d = Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
    if (dist <= d && d > 0) {
      const t = dist / d;
      return { e: path[i - 2] + (path[i] - path[i - 2]) * t, n: path[i - 1] + (path[i + 1] - path[i - 1]) * t };
    }
    dist -= d;
  }
  return { e: path[path.length - 2] ?? 0, n: path[path.length - 1] ?? 0 };
}

/** What a road or a wall costs in all, from its real length. */
export function infraCost(b: SimBuilding): Cost {
  const path = b.path ?? [];
  if (b.kind === 'road') {
    const m = pathLength(path);
    // an earthen road: mostly labour, a little gravel
    return { wood: 0, stone: m * 0.04, goods: 0, hours: 12 + m * 0.4 };
  }
  const pieces = path.length / 2;
  return b.res === 1
    ? { wood: pieces * 0.3, stone: pieces * 1.6, goods: 0, hours: 40 + pieces * 4.5 }
    : { wood: pieces * 1.5, stone: 0, goods: 0, hours: 30 + pieces * 2.6 };
}

/** Where the builders are at work on an unfinished road or wall. */
export function workFront(b: SimBuilding): { e: number; n: number } {
  const path = b.path ?? [];
  if (path.length < 2) return { e: b.e, n: b.n };
  if (b.kind === 'road') return pointAt(path, pathLength(path) * b.progress);
  const i = Math.min(path.length / 2 - 1, Math.floor((path.length / 2) * b.progress));
  // stand on the town side of the piece being raised
  const e = path[i * 2], n = path[i * 2 + 1];
  const l = Math.hypot(e - b.e, n - b.n) || 1;
  return { e: e - ((e - b.e) / l) * 3.5, n: n - ((n - b.n) / l) * 3.5 };
}

/** Marks the cells of a polyline, about `width` metres wide. */
function stamp(site: SimSite, mask: Uint8Array, path: number[], upTo: number, value: number): void {
  let done = 0;
  for (let i = 2; i < path.length && done < upTo; i += 2) {
    const d = Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
    const steps = Math.max(1, Math.ceil(d / 1.2));
    for (let s = 0; s <= steps; s++) {
      if (done + (d * s) / steps > upTo) break;
      const c = cellOf(site, path[i - 2] + ((path[i] - path[i - 2]) * s) / steps, path[i - 1] + ((path[i + 1] - path[i - 1]) * s) / steps);
      if (c >= 0) mask[c] = value;
    }
    done += d;
  }
}

/** Cells closed by the pieces of a wall (two cells thick so that nothing slips through a diagonal). */
function wallCells(site: SimSite, b: SimBuilding, out: (c: number) => void): void {
  const path = b.path ?? [];
  for (let i = 0; i < path.length; i += 2) {
    const e = path[i], n = path[i + 1];
    const l = Math.hypot(e - b.e, n - b.n) || 1;
    const re = (e - b.e) / l, rn = (n - b.n) / l; // radial
    for (let a = -1.5; a <= 1.5; a += 0.75) {
      for (const r of [-0.9, 0.9]) {
        const c = cellOf(site, e - rn * a + re * r, n + re * a + rn * r);
        if (c >= 0) out(c);
      }
    }
  }
}

/**
 * Applies the finished roads and walls of a settlement to its maps:
 * `walk` loses the cells under a wall, `mask` tells roads from walls.
 * Unfinished roads count up to where the builders have come.
 */
export function applyInfra(site: SimSite, list: SimBuilding[], walk: Uint8Array, mask: Uint8Array): void {
  mask.fill(0);
  for (const b of list) {
    if (b.kind !== 'road' || !b.path) continue;
    stamp(site, mask, b.path, pathLength(b.path) * b.progress, INFRA_ROAD);
  }
  for (const b of list) {
    if (b.kind !== 'wall' || !b.path) continue;
    wallCells(site, b, (c) => {
      mask[c] = INFRA_WALL;
      if (b.progress >= 1) walk[c] = 0;
    });
  }
}

const doorOf = (b: SimBuilding) => {
  const reach = b.radius * 0.72 + 1.2;
  return { e: b.e + b.fe * reach, n: b.n + b.fn * reach };
};

const ROAD_PRIORITY = ['storehouse', 'market', 'temple', 'dock', 'workshop', 'mine', 'barn', 'windmill', 'farm', 'watchtower', 'longhouse', 'house', 'hut'];

function nearRoad(site: SimSite, mask: Uint8Array, e: number, n: number, reach: number): boolean {
  for (let de = -reach; de <= reach; de += site.cell) {
    for (let dn = -reach; dn <= reach; dn += site.cell) {
      const c = cellOf(site, e + de, n + dn);
      if (c >= 0 && mask[c] === INFRA_ROAD) return true;
    }
  }
  return false;
}

function addInfra(sim: Simulation, st: SettlementState, kind: string, e: number, n: number, path: number[], res: number, gates?: number[]): SimBuilding {
  const b = sim.addBuilding({ kind, settlement: st.id, e, n, fe: 0, fn: 1, radius: 0 }, 0, res);
  b.path = path;
  if (gates) b.gates = gates;
  st.projects.push(b.id);
  sim.refreshSite(st.id);
  sim.record({ t: sim.state.time, type: 'project', settlement: st.id, what: kind, value: Math.round(kind === 'road' ? pathLength(path) : (path.length / 2) * WALL_PIECE) });
  return b;
}

/**
 * Opens a road project if the settlement has a use for one: a street from the
 * square to a building that has none, or, for a town, a highway towards a
 * neighbour it lives with. Returns the project, or null.
 */
export function planRoad(sim: Simulation, st: SettlementState, pop: number): SimBuilding | null {
  if (pop < 30) return null;
  const site = sim.site(st.id);
  const plaza = sim.plazaOf(st.id);
  if (!site || !plaza) return null;
  const mask = sim.infraMask(st.id);
  const list = sim.buildingsOf(st.id);
  const roads = list.filter((b) => b.kind === 'road');
  // a street can only start from the square or from a finished road
  const from = (e: number, n: number): { e: number; n: number } => {
    let best = plaza, bd = Math.hypot(plaza.e - e, plaza.n - n);
    for (const r of roads) {
      if (r.progress < 1 || !r.path || r.res >= 0) continue;
      for (let i = 0; i < r.path.length; i += 2) {
        const d = Math.hypot(r.path[i] - e, r.path[i + 1] - n);
        if (d < bd - 1e-6) { bd = d; best = { e: r.path[i], n: r.path[i + 1] }; }
      }
    }
    return best;
  };
  const candidates = list
    .filter((b) => !isInfra(b.kind) && b.progress >= 1 && b.kind !== 'well')
    .sort((a, b) => ROAD_PRIORITY.indexOf(a.kind) - ROAD_PRIORITY.indexOf(b.kind) || a.id - b.id);
  for (const b of candidates) {
    const door = nearestWalkable(site, doorOf(b).e, doorOf(b).n, 6);
    if (!door || nearRoad(site, mask, door.e, door.n, 7)) continue;
    const a = from(door.e, door.n);
    const start = nearestWalkable(site, a.e, a.n, 4);
    if (!start || Math.hypot(start.e - door.e, start.n - door.n) < 12) continue;
    const way = findPath(site, start.e, start.n, door.e, door.n);
    if (!way) continue;
    const path = [start.e, start.n, ...way];
    if (pathLength(path) > 260) continue;
    const mid = pointAt(path, pathLength(path) / 2);
    return addInfra(sim, st, 'road', mid.e, mid.n, path, -1);
  }
  // a highway towards the nearest neighbour reached by land and actually inhabited
  if (pop < 60) return null;
  const half = (site.size * site.cell) / 2;
  const nbs = site.neighbors
    .filter((nb) => !nb.overSea && sim.census(nb.id).pop > 0 && !roads.some((r) => r.res === nb.id))
    .sort((a, b) => a.distance - b.distance || a.id - b.id);
  for (const nb of nbs) {
    const l = Math.hypot(nb.e, nb.n) || 1;
    for (let reach = half - 9; reach > 60; reach -= 15) {
      const end = nearestWalkable(site, (nb.e / l) * reach, (nb.n / l) * reach, 5);
      const start = nearestWalkable(site, plaza.e, plaza.n, 4);
      if (!end || !start) continue;
      const way = findPath(site, start.e, start.n, end.e, end.n);
      if (!way) continue;
      const path = [start.e, start.n, ...way];
      const mid = pointAt(path, pathLength(path) / 2);
      return addInfra(sim, st, 'road', mid.e, mid.n, path, nb.id);
    }
  }
  return null;
}

/** Cells reachable on foot from a point. */
function flood(site: SimSite, walk: Uint8Array, e: number, n: number): Uint8Array {
  const S = site.size, seen = new Uint8Array(S * S);
  const start = cellOf(site, e, n);
  if (start < 0) return seen;
  const queue = new Int32Array(S * S);
  let head = 0, tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const c = queue[head++], i = c % S, j = (c / S) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= S || y >= S) continue;
      const k = y * S + x;
      if (seen[k] || !walk[k]) continue;
      seen[k] = 1;
      queue[tail++] = k;
    }
  }
  return seen;
}

/** Does this people have a reason to shut itself in? */
function threatened(sim: Simulation, st: SettlementState): boolean {
  const s = sim.state;
  if (s.wars.some((w) => w.attacker === st.civ || w.defender === st.civ)) return true;
  if (s.relations.some((r) => (r.a === st.civ || r.b === st.civ) && r.opinion < -0.15)) return true;
  return sim.buildingsOf(st.id).some((b) => b.kind === 'watchtower' && b.progress >= 1);
}

/**
 * Opens a wall project around the heart of a town: a palisade, or a stone
 * wall for a people that knows masonry. The ring keeps a gate on every road
 * it crosses and wherever one is needed for no door, well or field to be cut off.
 */
export function planWall(sim: Simulation, st: SettlementState, pop: number, force = false): SimBuilding | null {
  const site = sim.site(st.id), base = sim.baseSite(st.id);
  const plaza = sim.plazaOf(st.id);
  if (!site || !base || !plaza) return null;
  const list = sim.buildingsOf(st.id);
  if (list.some((b) => b.kind === 'wall')) return null;
  if (!force && (pop < 70 || !threatened(sim, st))) return null;
  const mask = sim.infraMask(st.id);
  const solid = list.filter((b) => !isInfra(b.kind));
  const core = solid.filter((b) => b.progress >= 1 && !['farm', 'dock', 'mine', 'windmill'].includes(b.kind) && Math.hypot(b.e - plaza.e, b.n - plaza.n) < 95);
  let r0 = 40;
  for (const b of core) r0 = Math.max(r0, Math.hypot(b.e - plaza.e, b.n - plaza.n) + b.radius + 8);
  r0 = Math.min(110, r0);
  // the radius that runs into the fewest buildings
  let radius = r0, fewest = Infinity;
  for (let r = r0; r <= r0 + 16; r += 4) {
    let hits = 0;
    for (const b of solid) if (Math.abs(Math.hypot(b.e - plaza.e, b.n - plaza.n) - r) < b.radius + 3) hits++;
    if (hits < fewest) { fewest = hits; radius = r; }
  }
  const count = Math.round((2 * Math.PI * radius) / WALL_PIECE);
  const at = (i: number) => {
    const a = (i / count) * Math.PI * 2;
    return { e: plaza.e + Math.cos(a) * radius, n: plaza.n + Math.sin(a) * radius };
  };
  const gates: { e: number; n: number }[] = [];
  const addGate = (g: { e: number; n: number }) => {
    if (!gates.some((x) => Math.hypot(x.e - g.e, x.n - g.n) < 14)) gates.push(g);
  };
  // gates where roads cross the ring, then one towards each quarter of the horizon
  for (let i = 0; i < count; i++) {
    const p = at(i), c = cellOf(site, p.e, p.n);
    if (c >= 0 && mask[c] === INFRA_ROAD) addGate(p);
  }
  for (let q = 0; q < 4; q++) {
    const p = at(Math.round(((q + 0.5) / 4) * count));
    const c = cellOf(site, p.e, p.n);
    if (c >= 0 && base.walk[c] && !gates.some((x) => Math.hypot(x.e - p.e, x.n - p.n) < radius * 0.9)) addGate(p);
  }
  const build = (): number[] => {
    const path: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = at(i), c = cellOf(site, p.e, p.n);
      if (c < 0 || !base.walk[c]) continue; // water, cliffs: the land itself closes the ring
      if (gates.some((g) => Math.hypot(g.e - p.e, g.n - p.n) < GATE_HALF)) continue;
      if (solid.some((b) => Math.hypot(b.e - p.e, b.n - p.n) < b.radius + 2.5)) continue;
      path.push(p.e, p.n);
    }
    return path;
  };
  // nothing that could be reached before may be cut off: add gates until it holds
  const before = flood(site, site.walk, plaza.e, plaza.n);
  const targets: { e: number; n: number }[] = [];
  for (const b of solid) { const d = nearestWalkable(site, doorOf(b).e, doorOf(b).n, 8); if (d) targets.push(d); }
  for (const w of base.water) targets.push(w);
  const half = (site.size * site.cell) / 2;
  for (let a = 0; a < 16; a++) {
    const p = nearestWalkable(site, Math.cos((a / 16) * Math.PI * 2) * (half - 12), Math.sin((a / 16) * Math.PI * 2) * (half - 12), 6);
    if (p) targets.push(p);
  }
  let path = build();
  const probe: SimBuilding = { id: 0, kind: 'wall', settlement: st.id, e: plaza.e, n: plaza.n, fe: 0, fn: 1, radius: 0, progress: 1, started: 0, completed: 0, res: 0, produced: 0, path };
  for (let round = 0; round < 12; round++) {
    const walk = new Uint8Array(site.walk);
    probe.path = path;
    wallCells(site, probe, (c) => { walk[c] = 0; });
    const start = nearestWalkable({ ...site, walk }, plaza.e, plaza.n, 6) ?? plaza;
    const after = flood(site, walk, start.e, start.n);
    const lost = targets.find((p) => { const c = cellOf(site, p.e, p.n); return c >= 0 && before[c] && walk[c] && !after[c]; });
    if (!lost) break;
    const l = Math.hypot(lost.e - plaza.e, lost.n - plaza.n) || 1;
    const g = { e: plaza.e + ((lost.e - plaza.e) / l) * radius, n: plaza.n + ((lost.n - plaza.n) / l) * radius };
    if (gates.some((x) => Math.hypot(x.e - g.e, x.n - g.n) < 1)) break; // already open there: the land is the obstacle
    gates.push(g);
    path = build();
  }
  if (path.length / 2 < 20) return null;
  const civ = sim.civOf(st.id);
  const stone = !!civ && civ.techs.includes('masonry');
  return addInfra(sim, st, 'wall', plaza.e, plaza.n, path, stone ? 1 : 0, gates.flatMap((g) => [g.e, g.n]));
}

/** How much a finished wall helps those who defend it. */
export function wallDefence(sim: Simulation, settlement: number): number {
  const wall = sim.buildingsOf(settlement).find((b) => b.kind === 'wall' && b.progress >= 1);
  return !wall ? 1 : wall.res === 1 ? 1.6 : 1.3;
}

/** Travel between two settlements is faster when a finished highway leads from one to the other. */
export function highwayFactor(sim: Simulation, from: number, to: number): number {
  const has = (a: number, b: number) => sim.buildingsOf(a).some((r) => r.kind === 'road' && r.res === b && r.progress >= 1);
  return 1 + (has(from, to) ? 0.25 : 0) + (has(to, from) ? 0.25 : 0);
}

