/**
 * World data model. The planet is stored as an equirectangular grid
 * (x: longitude, wraps; y: latitude, row 0 = north pole). All fields are
 * plain typed arrays so the whole world can be transferred between workers
 * and serialised without transformation.
 */

/** Planet radius in metres (a stylised miniature planet, ~20 km around). */
export const PLANET_RADIUS = 3200;
/** Altitude of the cloud layer above sea level (m). */
export const CLOUD_ALTITUDE = 420;
/** Top of the atmosphere above sea level (m). */
export const ATMOSPHERE_HEIGHT = 520;

export interface WorldConfig {
  seed: string;
  /** Grid width (longitude samples). Height is width / 2. */
  width: number;
}

export const DEFAULT_WORLD_WIDTH = 2048;

export enum Biome {
  DeepOcean = 0,
  Ocean = 1,
  Beach = 2,
  Desert = 3,
  Savanna = 4,
  Grassland = 5,
  Forest = 6,
  Rainforest = 7,
  Taiga = 8,
  Tundra = 9,
  Ice = 10,
  Alpine = 11,
  Volcanic = 12,
  Lake = 13,
  River = 14,
  Marsh = 15,
}

export const BIOME_NAMES: Record<number, string> = {
  0: 'Océan profond',
  1: 'Mer côtière',
  2: 'Littoral',
  3: 'Désert',
  4: 'Savane',
  5: 'Plaine',
  6: 'Forêt tempérée',
  7: 'Forêt tropicale',
  8: 'Taïga',
  9: 'Toundra',
  10: 'Glaces éternelles',
  11: 'Haute montagne',
  12: 'Terres volcaniques',
  13: 'Lac',
  14: 'Rivière',
  15: 'Marais',
};

export enum Water {
  Land = 0,
  Ocean = 1,
  Lake = 2,
  River = 3,
}

export type ResourceKind = 'iron' | 'coal' | 'gold' | 'stone';
export const RESOURCE_KINDS: ResourceKind[] = ['iron', 'coal', 'gold', 'stone'];
export const RESOURCE_NAMES: Record<ResourceKind, string> = {
  iron: 'Fer',
  coal: 'Charbon',
  gold: 'Or',
  stone: 'Pierre',
};

export interface Deposit {
  id: number;
  kind: ResourceKind;
  /** Grid cell of the deposit centre. */
  x: number;
  y: number;
  /** Radius in cells. */
  radius: number;
  /** Remaining quantity (abstract units). */
  amount: number;
}

export interface Landmass {
  id: number;
  name: string;
  kind: 'continent' | 'island';
  /** Surface in km². */
  area: number;
  /** Representative cell (highest fertility-weighted centroid snapped to land). */
  x: number;
  y: number;
}

export interface Volcano {
  x: number;
  y: number;
  /** Cone radius in metres. */
  radius: number;
  height: number;
}

/** A location suited to founding a settlement (computed from real world data). */
export interface SettlementSite {
  x: number;
  y: number;
  score: number;
  landmass: number;
  coastal: boolean;
  riverside: boolean;
}

export interface WorldStats {
  landRatio: number;
  maxElevation: number;
  riverCells: number;
  lakeCells: number;
  meanLandTemperature: number;
  biomeArea: number[];
}

export interface WorldData {
  seed: string;
  width: number;
  height: number;
  radius: number;
  /** Terrain elevation in metres relative to sea level (lakes are flattened to their surface). */
  elevation: Float32Array;
  /** Mean annual temperature in °C. */
  temperature: Float32Array;
  /** Moisture / rainfall 0..1. */
  moisture: Float32Array;
  /** River discharge (accumulated rainfall, in cell units). */
  flux: Float32Array;
  /** Downstream cell index for land cells (-1 for ocean). */
  flowTo: Int32Array;
  /** Water kind per cell (see Water). */
  water: Uint8Array;
  /** Soft water mask 0..255 used for rendering rivers & lakes. */
  waterMask: Uint8Array;
  biome: Uint8Array;
  /** 0..255 */
  fertility: Uint8Array;
  /** Tree cover 0..255 */
  forest: Uint8Array;
  /** Volcanic ash/lava influence 0..255 */
  volcanic: Uint8Array;
  /** Biodiversity 0..255 */
  biodiversity: Uint8Array;
  /** Distance to the ocean in cells (capped at 255). */
  oceanDist: Uint8Array;
  /** Landmass id per cell (0 = water). */
  landmassId: Uint16Array;
  /** Mineral richness per cell: high nibble = resource kind index + 1, low nibble = richness. */
  mineral: Uint8Array;
  deposits: Deposit[];
  landmasses: Landmass[];
  volcanoes: Volcano[];
  sites: SettlementSite[];
  stats: WorldStats;
}

/** Transferable buffers of a WorldData (for postMessage). */
export function worldTransferables(w: WorldData): ArrayBuffer[] {
  return [
    w.elevation, w.temperature, w.moisture, w.flux, w.flowTo, w.water, w.waterMask, w.biome,
    w.fertility, w.forest, w.volcanic, w.biodiversity, w.oceanDist, w.landmassId, w.mineral,
  ].map((a) => a.buffer as ArrayBuffer);
}
