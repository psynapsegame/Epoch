import { Simplex3 } from '../core/noise';
import { Rng, hashString } from '../core/rng';
import { clamp, clamp01, smoothstep } from '../core/math';
import { placeName } from './names';
import {
  Biome, Water, PLANET_RADIUS, RESOURCE_KINDS,
  type Deposit, type Landmass, type ResourceKind, type SettlementSite, type Volcano,
  type WorldConfig, type WorldData,
} from './types';

export type ProgressFn = (stage: string, progress: number) => void;

/**
 * Procedural planet generator. Pure & deterministic: the same config always
 * yields a bit-identical world. Runs inside a Web Worker in the app.
 *
 * Pipeline: continents -> relief -> volcanoes -> climate -> hydrology
 * (depression filling, rivers, lakes) -> biomes -> resources -> landmasses -> sites.
 */
export function generateWorld(cfg: WorldConfig, progress: ProgressFn = () => {}): WorldData {
  const W = cfg.width;
  const H = W >> 1;
  const N = W * H;
  const R = PLANET_RADIUS;
  const cellSize = (2 * Math.PI * R) / W; // metres at the equator
  const seedNum = hashString(cfg.seed);
  const rng = new Rng(seedNum);

  const nCont = new Simplex3(seedNum ^ 0x1111);
  const nWarp = new Simplex3(seedNum ^ 0x2222);
  const nHill = new Simplex3(seedNum ^ 0x3333);
  const nBelt = new Simplex3(seedNum ^ 0x4444);
  const nRidge = new Simplex3(seedNum ^ 0x5555);
  const nClim = new Simplex3(seedNum ^ 0x6666);
  const nIsle = new Simplex3(seedNum ^ 0x7777);

  // Unit direction lookup tables.
  const cosLat = new Float64Array(H), sinLat = new Float64Array(H);
  const cosLon = new Float64Array(W), sinLon = new Float64Array(W);
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    cosLat[y] = Math.cos(lat);
    sinLat[y] = Math.sin(lat);
  }
  for (let x = 0; x < W; x++) {
    const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI;
    cosLon[x] = Math.cos(lon);
    sinLon[x] = Math.sin(lon);
  }

  const elevation = new Float32Array(N);
  const temperature = new Float32Array(N);
  const moisture = new Float32Array(N);
  const flux = new Float32Array(N);
  const flowTo = new Int32Array(N).fill(-1);
  const water = new Uint8Array(N);
  const waterMask = new Uint8Array(N);
  const biome = new Uint8Array(N);
  const fertility = new Uint8Array(N);
  const forest = new Uint8Array(N);
  const volcanic = new Uint8Array(N);
  const biodiversity = new Uint8Array(N);
  const oceanDist = new Uint8Array(N);
  const landmassId = new Uint16Array(N);
  const mineral = new Uint8Array(N);

  // ---------------------------------------------------------------- continents
  progress('Formation des continents', 0);
  const cont = new Float32Array(N);
  const contFreq = 1.05 + rng.next() * 0.3;
  for (let y = 0; y < H; y++) {
    const cl = cosLat[y], py = sinLat[y];
    for (let x = 0; x < W; x++) {
      const px = cl * cosLon[x], pz = cl * sinLon[x];
      const wx = nWarp.fbm(px * 1.4 + 11.3, py * 1.4, pz * 1.4, 3) * 0.32;
      const wy = nWarp.fbm(px * 1.4, py * 1.4 + 27.1, pz * 1.4, 3) * 0.32;
      const wz = nWarp.fbm(px * 1.4, py * 1.4, pz * 1.4 + 5.7, 3) * 0.32;
      const qx = px + wx, qy = py + wy, qz = pz + wz;
      let c = nCont.fbm(qx * contFreq, qy * contFreq, qz * contFreq, 5, 2.05, 0.48);
      c += nHill.fbm(px * 9 + 3.1, py * 9, pz * 9, 4) * 0.035; // fractal coastlines
      const isle = nIsle.fbm(px * 4.3, py * 4.3 + 9.2, pz * 4.3, 3);
      if (isle > 0.42) c += (isle - 0.42) * 0.55; // archipelagos in the open sea
      cont[y * W + x] = c;
    }
    if ((y & 31) === 0) progress('Formation des continents', y / H);
  }

  // Sea level threshold from an area-weighted histogram (target land fraction).
  const targetLand = 0.29 + rng.next() * 0.08;
  {
    const BINS = 2048;
    const hist = new Float64Array(BINS);
    let total = 0;
    for (let y = 0; y < H; y++) {
      const w = cosLat[y];
      for (let x = 0; x < W; x++) {
        const b = clamp(Math.floor((cont[y * W + x] + 1) * 0.5 * BINS), 0, BINS - 1);
        hist[b] += w;
        total += w;
      }
    }
    let acc = 0, bin = BINS - 1;
    for (; bin >= 0; bin--) {
      acc += hist[bin];
      if (acc >= total * targetLand) break;
    }
    const thr = (bin / BINS) * 2 - 1;
    for (let i = 0; i < N; i++) cont[i] -= thr;
  }

  // Chamfer distance to the coast (in cells) so that land rises steadily inland:
  // this keeps drainage coherent and avoids giant closed basins.
  const coastDist = new Float32Array(N);
  {
    const BIG = 1e6;
    for (let i = 0; i < N; i++) coastDist[i] = cont[i] > 0 ? BIG : 0;
    const relax = (i: number, n: number, d: number) => {
      if (coastDist[n] + d < coastDist[i]) coastDist[i] = coastDist[n] + d;
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (coastDist[i] === 0) continue;
          relax(i, y * W + ((x + W - 1) % W), 1);
          if (y > 0) {
            relax(i, i - W, 1);
            relax(i, (y - 1) * W + ((x + W - 1) % W), 1.414);
            relax(i, (y - 1) * W + ((x + 1) % W), 1.414);
          }
        }
      }
      for (let y = H - 1; y >= 0; y--) {
        for (let x = W - 1; x >= 0; x--) {
          const i = y * W + x;
          if (coastDist[i] === 0) continue;
          relax(i, y * W + ((x + 1) % W), 1);
          if (y < H - 1) {
            relax(i, i + W, 1);
            relax(i, (y + 1) * W + ((x + W - 1) % W), 1.414);
            relax(i, (y + 1) * W + ((x + 1) % W), 1.414);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------- relief
  progress('Soulèvement des montagnes', 0);
  for (let y = 0; y < H; y++) {
    const cl = cosLat[y], py = sinLat[y];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const px = cl * cosLon[x], pz = cl * sinLon[x];
      const c = cont[i];
      let h: number;
      if (c > 0) {
        const inland = 0.72 * smoothstep(0, 750, coastDist[i] * cellSize) + 0.28 * smoothstep(0, 0.22, c);
        const hills = nHill.fbm(px * 7, py * 7, pz * 7, 5);
        h = 1.5 + 50 * Math.pow(inland, 1.25) + hills * (7 + 26 * inland);
        const belt = 1 - Math.abs(nBelt.fbm(px * 1.7 + 4.4, py * 1.7, pz * 1.7, 4));
        const coastFade = smoothstep(0.012, 0.11, c);
        const foot = smoothstep(0.8, 0.96, belt) * coastFade;
        const mmRaw = smoothstep(0.84, 0.992, belt) * coastFade;
        const mm = mmRaw * mmRaw;
        h += foot * 30;
        if (mm > 0) {
          const r = nRidge.ridged(px * 8.5, py * 8.5, pz * 8.5, 6);
          h += mm * (30 + 350 * r * (0.55 + 0.45 * mm));
        }
        if (h < 0.6) h = 0.6 + (h + 40) * 0.002;
      } else {
        const shelf = smoothstep(0, -0.05, c);
        const deep = smoothstep(-0.03, -0.3, c);
        h = -(1.5 + 22 * shelf + 190 * deep) + nHill.fbm(px * 5, py * 5, pz * 5, 3) * 9 * deep;
        if (h > -0.8) h = -0.8;
      }
      elevation[i] = h;
    }
    if ((y & 31) === 0) progress('Soulèvement des montagnes', y / H);
  }

  // ----------------------------------------------------------------- volcanoes
  progress('Éveil des volcans', 0);
  const volcanoes: Volcano[] = [];
  const volcanoCount = 5 + rng.int(0, 3);
  for (let attempt = 0; volcanoes.length < volcanoCount && attempt < 400; attempt++) {
    const x = rng.int(0, W - 1);
    const y = Math.floor(H * (0.5 + (rng.next() - 0.5) * 0.72));
    const c = cont[y * W + x];
    // Prefer coasts and shallow seas (island arcs), avoid deep ocean & far inland.
    if (c < -0.09 || c > 0.16) continue;
    const radius = 240 + rng.next() * 260;
    const height = 150 + rng.next() * 170;
    let tooClose = false;
    for (const v of volcanoes) {
      if (angularDist(x, y, v.x, v.y) * R < 900) tooClose = true;
    }
    if (tooClose) continue;
    volcanoes.push({ x, y, radius, height });
    const ry = Math.ceil((radius * 1.6) / cellSize);
    for (let yy = Math.max(0, y - ry); yy <= Math.min(H - 1, y + ry); yy++) {
      const rx = Math.min(W >> 1, Math.ceil(ry / Math.max(0.05, cosLat[yy])));
      for (let dx = -rx; dx <= rx; dx++) {
        const xx = (x + dx + W) % W;
        const d = angularDist(x, y, xx, yy) * R;
        if (d > radius * 1.6) continue;
        const i = yy * W + xx;
        const t = clamp01(1 - d / radius);
        let cone = height * Math.pow(t, 1.6);
        const crater = radius * 0.13;
        if (d < crater) cone -= height * 0.22 * (1 - d / crater);
        const rough = 1 + nRidge.noise(cosLat[yy] * cosLon[xx] * 40, sinLat[yy] * 40, cosLat[yy] * sinLon[xx] * 40) * 0.12;
        const base = elevation[i];
        const raised = Math.max(base, -25) * (1 - t * 0.5) + cone * rough;
        if (cone > 0 && raised > base) elevation[i] = raised;
        const ash = Math.round(255 * smoothstep(radius * 1.6, radius * 0.35, d));
        if (ash > volcanic[i]) volcanic[i] = ash;
      }
    }
  }

  function angularDist(x0: number, y0: number, x1: number, y1: number): number {
    const d =
      cosLat[y0] * cosLon[x0] * cosLat[y1] * cosLon[x1] +
      sinLat[y0] * sinLat[y1] +
      cosLat[y0] * sinLon[x0] * cosLat[y1] * sinLon[x1];
    return Math.acos(clamp(d, -1, 1));
  }

  // ------------------------------------------------------ ocean mask & distance
  progress('Remplissage des océans', 0);
  {
    const queue = new Int32Array(N);
    let qh = 0, qt = 0;
    oceanDist.fill(255);
    for (let i = 0; i < N; i++) {
      if (elevation[i] <= 0) {
        water[i] = Water.Ocean;
        oceanDist[i] = 0;
        queue[qt++] = i;
      }
    }
    while (qh < qt) {
      const i = queue[qh++];
      const d = oceanDist[i];
      if (d >= 254) continue;
      const x = i % W, y = (i / W) | 0;
      const nb = [y * W + ((x + 1) % W), y * W + ((x + W - 1) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (let k = 0; k < 4; k++) {
        const n = nb[k];
        if (n >= 0 && oceanDist[n] > d + 1) {
          oceanDist[n] = d + 1;
          queue[qt++] = n;
        }
      }
    }
  }

  // ------------------------------------------------------------------- climate
  progress('Naissance des climats', 0);
  for (let y = 0; y < H; y++) {
    const cl = cosLat[y], py = sinLat[y];
    const lat = Math.asin(py);
    const latT = 30 - 50 * Math.pow(Math.abs(py), 1.6);
    const circ = 0.5 + 0.38 * Math.cos(lat * 6) - 0.25 * Math.pow(Math.abs(py), 4);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const px = cl * cosLon[x], pz = cl * sinLon[x];
      const h = Math.max(0, elevation[i]);
      const tn = nClim.fbm(px * 2.6, py * 2.6, pz * 2.6, 3);
      temperature[i] = latT - h * 0.05 + tn * 3.5;
      const mn = nClim.fbm(px * 2.1 + 31.7, py * 2.1, pz * 2.1, 4);
      const coast = Math.exp(-oceanDist[i] / 45);
      let m = 0.18 + 0.52 * circ + 0.42 * mn + 0.2 * coast;
      m -= smoothstep(140, 330, h) * 0.12;
      moisture[i] = clamp01(m);
    }
    if ((y & 63) === 0) progress('Naissance des climats', y / H);
  }

  // ----------------------------------------------------------------- hydrology
  progress('Tracé des rivières', 0);
  const filled = new Float32Array(elevation);
  const order = new Int32Array(N); // land cells in pop order (downstream first)
  let orderLen = 0;
  {
    // Priority-flood depression filling (Barnes et al.) seeded from the ocean.
    const heap = new Int32Array(N);
    let heapLen = 0;
    const visited = new Uint8Array(N);
    const push = (i: number) => {
      let p = heapLen++;
      const v = filled[i];
      while (p > 0) {
        const parent = (p - 1) >> 1;
        if (filled[heap[parent]] <= v) break;
        heap[p] = heap[parent];
        p = parent;
      }
      heap[p] = i;
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap[--heapLen];
      const v = filled[last];
      let p = 0;
      for (;;) {
        let c = p * 2 + 1;
        if (c >= heapLen) break;
        if (c + 1 < heapLen && filled[heap[c + 1]] < filled[heap[c]]) c++;
        if (filled[heap[c]] >= v) break;
        heap[p] = heap[c];
        p = c;
      }
      heap[p] = last;
      return top;
    };
    for (let i = 0; i < N; i++) {
      if (water[i] !== Water.Ocean) continue;
      visited[i] = 1;
      // Only shore cells need to enter the queue.
      const x = i % W, y = (i / W) | 0;
      const shore =
        water[y * W + ((x + 1) % W)] !== Water.Ocean ||
        water[y * W + ((x + W - 1) % W)] !== Water.Ocean ||
        (y > 0 && water[i - W] !== Water.Ocean) ||
        (y < H - 1 && water[i + W] !== Water.Ocean);
      if (shore) push(i);
    }
    const EPS = 0.004;
    while (heapLen > 0) {
      const i = pop();
      const x = i % W, y = (i / W) | 0;
      if (water[i] !== Water.Ocean) order[orderLen++] = i;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const n = yy * W + ((x + dx + W) % W);
          if (visited[n]) continue;
          visited[n] = 1;
          if (filled[n] < filled[i] + EPS) filled[n] = filled[i] + EPS;
          flowTo[n] = i;
          push(n);
        }
      }
    }
  }
  // Flow accumulation: traverse upstream-first (reverse pop order).
  for (let k = orderLen - 1; k >= 0; k--) {
    const i = order[k];
    const y = (i / W) | 0;
    const rain = moisture[i] * (temperature[i] < -10 ? 0.15 : 1) * cosLat[y];
    flux[i] += rain;
    const to = flowTo[i];
    if (to >= 0 && water[to] !== Water.Ocean) flux[to] += flux[i];
  }

  // Lakes: deep, large enough, humid depressions. Shallow pits are simply filled.
  progress('Remplissage des lacs', 0);
  {
    const label = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    for (let k = 0; k < orderLen; k++) {
      const s = order[k];
      if (label[s] >= 0 || filled[s] - elevation[s] < 0.5) continue;
      let sp = 0, size = 0, maxDepth = 0, wet = 0;
      stack[sp++] = s;
      label[s] = s;
      const members: number[] = [];
      while (sp > 0) {
        const i = stack[--sp];
        members.push(i);
        size++;
        maxDepth = Math.max(maxDepth, filled[i] - elevation[i]);
        wet += moisture[i];
        const x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const n = yy * W + ((x + dx + W) % W);
            if (label[n] >= 0 || water[n] === Water.Ocean || filled[n] - elevation[n] < 0.5) continue;
            label[n] = s;
            stack[sp++] = n;
          }
        }
      }
      const isLake = maxDepth > 4.5 && size >= 14 && wet / size > 0.4 && temperature[s] > -14;
      if (isLake) for (const i of members) water[i] = Water.Lake;
    }
    for (let k = 0; k < orderLen; k++) {
      const i = order[k];
      if (filled[i] > elevation[i]) elevation[i] = filled[i];
    }
  }

  // Rivers: cells whose discharge exceeds a threshold; carve their beds.
  const RIVER_T = 420 * (W / 2048) * (W / 2048);
  let riverCells = 0;
  for (let k = 0; k < orderLen; k++) {
    const i = order[k];
    if (water[i] !== Water.Land || flux[i] < RIVER_T || temperature[i] < -12) continue;
    water[i] = Water.River;
    riverCells++;
  }
  for (let k = 0; k < orderLen; k++) {
    const i = order[k];
    if (water[i] !== Water.River) continue;
    const size = Math.log2(flux[i] / RIVER_T); // 0.. ~7
    const carve = Math.min(5, 0.9 + size * 0.55);
    elevation[i] = Math.max(0.25, elevation[i] - carve);
    const x = i % W, y = (i / W) | 0;
    waterMask[i] = 255;
    const wide = size > 2.2;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const n = yy * W + ((x + dx + W) % W);
        if (water[n] === Water.Ocean) continue;
        if (water[n] === Water.Land) elevation[n] = Math.max(0.3, elevation[n] - carve * (wide ? 0.7 : 0.35));
        const m = wide ? 215 : 70 + Math.min(60, size * 30);
        if (waterMask[n] < m) waterMask[n] = m;
      }
    }
  }
  let lakeCells = 0;
  for (let i = 0; i < N; i++) {
    if (water[i] === Water.Lake) {
      waterMask[i] = 255;
      lakeCells++;
    }
  }
  // Rivers humidify their banks.
  {
    const wet = new Float32Array(N);
    for (let i = 0; i < N; i++) if (water[i] === Water.River || water[i] === Water.Lake) wet[i] = 1;
    for (let pass = 0; pass < 6; pass++) {
      for (let y = 1; y < H - 1; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const m = Math.max(wet[y * W + ((x + 1) % W)], wet[y * W + ((x + W - 1) % W)], wet[i - W], wet[i + W]) * 0.72;
          if (m > wet[i]) wet[i] = m;
        }
      }
    }
    for (let i = 0; i < N; i++) if (wet[i] > 0) moisture[i] = clamp01(moisture[i] + wet[i] * 0.22);
  }

  // ------------------------------------------------------------- biomes & life
  progress('Éclosion de la vie', 0);
  const biomeArea = new Array<number>(16).fill(0);
  let landArea = 0, totalArea = 0, tempSum = 0, maxElevation = 0;
  for (let y = 0; y < H; y++) {
    const cl = cosLat[y], py = sinLat[y];
    const dxm = cellSize * Math.max(0.02, cl);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = elevation[i];
      const t = temperature[i];
      const m = moisture[i];
      const xe = y * W + ((x + 1) % W), xw = y * W + ((x + W - 1) % W);
      const yn = y > 0 ? i - W : i, ys = y < H - 1 ? i + W : i;
      const sx = (elevation[xe] - elevation[xw]) / (2 * dxm);
      const sy = (elevation[yn] - elevation[ys]) / (2 * cellSize);
      const slope = Math.sqrt(sx * sx + sy * sy);
      const px = cl * cosLon[x], pz = cl * sinLon[x];
      let b: Biome;
      const w = water[i];
      if (w === Water.Ocean) b = h < -45 ? Biome.DeepOcean : Biome.Ocean;
      else if (w === Water.Lake) b = Biome.Lake;
      else if (w === Water.River) b = Biome.River;
      else if (volcanic[i] > 150) b = Biome.Volcanic;
      else if (t < -11) b = Biome.Ice;
      else if (h > 170 && (slope > 0.6 || t < -5)) b = Biome.Alpine;
      else if (slope > 0.95) b = Biome.Alpine;
      else if (h < 2.2 && oceanDist[i] <= 2 && t > -4) b = Biome.Beach;
      else if (t < -3) b = Biome.Tundra;
      else if (t < 5) b = m > 0.42 ? Biome.Taiga : Biome.Tundra;
      else if (t < 19) {
        if (m < 0.27) b = Biome.Desert;
        else if (m < 0.52) b = Biome.Grassland;
        else if (m > 0.8 && h < 6 && slope < 0.05) b = Biome.Marsh;
        else b = Biome.Forest;
      } else {
        if (m < 0.33) b = Biome.Desert;
        else if (m < 0.52) b = Biome.Savanna;
        else if (m < 0.68) b = Biome.Forest;
        else b = Biome.Rainforest;
      }
      biome[i] = b;

      // Tree cover: clumpy noise modulated by biome.
      const clump = 0.5 + 0.5 * nIsle.fbm(px * 55, py * 55, pz * 55, 2);
      let f = 0;
      switch (b) {
        case Biome.Forest: f = 0.62 + 0.38 * clump; break;
        case Biome.Rainforest: f = 0.8 + 0.2 * clump; break;
        case Biome.Taiga: f = 0.45 + 0.5 * clump; break;
        case Biome.Marsh: f = 0.25 * clump; break;
        case Biome.Savanna: f = smoothstep(0.55, 0.9, clump) * 0.3; break;
        case Biome.Grassland: f = smoothstep(0.62, 0.95, clump) * 0.5 * smoothstep(0.3, 0.52, m); break;
        case Biome.Tundra: f = smoothstep(0.75, 1, clump) * 0.12; break;
        case Biome.Volcanic: f = 0; break;
        default: f = 0;
      }
      f *= 1 - smoothstep(0.5, 0.95, slope);
      forest[i] = Math.round(clamp01(f) * 255);

      // Fertility: warm-temperate, moist, flat land near fresh water.
      let fert = 0;
      if (w === Water.Land && b !== Biome.Ice) {
        const tf = smoothstep(-2, 12, t) * (1 - smoothstep(27, 36, t) * 0.5);
        const mf = smoothstep(0.18, 0.6, m) * (1 - smoothstep(0.85, 1, m) * 0.3);
        const sf = 1 - smoothstep(0.08, 0.5, slope);
        fert = tf * mf * sf * (b === Biome.Alpine ? 0.2 : 1);
        fert += (volcanic[i] / 255) * 0.25 * (b === Biome.Volcanic ? 0 : 1); // rich ash soils
        if (b === Biome.Beach) fert *= 0.4;
      }
      fertility[i] = Math.round(clamp01(fert) * 255);

      let bio = 0;
      if (w !== Water.Ocean) bio = smoothstep(-8, 24, t) * (0.25 + 0.75 * m) * (0.6 + 0.4 * (forest[i] / 255));
      else bio = smoothstep(-80, -2, h) * smoothstep(-6, 22, t) * 0.7;
      biodiversity[i] = Math.round(clamp01(bio) * 255);

      totalArea += cl;
      if (w !== Water.Ocean) {
        landArea += cl;
        tempSum += t * cl;
        if (h > maxElevation) maxElevation = h;
      }
      biomeArea[b] += cl;
    }
    if ((y & 63) === 0) progress('Éclosion de la vie', y / H);
  }

  // ----------------------------------------------------------------- landmasses
  progress('Cartographie des terres', 0);
  const landmasses: Landmass[] = [];
  {
    const nameRng = rng.fork('landmass-names');
    const stack = new Int32Array(N);
    const cellKm2 = (cellSize * cellSize) / 1e6;
    const raw: { id: number; area: number; best: number; bx: number; by: number }[] = [];
    let nextId = 1;
    for (let s = 0; s < N; s++) {
      if (water[s] === Water.Ocean || landmassId[s] !== 0) continue;
      const id = nextId < 65535 ? nextId++ : 65535;
      let sp = 0, area = 0, best = -1, bx = s % W, by = (s / W) | 0;
      stack[sp++] = s;
      landmassId[s] = id;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % W, y = (i / W) | 0;
        area += cosLat[y] * cellKm2;
        const score = fertility[i] + oceanDist[i] * 0.5;
        if (score > best) { best = score; bx = x; by = y; }
        const nb = [y * W + ((x + 1) % W), y * W + ((x + W - 1) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
        for (let k = 0; k < 4; k++) {
          const n = nb[k];
          if (n >= 0 && water[n] !== Water.Ocean && landmassId[n] === 0) {
            landmassId[n] = id;
            stack[sp++] = n;
          }
        }
      }
      raw.push({ id, area, best, bx, by });
    }
    raw.sort((a, b) => b.area - a.area || a.id - b.id);
    const used = new Set<string>();
    for (const r of raw) {
      if (r.area < 0.004) continue; // unnamed rocks
      let name = placeName(nameRng);
      while (used.has(name)) name = placeName(nameRng);
      used.add(name);
      landmasses.push({ id: r.id, name, kind: r.area > 0.9 ? 'continent' : 'island', area: r.area, x: r.bx, y: r.by });
    }
  }

  // ------------------------------------------------------------------ resources
  progress('Formation des gisements', 0);
  const deposits: Deposit[] = [];
  {
    const drng = rng.fork('deposits');
    const wanted: Record<ResourceKind, number> = { iron: 46, coal: 40, gold: 14, stone: 70 };
    const suit = (kind: ResourceKind, i: number): number => {
      if (water[i] !== Water.Land || biome[i] === Biome.Ice) return 0;
      const h = elevation[i];
      switch (kind) {
        case 'iron': return smoothstep(25, 90, h) * (1 - smoothstep(230, 330, h)) * 0.9 + (volcanic[i] / 255) * 0.5;
        case 'coal': return smoothstep(10, 45, h) * (1 - smoothstep(110, 190, h)) * (0.35 + 0.65 * moisture[i]);
        case 'gold': return smoothstep(90, 190, h) * 0.8 + (volcanic[i] > 60 ? 0.35 : 0);
        case 'stone': return smoothstep(18, 70, h) * 0.8 + (biome[i] === Biome.Alpine ? 0.3 : 0);
      }
    };
    let id = 1;
    for (const kind of RESOURCE_KINDS) {
      let placed = 0;
      for (let attempt = 0; placed < wanted[kind] && attempt < 60000; attempt++) {
        const y = Math.floor(Math.acos(1 - 2 * drng.next()) / Math.PI * H); // area-uniform latitude
        const x = drng.int(0, W - 1);
        const i = clamp(y, 0, H - 1) * W + x;
        if (drng.next() > suit(kind, i)) continue;
        const radius = kind === 'gold' ? drng.int(2, 4) : drng.int(3, 8);
        const amount = Math.round((kind === 'gold' ? 800 : kind === 'stone' ? 20000 : 6000) * (0.5 + drng.next()) * radius);
        const dep: Deposit = { id: id++, kind, x, y: clamp(y, 0, H - 1), radius, amount };
        deposits.push(dep);
        placed++;
        const kindIdx = RESOURCE_KINDS.indexOf(kind) + 1;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = dep.y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > radius) continue;
            const n = yy * W + ((x + dx + W) % W);
            if (water[n] === Water.Ocean) continue;
            const rich = Math.max(1, Math.round(15 * (1 - d / (radius + 1))));
            if ((mineral[n] & 15) < rich) mineral[n] = (kindIdx << 4) | rich;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ settlement sites
  progress('Repérage des terres fertiles', 0);
  const sites: SettlementSite[] = [];
  {
    // Coarse scan: score blocks by fertility, fresh water, flatness and climate.
    const step = Math.max(2, Math.round(W / 512));
    const cands: SettlementSite[] = [];
    const rad = Math.max(2, Math.round(6 * (W / 2048)));
    for (let y = Math.floor(H * 0.1); y < H * 0.9; y += step) {
      for (let x = 0; x < W; x += step) {
        const i = y * W + x;
        if (water[i] !== Water.Land || fertility[i] < 110 || elevation[i] > 110) continue;
        let fert = 0, fresh = 0, n = 0, wet = 0, hmin = 1e9, hmax = -1e9;
        for (let dy = -rad; dy <= rad; dy += 2) {
          for (let dx = -rad; dx <= rad; dx += 2) {
            const yy = clamp(y + dy, 0, H - 1);
            const j = yy * W + ((x + dx + W) % W);
            n++;
            fert += fertility[j];
            if (water[j] === Water.River || water[j] === Water.Lake) fresh++;
            if (water[j] !== Water.Land) wet++;
            hmin = Math.min(hmin, elevation[j]);
            hmax = Math.max(hmax, elevation[j]);
          }
        }
        if (wet / n > 0.45) continue;
        const coastal = oceanDist[i] < rad * 2.5;
        const riverside = fresh > 0;
        const relief = hmax - hmin;
        const score =
          (fert / n / 255) * 1.0 + (riverside ? 0.35 : 0) + (coastal ? 0.18 : 0) -
          smoothstep(8, 40, relief) * 0.5 + (forest[i] > 40 && forest[i] < 200 ? 0.05 : 0);
        cands.push({ x, y, score, landmass: landmassId[i], coastal, riverside });
      }
    }
    cands.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    const minSep = 520 / R; // radians
    for (const c of cands) {
      if (sites.length >= 28) break;
      let ok = true;
      for (const s of sites) {
        if (angularDist(c.x, c.y, s.x, s.y) < minSep) { ok = false; break; }
      }
      if (ok) sites.push(c);
    }
  }

  progress('Monde achevé', 1);
  return {
    seed: cfg.seed, width: W, height: H, radius: R,
    elevation, temperature, moisture, flux, flowTo, water, waterMask, biome, fertility, forest,
    volcanic, biodiversity, oceanDist, landmassId, mineral,
    deposits, landmasses, volcanoes, sites,
    stats: {
      landRatio: landArea / totalArea,
      maxElevation,
      riverCells,
      lakeCells,
      meanLandTemperature: landArea > 0 ? tempSum / landArea : 0,
      biomeArea: biomeArea.map((a) => a / totalArea),
    },
  };
}

/** Cheap order-sensitive checksum of a world, used by determinism tests and save validation. */
export function worldChecksum(w: WorldData): number {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 16777619) >>> 0;
  };
  const u32 = new Uint32Array(w.elevation.buffer, w.elevation.byteOffset, w.elevation.length);
  for (let i = 0; i < u32.length; i += 7) mix(u32[i]);
  for (let i = 0; i < w.biome.length; i += 5) mix(w.biome[i] | (w.water[i] << 8) | (w.fertility[i] << 16));
  for (const d of w.deposits) mix(d.x * 31 + d.y * 17 + d.amount);
  for (const s of w.sites) mix(s.x * 131 + s.y);
  return h >>> 0;
}
