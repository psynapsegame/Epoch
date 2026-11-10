import { SECONDS_PER_DAY, SECONDS_PER_YEAR } from './clock';
import { foundReligion } from './civilization';
import { ageAt } from './economy';
import type { Simulation } from './simulation';
import { R, T, type Person, type SettlementState, type SimBuilding } from './types';

export type DivinePower =
  | 'mountain' | 'valley' | 'forest' | 'deposit' | 'meteor' | 'drought' | 'storm' | 'fire'
  | 'animals' | 'blessing' | 'harvest' | 'blight' | 'protect' | 'hero';

export interface PowerDef {
  name: string;
  cost: number;
  effect: string;
  /** 'land': acts on the planet anywhere; 'people': needs a settlement within reach. */
  target: 'land' | 'people';
  benevolent: boolean;
  /** What a believer associates the phenomenon with. */
  focus: string;
  /** Radius of the effect in metres. */
  radius: number;
}

export const POWERS: Record<DivinePower, PowerDef> = {
  mountain: { name: 'Élever une montagne', cost: 30, effect: 'Soulève le sol : relief, froid et neiges durables', target: 'land', benevolent: true, focus: 'mountain', radius: 260 },
  valley: { name: 'Creuser une vallée', cost: 20, effect: 'Abaisse et adoucit le terrain, le rend plus fertile', target: 'land', benevolent: true, focus: 'mountain', radius: 220 },
  forest: { name: 'Faire naître une forêt', cost: 15, effect: 'Couvre la terre d’arbres : bois et gibier', target: 'land', benevolent: true, focus: 'forest', radius: 200 },
  deposit: { name: 'Créer un gisement', cost: 20, effect: 'Enfouit un filon de fer exploitable par une mine', target: 'land', benevolent: true, focus: 'mountain', radius: 70 },
  meteor: { name: 'Météorite', cost: 40, effect: 'Creuse un cratère ; détruit bâtiments et vies à l’impact', target: 'land', benevolent: false, focus: 'stars', radius: 60 },
  fire: { name: 'Incendie', cost: 25, effect: 'Brûle forêts, récoltes engrangées et maisons de bois', target: 'land', benevolent: false, focus: 'fire', radius: 110 },
  drought: { name: 'Sécheresse', cost: 25, effect: 'Deux ans de récoltes et de cueillettes misérables', target: 'people', benevolent: false, focus: 'sun', radius: 0 },
  storm: { name: 'Tempête', cost: 15, effect: 'Dix jours sans pêche ni cueillette ; chantiers abîmés', target: 'people', benevolent: false, focus: 'sea', radius: 0 },
  animals: { name: 'Envoyer du gibier', cost: 10, effect: 'Trois ans de chasse abondante', target: 'people', benevolent: true, focus: 'forest', radius: 0 },
  blessing: { name: 'Bénédiction', cost: 20, effect: 'Guérit et rassasie ; un an de naissances heureuses et de morts retardées', target: 'people', benevolent: true, focus: 'ancestors', radius: 0 },
  harvest: { name: 'Récolte miraculeuse', cost: 15, effect: 'Les champs donnent une fois et demie jusqu’au printemps', target: 'people', benevolent: true, focus: 'sun', radius: 0 },
  blight: { name: 'Récolte maudite', cost: 15, effect: 'Les champs ne donnent presque rien jusqu’au printemps', target: 'people', benevolent: false, focus: 'sun', radius: 0 },
  protect: { name: 'Protéger un peuple', cost: 30, effect: 'Dix ans à l’abri des fléaux ; ses défenseurs sont redoutables', target: 'people', benevolent: true, focus: 'ancestors', radius: 0 },
  hero: { name: 'Susciter un être d’exception', cost: 35, effect: 'Un jeune adulte reçoit des dons hors du commun', target: 'people', benevolent: true, focus: 'ancestors', radius: 0 },
};

export const POWER_ORDER: DivinePower[] = ['blessing', 'harvest', 'animals', 'protect', 'hero', 'forest', 'deposit', 'mountain', 'valley', 'storm', 'blight', 'drought', 'fire', 'meteor'];

export interface DivineAct {
  power: DivinePower;
  /** Nearest settlement (0 when the act falls on empty land). */
  settlement: number;
  /** Point of impact in that settlement's local frame (metres). */
  e: number;
  n: number;
}

export interface DivineResult {
  ok: boolean;
  /** Why the act was refused. */
  reason?: string;
  deaths: number;
  destroyed: number;
  /** Person singled out (hero). */
  person?: number;
}

const marked = (until: number, t: number) => until > t;

/** Divine marks currently in force on a settlement. */
export function marksOf(st: SettlementState, t: number): string[] {
  const out: string[] = [];
  if (marked(st.droughtUntil, t)) out.push('drought');
  if (marked(st.stormUntil, t)) out.push('storm');
  if (marked(st.blessedUntil, t)) out.push('blessed');
  if (marked(st.protectedUntil, t)) out.push('protected');
  if (marked(st.gameUntil, t)) out.push('game');
  return out;
}

function removeBuilding(sim: Simulation, st: SettlementState, b: SimBuilding): void {
  const s = sim.state;
  s.buildings = s.buildings.filter((x) => x !== b);
  st.projects = st.projects.filter((id) => id !== b.id);
  for (const h of s.households) if (h.building === b.id) h.building = 0; // homeless until a roof is found or built
  for (const p of s.persons) if (p.workplace === b.id) p.workplace = 0;
  sim.forgetBuilding(b);
}

function damage(st: SettlementState, b: SimBuilding, to: number): void {
  if (b.progress <= to) return;
  b.progress = to;
  b.completed = 0;
  if (!st.projects.includes(b.id)) st.projects.push(b.id); // builders will repair it
}

/**
 * How a people reads a divine act: awe when it matches what they worship or
 * does them good, doubt and anger when their gods seem to strike blindly.
 * A people without a faith may find one in the event.
 */
function react(sim: Simulation, st: SettlementState, power: DivinePower): void {
  const s = sim.state;
  const t = s.time;
  const def = POWERS[power];
  const civ = sim.civOf(st.id);
  if (!civ) return;
  const witnesses = s.persons.filter((p) => p.settlement === st.id && ageAt(p, t) >= 8 && !p.trip);
  if (!witnesses.length) return;
  for (const p of witnesses) sim.remember(p, { t, type: 'omen', what: power });
  const rel = s.religions[civ.religion - 1];
  let reading: string;
  if (!rel) {
    // no faith yet: the most inspired witness may give this sign a meaning
    let prophet: Person | null = null, best = 0.9;
    for (const p of witnesses) {
      const v = p.traits[T.Curiosity] + p.traits[T.Sociability];
      if (v > best && ageAt(p, t) >= 16) { best = v; prophet = p; }
    }
    if (prophet && sim.rng.next() < 0.6) {
      civ.religion = foundReligion(sim, civ, prophet, 0, def.focus).id;
      reading = 'founding';
    } else reading = 'wonder';
  } else {
    const kin = rel.focus === def.focus;
    if (def.benevolent) {
      rel.fervor = Math.min(1, rel.fervor + (kin ? 0.3 : 0.14));
      civ.legitimacy = Math.min(1, civ.legitimacy + 0.06);
      reading = kin ? 'favour' : 'grace';
    } else if (kin) {
      // their own god is angry: fear binds the faithful closer
      rel.fervor = Math.min(1, rel.fervor + 0.25);
      civ.legitimacy = Math.max(0, civ.legitimacy - 0.05);
      reading = 'wrath';
    } else {
      // a blow their faith cannot explain: doubt, and blame for the ruler
      rel.fervor = Math.max(0.1, rel.fervor - 0.15);
      civ.legitimacy = Math.max(0, civ.legitimacy - 0.14);
      for (const p of witnesses) if (p.faith === rel.id && sim.rng.next() < 0.12 * (1 - p.traits[T.Loyalty])) p.faith = 0;
      reading = 'doubt';
    }
  }
  sim.record({ t, type: 'omen', settlement: st.id, civ: civ.id, what: `${power}:${reading}`, names: [civ.culture.people, s.religions[civ.religion - 1]?.name ?? ''] });
}

/** Carries out a divine intervention. Every effect is a real, lasting change of the simulation state. */
export function applyDivine(sim: Simulation, act: DivineAct): DivineResult {
  const s = sim.state;
  const t = s.time;
  const def = POWERS[act.power];
  const res: DivineResult = { ok: false, deaths: 0, destroyed: 0 };
  if (!def) return { ...res, reason: 'Pouvoir inconnu' };
  if (s.divine.energy < def.cost) return { ...res, reason: 'Ferveur insuffisante' };
  const st = act.settlement ? sim.settlement(act.settlement) : undefined;
  const pop = st ? sim.census(st.id).pop : 0;
  if (def.target === 'people' && (!st || pop === 0)) return { ...res, reason: 'Aucun peuple à cet endroit' };
  if (st && !def.benevolent && marked(st.protectedUntil, t) && pop > 0) return { ...res, reason: 'Ce peuple est sous votre protection' };

  const near = (x: { e: number; n: number }, r: number) => Math.hypot(x.e - act.e, x.n - act.n) < r;
  const people = st ? s.persons.filter((p) => p.settlement === st.id && !p.trip && !p.army) : [];
  switch (act.power) {
    case 'meteor': {
      if (st) {
        for (const b of [...sim.buildingsOf(st.id)]) if (near(b, def.radius * 0.5 + b.radius * 0.5)) { removeBuilding(sim, st, b); res.destroyed++; }
        // the blast kills at the heart of the impact; further out, people are thrown down and hurt
        for (const p of people) {
          if (near(p, def.radius * 0.45)) { sim.kill(p, 'disaster'); res.deaths++; }
          else if (near(p, def.radius)) p.health = Math.max(0.25, p.health - 0.35);
        }
        sim.refreshSite(st.id);
      }
      break;
    }
    case 'fire': {
      if (st) {
        for (const b of [...sim.buildingsOf(st.id)]) {
          if (!near(b, def.radius) || b.kind === 'well' || b.kind === 'mine' || b.kind === 'temple' || b.kind === 'watchtower') continue; // stone stands
          if (b.kind === 'hut' || sim.rng.next() < 0.25) { removeBuilding(sim, st, b); res.destroyed++; }
          else { damage(st, b, 0.35); res.destroyed++; }
          if (b.kind === 'storehouse' || b.kind === 'barn') st.stock[R.Food] *= 0.5;
        }
        for (const p of people) {
          if (!near(p, def.radius)) continue;
          if (sim.rng.next() < 0.12) { sim.kill(p, 'disaster'); res.deaths++; }
          else p.health = Math.max(0.2, p.health - 0.3);
        }
        st.stock[R.Wood] *= 0.6;
        sim.refreshSite(st.id);
      }
      break;
    }
    case 'drought': st!.droughtUntil = t + 2 * SECONDS_PER_YEAR; st!.forage *= 0.3; break;
    case 'storm': {
      st!.stormUntil = t + 10 * SECONDS_PER_DAY;
      for (const id of st!.projects) { const b = sim.building(id); if (b) { b.progress = Math.max(0, b.progress - 0.25); res.destroyed++; } }
      sim.buildingsVersion++;
      break;
    }
    case 'animals': st!.gameUntil = t + 3 * SECONDS_PER_YEAR; st!.forage = sim.forageCapacity(st!.id); break;
    case 'blessing': {
      st!.blessedUntil = t + SECONDS_PER_YEAR;
      for (const p of people) {
        p.health = 1;
        for (let i = 0; i < 6; i++) p.needs[i] = Math.max(p.needs[i], 0.9);
      }
      break;
    }
    case 'harvest': st!.harvest = 1.5; break;
    case 'blight': st!.harvest = 0.3; break;
    case 'protect': st!.protectedUntil = t + 10 * SECONDS_PER_YEAR; st!.stormUntil = 0; st!.droughtUntil = 0; break;
    case 'hero': {
      // a young adult of promise, not the ruler
      const civ = sim.civOf(st!.id);
      let chosen: Person | null = null, best = -1;
      for (const p of people) {
        const age = ageAt(p, t);
        if (age < 16 || age > 32 || p.id === civ?.leader) continue;
        const v = p.traits[T.Intelligence] + p.traits[T.Courage] + p.traits[T.Ambition] + sim.rng.next() * 0.5;
        if (v > best) { best = v; chosen = p; }
      }
      if (!chosen) return { ...res, reason: 'Aucun jeune adulte ne peut recevoir ce don ici' };
      for (const k of [T.Intelligence, T.Courage, T.Ambition, T.Sociability, T.Curiosity]) chosen.traits[k] = Math.max(chosen.traits[k], 0.93 + sim.rng.next() * 0.06);
      for (let k = 0; k < chosen.skills.length; k++) chosen.skills[k] = Math.min(1, chosen.skills[k] + 0.3);
      chosen.health = 1;
      sim.remember(chosen, { t, type: 'chosen' });
      for (const o of people) if (o !== chosen) o.bonds[chosen.id] = Math.min(1, (o.bonds[chosen.id] ?? 0) + 0.25); // people are drawn to them
      res.person = chosen.id;
      break;
    }
    default: break; // land powers: the planet itself changes (see world/edits.ts); the peoples nearby react below
  }
  s.divine.energy -= def.cost;
  s.divine.acts++;
  res.ok = true;
  const hero = res.person ? sim.person(res.person) : undefined;
  sim.record({ t, type: 'divine', settlement: st?.id ?? 0, civ: st?.civ ?? 0, what: act.power, a: res.person, value: res.deaths, names: hero ? [sim.nameOf(hero)] : [] });
  if (st && pop > 0 && (def.target === 'people' || Math.hypot(act.e, act.n) < 420)) react(sim, st, act.power);
  sim.rosterVersion++;
  return res;
}

/** Devotion feeds the power to act: every day, a little from the world itself and more from fervent believers. */
export function divineDaily(sim: Simulation): void {
  const s = sim.state;
  let devotion = 0;
  for (const p of s.persons) if (p.faith) devotion += s.religions[p.faith - 1]?.fervor ?? 0;
  s.divine.energy = Math.min(100, s.divine.energy + 1.2 + devotion * 0.01);
}

