import * as THREE from 'three';
import { Simplex3 } from '../core/noise';
import { hashString } from '../core/rng';
import { clamp, clamp01 } from '../core/math';
import { Biome, Water, type WorldData } from '../world/types';

function dataTexture(data: Uint8Array, w: number, h: number, mip = true): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mip;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const encSlope = (s: number) => {
  const e = Math.sign(s) * Math.sqrt(Math.min(1, Math.abs(s) / 4));
  return Math.round((e * 0.5 + 0.5) * 255);
};

/**
 * GPU views of the world grid.
 *  texA: R,G = terrain slope east/north (sqrt-encoded), B = fresh water mask, A = sea depth (sqrt-encoded, 0 on land)
 *  texB: R = temperature (-30..40°C), G = moisture, B = forest cover, A = volcanic influence
 */
export function buildWorldTextures(w: WorldData): { texA: THREE.DataTexture; texB: THREE.DataTexture } {
  const W = w.width, H = w.height;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const cell = (2 * Math.PI * w.radius) / W;
  const e = w.elevation;
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    const dxm = cell * Math.max(0.02, Math.cos(lat));
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      const sE = (e[y * W + ((x + 1) % W)] - e[y * W + ((x + W - 1) % W)]) / (2 * dxm);
      const sN = (e[Math.max(0, y - 1) * W + x] - e[Math.min(H - 1, y + 1) * W + x]) / (2 * cell);
      a[o] = encSlope(sE);
      a[o + 1] = encSlope(sN);
      a[o + 2] = w.waterMask[i];
      a[o + 3] = e[i] < 0 ? Math.round(Math.sqrt(Math.min(1, -e[i] / 120)) * 255) : 0;
      b[o] = Math.round(clamp01((w.temperature[i] + 30) / 70) * 255);
      b[o + 1] = Math.round(w.moisture[i] * 255);
      b[o + 2] = w.forest[i];
      b[o + 3] = w.volcanic[i];
    }
  }
  // Soften the tree-cover channel (render only) so forest edges do not show grid steps.
  const tmp = new Uint8Array(W * H);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < W * H; i++) tmp[i] = b[i * 4 + 2];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const xl = (x + W - 1) % W, xr = (x + 1) % W;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) s += tmp[(y + dy) * W + xl] + tmp[(y + dy) * W + x] + tmp[(y + dy) * W + xr];
        b[(y * W + x) * 4 + 2] = s / 9;
      }
    }
  }
  return { texA: dataTexture(a, W, H), texB: dataTexture(b, W, H) };
}

/** Seamless equirectangular cloud coverage map (R = large systems, G = finer detail). */
export function buildCloudTexture(seed: string, width = 1024): THREE.DataTexture {
  const W = width, H = width >> 1;
  const n = new Simplex3(hashString(seed) ^ 0xc10d);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat), py = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * 2 * Math.PI;
      const px = cl * Math.cos(lon), pz = cl * Math.sin(lon);
      // Stretch along latitude bands for a wind-swept look.
      const wx = n.fbm(px * 2 + 5, py * 2, pz * 2, 3) * 0.35;
      const big = n.fbm(px * 2.4 + wx, py * 4.2 + wx, pz * 2.4 - wx, 5) * 0.5 + 0.5;
      const fine = n.fbm(px * 11, py * 14 + 3.3, pz * 11, 4) * 0.5 + 0.5;
      const o = (y * W + x) * 4;
      data[o] = Math.round(clamp01(big) * 255);
      data[o + 1] = Math.round(clamp01(fine) * 255);
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  return dataTexture(data, W, H);
}

export type AtlasMode =
  | 'none' | 'elevation' | 'temperature' | 'moisture' | 'fertility' | 'biomes' | 'resources' | 'biodiversity' | 'landmasses'
  | 'borders' | 'population' | 'religions' | 'wars';

/** Maps drawn from the living simulation rather than from the world grid. */
export const POLITICAL_MODES: AtlasMode[] = ['borders', 'population', 'religions', 'wars'];

/** A settlement's zone of influence to paint on a political map. */
export interface PoliticalMark {
  dir: { x: number; y: number; z: number };
  /** Radius in metres. */
  radius: number;
  color: number;
  strength: number;
}

export const ATLAS_MODES: { id: AtlasMode; label: string; legend: [string, string][] }[] = [
  { id: 'none', label: 'Naturel', legend: [] },
  { id: 'biomes', label: 'Climats & biomes', legend: [['#d9bd78', 'Désert'], ['#aaa550', 'Savane'], ['#78a84a', 'Plaine'], ['#2f7036', 'Forêt'], ['#125a2a', 'Jungle'], ['#3c6450', 'Taïga'], ['#8c8c6e', 'Toundra'], ['#f0f5fa', 'Glaces'], ['#77726d', 'Montagne'], ['#4a2f2f', 'Volcanique']] },
  { id: 'elevation', label: 'Relief', legend: [['#2a6b3f', '0 m'], ['#d8c66a', '80 m'], ['#a8643a', '200 m'], ['#ffffff', '400 m']] },
  { id: 'temperature', label: 'Températures', legend: [['#3b4cc0', '−25 °C'], ['#aac7fd', '0 °C'], ['#f7b89c', '18 °C'], ['#b40426', '32 °C']] },
  { id: 'moisture', label: 'Précipitations', legend: [['#c9a15a', 'Aride'], ['#e9e2b0', 'Sec'], ['#74b9c9', 'Humide'], ['#1d4f9c', 'Très humide']] },
  { id: 'fertility', label: 'Fertilité', legend: [['#4a3b2a', 'Stérile'], ['#a08a3c', 'Pauvre'], ['#7fb83a', 'Fertile'], ['#1fe05a', 'Très fertile']] },
  { id: 'resources', label: 'Ressources', legend: [['#d8623a', 'Fer'], ['#3c3c46', 'Charbon'], ['#ffd23c', 'Or'], ['#b9b4aa', 'Pierre'], ['#2f7036', 'Bois']] },
  { id: 'biodiversity', label: 'Biodiversité', legend: [['#2b2b3a', 'Faible'], ['#3f8f7a', 'Moyenne'], ['#c8f06a', 'Foisonnante']] },
  { id: 'landmasses', label: 'Continents', legend: [] },
  { id: 'borders', label: 'Frontières', legend: [] },
  { id: 'population', label: 'Population', legend: [['#5a4424', 'Clairsemée'], ['#ffb347', 'Dense']] },
  { id: 'religions', label: 'Religions', legend: [] },
  { id: 'wars', label: 'Guerres', legend: [['#c0392b', 'Peuple en guerre'], ['#e67e22', 'Terre occupée'], ['#f1c40f', 'Assiégée'], ['#4a6f8a', 'En paix']] },
];

const BIOME_COL: Record<number, [number, number, number]> = {
  [Biome.DeepOcean]: [14, 34, 74], [Biome.Ocean]: [30, 76, 124], [Biome.Beach]: [226, 210, 160],
  [Biome.Desert]: [217, 189, 120], [Biome.Savanna]: [170, 165, 80], [Biome.Grassland]: [120, 168, 74],
  [Biome.Forest]: [47, 112, 54], [Biome.Rainforest]: [18, 90, 42], [Biome.Taiga]: [60, 100, 80],
  [Biome.Tundra]: [140, 140, 110], [Biome.Ice]: [240, 245, 250], [Biome.Alpine]: [119, 114, 109],
  [Biome.Volcanic]: [74, 47, 47], [Biome.Lake]: [70, 140, 210], [Biome.River]: [70, 140, 210], [Biome.Marsh]: [86, 120, 90],
};

function ramp(stops: [number, number, number, number][], t: number): [number, number, number] {
  t = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / (b[0] - a[0] || 1);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    }
  }
  const l = stops[stops.length - 1];
  return [l[1], l[2], l[3]];
}

const RAMP_ELEV: [number, number, number, number][] = [[0, 42, 107, 63], [0.2, 216, 198, 106], [0.5, 168, 100, 58], [1, 255, 255, 255]];
const RAMP_TEMP: [number, number, number, number][] = [[0, 59, 76, 192], [0.44, 170, 199, 253], [0.75, 247, 184, 156], [1, 180, 4, 38]];
const RAMP_MOIST: [number, number, number, number][] = [[0, 201, 161, 90], [0.35, 233, 226, 176], [0.65, 116, 185, 201], [1, 29, 79, 156]];
const RAMP_FERT: [number, number, number, number][] = [[0, 74, 59, 42], [0.35, 160, 138, 60], [0.7, 127, 184, 58], [1, 31, 224, 90]];
const RAMP_BIO: [number, number, number, number][] = [[0, 43, 43, 58], [0.5, 63, 143, 122], [1, 200, 240, 106]];
const RES_COL: [number, number, number][] = [[216, 98, 58], [60, 60, 70], [255, 210, 60], [185, 180, 170]];

/** Fills (or creates) the atlas overlay texture from live world data. Alpha = overlay strength. */
/**
 * Paints settlements' zones of influence over a dimmed map. Where zones of
 * different colours overlap, the nearer settlement wins: borders emerge.
 */
export function buildPoliticalTexture(w: WorldData, marks: PoliticalMark[], tex: THREE.DataTexture): void {
  const W = w.width, H = w.height;
  const out = tex.image.data as Uint8Array;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4, ocean = w.water[i] === Water.Ocean;
    out[o] = out[o + 1] = out[o + 2] = 46;
    out[o + 3] = ocean ? 0 : 165;
  }
  const best = new Float32Array(W * H).fill(2);
  const cell = (2 * Math.PI * w.radius) / W;
  for (const m of marks) {
    const lat = Math.asin(m.dir.y), lon = Math.atan2(m.dir.z, m.dir.x);
    const cy = (0.5 - lat / Math.PI) * H, cx = (lon / (2 * Math.PI) + 0.5) * W;
    const ry = Math.ceil(m.radius / cell), rx = Math.ceil(ry / Math.max(0.1, Math.cos(lat)));
    const r = (m.color >> 16) & 255, g = (m.color >> 8) & 255, b = m.color & 255;
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, Math.ceil(cy + ry)); y++) {
      const cl = Math.cos(Math.PI / 2 - ((y + 0.5) / H) * Math.PI);
      for (let dx = -rx; dx <= rx; dx++) {
        const x = (((Math.floor(cx) + dx) % W) + W) % W;
        const i = y * W + x;
        if (w.water[i] === Water.Ocean) continue;
        const d = Math.hypot((dx * cell * cl), (y + 0.5 - cy) * cell) / m.radius;
        if (d > 1 || d >= best[i]) continue;
        best[i] = d;
        const o = i * 4;
        const edge = d > 0.9 ? 0.6 : 1; // darker rim: a visible frontier
        out[o] = r * edge; out[o + 1] = g * edge; out[o + 2] = b * edge;
        out[o + 3] = Math.round(255 * Math.min(1, m.strength * (d > 0.9 ? 1 : 0.55 + 0.35 * (1 - d))));
      }
    }
  }
  tex.needsUpdate = true;
}

export function buildAtlasTexture(w: WorldData, mode: AtlasMode, existing?: THREE.DataTexture): THREE.DataTexture {
  const W = w.width, H = w.height;
  const tex = existing ?? dataTexture(new Uint8Array(W * H * 4), W, H);
  const out = tex.image.data as Uint8Array;
  const landCols = new Map<number, [number, number, number]>();
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const ocean = w.water[i] === Water.Ocean;
    let c: [number, number, number] = [0, 0, 0];
    let alpha = ocean ? 0 : 235;
    switch (mode) {
      case 'none': alpha = 0; break;
      case 'biomes': c = BIOME_COL[w.biome[i]]; alpha = 235; break;
      case 'elevation':
        if (ocean) { c = ramp([[0, 8, 20, 60], [1, 60, 120, 170]], 1 + w.elevation[i] / 200); alpha = 235; }
        else c = ramp(RAMP_ELEV, w.elevation[i] / 400);
        break;
      case 'temperature': c = ramp(RAMP_TEMP, (w.temperature[i] + 25) / 57); alpha = 225; break;
      case 'moisture': c = ramp(RAMP_MOIST, w.moisture[i]); break;
      case 'fertility': c = ramp(RAMP_FERT, w.fertility[i] / 255); break;
      case 'biodiversity': c = ramp(RAMP_BIO, w.biodiversity[i] / 255); alpha = 225; break;
      case 'resources': {
        const m = w.mineral[i];
        if (m >> 4) { c = RES_COL[(m >> 4) - 1]; alpha = 150 + (m & 15) * 7; }
        else if (w.forest[i] > 110) { c = [47, 112, 54]; alpha = 150; }
        else { c = [40, 40, 44]; alpha = ocean ? 0 : 150; }
        break;
      }
      case 'landmasses': {
        const id = w.landmassId[i];
        if (id) {
          let col = landCols.get(id);
          if (!col) {
            const k = new THREE.Color().setHSL((id * 0.61803398875) % 1, 0.55, 0.55);
            col = [k.r * 255, k.g * 255, k.b * 255];
            landCols.set(id, col);
          }
          c = col;
        }
        break;
      }
    }
    out[o] = clamp(c[0], 0, 255);
    out[o + 1] = clamp(c[1], 0, 255);
    out[o + 2] = clamp(c[2], 0, 255);
    out[o + 3] = alpha;
  }
  tex.needsUpdate = true;
  return tex;
}
