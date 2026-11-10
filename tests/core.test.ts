import { describe, expect, it } from 'vitest';
import { Rng, hash2, hashString } from '../src/core/rng';
import { Simplex3 } from '../src/core/noise';
import { DAYS_PER_YEAR, SECONDS_PER_DAY, SECONDS_PER_YEAR, SPEEDS, SimClock, dateOf, seasonPhase } from '../src/sim/clock';
import { SAVE_VERSION, exportSave, importSave, validateSave, type SaveData } from '../src/persistence/saveStore';

describe('rng', () => {
  it('replays the same sequence from the same seed', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('can be resumed from its serialised state', () => {
    const a = new Rng(7);
    for (let i = 0; i < 10; i++) a.next();
    const b = new Rng(0);
    b.state = a.state;
    expect(b.next()).toBe(a.next());
  });
  it('forks independent, reproducible streams', () => {
    const x = new Rng(1).fork('a').next();
    expect(new Rng(1).fork('a').next()).toBe(x);
    expect(new Rng(1).fork('b').next()).not.toBe(x);
  });
  it('stays within bounds', () => {
    const r = Rng.fromString('bounds');
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
      const h = hash2(i, i * 3, 5);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
    expect(hashString('epoch')).toBe(hashString('epoch'));
  });
});

describe('noise', () => {
  it('is deterministic and bounded', () => {
    const a = new Simplex3(9), b = new Simplex3(9);
    for (let i = 0; i < 200; i++) {
      const v = a.fbm(i * 0.13, i * 0.07, -i * 0.05, 4);
      expect(v).toBe(b.fbm(i * 0.13, i * 0.07, -i * 0.05, 4));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
      const r = a.ridged(i * 0.2, 1, 2, 5);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1.01);
    }
  });
});

describe('historical clock', () => {
  it('converts time to calendar dates', () => {
    expect(dateOf(0)).toMatchObject({ year: 1, dayOfYear: 0, season: 0 });
    expect(dateOf(SECONDS_PER_DAY * 90 + 3600 * 6)).toMatchObject({ year: 1, dayOfYear: 90, season: 1, hour: 6 });
    expect(dateOf(SECONDS_PER_YEAR * 249 + SECONDS_PER_DAY * (DAYS_PER_YEAR - 1))).toMatchObject({ year: 250, dayOfYear: 359, season: 3 });
  });
  it('advances according to speed and pauses', () => {
    const c = new SimClock(0);
    c.speedIndex = 0;
    expect(c.advance(10)).toBe(0);
    c.speedIndex = 2;
    c.advance(1);
    expect(c.time).toBe(SPEEDS[2].rate);
  });
  it('peaks in summer and bottoms out in winter', () => {
    expect(seasonPhase(SECONDS_PER_YEAR * 0.25)).toBeCloseTo(1, 6);
    expect(seasonPhase(SECONDS_PER_YEAR * 0.75)).toBeCloseTo(-1, 6);
    expect(seasonPhase(0)).toBeCloseTo(0, 6);
  });
});

describe('save format', () => {
  const save: SaveData = {
    version: SAVE_VERSION, slot: 'slot1', name: 'test', savedAt: 123, seed: 'Aurore-1234', worldWidth: 2048,
    worldChecksum: 99, simTime: 1e7, speedIndex: 2, camera: { dir: [1, 0, 0], distance: 500, heading: 0.3, tilt: 1 },
  };
  it('round-trips through export / import', () => {
    expect(importSave(exportSave(save))).toEqual(save);
  });
  it('rejects corrupted or foreign files', () => {
    expect(() => importSave('not json')).toThrow();
    expect(() => importSave('{"format":"other"}')).toThrow();
    expect(() => validateSave({ ...save, version: 999 })).toThrow();
    expect(() => validateSave({ ...save, seed: '' })).toThrow();
    expect(() => validateSave({ ...save, simTime: NaN })).toThrow();
  });
});
