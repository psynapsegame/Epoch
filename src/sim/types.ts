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
}
export const ACTIVITY_COUNT = 9;

export const ACTIVITY_LABELS: Record<number, string> = {
  0: 'Flâne', 1: 'Cueille et chasse', 2: 'Mange', 3: 'Boit', 4: 'Dort', 5: 'Discute', 6: 'Explore', 7: 'Se repose au foyer', 8: 'Joue',
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

export const SKILLS = ['foraging', 'social', 'exploration'] as const;
export const SKILL_LABELS = ['Cueillette et chasse', 'Éloquence', 'Exploration'];

export type MemoryType =
  | 'born' | 'settled' | 'married' | 'child' | 'friend' | 'quarrel' | 'discovery' | 'hunger' | 'gift' | 'received' | 'mourning' | 'feast';

export interface Memory {
  /** Simulated time of the event. */
  t: number;
  type: MemoryType;
  /** Other person involved, if any. */
  ref?: number;
  /** Place name, if any. */
  place?: string;
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
  /** Skill levels in [0,1] (see SKILLS). */
  skills: number[];
  health: number;
  /** Possessions (abstract value). The economy arrives in phase 3. */
  wealth: number;
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
  /** Meals being carried home. */
  carry: number;
  /** True while inside a building (not drawn). */
  inside: boolean;
  /** Lifetime counters (observable behaviour, used by statistics and tests). */
  counts: { meals: number; forages: number; chats: number; explorations: number; gifts: number };
}

export interface DeadPerson {
  id: number;
  firstName: string;
  lastName: string;
  sex: 0 | 1;
  birth: number;
  birthPlace: string;
  death: number;
  cause: 'starvation' | 'thirst';
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
}

export const SIM_STATE_VERSION = 1;

// ------------------------------------------------------------ static sites

export interface SiteBuilding {
  id: number;
  kind: string;
  e: number;
  n: number;
  radius: number;
  /** Point just outside the front door. */
  doorE: number;
  doorN: number;
}

/**
 * Static description of a settlement for the simulation: a local walkability
 * and foraging map derived from the real terrain, plus its buildings.
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
  /** 1 = walkable. */
  walk: Uint8Array;
  /** Foraging richness 0..255. */
  forage: Uint8Array;
  buildings: SiteBuilding[];
  /** Places to drink (well, river bank, lake shore). */
  water: { e: number; n: number }[];
  /** Gathering place (market or well). */
  plaza: { e: number; n: number };
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
}

/** Everything the interface needs to show one person's sheet (built in the simulation thread). */
export interface PersonView {
  alive: boolean;
  person: Person | DeadPerson;
  age: number;
  settlementName: string;
  household: { name: string; food: number; members: number[] } | null;
  /** Names of every person referenced (family, bonds, memories), living or dead. */
  names: Record<number, string>;
  /** Ids among `names` who have died. */
  deceased: number[];
  /** Current action scores, best first (living only). */
  utilities: { activity: number; score: number }[];
}
