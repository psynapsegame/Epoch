import { Rng } from '../core/rng';
import { SECONDS_PER_YEAR } from './clock';
import { dwellingCapacity } from './sites';
import { Activity, Phase, SKILL_COUNT, SKILL_EXPLORE, SKILL_SOCIAL, type Household, type Person, type SimBuilding, type SimSite } from './types';

const FEMALE = ['Aëla', 'Brune', 'Cyanne', 'Dalia', 'Elwen', 'Fara', 'Gaïa', 'Hélia', 'Isaure', 'Jana', 'Kaëlle', 'Lyra', 'Maëve', 'Nérie', 'Oriane', 'Perle', 'Rhéa', 'Sélène', 'Talia', 'Una', 'Vesna', 'Ysolde', 'Zélie', 'Amara', 'Bérénice', 'Clio', 'Doria', 'Enora', 'Flore', 'Ilse', 'Liv', 'Mira', 'Nour', 'Ondine', 'Sibylle', 'Thaïs'];
const MALE = ['Alaric', 'Bran', 'Cael', 'Doran', 'Edric', 'Faël', 'Gauvain', 'Hadrien', 'Ivar', 'Joris', 'Kael', 'Lothar', 'Maël', 'Nils', 'Oren', 'Perrin', 'Ronan', 'Soren', 'Tarek', 'Ulric', 'Vadim', 'Wulf', 'Yann', 'Zeno', 'Aubin', 'Brieuc', 'Corwin', 'Darius', 'Emrys', 'Galen', 'Idris', 'Léandre', 'Milo', 'Octave', 'Silas', 'Théo'];
const FAM_A = ['Val', 'Mor', 'Bel', 'Car', 'Dun', 'Fer', 'Gal', 'Har', 'Lor', 'Mal', 'Nor', 'Ost', 'Pen', 'Roc', 'Sal', 'Tor', 'Ver', 'Ald', 'Bran', 'Cor', 'Esk', 'Font', 'Grim', 'Haut'];
const FAM_B = ['mont', 'ric', 'vane', 'dor', 'lac', 'bois', 'val', 'ren', 'gard', 'wyn', 'mar', 'iel', 'eau', 'court', 'ville', 'as', 'ier', 'and', 'feld', 'holm'];

export const SKIN_TONES = 6;
export const HAIR_TONES = 6;
export const TUNIC_TONES = 10;

const trait = (rng: Rng) => (rng.next() + rng.next()) / 2;

export const firstNameFor = (rng: Rng, sex: 0 | 1): string => rng.pick(sex === 0 ? FEMALE : MALE);

/** A blank individual with a random temperament; callers fill in family, home and history. */
export function blankPerson(rng: Rng, id: number, sex: 0 | 1, birth: number, lastName: string, place: string, settlement: number, household: number, time: number): Person {
  return {
    id, firstName: firstNameFor(rng, sex), lastName, sex, birth, birthPlace: place,
    look: { skin: rng.int(0, SKIN_TONES - 1), hair: rng.int(0, HAIR_TONES - 1), tunic: rng.int(0, TUNIC_TONES - 1), height: 0.92 + rng.next() * 0.16 },
    traits: Array.from({ length: 9 }, () => trait(rng)),
    needs: [0.55 + rng.next() * 0.4, 0.55 + rng.next() * 0.4, 0.6 + rng.next() * 0.35, 0.9, 0.9, 0.5 + rng.next() * 0.4],
    skills: new Array<number>(SKILL_COUNT).fill(0),
    health: 1, job: 0, workplace: 0, faith: 0, pregnantUntil: 0, lastBirth: -1e12,
    household, settlement, spouse: 0, parents: [0, 0], children: [], bonds: {},
    memories: [{ t: birth, type: 'born', place }],
    e: 0, n: 0, activity: Activity.Idle, phase: Phase.Do, te: 0, tn: 0, path: [], until: time, partner: 0,
    carry: 0, carryRes: 0, trip: null, army: 0, inside: false,
    counts: { meals: 0, forages: 0, chats: 0, explorations: 0, gifts: 0, shifts: 0 },
  };
}

const FAM_MID = ['', '', 'de', 'an', 'el', 'ar', 'in', 'os'];

function familyName(rng: Rng, used: Set<string>): string {
  // short names first; longer ones as the world fills up; namesakes only when every name is taken
  for (let attempt = 0; ; attempt++) {
    const mid = attempt < 12 ? '' : rng.pick(FAM_MID);
    const n = rng.pick(FAM_A) + mid + rng.pick(FAM_B);
    if (!used.has(n) || attempt > 200) {
      used.add(n);
      return n;
    }
  }
}

export interface Founders {
  persons: Person[];
  households: Household[];
  nextId: number;
}

/**
 * Founds the first population: families housed in the dwellings of the
 * founding hamlets. Deterministic for a given seed, sites and start time.
 */
export function createPopulation(seedRng: Rng, sites: SimSite[], buildings: SimBuilding[], count: number, time: number): Founders {
  const rng = seedRng.fork('population');
  const persons: Person[] = [];
  const households: Household[] = [];
  const usedNames = new Set<string>();
  let nextId = 1;

  const makePerson = (site: SimSite, hh: Household, sex: 0 | 1, age: number, lastName: string, home: { e: number; n: number }, baseSkin: number): Person => {
    const birth = time - (age + rng.next()) * SECONDS_PER_YEAR;
    const p = blankPerson(rng, nextId++, sex, birth, lastName, site.name, site.id, hh.id, time);
    p.look.skin = Math.max(0, Math.min(SKIN_TONES - 1, baseSkin + rng.int(-1, 1)));
    if (age >= 12) p.skills[0] = 0.1 + rng.next() * 0.25;
    p.skills[SKILL_SOCIAL] = rng.next() * 0.2;
    p.skills[SKILL_EXPLORE] = rng.next() * 0.15;
    p.e = home.e + rng.range(-1.5, 1.5);
    p.n = home.n + rng.range(-1.5, 1.5);
    persons.push(p);
    hh.members.push(p.id);
    return p;
  };

  const marry = (a: Person, b: Person) => {
    a.spouse = b.id;
    b.spouse = a.id;
    const t = Math.min(time - SECONDS_PER_YEAR * 0.2, Math.max(a.birth, b.birth) + (17 + rng.next() * 6) * SECONDS_PER_YEAR);
    a.memories.push({ t, type: 'married', ref: b.id });
    b.memories.push({ t, type: 'married', ref: a.id });
  };

  // The founders settle the three best sites rather than crowding into one.
  const quota = Math.ceil(count / Math.min(3, Math.max(1, sites.length)));
  const skins = sites.map(() => rng.int(1, SKIN_TONES - 2));
  // second pass (quota lifted) houses whoever is left in the same three places: nobody founds a village alone
  outer: for (let pass = 0; pass < 2; pass++) for (const site of sites.slice(0, 3)) {
    const baseSkin = skins[sites.indexOf(site)];
    const siteStart = pass === 0 ? persons.length : -1e9;
    const homes = buildings
      .filter((b) => b.settlement === site.id && dwellingCapacity(b.kind) > 0 && !households.some((h) => h.building === b.id))
      .sort((a, b) => Math.hypot(a.e, a.n) - Math.hypot(b.e, b.n) || a.id - b.id);
    for (const home of homes) {
      if (count - persons.length <= 0) break outer;
      const remaining = Math.min(count - persons.length, quota - (persons.length - siteStart));
      if (remaining <= 0) break;
      const cap = Math.min(dwellingCapacity(home.kind), remaining);
      const lastName = familyName(rng, usedNames);
      const hh: Household = { id: households.length + 1, name: lastName, settlement: site.id, building: home.id, members: [], food: 0, coins: 15 };
      households.push(hh);
      const reach = home.radius * 0.72 + 1.2;
      const door = { e: home.e + home.fe * reach, n: home.n + home.fn * reach };
      const kind = rng.next();
      const members: Person[] = [];
      if (kind < 0.62 && cap >= 2) {
        // couple, usually with children
        const ageF = 19 + rng.next() * 24, ageM = ageF + rng.range(-1, 7);
        const mother = makePerson(site, hh, 0, ageF, lastName, door, baseSkin);
        const father = makePerson(site, hh, 1, Math.max(18, ageM), lastName, door, baseSkin);
        marry(mother, father);
        members.push(mother, father);
        const kids = Math.min(cap - 2, kind < 0.12 ? 0 : rng.int(1, 3));
        for (let k = 0; k < kids; k++) {
          const maxAge = Math.min(16, ageF - 18.5);
          if (maxAge < 0.5) break;
          const child = makePerson(site, hh, rng.chance(0.5) ? 0 : 1, rng.next() * maxAge, lastName, door, baseSkin);
          child.parents = [mother.id, father.id];
          // children inherit part of their parents' temperament and looks
          for (let t = 0; t < 9; t++) child.traits[t] = 0.33 * mother.traits[t] + 0.33 * father.traits[t] + 0.34 * child.traits[t];
          child.look.skin = rng.chance(0.5) ? mother.look.skin : father.look.skin;
          child.look.hair = rng.chance(0.5) ? mother.look.hair : father.look.hair;
          for (const par of [mother, father]) {
            par.children.push(child.id);
            par.memories.push({ t: child.birth, type: 'child', ref: child.id });
          }
          if (mother.lastBirth < child.birth) mother.lastBirth = child.birth;
          members.push(child);
        }
      } else if (kind < 0.76) {
        // single parent
        const sex: 0 | 1 = rng.chance(0.6) ? 0 : 1;
        const age = 24 + rng.next() * 20;
        const parent = makePerson(site, hh, sex, age, lastName, door, baseSkin);
        members.push(parent);
        const kids = Math.min(cap - 1, rng.int(1, 2));
        for (let k = 0; k < kids; k++) {
          const child = makePerson(site, hh, rng.chance(0.5) ? 0 : 1, rng.next() * Math.min(15, age - 18), lastName, door, baseSkin);
          child.parents = sex === 0 ? [parent.id, 0] : [0, parent.id];
          for (let t = 0; t < 9; t++) child.traits[t] = 0.5 * parent.traits[t] + 0.5 * child.traits[t];
          parent.children.push(child.id);
          parent.memories.push({ t: child.birth, type: 'child', ref: child.id });
          members.push(child);
        }
      } else if (kind < 0.9 && cap >= 2) {
        // elders
        const a = makePerson(site, hh, 0, 54 + rng.next() * 16, lastName, door, baseSkin);
        const b = makePerson(site, hh, 1, 55 + rng.next() * 17, lastName, door, baseSkin);
        marry(a, b);
        members.push(a, b);
      } else {
        members.push(makePerson(site, hh, rng.chance(0.5) ? 0 : 1, 18 + rng.next() * 40, lastName, door, baseSkin));
      }
      for (const m of members) {
        m.memories.sort((x, y) => x.t - y.t);
        m.memories.push({ t: time, type: 'settled', place: site.name });
        for (const o of members) if (o !== m) m.bonds[o.id] = 0.6 + rng.next() * 0.3;
      }
      hh.food = members.length * (1.5 + rng.next());
    }
  }
  return { persons, households, nextId };
}
