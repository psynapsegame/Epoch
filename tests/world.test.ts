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
