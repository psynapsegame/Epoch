import { describe, expect, it } from 'vitest';
import { generateWorld, worldChecksum } from '../src/world/generator';
import { Water } from '../src/world/types';
import { World } from '../src/world/world';

const data = generateWorld({ seed: 'test-world', width: 512 });
const world = new World(data);
const N = data.width * data.height;

describe('world generation', () => {
  it('is deterministic for a given seed', () => {
    const again = generateWorld({ seed: 'test-world', width: 512 });
    expect(worldChecksum(again)).toBe(worldChecksum(data));
    expect(again.landmasses.map((l) => l.name)).toEqual(data.landmasses.map((l) => l.name));
    expect(again.sites).toEqual(data.sites);
    expect(Array.from(again.elevation.slice(0, 2000))).toEqual(Array.from(data.elevation.slice(0, 2000)));
  });

  it('produces different worlds for different seeds', () => {
    const other = generateWorld({ seed: 'another-world', width: 512 });
    expect(worldChecksum(other)).not.toBe(worldChecksum(data));
  });

  it('has oceans, several landmasses and varied biomes', () => {
    expect(data.stats.landRatio).toBeGreaterThan(0.2);
    expect(data.stats.landRatio).toBeLessThan(0.5);
    expect(data.landmasses.length).toBeGreaterThan(3);
    expect(data.stats.maxElevation).toBeGreaterThan(150);
    const present = data.stats.biomeArea.filter((a) => a > 0.002).length;
    expect(present).toBeGreaterThanOrEqual(8);
  });

  it('keeps water and elevation consistent', () => {
    for (let i = 0; i < N; i++) {
      if (data.water[i] === Water.Ocean) expect(data.elevation[i]).toBeLessThanOrEqual(0);
      else expect(data.elevation[i]).toBeGreaterThan(0);
    }
  });

  it('routes every land cell to the sea without cycles', () => {
    for (let i = 0; i < N; i += 37) {
      if (data.water[i] === Water.Ocean) continue;
      let c = i, steps = 0;
      while (data.water[c] !== Water.Ocean) {
        c = data.flowTo[c];
        expect(c).toBeGreaterThanOrEqual(0);
        if (++steps > N) throw new Error('flow cycle detected');
      }
    }
  });

  it('makes rivers gain water downstream', () => {
    let rivers = 0;
    for (let i = 0; i < N; i++) {
      if (data.water[i] !== Water.River) continue;
      rivers++;
      const to = data.flowTo[i];
      if (data.water[to] !== Water.Ocean) expect(data.flux[to]).toBeGreaterThanOrEqual(data.flux[i]);
    }
    expect(rivers).toBeGreaterThan(50);
  });

  it('places deposits and settlement sites coherently', () => {
    expect(data.deposits.length).toBeGreaterThan(50);
    for (const d of data.deposits) expect(data.water[d.y * data.width + d.x]).toBe(Water.Land);
    expect(data.sites.length).toBeGreaterThan(5);
    for (const s of data.sites) {
      const i = s.y * data.width + s.x;
      expect(data.water[i]).toBe(Water.Land);
      expect(data.fertility[i]).toBeGreaterThanOrEqual(110);
    }
    // sites are sorted best-first
    for (let k = 1; k < data.sites.length; k++) expect(data.sites[k - 1].score).toBeGreaterThanOrEqual(data.sites[k].score);
  });

  it('is colder at the poles and on mountains', () => {
    const W = data.width, H = data.height;
    let pole = 0, eq = 0;
    for (let x = 0; x < W; x++) {
      pole += data.temperature[2 * W + x];
      eq += data.temperature[(H >> 1) * W + x];
    }
    expect(eq / W).toBeGreaterThan(pole / W + 25);
  });
});

describe('World query API', () => {
  it('maps cells to directions and back', () => {
    const d = { x: 0, y: 0, z: 0 };
    for (const [x, y] of [[0, 0], [100, 50], [511, 255], [256, 128]]) {
      world.cellDir(x, y, d);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
      expect(world.cellAt(d.x, d.y, d.z)).toBe(y * data.width + x);
    }
  });

  it('interpolates elevation close to the grid values', () => {
    const d = { x: 0, y: 0, z: 0 };
    const s = data.sites[0];
    world.cellDir(s.x, s.y, d);
    expect(Math.abs(world.baseElevation(d.x, d.y, d.z) - data.elevation[s.y * data.width + s.x])).toBeLessThan(0.5);
    expect(Math.abs(world.elevationAt(d.x, d.y, d.z) - data.elevation[s.y * data.width + s.x])).toBeLessThan(4);
  });

  it('raycasts onto the surface', () => {
    const d = { x: 0, y: 0, z: 0 };
    const s = data.sites[0];
    world.cellDir(s.x, s.y, d);
    const o = { x: d.x * 9000, y: d.y * 9000, z: d.z * 9000 };
    const t = world.raycast(o.x, o.y, o.z, -d.x, -d.y, -d.z);
    expect(t).toBeGreaterThan(0);
    expect(9000 - t).toBeCloseTo(world.surfaceRadius(d.x, d.y, d.z), 0);
    // a ray pointing away from the planet misses
    expect(world.raycast(o.x, o.y, o.z, d.x, d.y, d.z)).toBe(-1);
  });

  it('describes cells with real data', () => {
    const s = data.sites[0];
    const info = world.describe(s.y * data.width + s.x);
    expect(info.landmass).not.toBeNull();
    expect(info.fertility).toBeGreaterThan(0.4);
    expect(info.biomeName.length).toBeGreaterThan(0);
    // summer is warmer than winter in the northern hemisphere
    const north = 60 * data.width + 10;
    expect(world.seasonalTemperature(north, 1)).toBeGreaterThan(world.seasonalTemperature(north, -1));
  });
});

import { applyEdit, applyEdits, type WorldEdit } from '../src/world/edits';

describe('divine world edits', () => {
  const fresh = () => generateWorld({ seed: 'test-world', width: 512 });
  const site = (w: ReturnType<typeof fresh>) => w.sites[0];

  it('raise a mountain that is higher, colder and deterministic', () => {
    const a = fresh(), b = fresh();
    const s = site(a);
    const i = s.y * a.width + s.x;
    const before = a.elevation[i], temp = a.temperature[i];
    const edit: WorldEdit = { kind: 'mountain', x: s.x, y: s.y, radius: 250, amount: 180 };
    applyEdit(a, edit);
    applyEdit(b, edit);
    expect(a.elevation[i]).toBeGreaterThan(before + 100);
    expect(a.temperature[i]).toBeLessThan(temp - 4);
    expect(worldChecksum(a)).toBe(worldChecksum(b));
    // far away, nothing moved
    const far = ((s.y + 60) % a.height) * a.width + ((s.x + 200) % a.width);
    expect(a.elevation[far]).toBe(fresh().elevation[far]);
  });

  it('grow forests, seed deposits, dig craters and burn woods', () => {
    const w = fresh();
    const s = site(w);
    const i = s.y * w.width + s.x;
    applyEdit(w, { kind: 'forest', x: s.x, y: s.y, radius: 200, amount: 0 });
    expect(w.forest[i]).toBeGreaterThan(150);
    applyEdit(w, { kind: 'burn', x: s.x, y: s.y, radius: 200, amount: 0 });
    expect(w.forest[i]).toBeLessThan(60);
    expect(w.volcanic[i]).toBeGreaterThan(40);
    applyEdit(w, { kind: 'deposit', x: s.x, y: s.y, radius: 80, amount: 1 });
    expect(w.mineral[i] >> 4).toBe(1);
    expect(w.mineral[i] & 15).toBeGreaterThan(10);
    const h = w.elevation[i];
    applyEdit(w, { kind: 'crater', x: s.x, y: s.y, radius: 90, amount: 14 });
    expect(w.elevation[i]).toBeLessThan(h);
    expect(w.elevation[i]).toBeGreaterThan(0);
    applyEdit(w, { kind: 'valley', x: s.x, y: s.y, radius: 150, amount: 500 });
    expect(w.elevation[i]).toBeCloseTo(0.8, 5); // never below the shoreline
  });

  it('replay identically from a list (save / load)', () => {
    const edits: WorldEdit[] = [
      { kind: 'mountain', x: 100, y: 120, radius: 300, amount: 150 },
      { kind: 'forest', x: 140, y: 110, radius: 200, amount: 0 },
      { kind: 'crater', x: 100, y: 120, radius: 80, amount: 12 },
    ];
    const a = fresh(), b = fresh();
    applyEdits(a, edits);
    for (const e of edits) applyEdit(b, e);
    expect(worldChecksum(a)).toBe(worldChecksum(b));
    expect(worldChecksum(a)).not.toBe(worldChecksum(fresh()));
  });
});
