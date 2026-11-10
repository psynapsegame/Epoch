import { clamp01 } from '../core/math';
import { DAYS_PER_YEAR, SECONDS_PER_DAY, SECONDS_PER_YEAR } from './clock';
import { ageAt, countKind, isAdult } from './economy';
import { dwellingCapacity } from './sites';
import type { Simulation } from './simulation';
import { TECH_BY_ID, availableTechs } from './tech';
import {
  J, N, R, SKILL_SOCIAL, T,
  type Accession, type Civilization, type Culture, type Household, type Person, type Religion, type SettlementState,
} from './types';

export const CIV_COLORS = 8;
const TRADITIONS = ['jousts', 'harvestFeast', 'greatFair', 'storytelling'];
const FOCUS_NAMES: Record<string, string[]> = {
  sea: ['les Marées', 'la Mère des Flots', 'l’Abîme'],
  sun: ['le Soleil Invaincu', 'l’Aube', 'le Grand Jour'],
  mountain: ['la Montagne', 'les Cimes', 'la Pierre Dressée'],
  forest: ['la Forêt Ancienne', 'les Racines', 'le Cerf Blanc'],
  river: ['la Rivière', 'les Eaux Vives', 'la Source'],
  ancestors: ['les Ancêtres', 'les Premiers Foyers', 'les Aïeux'],
  fire: ['la Flamme', 'le Feu Gardien', 'la Braise'],
  stars: ['les Étoiles', 'la Voûte', 'la Veilleuse'],
};

const leaderOf = (sim: Simulation, civ: Civilization) => (civ.leader ? sim.person(civ.leader) : undefined);
const reigning = (civ: Civilization) => civ.dynasties[civ.dynasties.length - 1];

/** Everyone living in a civilisation's settlements. */
export function citizens(sim: Simulation, civ: Civilization): Person[] {
  const ids = new Set(sim.state.settlements.filter((s) => s.civ === civ.id).map((s) => s.id));
  return sim.state.persons.filter((p) => ids.has(p.settlement));
}

function cultureFrom(people: Person[], name: string, rngPick: number): Culture {
  const avg = (i: number) => people.reduce((a, p) => a + p.traits[i], 0) / Math.max(1, people.length);
  const values = [
    (avg(T.Aggression) + avg(T.Courage)) / 2,
    (avg(T.Altruism) + avg(T.Loyalty)) / 2,
    (avg(T.Ambition) + avg(T.Sociability)) / 2,
    (avg(T.Intelligence) + avg(T.Curiosity)) / 2,
  ];
  // founders' leanings are amplified into a recognisable identity
  const mean = values.reduce((a, b) => a + b, 0) / 4;
  const sharp = values.map((v) => clamp01(0.5 + (v - mean) * 6));
  let top = 0;
  for (let i = 1; i < 4; i++) if (sharp[i] > sharp[top]) top = i;
  const stem = name.replace(/[aeiouyé]+$/i, '');
  return { people: `${stem}iens`, values: sharp, traditions: [TRADITIONS[top]], festivalDay: 30 + Math.floor(rngPick * 300) };
}

/** A people gathers around its settlement: a civilisation is born, with a first chief. */
export function foundCivilization(sim: Simulation, st: SettlementState): Civilization {
  const s = sim.state;
  const site = sim.site(st.id)!;
  const people = s.persons.filter((p) => p.settlement === st.id);
  const id = s.civs.length + 1;
  const civ: Civilization = {
    id, name: site.name, color: (id - 1) % CIV_COLORS, capital: st.id, founded: s.time, leader: 0, government: 'chiefdom',
    legitimacy: 0.7, dynasties: [], culture: cultureFrom(people, site.name, sim.rng.next()), religion: 0,
    techs: [], research: { tech: null, progress: 0 }, lastColony: s.time, fallen: 0,
  };
  s.civs.push(civ);
  st.civ = id;
  if (!st.origin) st.origin = id;
  st.founded = s.time;
  for (const e of s.events) if (e.type === 'founded' && e.settlement === st.id && !e.civ) e.civ = id;
  sim.record({ t: s.time, type: 'civ', settlement: st.id, civ: id });
  // a people is recognised by its colours
  for (const p of people) p.look.tunic = (civ.color * 3 + (p.id % 4)) % 10;
  chooseLeader(sim, civ, 'founding');
  return civ;
}

function popularity(sim: Simulation, p: Person, people: Person[]): number {
  let friends = 0;
  for (const o of people) if ((o.bonds[p.id] ?? 0) > 0.3) friends++;
  const age = ageAt(p, sim.state.time);
  return p.traits[T.Ambition] * 0.4 + p.traits[T.Sociability] * 0.3 + p.traits[T.Intelligence] * 0.2 + p.skills[SKILL_SOCIAL] * 0.5 +
    friends * 0.03 + (age >= 28 && age < 60 ? 0.15 : 0);
}

/** Installs a ruler and records the reign (a new house unless power stays in the family). */
export function enthrone(sim: Simulation, civ: Civilization, p: Person, how: Accession): void {
  const s = sim.state;
  const t = s.time;
  const current = reigning(civ);
  const last = current?.rulers[current.rulers.length - 1];
  if (last && !last.to) last.to = t;
  const previous = last ? sim.person(last.person) ?? s.dead.find((d) => d.id === last.person) : undefined;
  const sameHouse = !!previous && (previous.children.includes(p.id) || p.parents.includes(previous.id) ||
    previous.parents.some((x) => x && p.parents.includes(x)) || previous.spouse === p.id) && how === 'inheritance';
  const reign = { person: p.id, name: sim.nameOf(p), from: t, to: 0, how };
  if (sameHouse && current) current.rulers.push(reign);
  else civ.dynasties.push({ name: p.lastName, founder: p.id, from: t, rulers: [reign] });
  const old = leaderOf(sim, civ);
  if (old && old.id !== p.id) {
    old.job = J.Gatherer;
    old.workplace = 0;
  }
  civ.leader = p.id;
  p.job = J.Leader;
  p.workplace = seatOf(sim, civ);
  civ.legitimacy = how === 'coup' ? 0.4 : how === 'revolt' ? 0.55 : how === 'inheritance' ? 0.65 : 0.75;
  sim.remember(p, { t, type: 'ruler', place: civ.name });
  sim.record({ t, type: how === 'coup' || how === 'revolt' ? 'coup' : 'ruler', settlement: civ.capital, civ: civ.id, a: p.id, b: old?.id, what: how, names: [sim.nameOf(p), old ? sim.nameOf(old) : ''] });
  sim.rosterVersion++;
}

/** Building from which the ruler governs: the great house, else the temple. */
function seatOf(sim: Simulation, civ: Civilization): number {
  const list = sim.buildingsOf(civ.capital);
  return (list.find((b) => b.kind === 'longhouse' && b.progress >= 1) ?? list.find((b) => b.kind === 'temple' && b.progress >= 1))?.id ?? 0;
}

/** Fills an empty seat of power: heir first in a monarchy (or for an ambitious house), election otherwise. */
export function chooseLeader(sim: Simulation, civ: Civilization, how: Accession, former?: Person | { children: number[]; traits?: number[]; id: number }): void {
  const t = sim.state.time;
  const people = citizens(sim, civ).filter((p) => ageAt(p, t) >= 18 && !p.trip);
  if (!people.length) { civ.leader = 0; return; }
  if (how !== 'coup' && how !== 'revolt' && former) {
    // inheritance: eldest adult child. A chief's house keeps power only if it was ambitious enough to impose it.
    const heirs = former.children.map((id) => sim.person(id)).filter((c): c is Person => !!c && ageAt(c, t) >= 16 && people.includes(c))
      .sort((a, b) => a.birth - b.birth);
    const imposes = civ.government === 'monarchy' || (civ.government === 'chiefdom' && (former.traits?.[T.Ambition] ?? 0) > 0.6 && civ.legitimacy > 0.5);
    if (heirs.length && imposes) {
      if (civ.government !== 'monarchy') {
        civ.government = 'monarchy';
        sim.record({ t, type: 'government', settlement: civ.capital, civ: civ.id, what: 'monarchy' });
      }
      enthrone(sim, civ, heirs[0], 'inheritance');
      return;
    }
    if (civ.government === 'monarchy' && !heirs.length && civ.techs.includes('writing')) {
      // the line is broken: a literate people entrusts power to a council
      civ.government = 'council';
      sim.record({ t, type: 'government', settlement: civ.capital, civ: civ.id, what: 'council' });
    } else if (civ.government === 'monarchy' && !heirs.length) {
      civ.government = 'chiefdom';
      sim.record({ t, type: 'government', settlement: civ.capital, civ: civ.id, what: 'chiefdom' });
    }
  }
  let best = people[0], bestScore = -Infinity;
  for (const p of people) {
    const score = popularity(sim, p, people) + sim.rng.next() * 0.1;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  enthrone(sim, civ, best, how === 'founding' ? 'founding' : how === 'coup' || how === 'revolt' ? how : 'election');
}

/** Called when a person dies: an empty throne is filled at once. */
export function onDeath(sim: Simulation, dead: Person): void {
  for (const civ of sim.state.civs) {
    if (civ.leader !== dead.id) continue;
    civ.leader = 0;
    chooseLeader(sim, civ, 'election', dead);
  }
}

// --------------------------------------------------------------- research
function pickResearch(sim: Simulation, civ: Civilization): void {
  const options = availableTechs(civ.techs);
  if (!options.length) { civ.research.tech = null; return; }
  const leader = leaderOf(sim, civ);
  const capital = sim.settlement(civ.capital);
  const list = sim.buildingsOf(civ.capital);
  let best = options[0], bestScore = -Infinity;
  for (const tech of options) {
    // rulers study what their people lack; curious ones wander further afield
    let need = 0;
    if (capital) {
      const pop = sim.census(civ.capital).pop;
      const foodDays = capital.stock[R.Food] / Math.max(1, pop);
      if (tech.field === 'Agriculture') need += foodDays < 4 ? 1.2 : 0.4;
      if (tech.id === 'boats' || tech.id === 'sailing') need += countKind(list, 'dock') ? 0.8 : -0.5;
      if (tech.field === 'Métallurgie') need += capital.stock[R.Iron] > 0 || list.some((b) => b.kind === 'mine') ? 0.9 : 0.1;
      if (tech.field === 'Architecture') need += capital.projects.length ? 0.8 : 0.3;
      if (tech.field === 'Médecine') need += 0.4;
      if (tech.field === 'Commerce') need += civ.culture.values[2];
      if (tech.field === 'Écriture' || tech.field === 'Sciences') need += civ.culture.values[3];
      if (tech.field === 'Armement') need += civ.culture.values[0] * 0.8;
    }
    const score = need - tech.cost / 400 + sim.rng.next() * (0.3 + (leader?.traits[T.Curiosity] ?? 0.5) * 0.6);
    if (score > bestScore) { bestScore = score; best = tech; }
  }
  civ.research.tech = best.id;
}

/** Adds research points; completes the technology when its cost is reached. */
export function addResearch(sim: Simulation, civ: Civilization, points: number, by?: Person): void {
  if (!civ.research.tech) pickResearch(sim, civ);
  const tech = civ.research.tech ? TECH_BY_ID.get(civ.research.tech) : undefined;
  if (!tech) return;
  civ.research.progress += points;
  if (civ.research.progress < tech.cost) return;
  civ.research.progress -= tech.cost;
  civ.techs.push(tech.id);
  civ.research.tech = null;
  sim.modsChanged();
  const t = sim.state.time;
  sim.record({ t, type: 'tech', settlement: civ.capital, civ: civ.id, what: tech.id, a: by?.id, names: by ? [sim.nameOf(by)] : [] });
  if (by) sim.remember(by, { t, type: 'discoveryTech', what: tech.id });
  pickResearch(sim, civ);
}

/** A merchant returning from a people that knows more brings ideas home. */
export function contact(sim: Simulation, home: number, abroad: number): void {
  const a = sim.civOf(home), b = sim.civOf(abroad);
  if (!a || !b || a === b || !a.research.tech) return;
  if (b.techs.includes(a.research.tech)) addResearch(sim, a, 1.5);
}

// --------------------------------------------------------------- religion
function focusFor(sim: Simulation, st: SettlementState): string {
  const site = sim.site(st.id)!;
  const options = ['ancestors', 'sun', 'stars', 'fire'];
  if (site.coastal) options.push('sea', 'sea');
  if (site.water.length) options.push('river');
  let trees = 0, rock = 0;
  for (let k = 0; k < site.wood.length; k += 7) { if (site.wood[k] > 120) trees++; if (site.kind[k] === 3) rock++; }
  if (trees > site.wood.length / 7 / 4) options.push('forest', 'forest');
  if (rock > site.wood.length / 7 / 12) options.push('mountain', 'mountain');
  return options[Math.floor(sim.rng.next() * options.length)];
}

export function foundReligion(sim: Simulation, civ: Civilization, prophet: Person, parent: number, forced?: string): Religion {
  const s = sim.state;
  const st = sim.settlement(prophet.settlement)!;
  let focus = forced ?? focusFor(sim, st);
  const parentRel = s.religions.find((r) => r.id === parent);
  if (parentRel && focus === parentRel.focus) focus = focus === 'ancestors' ? 'stars' : 'ancestors';
  const names = FOCUS_NAMES[focus];
  const used = new Set(s.religions.map((r) => r.name));
  let name = '';
  for (const prefix of parent ? ['Voie réformée de', 'Nouvelle alliance de', 'Culte de', 'Mystères de'] : ['Culte de', 'Mystères de', 'Voie de']) {
    for (const n of names) {
      const candidate = `${prefix} ${n}`.replace('de les ', 'des ').replace('de le ', 'du ');
      if (!used.has(candidate) && !name) name = candidate;
    }
  }
  if (!name) name = `Culte de ${names[0]} (${s.religions.length + 1})`.replace('de les ', 'des ').replace('de le ', 'du ');
  const rel: Religion = {
    id: s.religions.length + 1, name, focus, founder: prophet.id, founderName: sim.nameOf(prophet), founded: s.time,
    origin: civ.id, parent, fervor: 0.7, ended: 0,
  };
  s.religions.push(rel);
  prophet.faith = rel.id;
  sim.remember(prophet, { t: s.time, type: 'prophet', what: rel.name });
  sim.record({ t: s.time, type: parent ? 'schism' : 'religion', settlement: prophet.settlement, civ: civ.id, a: prophet.id, what: rel.name, names: [sim.nameOf(prophet), parentRel?.name ?? ''] });
  return rel;
}

function religionStep(sim: Simulation, civ: Civilization, people: Person[], newYear: boolean): void {
  const s = sim.state;
  const rng = sim.rng;
  const t = s.time;
  // birth of a faith: a charismatic seeker gives words to what the people feel
  if (!civ.religion && people.length >= 20) {
    const hasTemple = s.settlements.some((st) => st.civ === civ.id && countKind(sim.buildingsOf(st.id), 'temple') > 0);
    if (rng.next() < (hasTemple ? 0.02 : 0.004)) {
      let prophet: Person | null = null, best = 1.1;
      for (const p of people) {
        const v = p.traits[T.Curiosity] + p.traits[T.Sociability] + (ageAt(p, t) > 30 ? 0.1 : -0.3);
        if (v > best && ageAt(p, t) >= 18) { best = v; prophet = p; }
      }
      if (prophet) civ.religion = foundReligion(sim, civ, prophet, 0).id;
    }
  }
  if (!s.religions.length) return;
  // faith spreads through families and friendships
  for (const p of people) {
    if (ageAt(p, t) < 10) continue;
    if (!p.faith) {
      if (civ.religion && rng.next() < 0.012 * (0.6 + p.traits[T.Sociability])) {
        p.faith = civ.religion;
        sim.remember(p, { t, type: 'faith', what: s.religions[civ.religion - 1]?.name });
      }
      continue;
    }
    if (rng.next() > 0.004) continue;
    // drawn to the belief of those one loves, unless loyal to one's own
    const tally = new Map<number, number>();
    for (const k of Object.keys(p.bonds)) {
      const o = sim.person(+k);
      if (o && o.faith && p.bonds[+k] > 0.3) tally.set(o.faith, (tally.get(o.faith) ?? 0) + p.bonds[+k]);
    }
    let fav = p.faith, top = (tally.get(p.faith) ?? 0) + 0.6 + p.traits[T.Loyalty];
    for (const [f, w] of tally) if (w > top) { top = w; fav = f; }
    if (fav !== p.faith) {
      p.faith = fav;
      sim.remember(p, { t, type: 'faith', what: s.religions[fav - 1]?.name });
    }
  }
  if (!newYear) return;
  // schism: in a large, restless community a dissenter breaks away with kin and friends
  const state = s.religions[civ.religion - 1];
  if (state && people.length >= 70) {
    const followers = people.filter((p) => p.faith === state.id);
    const unrest = (1 - civ.legitimacy) * 0.5 + (1 - state.fervor) * 0.3;
    if (followers.length >= 50 && rng.next() < 0.04 + unrest * 0.12) {
      let rebel: Person | null = null, best = 1.2;
      for (const p of followers) {
        const v = p.traits[T.Curiosity] + (1 - p.traits[T.Loyalty]) + p.traits[T.Sociability] * 0.5;
        if (v > best && ageAt(p, t) >= 20 && p.id !== civ.leader) { best = v; rebel = p; }
      }
      if (rebel) {
        const sect = foundReligion(sim, civ, rebel, state.id);
        const hh = sim.household(rebel.household);
        for (const p of followers) {
          if (p === rebel) continue;
          if (hh?.members.includes(p.id) || (p.bonds[rebel.id] ?? 0) > 0.3) {
            p.faith = sect.id;
            sim.remember(p, { t, type: 'faith', what: sect.name });
          }
        }
        state.fervor = Math.min(1, state.fervor + 0.15); // the faithful close ranks
      }
    }
  }
}

/** Updates fervour and retires religions nobody follows any more (world-wide, once a day). */
export function religionCensus(sim: Simulation): Map<number, number> {
  const s = sim.state;
  const count = new Map<number, number>();
  for (const p of s.persons) if (p.faith) count.set(p.faith, (count.get(p.faith) ?? 0) + 1);
  for (const r of s.religions) {
    if (r.ended) continue;
    const n = count.get(r.id) ?? 0;
    if (n === 0 && s.time - r.founded > 30 * SECONDS_PER_DAY) {
      r.ended = s.time;
      for (const c of s.civs) if (c.religion === r.id) c.religion = 0;
      sim.record({ t: s.time, type: 'faithEnd', settlement: 0, what: r.name });
    }
    r.fervor = Math.max(0.15, r.fervor - 0.0004); // devotion fades unless something rekindles it
  }
  return count;
}

// ----------------------------------------------------------- colonisation
/** Sends a few families to settle empty land when the mother settlement is thriving or cramped. */
function colonise(sim: Simulation, civ: Civilization): void {
  const s = sim.state;
  const t = s.time;
  if (t - civ.lastColony < 2 * SECONDS_PER_YEAR) return;
  const leader = leaderOf(sim, civ);
  const mods = sim.modsOf(civ);
  for (const st of s.settlements) {
    if (st.civ !== civ.id) continue;
    const { pop } = sim.census(st.id);
    if (pop < 48) continue;
    let beds = 0;
    for (const b of sim.buildingsOf(st.id)) if (b.progress >= 1) beds += dwellingCapacity(b.kind);
    const pressure = pop / Math.max(1, beds) + (st.stock[R.Food] / pop < 2 ? 0.3 : 0) + (leader ? leader.traits[T.Ambition] * 0.4 : 0);
    if (pressure < 0.95 || sim.rng.next() > 0.01) continue;
    const site = sim.site(st.id)!;
    // best empty land within reach
    let target = 0, bestScore = 0;
    for (const nb of site.neighbors) {
      const other = sim.settlement(nb.id);
      const land = sim.site(nb.id);
      if (!other || !land || other.civ || sim.census(nb.id).pop > 0) continue;
      if (nb.overSea && !(mods.sailing && countKind(sim.buildingsOf(st.id), 'dock') > 0)) continue;
      const homes = sim.buildingsOf(nb.id).filter((b) => dwellingCapacity(b.kind) > 0).length;
      const hasWater = land.water.length > 0 || sim.buildingsOf(nb.id).some((b) => b.kind === 'well');
      if (!hasWater) continue;
      const score = land.richness + homes * 0.08 + (land.coastal ? 0.1 : 0) - nb.distance / 12000;
      if (score > bestScore) { bestScore = score; target = nb.id; }
    }
    if (!target) continue;
    // a few young households volunteer (never the ruler's)
    const hhs = s.households.filter((h) => h.settlement === st.id && !h.members.includes(civ.leader) &&
      h.members.some((id) => { const p = sim.person(id); return p && isAdult(p, t) && ageAt(p, t) < 45; }) &&
      !h.members.some((id) => sim.person(id)?.trip));
    hhs.sort((a, b) => {
      const young = (h: Household) => Math.min(...h.members.map((id) => { const p = sim.person(id)!; return isAdult(p, t) ? ageAt(p, t) : 99; }));
      return young(a) - young(b) || a.id - b.id;
    });
    const party: Household[] = [];
    let heads = 0;
    for (const h of hhs) {
      if (heads >= 12 || party.length >= 4) break;
      party.push(h);
      heads += h.members.length;
    }
    if (heads < 6) continue;
    sim.migrate(party, st, target);
    civ.lastColony = t;
    return;
  }
}

// ---------------------------------------------------------------- politics
function politics(sim: Simulation, civ: Civilization, people: Person[], newYear: boolean): void {
  const s = sim.state;
  const t = s.time;
  const leader = leaderOf(sim, civ);
  if (!leader || !people.includes(leader)) {
    civ.leader = 0;
    chooseLeader(sim, civ, 'election', leader);
    return;
  }
  // legitimacy follows the people's lot and the ruler's skill
  let food = 0, hungry = 0;
  for (const p of people) food += p.needs[N.Food];
  for (const st of s.settlements) if (st.civ === civ.id) hungry = Math.max(hungry, st.hungryDays);
  const rel = s.religions[civ.religion - 1];
  const house = reigning(civ);
  // a people at war tires of it; a restless temperament is harder to rule
  const unrest = people.reduce((a, p) => a + p.traits[T.Aggression] + p.traits[T.Ambition], 0) / people.length / 2;
  const reign = house?.rulers[house.rulers.length - 1];
  const years = reign ? (t - reign.from) / SECONDS_PER_YEAR : 0;
  const target = clamp01(0.42 + (food / people.length - 0.65) * 0.9 + leader.skills[J.Leader] * 0.1 + leader.skills[SKILL_SOCIAL] * 0.05
    - Math.min(0.25, Math.max(0, years - 6) * 0.012) // long reigns wear thin
    - (unrest - 0.5) * 0.6 - (sim.atWar(civ.id) ? 0.12 : 0) - Math.max(0, people.length - 60) * 0.0015
    + (rel && leader.faith === rel.id ? rel.fervor * 0.12 : 0) + Math.min(0.12, (house?.rulers.length ?? 1) * 0.03) - Math.min(0.5, hungry * 0.06));
  civ.legitimacy += (target - civ.legitimacy) * 0.03;

  // every year brings its quarrels and scandals, worse under a harsh ruler
  if (newYear) civ.legitimacy = Math.max(0, civ.legitimacy - sim.rng.next() * 0.28 * (0.4 + leader.traits[T.Aggression]));
  // a council re-elects its first sage every eight years
  if (civ.government === 'council' && newYear) {
    if (reign && t - reign.from >= 8 * SECONDS_PER_YEAR) chooseLeader(sim, civ, 'election');
  }
  // a despised ruler invites usurpers; a starving people rises
  if (civ.legitimacy < 0.3 && sim.rng.next() < (hungry > 3 ? 0.02 : 0.006)) {
    let rival: Person | null = null, best = 0.45;
    for (const p of people) {
      if (p === leader || ageAt(p, t) < 20 || p.trip) continue;
      const v = p.traits[T.Ambition] * (0.5 + p.traits[T.Aggression]) + p.traits[T.Courage] * 0.2;
      if (v > best) { best = v; rival = p; }
    }
    if (rival) {
      sim.remember(leader, { t, type: 'deposed', ref: rival.id });
      enthrone(sim, civ, rival, hungry > 3 ? 'revolt' : 'coup');
      leader.bonds[rival.id] = -0.8;
      rival.bonds[leader.id] = -0.5;
    }
  }
}

/** Yearly festival of the people: a shared feast paid from the granary. */
function festival(sim: Simulation, civ: Civilization, people: Person[]): void {
  const s = sim.state;
  let fed = false;
  for (const st of s.settlements) {
    if (st.civ !== civ.id) continue;
    const pop = sim.census(st.id).pop;
    if (pop && st.stock[R.Food] >= pop * 1.5) {
      st.stock[R.Food] -= pop * 0.5;
      fed = true;
    }
  }
  if (!fed) return; // no feast in lean times
  for (const p of people) {
    p.needs[N.Social] = Math.min(1, p.needs[N.Social] + 0.35);
    if (ageAt(p, s.time) >= 6 && sim.rng.next() < 0.25) sim.remember(p, { t: s.time, type: 'feast' });
  }
  civ.legitimacy = Math.min(1, civ.legitimacy + 0.04);
  const rel = s.religions[civ.religion - 1];
  if (rel) rel.fervor = Math.min(1, rel.fervor + 0.05);
  sim.record({ t: s.time, type: 'festival', settlement: civ.capital, civ: civ.id, what: civ.culture.traditions[0] });
}

/** Children grow into the values of their people (cultural transmission). */
function upbringing(civ: Civilization, people: Person[], time: number): void {
  const v = civ.culture.values;
  const pull: [number, number][] = [[T.Courage, v[0]], [T.Aggression, v[0] * 0.7], [T.Altruism, v[1]], [T.Loyalty, v[1]], [T.Ambition, v[2]], [T.Sociability, v[2]], [T.Intelligence, v[3]], [T.Curiosity, v[3]]];
  for (const p of people) {
    const age = ageAt(p, time);
    if (age < 5 || age >= 16) continue;
    for (const [trait, value] of pull) p.traits[trait] += (value - p.traits[trait]) * 0.02;
  }
}

/** Everything a civilisation does once per simulated day. */
export function civilizationsDaily(sim: Simulation): void {
  const s = sim.state;
  const day = Math.floor(s.time / SECONDS_PER_DAY);
  const doy = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const newYear = doy === 0;
  // an inhabited settlement that belongs to nobody founds its own people
  for (const st of s.settlements) if (!st.civ && sim.census(st.id).pop >= 6) foundCivilization(sim, st);
  for (const civ of s.civs) {
    if (civ.fallen) continue;
    const people = citizens(sim, civ);
    if (!people.length) {
      civ.fallen = s.time;
      civ.leader = 0;
      const house = reigning(civ);
      const last = house?.rulers[house.rulers.length - 1];
      if (last && !last.to) last.to = s.time;
      for (const st of s.settlements) if (st.civ === civ.id) st.civ = 0;
      sim.record({ t: s.time, type: 'civ', settlement: civ.capital, civ: civ.id, what: 'fallen' });
      continue;
    }
    // the capital follows the people
    if (sim.census(civ.capital).pop === 0 || sim.settlement(civ.capital)?.civ !== civ.id) {
      let best = civ.capital, n = 0;
      for (const st of s.settlements) if (st.civ === civ.id && sim.census(st.id).pop > n) { n = sim.census(st.id).pop; best = st.id; }
      civ.capital = best;
    }
    politics(sim, civ, people, newYear);
    religionStep(sim, civ, people, newYear);
    // everyday curiosity: a people learns a little even without scholars
    addResearch(sim, civ, people.length * 0.001 * sim.modsOf(civ).research);
    colonise(sim, civ);
    if (doy === civ.culture.festivalDay) festival(sim, civ, people);
    if (newYear) {
      upbringing(civ, people, s.time);
      const fresh = cultureFrom(people, civ.name, 0).values;
      civ.culture.values = civ.culture.values.map((v, i) => v + (fresh[i] - v) * 0.08);
    }
    const leader = leaderOf(sim, civ);
    if (leader && leader.job !== J.Leader) leader.job = J.Leader;
    if (leader && !leader.workplace) leader.workplace = seatOf(sim, civ);
  }
  religionCensus(sim);
}
