import { beforeAll, describe, expect, it } from 'vitest';
import { generateWorld } from '../src/world/generator';
import { World } from '../src/world/world';
import { layoutHamlet, type Building, type Settlement } from '../src/sim/settlements';
import { buildSimSite } from '../src/sim/sites';
import { Simulation } from '../src/sim/simulation';
import { findPath, isWalkable, lineOfSight } from '../src/sim/pathfinding';
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, TICK_SECONDS, localHour } from '../src/sim/clock';
import { Activity, N, T, type SimSite } from '../src/sim/types';

const TICKS_PER_DAY = SECONDS_PER_DAY / TICK_SECONDS;
let sites: SimSite[] = [];
const START = 7 * 3600;

beforeAll(() => {
  const world = new World(generateWorld({ seed: 'sim-test', width: 1024 }));
  const settlements: Settlement[] = [], buildings: Building[] = [];
  for (let i = 0; i < 6; i++) {
    const r = layoutHamlet(world, i, i + 1, `Hameau${i + 1}`, buildings.length + 1);
    settlements.push(r.settlement);
    buildings.push(...r.buildings);
  }
  sites = settlements.map((s) => buildSimSite(world, s, buildings));
});

const fresh = (seed = 'alpha', n = 100) => Simulation.create(seed, sites, n, START);

describe('settlement maps', () => {
  it('offer walkable ground, water and reachable homes', () => {
    for (const s of sites.slice(0, 3)) {
      let walk = 0;
      for (const v of s.walk) walk += v;
      expect(walk).toBeGreaterThan(s.size * s.size * 0.2);
      expect(s.water.length).toBeGreaterThan(0);
      const homes = s.buildings.filter((b) => ['house', 'hut', 'longhouse', 'farm'].includes(b.kind));
      expect(homes.length).toBeGreaterThan(3);
      const well = s.water[0];
      let reachable = 0;
      for (const h of homes) if (findPath(s, h.doorE, h.doorN, well.e, well.n)) reachable++;
      expect(reachable).toBeGreaterThanOrEqual(homes.length - 1);
    }
  });
  it('finds paths that stay on walkable ground', () => {
    const s = sites[0];
    const a = s.buildings[1], b = s.buildings[s.buildings.length - 2];
    const path = findPath(s, a.doorE, a.doorN, b.doorE, b.doorN);
    expect(path).not.toBeNull();
    let e = a.doorE, n = a.doorN;
    for (let i = 0; i < path!.length; i += 2) {
      expect(isWalkable(s, path![i], path![i + 1])).toBe(true);
      if (i > 0) expect(lineOfSight(s, e, n, path![i], path![i + 1])).toBe(true);
      e = path![i];
      n = path![i + 1];
    }
  });
});

describe('founding population', () => {
  it('creates exactly the requested number of unique individuals', () => {
    const sim = fresh();
    const ps = sim.state.persons;
    expect(ps.length).toBe(100);
    expect(new Set(ps.map((p) => p.id)).size).toBe(100);
    for (const p of ps) {
      expect(p.firstName.length).toBeGreaterThan(1);
      expect(p.traits.length).toBe(9);
      for (const t of p.traits) { expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1); }
      expect(p.birth).toBeLessThan(START);
      expect(p.memories[0].type).toBe('born');
    }
  });
  it('builds coherent families and households', () => {
    const sim = fresh();
    const byId = new Map(sim.state.persons.map((p) => [p.id, p]));
    let couples = 0, children = 0;
    for (const p of sim.state.persons) {
      if (p.spouse) {
        couples++;
        expect(byId.get(p.spouse)!.spouse).toBe(p.id);
        expect(byId.get(p.spouse)!.household).toBe(p.household);
      }
      for (const c of p.children) {
        const child = byId.get(c)!;
        expect(child.parents).toContain(p.id);
        expect(child.birth).toBeGreaterThan(p.birth + 15 * SECONDS_PER_YEAR);
        expect(child.lastName).toBe(p.lastName);
        children++;
      }
      const hh = sim.household(p.household)!;
      expect(hh.members).toContain(p.id);
      expect(hh.settlement).toBe(p.settlement);
    }
    expect(couples).toBeGreaterThan(10);
    expect(children).toBeGreaterThan(10);
    const total = sim.state.households.reduce((a, h) => a + h.members.length, 0);
    expect(total).toBe(100);
    // no dwelling houses two families
    expect(new Set(sim.state.households.map((h) => h.building)).size).toBe(sim.state.households.length);
  });
  it('gives individuals distinct personalities', () => {
    const sim = fresh();
    const soc = sim.state.persons.map((p) => p.traits[T.Sociability]);
    expect(Math.max(...soc) - Math.min(...soc)).toBeGreaterThan(0.4);
  });
});

describe('simulation', () => {
  it('is deterministic', () => {
    const a = fresh(), b = fresh();
    a.run(TICKS_PER_DAY * 2);
    b.run(TICKS_PER_DAY * 2);
    expect(a.checksum()).toBe(b.checksum());
    const c = fresh('beta');
    c.run(TICKS_PER_DAY * 2);
    expect(c.checksum()).not.toBe(a.checksum());
  });

  it('continues identically after a save / restore', () => {
    const a = fresh();
    a.run(TICKS_PER_DAY);
    const saved = JSON.parse(JSON.stringify(a.serialize()));
    a.run(TICKS_PER_DAY);
    const b = new Simulation(sites, saved);
    b.run(TICKS_PER_DAY);
    expect(b.checksum()).toBe(a.checksum());
    expect(b.state.time).toBe(a.state.time);
  });

  it('keeps everyone on walkable ground or indoors', () => {
    const sim = fresh();
    for (let d = 0; d < 40; d++) {
      sim.run(37);
      for (const p of sim.state.persons) {
        const s = sim.site(p.settlement)!;
        if (!p.inside && p.path.length === 0) expect(isWalkable(s, p.e, p.n) || Math.hypot(p.e - p.te, p.n - p.tn) < 6).toBe(true);
        for (const v of p.needs) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      }
    }
  });

  it('lets a society feed itself for weeks', () => {
    const sim = fresh();
    sim.run(TICKS_PER_DAY * 30);
    const s = sim.summary();
    expect(s.alive).toBeGreaterThanOrEqual(97);
    expect(s.avgNeeds[N.Food]).toBeGreaterThan(0.45);
    expect(s.avgNeeds[N.Water]).toBeGreaterThan(0.45);
    expect(s.avgNeeds[N.Sleep]).toBeGreaterThan(0.4);
    const meals = sim.state.persons.reduce((a, p) => a + p.counts.meals, 0);
    const forages = sim.state.persons.reduce((a, p) => a + p.counts.forages, 0);
    expect(meals / s.alive / 30).toBeGreaterThan(1.2); // meals per person per day
    expect(forages).toBeGreaterThan(300);
  });

  it('makes hungry people eat and thirsty people drink', () => {
    const sim = fresh();
    const p = sim.state.persons.find((x) => (START - x.birth) / SECONDS_PER_YEAR > 20)!;
    p.needs[N.Food] = 0.05;
    p.needs[N.Water] = 0.5;
    sim.household(p.household)!.food = 10;
    expect(sim.utilities(p).sort((a, b) => b.score - a.score)[0].activity).toBe(Activity.Eating);
    sim.run(180);
    expect(p.needs[N.Food]).toBeGreaterThan(0.8);
    p.needs[N.Water] = 0.03;
    expect(sim.utilities(p).sort((a, b) => b.score - a.score)[0].activity).toBe(Activity.Drinking);
    sim.run(240);
    expect(p.needs[N.Water]).toBeGreaterThan(0.6);
  });

  it('lets starvation kill when there is nothing to eat', () => {
    const barren: SimSite[] = sites.map((s) => ({ ...s, forage: new Uint8Array(s.forage.length) }));
    const sim = Simulation.create('alpha', barren, 30, START);
    for (const h of sim.state.households) h.food = 0;
    sim.run(TICKS_PER_DAY * 12);
    expect(sim.state.dead.length).toBeGreaterThan(5);
    expect(sim.state.dead[0].cause).toBe('starvation');
    const mourners = sim.state.persons.filter((p) => p.memories.some((m) => m.type === 'mourning'));
    if (sim.state.persons.length) expect(mourners.length).toBeGreaterThan(0);
    // the dead keep their identity in the archive
    expect(sim.state.dead[0].firstName.length).toBeGreaterThan(1);
  });

  it('sleeps at night and is active by day', () => {
    const sim = fresh();
    sim.run(TICKS_PER_DAY * 3);
    const lon = sim.site(sim.state.persons[0].settlement)!.longitude;
    let nightAsleep = 0, nightN = 0, dayAsleep = 0, dayN = 0;
    for (let i = 0; i < TICKS_PER_DAY * 2; i += 20) {
      sim.run(20);
      const h = localHour(sim.state.time, lon);
      const group = sim.state.persons.filter((p) => Math.abs(sim.site(p.settlement)!.longitude - lon) < 0.01);
      const asleep = group.filter((p) => p.activity === Activity.Sleeping).length / group.length;
      if (h > 0 && h < 4) { nightAsleep += asleep; nightN++; }
      if (h > 10 && h < 16) { dayAsleep += asleep; dayN++; }
    }
    expect(nightAsleep / nightN).toBeGreaterThan(0.7);
    expect(dayAsleep / dayN).toBeLessThan(0.25);
  });

  it('lets personality shape behaviour', () => {
    const sim = fresh();
    sim.run(TICKS_PER_DAY * 30);
    const adults = sim.state.persons.filter((p) => (sim.state.time - p.birth) / SECONDS_PER_YEAR >= 14);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const split = (trait: number, count: (p: (typeof adults)[number]) => number) => {
      const sorted = [...adults].sort((a, b) => a.traits[trait] - b.traits[trait]);
      const third = Math.floor(sorted.length / 3);
      return [mean(sorted.slice(0, third).map(count)), mean(sorted.slice(-third).map(count))];
    };
    const [shy, outgoing] = split(T.Sociability, (p) => p.counts.chats);
    expect(outgoing).toBeGreaterThan(shy * 1.15);
    const [incurious, curious] = split(T.Curiosity, (p) => p.counts.explorations);
    expect(curious).toBeGreaterThan(incurious * 1.3);
  });

  it('forms friendships and memories over time', () => {
    const sim = fresh();
    sim.run(TICKS_PER_DAY * 40);
    const friends = sim.state.persons.filter((p) => p.memories.some((m) => m.type === 'friend')).length;
    expect(friends).toBeGreaterThan(5);
    for (const p of sim.state.persons) expect(p.memories.length).toBeLessThanOrEqual(40);
  });
});
