import { Rng, hashString } from '../core/rng';
import { clamp01 } from '../core/math';
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, TICK_SECONDS, localHour, seasonPhase } from './clock';
import { addResearch, contact, foundCivilization, onDeath } from './civilization';
import { BUILD_COST, ageAt, countKind, dailyUpdate, isAdult, stockTargets, updatePrices, workOnProject } from './economy';
import { BASE_MODS, modsFor, type Mods } from './tech';
import { cellOf, findPath, isWalkable, nearestWalkable } from './pathfinding';
import { blankPerson, createPopulation } from './populate';
import { dwellingCapacity } from './sites';
import {
  ACTIVITY_COUNT, Activity, BASE_PRICE, J, JOB_COUNT, N, Phase, R, RESOURCE_COUNT, SIM_STATE_VERSION, SKILL_EXPLORE, SKILL_SOCIAL, T,
  type Civilization, type DeadPerson, type EconomyView, type FoundingBuilding, type Household, type Memory, type Person, type PersonView, type PopulationSummary,
  type RosterEntry, type SettlementState, type SettlementView, type SimBuilding, type SimEvent, type SimEventType, type SearchHit, type SimSite, type SimState, type Snapshot, type WorldView,
} from './types';

const TICK = TICK_SECONDS;
const HOUR = 3600;
/** Walking speed in metres per simulated second (see clock.ts: tuned so walks are watchable at ×1). */
const WALK_SPEED = 0.022;
const TRAVEL_SPEED = WALK_SPEED * 1.5;
const MAX_MEMORIES = 40;
const MAX_BONDS = 24;
const MAX_EVENTS = 4000;
/** Share of a sale that reaches the producer; the rest funds the community (builders' wages). */
const PRODUCER_SHARE = 0.8;
const BUILDER_WAGE = 0.6; // coins per hour
/** Main resource produced by each profession (-1: none / varies). */
const JOB_OUTPUT = [R.Food, R.Food, R.Food, R.Food, R.Wood, R.Stone, -1, R.Tools, R.Goods, -1, -1, -1];

interface SiteCache {
  depot: { e: number; n: number };
  plaza: { e: number; n: number };
  water: { e: number; n: number }[];
  forageCapacity: number;
  windmill: boolean;
  temple: { e: number; n: number } | null;
}

/**
 * The living society. Pure and deterministic: a fixed time step, its own
 * serialisable random stream, no access to wall-clock time, rendering or DOM.
 * Runs inside a Web Worker in the game and directly in Node for the tests.
 *
 * Each inhabitant picks what to do with a utility AI: every possible action
 * gets a score from the person's needs, personality and context (hour,
 * pantry, prices, season); the best feasible one is carried out.
 * Settlement-level rules (labour market, prices, construction planning,
 * unions and births) live in economy.ts and run once per simulated day.
 */
export class Simulation {
  readonly state: SimState;
  readonly rng: Rng;
  private sites = new Map<number, SimSite>();
  private baseSites = new Map<number, SimSite>();
  private byId = new Map<number, Person>();
  private households = new Map<number, Household>();
  private buildings = new Map<number, SimBuilding>();
  private bySite = new Map<number, SimBuilding[]>();
  private settlements = new Map<number, SettlementState>();
  private homeDoor = new Map<number, { e: number; n: number }>();
  private cache = new Map<number, SiteCache>();
  private censusTick = -1;
  private censusData = new Map<number, { pop: number; adults: number }>();
  private causes = new Map<number, DeadPerson['cause']>();
  private modsCache = new Map<number, Mods>();
  /** Bumped whenever the set of living people (or their jobs / homes) changes. */
  rosterVersion = 0;
  /** Bumped whenever a building is added or progresses. */
  buildingsVersion = 0;

  constructor(sites: SimSite[], state: SimState) {
    this.state = state;
    this.rng = new Rng(0);
    this.rng.state = state.rng;
    for (const s of sites) {
      this.baseSites.set(s.id, s);
      this.sites.set(s.id, { ...s, walk: new Uint8Array(s.walk) });
    }
    for (const p of state.persons) this.byId.set(p.id, p);
    for (const st of state.settlements) this.settlements.set(st.id, st);
    for (const b of state.buildings) {
      this.buildings.set(b.id, b);
      if (!this.bySite.has(b.settlement)) this.bySite.set(b.settlement, []);
      this.bySite.get(b.settlement)!.push(b);
    }
    for (const h of state.households) this.households.set(h.id, h);
    for (const s of sites) this.refreshSite(s.id);
  }

  /** Founds a new society on a freshly generated world. */
  static create(seed: string, sites: SimSite[], founding: FoundingBuilding[], population: number, time: number): Simulation {
    const rng = new Rng(hashString(seed) ^ 0x50b);
    const buildings: SimBuilding[] = founding.map((f, i) => ({
      id: i + 1, kind: f.kind, settlement: f.settlement, e: f.e, n: f.n, fe: f.fe, fn: f.fn, radius: f.radius,
      progress: 1, started: time, completed: time, res: -1, produced: 0,
    }));
    const founders = createPopulation(rng, sites, buildings, population, time);
    const settlements: SettlementState[] = sites.map((s) => {
      const pop = founders.persons.filter((p) => p.settlement === s.id).length;
      const stock = new Array<number>(RESOURCE_COUNT).fill(0);
      if (pop) {
        stock[R.Food] = pop * 2.5;
        stock[R.Wood] = 45;
        stock[R.Stone] = 18;
        stock[R.Tools] = 3;
      }
      return { id: s.id, stock, prices: [...BASE_PRICE], treasury: pop ? 250 : 0, forage: 1e9, harvest: 1, projects: [], hungryDays: 0, civ: 0, founded: time };
    });
    const events: SimEvent[] = settlements.filter((st) => st.treasury > 0).map((st) => ({ t: time, type: 'founded' as const, settlement: st.id }));
    const state: SimState = {
      version: SIM_STATE_VERSION, time, tick: 0, rng: rng.fork('simulation').state, nextId: founders.nextId,
      persons: founders.persons, households: founders.households, dead: [],
      buildings, settlements, events, civs: [], religions: [], nextBuildingId: buildings.length + 1, stride: 1,
    };
    const sim = new Simulation(sites, state);
    for (const st of settlements) {
      st.forage = sim.forageCapacity(st.id);
      updatePrices(sim, st);
      // each founding community is a people of its own, with its first chief
      if (st.treasury > 0) foundCivilization(sim, st);
    }
    state.rng = sim.rng.state;
    return sim;
  }

  // ------------------------------------------------------------ accessors
  person(id: number): Person | undefined { return this.byId.get(id); }
  household(id: number): Household | undefined { return this.households.get(id); }
  building(id: number): SimBuilding | undefined { return this.buildings.get(id); }
  buildingsOf(site: number): SimBuilding[] { return this.bySite.get(site) ?? []; }
  /** Settlement map including building footprints. */
  site(id: number): SimSite | undefined { return this.sites.get(id); }
  /** Settlement map of the bare terrain. */
  baseSite(id: number): SimSite { return this.baseSites.get(id)!; }
  settlement(id: number): SettlementState | undefined { return this.settlements.get(id); }
  nameOf(p: { firstName: string; lastName: string }): string { return `${p.firstName} ${p.lastName}`; }
  forageCapacity(site: number): number { return this.cache.get(site)?.forageCapacity ?? 0; }
  /** Civilisation a settlement belongs to. */
  civOf(settlement: number): Civilization | undefined {
    const id = this.settlements.get(settlement)?.civ;
    return id ? this.state.civs[id - 1] : undefined;
  }
  /** What a civilisation's technologies change in practice. */
  modsOf(civ: Civilization): Mods {
    let m = this.modsCache.get(civ.id);
    if (!m) this.modsCache.set(civ.id, (m = modsFor(civ.techs)));
    return m;
  }
  mods(settlement: number): Mods {
    const civ = this.civOf(settlement);
    return civ ? this.modsOf(civ) : BASE_MODS;
  }
  modsChanged(): void { this.modsCache.clear(); }

  householdOfBuilding(building: number): Household | undefined {
    for (const h of this.state.households) if (h.building === building) return h;
    return undefined;
  }

  census(site: number): { pop: number; adults: number } {
    if (this.censusTick !== this.state.tick) {
      this.censusTick = this.state.tick;
      this.censusData.clear();
      const t = this.state.time;
      for (const p of this.state.persons) {
        let c = this.censusData.get(p.settlement);
        if (!c) this.censusData.set(p.settlement, (c = { pop: 0, adults: 0 }));
        c.pop++;
        if (isAdult(p, t)) c.adults++;
      }
    }
    return this.censusData.get(site) ?? { pop: 0, adults: 0 };
  }

  /** Deep copy of the whole state, safe to store or send to another thread. */
  serialize(): SimState {
    this.state.rng = this.rng.state;
    return JSON.parse(JSON.stringify(this.state)) as SimState;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  // ------------------------------------------------- buildings & site maps
  private doorOf(b: SimBuilding): { e: number; n: number } {
    const reach = b.radius * 0.72 + 1.2;
    return { e: b.e + b.fe * reach, n: b.n + b.fn * reach };
  }

  /** Rebuilds the walkability map and the cached places of a settlement after its buildings changed. */
  refreshSite(id: number): void {
    const base = this.baseSites.get(id), site = this.sites.get(id);
    if (!base || !site) return;
    site.walk.set(base.walk);
    const half = (site.size * site.cell) / 2;
    const list = this.buildingsOf(id);
    for (const b of list) {
      if (b.kind === 'dock' || b.kind === 'market' || b.kind === 'farm') continue;
      const r = b.radius * 0.62;
      const i0 = Math.floor((b.e - r + half) / site.cell), i1 = Math.floor((b.e + r + half) / site.cell);
      const j0 = Math.floor((b.n - r + half) / site.cell), j1 = Math.floor((b.n + r + half) / site.cell);
      for (let j = Math.max(0, j0); j <= Math.min(site.size - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(site.size - 1, i1); i++) {
          const e = (i + 0.5) * site.cell - half, n = (j + 0.5) * site.cell - half;
          if (Math.hypot(e - b.e, n - b.n) < r) site.walk[j * site.size + i] = 0;
        }
      }
    }
    const done = (k: string) => list.find((b) => b.kind === k && b.progress >= 1);
    const snap = (pt: { e: number; n: number }) => nearestWalkable(site, pt.e, pt.n, 8) ?? pt;
    const well = done('well'), market = done('market'), store = done('storehouse');
    const plaza = snap(market ? this.doorOf(market) : well ? this.doorOf(well) : { e: 0, n: 0 });
    const depot = store ? snap(this.doorOf(store)) : plaza;
    const water = [...(well ? [snap(this.doorOf(well))] : []), ...base.water];
    let forage = 0;
    for (let k = 0; k < base.forage.length; k++) forage += base.forage[k];
    // What the wild can feed each day: enough for a hamlet, never for a town.
    const temple = done('temple');
    this.cache.set(id, { depot, plaza, water, forageCapacity: forage / 255 / 100, windmill: !!done('windmill'), temple: temple ? snap(this.doorOf(temple)) : null });
    for (const h of this.state.households) {
      if (h.settlement !== id) continue;
      const b = this.buildings.get(h.building);
      if (b) this.homeDoor.set(h.id, snap(this.doorOf(b)));
    }
    this.buildingsVersion++;
  }

  addBuilding(f: FoundingBuilding, progress: number, res = -1): SimBuilding {
    const s = this.state;
    const b: SimBuilding = {
      id: s.nextBuildingId++, kind: f.kind, settlement: f.settlement, e: f.e, n: f.n, fe: f.fe, fn: f.fn, radius: f.radius,
      progress, started: s.time, completed: progress >= 1 ? s.time : 0, res, produced: 0,
    };
    s.buildings.push(b);
    this.buildings.set(b.id, b);
    if (!this.bySite.has(b.settlement)) this.bySite.set(b.settlement, []);
    this.bySite.get(b.settlement)!.push(b);
    this.refreshSite(b.settlement);
    return b;
  }

  addHousehold(settlement: number, building: number, name: string, food: number, coins: number): Household {
    const s = this.state;
    let id = 1;
    for (const h of s.households) if (h.id >= id) id = h.id + 1;
    const hh: Household = { id, name, settlement, building, members: [], food, coins };
    s.households.push(hh);
    this.households.set(id, hh);
    const b = this.buildings.get(building), site = this.sites.get(settlement);
    if (b && site) this.homeDoor.set(id, nearestWalkable(site, this.doorOf(b).e, this.doorOf(b).n, 8) ?? this.doorOf(b));
    return hh;
  }

  moveToHousehold(p: Person, from: Household, to: Household): void {
    from.members = from.members.filter((id) => id !== p.id);
    if (!to.members.includes(p.id)) to.members.push(p.id);
    p.household = to.id;
    if (!from.members.length) {
      // the last one to leave takes the pantry and the purse along
      to.food += from.food;
      to.coins += from.coins;
      this.dropHousehold(from);
    }
    this.rosterVersion++;
  }

  private dropHousehold(hh: Household): void {
    this.households.delete(hh.id);
    this.state.households = this.state.households.filter((h) => h !== hh);
    this.homeDoor.delete(hh.id);
  }

  // --------------------------------------------------------------- events
  record(e: SimEvent): void {
    const ev = this.state.events;
    ev.push(e);
    if (ev.length > MAX_EVENTS) {
      // keep the milestones, forget the oldest everyday entry
      const idx = ev.findIndex((x) => x.type === 'birth' || x.type === 'trade' || x.type === 'shortage' || x.type === 'project');
      ev.splice(idx >= 0 ? idx : 0, 1);
    }
  }

  recentEvent(type: SimEventType, settlement: number, days: number): boolean {
    const since = this.state.time - days * SECONDS_PER_DAY;
    const ev = this.state.events;
    for (let i = ev.length - 1; i >= 0; i--) {
      if (ev[i].t < since) return false;
      if (ev[i].type === type && ev[i].settlement === settlement) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ step
  /** Coarseness of the simulation: 1 = every tick; higher values merge ticks at very high speeds. */
  setStride(stride: number): void {
    this.state.stride = Math.max(1, Math.min(30, Math.round(stride)));
  }

  step(): void {
    const s = this.state;
    const stride = s.stride;
    const dt = TICK * stride;
    const dayBefore = Math.floor(s.time / SECONDS_PER_DAY);
    s.time += dt;
    s.tick++;
    const persons = s.persons;
    let died = false;
    for (let i = 0; i < persons.length; i++) {
      const p = persons[i];
      const site = this.sites.get(p.settlement)!;
      this.updateNeeds(p, site, dt);
      if (p.health <= 0) {
        died = true;
        continue;
      }
      if (p.trip) {
        this.travel(p);
        continue;
      }
      if (ageAt(p, s.time) < 4) {
        this.infant(p);
        continue;
      }
      if (p.phase === Phase.Do) {
        if (p.activity === Activity.Trading || p.activity === Activity.Migrating) {
          this.decide(p, site); // journey over
        } else if (p.activity === Activity.Sleeping) {
          // people sleep through the night and rise with the day
          const h = localHour(s.time, site.longitude);
          const day = h >= 5.5 && h < 21;
          if ((day && p.needs[N.Sleep] > 0.7) || s.time >= p.until) this.finish(p, site);
        } else if (s.time >= p.until) this.finish(p, site);
        else if ((s.tick + p.id) % 15 === 0 && this.critical(p)) this.decide(p, site);
      } else {
        this.move(p, site, dt);
      }
    }
    if (died) this.bury();
    if (Math.floor(s.time / SECONDS_PER_DAY) !== dayBefore) dailyUpdate(this);
    s.rng = this.rng.state;
  }

  private critical(p: Person): boolean {
    if (p.activity === Activity.Eating || p.activity === Activity.Drinking || p.trip) return false;
    return p.needs[N.Water] < 0.12 || (p.needs[N.Food] < 0.12 && p.activity !== Activity.Foraging && p.activity !== Activity.Shopping);
  }

  /** Infants stay at home and are fed from the family pantry. */
  private infant(p: Person): void {
    p.inside = true;
    p.activity = Activity.Resting;
    p.phase = Phase.Do;
    const hh = this.households.get(p.household);
    const door = this.home(p);
    p.e = door.e;
    p.n = door.n;
    p.needs[N.Water] = 1;
    p.needs[N.Sleep] = 1;
    p.needs[N.Social] = 1;
    if (p.needs[N.Food] < 0.5 && hh && hh.food >= 0.4) {
      hh.food -= 0.4;
      p.needs[N.Food] = 1;
      p.counts.meals++;
    }
  }

  private updateNeeds(p: Person, site: SimSite, dt: number): void {
    const t = this.state.time;
    const nd = p.needs;
    const asleep = p.activity === Activity.Sleeping && p.phase === Phase.Do;
    const k = asleep ? 0.5 : 1;
    nd[N.Food] = Math.max(0, nd[N.Food] - (dt / (1.15 * SECONDS_PER_DAY)) * k);
    nd[N.Water] = Math.max(0, nd[N.Water] - (dt / (0.75 * SECONDS_PER_DAY)) * k);
    if (asleep) nd[N.Sleep] = Math.min(1, nd[N.Sleep] + dt / (9 * HOUR));
    else nd[N.Sleep] = Math.max(0, nd[N.Sleep] - dt / (24 * HOUR));
    if (!(p.activity === Activity.Socializing && p.phase === Phase.Do)) {
      nd[N.Social] = Math.max(0, nd[N.Social] - (dt / (2.5 * SECONDS_PER_DAY)) * (0.6 + 0.8 * p.traits[T.Sociability]));
    }
    if (p.trip) {
      // travellers carry provisions and keep each other company
      nd[N.Food] = Math.max(nd[N.Food], 0.5);
      nd[N.Water] = Math.max(nd[N.Water], 0.5);
      nd[N.Sleep] = Math.max(nd[N.Sleep], 0.35);
    }
    const h = localHour(t, site.longitude);
    const night = h < 5.5 || h >= 21;
    const far = Math.hypot(p.e, p.n) > site.radius + 25;
    const cold = this.seasonalTemperature(site) < 3;
    const steps = dt / TICK;
    const safeTarget = p.inside ? 1 : clamp01((night ? (far ? 0.25 : 0.5) : far ? 0.7 : 0.9) + p.traits[T.Courage] * 0.25);
    nd[N.Safety] += (safeTarget - nd[N.Safety]) * (1 - Math.pow(0.98, steps));
    const shelterTarget = p.inside ? 1 : clamp01((night ? 0.45 : 0.85) - (cold ? 0.25 : 0));
    nd[N.Shelter] += (shelterTarget - nd[N.Shelter]) * (1 - Math.pow(0.99, steps));

    // health: starvation and thirst kill, a satisfied body recovers
    if (nd[N.Water] < 0.04) { p.health -= dt / (1.5 * SECONDS_PER_DAY); if (p.health <= 0) this.causes.set(p.id, 'thirst'); }
    else if (nd[N.Food] < 0.04) { p.health -= dt / (4 * SECONDS_PER_DAY); if (p.health <= 0) this.causes.set(p.id, 'starvation'); }
    else if (p.health < 1 && nd[N.Food] > 0.3 && nd[N.Water] > 0.3) p.health = Math.min(1, p.health + dt / (5 * SECONDS_PER_DAY));
    if (nd[N.Food] < 0.06 && !this.recent(p, 'hunger', 10)) this.remember(p, { t, type: 'hunger' });
  }

  private seasonalTemperature(site: SimSite): number {
    return site.temperature + seasonPhase(this.state.time) * Math.max(-1, Math.min(1, site.sinLatitude * 1.6)) * 11;
  }

  private seasonFactor(site: SimSite): number {
    const t = this.seasonalTemperature(site);
    return t < 2 ? 0.45 : t < 8 ? 0.75 : 1;
  }

  // ------------------------------------------------------------- movement
  private move(p: Person, site: SimSite, dt: number): void {
    const age = ageAt(p, this.state.time);
    let budget = WALK_SPEED * dt * (age < 10 ? 0.7 : age > 62 ? 0.72 : 1);
    while (budget > 0 && p.path.length >= 2) {
      const we = p.path[0], wn = p.path[1];
      const d = Math.hypot(we - p.e, wn - p.n);
      if (d <= budget) {
        p.e = we;
        p.n = wn;
        p.path.splice(0, 2);
        budget -= d;
      } else {
        p.e += ((we - p.e) / d) * budget;
        p.n += ((wn - p.n) / d) * budget;
        budget = 0;
      }
    }
    if (p.path.length < 2) this.arrive(p, site);
  }

  /** Starts walking to a destination. Returns false when it cannot be reached. */
  private goTo(p: Person, site: SimSite, e: number, n: number): boolean {
    const dest = nearestWalkable(site, e, n, 5);
    if (!dest) return false;
    // Aggregated simulation (very high speeds): steps span tens of metres, so routes are not traced.
    const path = this.state.stride >= 6 ? [dest.e, dest.n] : findPath(site, p.e, p.n, dest.e, dest.n);
    if (!path) return false;
    p.path = path;
    p.te = dest.e;
    p.tn = dest.n;
    p.inside = false;
    return true;
  }

  private home(p: Person): { e: number; n: number } {
    return this.homeDoor.get(p.household) ?? this.cache.get(p.settlement)?.plaza ?? { e: 0, n: 0 };
  }

  private begin(p: Person, activity: Activity, phase: Phase, duration = 0): void {
    p.activity = activity;
    p.phase = phase;
    p.until = this.state.time + duration;
  }

  // -------------------------------------------------------------- arrival
  private arrive(p: Person, site: SimSite): void {
    const rng = this.rng;
    if (p.phase === Phase.Return) {
      this.deliver(p);
      this.decide(p, site);
      return;
    }
    switch (p.activity) {
      case Activity.Eating: p.inside = true; this.begin(p, Activity.Eating, Phase.Do, 20 * 60); break;
      case Activity.Sleeping: p.inside = true; this.begin(p, Activity.Sleeping, Phase.Do, 13 * HOUR); break;
      case Activity.Resting: p.inside = true; this.begin(p, Activity.Resting, Phase.Do, (40 + rng.next() * 50) * 60); break;
      case Activity.Drinking: this.begin(p, Activity.Drinking, Phase.Do, 6 * 60); break;
      case Activity.Foraging: this.begin(p, Activity.Foraging, Phase.Do, (80 + rng.next() * 30) * 60); break;
      case Activity.Wandering: this.begin(p, Activity.Wandering, Phase.Do, (8 + rng.next() * 10) * 60); break;
      case Activity.Playing: this.begin(p, Activity.Playing, Phase.Do, (15 + rng.next() * 20) * 60); break;
      case Activity.Working: {
        const indoors = p.job === J.Smith || p.job === J.Artisan || p.job === J.Miner || p.job === J.Researcher || p.job === J.Leader;
        p.inside = indoors;
        this.begin(p, Activity.Working, Phase.Do, (2.7 + rng.next() * 0.6) * HOUR);
        break;
      }
      case Activity.Building: this.begin(p, Activity.Building, Phase.Do, (2.7 + rng.next() * 0.6) * HOUR); break;
      case Activity.Shopping: this.begin(p, Activity.Shopping, Phase.Do, 10 * 60); break;
      case Activity.Praying: p.inside = true; this.begin(p, Activity.Praying, Phase.Do, (30 + rng.next() * 25) * 60); break;
      case Activity.Trading: this.depart(p, site); break;
      case Activity.Socializing: {
        const other = this.byId.get(p.partner);
        const free = other && !other.inside && other.partner === 0 && !other.trip &&
          (other.phase !== Phase.Do || other.activity === Activity.Idle || other.activity === Activity.Wandering || other.activity === Activity.Playing) &&
          other.activity !== Activity.Sleeping && Math.hypot(other.e - p.e, other.n - p.n) < 14 &&
          other.needs[N.Water] > 0.15 && other.needs[N.Food] > 0.15;
        if (other && free) {
          const dur = (25 + rng.next() * 30) * 60;
          this.begin(p, Activity.Socializing, Phase.Do, dur);
          other.path = [];
          other.partner = -p.id; // passive side of the conversation
          this.begin(other, Activity.Socializing, Phase.Do, dur);
        } else {
          p.partner = 0;
          this.begin(p, Activity.Socializing, Phase.Do, 15 * 60);
        }
        break;
      }
      default: this.begin(p, Activity.Idle, Phase.Do, 10 * 60);
    }
  }

  /** End of a carrying trip: fill the pantry or the communal stock, and get paid. */
  private deliver(p: Person): void {
    const hh = this.households.get(p.household)!;
    const st = this.settlements.get(p.settlement)!;
    if (p.carry <= 0) return;
    if (p.activity === Activity.Working || p.activity === Activity.Trading) {
      // sold to the community
      const value = st.prices[p.carryRes] * p.carry * PRODUCER_SHARE;
      const paid = Math.min(Math.max(0, st.treasury), value);
      st.stock[p.carryRes] += p.carry;
      st.treasury -= paid;
      hh.coins += paid;
    } else {
      hh.food += p.carry;
      this.shareSurplus(p, hh);
    }
    p.carry = 0;
  }

  // ---------------------------------------------------- end of an action
  private finish(p: Person, site: SimSite): void {
    const t = this.state.time;
    const rng = this.rng;
    const hh = this.households.get(p.household)!;
    const st = this.settlements.get(p.settlement)!;
    const age = ageAt(p, t);
    const learn = (skill: number, rate = 0.004) => { p.skills[skill] = Math.min(1, p.skills[skill] + rate * (0.5 + p.traits[T.Intelligence])); };
    switch (p.activity) {
      case Activity.Eating: {
        const portion = age < 10 ? 0.6 : 1;
        if (p.carry >= portion && p.carryRes === R.Food) p.carry -= portion;
        else if (hh.food >= portion * 0.5) hh.food = Math.max(0, hh.food - portion);
        else break; // the pantry was emptied meanwhile
        p.needs[N.Food] = 1;
        p.counts.meals++;
        break;
      }
      case Activity.Drinking: p.needs[N.Water] = 1; break;
      case Activity.Foraging: {
        const c = cellOf(site, p.e, p.n);
        const q = c >= 0 ? site.forage[c] / 255 : 0.2;
        const cap = this.forageCapacity(site.id);
        // the wild only gives so much: over-gathered land yields less
        const abundance = Math.max(0.15, Math.min(1, st.forage / (cap * 0.5 + 1e-6)));
        const got = (0.8 + 2.8 * q * (0.5 + p.skills[J.Gatherer])) * (0.85 + 0.3 * rng.next()) * this.seasonFactor(site) * abundance * this.mods(site.id).forage;
        st.forage = Math.max(0, st.forage - got);
        p.carry = got;
        p.carryRes = R.Food;
        learn(J.Gatherer);
        p.counts.forages++;
        if (p.needs[N.Food] < 0.25 && hh.food < 1 && p.carry >= 1) {
          p.carry -= 1;
          p.needs[N.Food] = 1;
          p.counts.meals++;
        }
        // a well-stocked household sells its surplus to the granary
        const surplus = hh.food > hh.members.length * 4 && st.prices[R.Food] >= BASE_PRICE[R.Food] * 0.6;
        const dest = surplus ? this.cache.get(site.id)!.depot : this.home(p);
        if (this.goTo(p, site, dest.e, dest.n)) {
          if (surplus) p.activity = Activity.Working;
          p.phase = Phase.Return;
          return;
        }
        hh.food += p.carry;
        p.carry = 0;
        break;
      }
      case Activity.Working: {
        p.inside = false;
        const out = this.produce(p, site, st);
        p.counts.shifts++;
        if (out && out.qty > 0) {
          learn(p.job);
          p.carry = out.qty;
          p.carryRes = out.res;
          const depot = this.cache.get(site.id)!.depot;
          if (this.goTo(p, site, depot.e, depot.n)) {
            p.phase = Phase.Return;
            return;
          }
          this.deliver(p);
        }
        break;
      }
      case Activity.Building: {
        const b = st.projects.length ? this.buildings.get(st.projects[0]) : undefined;
        p.counts.shifts++;
        if (b) {
          const hours = 3 * (0.6 + p.skills[J.Builder]) * this.toolBonus(st);
          const used = workOnProject(this, st, b, hours, p);
          if (used > 0) {
            learn(J.Builder);
            const wage = Math.min(Math.max(0, st.treasury), used * BUILDER_WAGE);
            st.treasury -= wage;
            hh.coins += wage;
          }
        }
        break;
      }
      case Activity.Shopping: {
        const want = Math.max(0, hh.members.length * 3 - hh.food);
        const afford = Math.max(0, (hh.coins + 30) / st.prices[R.Food]);
        const qty = Math.min(want, st.stock[R.Food], afford);
        if (qty > 0.2) {
          const cost = qty * st.prices[R.Food];
          st.stock[R.Food] -= qty;
          st.treasury += cost;
          hh.coins -= cost;
          p.carry = qty;
          p.carryRes = R.Food;
          const door = this.home(p);
          if (this.goTo(p, site, door.e, door.n)) {
            p.phase = Phase.Return;
            return;
          }
          hh.food += qty;
          p.carry = 0;
        }
        break;
      }
      case Activity.Praying: {
        p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.25);
        p.needs[N.Safety] = Math.min(1, p.needs[N.Safety] + 0.3);
        const rel = this.state.religions[p.faith - 1];
        if (rel) rel.fervor = Math.min(1, rel.fervor + 0.0015);
        break;
      }
      case Activity.Socializing: {
        const other = this.byId.get(Math.abs(p.partner));
        if (other && p.partner !== 0) {
          p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.5);
          learn(SKILL_SOCIAL, 0.003);
          p.counts.chats++;
          if (p.partner > 0) this.updateBond(p, other);
        } else {
          p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.12);
        }
        p.partner = 0;
        break;
      }
      case Activity.Wandering: {
        learn(SKILL_EXPLORE);
        p.counts.explorations++;
        if (Math.hypot(p.e, p.n) > site.radius + 70 && !this.recent(p, 'discovery', 30)) {
          this.remember(p, { t, type: 'discovery', place: site.name });
        }
        break;
      }
      case Activity.Playing: {
        for (const id of hh.members) {
          const o = this.byId.get(id);
          if (o && o !== p && o.activity === Activity.Playing) p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.1);
        }
        p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.12);
        break;
      }
      default: break;
    }
    this.decide(p, site);
  }

  /** Tools make every trade more productive; each shift wears them a little. */
  private toolBonus(st: SettlementState): number {
    if (st.stock[R.Tools] < 0.5) return 1;
    const m = this.mods(st.id);
    st.stock[R.Tools] = Math.max(0, st.stock[R.Tools] - 0.004 * m.toolWear);
    return m.tools;
  }

  /** Output of one work shift, according to the profession and the real land. */
  private produce(p: Person, site: SimSite, st: SettlementState): { res: number; qty: number } | null {
    const skill = 0.6 + p.skills[p.job];
    const vary = 0.85 + 0.3 * this.rng.next();
    const b = this.buildings.get(p.workplace);
    const credit = (qty: number) => { if (b) b.produced += qty; return qty; };
    const m = this.mods(st.id);
    const hh = this.households.get(p.household)!;
    const stipend = (coins: number) => {
      const paid = Math.min(Math.max(0, st.treasury), coins);
      st.treasury -= paid;
      hh.coins += paid;
    };
    switch (p.job) {
      case J.Researcher: {
        // study, observation, trial and error: knowledge accumulates for the whole people
        const civ = this.civOf(st.id);
        if (civ) addResearch(this, civ, 0.045 * skill * (0.6 + p.traits[T.Intelligence]) * m.research, p);
        p.skills[J.Researcher] = Math.min(1, p.skills[J.Researcher] + 0.004 * (0.5 + p.traits[T.Intelligence]));
        stipend(1.5);
        return null;
      }
      case J.Leader: {
        // holding council, settling disputes: a present ruler is a respected one
        const civ = this.civOf(st.id);
        if (civ && civ.leader === p.id) civ.legitimacy = Math.min(1, civ.legitimacy + 0.0006 * (0.5 + p.traits[T.Sociability]));
        p.skills[J.Leader] = Math.min(1, p.skills[J.Leader] + 0.003 * (0.5 + p.traits[T.Intelligence]));
        stipend(2);
        return null;
      }
      case J.Farmer: {
        if (!b) return null;
        const c = cellOf(site, b.e, b.n);
        const soil = c >= 0 ? site.fertility[c] / 255 : 0.4;
        const mill = this.cache.get(site.id)?.windmill ? 1.15 : 1;
        return { res: R.Food, qty: credit(4.2 * soil * this.seasonFactor(site) * st.harvest * skill * vary * mill * this.toolBonus(st) * m.farm * m.haul) };
      }
      case J.Herder: return b ? { res: R.Food, qty: credit(2.5 * skill * vary * (0.7 + 0.3 * this.seasonFactor(site))) } : null;
      case J.Fisher: return b ? { res: R.Food, qty: credit(2.9 * skill * vary * m.fish) } : null;
      case J.Woodcutter: {
        const c = cellOf(site, p.e, p.n);
        const density = c >= 0 ? site.wood[c] / 255 : 0.3;
        return { res: R.Wood, qty: 2.6 * (0.4 + 0.6 * density) * skill * vary * this.toolBonus(st) * m.haul };
      }
      case J.Miner: {
        // no mine: loose stone picked up along banks and slopes
        if (!b || b.kind !== 'mine') return { res: R.Stone, qty: 1.1 * skill * vary };
        if (b.res < 0) return null;
        const c = cellOf(site, b.e, b.n);
        const rich = c >= 0 ? (site.mineral[c] & 15) / 15 : 0.3;
        const base = b.res === R.Stone ? 2.6 : b.res === R.Gold ? 0.25 : 1.4;
        return { res: b.res, qty: credit(base * (0.4 + 0.6 * rich) * skill * vary * this.toolBonus(st) * m.mine * m.haul) };
      }
      case J.Smith: {
        // iron + fuel -> tools; nothing can be forged without iron
        if (!b || st.stock[R.Iron] < 1) return null;
        const fuelCoal = st.stock[R.Coal] >= 1;
        if (!fuelCoal && st.stock[R.Wood] < 2) return null;
        st.stock[R.Iron] -= 1;
        if (fuelCoal) st.stock[R.Coal] -= 1;
        else st.stock[R.Wood] -= 2;
        return { res: R.Tools, qty: credit(1 * skill) };
      }
      case J.Artisan: {
        if (!b || st.stock[R.Wood] < 1.5) return null;
        st.stock[R.Wood] -= 1.5;
        return { res: R.Goods, qty: credit(1 * skill) };
      }
      default: return null;
    }
  }

  // ------------------------------------------------------------- commerce
  /** A merchant loads surplus goods and sets off for the neighbour that pays best. */
  private planTrade(p: Person, site: SimSite, st: SettlementState): { to: number; res: number; qty: number } | null {
    const targets = stockTargets(this, st);
    const m = this.mods(st.id);
    const port = countKind(this.buildingsOf(st.id), 'dock') > 0;
    let best: { to: number; res: number; qty: number; gain: number } | null = null;
    for (const nb of site.neighbors) {
      const other = this.settlements.get(nb.id);
      if (!other || this.census(nb.id).pop === 0) continue;
      if (nb.overSea && !(m.sailing && port)) continue; // the sea is crossed only by those who can sail
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const surplus = st.stock[r] - targets[r];
        if (surplus < 2) continue;
        const qty = Math.min(m.cargo, surplus);
        const gain = (other.prices[r] - st.prices[r]) * qty;
        if (other.prices[r] > st.prices[r] * 1.15 && (!best || gain > best.gain)) best = { to: nb.id, res: r, qty, gain };
      }
    }
    return best;
  }

  private depart(p: Person, site: SimSite): void {
    const st = this.settlements.get(p.settlement)!;
    const plan = this.planTrade(p, site, st);
    const t = this.state.time;
    if (!plan) {
      this.begin(p, Activity.Idle, Phase.Do, 30 * 60);
      return;
    }
    const nb = site.neighbors.find((x) => x.id === plan.to)!;
    st.stock[plan.res] -= plan.qty;
    p.trip = {
      to: plan.to, stage: 1, depart: t, arrive: t + nb.distance / TRAVEL_SPEED,
      fromE: p.e, fromN: p.n, toE: nb.e, toN: nb.n, res: plan.res, qty: plan.qty,
      owed: st.prices[plan.res] * plan.qty, earned: 0,
    };
    this.begin(p, Activity.Trading, Phase.Do, nb.distance / TRAVEL_SPEED);
    this.remember(p, { t, type: 'journey', place: this.sites.get(plan.to)?.name });
  }

  /** Moves a travelling merchant along the road and handles both ends of the journey. */
  private travel(p: Person): void {
    const trip = p.trip;
    const t = this.state.time;
    const site = this.sites.get(p.settlement)!;
    if (!trip) {
      this.decide(p, site);
      return;
    }
    const f = clamp01((t - trip.depart) / Math.max(1, trip.arrive - trip.depart));
    const k = trip.stage === 2 ? 1 - f : f;
    p.e = trip.fromE + (trip.toE - trip.fromE) * k;
    p.n = trip.fromN + (trip.toN - trip.fromN) * k;
    if (t < trip.arrive) return;
    if (trip.stage === 3) {
      // colonists reach their new land
      p.e = trip.toE;
      p.n = trip.toN;
      p.trip = null;
      this.decide(p, site);
      return;
    }
    const home = this.settlements.get(p.settlement)!;
    const hh = this.households.get(p.household)!;
    if (trip.stage === 1) {
      // sell at the destination, look for a return cargo
      const there = this.settlements.get(trip.to)!;
      const revenue = Math.min(Math.max(0, there.treasury), there.prices[trip.res] * trip.qty);
      there.stock[trip.res] += trip.qty;
      there.treasury -= revenue;
      trip.earned = revenue;
      this.record({ t, type: 'trade', settlement: p.settlement, b: trip.to, a: p.id, what: trip.res, value: trip.qty, names: [this.nameOf(p)] });
      let back: { res: number; qty: number; gain: number } | null = null;
      const targets = stockTargets(this, there);
      for (let r = 0; r < RESOURCE_COUNT; r++) {
        const surplus = there.stock[r] - targets[r];
        if (r === trip.res || surplus < 2) continue;
        const qty = Math.min(8, surplus, trip.earned / there.prices[r]);
        const gain = (home.prices[r] - there.prices[r]) * qty;
        if (qty >= 1 && home.prices[r] > there.prices[r] * 1.1 && (!back || gain > back.gain)) back = { res: r, qty, gain };
      }
      if (back) {
        const cost = there.prices[back.res] * back.qty;
        there.stock[back.res] -= back.qty;
        there.treasury += cost;
        trip.earned -= cost;
        trip.res = back.res;
        trip.qty = back.qty;
      } else trip.qty = 0;
      trip.stage = 2;
      trip.depart = t;
      const duration = Math.hypot(trip.toE - trip.fromE, trip.toN - trip.fromN) / TRAVEL_SPEED;
      trip.arrive = t + duration;
      p.until = trip.arrive;
      return;
    }
    // home again: settle the consignment, sell the return cargo
    p.e = trip.fromE;
    p.n = trip.fromN;
    let purse = trip.earned;
    if (trip.qty > 0) {
      const value = Math.min(Math.max(0, home.treasury), home.prices[trip.res] * trip.qty * PRODUCER_SHARE);
      home.stock[trip.res] += trip.qty;
      home.treasury -= value;
      purse += value;
    }
    const due = Math.min(purse, trip.owed);
    home.treasury += due;
    hh.coins += purse - due;
    contact(this, p.settlement, trip.to);
    p.skills[J.Merchant] = Math.min(1, p.skills[J.Merchant] + 0.02 * (0.5 + p.traits[T.Intelligence]));
    p.counts.shifts++;
    p.trip = null;
    this.decide(p, site);
  }

  private updateBond(a: Person, b: Person): void {
    const t = this.state.time;
    let diff = 0;
    for (let i = 0; i < 9; i++) diff += Math.abs(a.traits[i] - b.traits[i]);
    const compat = 1 - diff / 9;
    const quarrel = this.rng.next() < 0.03 + 0.3 * Math.max(a.traits[T.Aggression], b.traits[T.Aggression]) * (1 - compat);
    const before = a.bonds[b.id] ?? 0;
    const delta = quarrel ? -0.18 : 0.06 + 0.1 * compat;
    const after = Math.max(-1, Math.min(1, before + delta));
    this.setBond(a, b.id, after);
    this.setBond(b, a.id, Math.max(-1, Math.min(1, (b.bonds[a.id] ?? 0) + delta)));
    if (before < 0.5 && after >= 0.5 && a.household !== b.household) {
      this.remember(a, { t, type: 'friend', ref: b.id });
      this.remember(b, { t, type: 'friend', ref: a.id });
    }
    if (quarrel && before > -0.3 && after <= -0.3) {
      this.remember(a, { t, type: 'quarrel', ref: b.id });
      this.remember(b, { t, type: 'quarrel', ref: a.id });
    }
  }

  private setBond(p: Person, other: number, value: number): void {
    p.bonds[other] = value;
    const keys = Object.keys(p.bonds);
    if (keys.length > MAX_BONDS) {
      let weakest = keys[0];
      for (const k of keys) if (Math.abs(p.bonds[+k]) < Math.abs(p.bonds[+weakest])) weakest = k;
      delete p.bonds[+weakest];
    }
  }

  /** Altruistic households with a full pantry carry food to neighbours who have none. */
  private shareSurplus(p: Person, hh: Household): void {
    if (p.traits[T.Altruism] < 0.55 || hh.food < hh.members.length * 3) return;
    let poorest: Household | null = null;
    for (const o of this.state.households) {
      if (o.settlement !== hh.settlement || o === hh || o.food >= o.members.length * 0.5) continue;
      if (!poorest || o.food / o.members.length < poorest.food / poorest.members.length) poorest = o;
    }
    if (!poorest) return;
    const gift = Math.min(2 + 2 * p.traits[T.Altruism], hh.food - hh.members.length * 2);
    if (gift < 0.5) return;
    hh.food -= gift;
    poorest.food += gift;
    p.counts.gifts++;
    const t = this.state.time;
    const head = this.byId.get(poorest.members[0]);
    this.remember(p, { t, type: 'gift', ref: head?.id });
    if (head) {
      this.remember(head, { t, type: 'received', ref: p.id });
      this.setBond(head, p.id, Math.min(1, (head.bonds[p.id] ?? 0) + 0.15));
    }
  }

  // ---------------------------------------------------------- utility AI
  /** Scores every action for this person. Exposed for the inspector and tests. */
  utilities(p: Person): { activity: Activity; score: number }[] {
    const site = this.sites.get(p.settlement)!;
    const st = this.settlements.get(p.settlement)!;
    const t = this.state.time;
    const nd = p.needs, tr = p.traits;
    const hh = this.households.get(p.household)!;
    const age = ageAt(p, t);
    const h = localHour(t, site.longitude);
    const night = h < 5.5 || h >= 21;
    const evening = h >= 19;
    const child = age < 13;
    const portion = age < 10 ? 0.6 : 1;
    const canEat = hh.food >= portion || (p.carry >= portion && p.carryRes === R.Food);
    const mealTime = Math.abs(h - 7.5) < 1 || Math.abs(h - 12.5) < 1 || Math.abs(h - 19) < 1;
    const sq = (x: number) => x * x;
    const out: { activity: Activity; score: number }[] = [];
    const add = (activity: Activity, score: number) => out.push({ activity, score });
    const starving = !canEat ? sq(1 - nd[N.Food]) * 1.7 : 0;

    add(Activity.Eating, canEat ? sq(1 - nd[N.Food]) * 1.7 + (mealTime && nd[N.Food] < 0.75 ? 0.25 : 0) : 0);
    add(Activity.Drinking, sq(1 - nd[N.Water]) * 1.9);
    add(Activity.Sleeping, Math.pow(1 - nd[N.Sleep], 1.5) * 1.3 + (night && nd[N.Sleep] < 0.9 ? 0.5 : 0));

    const stockPantry = hh.members.length * (1.5 + 3.5 * tr[T.Prudence]);
    const shortage = clamp01(1 - hh.food / stockPantry);
    const working = age >= 14 && age < 68;
    const workHours = h >= 6.5 && h < 18.5;
    // the granary feeds those who can pay (a little credit is allowed)
    const canBuy = age >= 14 && st.stock[R.Food] >= 2 && (hh.coins + 30) / st.prices[R.Food] >= 1.5;
    if (canBuy) add(Activity.Shopping, night ? 0 : (shortage * 0.9 + starving) * 1.1);
    if (age >= 12) {
      // living off the land: the gatherers' trade, and everyone's last resort
      let u = starving * (canBuy ? 0.6 : 1);
      // gatherers also supply the granary, but only while it is wanting (food fetches a fair price)
      const wanted = st.prices[R.Food] >= BASE_PRICE[R.Food] * 0.9;
      if (p.job === J.Gatherer) u += shortage * (0.5 + 0.45 * tr[T.Ambition] + 0.25 * tr[T.Prudence]) + (working && workHours && wanted ? 0.25 + 0.2 * tr[T.Ambition] : 0);
      else if (!canBuy) u += shortage * 0.6;
      if (night) u *= nd[N.Food] < 0.15 && !canEat ? 0.6 : 0;
      else if (evening) u *= 0.5;
      add(Activity.Foraging, u);
    }
    if (working && p.job !== J.Gatherer) {
      const late = p.pregnantUntil && p.pregnantUntil - t < 60 * SECONDS_PER_DAY ? 0.3 : 1;
      // people work as hard as their produce is wanted: a glutted market means shorter days
      const out = JOB_OUTPUT[p.job];
      const wanted = out < 0 ? 1 : Math.max(0.3, Math.min(1.2, st.prices[out] / BASE_PRICE[out]));
      const drive = (0.45 + 0.3 * tr[T.Ambition] + (hh.coins < 10 ? 0.12 : 0)) * (age > 60 ? 0.7 : 1) * late * wanted;
      const act = p.job === J.Builder ? Activity.Building : p.job === J.Merchant ? Activity.Trading : Activity.Working;
      add(act, workHours ? drive : 0);
    }
    if (child) add(Activity.Playing, night ? 0 : 0.3 + 0.4 * tr[T.Curiosity] + (1 - nd[N.Social]) * 0.3);
    else add(Activity.Socializing, night ? 0 : (1 - nd[N.Social]) * (0.35 + 0.9 * tr[T.Sociability]));
    if (!child || age >= 8) {
      add(Activity.Wandering, night ? 0 : (0.06 + 0.55 * tr[T.Curiosity] * Math.min(nd[N.Food], nd[N.Water], nd[N.Sleep])) * (0.6 + 0.6 * tr[T.Courage]));
    }
    if (p.faith && age >= 10 && this.cache.get(site.id)?.temple) {
      const fervor = this.state.religions[p.faith - 1]?.fervor ?? 0.5;
      add(Activity.Praying, night ? 0 : (1 - nd[N.Social]) * 0.25 + (1 - nd[N.Safety]) * 0.5 + fervor * 0.14);
    }
    add(Activity.Resting, 0.06 + (1 - nd[N.Safety]) * (0.4 + 0.8 * tr[T.Prudence]) + (1 - nd[N.Shelter]) * 0.5 + (night ? 0.25 : 0));
    return out;
  }

  private decide(p: Person, site: SimSite): void {
    const rng = this.rng;
    p.path = [];
    if (p.partner > 0) {
      const o = this.byId.get(p.partner);
      if (o && o.partner === -p.id) o.partner = 0;
    }
    p.partner = 0;
    const options = this.utilities(p);
    for (const o of options) o.score += rng.next() * 0.06;
    options.sort((a, b) => b.score - a.score || a.activity - b.activity);
    for (const o of options) {
      if (o.score <= 0.05) break;
      if (this.start(p, site, o.activity)) return;
    }
    p.inside = false;
    this.begin(p, Activity.Idle, Phase.Do, (6 + rng.next() * 10) * 60);
  }

  /** Tries to begin an action; false when it is not feasible right now. */
  private start(p: Person, site: SimSite, activity: Activity): boolean {
    const rng = this.rng;
    const door = this.home(p);
    const cache = this.cache.get(site.id)!;
    const st = this.settlements.get(p.settlement)!;
    const go = (e: number, n: number): boolean => {
      if (!this.goTo(p, site, e, n)) return false;
      p.activity = activity;
      p.phase = Phase.Go;
      return true;
    };
    switch (activity) {
      case Activity.Eating: {
        if (p.carry >= 1 && p.carryRes === R.Food && Math.hypot(p.e - door.e, p.n - door.n) > 40) {
          this.begin(p, Activity.Eating, Phase.Do, 15 * 60);
          return true;
        }
        return go(door.e, door.n);
      }
      case Activity.Sleeping:
      case Activity.Resting:
        return go(door.e, door.n);
      case Activity.Drinking: {
        const pts = cache.water.map((w) => ({ w, d: Math.hypot(w.e - p.e, w.n - p.n) })).sort((a, b) => a.d - b.d);
        for (const { w } of pts.slice(0, 3)) if (go(w.e + rng.range(-1, 1), w.n + rng.range(-1, 1))) return true;
        return false;
      }
      case Activity.Shopping:
        return go(cache.depot.e + rng.range(-1.5, 1.5), cache.depot.n + rng.range(-1.5, 1.5));
      case Activity.Praying:
        return cache.temple ? go(cache.temple.e + rng.range(-1, 1), cache.temple.n + rng.range(-1, 1)) : false;
      case Activity.Foraging: {
        const reach = 90 + 110 * p.traits[T.Courage];
        let best: { e: number; n: number; q: number } | null = null;
        for (let k = 0; k < 10; k++) {
          const a = rng.next() * Math.PI * 2, r = 35 + rng.next() * (reach - 35);
          const e = door.e + Math.cos(a) * r, n = door.n + Math.sin(a) * r;
          const c = cellOf(site, e, n);
          if (c < 0 || !site.walk[c] || site.forage[c] < 50) continue;
          const q = site.forage[c] - r * 0.25;
          if (!best || q > best.q) best = { e, n, q };
        }
        return best ? go(best.e, best.n) : false;
      }
      case Activity.Working: {
        const b = this.buildings.get(p.workplace);
        if (p.job === J.Woodcutter) {
          let best: { e: number; n: number; q: number } | null = null;
          for (let k = 0; k < 12; k++) {
            const a = rng.next() * Math.PI * 2, r = 30 + rng.next() * 170;
            const e = Math.cos(a) * r, n = Math.sin(a) * r;
            const c = cellOf(site, e, n);
            if (c < 0 || !site.walk[c] || site.wood[c] < 60) continue;
            const q = site.wood[c] - r * 0.3;
            if (!best || q > best.q) best = { e, n, q };
          }
          return best ? go(best.e, best.n) : false;
        }
        if (p.job === J.Miner && (!b || b.kind !== 'mine' || b.progress < 1)) {
          for (let k = 0; k < 14; k++) {
            const a = rng.next() * Math.PI * 2, r = 25 + rng.next() * 180;
            const e = Math.cos(a) * r, n = Math.sin(a) * r;
            const c = cellOf(site, e, n);
            if (c < site.size || c >= site.walk.length - site.size || !site.walk[c]) continue;
            // next to rock faces or water
            if (site.kind[c - 1] || site.kind[c + 1] || site.kind[c - site.size] || site.kind[c + site.size]) { if (go(e, n)) return true; }
          }
          const w = cache.water[cache.water.length - 1];
          return w ? go(w.e + rng.range(-3, 3), w.n + rng.range(-3, 3)) : false;
        }
        if ((p.job === J.Researcher || p.job === J.Leader) && (!b || b.progress < 1)) return go(cache.plaza.e + rng.range(-3, 3), cache.plaza.n + rng.range(-3, 3));
        if (!b || b.progress < 1) return false;
        if (p.job === J.Smith && (st.stock[R.Iron] < 1 || (st.stock[R.Coal] < 1 && st.stock[R.Wood] < 2))) return false;
        if (p.job === J.Artisan && st.stock[R.Wood] < 1.5) return false;
        const d = this.doorOf(b);
        const spread = p.job === J.Farmer ? b.radius * 0.6 : 1;
        return go(d.e + rng.range(-spread, spread), d.n + rng.range(-spread, spread));
      }
      case Activity.Building: {
        const b = st.projects.length ? this.buildings.get(st.projects[0]) : undefined;
        if (!b) return false;
        const a = rng.next() * Math.PI * 2;
        return go(b.e + Math.cos(a) * (b.radius * 0.7 + 1.5), b.n + Math.sin(a) * (b.radius * 0.7 + 1.5));
      }
      case Activity.Trading: {
        if (!this.planTrade(p, site, st)) return false;
        return go(cache.depot.e, cache.depot.n);
      }
      case Activity.Socializing: {
        const age = ageAt(p, this.state.time);
        let best: Person | null = null, bestScore = -Infinity;
        const persons = this.state.persons;
        for (let i = 0; i < persons.length; i++) {
          const o = persons[i];
          if (o === p || o.settlement !== p.settlement || o.inside || o.trip || o.activity === Activity.Sleeping || o.partner !== 0) continue;
          if (ageAt(o, this.state.time) < 13 !== age < 13) continue;
          const d = Math.hypot(o.e - p.e, o.n - p.n);
          let score = (p.bonds[o.id] ?? 0) * (0.4 + p.traits[T.Loyalty]) + rng.next() * 0.6 - d / 220;
          // courtship: the unattached seek each other's company
          if (age >= 17 && o.sex !== p.sex && !p.spouse && !o.spouse && ageAt(o, this.state.time) >= 17 && Math.abs(ageAt(o, this.state.time) - age) < 14) score += 0.45;
          if (score > bestScore) { bestScore = score; best = o; }
        }
        if (best && go(best.e, best.n)) {
          p.partner = best.id;
          return true;
        }
        return go(cache.plaza.e + rng.range(-4, 4), cache.plaza.n + rng.range(-4, 4));
      }
      case Activity.Wandering: {
        const reach = 45 + 190 * p.traits[T.Courage] * (0.4 + 0.6 * p.traits[T.Curiosity]);
        for (let k = 0; k < 6; k++) {
          const a = rng.next() * Math.PI * 2, r = 20 + rng.next() * reach;
          const e = p.e + Math.cos(a) * r, n = p.n + Math.sin(a) * r;
          if (isWalkable(site, e, n) && go(e, n)) return true;
        }
        return false;
      }
      case Activity.Playing: {
        const base = rng.chance(0.5) ? door : cache.plaza;
        for (let k = 0; k < 5; k++) {
          const e = base.e + rng.range(-22, 22), n = base.n + rng.range(-22, 22);
          if (isWalkable(site, e, n) && go(e, n)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  // ------------------------------------------------- memory, birth & death
  remember(p: Person, m: Memory): void {
    p.memories.push(m);
    if (p.memories.length > MAX_MEMORIES) {
      const keep = new Set(['born', 'married', 'child', 'settled', 'mourning', 'built']);
      const idx = p.memories.findIndex((x) => !keep.has(x.type));
      p.memories.splice(idx >= 0 ? idx : 4, 1);
    }
  }

  private recent(p: Person, type: string, days: number): boolean {
    const since = this.state.time - days * SECONDS_PER_DAY;
    for (let i = p.memories.length - 1; i >= 0; i--) {
      const m = p.memories[i];
      if (m.t < since) return false;
      if (m.type === type) return true;
    }
    return false;
  }

  /** A child is born: it inherits part of its parents' temperament and looks. */
  birth(mother: Person): Person {
    const s = this.state;
    const t = s.time;
    const rng = this.rng;
    const father = this.byId.get(mother.spouse);
    const site = this.sites.get(mother.settlement)!;
    const sex: 0 | 1 = rng.chance(0.5) ? 0 : 1;
    const child = blankPerson(rng, s.nextId++, sex, t, mother.lastName, site.name, mother.settlement, mother.household, t);
    for (let k = 0; k < 9; k++) {
      const inherited = father ? 0.33 * mother.traits[k] + 0.33 * father.traits[k] : 0.6 * mother.traits[k];
      child.traits[k] = clamp01(inherited + (father ? 0.34 : 0.4) * child.traits[k]);
    }
    child.look.skin = father && rng.chance(0.5) ? father.look.skin : mother.look.skin;
    child.look.hair = father && rng.chance(0.5) ? father.look.hair : mother.look.hair;
    child.parents = [mother.id, father?.id ?? 0];
    child.faith = mother.faith || father?.faith || 0;
    const civ = this.civOf(mother.settlement);
    if (civ) child.look.tunic = (civ.color * 3 + (child.id % 4)) % 10;
    child.needs = [1, 1, 1, 1, 1, 1];
    child.inside = true;
    const door = this.home(mother);
    child.e = door.e;
    child.n = door.n;
    s.persons.push(child);
    this.byId.set(child.id, child);
    this.households.get(mother.household)!.members.push(child.id);
    for (const par of [mother, father]) {
      if (!par) continue;
      par.children.push(child.id);
      this.remember(par, { t, type: 'child', ref: child.id });
      par.bonds[child.id] = 0.9;
      child.bonds[par.id] = 0.9;
    }
    mother.pregnantUntil = 0;
    mother.lastBirth = t;
    this.record({ t, type: 'birth', settlement: mother.settlement, a: child.id, b: mother.id, names: [this.nameOf(child), this.nameOf(mother)] });
    this.rosterVersion++;
    return child;
  }

  /** Marks someone as dying; the burial happens at the end of the tick. */
  kill(p: Person, cause: DeadPerson['cause']): void {
    p.health = 0;
    this.causes.set(p.id, cause);
    this.bury();
  }

  private bury(): void {
    const s = this.state;
    const t = s.time;
    const gone = s.persons.filter((p) => p.health <= 0);
    if (!gone.length) return;
    s.persons = s.persons.filter((p) => p.health > 0);
    for (const p of gone) {
      this.byId.delete(p.id);
      const cause = this.causes.get(p.id) ?? (p.needs[N.Water] < p.needs[N.Food] ? 'thirst' : 'starvation');
      this.causes.delete(p.id);
      s.dead.push({
        id: p.id, firstName: p.firstName, lastName: p.lastName, sex: p.sex, birth: p.birth, birthPlace: p.birthPlace,
        death: t, cause, settlement: p.settlement, spouse: p.spouse, parents: p.parents, children: p.children, memories: p.memories,
      });
      this.record({ t, type: 'death', settlement: p.settlement, a: p.id, what: cause, names: [this.nameOf(p)], value: Math.floor(ageAt(p, t)) });
      const hh = this.households.get(p.household);
      if (hh) {
        hh.members = hh.members.filter((id) => id !== p.id);
        if (!hh.members.length) {
          // no heir under this roof: what is left returns to the community
          const st = this.settlements.get(hh.settlement);
          if (st) { st.treasury += hh.coins; st.stock[R.Food] += hh.food; }
          this.dropHousehold(hh);
        } else this.fosterOrphans(hh);
      }
      for (const o of s.persons) {
        if (o.partner === p.id || o.partner === -p.id) o.partner = 0;
        if (o.spouse === p.id || o.parents.includes(p.id) || o.children.includes(p.id) || (o.bonds[p.id] ?? 0) >= 0.5) {
          this.remember(o, { t, type: 'mourning', ref: p.id });
          o.needs[N.Social] = Math.max(0, o.needs[N.Social] - 0.3);
        }
        delete o.bonds[p.id];
      }
    }
    this.censusTick = -1;
    this.rosterVersion++;
    for (const p of gone) onDeath(this, p);
  }

  /** Children left without any adult join the household of a relative, or the roomiest one. */
  private fosterOrphans(hh: Household): void {
    const t = this.state.time;
    if (hh.members.some((id) => { const m = this.byId.get(id); return m && ageAt(m, t) >= 14; })) return;
    const kin = new Set<number>();
    for (const id of hh.members) {
      const c = this.byId.get(id);
      if (!c) continue;
      for (const par of c.parents) {
        const dead = this.state.dead.find((d) => d.id === par);
        const src = this.byId.get(par) ?? dead;
        if (src) for (const sib of src.children) kin.add(sib);
        if (dead) for (const gp of dead.parents) kin.add(gp);
      }
    }
    let best: Household | null = null, bestScore = -Infinity;
    for (const o of this.state.households) {
      if (o === hh || o.settlement !== hh.settlement) continue;
      const room = dwellingCapacity(this.buildings.get(o.building)?.kind ?? '') - o.members.length;
      const score = room + (o.members.some((id) => kin.has(id)) ? 10 : 0);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (!best) return;
    for (const id of [...hh.members]) {
      const c = this.byId.get(id);
      if (c) this.moveToHousehold(c, hh, best);
    }
  }

  // ------------------------------------------------------------- queries
  summary(): PopulationSummary {
    const s = this.state;
    const byActivity = new Array<number>(ACTIVITY_COUNT).fill(0);
    const byJob = new Array<number>(JOB_COUNT).fill(0);
    const avgNeeds = [0, 0, 0, 0, 0, 0];
    let health = 0;
    const inhabited = new Set<number>();
    for (const p of s.persons) {
      byActivity[p.activity]++;
      if (isAdult(p, s.time)) byJob[p.job]++;
      for (let i = 0; i < 6; i++) avgNeeds[i] += p.needs[i];
      health += p.health;
      inhabited.add(p.settlement);
    }
    const n = Math.max(1, s.persons.length);
    let pantry = 0;
    for (const h of s.households) pantry += h.food;
    return {
      alive: s.persons.length, deaths: s.dead.length, households: s.households.length, byActivity, byJob,
      avgNeeds: avgNeeds.map((v) => v / n), avgHealth: health / n, pantryMeals: pantry, inhabitedSettlements: inhabited.size,
      births: this.bornSinceFounding(),
      civilizations: s.civs.reduce((a, c) => a + (c.fallen ? 0 : 1), 0),
    };
  }

  private bornSinceFounding(): number {
    const founded = this.state.events.find((e) => e.type === 'founded')?.t ?? -Infinity;
    let n = 0;
    for (const p of this.state.persons) if (p.birth > founded) n++;
    for (const d of this.state.dead) if (d.birth > founded) n++;
    return n;
  }

  snapshot(): Snapshot {
    const persons = this.state.persons;
    const count = persons.length;
    const ids = new Int32Array(count), pos = new Float32Array(count * 2), site = new Uint8Array(count), flags = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const p = persons[i];
      ids[i] = p.id;
      pos[i * 2] = p.e;
      pos[i * 2 + 1] = p.n;
      site[i] = p.settlement;
      flags[i] = p.activity | (p.phase !== Phase.Do || p.trip ? 64 : 0) | (p.inside ? 128 : 0);
    }
    return { time: this.state.time, count, ids, pos, site, flags, summary: this.summary() };
  }

  roster(): RosterEntry[] {
    return this.state.persons.map((p) => ({
      id: p.id, name: `${p.firstName} ${p.lastName}`, sex: p.sex, birth: p.birth, look: p.look, settlement: p.settlement,
      household: p.household, home: this.households.get(p.household)?.building ?? 0, job: p.job, workplace: p.workplace,
    }));
  }

  /** Economic picture of every settlement, plus the latest recorded events. */
  economy(): EconomyView {
    const s = this.state;
    const settlements: SettlementView[] = s.settlements.map((st) => {
      const { pop, adults } = this.census(st.id);
      const list = this.buildingsOf(st.id);
      const jobs = new Array<number>(JOB_COUNT).fill(0);
      for (const p of s.persons) if (p.settlement === st.id && isAdult(p, s.time)) jobs[p.job]++;
      let housing = 0;
      for (const b of list) if (b.progress >= 1) housing += dwellingCapacity(b.kind);
      return {
        id: st.id, population: pop, adults, stock: [...st.stock], prices: [...st.prices], targets: stockTargets(this, st),
        treasury: st.treasury, forage: st.forage / Math.max(1e-6, this.forageCapacity(st.id)), harvest: st.harvest, jobs,
        projects: st.projects.map((id) => {
          const b = this.buildings.get(id)!;
          const c = BUILD_COST[b.kind] ?? BUILD_COST.house;
          const left = 1 - b.progress;
          const missing: number[] = [];
          if (c.wood * left > st.stock[R.Wood] + 0.5) missing.push(R.Wood);
          if (c.stone * left > st.stock[R.Stone] + 0.5) missing.push(R.Stone);
          if (c.goods * left > st.stock[R.Goods] + 0.5) missing.push(R.Goods);
          return { id, kind: b.kind, progress: b.progress, missing };
        }),
        buildings: countKindAll(list), housing, civ: st.civ,
      };
    });
    return { settlements, events: s.events.slice(-60) };
  }

  /**
   * A few households leave to settle empty land: they travel physically to the
   * new place, which joins their civilisation, and take provisions with them.
   */
  migrate(party: Household[], from: SettlementState, target: number): void {
    const s = this.state;
    const t = s.time;
    const to = this.settlements.get(target)!;
    const site = this.sites.get(target)!;
    const back = site.neighbors.find((n) => n.id === from.id);
    if (!back) return;
    const heads = party.reduce((a, h) => a + h.members.length, 0);
    const popFrom = Math.max(1, this.census(from.id).pop);
    to.civ = from.civ;
    to.founded = t;
    const take = (r: number, amount: number) => {
      const q = Math.min(from.stock[r] * 0.5, amount);
      from.stock[r] -= q;
      to.stock[r] += q;
    };
    take(R.Food, heads * 6);
    take(R.Wood, 30);
    take(R.Stone, 10);
    take(R.Tools, 1);
    const purse = from.treasury * (heads / popFrom) * 0.5;
    from.treasury -= purse;
    to.treasury += purse;
    const vacant = this.buildingsOf(target).filter((b) => b.progress >= 1 && dwellingCapacity(b.kind) > 0 && !this.householdOfBuilding(b.id))
      .sort((a, b) => dwellingCapacity(b.kind) - dwellingCapacity(a.kind) || a.id - b.id);
    const duration = back.distance / TRAVEL_SPEED;
    const names: string[] = [];
    for (const hh of party) {
      hh.settlement = target;
      hh.building = vacant.shift()?.id ?? 0; // no roof yet: they will camp and build
      for (const id of hh.members) {
        const p = this.byId.get(id)!;
        if (p.partner > 0) { const o = this.byId.get(p.partner); if (o && o.partner === -p.id) o.partner = 0; }
        p.partner = 0;
        p.settlement = target;
        p.job = J.Gatherer;
        p.workplace = 0;
        p.carry = 0;
        p.path = [];
        p.inside = false;
        const a = this.rng.next() * Math.PI * 2, r = 3 + this.rng.next() * 8;
        p.trip = { to: target, stage: 3, depart: t, arrive: t + duration, fromE: back.e, fromN: back.n, toE: Math.cos(a) * r, toN: Math.sin(a) * r, res: 0, qty: 0, owed: 0, earned: 0 };
        p.e = back.e;
        p.n = back.n;
        this.begin(p, Activity.Migrating, Phase.Do, duration);
        if (ageAt(p, t) >= 12) this.remember(p, { t, type: 'colonist', place: site.name });
        if (isAdult(p, t) && names.length < 3) names.push(this.nameOf(p));
      }
    }
    this.censusTick = -1;
    this.refreshSite(target);
    this.rosterVersion++;
    this.record({ t, type: 'colony', settlement: target, b: from.id, civ: from.civ, value: heads, names });
  }

  /** Political, cultural and religious picture of the world. */
  worldView(): WorldView {
    const s = this.state;
    const settlements: WorldView['settlements'] = {};
    for (const st of s.settlements) settlements[st.id] = [st.civ, this.census(st.id).pop];
    const faith = new Map<number, number>();
    for (const p of s.persons) if (p.faith) faith.set(p.faith, (faith.get(p.faith) ?? 0) + 1);
    return {
      civs: s.civs.map((c) => {
        const own = s.settlements.filter((st) => st.civ === c.id).map((st) => st.id);
        const followers: Record<number, number> = {};
        let population = 0;
        for (const p of s.persons) {
          if (!own.includes(p.settlement)) continue;
          population++;
          if (p.faith) followers[p.faith] = (followers[p.faith] ?? 0) + 1;
        }
        const leader = this.byId.get(c.leader);
        return { ...c, population, settlements: own, leaderName: leader ? this.nameOf(leader) : '', followers };
      }),
      religions: s.religions.map((r) => ({ ...r, followers: faith.get(r.id) ?? 0 })),
      settlements,
      events: s.events.slice(-500),
    };
  }

  /** Finds people, living or dead, whose name contains the query (archives). */
  search(query: string, limit = 40): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: SearchHit[] = [];
    for (const p of this.state.persons) {
      if (out.length >= limit) break;
      const name = this.nameOf(p);
      if (name.toLowerCase().includes(q)) out.push({ id: p.id, name, alive: true, birth: p.birth, death: 0, settlement: p.settlement });
    }
    for (let i = this.state.dead.length - 1; i >= 0 && out.length < limit; i--) {
      const d = this.state.dead[i];
      const name = this.nameOf(d);
      if (name.toLowerCase().includes(q)) out.push({ id: d.id, name, alive: false, birth: d.birth, death: d.death, settlement: d.settlement });
    }
    return out;
  }

  /** Full sheet of a living or dead person, with the names of everyone it mentions. */
  view(id: number): PersonView | null {
    const s = this.state;
    const alive = this.byId.get(id);
    const person = alive ?? s.dead.find((d) => d.id === id);
    if (!person) return null;
    const names: Record<number, string> = {};
    const deceased: number[] = [];
    const note = (ref: number | undefined) => {
      if (!ref || names[ref]) return;
      const l = this.byId.get(ref);
      if (l) names[ref] = `${l.firstName} ${l.lastName}`;
      else {
        const d = s.dead.find((x) => x.id === ref);
        if (d) {
          names[ref] = `${d.firstName} ${d.lastName}`;
          deceased.push(ref);
        }
      }
    };
    note(person.spouse);
    person.parents.forEach(note);
    person.children.forEach(note);
    person.memories.forEach((m) => note(m.ref));
    const hh = alive ? this.households.get(alive.household) : undefined;
    if (alive) Object.keys(alive.bonds).forEach((k) => note(+k));
    hh?.members.forEach(note);
    const end = alive ? s.time : (person as DeadPerson).death;
    return {
      alive: !!alive,
      person: JSON.parse(JSON.stringify(person)) as Person | DeadPerson,
      age: (end - person.birth) / SECONDS_PER_YEAR,
      settlementName: this.sites.get(person.settlement)?.name ?? '',
      household: hh ? { name: hh.name, food: hh.food, coins: hh.coins, members: [...hh.members] } : null,
      names, deceased,
      utilities: alive ? this.utilities(alive).sort((a, b) => b.score - a.score).slice(0, 4) : [],
    };
  }

  /** Order-sensitive checksum of the dynamic state (determinism tests, save validation). */
  checksum(): number {
    let h = 2166136261 >>> 0;
    const mix = (v: number) => {
      h ^= v | 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    for (const p of this.state.persons) {
      mix(p.id);
      mix(Math.round(p.e * 1000));
      mix(Math.round(p.n * 1000));
      mix(p.activity * 4 + p.phase);
      mix(p.job);
      for (const v of p.needs) mix(Math.round(v * 1e6));
      mix(Math.round(p.health * 1e6));
      mix(p.memories.length);
    }
    for (const hh of this.state.households) { mix(Math.round(hh.food * 1000)); mix(Math.round(hh.coins * 1000)); }
    for (const st of this.state.settlements) { for (const v of st.stock) mix(Math.round(v * 1000)); mix(Math.round(st.treasury * 1000)); }
    for (const b of this.state.buildings) mix(Math.round(b.progress * 1e5) + b.id);
    for (const c of this.state.civs) { mix(c.leader); mix(c.techs.length); mix(Math.round(c.legitimacy * 1e6)); mix(Math.round(c.research.progress * 1000)); }
    for (const p of this.state.persons) mix(p.faith * 7 + p.settlement);
    mix(this.state.tick);
    mix(this.rng.state);
    return h >>> 0;
  }
}

function countKindAll(list: SimBuilding[]): number {
  let n = 0;
  for (const b of list) if (b.progress >= 1) n++;
  return n;
}
