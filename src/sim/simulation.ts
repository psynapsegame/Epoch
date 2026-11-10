import { Rng, hashString } from '../core/rng';
import { clamp01 } from '../core/math';
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, TICK_SECONDS, localHour, seasonPhase } from './clock';
import { cellOf, findPath, isWalkable, nearestWalkable } from './pathfinding';
import { createPopulation } from './populate';
import {
  ACTIVITY_COUNT, Activity, Phase, N, T,
  type DeadPerson, type Household, type Person, type PersonView, type PopulationSummary, type RosterEntry, type SimSite, type SimState, type Snapshot,
} from './types';

const DT = TICK_SECONDS;
const HOUR = 3600;
/** Walking speed in metres per simulated second (see clock.ts: tuned so walks are watchable at ×1). */
const WALK_SPEED = 0.022;
const MAX_MEMORIES = 40;
const MAX_BONDS = 24;

const ageOf = (p: Person, time: number) => (time - p.birth) / SECONDS_PER_YEAR;

/**
 * The living society. Pure and deterministic: a fixed time step, its own
 * serialisable random stream, no access to wall-clock time, rendering or DOM.
 * Runs inside a Web Worker in the game and directly in Node for the tests.
 *
 * Each inhabitant picks what to do with a utility AI: every possible action
 * gets a score from the person's needs, personality and context (hour,
 * pantry, season); the best feasible one is carried out.
 */
export class Simulation {
  readonly state: SimState;
  private rng: Rng;
  private sites = new Map<number, SimSite>();
  private byId = new Map<number, Person>();
  private households = new Map<number, Household>();
  private homeDoor = new Map<number, { e: number; n: number }>();
  /** Bumped whenever the set of living people changes. */
  rosterVersion = 0;

  constructor(sites: SimSite[], state: SimState) {
    this.state = state;
    this.rng = new Rng(0);
    this.rng.state = state.rng;
    for (const s of sites) this.sites.set(s.id, s);
    for (const p of state.persons) this.byId.set(p.id, p);
    for (const h of state.households) {
      this.households.set(h.id, h);
      const site = this.sites.get(h.settlement);
      const b = site?.buildings.find((x) => x.id === h.building);
      if (site && b) this.homeDoor.set(h.id, nearestWalkable(site, b.doorE, b.doorN, 8) ?? { e: b.doorE, n: b.doorN });
    }
  }

  static create(seed: string, sites: SimSite[], population: number, time: number): Simulation {
    return new Simulation(sites, createPopulation(new Rng(hashString(seed) ^ 0x50b), sites, population, time));
  }

  person(id: number): Person | undefined {
    return this.byId.get(id);
  }

  household(id: number): Household | undefined {
    return this.households.get(id);
  }

  site(id: number): SimSite | undefined {
    return this.sites.get(id);
  }

  /** Deep copy of the whole state, safe to store or send to another thread. */
  serialize(): SimState {
    this.state.rng = this.rng.state;
    return JSON.parse(JSON.stringify(this.state)) as SimState;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  // ------------------------------------------------------------------ step
  step(): void {
    const s = this.state;
    s.time += DT;
    s.tick++;
    const persons = s.persons;
    let died = false;
    for (let i = 0; i < persons.length; i++) {
      const p = persons[i];
      const site = this.sites.get(p.settlement)!;
      this.updateNeeds(p, site);
      if (p.health <= 0) {
        died = true;
        continue;
      }
      if (p.phase === Phase.Do) {
        if (p.activity === Activity.Sleeping) {
          const h = localHour(s.time, site.longitude);
          // people sleep through the night and rise with the day
          const day = h >= 5.5 && h < 21;
          if ((day && p.needs[N.Sleep] > 0.7) || s.time >= p.until) this.finish(p, site);
        } else if (s.time >= p.until) this.finish(p, site);
        else if ((s.tick + p.id) % 15 === 0 && this.critical(p)) this.decide(p, site);
      } else {
        this.move(p, site);
      }
    }
    if (died) this.bury();
    s.rng = this.rng.state;
  }

  private critical(p: Person): boolean {
    if (p.activity === Activity.Eating || p.activity === Activity.Drinking) return false;
    return p.needs[N.Water] < 0.12 || (p.needs[N.Food] < 0.12 && p.activity !== Activity.Foraging);
  }

  private updateNeeds(p: Person, site: SimSite): void {
    const t = this.state.time;
    const nd = p.needs;
    const asleep = p.activity === Activity.Sleeping && p.phase === Phase.Do;
    const k = asleep ? 0.5 : 1;
    nd[N.Food] = Math.max(0, nd[N.Food] - (DT / (1.15 * SECONDS_PER_DAY)) * k);
    nd[N.Water] = Math.max(0, nd[N.Water] - (DT / (0.75 * SECONDS_PER_DAY)) * k);
    if (asleep) nd[N.Sleep] = Math.min(1, nd[N.Sleep] + DT / (9 * HOUR));
    else nd[N.Sleep] = Math.max(0, nd[N.Sleep] - DT / (24 * HOUR));
    if (!(p.activity === Activity.Socializing && p.phase === Phase.Do)) {
      nd[N.Social] = Math.max(0, nd[N.Social] - (DT / (2.5 * SECONDS_PER_DAY)) * (0.6 + 0.8 * p.traits[T.Sociability]));
    }
    const h = localHour(t, site.longitude);
    const night = h < 5.5 || h >= 21;
    const far = Math.hypot(p.e, p.n) > site.radius + 25;
    const cold = site.temperature + seasonPhase(t) * Math.max(-1, Math.min(1, site.sinLatitude * 1.6)) * 11 < 3;
    const safeTarget = p.inside ? 1 : clamp01((night ? (far ? 0.25 : 0.5) : far ? 0.7 : 0.9) + p.traits[T.Courage] * 0.25);
    nd[N.Safety] += (safeTarget - nd[N.Safety]) * 0.02;
    const shelterTarget = p.inside ? 1 : clamp01((night ? 0.45 : 0.85) - (cold ? 0.25 : 0));
    nd[N.Shelter] += (shelterTarget - nd[N.Shelter]) * 0.01;

    // health: starvation and thirst kill, a satisfied body recovers
    if (nd[N.Water] < 0.04) p.health -= DT / (1.5 * SECONDS_PER_DAY);
    else if (nd[N.Food] < 0.04) p.health -= DT / (4 * SECONDS_PER_DAY);
    else if (p.health < 1 && nd[N.Food] > 0.3 && nd[N.Water] > 0.3) p.health = Math.min(1, p.health + DT / (5 * SECONDS_PER_DAY));
    if (nd[N.Food] < 0.06 && !this.recent(p, 'hunger', 10)) this.remember(p, { t, type: 'hunger' });
  }

  // ------------------------------------------------------------- movement
  private move(p: Person, site: SimSite): void {
    const age = ageOf(p, this.state.time);
    let budget = WALK_SPEED * DT * (age < 10 ? 0.7 : age > 62 ? 0.72 : 1);
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
    const path = findPath(site, p.e, p.n, dest.e, dest.n);
    if (!path) return false;
    p.path = path;
    p.te = dest.e;
    p.tn = dest.n;
    p.inside = false;
    return true;
  }

  private home(p: Person): { e: number; n: number } {
    return this.homeDoor.get(p.household) ?? { e: 0, n: 0 };
  }

  private begin(p: Person, activity: Activity, phase: Phase, duration = 0): void {
    p.activity = activity;
    p.phase = phase;
    p.until = this.state.time + duration;
  }

  // -------------------------------------------------------------- arrival
  private arrive(p: Person, site: SimSite): void {
    const t = this.state.time;
    const rng = this.rng;
    if (p.phase === Phase.Return) {
      // back from foraging: fill the pantry, maybe help a neighbour in need
      const hh = this.households.get(p.household)!;
      hh.food += p.carry;
      p.carry = 0;
      this.shareSurplus(p, hh);
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
      case Activity.Socializing: {
        const other = this.byId.get(p.partner);
        const free = other && !other.inside && other.partner === 0 &&
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
          // nobody available: linger a while, a little company is better than none
          p.partner = 0;
          this.begin(p, Activity.Socializing, Phase.Do, 15 * 60);
        }
        break;
      }
      default: this.begin(p, Activity.Idle, Phase.Do, 10 * 60);
    }
    void t;
  }

  // ---------------------------------------------------- end of an action
  private finish(p: Person, site: SimSite): void {
    const t = this.state.time;
    const rng = this.rng;
    const hh = this.households.get(p.household)!;
    const age = ageOf(p, t);
    switch (p.activity) {
      case Activity.Eating: {
        const portion = age < 10 ? 0.6 : 1;
        if (p.carry >= portion) p.carry -= portion;
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
        const cold = site.temperature + seasonPhase(t) * Math.max(-1, Math.min(1, site.sinLatitude * 1.6)) * 11;
        const season = cold < 2 ? 0.45 : cold < 8 ? 0.75 : 1;
        p.carry += (0.8 + 2.8 * q * (0.5 + p.skills[0])) * (0.85 + 0.3 * rng.next()) * season;
        p.skills[0] = Math.min(1, p.skills[0] + 0.004 * (0.5 + p.traits[T.Intelligence]));
        p.counts.forages++;
        // starving and nothing at home: eat on the spot
        if (p.needs[N.Food] < 0.25 && hh.food < 1 && p.carry >= 1) {
          p.carry -= 1;
          p.needs[N.Food] = 1;
          p.counts.meals++;
        }
        const door = this.home(p);
        if (this.goTo(p, site, door.e, door.n)) {
          p.phase = Phase.Return;
          return;
        }
        hh.food += p.carry;
        p.carry = 0;
        break;
      }
      case Activity.Socializing: {
        const other = this.byId.get(Math.abs(p.partner));
        if (other && p.partner !== 0) {
          p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.5);
          p.skills[1] = Math.min(1, p.skills[1] + 0.003 * (0.5 + p.traits[T.Intelligence]));
          p.counts.chats++;
          if (p.partner > 0) this.updateBond(p, other);
        } else {
          p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.12);
        }
        p.partner = 0;
        break;
      }
      case Activity.Wandering: {
        p.skills[2] = Math.min(1, p.skills[2] + 0.004 * (0.5 + p.traits[T.Intelligence]));
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
      // forget the weakest acquaintance
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
  /** Scores every action for this person, best first. Exposed for the inspector and tests. */
  utilities(p: Person): { activity: Activity; score: number }[] {
    const site = this.sites.get(p.settlement)!;
    const t = this.state.time;
    const nd = p.needs, tr = p.traits;
    const hh = this.households.get(p.household)!;
    const age = ageOf(p, t);
    const h = localHour(t, site.longitude);
    const night = h < 5.5 || h >= 21;
    const evening = h >= 19;
    const child = age < 13;
    const portion = age < 10 ? 0.6 : 1;
    const canEat = hh.food >= portion || p.carry >= portion;
    const mealTime = Math.abs(h - 7.5) < 1 || Math.abs(h - 12.5) < 1 || Math.abs(h - 19) < 1;
    const sq = (x: number) => x * x;
    const out: { activity: Activity; score: number }[] = [];
    const add = (activity: Activity, score: number) => out.push({ activity, score });

    add(Activity.Eating, canEat ? sq(1 - nd[N.Food]) * 1.7 + (mealTime && nd[N.Food] < 0.75 ? 0.25 : 0) : 0);
    add(Activity.Drinking, sq(1 - nd[N.Water]) * 1.9);
    add(Activity.Sleeping, Math.pow(1 - nd[N.Sleep], 1.5) * 1.3 + (night && nd[N.Sleep] < 0.9 ? 0.5 : 0));
    if (age >= 12) {
      const stock = hh.members.length * (1.5 + 3.5 * tr[T.Prudence]);
      const shortage = clamp01(1 - hh.food / stock);
      let u = shortage * (0.5 + 0.45 * tr[T.Ambition] + 0.25 * tr[T.Prudence]);
      if (!canEat) u += sq(1 - nd[N.Food]) * 1.7;
      if (night) u *= nd[N.Food] < 0.15 && !canEat ? 0.6 : 0;
      else if (evening) u *= 0.5;
      add(Activity.Foraging, u);
    }
    if (child) add(Activity.Playing, night ? 0 : 0.3 + 0.4 * tr[T.Curiosity] + (1 - nd[N.Social]) * 0.3);
    else add(Activity.Socializing, night ? 0 : (1 - nd[N.Social]) * (0.35 + 0.9 * tr[T.Sociability]));
    if (!child || age >= 8) {
      add(Activity.Wandering, night ? 0 : (0.06 + 0.55 * tr[T.Curiosity] * Math.min(nd[N.Food], nd[N.Water], nd[N.Sleep])) * (0.6 + 0.6 * tr[T.Courage]));
    }
    add(Activity.Resting, 0.06 + (1 - nd[N.Safety]) * (0.4 + 0.8 * tr[T.Prudence]) + (1 - nd[N.Shelter]) * 0.5 + (night ? 0.25 : 0));
    return out;
  }

  private decide(p: Person, site: SimSite): void {
    const rng = this.rng;
    p.path = [];
    if (p.partner > 0) {
      // release a partner who was waiting for us
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
    const go = (e: number, n: number): boolean => {
      if (!this.goTo(p, site, e, n)) return false;
      p.activity = activity;
      p.phase = Phase.Go;
      return true;
    };
    switch (activity) {
      case Activity.Eating: {
        if (p.carry >= 1 && Math.hypot(p.e - door.e, p.n - door.n) > 40) {
          this.begin(p, Activity.Eating, Phase.Do, 15 * 60); // eat what was gathered, on the spot
          return true;
        }
        return go(door.e, door.n);
      }
      case Activity.Sleeping:
      case Activity.Resting:
        return go(door.e, door.n);
      case Activity.Drinking: {
        const pts = site.water.map((w) => ({ w, d: Math.hypot(w.e - p.e, w.n - p.n) })).sort((a, b) => a.d - b.d);
        for (const { w } of pts.slice(0, 3)) if (go(w.e + rng.range(-1, 1), w.n + rng.range(-1, 1))) return true;
        return false;
      }
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
      case Activity.Socializing: {
        const age = ageOf(p, this.state.time);
        let best: Person | null = null, bestScore = -Infinity;
        const persons = this.state.persons;
        for (let i = 0; i < persons.length; i++) {
          const o = persons[i];
          if (o === p || o.settlement !== p.settlement || o.inside || o.activity === Activity.Sleeping || o.partner !== 0) continue;
          if (ageOf(o, this.state.time) < 13 !== age < 13) continue;
          const d = Math.hypot(o.e - p.e, o.n - p.n);
          const score = (p.bonds[o.id] ?? 0) * (0.4 + p.traits[T.Loyalty]) + rng.next() * 0.6 - d / 220;
          if (score > bestScore) { bestScore = score; best = o; }
        }
        if (best && go(best.e, best.n)) {
          p.partner = best.id;
          return true;
        }
        return go(site.plaza.e + rng.range(-4, 4), site.plaza.n + rng.range(-4, 4));
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
        const base = rng.chance(0.5) ? door : site.plaza;
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

  // ------------------------------------------------------ memory & death
  private remember(p: Person, m: Person['memories'][number]): void {
    p.memories.push(m);
    if (p.memories.length > MAX_MEMORIES) {
      // keep the founding memories of a life, drop the oldest minor one
      const idx = p.memories.findIndex((x) => x.type !== 'born' && x.type !== 'married' && x.type !== 'child' && x.type !== 'settled' && x.type !== 'mourning');
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

  private bury(): void {
    const s = this.state;
    const t = s.time;
    const gone = s.persons.filter((p) => p.health <= 0);
    s.persons = s.persons.filter((p) => p.health > 0);
    for (const p of gone) {
      this.byId.delete(p.id);
      const dead: DeadPerson = {
        id: p.id, firstName: p.firstName, lastName: p.lastName, sex: p.sex, birth: p.birth, birthPlace: p.birthPlace,
        death: t, cause: p.needs[N.Water] < p.needs[N.Food] ? 'thirst' : 'starvation', settlement: p.settlement,
        spouse: p.spouse, parents: p.parents, children: p.children, memories: p.memories,
      };
      s.dead.push(dead);
      const hh = this.households.get(p.household);
      if (hh) {
        hh.members = hh.members.filter((id) => id !== p.id);
        if (!hh.members.length) {
          this.households.delete(hh.id);
          s.households = s.households.filter((h) => h !== hh);
        }
      }
      // those who loved them mourn
      for (const o of s.persons) {
        if (o.partner === p.id || o.partner === -p.id) o.partner = 0;
        if (o.spouse === p.id || o.parents.includes(p.id) || o.children.includes(p.id) || (o.bonds[p.id] ?? 0) >= 0.5) {
          this.remember(o, { t, type: 'mourning', ref: p.id });
          o.needs[N.Social] = Math.max(0, o.needs[N.Social] - 0.3);
        }
        delete o.bonds[p.id];
      }
    }
    this.rosterVersion++;
  }

  // ------------------------------------------------------------- queries
  summary(): PopulationSummary {
    const s = this.state;
    const byActivity = new Array<number>(ACTIVITY_COUNT).fill(0);
    const avgNeeds = [0, 0, 0, 0, 0, 0];
    let health = 0;
    const inhabited = new Set<number>();
    for (const p of s.persons) {
      byActivity[p.activity]++;
      for (let i = 0; i < 6; i++) avgNeeds[i] += p.needs[i];
      health += p.health;
      inhabited.add(p.settlement);
    }
    const n = Math.max(1, s.persons.length);
    let pantry = 0;
    for (const h of s.households) pantry += h.food;
    return {
      alive: s.persons.length, deaths: s.dead.length, households: s.households.length, byActivity,
      avgNeeds: avgNeeds.map((v) => v / n), avgHealth: health / n, pantryMeals: pantry, inhabitedSettlements: inhabited.size,
    };
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
      flags[i] = p.activity | (p.phase !== Phase.Do ? 64 : 0) | (p.inside ? 128 : 0);
    }
    return { time: this.state.time, count, ids, pos, site, flags, summary: this.summary() };
  }

  roster(): RosterEntry[] {
    return this.state.persons.map((p) => ({
      id: p.id, name: `${p.firstName} ${p.lastName}`, sex: p.sex, birth: p.birth, look: p.look, settlement: p.settlement,
      household: p.household, home: this.households.get(p.household)?.building ?? 0,
    }));
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
      household: hh ? { name: hh.name, food: hh.food, members: [...hh.members] } : null,
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
      for (const v of p.needs) mix(Math.round(v * 1e6));
      mix(Math.round(p.health * 1e6));
      mix(p.memories.length);
    }
    for (const hh of this.state.households) mix(Math.round(hh.food * 1000));
    mix(this.state.tick);
    mix(this.rng.state);
    return h >>> 0;
  }
}
