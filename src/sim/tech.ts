/**
 * Technology tree. Every technology changes real numbers used by the
 * simulation (see Mods): nothing here is decorative.
 */
export interface Mods {
  /** Farm yield multiplier. */
  farm: number;
  fish: number;
  mine: number;
  forage: number;
  /** Extra output per shift from better hauling (farms, forests, mines). */
  haul: number;
  /** Productivity bonus given by tools, and how fast they wear. */
  tools: number;
  toolWear: number;
  /** Labour needed to build (multiplier, lower is better). */
  buildHours: number;
  research: number;
  /** Units a merchant can carry. */
  cargo: number;
  /** Old-age mortality multiplier (lower is better). */
  mortality: number;
  /** Daily granary loss. */
  spoilage: number;
  /** Worst possible harvest factor. */
  harvestFloor: number;
  /** Can cross the sea to trade and settle. */
  sailing: boolean;
  /** Strength of armed people (used from phase 5). */
  military: number;
}

export const BASE_MODS: Mods = {
  farm: 1, fish: 1, mine: 1, forage: 1, haul: 1, tools: 1.35, toolWear: 1, buildHours: 1, research: 1, cargo: 8,
  mortality: 1, spoilage: 0.015, harvestFloor: 0.55, sailing: false, military: 1,
};

export interface Tech {
  id: string;
  name: string;
  field: string;
  cost: number;
  requires: string[];
  effect: string;
  apply: (m: Mods) => void;
}

export const TECHS: Tech[] = [
  { id: 'pottery', name: 'Poterie', field: 'Agriculture', cost: 160, requires: [], effect: 'Les greniers perdent deux fois moins de nourriture', apply: (m) => { m.spoilage *= 0.5; } },
  { id: 'trapping', name: 'Pièges et arcs', field: 'Armement', cost: 160, requires: [], effect: 'Chasse et cueillette +25 %', apply: (m) => { m.forage *= 1.25; m.military *= 1.15; } },
  { id: 'boats', name: 'Barques', field: 'Navigation', cost: 240, requires: [], effect: 'Pêche +30 %', apply: (m) => { m.fish *= 1.3; } },
  { id: 'irrigation', name: 'Irrigation', field: 'Agriculture', cost: 320, requires: ['pottery'], effect: 'Rendement des fermes +25 %', apply: (m) => { m.farm *= 1.25; } },
  { id: 'masonry', name: 'Maçonnerie', field: 'Architecture', cost: 320, requires: [], effect: 'Chantiers 20 % plus rapides', apply: (m) => { m.buildHours *= 0.8; } },
  { id: 'herbalism', name: 'Herboristerie', field: 'Médecine', cost: 320, requires: [], effect: 'Mortalité des anciens −25 %', apply: (m) => { m.mortality *= 0.75; } },
  { id: 'wheel', name: 'Roue', field: 'Ingénierie', cost: 400, requires: [], effect: 'Charrois : production rapportée +15 %', apply: (m) => { m.haul *= 1.15; } },
  { id: 'currency', name: 'Monnaie frappée', field: 'Commerce', cost: 400, requires: [], effect: 'Les marchands transportent presque deux fois plus', apply: (m) => { m.cargo = 14; } },
  { id: 'metallurgy', name: 'Métallurgie', field: 'Métallurgie', cost: 480, requires: ['masonry'], effect: 'Outils plus efficaces (+60 % au lieu de +35 %) et deux fois plus durables', apply: (m) => { m.tools = 1.6; m.toolWear *= 0.5; } },
  { id: 'writing', name: 'Écriture', field: 'Écriture', cost: 600, requires: ['pottery'], effect: 'Recherche +50 % ; ouvre la voie au conseil des sages', apply: (m) => { m.research *= 1.5; } },
  { id: 'calendar', name: 'Calendrier', field: 'Sciences', cost: 480, requires: ['writing'], effect: 'Les mauvaises récoltes sont moins désastreuses', apply: (m) => { m.harvestFloor = 0.75; } },
  { id: 'weapons', name: 'Armes de fer', field: 'Armement', cost: 560, requires: ['metallurgy'], effect: 'Force des guerriers +50 %', apply: (m) => { m.military *= 1.5; } },
  { id: 'deepMining', name: 'Galeries profondes', field: 'Métallurgie', cost: 640, requires: ['metallurgy'], effect: 'Extraction +40 %', apply: (m) => { m.mine *= 1.4; } },
  { id: 'cropRotation', name: 'Assolement', field: 'Agriculture', cost: 640, requires: ['irrigation'], effect: 'Rendement des fermes +20 %', apply: (m) => { m.farm *= 1.2; } },
  { id: 'sailing', name: 'Voile', field: 'Navigation', cost: 800, requires: ['boats'], effect: 'Commerce et colonies au-delà des mers', apply: (m) => { m.sailing = true; m.fish *= 1.1; } },
  { id: 'medicine', name: 'Médecine', field: 'Médecine', cost: 880, requires: ['herbalism', 'writing'], effect: 'Mortalité des anciens encore −30 %', apply: (m) => { m.mortality *= 0.7; } },
  { id: 'mathematics', name: 'Mathématiques', field: 'Sciences', cost: 1000, requires: ['writing'], effect: 'Recherche +30 %, chantiers 10 % plus rapides', apply: (m) => { m.research *= 1.3; m.buildHours *= 0.9; } },
];

export const TECH_BY_ID = new Map(TECHS.map((t) => [t.id, t]));

export function modsFor(techs: string[]): Mods {
  const m = { ...BASE_MODS };
  for (const id of techs) TECH_BY_ID.get(id)?.apply(m);
  return m;
}

/** Technologies a civilisation could start studying now. */
export function availableTechs(known: string[]): Tech[] {
  return TECHS.filter((t) => !known.includes(t.id) && t.requires.every((r) => known.includes(r)));
}
