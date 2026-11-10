/**
 * Simulation data model. Everything here is plain JSON-serialisable data so a
 * whole society can be saved, restored and moved between threads.
 */
export enum Activity {
  Idle = 0,
  Foraging = 1,
  Eating = 2,
  Drinking = 3,
  Sleeping = 4,
  Socializing = 5,
  Wandering = 6,
  Resting = 7,
  Playing = 8,
  Working = 9,
  Shopping = 10,
  Building = 11,
  Trading = 12,
  Praying = 13,
  Migrating = 14,
  Fighting = 15,
}
export const ACTIVITY_COUNT = 16;

export const ACTIVITY_LABELS: Record<number, string> = {
  0: 'Flâne', 1: 'Cueille et chasse', 2: 'Mange', 3: 'Boit', 4: 'Dort', 5: 'Discute', 6: 'Explore', 7: 'Se repose au foyer', 8: 'Joue',
  9: 'Travaille', 10: 'S’approvisionne', 11: 'Bâtit', 12: 'En voyage de commerce', 13: 'Prie au temple', 14: 'Part fonder une colonie', 15: 'En campagne militaire',
};

/** Phases of an action. */
export enum Phase {
  /** Walking to the place of the action. */
  Go = 0,
  /** Performing it. */
  Do = 1,
  /** Carrying the result home. */
  Return = 2,
}

export const TRAITS = ['ambition', 'courage', 'intelligence', 'curiosity', 'loyalty', 'aggression', 'sociability', 'altruism', 'prudence'] as const;
export const TRAIT_LABELS = ['Ambition', 'Courage', 'Intelligence', 'Curiosité', 'Loyauté', 'Agressivité', 'Sociabilité', 'Altruisme', 'Prudence'];
export const enum T { Ambition, Courage, Intelligence, Curiosity, Loyalty, Aggression, Sociability, Altruism, Prudence }

export const NEEDS = ['food', 'water', 'sleep', 'safety', 'shelter', 'social'] as const;
export const NEED_LABELS = ['Nourriture', 'Eau', 'Sommeil', 'Sécurité', 'Logement', 'Liens sociaux'];
export const enum N { Food, Water, Sleep, Safety, Shelter, Social }

// ------------------------------------------------------------- economy
export const RESOURCES = ['food', 'wood', 'stone', 'iron', 'coal', 'gold', 'tools', 'goods'] as const;
export const RESOURCE_LABELS = ['Nourriture', 'Bois', 'Pierre', 'Fer', 'Charbon', 'Or', 'Outils', 'Objets artisanaux'];
export const RESOURCE_UNITS = ['repas', 'stères', 'blocs', 'lingots', 'sacs', 'pépites', 'outils', 'pièces'];
export const enum R { Food, Wood, Stone, Iron, Coal, Gold, Tools, Goods }
export const RESOURCE_COUNT = 8;
/** Reference prices in coins per unit. */
export const BASE_PRICE = [1, 0.8, 1.2, 3, 2, 12, 8, 5];

export const JOBS = ['gatherer', 'farmer', 'herder', 'fisher', 'woodcutter', 'miner', 'builder', 'smith', 'artisan', 'merchant', 'researcher', 'leader', 'soldier'] as const;
export const JOB_LABELS_M = ['Cueilleur', 'Agriculteur', 'Éleveur', 'Pêcheur', 'Bûcheron', 'Mineur', 'Bâtisseur', 'Forgeron', 'Artisan', 'Marchand', 'Savant', 'Dirigeant', 'Soldat'];
export const JOB_LABELS_F = ['Cueilleuse', 'Agricultrice', 'Éleveuse', 'Pêcheuse', 'Bûcheronne', 'Mineuse', 'Bâtisseuse', 'Forgeronne', 'Artisane', 'Marchande', 'Savante', 'Dirigeante', 'Soldate'];
export const enum J { Gatherer, Farmer, Herder, Fisher, Woodcutter, Miner, Builder, Smith, Artisan, Merchant, Researcher, Leader, Soldier }
export const JOB_COUNT = 13;

/** Skills: one per profession, then eloquence and exploration. */
export const SKILL_SOCIAL = 13;
export const SKILL_EXPLORE = 14;
export const SKILL_COUNT = 15;
export const SKILL_LABELS = [
  'Cueillette et chasse', 'Agriculture', 'Élevage', 'Pêche', 'Bûcheronnage', 'Extraction', 'Construction', 'Forge', 'Artisanat', 'Négoce', 'Savoir', 'Gouvernement', 'Armes',
  'Éloquence', 'Exploration',
];

export type MemoryType =
  | 'born' | 'settled' | 'married' | 'child' | 'friend' | 'quarrel' | 'discovery' | 'hunger' | 'gift' | 'received' | 'mourning' | 'feast'
  | 'job' | 'built' | 'journey' | 'home' | 'ruler' | 'deposed' | 'faith' | 'prophet' | 'colonist' | 'discoveryTech' | 'battle' | 'wounded' | 'conquered' | 'omen' | 'chosen';

export interface Memory {
  /** Simulated time of the event. */
  t: number;
  type: MemoryType;
  /** Other person involved, if any. */
  ref?: number;
  /** Place name, if any. */
  place?: string;
  /** Extra code: profession index for 'job', building kind for 'built'. */
  what?: string | number;
}

export interface Person {
  id: number;
  firstName: string;
  lastName: string;
  /** 0 = woman, 1 = man. */
  sex: 0 | 1;
  /** Simulated time of birth (negative for people born before year 1). */
  birth: number;
  birthPlace: string;
  /** Appearance: palette indices and build. */
  look: { skin: number; hair: number; tunic: number; height: number };
  /** Personality, 9 values in [0,1] (see TRAITS). */
  traits: number[];
  /** Need satisfaction, 6 values in [0,1] (1 = fully satisfied; see NEEDS). */
  needs: number[];
  /** Skill levels in [0,1] (see SKILL_LABELS). */
  skills: number[];
  health: number;
  /** Profession (see JOBS) and the building where it is practised (0 = none). */
  job: number;
  workplace: number;
  /** Religion followed (0 = none). */
  faith: number;
  /** End of pregnancy (simulated time), 0 when not expecting. */
  pregnantUntil: number;
  lastBirth: number;
  household: number;
  settlement: number;
  spouse: number;
  /** Mother and father ids (0 = unknown ancestor). */
  parents: [number, number];
  children: number[];
  /** Affinity with other people, -1..1. */
  bonds: Record<number, number>;
  memories: Memory[];
  // --- dynamic state ---
  /** Position in the settlement's local frame (metres east / north of its centre). */
  e: number;
  n: number;
  activity: Activity;
  phase: Phase;
  /** Final destination of the current movement. */
  te: number;
  tn: number;
  /** Remaining waypoints [e, n, e, n, ...] toward the destination. */
  path: number[];
  /** Simulated time at which the current "do" phase ends. */
  until: number;
  /** Partner of a social action. */
  partner: number;
  /** Goods being carried: quantity and resource index. */
  carry: number;
  carryRes: number;
  /** Journey in progress (trade, migration, military campaign). */
  trip: Trip | null;
  /** Army the person is serving in (0 = none). */
  army: number;
  /** True while inside a building (not drawn). */
  inside: boolean;
  /** Lifetime counters (observable behaviour, used by statistics and tests). */
  counts: { meals: number; forages: number; chats: number; explorations: number; gifts: number; shifts: number };
}

export interface Trip {
  /** Destination settlement. */
  to: number;
  /** 1 = outbound, 2 = returning, 3 = one-way migration, 4 = army marching out, 5 = army marching home. */
  stage: 1 | 2 | 3 | 4 | 5;
  depart: number;
  arrive: number;
  /** Local coordinates of both ends in the home settlement's frame. */
  fromE: number; fromN: number; toE: number; toN: number;
  res: number;
  qty: number;
  /** Coins owed to the home settlement for the outbound cargo taken on consignment. */
  owed: number;
  /** Coins earned so far on this journey. */
  earned: number;
}

export interface DeadPerson {
  id: number;
  firstName: string;
  lastName: string;
  sex: 0 | 1;
  birth: number;
  birthPlace: string;
  death: number;
  cause: 'starvation' | 'thirst' | 'age' | 'battle' | 'disaster';
  settlement: number;
  spouse: number;
  parents: [number, number];
  children: number[];
  memories: Memory[];
}

export interface Household {
  id: number;
  name: string;
  settlement: number;
  /** Building id of the home. */
  building: number;
  members: number[];
  /** Meals stored in the pantry. */
  food: number;
  /** Purse of the household (may go slightly negative: debts to the community). */
  coins: number;
}

/** A building of a settlement, from first stake to finished work. */
export interface SimBuilding {
  id: number;
  kind: string;
  settlement: number;
  e: number;
  n: number;
  /** Unit vector the front door faces. */
  fe: number;
  fn: number;
  radius: number;
  /** 0..1 — 1 when complete. */
  progress: number;
  started: number;
  completed: number;
  /** Resource extracted (mines), -1 otherwise. */
  res: number;
  /** Lifetime output in units (production buildings). */
  produced: number;
}

export interface SettlementState {
  id: number;
  /** Communal stock by resource index. */
  stock: number[];
  prices: number[];
  treasury: number;
  /** Wild food available around the settlement; regrows daily, shrinks when over-gathered. */
  forage: number;
  /** Yearly harvest factor (0.45 = disastrous year, 1.25 = bountiful). */
  harvest: number;
  /** Buildings under construction. */
  projects: number[];
  /** Consecutive days with an empty granary. */
  hungryDays: number;
  /** Civilisation the settlement belongs to (0 = unclaimed land). */
  civ: number;
  /** Simulated time of its (re)foundation by its current people. */
  founded: number;
  /** Civilisation that founded it (differs from `civ` when occupied). */
  origin: number;
  /** End of an ongoing siege (0 = none): the besieged cannot forage far or trade. */
  besiegedUntil: number;
  /** Lasting marks of divine intervention (simulated end times, 0 = none). */
  droughtUntil: number;
  stormUntil: number;
  blessedUntil: number;
  protectedUntil: number;
  /** Abundant game sent by the heavens. */
  gameUntil: number;
}

export type SimEventType =
  | 'founded' | 'birth' | 'death' | 'marriage' | 'project' | 'built' | 'famine' | 'harvest' | 'trade' | 'shortage'
  | 'civ' | 'ruler' | 'coup' | 'government' | 'tech' | 'religion' | 'schism' | 'faithEnd' | 'colony' | 'festival'
  | 'war' | 'peace' | 'alliance' | 'battle' | 'siege' | 'conquest' | 'secession'
  | 'divine' | 'omen';

/** A dated fact recorded by the simulation (seed of the future chronicles). */
export interface SimEvent {
  t: number;
  type: SimEventType;
  settlement: number;
  /** Person involved. */
  a?: number;
  b?: number;
  /** Building kind, resource index, cause... */
  what?: string | number;
  /** Names frozen at the time of the event, so the record survives the people. */
  names?: string[];
  value?: number;
  /** Civilisation concerned, when the event is political or cultural. */
  civ?: number;
}

export interface SimState {
  version: number;
  /** Simulated seconds since the dawn of year 1. */
  time: number;
  tick: number;
  rng: number;
  nextId: number;
  persons: Person[];
  households: Household[];
  dead: DeadPerson[];
  buildings: SimBuilding[];
  settlements: SettlementState[];
  events: SimEvent[];
  civs: Civilization[];
  religions: Religion[];
  relations: Relation[];
  wars: War[];
  armies: Army[];
  /** The player's power to act upon the world, fed by the devotion of the peoples. */
  divine: { energy: number; acts: number };
  nextBuildingId: number;
  /** Ticks merged per step: 1 = finest; raised at very high speeds (coarser, aggregated simulation). */
  stride: number;
}

export const SIM_STATE_VERSION = 4;

// ------------------------------------------------------- civilisations
export type Government = 'chiefdom' | 'monarchy' | 'council';
export const GOVERNMENT_LABELS: Record<Government, string> = { chiefdom: 'Chefferie', monarchy: 'Monarchie héréditaire', council: 'Conseil des sages' };
export const RULER_TITLES: Record<Government, [string, string]> = { chiefdom: ['Chef', 'Cheffe'], monarchy: ['Roi', 'Reine'], council: ['Premier sage', 'Première sage'] };

/** How power was obtained. */
export type Accession = 'founding' | 'election' | 'inheritance' | 'coup' | 'revolt';

export interface Reign {
  person: number;
  name: string;
  from: number;
  /** 0 while reigning. */
  to: number;
  how: Accession;
}

export interface Dynasty {
  /** Family name of the house. */
  name: string;
  founder: number;
  from: number;
  rulers: Reign[];
}

/** Cultural axes, each 0..1: martial, communal, mercantile, scholarly. */
export const CULTURE_AXES = ['Martiale', 'Solidaire', 'Marchande', 'Savante'];

export interface Culture {
  /** Name of the people, e.g. "Tyrethiens". */
  people: string;
  values: number[];
  /** Tradition codes (see civilization.ts). */
  traditions: string[];
  /** Day of the year of the great yearly festival. */
  festivalDay: number;
}

export interface Civilization {
  id: number;
  name: string;
  /** Index into the civilisation colour palette (banners, roofs, borders). */
  color: number;
  capital: number;
  founded: number;
  /** Current ruler (person id; 0 during an interregnum). */
  leader: number;
  government: Government;
  /** 0..1: how willingly people accept the ruler. */
  legitimacy: number;
  /** Ruling houses in order; the last one reigns. */
  dynasties: Dynasty[];
  culture: Culture;
  /** State religion (0 = none yet). */
  religion: number;
  techs: string[];
  /** Technology being studied and points accumulated. */
  research: { tech: string | null; progress: number };
  lastColony: number;
  /** True once every settlement is gone: kept for history. */
  fallen: number;
}

// ----------------------------------------------------- diplomacy & war
export type WarCause = 'resources' | 'territory' | 'rivalry' | 'religion' | 'security';
export const WAR_CAUSE_LABELS: Record<WarCause, string> = {
  resources: 'la convoitise des ressources', territory: 'des terres disputées', rivalry: 'la rivalité des dirigeants',
  religion: 'la querelle des croyances', security: 'la crainte d’un voisin trop fort',
};

/** Standing between two civilisations (a < b). */
export interface Relation {
  a: number;
  b: number;
  /** -1 (hatred) .. 1 (friendship). */
  opinion: number;
  status: 'peace' | 'war' | 'alliance';
  since: number;
  /** No new war before this time (treaty). */
  truceUntil: number;
  /** Resentment left by past wars, fading with the years. */
  grievance: number;
  /** What currently weighs most against the relation. */
  tension: WarCause;
}

export interface War {
  id: number;
  attacker: number;
  defender: number;
  cause: WarCause;
  start: number;
  /** 0 while the war goes on. */
  end: number;
  deathsAttacker: number;
  deathsDefender: number;
  battles: number;
  /** Settlements taken by each side during the war. */
  takenByAttacker: number[];
  takenByDefender: number[];
  /** 'attacker' | 'defender' | 'draw' once ended. */
  outcome: string;
}

export interface Army {
  id: number;
  civ: number;
  war: number;
  /** Settlement it set out from and the one it marches on. */
  home: number;
  target: number;
  members: number[];
  /** Size when it set out. */
  initial: number;
  state: 'march' | 'siege' | 'battle' | 'return';
  /** Defenders drawn into the battle (target side). */
  defenders: number[];
  defendersInitial: number;
  /** Time the current state began / the next battle round happens. */
  since: number;
  nextRound: number;
}

export interface Religion {
  id: number;
  name: string;
  /** What is venerated: 'sea' | 'sun' | 'mountain' | 'forest' | 'river' | 'ancestors' | 'fire' | 'stars'. */
  focus: string;
  founder: number;
  founderName: string;
  founded: number;
  /** Civilisation where it was born. */
  origin: number;
  /** Religion it split from (0 = original). */
  parent: number;
  /** 0..1 intensity of devotion. */
  fervor: number;
  /** Simulated time it lost its last follower (0 = alive). */
  ended: number;
}

// ------------------------------------------------------------ static sites

/** A neighbouring settlement reachable over land. */
export interface SiteNeighbor {
  id: number;
  /** Position of its centre in this settlement's local frame (metres). */
  e: number;
  n: number;
  distance: number;
  /** True when reaching it means crossing the sea (needs sailing). */
  overSea: boolean;
}

/**
 * Static description of the land around a settlement, derived from the real
 * terrain: where one can walk, what the land yields, where water is.
 * Rebuilt deterministically from the world, never saved.
 */
export interface SimSite {
  id: number;
  name: string;
  /** Longitude of the centre (radians), for local solar time. */
  longitude: number;
  /** Mean annual temperature at the centre (°C) and latitude sine, for seasons. */
  temperature: number;
  sinLatitude: number;
  /** Grid of size×size cells of `cell` metres, centred on the settlement. */
  size: number;
  cell: number;
  /** 1 = walkable terrain (buildings are rasterised on top by the simulation). */
  walk: Uint8Array;
  /** 0 land, 1 fresh water, 2 sea, 3 too steep. */
  kind: Uint8Array;
  /** Wild food richness 0..255. */
  forage: Uint8Array;
  /** Soil fertility 0..255. */
  fertility: Uint8Array;
  /** Tree cover 0..255. */
  wood: Uint8Array;
  /** Mineral: high nibble = resource kind (1 iron, 2 coal, 3 gold, 4 stone), low nibble = richness. */
  mineral: Uint8Array;
  /** Natural places to drink (river bank, lake shore). */
  water: { e: number; n: number }[];
  radius: number;
  neighbors: SiteNeighbor[];
  /** Mean fertility of the walkable land (0..1) and share of sea, used to judge a place before settling it. */
  richness: number;
  coastal: boolean;
}

/** A building as placed by the world's founders (phase 1 layout), in local coordinates. */
export interface FoundingBuilding {
  kind: string;
  settlement: number;
  e: number;
  n: number;
  fe: number;
  fn: number;
  radius: number;
}

/** Compact per-frame view of the population sent to the renderer. */
export interface Snapshot {
  time: number;
  count: number;
  ids: Int32Array;
  /** e, n per person. */
  pos: Float32Array;
  site: Uint8Array;
  /** Activity in the low 4 bits, bit 6 = walking, bit 7 = inside a building. */
  flags: Uint8Array;
  summary: PopulationSummary;
}

export interface PopulationSummary {
  alive: number;
  deaths: number;
  households: number;
  byActivity: number[];
  avgNeeds: number[];
  avgHealth: number;
  pantryMeals: number;
  inhabitedSettlements: number;
  byJob: number[];
  births: number;
  civilizations: number;
  wars: number;
}

/** Static identity of a person for lists and rendering. */
export interface RosterEntry {
  id: number;
  name: string;
  sex: 0 | 1;
  birth: number;
  look: Person['look'];
  settlement: number;
  household: number;
  /** Building id of the home. */
  home: number;
  job: number;
  workplace: number;
}

/** Economic view of one settlement for the interface. */
export interface SettlementView {
  id: number;
  population: number;
  adults: number;
  stock: number[];
  prices: number[];
  /** Stock level each resource is aimed at. */
  targets: number[];
  treasury: number;
  forage: number;
  harvest: number;
  jobs: number[];
  projects: { id: number; kind: string; progress: number; missing: number[] }[];
  buildings: number;
  housing: number;
  civ: number;
  origin: number;
  besieged: boolean;
  /** Divine marks currently in force: 'drought' | 'storm' | 'blessed' | 'protected' | 'game'. */
  marks: string[];
}

/** Political and cultural picture of the world for the interface. */
export interface WorldView {
  civs: (Civilization & { population: number; settlements: number[]; leaderName: string; followers: Record<number, number>; soldiers: number })[];
  relations: Relation[];
  wars: War[];
  /** Armies in the field, with their position in their home settlement's frame. */
  armies: { id: number; civ: number; home: number; target: number; state: string; size: number; e: number; n: number }[];
  religions: (Religion & { followers: number })[];
  /** Settlement id -> [civ, population]. */
  settlements: Record<number, [number, number]>;
  /** Most recent recorded events of the whole world, oldest first. */
  events: SimEvent[];
  divine: { energy: number; acts: number };
}

export interface SearchHit { id: number; name: string; alive: boolean; birth: number; death: number; settlement: number }

export interface EconomyView {
  settlements: SettlementView[];
  /** Most recent events, newest last. */
  events: SimEvent[];
}

/** Everything the interface needs to show one person's sheet (built in the simulation thread). */
export interface PersonView {
  alive: boolean;
  person: Person | DeadPerson;
  age: number;
  settlementName: string;
  household: { name: string; food: number; coins: number; members: number[] } | null;
  /** Names of every person referenced (family, bonds, memories), living or dead. */
  names: Record<number, string>;
  /** Ids among `names` who have died. */
  deceased: number[];
  /** Current action scores, best first (living only). */
  utilities: { activity: number; score: number }[];
}
