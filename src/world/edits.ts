import { Simplex3 } from '../core/noise';
import { hashString } from '../core/rng';
import { Biome, Water, type WorldData } from './types';

/**
 * Lasting changes made to the planet by divine intervention. A world is
 * regenerated from its seed, then its edits are replayed in order: the result
 * is identical on every load.
 */
export type WorldEditKind = 'mountain' | 'valley' | 'forest' | 'deposit' | 'crater' | 'burn';

export interface WorldEdit {
  kind: WorldEditKind;
  /** Grid cell of the centre. */
  x: number;
  y: number;
  /** Radius in metres. */
  radius: number;
  /** Height in metres (mountain, valley, crater) or resource index 1..4 (deposit: iron, coal, gold, stone). */
  amount: number;
}

export interface EditBounds { x0: number; x1: number; y0: number; y1: number }

/** Applies one edit to the world grid. Pure and deterministic. Returns the affected cell rectangle (x may wrap). */
export function applyEdit(w: WorldData, edit: WorldEdit): EditBounds {
  const W = w.width, H = w.height;
  const cell = (2 * Math.PI * w.radius) / W;
  const noise = new Simplex3(hashString(w.seed) ^ (edit.x * 73856093) ^ (edit.y * 19349663));
  const lat = Math.PI / 2 - ((edit.y + 0.5) / H) * Math.PI;
  const cl = Math.max(0.1, Math.cos(lat));
  const ry = Math.ceil(edit.radius / cell) + 1, rx = Math.ceil(ry / cl) + 1;
  const y0 = Math.max(1, edit.y - ry), y1 = Math.min(H - 2, edit.y + ry);
  for (let y = y0; y <= y1; y++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const x = (((edit.x + dx) % W) + W) % W;
      const i = y * W + x;
      const d = Math.hypot(dx * cell * cl, (y - edit.y) * cell) / edit.radius;
      if (d >= 1) continue;
      const land = w.water[i] !== Water.Ocean;
      const fall = Math.cos(d * Math.PI * 0.5) ** 2; // smooth dome
      switch (edit.kind) {
        case 'mountain': {
          if (!land) break; // mountains rise from the land, not from the sea floor
          const ridges = 0.75 + 0.5 * noise.ridged(x * 0.09, y * 0.09, 1.7, 4);
          const rise = edit.amount * Math.pow(fall, 1.3) * ridges;
          w.elevation[i] += rise;
          w.temperature[i] -= rise * 0.05;
          if (rise > 2.5 && (w.water[i] === Water.River || w.water[i] === Water.Lake)) { w.water[i] = Water.Land; w.waterMask[i] = 0; }
          else if (rise > 2.5) w.waterMask[i] = 0;
          if (rise > 25) { w.fertility[i] = Math.round(w.fertility[i] * 0.3); w.forest[i] = Math.round(w.forest[i] * (w.elevation[i] > 170 ? 0.1 : 0.6)); }
          if (w.elevation[i] > 170) w.biome[i] = Biome.Alpine;
          break;
        }
        case 'valley': {
          if (!land) break;
          // carve down toward a gentle floor, never below the shoreline
          const drop = edit.amount * fall;
          const floor = 0.8;
          const before = w.elevation[i];
          w.elevation[i] = Math.max(floor, before - drop);
          w.temperature[i] += (before - w.elevation[i]) * 0.05;
          if (before - w.elevation[i] > 3 && w.water[i] === Water.Land) w.fertility[i] = Math.min(255, w.fertility[i] + 40);
          if (w.biome[i] === Biome.Alpine && w.elevation[i] < 150) w.biome[i] = Biome.Grassland;
          break;
        }
        case 'forest': {
          if (w.water[i] !== Water.Land || w.elevation[i] > 260 || w.temperature[i] < -8) break;
          const clump = 0.6 + 0.4 * noise.fbm(x * 0.2, y * 0.2, 4.1, 2);
          w.forest[i] = Math.max(w.forest[i], Math.round(255 * Math.min(1, fall * 1.6) * clump));
          w.biodiversity[i] = Math.min(255, w.biodiversity[i] + 50);
          if (w.forest[i] > 120 && (w.biome[i] === Biome.Grassland || w.biome[i] === Biome.Savanna || w.biome[i] === Biome.Desert || w.biome[i] === Biome.Tundra)) {
            w.biome[i] = w.temperature[i] < 5 ? Biome.Taiga : w.temperature[i] > 19 ? Biome.Rainforest : Biome.Forest;
          }
          break;
        }
        case 'deposit': {
          if (!land) break;
          const rich = Math.max(1, Math.round(15 * fall));
          if ((w.mineral[i] & 15) < rich) w.mineral[i] = (Math.max(1, Math.min(4, edit.amount)) << 4) | rich;
          break;
        }
        case 'crater': {
          if (!land) break;
          // bowl with a raised rim, scorched and barren
          const bowl = d < 0.72 ? -edit.amount * Math.cos((d / 0.72) * Math.PI * 0.5) ** 1.5 : edit.amount * 0.35 * Math.sin(((d - 0.72) / 0.28) * Math.PI);
          w.elevation[i] = Math.max(0.6, w.elevation[i] + bowl);
          w.forest[i] = 0;
          w.fertility[i] = Math.round(w.fertility[i] * 0.2);
          w.volcanic[i] = Math.max(w.volcanic[i], Math.round(150 * (1 - d * 0.5)));
          if (w.water[i] !== Water.Land) { w.water[i] = Water.Land; w.waterMask[i] = 0; }
          break;
        }
        case 'burn': {
          if (w.water[i] !== Water.Land) break;
          const heat = fall * (0.7 + 0.3 * noise.fbm(x * 0.3, y * 0.3, 2.2, 2));
          if (heat < 0.15) break;
          w.forest[i] = Math.round(w.forest[i] * (1 - Math.min(1, heat * 1.4)));
          w.volcanic[i] = Math.max(w.volcanic[i], Math.round(95 * heat)); // ash
          w.biodiversity[i] = Math.round(w.biodiversity[i] * (1 - heat * 0.6));
          w.fertility[i] = Math.min(255, w.fertility[i] + Math.round(25 * heat)); // ashes feed the soil
          break;
        }
      }
    }
  }
  return { x0: edit.x - rx, x1: edit.x + rx, y0, y1 };
}

export function applyEdits(w: WorldData, edits: WorldEdit[]): void {
  for (const e of edits) applyEdit(w, e);
}
