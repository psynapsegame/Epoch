import { SECONDS_PER_YEAR, dateOf } from './clock';
import { POWERS, type DivinePower } from './divine';
import { TECH_BY_ID } from './tech';
import { BUILDING_NAMES, TRADITION_NAMES } from './text';
import {
  GOVERNMENT_LABELS, WAR_CAUSE_LABELS,
  type Civilization, type Government, type SimEvent, type SimState, type WarCause, type YearRecord,
} from './types';

/**
 * Chronicles: readable history written *only* from what the simulation
 * recorded. Every sentence lists the events (and yearly annals) it was built
 * from; the generator never states anything that is not in its sources.
 */
export interface Sentence {
  text: string;
  /** Ids of the recorded events this sentence reports. */
  sources: number[];
  /** Ids of the yearly records its figures come from. */
  annals: number[];
}

export interface Chapter {
  title: string;
  from: number;
  to: number;
  paragraphs: Sentence[][];
}

export interface Chronicle {
  /** 0 = annals of the world, otherwise a civilisation id. */
  scope: number;
  title: string;
  subtitle: string;
  chapters: Chapter[];
  /** Source material, so the interface can show what each sentence rests on. */
  events: Record<number, SimEvent>;
  annals: Record<number, YearRecord>;
}

const yearOf = (t: number) => dateOf(t).year;
const pick = <T,>(options: T[], seed: number): T => options[Math.abs(seed) % options.length];
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "de Tyreth" / "d’Orolheim". */
const de = (name: string) => (/^[aeiouyhéèêAEIOUYHÉÈÊ]/.test(name) ? `d’${name}` : `de ${name}`);

/** Technology names with their article, as they read in a sentence. */
const TECH_PHRASE: Record<string, string> = {
  pottery: 'la poterie', trapping: 'les pièges et les arcs', boats: 'la construction des barques', irrigation: 'l’irrigation', masonry: 'la maçonnerie',
  herbalism: 'l’herboristerie', wheel: 'la roue', currency: 'la monnaie frappée', metallurgy: 'la métallurgie', writing: 'l’écriture',
  calendar: 'le calendrier', weapons: 'les armes de fer', deepMining: 'les galeries profondes', cropRotation: 'l’assolement', sailing: 'la voile',
  medicine: 'la médecine', mathematics: 'les mathématiques',
};

const OMEN: Record<string, string> = {
  mountain: 'une montagne surgit de terre', valley: 'la terre s’ouvrit en vallée', forest: 'une forêt naquit en une nuit', deposit: 'un filon apparut dans la roche',
  meteor: 'une pierre de feu tomba du ciel', fire: 'un grand incendie éclata', drought: 'la sécheresse s’abattit', storm: 'une tempête se déchaîna',
  animals: 'des troupeaux vinrent de nulle part', blessing: 'malades et affamés furent relevés', harvest: 'les champs donnèrent plus qu’on n’avait jamais vu',
  blight: 'les champs se flétrirent sur pied', protect: 'une main invisible s’étendit sur le peuple', hero: 'un être hors du commun se révéla',
};

/** Events worth a sentence of their own (the rest is told through yearly figures). */
const NOTABLE = new Set<string>([
  'civ', 'ruler', 'coup', 'government', 'tech', 'religion', 'schism', 'faithEnd', 'colony', 'war', 'peace', 'alliance', 'siege', 'battle',
  'conquest', 'secession', 'famine', 'harvest', 'divine', 'omen', 'built',
]);
const NOTABLE_BUILDINGS = new Set(['temple', 'market', 'mine', 'windmill', 'watchtower', 'dock', 'workshop', 'storehouse', 'longhouse']);

interface Ctx {
  place: (id: number) => string;
  civName: (id: number) => string;
}

/** One sentence for one recorded event — a restatement, nothing more. */
function tell(e: SimEvent, c: Ctx): string | null {
  const n = e.names ?? [];
  const where = e.settlement ? c.place(e.settlement) : '';
  const v = e.id ?? 0;
  switch (e.type) {
    case 'civ': return e.what === 'fallen' ? `le peuple ${de(where)} s’éteignit, et son nom n’appartint plus qu’à la mémoire` : pick([`un peuple se reconnut autour ${de(where)}`, `les familles ${de(where)} se donnèrent un nom et un destin communs`], v);
    case 'ruler':
      if (e.what === 'founding') return pick([`${n[0]} fut le premier à porter la charge de chef`, `on confia à ${n[0]} la conduite du peuple naissant`], v);
      if (e.what === 'inheritance') return `${n[0]} hérita du pouvoir${n[1] ? ` laissé par ${n[1]}` : ''}`;
      return pick([`le peuple choisit ${n[0]} pour le gouverner`, `${n[0]} fut porté au pouvoir par les siens`], v) + (n[1] ? `, à la suite de ${n[1]}` : '');
    case 'coup': return e.what === 'revolt' ? `le peuple affamé se souleva, et ${n[0]} renversa ${n[1]}` : pick([`${n[0]} s’empara du pouvoir par la force, renversant ${n[1]}`, `un coup de force porta ${n[0]} à la place de ${n[1]}`], v);
    case 'government': return `le peuple changea de régime et devint une ${GOVERNMENT_LABELS[e.what as Government]?.toLowerCase() ?? 'autre forme de gouvernement'}`;
    case 'tech': {
      const phrase = TECH_PHRASE[String(e.what)];
      if (!phrase || !TECH_BY_ID.has(String(e.what))) return null;
      return pick([`on maîtrisa ${phrase}`, `le peuple apprit ${phrase}`], v) + (n[0] ? `, grâce aux travaux ${de(n[0])}` : '');
    }
    case 'religion': return `${n[0]} fonda une croyance nouvelle, ${e.what}`;
    case 'schism': return `${n[0]} rompit avec ${n[1]} et fonda ${e.what}`;
    case 'faithEnd': return `${e.what} perdit son dernier fidèle`;
    case 'colony': return `${plural(e.value ?? 0, 'colon', 'colons')} quittèrent ${c.place(e.b ?? 0)} pour s’établir à ${where}${n.length ? `, parmi eux ${n.slice(0, 2).join(' et ')}` : ''}`;
    case 'war': return e.what === 'alliance' ? `${n[0]} entra en guerre contre ${n[1]} pour honorer son alliance` : `${n[0]} déclara la guerre à ${n[1]}, poussé par ${WAR_CAUSE_LABELS[e.what as WarCause] ?? 'la discorde'}`;
    case 'peace': return `${n[0]} et ${n[1]} firent la paix après ${plural(e.value ?? 0, 'mort', 'morts')}` + (e.what === 'attacker' ? `, à l’avantage de ${n[0]}` : e.what === 'defender' ? `, à l’avantage de ${n[1]}` : ', sans vainqueur');
    case 'alliance': return e.what === 'broken' ? `l’alliance de ${n[0]} et de ${n[1]} fut rompue` : `${n[0]} et ${n[1]} scellèrent une alliance`;
    case 'siege': return `l’armée de ${n[0]} mit le siège devant ${where}`;
    case 'battle': return e.what === 'attackers' ? `${n[0]} l’emporta à la bataille ${de(where)}, qui coûta ${plural(e.value ?? 0, 'vie', 'vies')}` : `${n[1]} repoussa ${n[0]} à la bataille ${de(where)}, au prix de ${plural(e.value ?? 0, 'mort', 'morts')}`;
    case 'conquest': return `${where} tomba aux mains de ${n[0]}`;
    case 'secession': return e.what === 'return' ? `${where} se souleva contre ${n[1]} et rejoignit ${n[0]}` : `${where} rompit avec ${n[1]} et fonda son propre peuple`;
    case 'famine': return pick([`la famine frappa ${where} : greniers et garde-manger étaient vides`, `${where} connut la faim, les greniers vides`], v);
    case 'harvest': return (e.value ?? 1) < 1 ? `les récoltes ${de(where)} furent mauvaises` : `les récoltes ${de(where)} furent abondantes`;
    case 'built': return NOTABLE_BUILDINGS.has(String(e.what)) ? `${where} acheva ${articleFor(String(e.what))}${n[0] ? `, ${n[0]} y posant la dernière pierre` : ''}` : null;
    case 'divine': {
      const p = POWERS[e.what as DivinePower];
      if (!p) return null;
      const what = OMEN[String(e.what)] ?? 'un prodige eut lieu';
      return `${what}${where ? ` près ${de(where)}` : ''}` + (e.value ? `, et ${plural(e.value, 'habitant y laissa', 'habitants y laissèrent')} la vie` : '') + (e.what === 'hero' && n[0] ? ` : ${n[0]}` : '');
    }
    case 'omen': {
      const reading = String(e.what).split(':')[1];
      const faith = n[1] ? n[1] : 'leur croyance';
      switch (reading) {
        case 'founding': return `devant ce signe, les ${n[0]} se donnèrent une croyance, ${n[1]}`;
        case 'favour': return `les ${n[0]} y virent la faveur de ${faith}, et la ferveur grandit`;
        case 'grace': return `les ${n[0]} en rendirent grâce`;
        case 'wrath': return `les ${n[0]} y lurent la colère de ${faith}`;
        case 'doubt': return `les ${n[0]} n’y comprirent rien : le doute gagna les fidèles de ${faith} et l’on blâma le dirigeant`;
        default: return `les ${n[0]} en restèrent sans voix`;
      }
    }
    default: return null;
  }
}

const BUILT: Record<string, string> = {
  temple: 'son temple', market: 'son marché', mine: 'sa mine', windmill: 'son moulin', watchtower: 'sa tour de guet', dock: 'son ponton',
  workshop: 'son atelier', storehouse: 'son entrepôt', longhouse: 'sa grande maison',
};
function articleFor(kind: string): string {
  return BUILT[kind] ?? (BUILDING_NAMES[kind] ?? 'un bâtiment').toLowerCase();
}

/** Groups a period's notable events into paragraphs, one per year that has something to tell. */
function narrate(events: SimEvent[], c: Ctx, limit: number): Sentence[][] {
  const out: Sentence[][] = [];
  let lastYear = -1e9;
  let para: Sentence[] = [];
  let count = 0;
  for (const e of events) {
    if (count >= limit) break;
    const text = tell(e, c);
    if (!text) continue;
    const y = yearOf(e.t);
    let lead: string;
    if (y !== lastYear) {
      if (para.length) out.push(para);
      para = [];
      const gap = y - lastYear;
      lead = lastYear < -1e8 ? `En l’an ${y}, ` : gap === 1 ? pick(['L’année suivante, ', `En l’an ${y}, `], e.id ?? 0) : gap <= 4 ? `${cap(numberWord(gap))} ans plus tard, en l’an ${y}, ` : `En l’an ${y}, `;
      lastYear = y;
    } else lead = pick(['La même année, ', 'Cette année-là encore, ', 'Puis '], (e.id ?? 0) + para.length);
    para.push({ text: `${lead}${text}.`, sources: [e.id ?? 0], annals: [] });
    count++;
  }
  if (para.length) out.push(para);
  return out;
}

function numberWord(n: number): string {
  return ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq'][n] ?? String(n);
}

/** Sums the yearly records of a set of settlements over a span of years. */
function demography(annals: YearRecord[], keep: (r: YearRecord) => boolean): { births: number; deaths: number; age: number; hunger: number; battle: number; disaster: number; marriages: number; built: number; ids: number[]; first: number; last: number } | null {
  const rows = annals.filter(keep);
  if (!rows.length) return null;
  const sum = { births: 0, deaths: 0, age: 0, hunger: 0, battle: 0, disaster: 0, marriages: 0, built: 0 };
  for (const r of rows) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r[k];
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const popAt = (y: number) => rows.filter((r) => r.year === y).reduce((a, r) => a + r.pop, 0);
  return { ...sum, ids: rows.map((r) => r.id), first: popAt(years[0]), last: popAt(years[years.length - 1]) };
}

function demographySentence(d: NonNullable<ReturnType<typeof demography>>, subject: string): Sentence {
  const parts: string[] = [`${subject} ${d.births ? plural(d.births, 'enfant naquit', 'enfants naquirent') : 'aucun enfant ne naquit'}`];
  if (d.marriages) parts.push(`${plural(d.marriages, 'union fut célébrée', 'unions furent célébrées')}`);
  let text = parts.join(', ');
  if (d.deaths) {
    const causes: string[] = [];
    if (d.age) causes.push(`${d.age} de vieillesse`);
    if (d.hunger) causes.push(`${d.hunger} de faim ou de soif`);
    if (d.battle) causes.push(`${d.battle} au combat`);
    if (d.disaster) causes.push(`${d.disaster} dans les fléaux`);
    text += ` et ${plural(d.deaths, 'habitant mourut', 'habitants moururent')}${causes.length ? ` (${causes.join(', ')})` : ''}`;
  }
  if (d.built) text += ` ; ${plural(d.built, 'bâtiment fut achevé', 'bâtiments furent achevés')}`;
  text += `. À la fin de la dernière année comptée, on dénombrait ${plural(d.last, 'âme', 'âmes')}.`;
  return { text, sources: [], annals: d.ids };
}

/** Builds the chronicle of a civilisation (by reigns) or of the whole world (by decades). */
export function buildChronicle(state: SimState, scope: number, place: (id: number) => string): Chronicle {
  const c: Ctx = { place, civName: (id) => state.civs[id - 1]?.name ?? 'un peuple oublié' };
  const used = new Set<number>(), usedAnnals = new Set<number>();
  const chapters: Chapter[] = [];
  const notable = state.events.filter((e) => NOTABLE.has(e.type));
  const now = state.time;

  if (scope > 0) {
    const civ: Civilization | undefined = state.civs[scope - 1];
    if (!civ) return { scope, title: 'Chronique', subtitle: '', chapters: [], events: {}, annals: {} };
    // a civilisation's own story: what concerned it, plus the wars and treaties it took part in
    const mine = notable.filter((e) => e.civ === civ.id || ((e.type === 'war' || e.type === 'peace' || e.type === 'alliance' || e.type === 'conquest' || e.type === 'battle' || e.type === 'siege' || e.type === 'secession') && e.b === civ.id));
    const reigns = civ.dynasties.flatMap((d) => d.rulers.map((r) => ({ ...r, house: d.name })));
    reigns.forEach((r, i) => {
      const from = r.from, to = r.to || civ.fallen || now;
      const period = mine.filter((e) => e.t >= from && (e.t < to || (i === reigns.length - 1 && e.t <= to)));
      const paragraphs = narrate(period, c, 60);
      const y0 = yearOf(from), y1 = yearOf(to);
      const d = demography(state.annals, (a) => a.civ === civ.id && a.year >= y0 && a.year <= (r.to ? y1 - 1 : y1));
      if (d) paragraphs.push([demographySentence(d, `Durant ces années, chez les ${civ.culture.people},`)]);
      if (!paragraphs.length) return;
      chapters.push({
        title: `${r.name}, maison ${r.house} — ${r.to ? `de l’an ${y0} à l’an ${y1}` : `depuis l’an ${y0}`}`,
        from, to, paragraphs,
      });
    });
    for (const ch of chapters) for (const p of ch.paragraphs) for (const s of p) { s.sources.forEach((x) => used.add(x)); s.annals.forEach((x) => usedAnnals.add(x)); }
    const tradition = TRADITION_NAMES[civ.culture.traditions[0]];
    return {
      scope, title: `Chronique des ${civ.culture.people}`,
      subtitle: `Peuple de ${civ.name}, né en l’an ${yearOf(civ.founded)}${civ.fallen ? `, éteint en l’an ${yearOf(civ.fallen)}` : ''}${tradition ? ` — on y célèbre ${tradition}` : ''}`,
      chapters, events: pickEvents(state, used), annals: pickAnnals(state, usedAnnals),
    };
  }

  // annals of the world: the great deeds of all peoples, decade by decade
  const major = notable.filter((e) => e.type !== 'built' && e.type !== 'harvest' && !(e.type === 'ruler' && e.what === 'election'));
  const lastYear = yearOf(now);
  for (let y = 1; y <= lastYear; y += 10) {
    const from = (y - 1) * SECONDS_PER_YEAR, to = (y + 9) * SECONDS_PER_YEAR;
    const period = major.filter((e) => e.t >= from && e.t < to).map((e) => ({ ...e }));
    const paragraphs = narrate(period, {
      ...c,
    }, 70).map((p) => p.map((s) => {
      // name the people concerned, since the annals speak of all of them
      const e = state.events.find((x) => x.id === s.sources[0]);
      const people = e && e.civ ? state.civs[e.civ - 1]?.culture.people : undefined;
      const who = e && people && ['ruler', 'coup', 'government', 'tech', 'religion', 'schism'].includes(e.type) ? `, chez les ${people}` : '';
      return who ? { ...s, text: s.text.replace(/\.$/, `${who}.`) } : s;
    }));
    const d = demography(state.annals, (a) => a.year >= y && a.year <= y + 9);
    if (d) paragraphs.push([demographySentence(d, 'Dans le monde entier, durant ces années,')]);
    if (!paragraphs.length) continue;
    chapters.push({ title: `De l’an ${y} à l’an ${Math.min(y + 9, lastYear)}`, from, to, paragraphs });
  }
  for (const ch of chapters) for (const p of ch.paragraphs) for (const s of p) { s.sources.forEach((x) => used.add(x)); s.annals.forEach((x) => usedAnnals.add(x)); }
  const living = state.civs.filter((x) => !x.fallen).length;
  return {
    scope: 0, title: 'Annales du monde',
    subtitle: `An ${lastYear} — ${plural(living, 'peuple', 'peuples')}${state.civs.length > living ? `, ${plural(state.civs.length - living, 'disparu', 'disparus')}` : ''}`,
    chapters, events: pickEvents(state, used), annals: pickAnnals(state, usedAnnals),
  };
}

function pickEvents(state: SimState, ids: Set<number>): Record<number, SimEvent> {
  const out: Record<number, SimEvent> = {};
  for (const e of state.events) if (e.id && ids.has(e.id)) out[e.id] = e;
  return out;
}

function pickAnnals(state: SimState, ids: Set<number>): Record<number, YearRecord> {
  const out: Record<number, YearRecord> = {};
  for (const a of state.annals) if (ids.has(a.id)) out[a.id] = a;
  return out;
}

/** Plain-text version of a chronicle, for export. */
export function chronicleText(ch: Chronicle): string {
  const lines = [ch.title.toUpperCase(), ch.subtitle, ''];
  for (const c of ch.chapters) {
    lines.push(c.title, '');
    for (const p of c.paragraphs) lines.push(p.map((s) => s.text).join(' '), '');
  }
  lines.push('— Récit composé uniquement à partir des événements enregistrés par la simulation.');
  return lines.join('\n');
}
