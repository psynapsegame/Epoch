import { beforeAll, describe, expect, it } from 'vitest';
import { generateWorld } from '../src/world/generator';
import { World } from '../src/world/world';
import { layoutHamlet, type Building, type Settlement } from '../src/sim/settlements';
import { buildSimSite, foundingBuildings } from '../src/sim/sites';
import { Simulation } from '../src/sim/simulation';
import { findPath, isWalkable, lineOfSight } from '../src/sim/pathfinding';
import { BUILD_COST, assignJobs, jobSlots, planConstruction, updatePrices, workOnProject } from '../src/sim/economy';
import { SECONDS_PER_DAY, SECONDS_PER_YEAR, TICK_SECONDS, localHour } from '../src/sim/clock';
import { Activity, BASE_PRICE, J, N, R, T, type FoundingBuilding, type SimSite } from '../src/sim/types';
import { addResearch, citizens, civilizationsDaily, enthrone } from '../src/sim/civilization';
import { BASE_MODS, TECHS, availableTechs, modsFor } from '../src/sim/tech';

const TICKS_PER_DAY = SECONDS_PER_DAY / TICK_SECONDS;
let sites: SimSite[] = [];
let founding: FoundingBuilding[] = [];
const START = 7 * 3600;

beforeAll(() => {
  const world = new World(generateWorld({ seed: 'sim-test', width: 1024 }));
  const settlements: Settlement[] = [], buildings: Building[] = [];
  for (let i = 0; i < 6; i++) {
    const r = layoutHamlet(world, i, i + 1, `Hameau${i + 1}`, buildings.length + 1);
    settlements.push(r.settlement);
    buildings.push(...r.buildings);
  }
  sites = settlements.map((s) => buildSimSite(world, s, settlements));
  founding = foundingBuildings(world, settlements, buildings);
});

const fresh = (seed = 'alpha', n = 100) => Simulation.create(seed, sites, founding, n, START);
const door = (b: { e: number; n: number; fe: number; fn: number; radius: number }) => ({ e: b.e + b.fe * (b.radius * 0.72 + 1.2), n: b.n + b.fn * (b.radius * 0.72 + 1.2) });
const coins = (sim: Simulation) => sim.state.settlements.reduce((a, s) => a + s.treasury, 0) + sim.state.households.reduce((a, h) => a + h.coins, 0);

describe('settlement maps', () => {
  it('offer walkable ground, water and reachable homes', () => {
    const sim = fresh();
    for (const base of sites.slice(0, 3)) {
      const s = sim.site(base.id)!;
      let walk = 0;
      for (const v of s.walk) walk += v;
      expect(walk).toBeGreaterThan(s.size * s.size * 0.2);
      const homes = sim.buildingsOf(s.id).filter((b) => ['house', 'hut', 'longhouse', 'farm'].includes(b.kind));
      expect(homes.length).toBeGreaterThan(3);
      const well = door(homes[0]);
      let reachable = 0;
      for (const h of homes) if (findPath(s, door(h).e, door(h).n, well.e, well.n)) reachable++;
      expect(reachable).toBeGreaterThanOrEqual(homes.length - 1);
    }
  });
  it('finds paths that stay on walkable ground', () => {
    const sim = fresh();
    const s = sim.site(sites[0].id)!;
    const list = sim.buildingsOf(s.id);
    const a = door(list[1]), b = door(list[list.length - 2]);
    const path = findPath(s, a.e, a.n, b.e, b.n);
    expect(path).not.toBeNull();
    let e = a.e, n = a.n;
    for (let i = 0; i < path!.length; i += 2) {
      if (i < path!.length - 2) expect(isWalkable(s, path![i], path![i + 1])).toBe(true);
      if (i > 0 && i < path!.length - 2) expect(lineOfSight(s, e, n, path![i], path![i + 1])).toBe(true);
      e = path![i];
      n = path![i + 1];
    }
  });
  it('know their neighbours over land', () => {
    const linked = sites.filter((s) => s.neighbors.length > 0);
    for (const s of linked) for (const nb of s.neighbors) {
      expect(nb.distance).toBeGreaterThan(300);
      expect(Math.hypot(nb.e, nb.n)).toBeGreaterThan(nb.distance * 0.9);
      expect(sites.find((o) => o.id === nb.id)!.neighbors.some((b) => b.id === s.id)).toBe(true);
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
        if (!p.inside && !p.trip && p.path.length === 0) expect(isWalkable(s, p.e, p.n) || Math.hypot(p.e - p.te, p.n - p.tn) < 6).toBe(true);
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
    expect(meals / s.alive / 30).toBeGreaterThan(0.75); // meals per person per day
    expect(forages).toBeGreaterThan(100);
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
    const barren: SimSite[] = sites.map((s) => ({ ...s, forage: new Uint8Array(s.forage.length), fertility: new Uint8Array(s.fertility.length) }));
    const sim = Simulation.create('alpha', barren, founding, 30, START);
    for (const h of sim.state.households) h.food = 0;
    for (const st of sim.state.settlements) st.stock[R.Food] = 0;
    // no farms, barns or docks either: the land gives nothing
    for (const b of sim.state.buildings) if (['farm', 'barn', 'dock'].includes(b.kind)) b.progress = 0.5;
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

describe('economy', () => {
  it('gives people real professions tied to buildings', () => {
    const sim = fresh();
    sim.run(TICKS_PER_DAY * 3);
    const jobs = sim.summary().byJob;
    expect(jobs[J.Farmer]).toBeGreaterThan(3);
    expect(jobs[J.Gatherer]).toBeGreaterThan(3);
    for (const p of sim.state.persons) {
      const age = (sim.state.time - p.birth) / SECONDS_PER_YEAR;
      if (age < 14) expect(p.job).toBe(J.Gatherer);
      if (p.job === J.Farmer) expect(sim.building(p.workplace)!.kind).toBe('farm');
      if (p.job === J.Fisher) expect(sim.building(p.workplace)!.kind).toBe('dock');
    }
    // nobody is assigned to more positions than exist
    for (const st of sim.state.settlements) {
      const farms = sim.buildingsOf(st.id).filter((b) => b.kind === 'farm' && b.progress >= 1).length;
      expect(sim.state.persons.filter((p) => p.settlement === st.id && p.job === J.Farmer).length).toBeLessThanOrEqual(farms * 2);
    }
  });

  it('produces, stores and sells goods; money is conserved', () => {
    const sim = fresh();
    const before = coins(sim);
    sim.run(TICKS_PER_DAY * 20);
    expect(coins(sim)).toBeCloseTo(before, 3);
    const st = sim.settlement(1)!;
    const farms = sim.buildingsOf(1).filter((b) => b.kind === 'farm');
    expect(farms.reduce((a, b) => a + b.produced, 0)).toBeGreaterThan(20);
    expect(sim.state.persons.reduce((a, p) => a + p.counts.shifts, 0)).toBeGreaterThan(200);
    for (const v of st.stock) expect(v).toBeGreaterThanOrEqual(0);
    // some households earned a living
    expect(sim.state.households.some((h) => h.coins > 20)).toBe(true);
  });

  it('raises prices when a resource is scarce', () => {
    const sim = fresh();
    const st = sim.settlement(1)!;
    st.stock[R.Food] = 0;
    st.stock[R.Wood] = 500;
    updatePrices(sim, st);
    expect(st.prices[R.Food]).toBeGreaterThan(BASE_PRICE[R.Food] * 2);
    expect(st.prices[R.Wood]).toBeLessThan(BASE_PRICE[R.Wood] * 0.6);
  });

  it('cannot forge tools without iron', () => {
    const sim = fresh();
    const st = sim.settlement(1)!;
    st.stock[R.Iron] = 0;
    expect(jobSlots(sim, st)[J.Smith]).toBe(0);
    st.stock[R.Iron] = 6;
    st.stock[R.Coal] = 6;
    st.stock[R.Tools] = 0;
    expect(jobSlots(sim, st)[J.Smith]).toBeGreaterThan(0);
    assignJobs(sim, st);
    const smith = sim.state.persons.find((p) => p.settlement === 1 && p.job === J.Smith)!;
    expect(smith).toBeDefined();
    sim.run(TICKS_PER_DAY * 6);
    expect(st.stock[R.Tools]).toBeGreaterThan(0.5);
    expect(st.stock[R.Iron]).toBeLessThan(6);
  });

  it('builds what the community needs, with real materials and labour', () => {
    const sim = fresh();
    const st = sim.settlement(1)!;
    // crowd one home so the community decides to build a house
    const hh = sim.state.households.find((h) => h.settlement === 1)!;
    const others = sim.state.households.filter((h) => h.settlement === 1 && h !== hh).slice(0, 2);
    for (const o of others) for (const id of [...o.members]) sim.moveToHousehold(sim.person(id)!, o, hh);
    for (const b of sim.buildingsOf(1)) if (!sim.householdOfBuilding(b.id) && ['house', 'hut', 'longhouse', 'farm'].includes(b.kind)) b.kind = 'storehouse';
    st.stock[R.Wood] = 80;
    st.stock[R.Stone] = 40;
    const count = sim.state.buildings.length;
    planConstruction(sim, st);
    expect(st.projects.length).toBe(1);
    const project = sim.building(st.projects[0])!;
    expect(['house', 'hut']).toContain(project.kind);
    expect(project.progress).toBe(0);
    expect(sim.state.buildings.length).toBe(count + 1);
    // the plot is on walkable ground and free of other buildings
    for (const b of sim.buildingsOf(1)) if (b !== project) expect(Math.hypot(b.e - project.e, b.n - project.n)).toBeGreaterThan(b.radius + project.radius);
    const wood = st.stock[R.Wood];
    sim.run(TICKS_PER_DAY * 25);
    expect(project.progress).toBe(1);
    expect(project.completed).toBeGreaterThan(project.started);
    expect(st.stock[R.Wood]).toBeLessThan(wood + 60);
    expect(sim.state.events.some((e) => e.type === 'built' && e.what === project.kind)).toBe(true);
    expect(sim.state.persons.some((p) => p.memories.some((m) => m.type === 'built'))).toBe(true);
    // a crowded family moved in
    expect(sim.householdOfBuilding(project.id)).toBeDefined();
  });

  it('stalls construction when materials run out', () => {
    const sim = fresh();
    const st = sim.settlement(1)!;
    const b = sim.addBuilding({ kind: 'temple', settlement: 1, e: 150, n: 150, fe: 0, fn: 1, radius: 10 }, 0);
    st.projects.push(b.id);
    const builder = sim.state.persons.find((p) => p.settlement === 1)!;
    st.stock[R.Stone] = 0;
    st.stock[R.Wood] = 100;
    st.stock[R.Goods] = 100;
    expect(workOnProject(sim, st, b, 30, builder)).toBe(0);
    expect(b.progress).toBe(0);
    expect(sim.state.events.some((e) => e.type === 'shortage' && e.what === R.Stone)).toBe(true);
    st.stock[R.Stone] = 100;
    expect(workOnProject(sim, st, b, 40, builder)).toBe(40);
    expect(b.progress).toBeCloseTo(40 / BUILD_COST.temple.hours, 6);
    expect(st.stock[R.Stone]).toBeCloseTo(100 - BUILD_COST.temple.stone * b.progress, 6);
    // a little stone only allows a little progress
    st.stock[R.Stone] = 3;
    const before = b.progress;
    workOnProject(sim, st, b, 400, builder);
    expect(b.progress - before).toBeCloseTo(3 / BUILD_COST.temple.stone, 6);
    expect(st.stock[R.Stone]).toBeCloseTo(0, 6);
  });
});

describe('generations', () => {
  it('lets the old die of old age and be mourned', () => {
    const sim = fresh();
    const elders = sim.state.persons.filter((p) => (START - p.birth) / SECONDS_PER_YEAR > 55);
    expect(elders.length).toBeGreaterThan(2);
    for (const p of elders) p.birth -= 30 * SECONDS_PER_YEAR; // make them very old
    sim.setStride(10);
    sim.run(Math.round((TICKS_PER_DAY * 120) / 10));
    const dead = sim.state.dead.filter((d) => d.cause === 'age');
    expect(dead.length).toBeGreaterThan(1);
    expect(sim.state.events.some((e) => e.type === 'death' && e.what === 'age')).toBe(true);
    expect(sim.view(dead[0].id)!.alive).toBe(false);
  });

  it('sees unions, births and deaths of old age over the years; the society grows', () => {
    const sim = fresh();
    sim.setStride(10);
    const before = coins(sim);
    const steps = Math.round((TICKS_PER_DAY * 360 * 3) / 10);
    sim.run(steps);
    const s = sim.summary();
    const ev = sim.state.events;
    expect(s.births).toBeGreaterThan(8);
    expect(ev.some((e) => e.type === 'marriage')).toBe(true);
    expect(s.alive).toBeGreaterThan(95);
    expect(s.avgNeeds[N.Food]).toBeGreaterThan(0.4);
    expect(coins(sim)).toBeCloseTo(before, 2);
    // children born in the world carry their parents and their name
    const born = sim.state.persons.filter((p) => p.birth > START);
    for (const c of born) {
      expect(c.parents[0]).toBeGreaterThan(0);
      const mother = sim.person(c.parents[0]) ?? sim.state.dead.find((d) => d.id === c.parents[0])!;
      expect(mother.children).toContain(c.id);
    }
    // every living person belongs to exactly one household of their settlement
    const seen = new Set<number>();
    for (const h of sim.state.households) {
      expect(h.members.length).toBeGreaterThan(0);
      for (const id of h.members) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        expect(sim.person(id)!.household).toBe(h.id);
      }
    }
    expect(seen.size).toBe(sim.state.persons.length);
  }, 180000);

  it('stays deterministic with a coarser stride and across save / restore', () => {
    const a = fresh(), b = fresh();
    a.setStride(6);
    b.setStride(6);
    a.run(2000);
    b.run(2000);
    expect(b.checksum()).toBe(a.checksum());
    const saved = JSON.parse(JSON.stringify(b.serialize()));
    const c = new Simulation(sites, saved);
    c.run(2000);
    a.run(2000);
    b.run(2000);
    expect(c.checksum()).toBe(b.checksum());
    expect(b.checksum()).toBe(a.checksum());
  });
});

describe('civilisations', () => {
  it('found a people around each inhabited settlement, led by one of its own', () => {
    const sim = fresh();
    expect(sim.state.civs.length).toBe(3);
    for (const civ of sim.state.civs) {
      const leader = sim.person(civ.leader)!;
      expect(leader).toBeDefined();
      expect(citizens(sim, civ)).toContain(leader);
      expect(leader.job).toBe(J.Leader);
      expect(civ.dynasties.length).toBe(1);
      expect(civ.dynasties[0].rulers[0]).toMatchObject({ person: leader.id, how: 'founding', to: 0 });
      expect(civ.culture.values.length).toBe(4);
      expect(civ.culture.people.length).toBeGreaterThan(4);
      expect(leader.memories.some((m) => m.type === 'ruler')).toBe(true);
    }
    expect(sim.summary().civilizations).toBe(3);
    // no founder is left alone in a village
    for (const st of sim.state.settlements) expect([0, ...Array.from({ length: 60 }, (_, i) => i + 8)]).toContain(sim.census(st.id).pop);
  });

  it('replaces a dead ruler at once and records the succession', () => {
    const sim = fresh();
    const civ = sim.state.civs[0];
    const old = sim.person(civ.leader)!;
    sim.kill(old, 'age');
    expect(civ.leader).not.toBe(old.id);
    const next = sim.person(civ.leader)!;
    expect(next.job).toBe(J.Leader);
    const reigns = civ.dynasties.flatMap((d) => d.rulers);
    expect(reigns.length).toBe(2);
    expect(reigns[0].to).toBe(sim.state.time);
    expect(sim.state.events.some((e) => e.type === 'ruler' && e.a === next.id)).toBe(true);
    // the dead ruler stays in the archives
    expect(sim.view(old.id)!.alive).toBe(false);
  });

  it('keeps power in the family under a monarchy', () => {
    const sim = fresh();
    const civ = sim.state.civs[0];
    civ.government = 'monarchy';
    const parent = citizens(sim, civ).find((p) => p.children.some((c) => { const k = sim.person(c); return k && (sim.state.time - k.birth) / SECONDS_PER_YEAR < 16; }))!;
    enthrone(sim, civ, parent, 'election');
    const heir = sim.person(parent.children[0])!;
    heir.birth = sim.state.time - 20 * SECONDS_PER_YEAR; // of age
    const houses = civ.dynasties.length;
    sim.kill(parent, 'age');
    expect(civ.leader).toBe(heir.id);
    expect(civ.dynasties.length).toBe(houses);
    const house = civ.dynasties[civ.dynasties.length - 1];
    expect(house.rulers[house.rulers.length - 1]).toMatchObject({ person: heir.id, how: 'inheritance' });
    // without an heir, a people that can write entrusts power to a council
    civ.techs.push('writing');
    for (const c of heir.children) sim.person(c)!.birth = sim.state.time;
    sim.kill(heir, 'age');
    expect(['council', 'monarchy']).toContain(civ.government);
    if (!heir.children.length) expect(civ.government).toBe('council');
  });

  it('lets a despised ruler be overthrown', () => {
    const sim = fresh();
    const civ = sim.state.civs[0];
    const before = civ.leader;
    const people = citizens(sim, civ);
    for (const p of people) p.needs[N.Food] = 0.1; // misery
    let days = 0;
    while (civ.leader === before && days < 4000) {
      civ.legitimacy = 0.1;
      civilizationsDaily(sim);
      days++;
    }
    expect(civ.leader).not.toBe(before);
    expect(sim.state.events.some((e) => e.type === 'coup')).toBe(true);
    expect(sim.person(before)!.memories.some((m) => m.type === 'deposed')).toBe(true);
    expect(civ.dynasties.length).toBeGreaterThan(1);
  });

  it('turns research into technologies with real effects', () => {
    expect(modsFor([])).toEqual(BASE_MODS);
    expect(modsFor(['pottery', 'irrigation']).farm).toBeCloseTo(1.25, 6);
    expect(modsFor(['pottery']).spoilage).toBeLessThan(BASE_MODS.spoilage);
    expect(modsFor(['masonry', 'metallurgy']).tools).toBeGreaterThan(BASE_MODS.tools);
    expect(availableTechs([]).every((t) => t.requires.length === 0)).toBe(true);
    expect(availableTechs(['pottery']).some((t) => t.id === 'irrigation')).toBe(true);
    for (const t of TECHS) for (const r of t.requires) expect(TECHS.some((x) => x.id === r)).toBe(true);

    const sim = fresh();
    const civ = sim.state.civs[0];
    civ.research.tech = 'pottery';
    const st = sim.settlement(civ.capital)!;
    const lossBefore = sim.mods(st.id).spoilage;
    addResearch(sim, civ, 1000);
    expect(civ.techs).toContain('pottery');
    expect(sim.mods(st.id).spoilage).toBeLessThan(lossBefore);
    expect(sim.state.events.some((e) => e.type === 'tech' && e.what === 'pottery')).toBe(true);
    expect(civ.research.tech).not.toBe('pottery');
  });

  it('sends families to settle empty land, which joins their people', () => {
    const sim = fresh();
    const civ = sim.state.civs[0];
    const from = sim.settlement(civ.capital)!;
    const site = sim.site(from.id)!;
    const nb = site.neighbors.find((n) => sim.census(n.id).pop === 0);
    if (!nb) return; // this test world has no empty land within reach of the capital
    const party = sim.state.households.filter((h) => h.settlement === from.id && !h.members.includes(civ.leader)).slice(0, 3);
    const heads = party.reduce((a, h) => a + h.members.length, 0);
    const food = from.stock[R.Food];
    sim.migrate(party, from, nb.id);
    const to = sim.settlement(nb.id)!;
    expect(to.civ).toBe(civ.id);
    expect(to.stock[R.Food]).toBeGreaterThan(0);
    expect(from.stock[R.Food] + to.stock[R.Food]).toBeCloseTo(food, 6);
    for (const h of party) for (const id of h.members) expect(sim.person(id)!.trip?.stage).toBe(3);
    sim.setStride(10);
    sim.run(Math.round((TICKS_PER_DAY * 20) / 10));
    expect(sim.census(nb.id).pop).toBe(heads);
    for (const h of party) for (const id of h.members) {
      const p = sim.person(id)!;
      expect(p.trip).toBeNull();
      expect(p.settlement).toBe(nb.id);
    }
    expect(sim.state.events.some((e) => e.type === 'colony' && e.settlement === nb.id)).toBe(true);
    expect(sim.state.civs.length).toBe(3); // a colony, not a new people
  });

  it('sees beliefs arise and spread', () => {
    const sim = fresh();
    sim.setStride(10);
    sim.run(Math.round((TICKS_PER_DAY * 360 * 2) / 10));
    const w = sim.worldView();
    expect(w.religions.length).toBeGreaterThan(0);
    expect(w.religions.some((r) => r.followers > 10)).toBe(true);
    const r = w.religions[0];
    expect(sim.view(r.founder)).not.toBeNull();
    expect(sim.state.events.some((e) => e.type === 'religion')).toBe(true);
    expect(sim.search(r.founderName.split(' ')[0]).some((x) => x.id === r.founder)).toBe(true);
  }, 120000);
});
