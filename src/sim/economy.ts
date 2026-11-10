import { clamp01 } from '../core/math';
import { DAYS_PER_YEAR, SECONDS_PER_DAY, SECONDS_PER_YEAR } from './clock';
import { civilizationsDaily } from './civilization';
import { atWar, diplomacyDaily, soldierSlots } from './war';
import { divineDaily } from './divine';
import { cellOf } from './pathfinding';
import { dwellingCapacity } from './sites';
import type { Simulation } from './simulation';
import {
  BASE_PRICE, J, JOB_COUNT, R, RESOURCE_COUNT, emptyTally,
  type Household, type Person, type SettlementState, type SimBuilding, type SimSite,
} from './types';

/** Materials and labour needed to raise each kind of building. */
export const BUILD_COST: Record<string, { wood: number; stone: number; goods: number; hours: number }> = {
  hut: { wood: 12, stone: 0, goods: 0, hours: 40 },
  house: { wood: 28, stone: 10, goods: 0, hours: 120 },
  longhouse: { wood: 45, stone: 15, goods: 0, hours: 200 },
  farm: { wood: 20, stone: 4, goods: 0, hours: 90 },
  barn: { wood: 35, stone: 8, goods: 0, hours: 150 },
  storehouse: { wood: 30, stone: 12, goods: 0, hours: 140 },
  workshop: { wood: 30, stone: 15, goods: 0, hours: 160 },
  dock: { wood: 30, stone: 0, goods: 0, hours: 120 },
  mine: { wood: 25, stone: 10, goods: 0, hours: 160 },
  market: { wood: 25, stone: 10, goods: 5, hours: 120 },
  windmill: { wood: 35, stone: 20, goods: 0, hours: 220 },
  temple: { wood: 40, stone: 60, goods: 10, hours: 400 },
  watchtower: { wood: 20, stone: 40, goods: 0, hours: 250 },
  well: { wood: 0, stone: 15, goods: 0, hours: 60 },
};

const FOOTPRINT: Record<string, number> = {
  hut: 4.5, house: 6.5, longhouse: 10, farm: 10, barn: 9.5, market: 8.5, workshop: 8.5,
  storehouse: 7, temple: 10, well: 3, windmill: 6.5, watchtower: 5, dock: 8, mine: 8,
};

/** How much each temperament suits each profession (weights on the 9 traits). */
const JOB_TRAITS: number[][] = [
  /* gatherer   */ [0, 0, 0, 0.3, 0, 0, 0, 0, 0],
  /* farmer     */ [0, 0, 0, 0, 0.3, 0, 0, 0, 0.4],
  /* herder     */ [0, 0, 0, 0, 0, 0, 0, 0.3, 0.3],
  /* fisher     */ [0, 0.3, 0, 0.2, 0, 0, 0, 0, 0],
  /* woodcutter */ [0, 0.3, 0, 0, 0, 0.2, 0, 0, 0],
  /* miner      */ [0, 0.5, 0, 0, 0, 0, 0, 0, 0],
  /* builder    */ [0.3, 0, 0.3, 0, 0, 0, 0, 0, 0],
  /* smith      */ [0.2, 0, 0.5, 0, 0, 0, 0, 0, 0],
  /* artisan    */ [0, 0, 0.4, 0.3, 0, 0, 0, 0, 0],
  /* merchant   */ [0.5, 0, 0, 0, 0, 0, 0.5, 0, 0],
  /* researcher */ [0, 0, 0.6, 0.5, 0, 0, 0, 0, 0],
  /* leader     */ [0.5, 0, 0.2, 0, 0, 0, 0.4, 0, 0],
  /* soldier    */ [0, 0.6, 0, 0, 0.3, 0.3, 0, 0, 0],
];

export const ageAt = (p: Person, time: number) => (time - p.birth) / SECONDS_PER_YEAR;
export const isAdult = (p: Person, time: number) => { const a = ageAt(p, time); return a >= 14 && a < 68; };

export function countKind(list: SimBuilding[], kind: string): number {
  let n = 0;
  for (const b of list) if (b.kind === kind && b.progress >= 1) n++;
  return n;
}

/** Desired stock of each resource for a settlement (drives prices and labour). */
export function stockTargets(sim: Simulation, st: SettlementState): number[] {
  const { pop, adults } = sim.census(st.id);
  const list = sim.buildingsOf(st.id);
  let needWood = 0, needStone = 0, needGoods = 0;
  for (const id of st.projects) {
    const b = sim.building(id);
    const c = b && BUILD_COST[b.kind];
    if (!b || !c) continue;
    needWood += c.wood * (1 - b.progress);
    needStone += c.stone * (1 - b.progress);
    needGoods += c.goods * (1 - b.progress);
  }
  const forge = countKind(list, 'workshop') > 0;
  const t = new Array<number>(RESOURCE_COUNT).fill(0);
  t[R.Food] = pop * 4;
  t[R.Wood] = 30 + adults * 0.6 + needWood;
  t[R.Stone] = 12 + adults * 0.3 + needStone;
  t[R.Iron] = forge ? 4 : 0;
  t[R.Coal] = forge ? 4 : 0;
  t[R.Gold] = 0;
  t[R.Tools] = Math.max(2, adults * 0.12);
  t[R.Goods] = 3 + pop * 0.03 + needGoods;
  return t;
}

export function updatePrices(sim: Simulation, st: SettlementState): void {
  const t = stockTargets(sim, st);
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const ratio = Math.pow((t[r] + 1) / (st.stock[r] + 1), 0.6);
    st.prices[r] = BASE_PRICE[r] * Math.max(0.35, Math.min(4, ratio));
  }
}

// ---------------------------------------------------------------- labour
/** Open positions per profession in a settlement today. */
export function jobSlots(sim: Simulation, st: SettlementState): number[] {
  const list = sim.buildingsOf(st.id);
  const site = sim.site(st.id)!;
  const { adults } = sim.census(st.id);
  const t = stockTargets(sim, st);
  const slots = new Array<number>(JOB_COUNT).fill(0);
  slots[J.Gatherer] = 1e9;
  // Hands go where goods are lacking.
  const need = (r: number) => (st.stock[r] < t[r] ? 1 : st.stock[r] < t[r] * 1.6 ? 0.5 : 0);
  // Food trades keep their hands all year; when the granary is full they simply work less (see utilities).
  slots[J.Farmer] = 2 * countKind(list, 'farm');
  slots[J.Herder] = 2 * countKind(list, 'barn');
  slots[J.Fisher] = 2 * countKind(list, 'dock');
  let mining = 0;
  for (const b of list) if (b.kind === 'mine' && b.progress >= 1 && b.res >= 0) mining += Math.ceil(3 * (b.res === R.Gold ? 0.34 : need(b.res)));
  // without a quarry, a couple of people gather loose stone along banks and slopes
  const quarry = list.some((b) => b.kind === 'mine' && b.progress >= 1 && b.res === R.Stone);
  if (!quarry && st.stock[R.Stone] < t[R.Stone]) mining += Math.min(2, Math.max(1, Math.ceil(adults * 0.06)));
  slots[J.Miner] = mining;
  const workshops = countKind(list, 'workshop');
  const canForge = st.stock[R.Iron] >= 1 && (st.stock[R.Coal] >= 1 || st.stock[R.Wood] >= 2);
  slots[J.Smith] = canForge && st.stock[R.Tools] < t[R.Tools] * 1.5 ? workshops : 0;
  slots[J.Artisan] = st.stock[R.Wood] >= 3 && st.stock[R.Goods] < t[R.Goods] * 1.5 ? workshops : 0;
  slots[J.Builder] = st.projects.length ? Math.min(8, Math.max(2, Math.ceil(adults * 0.18))) : 0;
  slots[J.Woodcutter] = st.stock[R.Wood] < t[R.Wood] ? Math.min(6, Math.max(1, Math.ceil(adults * 0.15))) : st.stock[R.Wood] < t[R.Wood] * 1.6 ? 1 : 0;
  const partners = site.neighbors.filter((n) => sim.census(n.id).pop > 0).length;
  slots[J.Merchant] = countKind(list, 'market') > 0 && partners > 0 ? Math.min(2, Math.ceil(adults / 40)) : 0;
  // scholars gather where there is a temple or a great house; a learned culture keeps more of them
  const civ = sim.civOf(st.id);
  const school = countKind(list, 'temple') + countKind(list, 'longhouse') > 0;
  slots[J.Soldier] = soldierSlots(sim, st, adults);
  slots[J.Researcher] = !civ ? 0 : school ? Math.max(1, Math.ceil(adults * 0.04 * (0.5 + civ.culture.values[3] * 1.5))) : adults >= 18 ? 1 : 0;
  return slots;
}

let atWarCache: (civ: number) => boolean = () => false;

function jobUrgency(st: SettlementState, job: number): number {
  const ratio = (r: number) => st.prices[r] / BASE_PRICE[r];
  switch (job) {
    case J.Farmer: case J.Herder: case J.Fisher: return ratio(R.Food) + 0.3;
    case J.Woodcutter: return ratio(R.Wood);
    case J.Miner: return Math.max(ratio(R.Stone), ratio(R.Iron) * 0.8);
    case J.Builder: return 1.6;
    case J.Smith: return ratio(R.Tools);
    case J.Artisan: return ratio(R.Goods) * 0.8;
    case J.Merchant: return 1;
    case J.Researcher: return 0.9;
    case J.Soldier: return st.civ && atWarCache(st.civ) ? 3 : 0.7;
    default: return 0;
  }
}

const BOUND: Record<number, string> = { [J.Farmer]: 'farm', [J.Herder]: 'barn', [J.Fisher]: 'dock', [J.Smith]: 'workshop', [J.Artisan]: 'workshop' };

/**
 * Daily labour market: people keep a job that is still needed; freed and
 * unoccupied adults take the most urgent open positions they are best suited
 * for (skill + temperament). Everyone else lives off the land.
 */
export function assignJobs(sim: Simulation, st: SettlementState): void {
  const time = sim.state.time;
  atWarCache = (civ) => atWar(sim, civ);
  const slots = jobSlots(sim, st);
  const people = sim.state.persons.filter((p) => p.settlement === st.id);
  const pool: Person[] = [];
  const ruler = sim.civOf(st.id)?.leader ?? 0;
  for (const p of people) {
    if (p.id === ruler || p.army) continue; // the ruler rules; those on campaign stay under arms
    if (p.job === J.Leader) p.job = J.Gatherer; // a former ruler returns to common life
    if (!isAdult(p, time)) {
      if (p.job !== J.Gatherer) setJob(sim, p, J.Gatherer, 0);
      continue;
    }
    if (p.job !== J.Gatherer && slots[p.job] > 0 && (!BOUND[p.job] || workplaceOk(sim, p))) {
      slots[p.job]--;
      if (p.job === J.Miner) p.workplace = pickWorkplace(sim, st, J.Miner);
    }
    else {
      if (p.job !== J.Gatherer && !p.trip) setJob(sim, p, J.Gatherer, 0);
      if (!p.trip) pool.push(p);
    }
  }
  // Never strip the land of all its gatherers while the granary is low.
  const foodDays = st.stock[R.Food] / Math.max(1, people.length);
  let reserve = foodDays < 1.5 ? Math.ceil(pool.length * 0.5) : foodDays < 3 ? Math.ceil(pool.length * 0.25) : 0;
  const order = [J.Farmer, J.Herder, J.Fisher, J.Woodcutter, J.Miner, J.Builder, J.Smith, J.Artisan, J.Merchant, J.Researcher, J.Soldier]
    .sort((a, b) => jobUrgency(st, b) - jobUrgency(st, a) || a - b);
  for (const job of order) {
    const foodJob = job === J.Farmer || job === J.Herder || job === J.Fisher;
    while (slots[job] > 0 && pool.length > (foodJob ? 0 : reserve)) {
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        let s = p.skills[job] * 1.5;
        for (let k = 0; k < 9; k++) s += JOB_TRAITS[job][k] * p.traits[k];
        if (s > bestScore) { bestScore = s; best = i; }
      }
      const p = pool.splice(best, 1)[0];
      setJob(sim, p, job, pickWorkplace(sim, st, job));
      slots[job]--;
      if (foodJob && reserve > 0) reserve--;
    }
  }
}

function workplaceOk(sim: Simulation, p: Person): boolean {
  const b = sim.building(p.workplace);
  return !!b && b.progress >= 1 && b.kind === BOUND[p.job];
}

function pickWorkplace(sim: Simulation, st: SettlementState, job: number): number {
  if (job === J.Researcher) {
    const list = sim.buildingsOf(st.id);
    return (list.find((b) => b.kind === 'temple' && b.progress >= 1) ?? list.find((b) => b.kind === 'longhouse' && b.progress >= 1))?.id ?? 0;
  }
  const kind = job === J.Miner ? 'mine' : BOUND[job];
  if (!kind) return 0;
  const counts = new Map<number, number>();
  for (const p of sim.state.persons) if (p.settlement === st.id && p.job === job) counts.set(p.workplace, (counts.get(p.workplace) ?? 0) + 1);
  let best = 0, bestN = Infinity;
  for (const b of sim.buildingsOf(st.id)) {
    if (b.kind !== kind || b.progress < 1) continue;
    // a mine whose ore is plentiful in the stores needs no more hands
    if (kind === 'mine' && b.res !== R.Gold && st.stock[b.res] >= stockTargets(sim, st)[b.res] * 1.6) continue;
    const n = counts.get(b.id) ?? 0;
    if (n < bestN) { bestN = n; best = b.id; }
  }
  return best;
}

function setJob(sim: Simulation, p: Person, job: number, workplace: number): void {
  if (p.job !== job) sim.remember(p, { t: sim.state.time, type: 'job', what: job });
  p.job = job;
  p.workplace = workplace;
  sim.rosterVersion++;
}

// ------------------------------------------------------------- planning
/** Finds where a new building can stand: free, dry, gentle ground with room around it. */
export function findSpot(sim: Simulation, site: SimSite, kind: string): { e: number; n: number; fe: number; fn: number; res: number } | null {
  const radius = FOOTPRINT[kind] ?? 7;
  const half = (site.size * site.cell) / 2;
  const list = sim.buildingsOf(site.id);
  const base = sim.baseSite(site.id);
  const clear = (e: number, n: number): boolean => {
    for (const b of list) if (Math.hypot(b.e - e, b.n - n) < b.radius + radius + 2.5) return false;
    const r = radius * 0.85;
    for (let de = -r; de <= r; de += site.cell) {
      for (let dn = -r; dn <= r; dn += site.cell) {
        if (de * de + dn * dn > r * r) continue;
        const c = cellOf(site, e + de, n + dn);
        if (c < 0 || !base.walk[c]) return false;
      }
    }
    return true;
  };
  const face = (e: number, n: number) => {
    const l = Math.hypot(e, n) || 1;
    return { fe: -e / l, fn: -n / l };
  };

  if (kind === 'dock') {
    // nearest shore: a walkable cell touching the sea, pier pointing out to the water
    let best: { e: number; n: number; fe: number; fn: number; d: number } | null = null;
    const S = site.size;
    for (let j = 2; j < S - 2; j++) {
      for (let i = 2; i < S - 2; i++) {
        const k = j * S + i;
        if (!base.walk[k]) continue;
        let fe = 0, fn = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (site.kind[(j + dj) * S + i + di] === 2 && site.kind[(j + dj * 2) * S + i + di * 2] === 2) { fe += di; fn += dj; }
        }
        if (!fe && !fn) continue;
        const e = (i + 0.5) * site.cell - half, n = (j + 0.5) * site.cell - half;
        const d = Math.hypot(e, n);
        if (d > 210 || (best && d >= best.d)) continue;
        let free = true;
        for (const b of list) if (Math.hypot(b.e - e, b.n - n) < b.radius + 6) free = false;
        if (!free) continue;
        const l = Math.hypot(fe, fn);
        best = { e, n, fe: fe / l, fn: fn / l, d };
      }
    }
    return best ? { e: best.e, n: best.n, fe: best.fe, fn: best.fn, res: -1 } : null;
  }

  if (kind === 'mine') {
    // richest reachable deposit not yet worked: stone anywhere rocky, metals only on real veins
    const taken = new Set(list.filter((b) => b.kind === 'mine').map((b) => b.res));
    let best: { e: number; n: number; res: number; score: number } | null = null;
    const S = site.size;
    for (let j = 3; j < S - 3; j += 2) {
      for (let i = 3; i < S - 3; i += 2) {
        const m = site.mineral[j * S + i];
        if (!m) continue;
        const res = [R.Iron, R.Coal, R.Gold, R.Stone][(m >> 4) - 1];
        if (taken.has(res)) continue;
        const e = (i + 0.5) * site.cell - half, n = (j + 0.5) * site.cell - half;
        const score = (m & 15) * (res === R.Stone ? 1 : 2.5) - Math.hypot(e, n) * 0.03;
        if (best && score <= best.score) continue;
        if (!clear(e, n)) continue;
        best = { e, n, res, score };
      }
    }
    return best ? { e: best.e, n: best.n, ...face(best.e, best.n), res: best.res } : null;
  }

  const farm = kind === 'farm';
  const rMin = farm ? 45 : kind === 'windmill' || kind === 'watchtower' ? 50 : 14;
  for (let r = rMin; r < 205; r += 7) {
    const steps = Math.max(8, Math.floor((2 * Math.PI * r) / 9));
    const offset = sim.rng.next() * Math.PI * 2;
    for (let s = 0; s < steps; s++) {
      const a = offset + (s / steps) * Math.PI * 2;
      const e = Math.cos(a) * r, n = Math.sin(a) * r;
      if (!clear(e, n)) continue;
      if (farm) {
        const c = cellOf(site, e, n);
        if (c < 0 || site.fertility[c] < 120) continue;
      }
      return { e, n, ...face(e, n), res: -1 };
    }
  }
  return null;
}

/** Can stone or ore be dug within reach? */
function hasMineral(site: SimSite): boolean {
  for (let k = 0; k < site.mineral.length; k += 3) if (site.mineral[k]) return true;
  return false;
}

function hasSea(site: SimSite): boolean {
  for (let k = 0; k < site.kind.length; k += 5) if (site.kind[k] === 2) return true;
  return false;
}

/**
 * The community decides what to build next from its real situation:
 * crowded homes, thin granary, missing trades. One project at a time for a
 * hamlet, two for a larger place.
 */
export function planConstruction(sim: Simulation, st: SettlementState): void {
  const { pop, adults } = sim.census(st.id);
  if (adults < 3 || st.projects.length >= (pop > 150 ? 2 : 1)) return;
  const site = sim.site(st.id)!;
  const list = sim.buildingsOf(st.id);
  const has = (k: string) => list.some((b) => b.kind === k);
  const done = (k: string) => countKind(list, k);
  let beds = 0;
  for (const b of list) if (b.progress >= 1) beds += dwellingCapacity(b.kind);
  let crowded = 0;
  for (const h of sim.state.households) {
    if (h.settlement !== st.id) continue;
    const home = sim.building(h.building);
    if (!home || h.members.length > dwellingCapacity(home.kind)) crowded++;
  }
  const vacant = list.filter((b) => b.progress >= 1 && dwellingCapacity(b.kind) > 0 && !sim.householdOfBuilding(b.id)).length;
  const foodDays = st.stock[R.Food] / Math.max(1, pop);
  const wants: string[] = [];
  if (crowded > vacant || pop > beds * 0.92) wants.push(st.stock[R.Stone] < 6 && st.stock[R.Wood] < 40 ? 'hut' : 'house');
  if (!has('storehouse')) wants.push('storehouse');
  if (done('farm') < Math.ceil(pop / 12) && (foodDays < 4 || st.forage < sim.forageCapacity(st.id) * 0.35)) wants.push('farm');
  if (!has('dock') && pop >= 25 && hasSea(site)) wants.push('dock');
  if (!has('workshop') && pop >= 30) wants.push('workshop');
  if (pop >= 30 && hasMineral(site) && list.filter((b) => b.kind === 'mine').length < 2) wants.push('mine');
  if (!has('barn') && pop >= 45) wants.push('barn');
  if (!has('market') && pop >= 50) wants.push('market');
  if (!has('windmill') && done('farm') >= 3) wants.push('windmill');
  if (!has('temple') && pop >= 110) wants.push('temple');
  if (!has('watchtower') && pop >= 140) wants.push('watchtower');
  for (const kind of wants) {
    const spot = findSpot(sim, site, kind);
    if (!spot) continue;
    const b = sim.addBuilding({ kind, settlement: st.id, e: spot.e, n: spot.n, fe: spot.fe, fn: spot.fn, radius: FOOTPRINT[kind] ?? 7 }, 0, spot.res);
    st.projects.push(b.id);
    sim.record({ t: sim.state.time, type: 'project', settlement: st.id, what: kind });
    return;
  }
}

/** A builder's shift: turns stocked materials and hours of work into progress. Returns hours actually used. */
export function workOnProject(sim: Simulation, st: SettlementState, b: SimBuilding, hours: number, builder: Person): number {
  const cost = BUILD_COST[b.kind] ?? BUILD_COST.house;
  let dp = Math.min(1 - b.progress, hours / (cost.hours * sim.mods(st.id).buildHours));
  const need = [[R.Wood, cost.wood], [R.Stone, cost.stone], [R.Goods, cost.goods]] as const;
  let f = 1;
  for (const [r, amount] of need) if (amount > 0) f = Math.min(f, st.stock[r] / (amount * dp + 1e-9));
  f = clamp01(f);
  if (f < 0.05) {
    if (!sim.recentEvent('shortage', st.id, 20)) {
      const missing = need.filter(([r, amount]) => amount > 0 && st.stock[r] < amount * dp).map(([r]) => r)[0] ?? R.Wood;
      sim.record({ t: sim.state.time, type: 'shortage', settlement: st.id, what: missing });
    }
    return 0;
  }
  dp *= f;
  for (const [r, amount] of need) st.stock[r] = Math.max(0, st.stock[r] - amount * dp);
  b.progress += dp;
  if (b.progress >= 0.9999) {
    b.progress = 1;
    b.completed = sim.state.time;
    st.tally.built++;
    st.projects = st.projects.filter((id) => id !== b.id);
    sim.record({ t: sim.state.time, type: 'built', settlement: st.id, what: b.kind, a: builder.id, names: [sim.nameOf(builder)] });
    sim.remember(builder, { t: sim.state.time, type: 'built', what: b.kind });
    sim.refreshSite(st.id);
    rehouse(sim, st);
  } else {
    sim.buildingsVersion++;
  }
  return hours * f;
}

// -------------------------------------------------------------- housing
/** Moves a couple living with relatives into a vacant home; fills empty dwellings. */
export function rehouse(sim: Simulation, st: SettlementState): void {
  const time = sim.state.time;
  const capOf = (h: Household) => dwellingCapacity(sim.building(h.building)?.kind ?? '');
  // Families without a roof (colonists, victims of a disaster) take the first free home.
  for (const hh of sim.state.households) {
    if (hh.settlement !== st.id || sim.building(hh.building)) continue;
    const free = sim.buildingsOf(st.id).filter((b) => b.progress >= 1 && dwellingCapacity(b.kind) > 0 && !sim.householdOfBuilding(b.id))
      .sort((a, b) => Math.abs(dwellingCapacity(a.kind) - hh.members.length) - Math.abs(dwellingCapacity(b.kind) - hh.members.length) || a.id - b.id)[0];
    if (!free) continue;
    hh.building = free.id;
    sim.refreshSite(st.id);
    sim.rosterVersion++;
  }
  // A family that has outgrown its home moves into a larger vacant one.
  for (const hh of sim.state.households) {
    if (hh.settlement !== st.id || hh.members.length <= capOf(hh)) continue;
    let best: SimBuilding | null = null;
    for (const b of sim.buildingsOf(st.id)) {
      const cap = dwellingCapacity(b.kind);
      if (b.progress < 1 || cap <= capOf(hh) || sim.householdOfBuilding(b.id)) continue;
      if (!best || cap > dwellingCapacity(best.kind)) best = b;
    }
    if (best) {
      hh.building = best.id;
      sim.refreshSite(st.id);
      sim.rosterVersion++;
    }
  }
  for (const b of sim.buildingsOf(st.id)) {
    if (b.progress < 1 || dwellingCapacity(b.kind) === 0 || sim.householdOfBuilding(b.id)) continue;
    // most crowded household that contains a couple who are not its founders
    let pick: { hh: Household; movers: Person[] } | null = null, worst = 0;
    for (const hh of sim.state.households) {
      if (hh.settlement !== st.id) continue;
      const home = sim.building(hh.building);
      const over = hh.members.length - (home ? dwellingCapacity(home.kind) : 0);
      if (over <= worst && pick) continue;
      const head = hh.members[0];
      for (const id of hh.members) {
        const p = sim.person(id);
        if (!p || !p.spouse || p.id === head || p.spouse === head || !hh.members.includes(p.spouse) || p.id > p.spouse) continue;
        const spouse = sim.person(p.spouse)!;
        const movers = [p, spouse];
        for (const c of p.children) {
          const child = sim.person(c);
          if (child && hh.members.includes(c) && ageAt(child, time) < 16) movers.push(child);
        }
        if (hh.members.length - movers.length < 1) continue;
        if (over > worst || !pick) { worst = over; pick = { hh, movers }; }
        break;
      }
    }
    if (!pick) {
      // no couple to settle: a grown child leaves a crowded home to live on their own
      for (const hh of sim.state.households) {
        if (hh.settlement !== st.id || hh.members.length <= capOf(hh)) continue;
        const over = hh.members.length - capOf(hh);
        for (const id of hh.members.slice(1)) {
          const p = sim.person(id);
          if (!p || p.spouse || ageAt(p, time) < 19 || p.children.some((c) => hh.members.includes(c))) continue;
          if (!pick || over > worst) { worst = over; pick = { hh, movers: [p] }; }
          break;
        }
      }
    }
    if (!pick) continue;
    const share = pick.movers.length / pick.hh.members.length;
    const hh = sim.addHousehold(st.id, b.id, pick.movers[0].lastName, pick.hh.food * share, pick.hh.coins * share);
    pick.hh.food *= 1 - share;
    pick.hh.coins *= 1 - share;
    for (const m of pick.movers) {
      pick.hh.members = pick.hh.members.filter((id) => id !== m.id);
      hh.members.push(m.id);
      m.household = hh.id;
      if (ageAt(m, time) >= 16) sim.remember(m, { t: time, type: 'home' });
    }
    sim.rosterVersion++;
  }
}

// ------------------------------------------------------------ life cycle
function related(a: Person, b: Person): boolean {
  if (a.parents.includes(b.id) || b.parents.includes(a.id)) return true;
  for (const pa of a.parents) if (pa && b.parents.includes(pa)) return true;
  return false;
}

/** Unions, conceptions, births and deaths of old age — once per simulated day. */
export function lifeCycle(sim: Simulation, st: SettlementState): void {
  const s = sim.state;
  const time = s.time;
  const rng = sim.rng;
  const people = s.persons.filter((p) => p.settlement === st.id);
  const single = (p: Person) => (!p.spouse || !sim.person(p.spouse)) && !p.trip;

  // --- unions: two unattached adults who have grown fond of each other
  for (const w of people) {
    if (w.sex !== 0 || !single(w)) continue;
    const aw = ageAt(w, time);
    if (aw < 17 || aw > 48) continue;
    let best: Person | null = null, bestBond = 0.28;
    for (const m of people) {
      if (m.sex !== 1 || !single(m) || related(w, m)) continue;
      const am = ageAt(m, time);
      if (am < 17 || am > 60 || Math.abs(am - aw) > 16) continue;
      const bond = Math.min(w.bonds[m.id] ?? 0, m.bonds[w.id] ?? 0);
      if (bond > bestBond) { bestBond = bond; best = m; }
    }
    if (!best || rng.next() > 0.06) continue;
    const m = best;
    w.spouse = m.id;
    m.spouse = w.id;
    sim.remember(w, { t: time, type: 'married', ref: m.id });
    sim.remember(m, { t: time, type: 'married', ref: w.id });
    st.tally.marriages++;
    sim.record({ t: time, type: 'marriage', settlement: st.id, a: w.id, b: m.id, names: [sim.nameOf(w), sim.nameOf(m)] });
    // the bride or groom joins the roomier household; a home of their own comes when one is free
    if (w.household !== m.household) {
      const hw = sim.household(w.household)!, hm = sim.household(m.household)!;
      const room = (h: Household) => dwellingCapacity(sim.building(h.building)?.kind ?? '') - h.members.length;
      const [mover, from, to] = room(hw) >= room(hm) ? [m, hm, hw] : [w, hw, hm];
      sim.moveToHousehold(mover, from, to);
      for (const c of mover.children) {
        const child = sim.person(c);
        if (child && child.household === from.id && ageAt(child, time) < 16) sim.moveToHousehold(child, from, to);
      }
    }
    w.lastName = m.lastName;
  }
  rehouse(sim, st);

  // --- conceptions and births
  for (const w of people) {
    if (w.sex !== 0) continue;
    if (w.pregnantUntil) {
      if (time >= w.pregnantUntil) sim.birth(w);
      continue;
    }
    const age = ageAt(w, time);
    const father = w.spouse ? sim.person(w.spouse) : undefined;
    if (age < 18 || age > 43 || !father || father.settlement !== st.id) continue;
    if (time - w.lastBirth < 1.3 * SECONDS_PER_YEAR || w.health < 0.6 || w.needs[0] < 0.3) continue;
    const hh = sim.household(w.household)!;
    const cap = dwellingCapacity(sim.building(hh.building)?.kind ?? '');
    if (hh.members.length >= cap + 2) continue; // no room for another child
    if (rng.next() < (1 / 300) * (st.blessedUntil > time ? 1.6 : 1)) w.pregnantUntil = time + 270 * SECONDS_PER_DAY;
  }

  // --- old age
  for (const p of people) {
    const age = ageAt(p, time);
    if (age < 55 || p.trip) continue;
    if (rng.next() < 0.00004 * Math.exp((age - 55) / 7) * sim.mods(st.id).mortality * (st.blessedUntil > time ? 0.5 : 1)) sim.kill(p, 'age');
  }
}

/** Everything a settlement does once per simulated day. */
export function dailyUpdate(sim: Simulation): void {
  const s = sim.state;
  const day = Math.floor(s.time / SECONDS_PER_DAY);
  const newYear = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR === 0;
  for (const st of s.settlements) {
    const { pop } = sim.census(st.id);
    if (newYear) {
      // close the year in the annals: exact figures, kept for ever
      const ty = st.tally;
      if (pop > 0 || ty.births + ty.deaths + ty.built > 0) {
        s.annals.push({ id: s.annals.length + 1, year: Math.round(day / DAYS_PER_YEAR), settlement: st.id, civ: st.civ, pop, harvest: st.harvest, ...ty });
      }
      st.tally = emptyTally();
    }
    const cap = sim.forageCapacity(st.id);
    st.forage = Math.min(cap, st.forage + cap * 0.5 * (st.droughtUntil > s.time ? 0.4 : 1) * (st.gameUntil > s.time ? 1.8 : 1));
    if (pop === 0) continue;
    st.stock[R.Food] *= 1 - sim.mods(st.id).spoilage; // granary losses: food does not keep forever
    // an idle, overflowing common purse is shared out again among the households
    const reserve = 150 + pop * 2;
    if (st.treasury > reserve && !st.projects.length) {
      const members = Math.max(1, pop);
      const out = (st.treasury - reserve) * 0.1;
      for (const h of s.households) if (h.settlement === st.id) h.coins += (out * h.members.length) / members;
      st.treasury -= out;
    }
    // tithe: comfortable households fund the common purse (builders' wages, purchases)
    for (const h of s.households) {
      if (h.settlement !== st.id || h.coins <= 20) continue;
      const due = (h.coins - 20) * 0.03;
      h.coins -= due;
      st.treasury += due;
    }
    if (newYear) {
      st.harvest = Math.max(sim.mods(st.id).harvestFloor, 0.55 + sim.rng.next() * 0.75);
      if (st.harvest < 0.72 || st.harvest > 1.18) sim.record({ t: s.time, type: 'harvest', settlement: st.id, value: st.harvest });
    }
    // famine: the granary and the pantries are empty for days
    let pantry = 0;
    for (const h of s.households) if (h.settlement === st.id) pantry += h.food;
    if (st.stock[R.Food] < 1 && pantry < pop * 0.4) {
      st.hungryDays++;
      if (st.hungryDays === 4 && !sim.recentEvent('famine', st.id, 90)) sim.record({ t: s.time, type: 'famine', settlement: st.id });
    } else st.hungryDays = 0;
    lifeCycle(sim, st);
    updatePrices(sim, st);
    assignJobs(sim, st);
    planConstruction(sim, st);
  }
  civilizationsDaily(sim);
  diplomacyDaily(sim);
  divineDaily(sim);
}
