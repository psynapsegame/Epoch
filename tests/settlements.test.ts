import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/world/generator';
import { Water } from '../src/world/types';
import { World } from '../src/world/world';
import { layoutHamlet } from '../src/sim/settlements';

const world = new World(generateWorld({ seed: 'hamlet-test', width: 1024 }));

describe('hamlet construction', () => {
  it('is deterministic', () => {
    const a = layoutHamlet(world, 0, 1, 'A', 1);
    const b = layoutHamlet(world, 0, 1, 'A', 1);
    expect(a).toEqual(b);
  });

  it('builds on dry, gentle ground without overlaps', () => {
    let total = 0;
    for (let site = 0; site < 4; site++) {
      const { settlement, buildings } = layoutHamlet(world, site, site + 1, 'X', 1);
      total += buildings.length;
      expect(settlement.buildings.length).toBe(buildings.length);
      for (const b of buildings) {
        expect(Math.hypot(b.dir.x, b.dir.y, b.dir.z)).toBeCloseTo(1, 5);
        // door direction is tangent to the ground
        expect(Math.abs(b.dir.x * b.facing.x + b.dir.y * b.facing.y + b.dir.z * b.facing.z)).toBeLessThan(1e-6);
        if (b.kind === 'dock') continue;
        const cell = world.cellAt(b.dir.x, b.dir.y, b.dir.z);
        expect(world.data.water[cell]).toBe(Water.Land);
        expect(world.elevationAt(b.dir.x, b.dir.y, b.dir.z)).toBeGreaterThan(1);
      }
      for (let i = 0; i < buildings.length; i++) {
        for (let j = i + 1; j < buildings.length; j++) {
          const a = buildings[i], b = buildings[j];
          if (a.kind === 'dock' || b.kind === 'dock') continue;
          const d = Math.acos(Math.min(1, a.dir.x * b.dir.x + a.dir.y * b.dir.y + a.dir.z * b.dir.z)) * world.R;
          expect(d).toBeGreaterThan(a.radius + b.radius);
        }
      }
    }
    expect(total).toBeGreaterThan(20);
  });
});
