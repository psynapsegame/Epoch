import { clamp01 } from '../core/math';
import { DAYS_PER_YEAR, SECONDS_PER_DAY, SECONDS_PER_YEAR } from './clock';
import { citizens, foundCivilization } from './civilization';
import { ageAt, countKind, isAdult } from './economy';
import type { Simulation } from './simulation';
import {
  J, R, T,
  type Army, type Civilization, type Person, type Relation, type SettlementState, type War, type WarCause,
} from './types';

const ROUND = 20 * 60; // seconds between rounds of a battle
const leader = (sim: Simulation, c: Civilization) => (c.leader ? sim.person(c.leader) : undefined);
const alive = (c: Civilization | undefined): c is Civilization => !!c && !c.fallen;

export function relationOf(sim: Simulation, x: number, y: number): Relation {
  const a = Math.min(x, y), b = Math.max(x, y);
  let r = sim.state.relations.find((q) => q.a === a && q.b === b);
  if (!r) {
    r = { a, b, opinion: 0.1, status: 'peace', since: sim.state.time, truceUntil: 0, grievance: 0, tension: 'rivalry' };
    sim.state.relations.push(r);
  }
  return r;
}

export const atWar = (sim: Simulation, civ: number): boolean => sim.state.relations.some((r) => r.status === 'war' && (r.a === civ || r.b === civ));
const settlementsOf = (sim: Simulation, civ: number): SettlementState[] => sim.state.settlements.filter((s) => s.civ === civ);

/** Fighting strength of a people: its able adults, its martial spirit, its weapons. */
export function strength(sim: Simulation, civ: Civilization): number {
  const t = sim.state.time;
  let adults = 0;
  for (const p of citizens(sim, civ)) if (isAdult(p, t)) adults++;
  const armed = settlementsOf(sim, civ.id).some((s) => s.stock[R.Tools] >= 1);
  return adults * (0.5 + civ.culture.values[0]) * sim.modsOf(civ).military * (armed ? 1.15 : 1);
}

/** Soldiers a settlement keeps under arms: a small watch in peace, a levy in war. */
export function soldierSlots(sim: Simulation, st: SettlementState, adults: number): number {
  const civ = sim.civOf(st.id);
  if (!civ) return 0;
  const martial = civ.culture.values[0];
  if (atWar(sim, civ.id)) return Math.ceil(adults * (0.18 + 0.15 * martial));
  const tower = countKind(sim.buildingsOf(st.id), 'watchtower') > 0;
  return (tower ? 2 : 0) + Math.floor(adults * 0.05 * martial);
}

/** Do two peoples live close enough to know (and trouble) each other? Returns their closest pair of settlements. */
export function contactBetween(sim: Simulation, a: Civilization, b: Civilization): { from: number; to: number; distance: number } | null {
  const canSail = (c: Civilization, st: number) => sim.modsOf(c).sailing && countKind(sim.buildingsOf(st), 'dock') > 0;
  let best: { from: number; to: number; distance: number } | null = null;
  for (const sa of settlementsOf(sim, a.id)) {
    const site = sim.site(sa.id);
    if (!site) continue;
    for (const nb of site.neighbors) {
      if (sim.settlement(nb.id)?.civ !== b.id) continue;
      if (nb.overSea && !canSail(a, sa.id) && !canSail(b, nb.id)) continue;
      if (!best || nb.distance < best.distance) best = { from: sa.id, to: nb.id, distance: nb.distance };
    }
  }
  return best;
}

/** Slow drift of how two peoples regard each other, from what actually happens between them. */
function updateOpinion(sim: Simulation, r: Relation, a: Civilization, b: Civilization, contact: { distance: number }): void {
  const s = sim.state;
  const la = leader(sim, a), lb = leader(sim, b);
  const since = s.time - 2 * SECONDS_PER_YEAR;
  let trades = 0;
  for (let i = s.events.length - 1; i >= 0 && s.events[i].t > since; i--) {
    const e = s.events[i];
    if (e.type !== 'trade') continue;
    const ca = sim.settlement(e.settlement)?.civ, cb = sim.settlement(e.b ?? 0)?.civ;
    if ((ca === a.id && cb === b.id) || (ca === b.id && cb === a.id)) trades++;
  }
  const ra = s.religions[a.religion - 1], rb = s.religions[b.religion - 1];
  let similar = 0;
  for (let i = 0; i < 4; i++) similar += 1 - Math.abs(a.culture.values[i] - b.culture.values[i]);
  const sa = strength(sim, a), sb = strength(sim, b);
  const iron = (c: Civilization) => settlementsOf(sim, c.id).some((st) => st.stock[R.Iron] + st.stock[R.Gold] > 3);
  // what pushes them apart, by cause
  const against: Record<WarCause, number> = {
    territory: contact.distance < 1500 ? 0.3 : contact.distance < 2500 ? 0.12 : 0,
    rivalry: 0.3 * ((la?.traits[T.Aggression] ?? 0.4) + (lb?.traits[T.Aggression] ?? 0.4)) / 2 + 0.25 * (a.culture.values[0] + b.culture.values[0]) / 2,
    religion: ra && rb && ra.id !== rb.id ? 0.3 * (ra.fervor + rb.fervor) / 2 : 0,
    resources: iron(a) !== iron(b) ? 0.18 : 0,
    security: Math.max(sa, sb) > Math.min(sa, sb) * 1.8 ? 0.15 : 0,
  };
  let worst: WarCause = 'rivalry';
  for (const k of Object.keys(against) as WarCause[]) if (against[k] > against[worst]) worst = k;
  r.tension = worst;
  const together = 0.15 + Math.min(0.35, trades * 0.05) + (ra && rb && ra.id === rb.id ? 0.25 : 0) + (similar / 4 - 0.5) * 0.4;
  const target = Math.max(-1, Math.min(1, together - Object.values(against).reduce((x, y) => x + y, 0) - r.grievance));
  r.opinion += (target - r.opinion) * 0.004;
  r.grievance = Math.max(0, r.grievance - 0.2 / (10 * DAYS_PER_YEAR)); // old wounds close over a decade
}

export function declareWar(sim: Simulation, r: Relation, attacker: Civilization, defender: Civilization): void {
  const s = sim.state;
  r.status = 'war';
  r.since = s.time;
  const war: War = {
    id: s.wars.length + 1, attacker: attacker.id, defender: defender.id, cause: r.tension, start: s.time, end: 0,
    deathsAttacker: 0, deathsDefender: 0, battles: 0, takenByAttacker: [], takenByDefender: [], outcome: '',
  };
  s.wars.push(war);
  sim.record({ t: s.time, type: 'war', settlement: attacker.capital, civ: attacker.id, b: defender.id, what: war.cause, names: [attacker.name, defender.name] });
  // allies of the attacked people are drawn in
  for (const q of s.relations) {
    if (q.status !== 'alliance' || (q.a !== defender.id && q.b !== defender.id)) continue;
    const ally = s.civs[(q.a === defender.id ? q.b : q.a) - 1];
    if (!alive(ally) || ally.id === attacker.id) continue;
    const ra = relationOf(sim, ally.id, attacker.id);
    if (ra.status === 'war') continue;
    ra.status = 'war';
    ra.since = s.time;
    s.wars.push({ ...war, id: s.wars.length + 1, attacker: attacker.id, defender: ally.id, takenByAttacker: [], takenByDefender: [] });
    sim.record({ t: s.time, type: 'war', settlement: ally.capital, civ: ally.id, b: attacker.id, what: 'alliance', names: [ally.name, attacker.name] });
  }
}

function makePeace(sim: Simulation, war: War, r: Relation): void {
  const s = sim.state;
  war.end = s.time;
  const a = war.takenByAttacker.length * 3 + war.deathsDefender * 0.1, d = war.takenByDefender.length * 3 + war.deathsAttacker * 0.1;
  war.outcome = a > d * 1.2 ? 'attacker' : d > a * 1.2 ? 'defender' : 'draw';
  r.status = 'peace';
  r.since = s.time;
  r.truceUntil = s.time + 6 * SECONDS_PER_YEAR;
  r.grievance = Math.min(0.6, r.grievance + 0.25 + (war.deathsAttacker + war.deathsDefender) * 0.004);
  r.opinion = Math.min(r.opinion, -0.1);
  const A = s.civs[war.attacker - 1], D = s.civs[war.defender - 1];
  sim.record({ t: s.time, type: 'peace', settlement: A.capital, civ: A.id, b: D.id, what: war.outcome, names: [A.name, D.name], value: war.deathsAttacker + war.deathsDefender });
  // the armies still in the field go home
  for (const army of s.armies) if (army.war === war.id && army.state !== 'return') sendHome(sim, army);
}

// ----------------------------------------------------------------- armies
function fighters(sim: Simulation, ids: number[]): Person[] {
  const out: Person[] = [];
  for (const id of ids) {
    const p = sim.person(id);
    if (p && p.health > 0.3) out.push(p);
  }
  return out;
}

function power(sim: Simulation, p: Person, bonus: number): number {
  const age = ageAt(p, sim.state.time);
  const st = sim.settlement(p.settlement);
  const armed = st && st.stock[R.Tools] >= 1 ? 1.2 : 1;
  return (0.5 + p.skills[J.Soldier]) * (0.6 + 0.8 * p.traits[T.Courage]) * sim.mods(p.settlement).military * armed * (age > 50 ? 0.75 : 1) * bonus;
}

/** Raises an army from a settlement's soldiers and sends it against an enemy settlement. */
function raiseArmy(sim: Simulation, civ: Civilization, war: War, from: number, target: number): void {
  const s = sim.state;
  const site = sim.site(from)!;
  const nb = site.neighbors.find((n) => n.id === target);
  if (!nb) return;
  const soldiers = s.persons.filter((p) => p.settlement === from && p.job === J.Soldier && !p.army && !p.trip && p.health > 0.5);
  if (soldiers.length < 4) return;
  const army: Army = {
    id: (s.armies.reduce((m, a) => Math.max(m, a.id), 0)) + 1, civ: civ.id, war: war.id, home: from, target, members: soldiers.map((p) => p.id),
    initial: soldiers.length, state: 'march', defenders: [], defendersInitial: 0, since: s.time, nextRound: 0,
  };
  s.armies.push(army);
  soldiers.forEach((p, i) => {
    // drawn up in ranks outside the enemy settlement
    const a = (i / soldiers.length) * Math.PI * 2;
    sim.march(p, army.id, 4, nb.e + Math.cos(a) * (28 + (i % 3) * 5), nb.n + Math.sin(a) * (28 + (i % 3) * 5), nb.distance);
  });
}

function sendHome(sim: Simulation, army: Army): void {
  const site = sim.site(army.home)!;
  const nb = site.neighbors.find((n) => n.id === army.target);
  army.state = 'return';
  army.since = sim.state.time;
  for (const id of army.defenders) sim.release(id);
  army.defenders = [];
  let i = 0;
  for (const id of army.members) {
    const p = sim.person(id);
    if (!p) continue;
    const a = sim.rng.next() * Math.PI * 2;
    sim.march(p, army.id, 5, Math.cos(a) * (4 + (i++ % 5) * 2), Math.sin(a) * (4 + (i % 5) * 2), nb?.distance ?? 800);
  }
}

function beginBattle(sim: Simulation, army: Army): void {
  const s = sim.state;
  const t = s.time;
  // the defenders: soldiers at home, joined by the bravest adults
  const here = s.persons.filter((p) => p.settlement === army.target && !p.army && !p.trip && p.health > 0.5);
  const soldiers = here.filter((p) => p.job === J.Soldier);
  const adults = here.filter((p) => { const a = ageAt(p, t); return a >= 17 && a < 56 && p.job !== J.Soldier; })
    .sort((a, b) => b.traits[T.Courage] - a.traits[T.Courage] || a.id - b.id);
  const militia = adults.slice(0, Math.ceil(adults.length * 0.3)).filter((p) => p.traits[T.Courage] > 0.4);
  const defenders = [...soldiers, ...militia];
  defenders.forEach((p, i) => {
    const a = (i / Math.max(1, defenders.length)) * Math.PI * 2;
    sim.hold(p, army.id, Math.cos(a) * (8 + (i % 3) * 3), Math.sin(a) * (8 + (i % 3) * 3));
  });
  army.defenders = defenders.map((p) => p.id);
  army.defendersInitial = defenders.length;
  army.state = 'battle';
  army.since = t;
  army.nextRound = t + ROUND;
}

function conquer(sim: Simulation, army: Army, war: War, st: SettlementState): void {
  const s = sim.state;
  const t = s.time;
  const winner = s.civs[army.civ - 1], loser = s.civs[st.civ - 1];
  const home = sim.settlement(army.home)!;
  // plunder carried home
  for (let r = 0; r < st.stock.length; r++) {
    const loot = st.stock[r] * 0.3;
    st.stock[r] -= loot;
    home.stock[r] += loot;
  }
  const coins = st.treasury * 0.5;
  st.treasury -= coins;
  home.treasury += coins;
  st.civ = winner.id;
  st.besiegedUntil = 0;
  (war.attacker === winner.id ? war.takenByAttacker : war.takenByDefender).push(st.id);
  for (const p of s.persons) if (p.settlement === st.id && ageAt(p, t) >= 10) sim.remember(p, { t, type: 'conquered', place: winner.name });
  sim.record({ t, type: 'conquest', settlement: st.id, civ: winner.id, b: loser?.id, names: [winner.name, loser?.name ?? ''] });
  if (loser && loser.capital === st.id) {
    // the vanquished move their seat, if they have anywhere left
    const left = settlementsOf(sim, loser.id).sort((a, b) => sim.census(b.id).pop - sim.census(a.id).pop);
    if (left.length) loser.capital = left[0].id;
  }
  if (winner) winner.legitimacy = Math.min(1, winner.legitimacy + 0.1);
  if (loser) loser.legitimacy = Math.max(0, loser.legitimacy - 0.2);
  sim.rosterVersion++;
  sim.modsChanged();
}

/** Advances every army: march, siege, battle rounds, conquest or retreat. Called every simulation step. */
export function armiesStep(sim: Simulation): void {
  const s = sim.state;
  if (!s.armies.length) return;
  const t = s.time;
  for (const army of [...s.armies]) {
    const war = s.wars[army.war - 1];
    army.members = army.members.filter((id) => sim.person(id));
    army.defenders = army.defenders.filter((id) => sim.person(id));
    const members = army.members.map((id) => sim.person(id)!);
    if (!members.length) {
      for (const id of army.defenders) sim.release(id);
      s.armies = s.armies.filter((a) => a !== army);
      continue;
    }
    const st = sim.settlement(army.target)!;
    if (army.state === 'march') {
      if (members.some((p) => p.trip)) continue;
      if (st.civ === army.civ || !war || war.end) { sendHome(sim, army); continue; }
      // a fortified place is first invested: its people can no longer roam or trade
      if (countKind(sim.buildingsOf(st.id), 'watchtower') > 0 && sim.census(st.id).pop > 0) {
        army.state = 'siege';
        army.since = t;
        st.besiegedUntil = t + 6 * SECONDS_PER_DAY;
        sim.record({ t, type: 'siege', settlement: st.id, civ: army.civ, b: st.civ, names: [s.civs[army.civ - 1].name, s.civs[st.civ - 1]?.name ?? ''] });
      } else beginBattle(sim, army);
    } else if (army.state === 'siege') {
      if (!war || war.end) { st.besiegedUntil = 0; sendHome(sim, army); }
      else if (t >= st.besiegedUntil) beginBattle(sim, army);
    } else if (army.state === 'battle') {
      // home ground, walls of a watchtower, and the hand of the heavens over a protected people
      const fortified = (countKind(sim.buildingsOf(st.id), 'watchtower') > 0 ? 1.4 : 1.15) * (st.protectedUntil > t ? 2.5 : 1);
      while (t >= army.nextRound && army.state === 'battle') {
        army.nextRound += ROUND;
        const A = fighters(sim, army.members), D = fighters(sim, army.defenders);
        const routA = A.length <= army.initial * 0.45, routD = D.length <= army.defendersInitial * 0.45;
        if (!A.length || !D.length || routA || routD) {
          const attackersWin = D.length === 0 || (routD && !routA && A.length > 0);
          const lostA = army.initial - army.members.length, lostD = army.defendersInitial - army.defenders.length;
          if (war) {
            war.battles++;
            const attackerIsWarAttacker = war.attacker === army.civ;
            war.deathsAttacker += attackerIsWarAttacker ? lostA : lostD;
            war.deathsDefender += attackerIsWarAttacker ? lostD : lostA;
          }
          sim.record({
            t, type: 'battle', settlement: st.id, civ: army.civ, b: st.civ, what: attackersWin ? 'attackers' : 'defenders',
            names: [s.civs[army.civ - 1].name, s.civs[st.civ - 1]?.name ?? ''], value: lostA + lostD,
          });
          for (const p of [...A, ...D]) if (ageAt(p, t) >= 10) sim.remember(p, { t, type: 'battle', place: sim.site(st.id)?.name });
          if (attackersWin && war) conquer(sim, army, war, st);
          st.besiegedUntil = 0;
          sendHome(sim, army);
          break;
        }
        // duels: the stronger arm usually prevails; the loser is wounded or killed
        const duels = Math.max(1, Math.floor(Math.min(A.length, D.length) / 2));
        for (let k = 0; k < duels; k++) {
          const a = A[Math.floor(sim.rng.next() * A.length)], d = D[Math.floor(sim.rng.next() * D.length)];
          if (!sim.person(a.id) || !sim.person(d.id) || a.health <= 0.3 || d.health <= 0.3) continue;
          const pa = power(sim, a, 1), pd = power(sim, d, fortified);
          const loser = sim.rng.next() < pa / (pa + pd) ? d : a;
          const win = loser === a ? d : a;
          win.skills[J.Soldier] = Math.min(1, win.skills[J.Soldier] + 0.02);
          if (sim.rng.next() < 0.4) sim.kill(loser, 'battle');
          else {
            loser.health -= 0.35;
            if (loser.health <= 0) sim.kill(loser, 'battle');
            else sim.remember(loser, { t, type: 'wounded' });
          }
        }
        army.members = army.members.filter((id) => sim.person(id));
        army.defenders = army.defenders.filter((id) => sim.person(id));
      }
    } else if (army.state === 'return') {
      if (members.some((p) => p.trip)) continue;
      for (const p of members) sim.release(p.id);
      s.armies = s.armies.filter((a) => a !== army);
    }
  }
}

// -------------------------------------------------------------- diplomacy
/** Unrest in occupied or far-flung settlements: they may break away. */
function secessions(sim: Simulation): void {
  const s = sim.state;
  for (const st of s.settlements) {
    const civ = s.civs[st.civ - 1];
    if (!alive(civ) || st.id === civ.capital || st.besiegedUntil) continue;
    const pop = sim.census(st.id).pop;
    if (pop < 12) continue;
    const origin = s.civs[st.origin - 1];
    const occupied = st.origin !== st.civ;
    const far = (sim.site(civ.capital)?.neighbors.find((n) => n.id === st.id)?.distance ?? 4000) > 1500;
    const chance = occupied ? 0.1 + (1 - civ.legitimacy) * 0.25 : far && pop >= 45 && civ.legitimacy < 0.55 ? 0.05 + (0.55 - civ.legitimacy) * 0.3 : 0;
    if (sim.rng.next() >= chance) continue;
    const t = s.time;
    const from = civ.id;
    if (occupied && alive(origin)) {
      st.civ = origin.id; // the occupied return to their own people
      sim.record({ t, type: 'secession', settlement: st.id, civ: origin.id, b: from, what: 'return', names: [origin.name, civ.name] });
      relationOf(sim, origin.id, from).grievance += 0.1;
    } else {
      st.civ = 0;
      st.origin = 0;
      const born = foundCivilization(sim, st);
      st.origin = born.id;
      sim.record({ t, type: 'secession', settlement: st.id, civ: born.id, b: from, what: 'independence', names: [born.name, civ.name] });
      relationOf(sim, born.id, from).opinion = -0.2;
    }
    civ.legitimacy = Math.max(0, civ.legitimacy - 0.1);
    sim.rosterVersion++;
    sim.modsChanged();
  }
}

/** Relations, alliances, declarations of war, campaigns and treaties — once per simulated day. */
export function diplomacyDaily(sim: Simulation): void {
  const s = sim.state;
  const t = s.time;
  const rng = sim.rng;
  const day = Math.floor(t / SECONDS_PER_DAY);
  const newYear = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR === 0;
  const civs = s.civs.filter(alive);

  // wars whose belligerent is gone end by themselves
  for (const war of s.wars) {
    if (war.end) continue;
    const A = s.civs[war.attacker - 1], D = s.civs[war.defender - 1];
    if (!alive(A) || !alive(D)) {
      war.end = t;
      war.outcome = alive(A) ? 'attacker' : alive(D) ? 'defender' : 'draw';
      const r = relationOf(sim, war.attacker, war.defender);
      r.status = 'peace';
      r.since = t;
      for (const army of s.armies) if (army.war === war.id && army.state !== 'return') sendHome(sim, army);
    }
  }

  for (let i = 0; i < civs.length; i++) {
    for (let j = i + 1; j < civs.length; j++) {
      const a = civs[i], b = civs[j];
      const contact = contactBetween(sim, a, b) ?? contactBetween(sim, b, a);
      const existing = s.relations.find((q) => q.a === Math.min(a.id, b.id) && q.b === Math.max(a.id, b.id));
      if (!contact && !existing) continue;
      const r = existing ?? relationOf(sim, a.id, b.id);
      if (contact) updateOpinion(sim, r, a, b, contact);

      if (r.status === 'war') {
        const war = s.wars.find((w) => !w.end && ((w.attacker === a.id && w.defender === b.id) || (w.attacker === b.id && w.defender === a.id)));
        if (!war) { r.status = 'peace'; continue; }
        // campaigns: each side strikes when it has soldiers and no army in the field
        for (const [me, foe] of [[a, b], [b, a]] as const) {
          if (s.armies.some((x) => x.civ === me.id)) continue;
          const link = contactBetween(sim, me, foe);
          if (!link) continue;
          const ready = s.persons.filter((p) => p.settlement === link.from && p.job === J.Soldier && !p.army && !p.trip).length;
          const bold = (leader(sim, me)?.traits[T.Courage] ?? 0.5) * 0.02 + 0.01;
          if (ready >= 4 && rng.next() < bold) raiseArmy(sim, me, war, link.from, link.to);
        }
        // weariness brings peace
        const pop = citizens(sim, a).length + citizens(sim, b).length;
        const years = (t - war.start) / SECONDS_PER_YEAR;
        const weary = (war.deathsAttacker + war.deathsDefender) / Math.max(1, pop) * 2 + years * 0.12 + (war.takenByAttacker.length + war.takenByDefender.length) * 0.15;
        if (years > 0.3 && !s.armies.some((x) => x.war === war.id && x.state !== 'return') && rng.next() < clamp01(weary - 0.2) * 0.03) makePeace(sim, war, r);
        continue;
      }
      if (!contact) continue;

      if (r.status === 'alliance') {
        if (r.opinion < 0.15) {
          r.status = 'peace';
          r.since = t;
          sim.record({ t, type: 'alliance', settlement: a.capital, civ: a.id, b: b.id, what: 'broken', names: [a.name, b.name] });
        }
        continue;
      }
      // peace: friendship may become an alliance, resentment a war
      if (r.opinion > 0.5 && rng.next() < 0.004) {
        r.status = 'alliance';
        r.since = t;
        sim.record({ t, type: 'alliance', settlement: a.capital, civ: a.id, b: b.id, what: 'formed', names: [a.name, b.name] });
        continue;
      }
      if (r.opinion < -0.25 && t >= r.truceUntil) {
        for (const [me, foe] of [[a, b], [b, a]] as const) {
          const l = leader(sim, me);
          if (!l || atWar(sim, me.id)) continue;
          const belligerence = l.traits[T.Aggression] * 0.6 + l.traits[T.Ambition] * 0.4 + me.culture.values[0] * 0.3;
          const odds = strength(sim, me) / Math.max(1, strength(sim, foe));
          if (belligerence > 0.55 && odds > 1.05 && citizens(sim, me).length >= 20 && rng.next() < 0.006 * (-r.opinion) * 4) {
            declareWar(sim, r, me, foe);
            break;
          }
        }
      }
    }
  }
  if (newYear) secessions(sim);
}

